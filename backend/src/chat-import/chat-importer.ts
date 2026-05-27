import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatBatchesRepository, ChatBatchStatus } from './chat-batches-repository.js';
import { extractMatcherFeatures } from './checklist-matcher.js';
import { findChatManifests, type ChatManifest } from './chat-manifest.js';

export interface ImportChatFoldersInput {
  projectId: string;
  rootPath: string;
  repository: ChatBatchesRepository;
}

export interface ImportChatFoldersResult {
  imported: number;
  waitingForClassification: number;
  pendingReview: number;
  cleared: number;
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

function removeDuplicateFiles(manifest: ChatManifest, knownHashes: Set<string>): ChatManifest {
  const files: ChatManifest['files'] = [];

  for (const file of manifest.files) {
    const contentHash = file.contentHash;
    if (!contentHash) {
      files.push(file);
      continue;
    }
    if (knownHashes.has(contentHash)) continue;

    knownHashes.add(contentHash);
    files.push({ ...file, contentHash });
  }

  return files.length === manifest.files.length ? manifest : { ...manifest, files };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fillMissingContentHashes(manifest: ChatManifest): Promise<ChatManifest> {
  let changed = false;
  const files = await Promise.all(
    manifest.files.map(async (file) => {
      if (file.contentHash) return file;

      try {
        const sourceBuffer = await readFile(join(manifest.folderPath, file.fileName));
        changed = true;
        return { ...file, contentHash: sha256(sourceBuffer) };
      } catch {
        return file;
      }
    }),
  );

  return changed ? { ...manifest, files } : manifest;
}

export async function importChatFolders(input: ImportChatFoldersInput): Promise<ImportChatFoldersResult> {
  const manifests = await findChatManifests(input.rootPath);
  const result: ImportChatFoldersResult = {
    imported: 0,
    waitingForClassification: 0,
    pendingReview: 0,
    cleared: input.repository.clearWorkingBatches(input.projectId),
  };
  const knownHashes = new Set(input.repository.listAssignedProjectPhotoContentHashes(input.projectId));

  for (const rawManifest of manifests) {
    const hashedManifest = await fillMissingContentHashes(rawManifest);
    const manifest = removeDuplicateFiles(hashedManifest, knownHashes);
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

  return result;
}
