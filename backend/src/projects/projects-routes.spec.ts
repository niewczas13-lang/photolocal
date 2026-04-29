import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { ChatBatchesRepository } from '../chat-import/chat-batches-repository.js';
import { ProjectsRepository } from './projects-repository.js';

describe('projects routes', () => {
  afterEach(() => {
    delete process.env.PHOTO_LOCAL_DB;
    delete process.env.PHOTO_BASE_DIR;
  });

  it('returns an empty project list from a fresh database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app } = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('stores an uploaded photo against a checklist node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-upload-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: join(dir, 'photos', 'PROJEKT'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-upload',
          projectId: 'project-temp',
          parentId: null,
          name: 'WRONCKIEJ_13',
          path: 'Zapasy_kabli_instalacyjnych/OSD2640/WRONCKIEJ_13',
          nodeType: 'CABLE_RESERVE',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const boundary = '----photo-local-test';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="reserveLocation"\r\n\r\nDoziemny\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/checklist/node-upload/photos`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    const checklist = repository.getChecklist(project.id) as Array<{ photoCount: number }>;
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      storedFileName: 'WRONCKIEJ_13_foto1.jpeg',
    });
    expect(checklist[0].photoCount).toBe(1);
  });

  it('moves selected reserve photos to another reserve location folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-move-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: join(dir, 'photos', 'PROJEKT'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-upload',
          projectId: 'project-temp',
          parentId: null,
          name: 'WRONCKIEJ_13',
          path: 'Zapasy_kabli_instalacyjnych/OSD2640/WRONCKIEJ_13',
          nodeType: 'CABLE_RESERVE',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const boundary = '----photo-local-move-test';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const uploadPayload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="reserveLocation"\r\n\r\nDoziemny\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploadResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/checklist/node-upload/photos`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: uploadPayload,
    });
    const photoId = uploadResponse.json().id as string;
    const originalPath = uploadResponse.json().storagePath as string;

    const moveResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/checklist/node-upload/photos/reclassify`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        photoIds: [photoId],
        reserveLocation: 'W studni',
      }),
    });

    const nodeDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/checklist/node-upload`,
    });
    await app.close();

    expect(uploadResponse.statusCode).toBe(200);
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json()).toMatchObject({ moved: 1 });
    expect(existsSync(originalPath)).toBe(false);
    expect(nodeDetail.json().photos).toHaveLength(1);
    expect(nodeDetail.json().photos[0]).toMatchObject({
      id: photoId,
      reserveLocation: 'W studni',
    });
    expect(nodeDetail.json().photos[0].storagePath).toContain('Zapasy_w_studni');
    expect(existsSync(nodeDetail.json().photos[0].storagePath)).toBe(true);
  });

  it('lists and accepts a reviewed Google Chat batch into multiple checklist nodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-review-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const chatBatches = new ChatBatchesRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
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
    const chatFolder = join(dir, 'chat', 'Maleniecka 5 i 7');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    mkdirSync(chatFolder, { recursive: true });
    writeFileSync(join(chatFolder, 'photo.png'), png);
    const batch = chatBatches.importManifest({
      projectId: project.id,
      status: 'PENDING_REVIEW',
      reviewReason: 'Wiadomosc wyglada na wiele adresow',
      manifest: {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/Maleniecka-5-7',
        messageText: 'Maleniecka 5 i 7',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'Maleniecka 5 i 7',
        folderPath: chatFolder,
        files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
      },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/chat-batches?status=PENDING_REVIEW`,
    });
    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/${batch.id}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        checklistNodeIds: ['node-maleniecka-5', 'node-maleniecka-7'],
        reserveLocation: 'W studni',
      }),
    });
    const checklist = projects.getChecklist(project.id) as Array<{ id: string; photoCount: number }>;
    await app.close();

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({
        id: batch.id,
        status: 'PENDING_REVIEW',
        files: [expect.objectContaining({ fileName: 'photo.png' })],
      }),
    ]);
    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toEqual({ importedPhotos: 2, checklistNodeCount: 2, sourceFileCount: 1 });
    expect(checklist.find((node) => node.id === 'node-maleniecka-5')?.photoCount).toBe(1);
    expect(checklist.find((node) => node.id === 'node-maleniecka-7')?.photoCount).toBe(1);
  });

  it('accepts only selected files from a reviewed Google Chat batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-review-selected-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const chatBatches = new ChatBatchesRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-work',
          projectId: 'project-temp',
          parentId: null,
          name: 'Prace_zanikowe',
          path: 'Wykopy_Przeciski/Prace_zanikowe',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });
    const chatFolder = join(dir, 'chat', 'Prace');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    mkdirSync(chatFolder, { recursive: true });
    writeFileSync(join(chatFolder, 'keep.png'), png);
    writeFileSync(join(chatFolder, 'skip.png'), png);
    const batch = chatBatches.importManifest({
      projectId: project.id,
      status: 'PENDING_REVIEW',
      reviewReason: 'Opis nie wyglada na adres ani punkt checklisty',
      manifest: {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/work',
        messageText: 'Prace',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'Prace',
        folderPath: chatFolder,
        files: [
          { fileName: 'keep.png', contentName: 'keep.png', contentType: 'image/png' },
          { fileName: 'skip.png', contentName: 'skip.png', contentType: 'image/png' },
        ],
      },
    });
    const keepFile = chatBatches.listBatchFiles(project.id, batch.id).find((file) => file.fileName === 'keep.png');
    if (!keepFile) throw new Error('keep file missing');

    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/${batch.id}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        checklistNodeIds: ['node-work'],
        fileIds: [keepFile.id],
      }),
    });
    const photos = projects.getNodePhotos(project.id, 'node-work');
    await app.close();

    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toEqual({ importedPhotos: 1, checklistNodeCount: 1, sourceFileCount: 1 });
    expect(photos).toHaveLength(1);
    expect(photos[0].sourceFileName).toBe('keep.png');
    expect(photos[0].reserveLocation).toBeNull();
  });

  it('rejects a Google Chat batch without importing photos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-reject-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const chatBatches = new ChatBatchesRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });
    const chatFolder = join(dir, 'chat', 'Nie dla inwestora');
    mkdirSync(chatFolder, { recursive: true });
    writeFileSync(join(chatFolder, 'photo.png'), 'image');
    const batch = chatBatches.importManifest({
      projectId: project.id,
      status: 'PENDING_REVIEW',
      reviewReason: 'Niepotrzebne zdjecia',
      manifest: {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/reject',
        messageText: 'Nie dla inwestora',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'Nie dla inwestora',
        folderPath: chatFolder,
        files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/${batch.id}/reject`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'Nie zalaczac inwestorowi' }),
    });
    const updated = chatBatches.getBatch(project.id, batch.id);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'REJECTED', reviewReason: 'Nie zalaczac inwestorowi' });
    expect(updated).toMatchObject({ status: 'REJECTED', reviewReason: 'Nie zalaczac inwestorowi' });
  });

  it('imports downloaded Google Chat folders into project batches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-import-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });
    const chatRoot = join(dir, 'downloaded-chat');
    const normalFolder = join(chatRoot, 'Maleniecka 5');
    const noDescriptionFolder = join(chatRoot, 'brak_opisu');
    mkdirSync(normalFolder, { recursive: true });
    mkdirSync(noDescriptionFolder, { recursive: true });
    writeFileSync(join(normalFolder, 'photo.png'), 'image');
    writeFileSync(join(noDescriptionFolder, 'photo.png'), 'image');
    writeFileSync(
      join(normalFolder, 'manifest.json'),
      JSON.stringify({
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/normal',
        messageText: 'Maleniecka 5',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'Maleniecka 5',
        files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
      }),
    );
    writeFileSync(
      join(noDescriptionFolder, 'manifest.json'),
      JSON.stringify({
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/no-description',
        messageText: '',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'brak_opisu',
        files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-import`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rootPath: chatRoot }),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ imported: 2, waitingForClassification: 1, pendingReview: 1 });
  });

  it('returns a clear error when Google Chat import folder does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-missing-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-import`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rootPath: join(dir, 'missing') }),
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Google Chat import folder does not exist' });
  });

  it('starts chat batch classification in the background for a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-classify-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/classify`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ state: 'RUNNING', processed: 0, total: 0 });
  });

  it('returns chat classification status for a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-classify-status-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/chat-batches/classify/status`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'IDLE', processed: 0, total: 0 });
  });

  it('auto-accepts ready Google Chat batches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-accept-ready-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const projects = new ProjectsRepository(db);
    const chatBatches = new ChatBatchesRepository(db);
    const project = projects.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'OPP0013.gpkg',
      baseFolder: join(dir, 'photos', 'OPP0013'),
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
    const chatFolder = join(dir, 'chat', 'Maleniecka 5');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    mkdirSync(chatFolder, { recursive: true });
    writeFileSync(join(chatFolder, 'photo.png'), png);
    chatBatches.importManifest({
      projectId: project.id,
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'Doziemny',
      confidence: 0.92,
      llmModel: 'qwen2.5vl:3b',
      manifest: {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: 'spaces/AAA/messages/Maleniecka-5',
        messageText: 'Maleniecka 5',
        createTime: '2026-04-27T10:00:00Z',
        folderName: 'Maleniecka 5',
        folderPath: chatFolder,
        files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/accept-ready`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    const checklist = projects.getChecklist(project.id) as Array<{ id: string; photoCount: number }>;
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ importedBatches: 1, importedPhotos: 1, skippedBatches: 0 });
    expect(checklist.find((node) => node.id === 'node-maleniecka-5')?.photoCount).toBe(1);
  });
});
