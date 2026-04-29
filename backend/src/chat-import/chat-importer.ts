import type { ChatBatchesRepository, ChatBatchStatus } from './chat-batches-repository.js';
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
}

const MULTI_ADDRESS_PATTERN = /\b\d+[a-z]?\s*(?:i|oraz)\s*\d+[a-z]?\b/i;
const ADDRESS_LIKE_PATTERN = /\b[\p{L}][\p{L}\s.'-]{2,}\s+(?:d\s*)?\d+[a-z]?(?=$|[^\p{L}\p{N}])/iu;
const CHECKLIST_POINT_PATTERN = /\b(?:osd|opp|zs|d\d{3,5}|x\d{3,5})\b/i;

function hasDescription(manifest: ChatManifest): boolean {
  return manifest.messageText.trim() !== '' && !/^brak_opisu$/i.test(manifest.folderName.trim());
}

function isLikelyMultiAddress(manifest: ChatManifest): boolean {
  return MULTI_ADDRESS_PATTERN.test(manifest.messageText) || MULTI_ADDRESS_PATTERN.test(manifest.folderName);
}

function hasLikelyChecklistTarget(manifest: ChatManifest): boolean {
  const text = `${manifest.messageText} ${manifest.folderName}`;
  return ADDRESS_LIKE_PATTERN.test(text) || CHECKLIST_POINT_PATTERN.test(text);
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

export async function importChatFolders(input: ImportChatFoldersInput): Promise<ImportChatFoldersResult> {
  const manifests = await findChatManifests(input.rootPath);
  const result: ImportChatFoldersResult = {
    imported: 0,
    waitingForClassification: 0,
    pendingReview: 0,
  };

  for (const manifest of manifests) {
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
