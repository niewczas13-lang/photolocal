import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatBatchesRepository, ChatBatchStatus } from './chat-batches-repository.js';
import { extractMatcherFeatures } from './checklist-matcher.js';
import { findChatManifests, type ChatManifest } from './chat-manifest.js';
import { processPhoto } from '../photos/photo-processor.js';

export interface ImportChatFoldersInput {
  projectId: string;
  rootPath: string;
  repository: ChatBatchesRepository;
  onProgress?: (event: ChatImportProgressEvent) => void;
}

export interface ImportChatFoldersResult {
  imported: number;
  waitingForClassification: number;
  pendingReview: number;
  cleared: number;
}

export type ChatImportProgressPhase = 'scanning' | 'checking' | 'done';

export interface ChatImportProgressEvent extends ImportChatFoldersResult {
  projectId: string;
  rootPath: string;
  phase: ChatImportProgressPhase;
  processedManifests: number;
  totalManifests: number;
  processedFiles: number;
  totalFiles: number;
  skippedFiles: number;
  currentFolderName: string | null;
  currentFileName: string | null;
  updatedAt: string;
}

const MULTI_ADDRESS_PATTERN = /\b\d+[a-z]?\s*(?:i|oraz)\s*\d+[a-z]?\b/i;
const MAX_ADDRESS_RESIDUAL_TOKENS = 1;

function hasDescription(manifest: ChatManifest): boolean {
  return manifest.messageText.trim() !== '' && !/^brak_opisu$/i.test(manifest.folderName.trim());
}

function isLikelyMultiAddress(manifest: ChatManifest): boolean {
  return MULTI_ADDRESS_PATTERN.test(manifest.messageText) || MULTI_ADDRESS_PATTERN.test(manifest.folderName);
}

function hasLikelyChecklistTarget(manifest: ChatManifest): boolean {
  const features = extractMatcherFeatures(`${manifest.messageText} ${manifest.folderName}`);
  if (features.pointIds.length > 0) {
    return true;
  }

  return features.addresses.length > 0 && features.residualTokens.length <= MAX_ADDRESS_RESIDUAL_TOKENS;
}

function decideInitialStatus(manifest: ChatManifest): { status: ChatBatchStatus; reviewReason: string | null } {
  if (!hasDescription(manifest)) {
    return { status: 'PENDING_REVIEW', reviewReason: 'Brak opisu wiadomosci' };
  }

  if (isLikelyMultiAddress(manifest)) {
    return { status: 'PENDING_REVIEW', reviewReason: 'Wiadomosc wyglada na wiele adresow' };
  }

  if (!hasLikelyChecklistTarget(manifest)) {
    return { status: 'PENDING_REVIEW', reviewReason: 'Opis nie wyglada na adres ani punkt checklisty' };
  }

  return { status: 'WAITING_FOR_CLASSIFICATION', reviewReason: null };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function filterDuplicateFiles(
  manifest: ChatManifest,
  knownHashes: Set<string>,
  onFileChecked?: (file: ChatManifest['files'][number], skipped: boolean) => void,
): Promise<ChatManifest> {
  const files: ChatManifest['files'] = [];

  for (const file of manifest.files) {
    let sourceBuffer: Buffer | null = null;
    let contentHash = file.contentHash ?? null;

    if (!contentHash) {
      try {
        sourceBuffer = await readFile(join(manifest.folderPath, file.fileName));
        contentHash = sha256(sourceBuffer);
      } catch {
        files.push(file);
        onFileChecked?.(file, false);
        continue;
      }
    }

    if (knownHashes.has(contentHash)) {
      onFileChecked?.(file, true);
      continue;
    }

    if (!sourceBuffer) {
      try {
        sourceBuffer = await readFile(join(manifest.folderPath, file.fileName));
      } catch {
        knownHashes.add(contentHash);
        files.push({ ...file, contentHash });
        onFileChecked?.(file, false);
        continue;
      }
    }

    try {
      const processed = await processPhoto(sourceBuffer);
      const processedHash = sha256(processed.buffer);
      if (knownHashes.has(processedHash)) {
        onFileChecked?.(file, true);
        continue;
      }

      knownHashes.add(processedHash);
    } catch {
      // Keep the raw hash path for files that cannot be normalized by sharp.
    }

    knownHashes.add(contentHash);
    files.push({ ...file, contentHash });
    onFileChecked?.(file, false);
  }

  return files.length === manifest.files.length ? manifest : { ...manifest, files };
}

export async function importChatFolders(input: ImportChatFoldersInput): Promise<ImportChatFoldersResult> {
  const manifests = await findChatManifests(input.rootPath);
  const totalFiles = manifests.reduce((sum, manifest) => sum + manifest.files.length, 0);
  let processedFiles = 0;
  let skippedFiles = 0;
  let processedManifests = 0;
  const result: ImportChatFoldersResult = {
    imported: 0,
    waitingForClassification: 0,
    pendingReview: 0,
    cleared: input.repository.clearWorkingBatches(input.projectId),
  };
  const knownHashes = new Set(input.repository.listAssignedProjectPhotoContentHashes(input.projectId));
  const emitProgress = (
    phase: ChatImportProgressPhase,
    current: { folderName?: string | null; fileName?: string | null } = {},
  ) => {
    input.onProgress?.({
      ...result,
      projectId: input.projectId,
      rootPath: input.rootPath,
      phase,
      processedManifests,
      totalManifests: manifests.length,
      processedFiles,
      totalFiles,
      skippedFiles,
      currentFolderName: current.folderName ?? null,
      currentFileName: current.fileName ?? null,
      updatedAt: new Date().toISOString(),
    });
  };

  emitProgress('scanning');

  for (const rawManifest of manifests) {
    const manifest = await filterDuplicateFiles(rawManifest, knownHashes, (file, skipped) => {
      processedFiles += 1;
      if (skipped) skippedFiles += 1;
      emitProgress('checking', {
        folderName: rawManifest.folderName,
        fileName: file.fileName,
      });
    });
    processedManifests += 1;
    if (manifest.files.length === 0) continue;

    const existingBatch = input.repository.findBatchForManifest(input.projectId, manifest);
    if (existingBatch) {
      const canRefreshImportedBatch =
        existingBatch.status === 'IMPORTED' &&
        input.repository.listBatchFiles(input.projectId, existingBatch.id).length === 0;
      if (!canRefreshImportedBatch) {
        continue;
      }
    }

    const decision = decideInitialStatus(manifest);

    input.repository.importManifest({
      projectId: input.projectId,
      manifest,
      status: decision.status,
      reviewReason: decision.reviewReason,
    });

    result.imported += 1;
    if (decision.status === 'WAITING_FOR_CLASSIFICATION') {
      result.waitingForClassification += 1;
    }
    if (decision.status === 'PENDING_REVIEW') {
      result.pendingReview += 1;
    }
  }

  emitProgress('done');

  return result;
}
