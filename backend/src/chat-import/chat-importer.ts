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

async function hashChatFile(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

async function removeDuplicateFiles(manifest: ChatManifest, knownHashes: Set<string>): Promise<ChatManifest> {
  const files: ChatManifest['files'] = [];

  for (const file of manifest.files) {
    const contentHash = file.contentHash ?? (await hashChatFile(join(manifest.folderPath, file.fileName)));
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
    const manifest = await removeDuplicateFiles(rawManifest, knownHashes);
    if (manifest.files.length === 0) continue;

    const existingBatch = input.repository.findBatchForManifest(input.projectId, manifest);
    if (existingBatch) {
      continue;
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
