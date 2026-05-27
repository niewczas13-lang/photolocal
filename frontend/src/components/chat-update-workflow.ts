import type { ChatClassificationStatus, ChatImportStatus, GoogleChatDownloadStatus } from '../types';

export type ChatUpdateWorkflowPhase = 'idle' | 'download' | 'dedupe' | 'qwen' | 'done' | 'failed';
export type ChatUpdateWorkflowStepId = 'download' | 'dedupe' | 'qwen';
export type ChatUpdateWorkflowStepState = 'waiting' | 'active' | 'complete' | 'failed';

export interface ChatUpdateWorkflowCounts {
  waiting: number;
  ready: number;
  review: number;
}

export interface ChatUpdateWorkflowAction {
  tab: 'ready' | 'review';
  label: string;
}

export interface ChatUpdateWorkflowStep {
  id: ChatUpdateWorkflowStepId;
  label: string;
  state: ChatUpdateWorkflowStepState;
}

export interface ChatUpdateWorkflowSnapshot {
  title: string;
  description: string;
  progressPercent: number;
  steps: ChatUpdateWorkflowStep[];
  details: string;
  currentItem: string | null;
  canClose: boolean;
  primaryAction: ChatUpdateWorkflowAction | null;
  secondaryAction: ChatUpdateWorkflowAction | null;
}

export interface GetChatUpdateWorkflowSnapshotInput {
  phase: ChatUpdateWorkflowPhase;
  counts: ChatUpdateWorkflowCounts;
  downloadStatus: GoogleChatDownloadStatus | null;
  importStatus: ChatImportStatus | null;
  classificationStatus: ChatClassificationStatus | null;
  error: string | null;
}

export function getChatUpdateWorkflowSnapshot(
  input: GetChatUpdateWorkflowSnapshotInput,
): ChatUpdateWorkflowSnapshot {
  const steps: ChatUpdateWorkflowStep[] = [
    { id: 'download', label: 'Pobieranie zdjec', state: stepState('download', input) },
    { id: 'dedupe', label: 'Haszowanie i duplikaty', state: stepState('dedupe', input) },
    { id: 'qwen', label: 'Qwen', state: stepState('qwen', input) },
  ];

  return {
    title: getTitle(input.phase),
    description: getDescription(input.phase),
    progressPercent: getProgressPercent(input),
    steps,
    details: getDetails(input),
    currentItem: getCurrentItem(input),
    canClose: input.phase === 'idle' || input.phase === 'done' || input.phase === 'failed',
    primaryAction: input.phase === 'done' ? getPrimaryAction(input.counts) : null,
    secondaryAction: input.phase === 'done' ? getSecondaryAction(input.counts) : null,
  };
}

