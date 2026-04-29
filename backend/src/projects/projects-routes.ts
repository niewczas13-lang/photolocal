import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { ProjectsRepository } from './projects-repository.js';
import { resolveProjectPhotoFolder } from './project-photo-path.js';
import { acceptChatBatch } from '../chat-import/chat-batch-acceptance.js';
import { acceptReadyChatBatches } from '../chat-import/chat-auto-import.js';
import { classifyWaitingChatBatches } from '../chat-import/chat-classification-runner.js';
import {
  completeChatClassification,
  failChatClassification,
  getChatClassificationStatus,
  startChatClassification,
  updateChatClassificationProgress,
} from '../chat-import/chat-classification-status.js';
import { ChatBatchesRepository, type ChatBatchStatus } from '../chat-import/chat-batches-repository.js';
import { importChatFolders } from '../chat-import/chat-importer.js';
import { extractGpkg } from '../gpkg/gpkg-extractor.js';
import {
  getGoogleChatDownloadStatus,
  listGoogleChatSpaces,
  startGoogleChatDownload,
} from '../google-chat/google-chat-downloader.js';
import { generateChecklistNodes } from '../checklist/checklist-generator.js';
import { loadConfig } from '../config.js';
import type { ProjectType, SplitterTopology } from '../types.js';
import { processPhoto, resolvePhotoTarget, type ReserveLocation } from '../photos/photo-processor.js';

