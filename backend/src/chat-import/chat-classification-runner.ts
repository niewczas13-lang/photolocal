import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import type { ProjectsRepository } from '../projects/projects-repository.js';
import {
  type ChatBatchesRepository,
  type ChatBatchRecord,
  type ChatBatchStatus,
} from './chat-batches-repository.js';
import {
  classifyChatFolder,
  type ClassifyFolderInput,
  type ChatFolderClassification,
  type ReserveClassification,
} from './vision-classifier.js';

export interface ClassifyWaitingChatBatchesInput {
  projectId: string;
  projectsRepository: ProjectsRepository;
  batchesRepository: ChatBatchesRepository;
  classifyFolder?: (input: ClassifyFolderInput) => Promise<ChatFolderClassification>;
  onProgress?: (event: ChatClassificationProgressEvent) => void;
}

export interface ClassifyWaitingChatBatchesResult {
  processed: number;
  readyForImport: number;
  pendingReview: number;
}

export interface ChatClassificationProgressEvent {
  projectId: string;
  processed: number;
  total: number;
  currentBatchId: string | null;
  currentFolderName: string | null;
  lastDecision?: ChatClassificationDebugEvent;
  readyForImport: number;
  pendingReview: number;
  startedAt: string;
  updatedAt: string;
}

export interface ChatClassificationDebugEvent {
  folderName: string;
  messageText: string;
  model: string;
  reserveLocation: ReserveClassification;
  confidence: number;
  shouldReview: boolean;
  reviewReason: string | null;
  matchedChecklistNodeId: string | null;
  matchedChecklistNodeName: string | null;
  status: ChatBatchStatus;
  rawResponsePreview?: string;
  visualEvidence: string[];
}

interface ChecklistCandidate {
  id: string;
  name: string;
  path: string;
  nodeType: string;
  acceptsPhotos: number | boolean;
}

const VALID_RESERVE_LOCATIONS = new Set<ReserveClassification>(['Doziemny', 'W studni']);

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/^ul\.?\s+/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function splitStreetAndBuilding(value: string): { street: string; building: string } | null {
  const normalized = normalizeMatchText(value);
  const match = normalized.match(/^(?<street>.+?)\s+(?<building>(?:d\s*)?\d+[a-z]?)$/i);
  if (!match?.groups) return null;

  return {
    street: match.groups.street.trim(),
    building: match.groups.building.replace(/\s+/g, '').trim(),
  };
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function isLikelyStreetTypo(left: string, right: string): boolean {
  if (left === '' || right === '') return false;
  if (left === right) return true;
  const distance = levenshtein(left, right);
  const maxLength = Math.max(left.length, right.length);
  return distance <= 2 || distance / maxLength <= 0.18;
}

function findChecklistCandidate(batch: ChatBatchRecord, rows: unknown[]): ChecklistCandidate | null {
  const source = normalizeMatchText(`${batch.messageText} ${batch.folderName}`);
  const candidates = rows.filter((row): row is ChecklistCandidate => {
    if (row === null || typeof row !== 'object') return false;
    const candidate = row as Partial<ChecklistCandidate>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.path === 'string' &&
      candidate.nodeType === 'CABLE_RESERVE' &&
      Boolean(candidate.acceptsPhotos)
    );
  });

  const matches = candidates.filter((candidate) => {
    const name = normalizeMatchText(candidate.name);
    const pathTail = normalizeMatchText(candidate.path.split('/').at(-1) ?? candidate.path);
    if ((name !== '' && source.includes(name)) || (pathTail !== '' && source.includes(pathTail))) {
      return true;
    }

    const candidateAddress = splitStreetAndBuilding(candidate.name);
    if (!candidateAddress || !source.includes(candidateAddress.building)) {
      return false;
    }

    const sourceCandidates = Array.from(source.matchAll(/(?<street>[a-z ]+?)\s+(?<building>(?:d\s*)?\d+[a-z]?)/gi))
      .map((match) => match.groups)
      .filter((groups): groups is { street: string; building: string } => Boolean(groups));

    return sourceCandidates.some(
      (sourceAddress) =>
        sourceAddress.building.replace(/\s+/g, '') === candidateAddress.building &&
        isLikelyStreetTypo(sourceAddress.street.trim(), candidateAddress.street),
    );
  });

  return matches.length === 1 ? matches[0] : null;
}

