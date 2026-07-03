import type {
  AuthSession,
  AuthUser,
  ChatBatch,
  ChatBatchStatus,
  ChatClassificationResult,
  ChatClassificationStatus,
  ChatImportStatus,
  ChatImportResult,
  ChatQueueClearResult,
  AppConfig,
  ChecklistNode,
  ChecklistNodeDetail,
  ChecklistRecalculateResult,
  GoogleChatDownloadStatus,
  GoogleChatInviteAcceptResult,
  GoogleChatInviteListResult,
  GoogleChatInviteSetupResult,
  GoogleChatSpace,
  ProjectMapCable,
  ProjectMapCandidateReserveLocation,
  ProjectMapData,
  ProjectMapInfraNode,
  ProjectMapNote,
  ProjectMapNoteTargetType,
  ProjectSummary,
  ReserveLocation,
  SharedFolderListResult,
  SharedFolderRoot,
} from './types';

const AUTH_TOKEN_KEY = 'photo-local-auth-token';

export function getAuthToken(): string | null {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token: string): void {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    if (response.status === 401) clearAuthToken();
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string') {
        message = parsed.error;
      } else if (typeof parsed.message === 'string') {
        message = parsed.message;
      }
    } catch {
      // Leave the raw response text when the backend did not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function requestBlob(url: string, init?: RequestInit): Promise<Blob> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    if (response.status === 401) clearAuthToken();
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.blob();
}

