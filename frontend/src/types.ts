export type ProjectType = 'SI' | 'KPO';
export type SplitterTopology = 'SINGLE' | 'CASCADE';

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

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
  googleChatSpaceName: string | null;
  googleChatSpaceDisplayName: string | null;
  googleChatLastDownloadAt: string | null;
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
  source?: 'GPKG' | 'MANUAL' | 'SYSTEM';
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
  source?: 'GPKG' | 'MANUAL' | 'SYSTEM';
  addressId: string | null;
  sortOrder: number;
  minPhotos: number;
  acceptsPhotos: boolean;
  status: 'OPEN' | 'COMPLETE' | 'NOT_APPLICABLE';
  notApplicableReason: string | null;
  photos: ChecklistPhoto[];
}

export type ProjectMapCableStatus = 'PENDING' | 'DUCT_READY' | 'PULLED' | 'WELDED' | 'SUSPENDED';
export type ProjectMapNodeStatus = 'PENDING' | 'WELDED';
export type ProjectMapCableRoutingType = 'underground' | 'aerial' | 'existing_duct';
export type ProjectMapInfrastructureFeatureType = 'duct' | 'pole' | 'manhole';
export type ProjectMapNoteTargetType = 'cable' | 'node' | 'address' | 'polygon' | 'free';
export type ProjectMapAddressStatus = 'PENDING' | 'COMPLETE' | 'NOT_APPLICABLE';
export type ProjectMapAddressCandidateStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ProjectMapAddressCandidateAssignmentSource = 'NONE' | 'REGION';
export type ProjectMapCandidateReserveLocation = 'Doziemny' | 'Napowietrzny';

export interface ProjectMapPhoto {
  id: string;
  checklistNodeId: string;
  storedFileName: string;
  reserveLocation: string | null;
  uploadedAt: string;
}

export interface ProjectMapAddress {
  id: string;
  label: string;
  city: string;
  street: string;
  buildingNo: string | null;
  distributionPoint: string | null;
  lat: number;
  lng: number;
  reservePhotoCount: number;
  hasReservePhoto: boolean;
  status: ProjectMapAddressStatus;
  isNotApplicable: boolean;
  photos: ProjectMapPhoto[];
}

export interface ProjectMapAddressCandidate {
  id: string;
  label: string;
  status: ProjectMapAddressCandidateStatus;
  city: string;
  street: string;
  buildingNo: string | null;
  postalCode: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  lat: number;
  lng: number;
  geocoderSource: string;
  geocoderDistanceMeters: number | null;
  suggestedDistributionPoint: string | null;
  assignmentSource: ProjectMapAddressCandidateAssignmentSource;
  approvedAddressId: string | null;
  reserveLocation: ProjectMapCandidateReserveLocation | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMapPolygon {
  id: string;
  osdName: string;
  label: string | null;
  geojson: GeoJSON.Feature | GeoJSON.Geometry | Record<string, unknown>;
  households: number | null;
  paCount: number | null;
  cableRef: string | null;
  addressTotal: number;
  addressWithReservePhoto: number;
}

export interface ProjectMapCable {
  id: string;
  cableType: string;
  fromNode: string;
  toNode: string;
  osdName: string;
  geojson: GeoJSON.LineString | GeoJSON.MultiLineString | Record<string, unknown>;
  rawName: string | null;
  routingType: ProjectMapCableRoutingType;
  status: ProjectMapCableStatus;
  routeLengthMeters: number | null;
  installationLengthMeters: number | null;
}

export interface ProjectMapInfraNode {
  id: string;
  nodeType: 'OSD' | 'OPP' | 'ZS';
  name: string;
  label: string | null;
  lat: number;
  lng: number;
  status: ProjectMapNodeStatus;
  hasPhoto: boolean;
  photos: ProjectMapPhoto[];
}

export interface ProjectMapInfrastructureFeature {
  id: string;
  featureType: ProjectMapInfrastructureFeatureType;
  sourceLayer: string;
  label: string | null;
  elementType: string | null;
  owner: string | null;
  geojson: GeoJSON.LineString | GeoJSON.MultiLineString | GeoJSON.Point | GeoJSON.MultiPoint | Record<string, unknown>;
}

export interface ProjectMapNotePhoto {
  id: string;
  noteId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number | null;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  uploadedAt: string;
}

export interface ProjectMapNote {
  id: string;
  targetType: ProjectMapNoteTargetType;
  targetId: string | null;
  targetLabel: string | null;
  body: string;
  lat: number | null;
  lng: number | null;
  photoCount: number;
  photos: ProjectMapNotePhoto[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMapData {
  addresses: ProjectMapAddress[];
  addressCandidates: ProjectMapAddressCandidate[];
  polygons: ProjectMapPolygon[];
  trunkCables: ProjectMapCable[];
  infraNodes: ProjectMapInfraNode[];
  infrastructureFeatures: ProjectMapInfrastructureFeature[];
  notes: ProjectMapNote[];
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
  contentHash: string | null;
  photoId: string | null;
  createdAt: string;
}

export interface ChatSourceMessage {
  messageName: string;
  messageText: string;
  createTime: string;
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
  sourceMessages: ChatSourceMessage[];
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
  cleared: number;
}

export interface ChatImportStatus extends ChatImportResult {
  state: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  projectId: string | null;
  rootPath: string | null;
  phase: 'scanning' | 'checking' | 'done' | null;
  processedManifests: number;
  totalManifests: number;
  processedFiles: number;
  totalFiles: number;
  skippedFiles: number;
  currentFolderName: string | null;
  currentFileName: string | null;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ChatQueueClearResult {
  cleared: number;
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
  downloadedFiles?: number;
  skippedFiles?: number;
  totalFiles?: number;
  filesToDownload?: number;
  failedFiles?: number;
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

export interface GoogleChatInviteBrowserLaunchInfo {
  executablePath: string | null;
  executableName: string | null;
  debugPort: number;
  profileDir: string;
  url: string;
  command: string | null;
}

export interface GoogleChatInviteListResult {
  invites: GoogleChatInvite[];
  url: string;
  profileDir: string;
  session: GoogleChatInviteSessionStatus;
  launch?: GoogleChatInviteBrowserLaunchInfo;
}

export interface GoogleChatInviteAcceptResult {
  accepted: boolean;
  invite: GoogleChatInvite | null;
}

export interface GoogleChatInviteSetupResult {
  started: boolean;
  url: string;
  profileDir: string;
  session: GoogleChatInviteSessionStatus;
  launch: GoogleChatInviteBrowserLaunchInfo;
  error: string | null;
  diagnostics: string[];
}
