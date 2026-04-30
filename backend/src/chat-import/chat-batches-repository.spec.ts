import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from '../projects/projects-repository.js';
import { ChatBatchesRepository } from './chat-batches-repository.js';
import type { ChatManifest } from './chat-manifest.js';

function createRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-batches-'));
  mkdirSync(dir, { recursive: true });
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
    baseFolder: join(dir, 'photos'),
    addresses: [],
    dacToAddressCableCount: 0,
    adssToAddressCableCount: 0,
    checklistNodes: [
      {
        id: 'node-reserve',
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

  return { db, repository: new ChatBatchesRepository(db), projectId: project.id, tempDir: dir };
}

function createManifest(folderPath: string): ChatManifest {
  writeFileSync(join(folderPath, 'a.jpeg'), 'image-a');
  writeFileSync(join(folderPath, 'b.png'), 'image-b');

  return {
    source: 'google-chat',
    spaceName: 'spaces/AAA',
    spaceDisplayName: 'Budowa',
    messageName: 'spaces/AAA/messages/BBB',
    messageText: 'Maleniecka 5',
    createTime: '2026-04-27T10:00:00Z',
    folderName: 'Maleniecka 5',
    folderPath,
    files: [
      { fileName: 'a.jpeg', contentName: 'a.jpeg', contentType: 'image/jpeg' },
      { fileName: 'b.png', contentName: 'b.png', contentType: 'image/png' },
    ],
  };
}

describe('ChatBatchesRepository', () => {
  it('stores a whole Google Chat folder as one review batch with files', () => {
    const { db, repository, projectId, tempDir } = createRepository();
    const folderPath = join(tempDir, 'Maleniecka 5');
    mkdirSync(folderPath, { recursive: true });

    const batch = repository.importManifest({
      projectId,
      manifest: createManifest(folderPath),
      status: 'PENDING_REVIEW',
      reviewReason: 'Needs human review',
    });

    expect(batch).toMatchObject({
      projectId,
      sourceMessageName: 'spaces/AAA/messages/BBB',
      messageText: 'Maleniecka 5',
      folderName: 'Maleniecka 5',
      folderPath,
      status: 'PENDING_REVIEW',
      reviewReason: 'Needs human review',
      fileCount: 2,
    });

    const files = repository.listBatchFiles(projectId, batch.id);
    db.close();

    expect(files).toEqual([
      expect.objectContaining({ fileName: 'a.jpeg', sourcePath: join(folderPath, 'a.jpeg') }),
      expect.objectContaining({ fileName: 'b.png', sourcePath: join(folderPath, 'b.png') }),
    ]);
  });

  it('updates the same chat message folder instead of duplicating it', () => {
    const { db, repository, projectId, tempDir } = createRepository();
    const folderPath = join(tempDir, 'Maleniecka 5');
    mkdirSync(folderPath, { recursive: true });
    const manifest = createManifest(folderPath);

    const first = repository.importManifest({ projectId, manifest, status: 'PENDING_REVIEW' });
    const second = repository.importManifest({
      projectId,
      manifest: {
        ...manifest,
        messageText: 'Maleniecka 5 poprawione',
        files: [...manifest.files, { fileName: 'c.webp', contentName: 'c.webp', contentType: 'image/webp' }],
      },
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-reserve',
      reserveLocation: 'W studni',
      confidence: 0.91,
      llmModel: 'qwen2.5vl:3b',
      visualEvidence: ['widoczna studnia'],
    });

    expect(second.id).toBe(first.id);
    expect(repository.listBatches(projectId)).toHaveLength(1);
    expect(second).toMatchObject({
      messageText: 'Maleniecka 5 poprawione',
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-reserve',
      reserveLocation: 'W studni',
      confidence: 0.91,
      llmModel: 'qwen2.5vl:3b',
      fileCount: 3,
    });
    expect(repository.listBatchFiles(projectId, second.id)).toHaveLength(3);
    db.close();
  });

  it('removes selected files from the active batch', () => {
    const { db, repository, projectId, tempDir } = createRepository();
    const folderPath = join(tempDir, 'Maleniecka 5');
    mkdirSync(folderPath, { recursive: true });

    const batch = repository.importManifest({
      projectId,
      manifest: createManifest(folderPath),
      status: 'PENDING_REVIEW',
      reviewReason: 'Needs human review',
    });
    const files = repository.listBatchFiles(projectId, batch.id);

    const removed = repository.removeBatchFiles(projectId, batch.id, [files[0].id]);
    const remaining = repository.listBatchFiles(projectId, batch.id);
    const updatedBatch = repository.getBatch(projectId, batch.id);
    db.close();

    expect(removed).toBe(1);
    expect(remaining.map((file) => file.id)).toEqual([files[1].id]);
    expect(updatedBatch?.fileCount).toBe(1);
  });
});
