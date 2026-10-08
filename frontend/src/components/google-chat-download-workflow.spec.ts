import { describe, expect, it } from 'vitest';
import type { GoogleChatDownloadStatus } from '../types';
import {
  canResumeGoogleChatDownload,
  canReplaceGoogleChatDownload,
  getGoogleChatImportRoot,
  waitForCompletedGoogleChatDownload,
} from './google-chat-download-workflow';

function status(state: GoogleChatDownloadStatus['state']): GoogleChatDownloadStatus {
  return {
    state, projectId: 'project-1', spaceName: 'spaces/1',
    spaceDisplayName: 'Pokój / 1', recentLines: [], downloadedFiles: 3, totalFiles: 10,
  };
}

describe('saved Google Chat download workflow', () => {
  it.each(['FAILED', 'AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE'] as const)(
    'allows replacing a non-active %s job while still offering its saved resume', (state) => {
      const savedJob = Object.freeze(status(state));

      expect(canReplaceGoogleChatDownload(savedJob)).toBe(true);
      expect(canResumeGoogleChatDownload(savedJob)).toBe(true);
      expect(savedJob.downloadedFiles).toBe(3);
    },
  );

  it('does not replace an active download with a parallel job', () => {
    expect(canReplaceGoogleChatDownload(status('RUNNING'))).toBe(false);
  });

  it.each(['IDLE', 'FAILED', 'AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE'] as const)(
    'does not continue to import after a %s download',
    async (state) => {
      let imported = false;
      const workflow = async () => {
        await waitForCompletedGoogleChatDownload(status(state), {
          getStatus: async () => status(state), onStatus: () => {},
          wait: async () => {}, isCurrent: () => true,
        });
        imported = true;
      };
      await expect(workflow()).rejects.toThrow();
      expect(imported).toBe(false);
    },
  );

  it('waits for the saved job and preserves each progress update before import', async () => {
    const states: GoogleChatDownloadStatus['state'][] = [];
    const completed = await waitForCompletedGoogleChatDownload(status('RUNNING'), {
      getStatus: async () => status('COMPLETED'),
      onStatus: (value) => states.push(value.state),
      wait: async () => {}, isCurrent: () => true,
    });
    expect(states).toEqual(['RUNNING', 'COMPLETED']);
    expect(completed.state).toBe('COMPLETED');
  });

  it('ignores a completed response when the user has left the project', async () => {
    let isCurrent = true;
    const states: GoogleChatDownloadStatus['state'][] = [];
    await expect(waitForCompletedGoogleChatDownload(status('RUNNING'), {
      getStatus: async () => { isCurrent = false; return status('COMPLETED'); },
      onStatus: (value) => states.push(value.state),
      wait: async () => {}, isCurrent: () => isCurrent,
    })).rejects.toThrow();
    expect(states).toEqual(['RUNNING']);
  });

  it.each(['FAILED', 'AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE'] as const)(
    'offers resume for the saved %s job', (state) => {
      expect(canResumeGoogleChatDownload(status(state))).toBe(true);
    },
  );

  it('does not resume an idle, running, completed, or missing job', () => {
    for (const state of ['IDLE', 'RUNNING', 'COMPLETED'] as const) {
      expect(canResumeGoogleChatDownload(status(state))).toBe(false);
    }
    expect(canResumeGoogleChatDownload(null)).toBe(false);
  });

  it('uses the saved root path, including when the room name changed', () => {
    expect(getGoogleChatImportRoot('/data/chat', {
      ...status('COMPLETED'), rootPath: '/data/chat/old-name',
    })).toBe('/data/chat/old-name');
  });

  it('builds compatible fallback paths for Linux and Windows', () => {
    expect(getGoogleChatImportRoot('/data/chat/', status('COMPLETED'))).toBe('/data/chat/Pokój _ 1');
    expect(getGoogleChatImportRoot('C:\\chat\\', status('COMPLETED'))).toBe('C:\\chat\\Pokój _ 1');
  });
});
