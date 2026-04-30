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
import {
  findBestChecklistCandidate,
  findBestDistributionDetailCandidate,
} from './checklist-matcher.js';

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

const VALID_RESERVE_LOCATIONS = new Set<ReserveClassification>(['Doziemny', 'W studni']);

function decideStatus(
  classification: ChatFolderClassification,
  candidate: { id: string } | null,
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

    const distributionCandidate = findBestDistributionDetailCandidate(
      `${batch.messageText} ${batch.folderName}`,
      checklistRows,
    );
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

    const classification = await classifier({
      folderPath: batch.folderPath,
    });
    const match = findBestChecklistCandidate(`${batch.messageText} ${batch.folderName}`, checklistRows);
    const candidate = match?.candidate ?? null;
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
