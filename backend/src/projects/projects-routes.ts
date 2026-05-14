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
  updateChatClassificationDiagnostics,
  updateChatClassificationProgress,
} from '../chat-import/chat-classification-status.js';
import { ChatBatchesRepository, type ChatBatchStatus } from '../chat-import/chat-batches-repository.js';
import { importChatFolders } from '../chat-import/chat-importer.js';
import { getOllamaDiagnostics } from '../chat-import/ollama-diagnostics.js';
import { extractGpkg } from '../gpkg/gpkg-extractor.js';
import {
  getGoogleChatDownloadStatus,
  listGoogleChatSpaces,
  startGoogleChatDownload,
} from '../google-chat/google-chat-downloader.js';
import { generateChecklistNodes } from '../checklist/checklist-generator.js';
import type { ChecklistAddress, GeneratedChecklistNode } from '../checklist/checklist-generator.js';
import { loadConfig } from '../config.js';
import type { ProjectType, SplitterTopology } from '../types.js';
import { isReserveLocation, processPhoto, resolvePhotoTarget, type ReserveLocation } from '../photos/photo-processor.js';
import { runProjectOperation } from '../utils/project-operation-queue.js';

interface PreparedChecklistFromGpkg {
  projectDefinition: string | null;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  splitterTopologySource: 'AUTO' | 'MANUAL';
  splitterCount: number;
  addresses: ChecklistAddress[];
  checklistNodes: GeneratedChecklistNode[];
  dacToAddressCableCount: number;
  adssToAddressCableCount: number;
}

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

function getChatAcceptErrorStatus(error: unknown): 409 | 500 {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('already imported') ||
    message.includes('already rejected') ||
    message.includes('no remaining files') ||
    message.includes('no longer available')
    ? 409
    : 500;
}

function prepareChecklistFromGpkg(input: {
  projectId: string;
  projectName: string;
  gpkgPath: string;
  projectType: ProjectType;
  manualTopology: SplitterTopology | 'AUTO' | undefined;
}): PreparedChecklistFromGpkg {
  const extracted = extractGpkg(input.gpkgPath);
  const splitterTopology =
    input.manualTopology && input.manualTopology !== 'AUTO'
      ? input.manualTopology
      : extracted.suggestedSplitterTopology;
  const addresses = extracted.addresses.map((addr) => ({
    ...addr,
    id: randomUUID(),
  }));

  return {
    projectDefinition: extracted.suggestedProjectDefinition ?? null,
    projectType: input.projectType,
    splitterTopology,
    splitterTopologySource: input.manualTopology && input.manualTopology !== 'AUTO' ? 'MANUAL' : 'AUTO',
    splitterCount: extracted.splitterCount,
    addresses,
    checklistNodes: generateChecklistNodes({
      projectId: input.projectId,
      projectName: input.projectName,
      projectType: input.projectType,
      splitterTopology,
      addresses,
      splices: extracted.splices,
      dacToAddressCableEntries: extracted.dacToAddressCableEntries,
      adssToAddressCableEntries: extracted.adssToAddressCableEntries,
    }),
    dacToAddressCableCount: extracted.dacToAddressCableEntries.length,
    adssToAddressCableCount: extracted.adssToAddressCableEntries.length,
  };
}