function toTree(rows: any[]) {
  const map = new Map<string, any>();
  const roots: any[] = [];

  for (const row of rows) {
    map.set(row.id, {
      ...row,
      acceptsPhotos: Boolean(row.acceptsPhotos),
      children: [],
    });
  }

  for (const row of rows) {
    const node = map.get(row.id);
    if (row.parentId && map.has(row.parentId)) {
      map.get(row.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function registerProjectRoutes(app: FastifyInstance, db: Database.Database): Promise<void> {
  const repository = new ProjectsRepository(db);
  const chatBatchesRepository = new ChatBatchesRepository(db);
  let isClosing = false;
  app.addHook('onClose', async () => {
    isClosing = true;
  });
  const googleChatConfig = () => {
    const config = loadConfig();
    return {
      pythonCommand: config.googleChatPythonCommand,
      scriptPath: config.googleChatScriptPath,
    };
  };

  app.get('/api/projects', async () => repository.listProjects());

  app.get('/api/projects/:projectId/chat-batches', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { status } = request.query as { status?: ChatBatchStatus };
    const validStatus =
      status === 'WAITING_FOR_CLASSIFICATION' ||
      status === 'PENDING_REVIEW' ||
      status === 'READY_FOR_IMPORT' ||
      status === 'IMPORTED' ||
      status === 'REJECTED'
        ? status
        : undefined;

    return chatBatchesRepository.listBatches(projectId, validStatus).map((batch) => ({
      ...batch,
      files: chatBatchesRepository.listBatchFiles(projectId, batch.id),
    }));
  });

  app.get('/api/google-chat/spaces', async () => listGoogleChatSpaces(googleChatConfig()));

  app.get('/api/projects/:projectId/google-chat/download/status', async () =>
    getGoogleChatDownloadStatus(),
  );

  app.post('/api/projects/:projectId/google-chat/download', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { spaceName?: string; spaceDisplayName?: string };
    const project = repository.getProject(projectId);

    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!body.spaceName?.trim()) return reply.status(400).send({ error: 'spaceName is required' });

    try {
      return reply.status(202).send(
        startGoogleChatDownload({
          projectId,
          spaceName: body.spaceName.trim(),
          spaceDisplayName: body.spaceDisplayName?.trim() || body.spaceName.trim(),
          config: googleChatConfig(),
        }),
      );
    } catch (error) {
      return reply.status(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/projects/:projectId/chat-import', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { rootPath?: string };
    const project = repository.getProject(projectId);

    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!body.rootPath || body.rootPath.trim() === '') {
      return reply.status(400).send({ error: 'rootPath is required' });
    }
    try {
      if (!statSync(body.rootPath.trim()).isDirectory()) {
        return reply.status(400).send({ error: 'Google Chat import folder does not exist' });
      }
    } catch {
      return reply.status(400).send({ error: 'Google Chat import folder does not exist' });
    }

    return importChatFolders({
      projectId,
      rootPath: body.rootPath.trim(),
      repository: chatBatchesRepository,
    });
  });

  app.post('/api/projects/:projectId/chat-batches/classify', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = repository.getProject(projectId);
    const status = getChatClassificationStatus(projectId);

    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (status.state === 'RUNNING') {
      return reply.status(409).send({ error: 'Chat classification is already running' });
    }

    startChatClassification(projectId);
    setImmediate(() => {
      if (isClosing) return;

      void classifyWaitingChatBatches({
        projectId,
        projectsRepository: repository,
        batchesRepository: chatBatchesRepository,
        onProgress: updateChatClassificationProgress,
      })
      .then((result) => {
        completeChatClassification(projectId, result);
      })
      .catch((error: unknown) => {
        failChatClassification(projectId, error);
        app.log.error(error);
      });
    });

    return reply.status(202).send(getChatClassificationStatus(projectId));
  });

  app.get('/api/projects/:projectId/chat-batches/classify/status', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return getChatClassificationStatus(projectId);
  });

  app.post('/api/projects/:projectId/chat-batches/accept-ready', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = repository.getProject(projectId);

    if (!project) return reply.status(404).send({ error: 'Project not found' });

    return acceptReadyChatBatches({
      projectId,
      projectsRepository: repository,
      batchesRepository: chatBatchesRepository,
    });
  });

  app.get('/api/projects/:projectId/chat-batches/:batchId/files/:fileId/file', async (request, reply) => {
    const { projectId, batchId, fileId } = request.params as {
      projectId: string;
      batchId: string;
      fileId: string;
    };
    const file = chatBatchesRepository
      .listBatchFiles(projectId, batchId)
      .find((candidate) => candidate.id === fileId);

    if (!file) return reply.status(404).send({ error: 'Chat batch file not found' });

    const buffer = await readFile(file.sourcePath);
    reply.header('Content-Type', file.contentType || 'application/octet-stream');
    return reply.send(buffer);
  });

  app.post('/api/projects/:projectId/chat-batches/:batchId/accept', async (request, reply) => {
    const { projectId, batchId } = request.params as { projectId: string; batchId: string };
    const body = request.body as {
      checklistNodeIds?: string[];
      fileIds?: string[];
      reserveLocation?: ReserveLocation | null;
    };
    const checklistNodeIds = Array.isArray(body.checklistNodeIds) ? body.checklistNodeIds.filter(Boolean) : [];
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter(Boolean) : undefined;
    const reserveLocation =
      body.reserveLocation === 'Doziemny' || body.reserveLocation === 'W studni'
        ? body.reserveLocation
        : null;

    if (checklistNodeIds.length === 0) {
      return reply.status(400).send({ error: 'checklistNodeIds are required' });
    }

    const selectedNodes = checklistNodeIds.map((nodeId) => repository.getChecklistNode(projectId, nodeId));
    if (selectedNodes.some((node) => !node)) {
      return reply.status(404).send({ error: 'Some checklist nodes were not found' });
    }
    const requiresReserveLocation = selectedNodes.some((node) => node?.nodeType === 'CABLE_RESERVE');
    if (requiresReserveLocation && !reserveLocation) {
      return reply.status(400).send({ error: 'reserveLocation is required for cable reserve nodes' });
    }

    const config = loadConfig();
    const result = await acceptChatBatch({
      projectId,
      batchId,
      checklistNodeIds,
      fileIds,
      reserveLocation,
      projectsRepository: repository,
      batchesRepository: chatBatchesRepository,
    });

    return result;
  });

  app.post('/api/projects/:projectId/chat-batches/:batchId/reject', async (request, reply) => {
    const { projectId, batchId } = request.params as { projectId: string; batchId: string };
    const body = request.body as { reason?: string };
    const batch = chatBatchesRepository.getBatch(projectId, batchId);

    if (!batch) return reply.status(404).send({ error: 'Chat batch not found' });

    return chatBatchesRepository.updateDecision({
      projectId,
      batchId,
      status: 'REJECTED',
      reviewReason: body.reason?.trim() || 'Odrzucone recznie',
      checklistNodeId: batch.checklistNodeId,
      reserveLocation: batch.reserveLocation,
      confidence: batch.confidence,
      llmModel: batch.llmModel,
      llmRawResponse: batch.llmRawResponse,
      visualEvidence: batch.visualEvidence,
    });
  });

  app.get('/api/projects/:projectId/checklist', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return toTree(repository.getChecklist(projectId));
  });

  app.get('/api/projects/:projectId/checklist/:nodeId', async (request, reply) => {
    const { projectId, nodeId } = request.params as { projectId: string; nodeId: string };
    const node = repository.getChecklistNode(projectId, nodeId);
    if (!node) return reply.status(404).send({ error: 'Checklist node not found' });

    return {
      ...node,
      acceptsPhotos: Boolean(node.acceptsPhotos),
      photos: repository.getNodePhotos(projectId, nodeId),
    };
  });

  app.get('/api/projects/:projectId/photos/:photoId/thumb', async (request, reply) => {
    const { projectId, photoId } = request.params as { projectId: string; photoId: string };
    const photo = repository.getPhoto(projectId, photoId);
    if (!photo?.thumbnailPath) return reply.status(404).send({ error: 'Photo thumbnail not found' });

    const buffer = await readFile(photo.thumbnailPath);
    reply.header('Content-Type', 'image/webp');
    return reply.send(buffer);
  });

  app.get('/api/projects/:projectId/photos/:photoId/file', async (request, reply) => {
    const { projectId, photoId } = request.params as { projectId: string; photoId: string };
    const photo = repository.getPhoto(projectId, photoId);
    if (!photo) return reply.status(404).send({ error: 'Photo not found' });

    const buffer = await readFile(photo.storagePath);
    reply.header('Content-Type', photo.mimeType);
    return reply.send(buffer);
  });

  app.patch('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { name?: string };
    const project = repository.getProject(projectId);

    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!body.name || body.name.trim() === '') {
      return reply.status(400).send({ error: 'Project name is required' });
    }

    repository.renameProject(projectId, body.name.trim());
    return repository.getProject(projectId);
  });

  app.post('/api/projects/:projectId/checklist/:nodeId/not-applicable', async (request) => {
    const { projectId, nodeId } = request.params as { projectId: string; nodeId: string };
    const body = request.body as { reason?: string };
    repository.markNotApplicable(projectId, nodeId, body.reason ?? null);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/checklist/:nodeId/reopen', async (request) => {
    const { projectId, nodeId } = request.params as { projectId: string; nodeId: string };
    repository.reopenNode(projectId, nodeId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/checklist/:nodeId/photos', async (request, reply) => {
    const { projectId, nodeId } = request.params as { projectId: string; nodeId: string };
    const project = repository.getProject(projectId);
    const node = repository.getChecklistNode(projectId, nodeId);

    if (!project || !node) return reply.status(404).send({ error: 'Project or checklist node not found' });
    if (!Boolean(node.acceptsPhotos)) return reply.status(400).send({ error: 'Node does not accept photos' });

    let reserveLocation: ReserveLocation | null = null;
    let sourceFileName: string | null = null;
    let sourceBuffer: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        sourceFileName = part.filename;
        sourceBuffer = await part.toBuffer();
      } else if (part.fieldname === 'reserveLocation') {
        const value = String(part.value);
        reserveLocation = value === 'Doziemny' || value === 'W studni' ? value : null;
      }
    }

    if (!sourceFileName || !sourceBuffer) return reply.status(400).send({ error: 'No photo uploaded' });

    const photoId = randomUUID();
    const existingCount = repository.countPhotosForNode(nodeId, reserveLocation);
    const target = resolvePhotoTarget({
      projectFolder: project.baseFolder,
      nodePath: node.path,
      nodeName: node.name,
      existingCount,
      reserveLocation,
      sourceFileName,
    });
    const processed = await processPhoto(sourceBuffer);
    
    const thumbnailPath = join(project.baseFolder, '.thumbnails', `${photoId}.webp`);

    await mkdir(dirname(target.absolutePath), { recursive: true });
    await mkdir(dirname(thumbnailPath), { recursive: true });
    await writeFile(target.absolutePath, processed.buffer);
    await writeFile(thumbnailPath, processed.thumbnail);

    repository.addPhoto({
      id: photoId,
      projectId,
      checklistNodeId: nodeId,
      sourceFileName,
      storedFileName: target.fileName,
      storagePath: target.absolutePath,
      thumbnailPath,
      mimeType: processed.mimeType,
      fileSize: processed.fileSize,
      lat: processed.lat,
      lng: processed.lng,
      capturedAt: processed.capturedAt,
      reserveLocation,
    });

    return {
      id: photoId,
      storedFileName: target.fileName,
      storagePath: target.absolutePath,
      thumbnailPath,
    };
  });

  app.post('/api/projects/:projectId/checklist/:nodeId/photos/reclassify', async (request, reply) => {
    const { projectId, nodeId } = request.params as { projectId: string; nodeId: string };
    const body = request.body as { photoIds?: string[]; reserveLocation?: ReserveLocation };
    const project = repository.getProject(projectId);
    const node = repository.getChecklistNode(projectId, nodeId);

    if (!project || !node) return reply.status(404).send({ error: 'Project or checklist node not found' });
    if (node.nodeType !== 'CABLE_RESERVE') {
      return reply.status(400).send({ error: 'Only cable reserve photos can be reclassified' });
    }

    const reserveLocation =
      body.reserveLocation === 'Doziemny' || body.reserveLocation === 'W studni'
        ? body.reserveLocation
        : null;
    const photoIds = Array.isArray(body.photoIds) ? body.photoIds.filter(Boolean) : [];

    if (!reserveLocation || photoIds.length === 0) {
      return reply.status(400).send({ error: 'photoIds and reserveLocation are required' });
    }

    const photos = repository.getPhotosByIds(projectId, nodeId, photoIds);
    if (photos.length !== photoIds.length) {
      return reply.status(404).send({ error: 'Some photos were not found' });
    }

    let existingCount = repository.countPhotosForNode(nodeId, reserveLocation);
    for (const photo of photos) {
      if (photo.reserveLocation === reserveLocation) {
        existingCount = Math.max(existingCount, repository.countPhotosForNode(nodeId, reserveLocation));
        continue;
      }

      const target = resolvePhotoTarget({
        projectFolder: project.baseFolder,
        nodePath: node.path,
        nodeName: node.name,
        existingCount,
        reserveLocation,
        sourceFileName: photo.sourceFileName,
      });

      await mkdir(dirname(target.absolutePath), { recursive: true });
      await rename(photo.storagePath, target.absolutePath);

      repository.updatePhotoRecord(photo.id, {
        storedFileName: target.fileName,
        storagePath: target.absolutePath,
        thumbnailPath: photo.thumbnailPath, // Keep existing thumbnail path
        reserveLocation,
      });
      existingCount += 1;
    }

    return { moved: photos.filter((photo) => photo.reserveLocation !== reserveLocation).length };
  });

  app.post('/api/projects', async (request, reply) => {
    let projectType: ProjectType = 'SI';
    let manualTopology: SplitterTopology | 'AUTO' | undefined;
    let gpkgFileName: string | null = null;
    let gpkgBuffer: Buffer | null = null;
    let photoRootPath: string | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        gpkgFileName = part.filename;
        gpkgBuffer = await part.toBuffer();
      } else if (part.fieldname === 'projectType') {
        const value = String(part.value);
        projectType = value === 'KPO' ? 'KPO' : 'SI';
      } else if (part.fieldname === 'splitterTopology') {
        const value = String(part.value);
        manualTopology = value === 'SINGLE' || value === 'CASCADE' ? value : 'AUTO';
      } else if (part.fieldname === 'photoRootPath') {
        photoRootPath = String(part.value);
      }
    }

    if (!gpkgFileName || !gpkgBuffer) return reply.status(400).send({ error: 'No file uploaded' });
    if (!photoRootPath?.trim()) return reply.status(400).send({ error: 'photoRootPath is required' });
    
    const tempGpkgPath = join(tmpdir(), `photo-local-${randomUUID()}.gpkg`);
    writeFileSync(tempGpkgPath, gpkgBuffer);

    try {
      const extracted = extractGpkg(tempGpkgPath);
      const projectId = randomUUID();
      const projectName = extracted.suggestedProjectName ?? gpkgFileName.replace(/\.gpkg$/i, '');

      const projectFolder = resolveProjectPhotoFolder(photoRootPath);
      const splitterTopology =
        manualTopology && manualTopology !== 'AUTO' ? manualTopology : extracted.suggestedSplitterTopology;
      mkdirSync(projectFolder, { recursive: true });
      
      const checklistAddresses = extracted.addresses.map(addr => ({
        ...addr,
        id: randomUUID()
      }));

      const checklistNodes = generateChecklistNodes({
        projectId,
        projectName,
        projectType,
        splitterTopology,
        addresses: checklistAddresses,
        splices: extracted.splices,
        dacToAddressCableEntries: extracted.dacToAddressCableEntries,
        adssToAddressCableEntries: extracted.adssToAddressCableEntries,
      });

      const project = repository.createProject({
        name: projectName,
        projectDefinition: extracted.suggestedProjectDefinition ?? null,
        projectType,
        splitterTopology,
        splitterTopologySource: manualTopology && manualTopology !== 'AUTO' ? 'MANUAL' : 'AUTO',
        splitterCount: extracted.splitterCount,
        gpkgFileName,
        baseFolder: projectFolder,
        addresses: checklistAddresses,
        dacToAddressCableCount: extracted.dacToAddressCableEntries.length,
        adssToAddressCableCount: extracted.adssToAddressCableEntries.length,
        checklistNodes,
      });

      return project;
    } finally {
      if (existsSync(tempGpkgPath)) {
        unlinkSync(tempGpkgPath);
      }
    }
  });
}
