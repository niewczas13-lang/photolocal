import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectsRepository } from '../projects/projects-repository.js';
import {
  processPhoto as defaultProcessPhoto,
  resolvePhotoTarget,
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
  processPhoto?: (sourceBuffer: Buffer) => Promise<ProcessedPhoto>;
}

export interface AcceptChatBatchResult {
  importedPhotos: number;
  checklistNodeCount: number;
  sourceFileCount: number;
}

export async function acceptChatBatch(input: AcceptChatBatchInput): Promise<AcceptChatBatchResult> {
  const project = input.projectsRepository.getProject(input.projectId);
  const batch = input.batchesRepository.getBatch(input.projectId, input.batchId);
  const files = input.fileIds && input.fileIds.length > 0
    ? input.batchesRepository
        .listBatchFiles(input.projectId, input.batchId)
        .filter((file) => input.fileIds?.includes(file.id))
    : input.batchesRepository.listBatchFiles(input.projectId, input.batchId);
  const processor = input.processPhoto ?? defaultProcessPhoto;

  if (!project) throw new Error('Project not found');
  if (!batch) throw new Error('Chat batch not found');
  if (input.checklistNodeIds.length === 0) throw new Error('At least one checklist node is required');

  let importedPhotos = 0;

  for (const nodeId of input.checklistNodeIds) {
    const node = input.projectsRepository.getChecklistNode(input.projectId, nodeId);
    if (!node) throw new Error(`Checklist node ${nodeId} not found`);
    if (!Boolean(node.acceptsPhotos)) throw new Error(`Checklist node ${nodeId} does not accept photos`);
    if (node.nodeType === 'CABLE_RESERVE' && !input.reserveLocation) {
      throw new Error(`Reserve location is required for checklist node ${nodeId}`);
    }
    const nodeReserveLocation = node.nodeType === 'CABLE_RESERVE' ? input.reserveLocation : null;

    let existingCount = input.projectsRepository.countPhotosForNode(nodeId, nodeReserveLocation);

    for (const file of files) {
      const photoId = randomUUID();
      const sourceBuffer = await readFile(file.sourcePath);
      const processed = await processor(sourceBuffer);
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

  input.batchesRepository.updateDecision({
    projectId: input.projectId,
    batchId: input.batchId,
    status: 'IMPORTED',
    reviewReason: null,
    checklistNodeId: input.checklistNodeIds.length === 1 ? input.checklistNodeIds[0] : null,
    reserveLocation: input.reserveLocation,
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
