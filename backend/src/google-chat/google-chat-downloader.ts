import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

export interface GoogleChatSpace {
  name: string;
  displayName: string;
  spaceType: string;
}

export interface GoogleChatDownloadStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  projectId: string | null;
  spaceName: string | null;
  spaceDisplayName: string | null;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentLines: string[];
}

export interface GoogleChatRunnerConfig {
  pythonCommand: string;
  scriptPath: string;
}

const status: GoogleChatDownloadStatus = {
  state: 'IDLE',
  projectId: null,
  spaceName: null,
  spaceDisplayName: null,
  recentLines: [],
};

function rememberLine(line: string): void {
  const value = line.trim();
  if (!value) return;
  status.recentLines = [...status.recentLines, value].slice(-40);
  status.updatedAt = new Date().toISOString();
}

function runPython(args: string[], config: GoogleChatRunnerConfig): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonCommand, [config.scriptPath, ...args], {
      cwd: dirname(config.scriptPath),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      for (const line of chunk.split(/\r?\n/)) rememberLine(line);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      for (const line of chunk.split(/\r?\n/)) rememberLine(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `Google Chat downloader exited with code ${code}`));
      }
    });
  });
}

export async function listGoogleChatSpaces(config: GoogleChatRunnerConfig): Promise<GoogleChatSpace[]> {
  const result = await runPython(['--list-spaces-json'], config);
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((space): space is GoogleChatSpace => {
      if (!space || typeof space !== 'object') return false;
      const candidate = space as Partial<GoogleChatSpace>;
      return typeof candidate.name === 'string' && typeof candidate.displayName === 'string';
    })
    .map((space) => ({
      name: space.name,
      displayName: space.displayName || space.name,
      spaceType: space.spaceType || '',
    }));
}

export function getGoogleChatDownloadStatus(): GoogleChatDownloadStatus {
  return { ...status, recentLines: [...status.recentLines] };
}

export function startGoogleChatDownload(input: {
  projectId: string;
  spaceName: string;
  spaceDisplayName: string;
  config: GoogleChatRunnerConfig;
}): GoogleChatDownloadStatus {
  if (status.state === 'RUNNING') {
    throw new Error('Google Chat download is already running');
  }

  const now = new Date().toISOString();
  status.state = 'RUNNING';
  status.projectId = input.projectId;
  status.spaceName = input.spaceName;
  status.spaceDisplayName = input.spaceDisplayName;
  status.startedAt = now;
  status.updatedAt = now;
  status.finishedAt = undefined;
  status.error = undefined;
  status.recentLines = [];

  void runPython(
    ['--space', input.spaceName, '--space-display-name', input.spaceDisplayName],
    input.config,
  )
    .then(() => {
      status.state = 'COMPLETED';
      status.finishedAt = new Date().toISOString();
      status.updatedAt = status.finishedAt;
    })
    .catch((error: unknown) => {
      status.state = 'FAILED';
      status.error = error instanceof Error ? error.message : String(error);
      status.finishedAt = new Date().toISOString();
      status.updatedAt = status.finishedAt;
    });

  return getGoogleChatDownloadStatus();
}
