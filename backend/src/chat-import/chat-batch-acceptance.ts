import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectsRepository } from '../projects/projects-repository.js';
import {
  processPhoto as defaultProcessPhoto,
  resolvePhotoTarget,
  type ProcessPhotoOptions,
  type ProcessedPhoto,
  type ReserveLocation,
} from '../photos/photo-processor.js';
import type { ChatBatchesRepository } from './chat-batches-repository.js';

export interface AcceptChatBatchInput {
  projectId: string;
  batchId: string;
  checklistNodeIds: string[];
  fileIds?: string[];
  reserveLocation: ReserveLocation | null;
  projectsRepository: ProjectsRepository;
  batchesRepository: ChatBatchesRepository;
  processPhoto?: (sourceBuffer: Buffer, options?: ProcessPhotoOptions) => Promise<ProcessedPhoto>;
}

export interface AcceptChatBatchResult {
  importedPhotos: number;
  checklistNodeCount: number;
  sourceFileCount: number;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function assertReserveLocationMatchesNodePath(nodePath: string, reserveLocation: ReserveLocation | null): void {
  if (!reserveLocation) return;
  if (nodePath.startsWith('Zapasy_kabli_napowietrznych') && reserveLocation !== 'Napowietrzny') {
    throw new Error('Aerial cable reserve nodes require Napowietrzny reserve location');
  }
  if (nodePath.startsWith('Zapasy_kabli_instalacyjnych') && reserveLocation === 'Napowietrzny') {
    throw new Error('Underground cable reserve nodes cannot use Napowietrzny reserve location');
  }
}

export async function acceptChatBatch(input: AcceptChatBatchInput): Promise<AcceptChatBatchResult> {
  const project = input.projectsRepository.getProject(input.projectId);
  const batch = input.batchesRepository.getBatch(input.projectId, input.batchId);
  const batchFiles = input.batchesRepository.listBatchFiles(input.projectId, input.batchId);
  const files = input.fileIds && input.fileIds.length > 0
    ? batchFiles.filter((file) => input.fileIds?.includes(file.id))
    : batchFiles;
  const processor = input.processPhoto ?? defaultProcessPhoto;
  const knownPhotoHashes = new Set(input.projectsRepository.listProjectPhotoContentHashes(input.projectId));

  if (!project) throw new Error('Project not found');
  if (!batch) throw new Error('Chat batch not found');
  if (input.checklistNodeIds.length === 0) throw new Error('At least one checklist node is required');
  if (batch.status === 'IMPORTED') throw new Error('Chat batch was already imported');
  if (batch.status === 'REJECTED') throw new Error('Chat batch was already rejected');
  if (batchFiles.length === 0) throw new Error('Chat batch has no remaining files');
  if (files.length === 0) throw new Error('Selected chat batch files are no longer available');

  let importedPhotos = 0;

  for (const nodeId of input.checklistNodeIds) {
    const node = input.projectsRepository.getChecklistNode(input.projectId, nodeId);
    if (!node) throw new Error(`Checklist node ${nodeId} not found`);
    if (!Boolean(node.acceptsPhotos)) throw new Error(`Checklist node ${nodeId} does not accept photos`);
    if (node.nodeType === 'CABLE_RESERVE' && !input.reserveLocation) {
      throw new Error(`Reserve location is required for checklist node ${nodeId}`);
    }
    const nodeReserveLocation = node.nodeType === 'CABLE_RESERVE' ? input.reserveLocation : null;
    assertReserveLocationMatchesNodePath(node.path, nodeReserveLocation);

    let existingCount = input.projectsRepository.countPhotosForNode(nodeId, nodeReserveLocation);

    for (const file of files) {
      const photoId = randomUUID();
      const sourceBuffer = await readFile(file.sourcePath);
      const contentHash = file.contentHash ?? sha256(sourceBuffer);
      if (knownPhotoHashes.has(contentHash)) {
        continue;
      }
      const processed = await processor(sourceBuffer, {
        fallbackCapturedAt: batch.sourceCreateTime,
      });
      const target = resolvePhotoTarget({
        projectFolder: project.baseFolder,
        nodePath: node.path,
        nodeName: node.name,
        existingCount,
        reserveLocation: nodeReserveLocation,
        sourceFileName: file.fileName,
      });
      const thumbnailPath = join(project.baseFolder, '.thumbnails', `${photoId}.webp`);

      await mkdir(dirname(target.absolutePath), { recursive: true });
      await mkdir(dirname(thumbnailPath), { recursive: true });
      await writeFile(target.absolutePath, processed.buffer);
      await writeFile(thumbnailPath, processed.thumbnail);

      input.projectsRepository.addPhoto({
        id: photoId,
        projectId: input.projectId,
        checklistNodeId: nodeId,
        sourceFileName: file.fileName,
        storedFileName: target.fileName,
        storagePath: target.absolutePath,
        thumbnailPath,
        mimeType: processed.mimeType,
        fileSize: processed.fileSize,
        lat: processed.lat,
        lng: processed.lng,
        capturedAt: processed.capturedAt,
        reserveLocation: nodeReserveLocation,
        contentHash,
      });
      input.batchesRepository.recordFileImport({
        chatPhotoFileId: file.id,
        photoId,
        checklistNodeId: nodeId,
      });

      existingCount += 1;
      importedPhotos += 1;
    }
  }

  const importedFileIds = files.map((file) => file.id);
  input.batchesRepository.removeBatchFiles(input.projectId, input.batchId, importedFileIds);
  const remainingFiles = input.batchesRepository.listBatchFiles(input.projectId, input.batchId);
  const isFullyConsumed = remainingFiles.length === 0;

  input.batchesRepository.updateDecision({
    projectId: input.projectId,
    batchId: input.batchId,
    status: isFullyConsumed ? 'IMPORTED' : 'PENDING_REVIEW',
    reviewReason: isFullyConsumed ? null : batch.reviewReason,
    checklistNodeId:
      isFullyConsumed && input.checklistNodeIds.length === 1 ? input.checklistNodeIds[0] : null,
    reserveLocation: isFullyConsumed ? input.reserveLocation : batch.reserveLocation,
    confidence: batch.confidence,
    llmModel: batch.llmModel,
    llmRawResponse: batch.llmRawResponse,
    visualEvidence: batch.visualEvidence,
  });

  return {
    importedPhotos,
    checklistNodeCount: input.checklistNodeIds.length,
    sourceFileCount: files.length,
  };
}
