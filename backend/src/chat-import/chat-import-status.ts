import type { ChatImportProgressEvent, ImportChatFoldersResult } from './chat-importer.js';

export type ChatImportState = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ChatImportStatus extends ImportChatFoldersResult {
  state: ChatImportState;
  projectId: string | null;
  rootPath: string | null;
  phase: ChatImportProgressEvent['phase'] | null;
  processedManifests: number;
  totalManifests: number;
  processedFiles: number;
  totalFiles: number;
  skippedFiles: number;
  currentFolderName: string | null;
  currentFileName: string | null;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
}

const statuses = new Map<string, ChatImportStatus>();

function idleStatus(projectId: string): ChatImportStatus {
  return {
    state: 'IDLE',
    projectId,
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
  };
}

export function getChatImportStatus(projectId: string): ChatImportStatus {
  return statuses.get(projectId) ?? idleStatus(projectId);
}

export function startChatImport(projectId: string, rootPath: string): void {
  const now = new Date().toISOString();
  statuses.set(projectId, {
    ...idleStatus(projectId),
    state: 'RUNNING',
    rootPath,
    phase: 'scanning',
    startedAt: now,
    updatedAt: now,
  });
}

export function updateChatImportProgress(event: ChatImportProgressEvent): void {
  const current = getChatImportStatus(event.projectId);
  statuses.set(event.projectId, {
    ...current,
    ...event,
    state: 'RUNNING',
    updatedAt: event.updatedAt,
  });
}

export function completeChatImport(projectId: string, result: ImportChatFoldersResult): void {
  const current = getChatImportStatus(projectId);
  const now = new Date().toISOString();
  statuses.set(projectId, {
    ...current,
    ...result,
    state: 'COMPLETED',
    phase: 'done',
    currentFolderName: null,
    currentFileName: null,
    updatedAt: now,
    finishedAt: now,
  });
}

export function failChatImport(projectId: string, error: unknown): void {
  const current = getChatImportStatus(projectId);
  const now = new Date().toISOString();
  statuses.set(projectId, {
    ...current,
    state: 'FAILED',
    currentFolderName: null,
    currentFileName: null,
    updatedAt: now,
    finishedAt: now,
    error: error instanceof Error ? error.message : String(error),
  });
}
