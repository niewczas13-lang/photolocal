import { describe, expect, it } from 'vitest';
import type { ChatClassificationStatus, ChatImportStatus, GoogleChatDownloadStatus } from '../types';
import { getChatUpdateWorkflowSnapshot } from './chat-update-workflow';

function downloadStatus(partial: Partial<GoogleChatDownloadStatus>): GoogleChatDownloadStatus {
  return {
    state: 'IDLE',
    projectId: 'project-1',
    spaceName: 'spaces/room',
    spaceDisplayName: 'Pokoj budowy',
    recentLines: [],
    ...partial,
  };
}

function importStatus(partial: Partial<ChatImportStatus>): ChatImportStatus {
  return {
    state: 'IDLE',
    projectId: 'project-1',
    rootPath: null,
    phase: null,
    imported: 0,
    waitingForClassification: 0,
    pendingReview: 0,
    cleared: 0,
    processedManifests: 0,
    totalManifests: 0,
    processedFiles: 0,
    totalFiles: 0,
    skippedFiles: 0,
    currentFolderName: null,
    currentFileName: null,
    ...partial,
  };
}

function classificationStatus(partial: Partial<ChatClassificationStatus>): ChatClassificationStatus {
  return {
    state: 'IDLE',
    processed: 0,
    total: 0,
    ...partial,
  };
}

describe('getChatUpdateWorkflowSnapshot', () => {
  it('marks download as active and keeps the modal locked while photos are downloading', () => {
    const snapshot = getChatUpdateWorkflowSnapshot({
      phase: 'download',
      counts: { waiting: 0, ready: 0, review: 0 },
      downloadStatus: downloadStatus({
        state: 'RUNNING',
        downloadedFiles: 4,
        skippedFiles: 6,
        totalFiles: 20,
        filesToDownload: 10,
      }),
      importStatus: null,
      classificationStatus: null,
      error: null,
    });

    expect(snapshot.canClose).toBe(false);
    expect(snapshot.progressPercent).toBe(50);
    expect(snapshot.steps.map((step) => `${step.id}:${step.state}`)).toEqual([
      'download:active',
      'dedupe:waiting',
      'qwen:waiting',
    ]);
    expect(snapshot.details).toContain('Pliki: 10/20');
  });

  it('shows hashing and duplicate checks as the second active step', () => {
    const snapshot = getChatUpdateWorkflowSnapshot({
      phase: 'dedupe',
      counts: { waiting: 0, ready: 0, review: 0 },
      downloadStatus: downloadStatus({ state: 'COMPLETED', totalFiles: 12, downloadedFiles: 2, skippedFiles: 10 }),
      importStatus: importStatus({
        state: 'RUNNING',
        processedFiles: 8,
        totalFiles: 10,
        skippedFiles: 3,
        waitingForClassification: 2,
        currentFolderName: 'UL_ZIOLOWA_1',
      }),
      classificationStatus: null,
      error: null,
    });

    expect(snapshot.progressPercent).toBe(80);
    expect(snapshot.steps.map((step) => `${step.id}:${step.state}`)).toEqual([
      'download:complete',
      'dedupe:active',
      'qwen:waiting',
    ]);
    expect(snapshot.details).toContain('Pominiete duplikaty: 3');
    expect(snapshot.currentItem).toBe('UL_ZIOLOWA_1');
  });

  it('does not offer queue shortcuts before the workflow is finished', () => {
    const snapshot = getChatUpdateWorkflowSnapshot({
      phase: 'qwen',
      counts: { waiting: 0, ready: 4, review: 1 },
      downloadStatus: downloadStatus({ state: 'COMPLETED' }),
      importStatus: importStatus({ state: 'COMPLETED' }),
      classificationStatus: classificationStatus({ state: 'RUNNING', processed: 2, total: 5 }),
      error: null,
    });

    expect(snapshot.canClose).toBe(false);
    expect(snapshot.primaryAction).toBeNull();
    expect(snapshot.secondaryAction).toBeNull();
  });

  it('shows Qwen model load status and diagnostic errors while classifying', () => {
    const snapshot = getChatUpdateWorkflowSnapshot({
      phase: 'qwen',
      counts: { waiting: 0, ready: 0, review: 0 },
      downloadStatus: downloadStatus({ state: 'COMPLETED' }),
      importStatus: importStatus({ state: 'COMPLETED' }),
      classificationStatus: classificationStatus({
        state: 'RUNNING',
        processed: 1,
        total: 3,
        readyForImport: 1,
        pendingReview: 0,
        diagnostics: {
          checkedAt: '2026-05-27T21:50:00.000Z',
          ollamaUrl: 'http://localhost:11434',
          model: 'qwen2.5vl:3b',
          ollamaReachable: true,
          modelLoaded: false,
          processor: null,
          size: null,
          sizeVram: null,
          expiresAt: null,
          gpu: null,
          error: 'Ollama /api/ps HTTP 500',
        },
      }),
      error: null,
    });

    expect(snapshot.details).toContain('Model: qwen2.5vl:3b');
    expect(snapshot.details).toContain('niezaladowany');
    expect(snapshot.details).toContain('Ollama /api/ps HTTP 500');
  });

  it('offers queue shortcuts only after Qwen has finished', () => {
    const snapshot = getChatUpdateWorkflowSnapshot({
      phase: 'done',
      counts: { waiting: 0, ready: 7, review: 2 },
      downloadStatus: downloadStatus({ state: 'COMPLETED' }),
      importStatus: importStatus({ state: 'COMPLETED', waitingForClassification: 9 }),
      classificationStatus: classificationStatus({ state: 'COMPLETED', processed: 9, total: 9, readyForImport: 7, pendingReview: 2 }),
      error: null,
    });

    expect(snapshot.canClose).toBe(true);
    expect(snapshot.steps.map((step) => `${step.id}:${step.state}`)).toEqual([
      'download:complete',
      'dedupe:complete',
      'qwen:complete',
    ]);
    expect(snapshot.primaryAction).toEqual({ tab: 'ready', label: 'Przejdz do Do importu (7)' });
    expect(snapshot.secondaryAction).toEqual({ tab: 'review', label: 'Przejdz do Review (2)' });
  });
});