function findDistributionDetailCandidate(batch: ChatBatchRecord, rows: unknown[]): ChecklistCandidate | null {
  const source = normalizeMatchText(`${batch.messageText} ${batch.folderName}`);
  const pointMatch = source.match(/\b(?:osd|opp|zs)\s*\d*\b/i);
  if (!pointMatch) return null;

  const point = pointMatch[0].replace(/\s+/g, '').toLowerCase();
  const candidates = rows.filter((row): row is ChecklistCandidate => {
    if (row === null || typeof row !== 'object') return false;
    const candidate = row as Partial<ChecklistCandidate>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.path !== 'string' ||
      !Boolean(candidate.acceptsPhotos)
    ) {
      return false;
    }

    const normalizedPath = normalizeMatchText(candidate.path).replace(/\s+/g, '');
    return normalizedPath.includes(point) && normalizedPath.includes('szczegolyskrzynki');
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function decideStatus(
  classification: ChatFolderClassification,
  candidate: ChecklistCandidate | null,
): { status: ChatBatchStatus; reviewReason: string | null; checklistNodeId: string | null; reserveLocation: ReserveClassification | null } {
  if (classification.reason?.startsWith('Nie udalo sie sparsowac odpowiedzi modelu')) {
    return {
      status: 'WAITING_FOR_CLASSIFICATION',
      reviewReason: 'Blad odpowiedzi LLM - ponow klasyfikacje',
      checklistNodeId: null,
      reserveLocation: null,
    };
  }

  if (classification.shouldReview || !VALID_RESERVE_LOCATIONS.has(classification.reserveLocation)) {
    return {
      status: 'PENDING_REVIEW',
      reviewReason: 'LLM wymaga recznego sprawdzenia',
      checklistNodeId: null,
      reserveLocation: null,
    };
  }

  if (!candidate) {
    return {
      status: 'PENDING_REVIEW',
      reviewReason: 'Nie znaleziono jednoznacznego punktu checklisty',
      checklistNodeId: null,
      reserveLocation: classification.reserveLocation,
    };
  }

  return {
    status: 'READY_FOR_IMPORT',
    reviewReason: null,
    checklistNodeId: candidate.id,
    reserveLocation: classification.reserveLocation,
  };
}

export async function classifyWaitingChatBatches(
  input: ClassifyWaitingChatBatchesInput,
): Promise<ClassifyWaitingChatBatchesResult> {
  const classifier = input.classifyFolder ?? classifyChatFolder;
  const checklistRows = input.projectsRepository.getChecklist(input.projectId);
  const batches = input.batchesRepository.listBatches(input.projectId, 'WAITING_FOR_CLASSIFICATION');
  const startedAt = new Date().toISOString();
  const result: ClassifyWaitingChatBatchesResult = {
    processed: 0,
    readyForImport: 0,
    pendingReview: 0,
  };

  for (const batch of batches) {
    await yieldToEventLoop();

    input.onProgress?.({
      projectId: input.projectId,
      processed: result.processed,
      total: batches.length,
      currentBatchId: batch.id,
      currentFolderName: batch.folderName,
      readyForImport: result.readyForImport,
      pendingReview: result.pendingReview,
      startedAt,
      updatedAt: new Date().toISOString(),
    });

    const distributionCandidate = findDistributionDetailCandidate(batch, checklistRows);
    if (distributionCandidate) {
      input.batchesRepository.updateDecision({
        projectId: input.projectId,
        batchId: batch.id,
        status: 'READY_FOR_IMPORT',
        reviewReason: null,
        checklistNodeId: distributionCandidate.id,
        reserveLocation: null,
        confidence: null,
        llmModel: null,
        llmRawResponse: null,
        visualEvidence: [],
      });
      result.processed += 1;
      result.readyForImport += 1;
      input.onProgress?.({
        projectId: input.projectId,
        processed: result.processed,
        total: batches.length,
        currentBatchId: null,
        currentFolderName: null,
        lastDecision: {
          folderName: batch.folderName,
          messageText: batch.messageText,
          model: 'rule-based',
          reserveLocation: 'Inne',
          confidence: 1,
          shouldReview: false,
          reviewReason: null,
          matchedChecklistNodeId: distributionCandidate.id,
          matchedChecklistNodeName: distributionCandidate.name,
          status: 'READY_FOR_IMPORT',
          visualEvidence: ['Dopasowano punkt techniczny do Szczegoly_skrzynki'],
        },
        readyForImport: result.readyForImport,
        pendingReview: result.pendingReview,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    const files = input.batchesRepository.listBatchFiles(input.projectId, batch.id);
    const classification = await classifier({
      folderPath: batch.folderPath,
    });
    const candidate = findChecklistCandidate(batch, checklistRows);
    const decision = decideStatus(classification, candidate);

    input.batchesRepository.updateDecision({
      projectId: input.projectId,
      batchId: batch.id,
      status: decision.status,
      reviewReason: decision.reviewReason,
      checklistNodeId: decision.checklistNodeId,
      reserveLocation: decision.reserveLocation,
      confidence: classification.confidence,
      llmModel: classification.model,
      llmRawResponse: classification.rawResponse,
      visualEvidence: classification.visualEvidence,
    });

    result.processed += 1;
    if (decision.status === 'READY_FOR_IMPORT') {
      result.readyForImport += 1;
    }
    if (decision.status === 'PENDING_REVIEW') {
      result.pendingReview += 1;
    }

    input.onProgress?.({
      projectId: input.projectId,
      processed: result.processed,
      total: batches.length,
      currentBatchId: null,
      currentFolderName: null,
      lastDecision: {
        folderName: batch.folderName,
        messageText: batch.messageText,
        model: classification.model,
        reserveLocation: classification.reserveLocation,
        confidence: classification.confidence,
        shouldReview: classification.shouldReview,
        reviewReason: decision.reviewReason,
        matchedChecklistNodeId: candidate?.id ?? null,
        matchedChecklistNodeName: candidate?.name ?? null,
        status: decision.status,
        rawResponsePreview: classification.rawResponse?.slice(0, 500),
        visualEvidence: classification.visualEvidence,
      },
      readyForImport: result.readyForImport,
      pendingReview: result.pendingReview,
      startedAt,
      updatedAt: new Date().toISOString(),
    });

    await yieldToEventLoop();
  }

  return result;
}
