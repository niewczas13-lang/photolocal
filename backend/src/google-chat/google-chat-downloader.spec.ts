import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoogleChatDownloadManager, type GoogleChatProcessRunner, type GoogleChatRunnerConfig } from './google-chat-downloader.js';
import { GoogleChatOperationQueue } from './google-chat-files.js';

function fixture(runner: GoogleChatProcessRunner) {
  const root = mkdtempSync(join(tmpdir(), 'photo-local-download-'));
  const config: GoogleChatRunnerConfig = { pythonCommand: 'python', scriptPath: join(root, 'chat.py'),
    credentialsFile: join(root, 'credentials.json'), tokenFile: join(root, 'token.json'),
    downloadRoot: join(root, 'downloads'), stateFile: join(root, 'job.json') };
  const queue = new GoogleChatOperationQueue();
  return { manager: new GoogleChatDownloadManager(config, queue, runner), config, queue };
}

const input = { projectId: 'project-one', spaceName: 'spaces/one', spaceDisplayName: 'One' };

describe('durable Google Chat downloads', () => {
  it('can retry after the initial job snapshot cannot be written', async () => {
    const runner = vi.fn<GoogleChatProcessRunner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const { manager, config } = fixture(runner);
    const previous = manager.getStatus();
    // A directory at the snapshot filename reproduces a failed atomic publish on both platforms.
    mkdirSync(config.stateFile);
    try {
      expect(() => manager.start(input)).toThrow();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getStatus()).toEqual(previous);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      rmdirSync(config.stateFile);
    }
    manager.start(input);
    await manager.waitForIdle();
    expect(manager.getStatus().state).toBe('COMPLETED');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('persists authorization-required jobs, reconnects and resumes the same space', async () => {
    const runner = vi.fn<GoogleChatProcessRunner>().mockResolvedValueOnce({ code: 3, stdout: '', stderr: '{"code":"PHOTO_LOCAL_AUTH_REQUIRED"}' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const { manager, config } = fixture(runner);
    manager.start(input);
    await manager.waitForIdle();
    expect(manager.getStatus('project-one')).toMatchObject({ state: 'AUTH_REQUIRED', spaceName: 'spaces/one' });
    const restored = new GoogleChatDownloadManager(config, new GoogleChatOperationQueue(), runner);
    expect(restored.isAuthRequired()).toBe(true);
    restored.markConnected();
    restored.resume('project-one');
    await restored.waitForIdle();
    expect(restored.getStatus('project-one').state).toBe('COMPLETED');
    expect(runner.mock.calls[1][0]).toEqual(['--space', 'spaces/one', '--space-display-name', 'One']);
  });

  it('does not call partial failures complete even with a zero process exit', async () => {
    const { manager } = fixture(async (_args, _config, onLine) => {
      onLine('Pobrano: 2'); onLine('Błędów: 1');
      return { code: 0, stdout: '', stderr: '' };
    });
    manager.start(input);
    await manager.waitForIdle();
    expect(manager.getStatus()).toMatchObject({ state: 'PARTIAL_FAILURE', downloadedFiles: 2, failedFiles: 1 });
  });

  it('restores an interrupted job as paused without automatically writing files', () => {
    const runner = vi.fn<GoogleChatProcessRunner>();
    const { config } = fixture(runner);
    writeFileSync(config.stateFile, JSON.stringify({ version: 1, authRequired: false, status: { state: 'RUNNING', ...input, recentLines: [] } }));
    const manager = new GoogleChatDownloadManager(config, new GoogleChatOperationQueue(), runner);
    expect(manager.getStatus().state).toBe('PAUSED');
    expect(manager.getStatus('another-project').state).toBe('IDLE');
    expect(runner).not.toHaveBeenCalled();
    expect(() => manager.resume('another-project')).toThrow();
  });

  it('serializes list/refresh and reconnect writes and does not persist raw process secrets', async () => {
    let release!: () => void;
    const runner = vi.fn<GoogleChatProcessRunner>().mockImplementation(async (_args, _config, onLine) => {
      onLine('refresh_token=do-not-persist');
      await new Promise<void>((resolve) => { release = resolve; });
      return { code: 3, stdout: '', stderr: 'PHOTO_LOCAL_AUTH_REQUIRED refresh_token=secret' };
    });
    const { manager, queue, config } = fixture(runner);
    manager.start(input);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    const reconnect = vi.fn(async () => undefined);
    const queued = queue.run(reconnect);
    expect(reconnect).not.toHaveBeenCalled();
    release();
    await manager.waitForIdle();
    await queued;
    expect(reconnect).toHaveBeenCalledOnce();
    expect(readFileSync(config.stateFile, 'utf8')).not.toMatch(/secret|do-not-persist|refresh_token/);
  });

  it('reports lost authorization while listing spaces as a dedicated error', async () => {
    const { manager } = fixture(async () => ({ code: 3, stdout: '', stderr: 'PHOTO_LOCAL_AUTH_REQUIRED' }));
    await expect(manager.listSpaces()).rejects.toMatchObject({ code: 'GOOGLE_AUTH_REQUIRED' });
    expect(manager.isAuthRequired()).toBe(true);
  });

  it('retains the actual stable import folder and validated progress after restart', async () => {
    const { config, queue } = fixture(async () => ({ code: 0, stdout: '', stderr: '' }));
    const rootPath = join(config.downloadRoot, 'original-room-name');
    const manager = new GoogleChatDownloadManager(config, queue, async (_args, _config, onLine) => {
      onLine('PHOTO_LOCAL_PROGRESS ' + JSON.stringify({ rootPath, totalFiles: 4, downloadedFiles: 2, skippedFiles: 2, failedFiles: 0, pendingFiles: 0 }));
      onLine('PHOTO_LOCAL_PROGRESS ' + JSON.stringify({ rootPath: join(config.downloadRoot, '..', 'outside'), totalFiles: -5 }));
      return { code: 0, stdout: '', stderr: '' };
    });
    manager.start(input);
    await manager.waitForIdle();
    const restored = new GoogleChatDownloadManager(config, new GoogleChatOperationQueue());
    expect(restored.getStatus()).toMatchObject({ state: 'COMPLETED', rootPath, totalFiles: 4, downloadedFiles: 2, skippedFiles: 2 });
  });
});
