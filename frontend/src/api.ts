import type {
  ChatAcceptReadyResult,
  ChatBatch,
  ChatBatchStatus,
  ChatClassificationResult,
  ChatClassificationStatus,
  ChatImportResult,
  AppConfig,
  ChecklistNode,
  ChecklistNodeDetail,
  FolderBrowserResult,
  GoogleChatDownloadStatus,
  GoogleChatSpace,
  ProjectSummary,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getConfig: () => request<AppConfig>('/api/config'),
  listFolders: (path?: string) => {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return request<FolderBrowserResult>(`/api/folders${query}`);
  },
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  listGoogleChatSpaces: () => request<GoogleChatSpace[]>('/api/google-chat/spaces'),
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
  getChecklist: (projectId: string) => request<ChecklistNode[]>(`/api/projects/${projectId}/checklist`),
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
  classifyChatBatches: (projectId: string) =>
    request<ChatClassificationStatus>(`/api/projects/${projectId}/chat-batches/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  getChatClassificationStatus: (projectId: string) =>
    request<ChatClassificationStatus>(`/api/projects/${projectId}/chat-batches/classify/status`),
  acceptReadyChatBatches: (projectId: string) =>
    request<ChatAcceptReadyResult>(`/api/projects/${projectId}/chat-batches/accept-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  acceptChatBatch: (
    projectId: string,
    batchId: string,
    checklistNodeIds: string[],
    reserveLocation: 'Doziemny' | 'W studni' | null,
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
    reserveLocation: 'Doziemny' | 'W studni',
  ) =>
    request<{ moved: number }>(`/api/projects/${projectId}/checklist/${nodeId}/photos/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoIds, reserveLocation }),
    }),
  photoThumbUrl: (projectId: string, photoId: string) => `/api/projects/${projectId}/photos/${photoId}/thumb`,
  photoFileUrl: (projectId: string, photoId: string) => `/api/projects/${projectId}/photos/${photoId}/file`,
  chatBatchFileUrl: (projectId: string, batchId: string, fileId: string) =>
    `/api/projects/${projectId}/chat-batches/${batchId}/files/${fileId}/file`,
};
