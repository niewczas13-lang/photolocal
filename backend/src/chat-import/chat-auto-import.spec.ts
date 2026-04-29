import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from '../projects/projects-repository.js';
import { ChatBatchesRepository } from './chat-batches-repository.js';
import { acceptReadyChatBatches } from './chat-auto-import.js';
import type { ChatManifest } from './chat-manifest.js';

function createContext() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-auto-import-'));
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

  return {
    source: 'google-chat',
    spaceName: 'spaces/AAA',
    spaceDisplayName: 'Budowa',
    messageName: 'spaces/AAA/messages/Maleniecka-5',
    messageText: 'Maleniecka 5',
    createTime: '2026-04-27T10:00:00Z',
    folderName: 'Maleniecka 5',
    folderPath,
    files: [{ fileName: 'photo.jpeg', contentName: 'photo.jpeg', contentType: 'image/jpeg' }],
  };
}

describe('acceptReadyChatBatches', () => {
  it('imports ready batches into their matched checklist nodes', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(join(dir, 'Maleniecka 5')),
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'Doziemny',
      confidence: 0.93,
      llmModel: 'qwen2.5vl:3b',
    });

    const result = await acceptReadyChatBatches({
      projectId,
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

    const updated = batches.getBatch(projectId, batch.id);
    const photos = projects.getNodePhotos(projectId, 'node-maleniecka-5');
    db.close();

    expect(result).toEqual({ importedBatches: 1, importedPhotos: 1, skippedBatches: 0 });
    expect(updated?.status).toBe('IMPORTED');
    expect(photos).toHaveLength(1);
    expect(photos[0].reserveLocation).toBe('Doziemny');
    expect(existsSync(photos[0].storagePath)).toBe(true);
  });

  it('imports ready distribution box batches without reserve location', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, address_id,
        sort_order, min_photos, accepts_photos, status
      ) VALUES (?, ?, null, ?, ?, 'DISTRIBUTION', null, 1, 1, 1, 'OPEN')`,
    ).run('node-osd2766-details', projectId, 'Szczegoly_skrzynki', 'OSD2766/Szczegoly_skrzynki');
    batches.importManifest({
      projectId,
      manifest: createManifest(join(dir, 'OSD2766')),
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-osd2766-details',
      reserveLocation: null,
      confidence: null,
      llmModel: null,
    });

    const result = await acceptReadyChatBatches({
      projectId,
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

    const photos = projects.getNodePhotos(projectId, 'node-osd2766-details');
    db.close();

    expect(result).toEqual({ importedBatches: 1, importedPhotos: 1, skippedBatches: 0 });
    expect(photos).toHaveLength(1);
    expect(photos[0].reserveLocation).toBeNull();
  });
});