export async function registerProjectRoutes(app: FastifyInstance, db: Database.Database): Promise<void> {
  const repository = new ProjectsRepository(db);
  const chatBatchesRepository = new ChatBatchesRepository(db);
  let isClosing = false;
  const classificationDiagnosticsTimers = new Map<string, NodeJS.Timeout>();
  const stopClassificationDiagnostics = (projectId: string) => {
    const timer = classificationDiagnosticsTimers.get(projectId);
    if (!timer) return;
    clearInterval(timer);
    classificationDiagnosticsTimers.delete(projectId);
  };
  app.addHook('onClose', async () => {
    isClosing = true;
    for (const timer of classificationDiagnosticsTimers.values()) {
      clearInterval(timer);
    }
    classificationDiagnosticsTimers.clear();
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
    const refreshDiagnostics = async () => {
      try {
        updateChatClassificationDiagnostics(projectId, await getOllamaDiagnostics());
      } catch (error) {
        app.log.warn({ error }, 'Failed to refresh Ollama diagnostics');
      }
    };
    stopClassificationDiagnostics(projectId);
    void refreshDiagnostics();
    classificationDiagnosticsTimers.set(projectId, setInterval(() => void refreshDiagnostics(), 5_000));

    setImmediate(() => {
      if (isClosing) return;

      void classifyWaitingChatBatches({
        projectId,
        projectsRepository: repository,
        batchesRepository: chatBatchesRepository,
        onProgress: updateChatClassificationProgress,
      })
      .then((result) => {
        stopClassificationDiagnostics(projectId);
        completeChatClassification(projectId, result);
      })
      .catch((error: unknown) => {
        stopClassificationDiagnostics(projectId);
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

    try {
      return await runProjectOperation(projectId, () =>
        acceptReadyChatBatches({
          projectId,
          projectsRepository: repository,
          batchesRepository: chatBatchesRepository,
        }),
      );
    } catch (error) {
      app.log.error({ error, projectId }, 'Failed to accept ready chat batches');
      return reply.status(getChatAcceptErrorStatus(error)).send({
        error: error instanceof Error ? error.message : 'Blad podczas importu gotowych paczek',
      });
    }
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
    const reserveLocation = isReserveLocation(body.reserveLocation) ? body.reserveLocation : null;

    if (checklistNodeIds.length === 0) {
      return reply.status(400).send({ error: 'checklistNodeIds are required' });
    }

    const selectedNodes = checklistNodeIds.map((nodeId) => repository.getChecklistNode(projectId, nodeId));
    if (selectedNodes.some((node) => !node)) {
      return reply.status(404).send({ error: 'Some checklist nodes were not found' });
    }
    const batch = chatBatchesRepository.getBatch(projectId, batchId);
    if (!batch) {
      return reply.status(404).send({ error: 'Chat batch not found' });
    }
    if (batch.status === 'IMPORTED' || batch.status === 'REJECTED') {
      return reply.status(409).send({
        error: 'Ta paczka zostala juz obsluzona. Odswiez liste paczek.',
      });
    }
    const currentFiles = chatBatchesRepository.listBatchFiles(projectId, batchId);
    if (currentFiles.length === 0) {
      return reply.status(409).send({
        error: 'Ta paczka nie ma juz zdjec do importu. Odswiez liste paczek.',
      });
    }
    if (fileIds && !fileIds.every((fileId) => currentFiles.some((file) => file.id === fileId))) {
      return reply.status(409).send({
        error: 'Wybrane zdjecia z paczki nie sa juz dostepne. Odswiez liste paczek.',
      });
    }
    const requiresReserveLocation = selectedNodes.some((node) => node?.nodeType === 'CABLE_RESERVE');
    if (requiresReserveLocation && !reserveLocation) {
      return reply.status(400).send({ error: 'reserveLocation is required for cable reserve nodes' });
    }

    try {
      return await runProjectOperation(projectId, () =>
        acceptChatBatch({
          projectId,
          batchId,
          checklistNodeIds,
          fileIds,
          reserveLocation,
          projectsRepository: repository,
          batchesRepository: chatBatchesRepository,
        }),
      );
    } catch (error) {
      app.log.error({ error, projectId, batchId }, 'Failed to accept chat batch');
      return reply.status(getChatAcceptErrorStatus(error)).send({
        error: error instanceof Error ? error.message : 'Blad podczas akceptacji paczki z czatu',
      });
    }
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

  app.delete('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const deleted = repository.deleteProject(projectId);

    if (!deleted) return reply.status(404).send({ error: 'Project not found' });
    return { ok: true };
  });

  app.post('/api/projects/:projectId/checklist/recalculate', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = repository.getProject(projectId);
    let projectType: ProjectType | undefined;
    let manualTopology: SplitterTopology | 'AUTO' | undefined;
    let gpkgFileName: string | null = null;
    let gpkgBuffer: Buffer | null = null;

    if (!project) return reply.status(404).send({ error: 'Project not found' });

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
      }
    }

    if (!gpkgFileName || !gpkgBuffer) return reply.status(400).send({ error: 'No file uploaded' });

    const tempGpkgPath = join(tmpdir(), `photo-local-recalculate-${randomUUID()}.gpkg`);
    writeFileSync(tempGpkgPath, gpkgBuffer);

    try {
      const prepared = prepareChecklistFromGpkg({
        projectId,
        projectName: project.name,
        gpkgPath: tempGpkgPath,
        projectType: projectType ?? project.projectType,
        manualTopology:
          manualTopology ??
          (project.splitterTopologySource === 'MANUAL' ? project.splitterTopology : 'AUTO'),
      });
      const result = repository.recalculateChecklist({
        projectId,
        projectDefinition: prepared.projectDefinition,
        projectType: prepared.projectType,
        splitterTopology: prepared.splitterTopology,
        splitterTopologySource: prepared.splitterTopologySource,
        splitterCount: prepared.splitterCount,
        gpkgFileName,
        addresses: prepared.addresses,
        dacToAddressCableCount: prepared.dacToAddressCableCount,
        adssToAddressCableCount: prepared.adssToAddressCableCount,
        checklistNodes: prepared.checklistNodes,
      });

      return {
        ...result,
        project: repository.getProject(projectId),
      };
    } finally {
      if (existsSync(tempGpkgPath)) {
        unlinkSync(tempGpkgPath);
      }
    }
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
        reserveLocation = isReserveLocation(value) ? value : null;
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

    const reserveLocation = isReserveLocation(body.reserveLocation) ? body.reserveLocation : null;
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
      const projectId = randomUUID();
      const extracted = extractGpkg(tempGpkgPath);
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
