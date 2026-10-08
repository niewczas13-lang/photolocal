import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { GoogleChatOperationQueue, readJsonObject, writeJsonAtomic } from './google-chat-files.js';

export interface GoogleChatSpace { name: string; displayName: string; spaceType: string; }
export interface GoogleChatDownloadStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'AUTH_REQUIRED' | 'PAUSED' | 'PARTIAL_FAILURE';
  projectId: string | null;
  spaceName: string | null;
  spaceDisplayName: string | null;
  rootPath?: string;
  downloadedFiles?: number;
  skippedFiles?: number;
  totalFiles?: number;
  filesToDownload?: number;
  failedFiles?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentLines: string[];
}

export interface GoogleChatRunnerConfig {
  pythonCommand: string;
  scriptPath: string;
  credentialsFile: string;
  tokenFile: string;
  downloadRoot: string;
  stateFile: string;
}

interface ProcessResult { code: number; stdout: string; stderr: string; }
export interface GoogleChatProcessRunner {
  (args: string[], config: GoogleChatRunnerConfig, onLine: (line: string) => void, signal: AbortSignal): Promise<ProcessResult>;
}

interface DownloadInput { projectId: string; spaceName: string; spaceDisplayName: string; }

export class GoogleChatRequestError extends Error {
  constructor(message: string, readonly code: 'GOOGLE_AUTH_REQUIRED' | 'GOOGLE_CHAT_FAILED') { super(message); }
}

function idleStatus(): GoogleChatDownloadStatus {
  return { state: 'IDLE', projectId: null, spaceName: null, spaceDisplayName: null, recentLines: [] };
}

const AUTH_MESSAGE = 'Połącz ponownie konto Google, aby wznowić pobieranie zdjęć.';

const runPython: GoogleChatProcessRunner = (args, config, onLine, signal) => new Promise((resolve, reject) => {
  const child = spawn(config.pythonCommand, [config.scriptPath, ...args], {
    cwd: dirname(config.scriptPath), windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
      GOOGLE_CHAT_CREDENTIALS_FILE: config.credentialsFile, GOOGLE_CHAT_TOKEN_FILE: config.tokenFile,
      GOOGLE_CHAT_DOWNLOAD_ROOT: config.downloadRoot },
  });
  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let failure: Error | undefined;
  const abort = () => { failure = new Error('Pobieranie zostało przerwane.'); child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => { failure = new Error('Przekroczono czas operacji Google Chat.'); child.kill(); },
    args.includes('--list-spaces-json') ? 120_000 : 6 * 60 * 60_000);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 4 * 1024 * 1024) {
      if (args.includes('--list-spaces-json')) {
        failure = new Error('Odpowiedź listy czatów jest zbyt duża.'); child.kill();
      } else stdout = stdout.slice(-64_000);
    }
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = (lines.pop() ?? '').slice(-8_000);
    try { for (const line of lines) onLine(line); } catch {
      failure = new Error('Nie udało się zapisać postępu pobierania.'); child.kill();
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_000); });
  child.on('error', () => { failure = new Error('Nie udało się uruchomić programu pobierającego zdjęcia.'); });
  child.on('close', (code) => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (failure) return reject(failure);
    try { if (lineBuffer) onLine(lineBuffer); } catch { return reject(new Error('Nie udało się zapisać postępu pobierania.')); }
    resolve({ code: code ?? 1, stdout, stderr });
  });
});

export class GoogleChatDownloadManager {
  private status = idleStatus();
  private authRequired = false;
  private readonly abortController = new AbortController();
  private task: Promise<void> = Promise.resolve();
  private isClosing = false;

  constructor(readonly config: GoogleChatRunnerConfig, readonly queue: GoogleChatOperationQueue,
    private readonly runner: GoogleChatProcessRunner = runPython) {
    const saved = readJsonObject(config.stateFile);
    this.authRequired = saved?.authRequired === true;
    const status = saved?.status as Partial<GoogleChatDownloadStatus> | undefined;
    const states = ['RUNNING', 'COMPLETED', 'FAILED', 'AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE'];
    if (saved?.version === 1 && status && typeof status.projectId === 'string'
      && typeof status.spaceName === 'string' && /^spaces\/[A-Za-z0-9_-]+$/.test(status.spaceName)
      && typeof status.spaceDisplayName === 'string' && states.includes(status.state ?? '')) {
      this.status = { ...status, state: status.state === 'RUNNING' ? 'PAUSED' : status.state!,
        projectId: status.projectId, spaceName: status.spaceName, spaceDisplayName: status.spaceDisplayName,
        recentLines: [] };
      if (status.state === 'RUNNING') this.status.error = 'Serwer został ponownie uruchomiony. Wznów pobieranie.';
      const folders = readJsonObject(join(config.downloadRoot, '.spaces.json'));
      const folder = folders?.[status.spaceName];
      if (typeof folder === 'string' && folder && !/[\\/]/.test(folder) && folder !== '.' && folder !== '..') {
        this.status.rootPath = join(config.downloadRoot, folder);
      } else if (this.status.rootPath && !this.isDownloadPath(this.status.rootPath)) {
        delete this.status.rootPath;
      }
    }
  }