function stepState(
  step: ChatUpdateWorkflowStepId,
  input: GetChatUpdateWorkflowSnapshotInput,
): ChatUpdateWorkflowStepState {
  if (input.phase === 'failed') {
    if (input.classificationStatus?.state === 'FAILED') return step === 'qwen' ? 'failed' : 'complete';
    if (input.importStatus?.state === 'FAILED') {
      if (step === 'download') return 'complete';
      return step === 'dedupe' ? 'failed' : 'waiting';
    }
    return step === 'download' ? 'failed' : 'waiting';
  }

  const order: ChatUpdateWorkflowStepId[] = ['download', 'dedupe', 'qwen'];
  const currentIndex = order.indexOf(phaseToStep(input.phase));
  const stepIndex = order.indexOf(step);

  if (input.phase === 'idle') return 'waiting';
  if (input.phase === 'done') return 'complete';
  if (stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'active';
  return 'waiting';
}

function phaseToStep(phase: ChatUpdateWorkflowPhase): ChatUpdateWorkflowStepId {
  if (phase === 'dedupe') return 'dedupe';
  if (phase === 'qwen' || phase === 'done') return 'qwen';
  return 'download';
}

function getTitle(phase: ChatUpdateWorkflowPhase): string {
  if (phase === 'done') return 'Aktualizacja gotowa';
  if (phase === 'failed') return 'Aktualizacja przerwana';
  return 'Aktualizacja zdjec z Google Chat';
}

function getDescription(phase: ChatUpdateWorkflowPhase): string {
  if (phase === 'download') return 'Pobieram nowe zdjecia z przypisanego pokoju.';
  if (phase === 'dedupe') return 'Hashuje zdjecia i odrzucam duplikaty z dysku oraz z kolejki.';
  if (phase === 'qwen') return 'Qwen sprawdza paczki i kieruje je do importu albo review.';
  if (phase === 'done') return 'Mozna przejsc do akceptacji albo review.';
  if (phase === 'failed') return 'Sprawdz komunikat bledu i sprobuj ponownie.';
  return 'Workflow jest gotowy do startu.';
}

function getProgressPercent(input: GetChatUpdateWorkflowSnapshotInput): number {
  if (input.phase === 'done') return 100;
  if (input.phase === 'download') {
    const total = input.downloadStatus?.totalFiles ?? 0;
    const done = (input.downloadStatus?.downloadedFiles ?? 0) + (input.downloadStatus?.skippedFiles ?? 0);
    return percent(done, total);
  }
  if (input.phase === 'dedupe') {
    return percent(input.importStatus?.processedFiles ?? 0, input.importStatus?.totalFiles ?? 0);
  }
  if (input.phase === 'qwen') {
    return percent(input.classificationStatus?.processed ?? 0, input.classificationStatus?.total ?? 0);
  }
  return 0;
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function getDetails(input: GetChatUpdateWorkflowSnapshotInput): string {
  if (input.error) return input.error;
  if (input.phase === 'download') {
    const total = input.downloadStatus?.totalFiles ?? 0;
    const done = (input.downloadStatus?.downloadedFiles ?? 0) + (input.downloadStatus?.skippedFiles ?? 0);
    const toDownload = input.downloadStatus?.filesToDownload ?? 0;
    const skipped = input.downloadStatus?.skippedFiles ?? 0;
    return `Pliki: ${done}/${total} | Do pobrania: ${toDownload} | Pominiete: ${skipped}`;
  }
  if (input.phase === 'dedupe') {
    const status = input.importStatus;
    return [
      `Paczki: ${status?.processedManifests ?? 0}/${status?.totalManifests ?? 0}`,
      `Pominiete duplikaty: ${status?.skippedFiles ?? 0}`,
      `Do Qwena: ${status?.waitingForClassification ?? 0}`,
      `Review: ${status?.pendingReview ?? 0}`,
    ].join(' | ');
  }
  if (input.phase === 'qwen') {
    const status = input.classificationStatus;
    return [
      `Qwen: ${status?.processed ?? 0}/${status?.total ?? 0}`,
      `Do importu: ${status?.readyForImport ?? input.counts.ready}`,
      `Review: ${status?.pendingReview ?? input.counts.review}`,
    ].join(' | ');
  }
  if (input.phase === 'done') {
    return `Gotowe: Do importu ${input.counts.ready}, Review ${input.counts.review}, Czeka na Qwen ${input.counts.waiting}.`;
  }
  return 'Kliknij aktualizacje, zeby wystartowac pelny przebieg.';
}

function getCurrentItem(input: GetChatUpdateWorkflowSnapshotInput): string | null {
  if (input.phase === 'dedupe') return input.importStatus?.currentFolderName ?? input.importStatus?.currentFileName ?? null;
  if (input.phase === 'qwen') return input.classificationStatus?.currentFolderName ?? null;
  return null;
}

function getPrimaryAction(counts: ChatUpdateWorkflowCounts): ChatUpdateWorkflowAction | null {
  if (counts.ready > 0) return { tab: 'ready', label: `Przejdz do Do importu (${counts.ready})` };
  if (counts.review > 0) return { tab: 'review', label: `Przejdz do Review (${counts.review})` };
  return null;
}

function getSecondaryAction(counts: ChatUpdateWorkflowCounts): ChatUpdateWorkflowAction | null {
  if (counts.ready > 0 && counts.review > 0) {
    return { tab: 'review', label: `Przejdz do Review (${counts.review})` };
  }
  return null;
}