export const api = {
  hasAuthToken: () => Boolean(getAuthToken()),
  login: async (username: string, password: string) => {
    const session = await request<AuthSession>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    setAuthToken(session.token);
    return session;
  },
  getCurrentUser: async () => {
    const result = await request<{ user: AuthUser }>('/api/auth/me');
    return result.user;
  },
  logout: async () => {
    try {
      await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
    } catch {
      // The local session should be cleared even if the server token is already invalid.
    } finally {
      clearAuthToken();
    }
  },
  getConfig: () => request<AppConfig>('/api/config'),
  listSharedFolderRoots: () => request<{ roots: SharedFolderRoot[] }>('/api/shared-folders/roots'),
  listSharedFolderChildren: (path: string) =>
    request<SharedFolderListResult>('/api/shared-folders/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  createSharedFolder: (parentPath: string, folderName: string) =>
    request<{ path: string }>('/api/shared-folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, folderName }),
    }),
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  listGoogleChatSpaces: () => request<GoogleChatSpace[]>('/api/google-chat/spaces'),
  listGoogleChatInvites: () =>
    request<GoogleChatInviteListResult>('/api/google-chat/invites/list', {
      method: 'POST',
    }),
  openGoogleChatInviteSetup: () =>
    request<GoogleChatInviteSetupResult>('/api/google-chat/invites/setup', {
      method: 'POST',
    }),
  acceptGoogleChatInvite: (inviteKey: string) =>
    request<GoogleChatInviteAcceptResult>('/api/google-chat/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteKey }),
    }),
  startGoogleChatDownload: (projectId: string, spaceName: string, spaceDisplayName: string) =>
    request<GoogleChatDownloadStatus>(`/api/projects/${projectId}/google-chat/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceName, spaceDisplayName }),
    }),
  getGoogleChatDownloadStatus: (projectId: string) =>
    request<GoogleChatDownloadStatus>(`/api/projects/${projectId}/google-chat/download/status`),
  renameProject: (projectId: string, newName: string) =>
    request<ProjectSummary>(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }),
  deleteProject: (projectId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}`, {
      method: 'DELETE',
    }),
  getChecklist: (projectId: string) => request<ChecklistNode[]>(`/api/projects/${projectId}/checklist`),
  getProjectMap: (projectId: string) => request<ProjectMapData>(`/api/projects/${projectId}/map`),
  downloadAddressConstructionReport: (projectId: string) =>
    requestBlob(`/api/projects/${projectId}/reports/address-construction.xlsx`),
  updateMapCableStatus: (projectId: string, cableId: string, status: ProjectMapCable['status']) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/cables/${cableId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  updateMapNodeStatus: (projectId: string, nodeId: string, status: ProjectMapInfraNode['status']) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/nodes/${nodeId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  markMapAddressNotApplicable: (projectId: string, addressId: string, reason: string | null) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/addresses/${addressId}/not-applicable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
  updateMapAddressOplConsent: (projectId: string, addressId: string, confirmed: boolean) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/addresses/${addressId}/opl-consent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed }),
    }),
  reverseGeocodeMapAddressCandidate: (projectId: string, lat: number, lng: number) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/address-candidates/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    }),
  approveMapAddressCandidate: (
    projectId: string,
    candidateId: string,
    input: {
      city: string;
      street: string;
      buildingNo: string | null;
      propertyId: string | null;
      parcelNumber: string | null;
      distributionPoint: string | null;
      reserveLocation: ProjectMapCandidateReserveLocation;
      createDistributionNodeType: 'OSD' | 'OPP' | null;
      oplConsentConfirmed?: boolean;
      noteBody?: string | null;
    },
  ) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/address-candidates/${candidateId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  rejectMapAddressCandidate: (projectId: string, candidateId: string) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/address-candidates/${candidateId}/reject`, {
      method: 'POST',
    }),
  createMapNote: (
    projectId: string,
    input: {
      targetType: ProjectMapNoteTargetType;
      targetId: string | null;
      targetLabel: string | null;
      body: string;
      lat: number | null;
      lng: number | null;
    },
  ) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateMapNote: (
    projectId: string,
    noteId: string,
    input: Pick<ProjectMapNote, 'body' | 'lat' | 'lng'>,
  ) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  deleteMapNote: (projectId: string, noteId: string) =>
    request<ProjectMapData>(`/api/projects/${projectId}/map/notes/${noteId}`, {
      method: 'DELETE',
    }),
  uploadMapNotePhoto: (projectId: string, noteId: string, file: File) => {
    const formData = new FormData();
    formData.append('photo', file);
    return request<{ id: string; storedFileName: string; storagePath: string; thumbnailPath: string | null }>(
      `/api/projects/${projectId}/map/notes/${noteId}/photos`,
      {
        method: 'POST',
        body: formData,
      },
    );
  },
  createChecklistNode: (
    projectId: string,
    input: {
      name: string;
      parentId: string | null;
      nodeType: ChecklistNode['nodeType'];
      minPhotos: number;
      acceptsPhotos: boolean;
    },
  ) =>
    request<ChecklistNode>(`/api/projects/${projectId}/checklist/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  recalculateChecklist: (
    projectId: string,
    gpkgFile: File,
    projectType: string,
    splitterTopology: string,
  ) => {
    const formData = new FormData();
    formData.append('projectType', projectType);
    formData.append('splitterTopology', splitterTopology);
    formData.append('gpkg', gpkgFile);
    return request<ChecklistRecalculateResult>(`/api/projects/${projectId}/checklist/recalculate`, {
      method: 'POST',
      body: formData,
    });
  },
  getChecklistNode: (projectId: string, nodeId: string) =>
    request<ChecklistNodeDetail>(`/api/projects/${projectId}/checklist/${nodeId}`),
  listChatBatches: (projectId: string, status?: ChatBatchStatus) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<ChatBatch[]>(`/api/projects/${projectId}/chat-batches${query}`);
  },
  importChatFolders: (projectId: string, rootPath: string) =>
    request<ChatImportResult>(`/api/projects/${projectId}/chat-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootPath }),
    }),
  getChatImportStatus: (projectId: string) =>
    request<ChatImportStatus>(`/api/projects/${projectId}/chat-import/status`),
  clearChatQueues: (projectId: string) =>
    request<ChatQueueClearResult>(`/api/projects/${projectId}/chat-batches/clear-working`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  classifyChatBatches: (projectId: string) =>
    request<ChatClassificationStatus>(`/api/projects/${projectId}/chat-batches/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  getChatClassificationStatus: (projectId: string) =>
    request<ChatClassificationStatus>(`/api/projects/${projectId}/chat-batches/classify/status`),
  acceptChatBatch: (
    projectId: string,
    batchId: string,
    checklistNodeIds: string[],
    reserveLocation: ReserveLocation | null,
    fileIds: string[],
  ) =>
    request<{ importedPhotos: number; checklistNodeCount: number; sourceFileCount: number }>(
      `/api/projects/${projectId}/chat-batches/${batchId}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checklistNodeIds, reserveLocation, fileIds }),
      },
    ),
  rejectChatBatch: (projectId: string, batchId: string, reason: string) =>
    request<ChatBatch>(`/api/projects/${projectId}/chat-batches/${batchId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
  markNotApplicable: (projectId: string, nodeId: string, reason: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/checklist/${nodeId}/not-applicable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
  reopenNode: (projectId: string, nodeId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/checklist/${nodeId}/reopen`, {
      method: 'POST',
    }),
  createProject: (gpkgFile: File, projectType: string, splitterTopology: string, photoRootPath: string) => {
    const formData = new FormData();
    formData.append('projectType', projectType);
    formData.append('splitterTopology', splitterTopology);
    formData.append('photoRootPath', photoRootPath);
    formData.append('gpkg', gpkgFile);
    return request<any>('/api/projects', {
      method: 'POST',
      body: formData,
    });
  },
  uploadPhoto: (projectId: string, nodeId: string, file: File, reserveLocation: string | null) => {
    const formData = new FormData();
    if (reserveLocation) formData.append('reserveLocation', reserveLocation);
    formData.append('photo', file);
    return request<{ storedFileName: string }>(`/api/projects/${projectId}/checklist/${nodeId}/photos`, {
      method: 'POST',
      body: formData,
    });
  },
  reclassifyPhotos: (
    projectId: string,
    nodeId: string,
    photoIds: string[],
    reserveLocation: ReserveLocation,
  ) =>
    request<{ moved: number }>(`/api/projects/${projectId}/checklist/${nodeId}/photos/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoIds, reserveLocation }),
    }),
  changeReserveFolderLocation: (projectId: string, nodeId: string, reserveLocation: ReserveLocation) =>
    request<{
      moved: number;
      reserveLocation: ReserveLocation;
      sourceNodeId: string;
      targetNodeId: string;
    }>(`/api/projects/${projectId}/checklist/${nodeId}/reserve-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reserveLocation }),
    }),
  deletePhotos: (projectId: string, nodeId: string, photoIds: string[]) =>
    request<{ deleted: number }>(`/api/projects/${projectId}/checklist/${nodeId}/photos`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoIds }),
    }),
  movePhotos: (
    projectId: string,
    nodeId: string,
    photoIds: string[],
    targetNodeId: string,
    reserveLocation: ReserveLocation | null,
  ) =>
    request<{ moved: number }>(`/api/projects/${projectId}/checklist/${nodeId}/photos/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoIds, targetNodeId, reserveLocation }),
    }),
  photoThumbUrl: (projectId: string, photoId: string) => `/api/projects/${projectId}/photos/${photoId}/thumb`,
  photoFileUrl: (projectId: string, photoId: string) => `/api/projects/${projectId}/photos/${photoId}/file`,
  chatBatchFileUrl: (projectId: string, batchId: string, fileId: string) =>
    `/api/projects/${projectId}/chat-batches/${batchId}/files/${fileId}/file`,
};
