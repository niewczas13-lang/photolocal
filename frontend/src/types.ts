export type ProjectType = 'SI' | 'KPO';
export type SplitterTopology = 'SINGLE' | 'CASCADE';

export interface ProjectSummary {
  id: string;
  name: string;
  projectDefinition: string | null;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  splitterTopologySource: 'AUTO' | 'MANUAL';
  splitterCount: number;
  gpkgFileName: string;
  baseFolder: string;
  addressCount: number;
  dacToAddressCableCount: number;
  adssToAddressCableCount: number;
  progressDone: number;
  progressTotal: number;
  status: 'W trakcie' | 'Kompletne';
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistRecalculateResult {
  addedNodes: number;
  updatedNodes: number;
  unchangedNodes: number;
  addedAddresses: number;
  reusedAddresses: number;
  removedStaleNodes: number;
  preservedAssignedStaleNodes: number;
  project: ProjectSummary;
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
  reserveLocation: ReserveLocation | null;
}

export type ReserveLocation = 'Doziemny' | 'W studni' | 'Napowietrzny';

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
  reserveLocation: ReserveLocation | null;
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
  currentStartedAt?: string | null;
  currentStep?: string | null;
  currentElapsedMs?: number | null;
  readyForImport?: number;
  pendingReview?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  recentDecisions?: ChatClassificationDebugEvent[];
  diagnostics?: OllamaDiagnostics | null;
}

export interface OllamaDiagnostics {
  checkedAt: string;
  ollamaUrl: string;
  model: string;
  ollamaReachable: boolean;
  modelLoaded: boolean;
  processor: string | null;
  size: string | null;
  sizeVram: string | null;
  expiresAt: string | null;
  gpu: NvidiaSmiSnapshot | null;
  error: string | null;
}

export interface NvidiaSmiSnapshot {
  name: string;
  utilizationGpuPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  temperatureC: number | null;
}

export interface ChatClassificationDebugEvent {
  folderName: string;
  messageText: string;
  model: string;
  reserveLocation: ReserveLocation | 'Inne' | 'Niepewne';
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
  googleChatInviteProfileDir: string;
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

export interface SharedFolderRoot {
  path: string;
  label: string;
  providerName: string | null;
}

export interface SharedFolderEntry {
  name: string;
  path: string;
}

export interface SharedFolderListResult {
  currentPath: string;
  parentPath: string | null;
  entries: SharedFolderEntry[];
}

export interface GoogleChatInvite {
  key: string;
  roomName: string | null;
  senderEmail: string | null;
  textPreview: string;
}

export interface GoogleChatInviteSessionStatus {
  state: 'ACTIVE' | 'NEEDS_LOGIN' | 'UNKNOWN';
  message: string;
  url: string | null;
  title: string | null;
  checkedAt: string;
}

export interface GoogleChatInviteListResult {
  invites: GoogleChatInvite[];
  url: string;
  profileDir: string;
  session: GoogleChatInviteSessionStatus;
}

export interface GoogleChatInviteAcceptResult {
  accepted: boolean;
  invite: GoogleChatInvite | null;
}

export interface GoogleChatInviteSetupResult {
  started: true;
  url: string;
  profileDir: string;
  session: GoogleChatInviteSessionStatus;
}