  private save(): void {
    writeJsonAtomic(this.config.stateFile, { version: 1, authRequired: this.authRequired, status: this.status });
  }

  isAuthRequired(): boolean { return this.authRequired; }
  isRunning(): boolean { return this.status.state === 'RUNNING'; }
  getStatus(projectId?: string): GoogleChatDownloadStatus {
    if (projectId && projectId !== this.status.projectId) return idleStatus();
    return { ...this.status, recentLines: [...this.status.recentLines] };
  }

  markConnected(): void {
    this.authRequired = false;
    if (this.status.state === 'AUTH_REQUIRED') {
      this.status.state = 'PAUSED';
      this.status.error = 'Konto Google połączone. Możesz wznowić pobieranie.';
    }
    this.save();
  }

  async listSpaces(signal?: AbortSignal): Promise<GoogleChatSpace[]> {
    if (this.isClosing) throw new Error('Serwer jest zatrzymywany.');
    if (this.isRunning()) throw new Error('Trwa pobieranie. Poczekaj przed odświeżeniem listy czatów.');
    return this.queue.run(async () => {
      signal?.throwIfAborted();
      const operationSignal = signal ? AbortSignal.any([this.abortController.signal, signal]) : this.abortController.signal;
      const result = await this.runner(['--list-spaces-json'], this.config, () => undefined, operationSignal);
      if (result.code === 3 || result.stderr.includes('PHOTO_LOCAL_AUTH_REQUIRED')) {
        this.authRequired = true;
        this.save();
        throw new GoogleChatRequestError(AUTH_MESSAGE, 'GOOGLE_AUTH_REQUIRED');
      }
      if (result.code !== 0) throw new GoogleChatRequestError('Nie udało się pobrać listy czatów. Spróbuj ponownie.', 'GOOGLE_CHAT_FAILED');
      let spaces: unknown;
      try { spaces = JSON.parse(result.stdout); } catch { throw new GoogleChatRequestError('Nieprawidłowa odpowiedź listy czatów.', 'GOOGLE_CHAT_FAILED'); }
      if (!Array.isArray(spaces)) throw new GoogleChatRequestError('Nieprawidłowa odpowiedź listy czatów.', 'GOOGLE_CHAT_FAILED');
      this.markConnected();
      return spaces.filter((space): space is GoogleChatSpace => Boolean(space && typeof space === 'object'
        && typeof space.name === 'string' && /^spaces\/[A-Za-z0-9_-]+$/.test(space.name)
        && typeof space.displayName === 'string')).map((space) => ({ name: space.name,
        displayName: space.displayName || space.name, spaceType: typeof space.spaceType === 'string' ? space.spaceType : '' }));
    });
  }

