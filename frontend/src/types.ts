export type ProjectType = 'SI' | 'KPO';
export type SplitterTopology = 'SINGLE' | 'CASCADE';

export interface ProjectSummary {
  id: string;
  name: string;
  projectDefinition: string | null;
  progressDone: number;
  progressTotal: number;
  status: 'W trakcie' | 'Kompletne';
  updatedAt: string;
}

export interface ChecklistNode {
  id: string;
  name: string;
  path: string;
  nodeType: 'STATIC' | 'DISTRIBUTION' | 'ADDRESS' | 'CABLE_RESERVE';
  acceptsPhotos: boolean;
  minPhotos: number;
  photoCount: number;
  status: 'OPEN' | 'COMPLETE' | 'NOT_APPLICABLE';
  children: ChecklistNode[];
}

export interface ChecklistPhoto {
  id: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  uploadedAt: string;
  reserveLocation: 'Doziemny' | 'W studni' | null;
}

export interface ChecklistNodeDetail {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  path: string;
  nodeType: 'STATIC' | 'DISTRIBUTION' | 'ADDRESS' | 'CABLE_RESERVE';
  addressId: string | null;
  sortOrder: number;
  minPhotos: number;
  acceptsPhotos: boolean;
  status: 'OPEN' | 'COMPLETE' | 'NOT_APPLICABLE';
  notApplicableReason: string | null;
  photos: ChecklistPhoto[];
}

export type ChatBatchStatus =
  | 'WAITING_FOR_CLASSIFICATION'
  | 'PENDING_REVIEW'
  | 'READY_FOR_IMPORT'
  | 'IMPORTED'
  | 'REJECTED';

export interface ChatBatchFile {
  id: string;
  batchId: string;
  fileName: string;
  contentName: string;
  contentType: string;
  sourcePath: string;
  photoId: string | null;
  createdAt: string;
}

export interface ChatBatch {
  id: string;
  projectId: string;
  source: 'google-chat';
  sourceSpaceName: string;
  sourceSpaceDisplayName: string;
  sourceMessageName: string;
  messageText: string;
  sourceCreateTime: string;
  folderName: string;
  folderPath: string;
  status: ChatBatchStatus;
  reviewReason: string | null;
  checklistNodeId: string | null;
  reserveLocation: 'Doziemny' | 'W studni' | null;
  confidence: number | null;
  llmModel: string | null;
  llmRawResponse: string | null;
  visualEvidence: string[];
  fileCount: number;
  files: ChatBatchFile[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatImportResult {
  imported: number;
  waitingForClassification: number;
  pendingReview: number;
}

export interface ChatClassificationResult {
  processed: number;
  readyForImport: number;
  pendingReview: number;
}

export interface ChatAcceptReadyResult {
  importedBatches: number;
  importedPhotos: number;
  skippedBatches: number;
}

export interface ChatClassificationStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  processed: number;
  total: number;
  currentBatchId?: string | null;
  currentFolderName?: string | null;
  readyForImport?: number;
  pendingReview?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentDecisions?: ChatClassificationDebugEvent[];
}

export interface ChatClassificationDebugEvent {
  folderName: string;
  messageText: string;
  model: string;
  reserveLocation: 'Doziemny' | 'W studni' | 'Inne' | 'Niepewne';
  confidence: number;
  shouldReview: boolean;
  reviewReason: string | null;
  matchedChecklistNodeId: string | null;
  matchedChecklistNodeName: string | null;
  status: ChatBatchStatus;
  rawResponsePreview?: string;
  visualEvidence: string[];
}

export interface GoogleChatSpace {
  name: string;
  displayName: string;
  spaceType: string;
}

export interface AppConfig {
  googleChatDownloadRoot: string;
}

export interface NativeFolderPickResult {
  path: string | null;
}

export interface GoogleChatDownloadStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  projectId: string | null;
  spaceName: string | null;
  spaceDisplayName: string | null;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentLines: string[];
}
