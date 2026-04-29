import type { ChatClassificationDebugEvent, ChatClassificationProgressEvent } from './chat-classification-runner.js';

export type ChatClassificationState = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ChatClassificationStatus {
  state: ChatClassificationState;
  processed: number;
  total: number;
  currentBatchId?: string | null;
  currentFolderName?: string | null;
  readyForImport?: number;
  pendingReview?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentDecisions?: ChatClassificationDebugEvent[];
}

const statuses = new Map<string, ChatClassificationStatus>();

export function getChatClassificationStatus(projectId: string): ChatClassificationStatus {
  return statuses.get(projectId) ?? { state: 'IDLE', processed: 0, total: 0 };
}

export function startChatClassification(projectId: string): void {
  const now = new Date().toISOString();
  statuses.set(projectId, {
    state: 'RUNNING',
    processed: 0,
    total: 0,
    currentBatchId: null,
    currentFolderName: null,
    readyForImport: 0,
    pendingReview: 0,
    startedAt: now,
    updatedAt: now,
    recentDecisions: [],
  });
}

export function updateChatClassificationProgress(event: ChatClassificationProgressEvent): void {
  const current = getChatClassificationStatus(event.projectId);
  const recentDecisions = event.lastDecision
    ? [event.lastDecision, ...(current.recentDecisions ?? [])].slice(0, 5)
    : current.recentDecisions ?? [];

  statuses.set(event.projectId, {
    state: 'RUNNING',
    processed: event.processed,
    total: event.total,
    currentBatchId: event.currentBatchId,
    currentFolderName: event.currentFolderName,
    readyForImport: event.readyForImport,
    pendingReview: event.pendingReview,
    startedAt: event.startedAt,
    updatedAt: event.updatedAt,
    recentDecisions,
  });
}

export function completeChatClassification(projectId: string, result: { processed: number; readyForImport: number; pendingReview: number }): void {
  const current = getChatClassificationStatus(projectId);
  const now = new Date().toISOString();
  statuses.set(projectId, {
    ...current,
    state: 'COMPLETED',
    processed: result.processed,
    total: Math.max(current.total, result.processed),
    currentBatchId: null,
    currentFolderName: null,
    readyForImport: result.readyForImport,
    pendingReview: result.pendingReview,
    updatedAt: now,
    finishedAt: now,
    recentDecisions: current.recentDecisions ?? [],
  });
}

export function failChatClassification(projectId: string, error: unknown): void {
  const current = getChatClassificationStatus(projectId);
  const now = new Date().toISOString();
  statuses.set(projectId, {
    ...current,
    state: 'FAILED',
    currentBatchId: null,
    currentFolderName: null,
    updatedAt: now,
    finishedAt: now,
    error: error instanceof Error ? error.message : String(error),
  });
}