  private progress(line: string): void {
    if (line.startsWith('PHOTO_LOCAL_PROGRESS ')) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line.slice('PHOTO_LOCAL_PROGRESS '.length)) as Record<string, unknown>; }
      catch { return; }
      if (!event || typeof event.rootPath !== 'string' || !this.isDownloadPath(event.rootPath)) return;
      const keys = ['totalFiles', 'downloadedFiles', 'skippedFiles', 'failedFiles'] as const;
      if (!keys.every((key) => typeof event[key] === 'number' && Number.isSafeInteger(event[key]) && (event[key] as number) >= 0)) return;
      this.status.rootPath = resolve(event.rootPath);
      for (const key of keys) this.status[key] = event[key] as number;
      this.status.filesToDownload = Math.max(0, this.status.totalFiles! - this.status.skippedFiles!);
      this.status.updatedAt = new Date().toISOString();
      this.save();
      return;
    }
    const count = line.match(/^\s*((?:[ŁL][aą]czna )?liczba plik[^:]*|Do pobrania|Post[eę]p|Pobrano|Pomini[eę][^:]*|B[lł][eę]d[oó]w)\s*:\s*(\d+)(?:\/(\d+))?\s*$/i);
    if (!count) return;
    const value = Number(count[2]);
    const label = count[1].toLowerCase();
    if (label.includes('liczba')) this.status.totalFiles = value;
    else if (label.startsWith('do pobrania')) this.status.filesToDownload = value;
    else if (label.startsWith('pobrano')) this.status.downloadedFiles = value;
    else if (label.startsWith('pomin')) this.status.skippedFiles = value;
    else if (label.startsWith('b')) this.status.failedFiles = value;
    // "Postęp" means processed attempts, not successfully downloaded files.
    this.status.recentLines = [...this.status.recentLines, `${count[1]}: ${value}${count[3] ? `/${count[3]}` : ''}`].slice(-20);
    this.status.updatedAt = new Date().toISOString();
    this.save();
  }

  private isDownloadPath(path: string): boolean {
    if (!isAbsolute(path)) return false;
    const difference = relative(resolve(this.config.downloadRoot), resolve(path));
    return difference !== '' && difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      && !isAbsolute(difference);
  }

  start(input: DownloadInput): GoogleChatDownloadStatus {
    if (this.isClosing) throw new Error('Serwer jest zatrzymywany.');
    if (this.isRunning()) throw new Error('Pobieranie zdjęć już trwa.');
    if (!input.projectId || !/^spaces\/[A-Za-z0-9_-]+$/.test(input.spaceName)
      || !input.spaceDisplayName.trim() || input.spaceDisplayName.length > 500) throw new Error('Nieprawidłowy czat.');
    if (this.authRequired) throw new GoogleChatRequestError(AUTH_MESSAGE, 'GOOGLE_AUTH_REQUIRED');
    const previousStatus = this.status;
    this.status = { ...idleStatus(), ...input, state: 'RUNNING', startedAt: new Date().toISOString(),
      downloadedFiles: 0, skippedFiles: 0, failedFiles: 0 };
    try {
      this.save();
    } catch {
      this.status = previousStatus;
      throw new Error('Nie udało się zapisać zadania. Sprawdź miejsce i uprawnienia na dysku serwera.');
    }
    this.task = this.queue.run(async () => {
      try {
        if (this.isClosing) { this.status.state = 'PAUSED'; return; }
        const result = await this.runner(['--space', input.spaceName, '--space-display-name', input.spaceDisplayName],
          this.config, (line) => this.progress(line), this.abortController.signal);
        if (result.code === 3 || result.stderr.includes('PHOTO_LOCAL_AUTH_REQUIRED')) {
          this.authRequired = true; this.status.state = 'AUTH_REQUIRED'; this.status.error = AUTH_MESSAGE;
        } else if (result.code === 2 || (this.status.failedFiles ?? 0) > 0) {
          this.status.state = 'PARTIAL_FAILURE';
          this.status.error = 'Część zdjęć nie została pobrana. Wznów pobieranie, aby uzupełnić brakujące pliki.';
        } else if (result.code !== 0) {
          this.status.state = 'FAILED'; this.status.error = 'Pobieranie nie powiodło się. Możesz spróbować ponownie.';
        } else { this.authRequired = false; this.status.state = 'COMPLETED'; }
      } catch {
        this.status.state = this.isClosing ? 'PAUSED' : 'FAILED';
        this.status.error = this.isClosing ? 'Serwer został zatrzymany. Wznów pobieranie.' : 'Pobieranie zostało przerwane. Wznów pobieranie.';
      } finally {
        this.status.finishedAt = new Date().toISOString();
        this.status.updatedAt = this.status.finishedAt;
        this.save();
      }
    });
    // Keep asynchronous persistence failures observed and visible without crashing the server.
    void this.task.catch(() => {
      this.status.state = 'FAILED'; this.status.error = 'Nie udało się zapisać postępu. Sprawdź miejsce na dysku serwera.';
    });
    return this.getStatus();
  }

  resume(projectId: string): GoogleChatDownloadStatus {
    if (this.status.projectId !== projectId || !this.status.spaceName || !this.status.spaceDisplayName
      || !['AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE', 'FAILED'].includes(this.status.state)) {
      throw new Error('Brak przerwanego pobierania dla tego projektu.');
    }
    return this.start({ projectId, spaceName: this.status.spaceName, spaceDisplayName: this.status.spaceDisplayName });
  }

  async waitForIdle(): Promise<void> { await this.task; }
  async close(): Promise<void> {
    this.isClosing = true;
    this.abortController.abort();
    await this.queue.run(async () => undefined);
  }
}
