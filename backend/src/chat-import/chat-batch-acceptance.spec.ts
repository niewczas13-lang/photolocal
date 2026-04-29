import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from '../projects/projects-repository.js';
import { ChatBatchesRepository } from './chat-batches-repository.js';
import { acceptChatBatch } from './chat-batch-acceptance.js';
import type { ChatManifest } from './chat-manifest.js';

function createContext() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-acceptance-'));
  const photoBaseDir = join(dir, 'photo-base');
  mkdirSync(photoBaseDir, { recursive: true });
  const db = openDatabase(join(dir, 'test.sqlite'));
  runMigrations(db);
  const projects = new ProjectsRepository(db);
  const project = projects.createProject({
    name: 'OPP0013',
    projectDefinition: null,
    projectType: 'SI',
    splitterTopology: 'SINGLE',
    splitterTopologySource: 'AUTO',
    splitterCount: 1,
    gpkgFileName: 'OPP0013.gpkg',
    baseFolder: join(photoBaseDir, 'OPP0013'),
    addresses: [],
    dacToAddressCableCount: 0,
    adssToAddressCableCount: 0,
    checklistNodes: [
      {
        id: 'node-maleniecka-5',
        projectId: 'project-temp',
        parentId: null,
        name: 'Maleniecka_5',
        path: 'Zapasy_kabli_instalacyjnych/OPP0013/Maleniecka_5',
        nodeType: 'CABLE_RESERVE',
        addressId: null,
        sortOrder: 0,
        minPhotos: 1,
        acceptsPhotos: true,
      },
      {
        id: 'node-maleniecka-7',
        projectId: 'project-temp',
        parentId: null,
        name: 'Maleniecka_7',
        path: 'Zapasy_kabli_instalacyjnych/OPP0013/Maleniecka_7',
        nodeType: 'CABLE_RESERVE',
        addressId: null,
        sortOrder: 1,
        minPhotos: 1,
        acceptsPhotos: true,
      },
    ],
  });

  return {
    db,
    projects,
    batches: new ChatBatchesRepository(db),
    projectId: project.id,
    dir,
    photoBaseDir,
  };
}

function createManifest(folderPath: string): ChatManifest {
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(join(folderPath, 'photo.jpeg'), 'source-image');
  writeFileSync(join(folderPath, 'skip.jpeg'), 'skipped-image');

  return {
    source: 'google-chat',
    spaceName: 'spaces/AAA',
    spaceDisplayName: 'Budowa',
    messageName: 'spaces/AAA/messages/Maleniecka-5-7',
    messageText: 'Maleniecka 5 i 7',
    createTime: '2026-04-27T10:00:00Z',
    folderName: 'Maleniecka 5 i 7',
    folderPath,
    files: [
      { fileName: 'photo.jpeg', contentName: 'photo.jpeg', contentType: 'image/jpeg' },
      { fileName: 'skip.jpeg', contentName: 'skip.jpeg', contentType: 'image/jpeg' },
    ],
  };
}

describe('acceptChatBatch', () => {
  it('copies the same reviewed chat photos into multiple checklist nodes', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(join(dir, 'Maleniecka 5 i 7')),
      status: 'PENDING_REVIEW',
      reviewReason: 'Wiadomosc wyglada na wiele adresow',
    });

    const result = await acceptChatBatch({
      projectId,
      batchId: batch.id,
      checklistNodeIds: ['node-maleniecka-5', 'node-maleniecka-7'],
      reserveLocation: 'W studni',
      projectsRepository: projects,
      batchesRepository: batches,
      processPhoto: async () => ({
        buffer: Buffer.from('processed-photo'),
        thumbnail: Buffer.from('thumb'),
        mimeType: 'image/jpeg',
        fileSize: 15,
        lat: null,
        lng: null,
        capturedAt: null,
      }),
    });

    const updatedBatch = batches.getBatch(projectId, batch.id);
    const imports = batches.listFileImports(projectId, batch.id);
    const node5Photos = projects.getNodePhotos(projectId, 'node-maleniecka-5');
    const node7Photos = projects.getNodePhotos(projectId, 'node-maleniecka-7');
    db.close();

    expect(result).toEqual({ importedPhotos: 4, checklistNodeCount: 2, sourceFileCount: 2 });
    expect(updatedBatch).toMatchObject({ status: 'IMPORTED', reserveLocation: 'W studni' });
    expect(imports).toHaveLength(4);
    expect(node5Photos).toHaveLength(2);
    expect(node7Photos).toHaveLength(2);
    expect(node5Photos[0].reserveLocation).toBe('W studni');
    expect(node7Photos[0].reserveLocation).toBe('W studni');
    expect(existsSync(node5Photos[0].storagePath)).toBe(true);
    expect(existsSync(node7Photos[0].storagePath)).toBe(true);
  });

  it('imports only selected chat batch files', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(join(dir, 'Maleniecka 5 i 7')),
      status: 'PENDING_REVIEW',
      reviewReason: 'Wiadomosc wyglada na wiele adresow',
    });
    const files = batches.listBatchFiles(projectId, batch.id);
    const selectedFile = files.find((file) => file.fileName === 'photo.jpeg');
    if (!selectedFile) throw new Error('selected file missing');

    const result = await acceptChatBatch({
      projectId,
      batchId: batch.id,
      checklistNodeIds: ['node-maleniecka-5'],
      fileIds: [selectedFile.id],
      reserveLocation: 'W studni',
      projectsRepository: projects,
      batchesRepository: batches,
      processPhoto: async () => ({
        buffer: Buffer.from('processed-photo'),
        thumbnail: Buffer.from('thumb'),
        mimeType: 'image/jpeg',
        fileSize: 15,
        lat: null,
        lng: null,
        capturedAt: null,
      }),
    });

    const imports = batches.listFileImports(projectId, batch.id);
    const nodePhotos = projects.getNodePhotos(projectId, 'node-maleniecka-5');
    db.close();

    expect(result).toEqual({ importedPhotos: 1, checklistNodeCount: 1, sourceFileCount: 1 });
    expect(imports).toHaveLength(1);
    expect(imports[0].chatPhotoFileId).toBe(selectedFile.id);
    expect(nodePhotos).toHaveLength(1);
    expect(nodePhotos[0].sourceFileName).toBe('photo.jpeg');
  });
});
