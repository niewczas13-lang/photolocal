import type { ProjectsRepository } from '../projects/projects-repository.js';
import type { ProcessedPhoto } from '../photos/photo-processor.js';
import { acceptChatBatch } from './chat-batch-acceptance.js';
import type { ChatBatchesRepository } from './chat-batches-repository.js';

export interface AcceptReadyChatBatchesInput {
  projectId: string;
  projectsRepository: ProjectsRepository;
  batchesRepository: ChatBatchesRepository;
  processPhoto?: (sourceBuffer: Buffer) => Promise<ProcessedPhoto>;
}

export interface AcceptReadyChatBatchesResult {
  importedBatches: number;
  importedPhotos: number;
  skippedBatches: number;
}

function isAcceptedReserveLocation(value: string | null): value is 'Doziemny' | 'W studni' {
  return value === 'Doziemny' || value === 'W studni';
}

export async function acceptReadyChatBatches(
  input: AcceptReadyChatBatchesInput,
): Promise<AcceptReadyChatBatchesResult> {
  const batches = input.batchesRepository.listBatches(input.projectId, 'READY_FOR_IMPORT');
  const result: AcceptReadyChatBatchesResult = {
    importedBatches: 0,
    importedPhotos: 0,
    skippedBatches: 0,
  };

  for (const batch of batches) {
    if (!batch.checklistNodeId) {
      input.batchesRepository.updateDecision({
        projectId: input.projectId,
        batchId: batch.id,
        status: 'PENDING_REVIEW',
        reviewReason: 'Brak kompletnego dopasowania do auto-importu',
        reserveLocation: batch.reserveLocation,
        confidence: batch.confidence,
        llmModel: batch.llmModel,
        llmRawResponse: batch.llmRawResponse,
        visualEvidence: batch.visualEvidence,
      });
      result.skippedBatches += 1;
      continue;
    }

    const node = input.projectsRepository.getChecklistNode(input.projectId, batch.checklistNodeId);
    const needsReserveLocation = node?.nodeType === 'CABLE_RESERVE';

    if (needsReserveLocation && !isAcceptedReserveLocation(batch.reserveLocation)) {
      input.batchesRepository.updateDecision({
        projectId: input.projectId,
        batchId: batch.id,
        status: 'PENDING_REVIEW',
        reviewReason: 'Brak kompletnego dopasowania do auto-importu',
        reserveLocation: batch.reserveLocation,
        confidence: batch.confidence,
        llmModel: batch.llmModel,
        llmRawResponse: batch.llmRawResponse,
        visualEvidence: batch.visualEvidence,
      });
      result.skippedBatches += 1;
      continue;
    }

    const reserveLocation = needsReserveLocation && isAcceptedReserveLocation(batch.reserveLocation)
      ? batch.reserveLocation
      : null;
    const imported = await acceptChatBatch({
      projectId: input.projectId,
      batchId: batch.id,
      checklistNodeIds: [batch.checklistNodeId],
      reserveLocation,
      projectsRepository: input.projectsRepository,
      batchesRepository: input.batchesRepository,
      processPhoto: input.processPhoto,
    });

    result.importedBatches += 1;
    result.importedPhotos += imported.importedPhotos;
  }

  return result;
}
