import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { ChatBatchesRepository } from '../chat-import/chat-batches-repository.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import type { AddressGeocoder } from '../geocoding/address-geocoder.js';
import { ProjectsRepository } from './projects-repository.js';
import { registerProjectRoutes } from './projects-routes.js';

async function buildProjectRoutesTestApp(geocoder: AddressGeocoder) {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-route-candidates-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  runMigrations(db);
  const app = Fastify({ logger: false });
  await registerProjectRoutes(app, db, { addressGeocoder: geocoder });
  return { app, db, dir, repository: new ProjectsRepository(db) };
}

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

  it('deletes a project from the database without removing its photo folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-delete-project-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const projectFolder = join(dir, 'photos', 'PROJEKT');
    mkdirSync(projectFolder, { recursive: true });
    writeFileSync(join(projectFolder, 'kept.txt'), 'do not delete');
    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: projectFolder,
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-upload',
          projectId: 'project-temp',
          parentId: null,
          name: 'Zdjecia',
          path: 'Notatki_z_budowy/Zdjecia',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const response = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    const projectsAfterDelete = repository.listProjects();
    const checklistAfterDelete = repository.getChecklist(project.id);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(projectsAfterDelete).toEqual([]);
    expect(checklistAfterDelete).toEqual([]);
    expect(existsSync(join(projectFolder, 'kept.txt'))).toBe(true);
  });

  it('returns project map data and updates map work statuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-map-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: join(dir, 'photos', 'MAPA'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [],
      trunkCables: [
        {
          cableType: 'MI-MKF 48J',
          fromNode: 'ZS0001',
          toNode: 'OSD0001',
          osdName: 'OSD0001',
          geojson: { type: 'LineString', coordinates: [[21.1, 51.4], [21.2, 51.5]] },
          rawName: 'TK-1',
          routingType: 'underground',
        },
      ],
      infraNodes: [
        {
          nodeType: 'OSD',
          name: 'OSD0001',
          label: 'RADOM/OSD0001',
          lat: 51.5,
          lng: 21.2,
        },
      ],
    });

    const mapResponse = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/map` });
    const cableId = mapResponse.json().trunkCables[0].id as string;
    const nodeId = mapResponse.json().infraNodes[0].id as string;
    const cableStatusResponse = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/map/cables/${cableId}/status`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'SUSPENDED' }),
    });
    const nodeStatusResponse = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/map/nodes/${nodeId}/status`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'WELDED' }),
    });
    await app.close();

    expect(mapResponse.statusCode).toBe(200);
    expect(mapResponse.json().trunkCables[0]).toMatchObject({
      fromNode: 'ZS0001',
      toNode: 'OSD0001',
      status: 'PENDING',
      routingType: 'underground',
    });
    expect(cableStatusResponse.statusCode).toBe(200);
    expect(cableStatusResponse.json().trunkCables[0]).toMatchObject({ id: cableId, status: 'SUSPENDED' });
    expect(nodeStatusResponse.statusCode).toBe(200);
    expect(nodeStatusResponse.json().infraNodes[0]).toMatchObject({ id: nodeId, status: 'WELDED' });
  });

  it('creates and approves map address candidates through API routes', async () => {
    const geocoder: AddressGeocoder = {
      async reverse(point) {
        expect(point).toEqual({ lat: 53.8, lng: 20.5 });
        return {
          city: 'Ostrzeszewo',
          street: 'Lesna',
          buildingNo: '7',
          postalCode: '10-001',
          propertyId: null,
          parcelNumber: null,
          lat: 53.8001,
          lng: 20.5001,
          distanceMeters: 4,
          source: 'adresy.app',
        };
      },
    };
    const { app, db, repository } = await buildProjectRoutesTestApp(geocoder);
    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [
        {
          osdName: 'OSTRZESZEWO/OPP0002',
          label: 'OSTRZESZEWO/OPP0002',
          geojson: {
            type: 'Polygon',
            coordinates: [
              [
                [20.4, 53.7],
                [20.7, 53.7],
                [20.7, 54.0],
                [20.4, 54.0],
                [20.4, 53.7],
              ],
            ],
          },
          households: null,
          paCount: null,
          cableRef: null,
        },
      ],
      trunkCables: [],
      infraNodes: [],
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/map/address-candidates/reverse`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ lat: 53.8, lng: 20.5 }),
    });
    const candidateId = createResponse.json().addressCandidates[0].id as string;
    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/map/address-candidates/${candidateId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        city: 'Ostrzeszewo',
        street: 'Lesna',
        buildingNo: '7',
        propertyId: null,
        parcelNumber: null,
        distributionPoint: null,
        reserveLocation: 'Doziemny',
        createDistributionNodeType: null,
        noteBody: 'Dopisane przy zatwierdzaniu adresu',
      }),
    });
    await app.close();
    db.close();

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().addressCandidates[0]).toMatchObject({
      city: 'Ostrzeszewo',
      suggestedDistributionPoint: 'OSTRZESZEWO/OPP0002',
      assignmentSource: 'REGION',
    });
    expect(approveResponse.statusCode).toBe(200);
    expect(approveResponse.json().addressCandidates).toEqual([]);
    expect(approveResponse.json().addresses[0]).toMatchObject({
      city: 'Ostrzeszewo',
      street: 'Lesna',
      buildingNo: '7',
      distributionPoint: 'OSTRZESZEWO/OPP0002',
    });
    expect(approveResponse.json().notes[0]).toMatchObject({
      targetType: 'address',
      targetId: approveResponse.json().addresses[0].id,
      body: 'Dopisane przy zatwierdzaniu adresu',
    });
  });

  it('creates map notes and stores uploaded note photos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-map-note-route-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: join(dir, 'photos', 'MAPA'),
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const noteResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/map/notes`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        targetType: 'free',
        targetLabel: 'Notatka mapy',
        body: 'Niedroznosc przy studni',
        lat: 51.45,
        lng: 21.15,
      }),
    });
    const noteId = noteResponse.json().notes[0].id as string;
    const boundary = '----photo-local-map-note-photo-test';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="niedroznosc.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const photoResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/map/notes/${noteId}/photos`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    const mapResponse = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/map` });
    await app.close();

    expect(noteResponse.statusCode).toBe(200);
    expect(photoResponse.statusCode).toBe(200);
    expect(photoResponse.json()).toMatchObject({ storedFileName: 'NOTATKA_MAPY_foto1.jpeg' });
    expect(existsSync(photoResponse.json().storagePath)).toBe(true);
    expect(mapResponse.json().notes[0]).toMatchObject({
      id: noteId,
      body: 'Niedroznosc przy studni',
      photoCount: 1,
    });
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
    const photoHashes = repository.listProjectPhotoContentHashes(project.id);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      storedFileName: 'WRONCKIEJ_13_foto1.jpeg',
    });
    expect(checklist[0].photoCount).toBe(1);
    expect(photoHashes).toHaveLength(1);
  });

  it('serves a thumbnail fallback when the original photo file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-missing-original-'));
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
    const thumbnailPath = join(dir, 'photos', 'PROJEKT', '.thumbnails', 'photo-missing.webp');
    mkdirSync(join(dir, 'photos', 'PROJEKT', '.thumbnails'), { recursive: true });
    writeFileSync(thumbnailPath, 'thumbnail');
    repository.addPhoto({
      id: 'photo-missing',
      projectId: project.id,
      checklistNodeId: 'node-upload',
      sourceFileName: 'original.jpeg',
      storedFileName: 'stored.jpeg',
      storagePath: join(dir, 'photos', 'PROJEKT', 'missing.jpeg'),
      thumbnailPath,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: 'Doziemny',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/photos/photo-missing/file`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
    expect(response.body).toBe('thumbnail');
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

  it('deletes selected checklist photos and removes their files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-delete-photo-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const projectFolder = join(dir, 'photos', 'PROJEKT');
    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: projectFolder,
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-source',
          projectId: 'project-temp',
          parentId: null,
          name: 'ZS0001',
          path: 'ZS0001',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });
    const storagePath = join(projectFolder, 'ZS0001', 'zs.jpeg');
    const thumbnailPath = join(projectFolder, '.thumbnails', 'photo-delete.webp');
    mkdirSync(join(projectFolder, 'ZS0001'), { recursive: true });
    mkdirSync(join(projectFolder, '.thumbnails'), { recursive: true });
    writeFileSync(storagePath, 'photo');
    writeFileSync(thumbnailPath, 'thumb');
    repository.addPhoto({
      id: 'photo-delete',
      projectId: project.id,
      checklistNodeId: 'node-source',
      sourceFileName: 'source.jpeg',
      storedFileName: 'zs.jpeg',
      storagePath,
      thumbnailPath,
      mimeType: 'image/jpeg',
      fileSize: 5,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}/checklist/node-source/photos`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ photoIds: ['photo-delete'] }),
    });
    const nodeDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/checklist/node-source`,
    });
    const checklist = repository.getChecklist(project.id) as Array<{ id: string; photoCount: number; status: string }>;
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 1 });
    expect(existsSync(storagePath)).toBe(false);
    expect(existsSync(thumbnailPath)).toBe(false);
    expect(nodeDetail.json().photos).toHaveLength(0);
    expect(checklist.find((node) => node.id === 'node-source')).toMatchObject({
      photoCount: 0,
      status: 'OPEN',
    });
  });

  it('moves selected checklist photos to another checklist folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-move-folder-'));
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const projectFolder = join(dir, 'photos', 'PROJEKT');
    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: projectFolder,
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-source',
          projectId: 'project-temp',
          parentId: null,
          name: 'ZS0001',
          path: 'ZS0001',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
        {
          id: 'node-target',
          projectId: 'project-temp',
          parentId: null,
          name: 'Docelowy folder',
          path: 'Docelowy_folder',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 1,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });
    const storagePath = join(projectFolder, 'ZS0001', 'zs.jpeg');
    const thumbnailPath = join(projectFolder, '.thumbnails', 'photo-move.webp');
    mkdirSync(join(projectFolder, 'ZS0001'), { recursive: true });
    mkdirSync(join(projectFolder, '.thumbnails'), { recursive: true });
    writeFileSync(storagePath, 'photo');
    writeFileSync(thumbnailPath, 'thumb');
    repository.addPhoto({
      id: 'photo-move',
      projectId: project.id,
      checklistNodeId: 'node-source',
      sourceFileName: 'source.jpeg',
      storedFileName: 'zs.jpeg',
      storagePath,
      thumbnailPath,
      mimeType: 'image/jpeg',
      fileSize: 5,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/checklist/node-source/photos/move`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ photoIds: ['photo-move'], targetNodeId: 'node-target' }),
    });
    const sourceDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/checklist/node-source`,
    });
    const targetDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/checklist/node-target`,
    });
    const checklist = repository.getChecklist(project.id) as Array<{ id: string; photoCount: number; status: string }>;
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ moved: 1 });
    expect(existsSync(storagePath)).toBe(false);
    expect(sourceDetail.json().photos).toHaveLength(0);
    expect(targetDetail.json().photos).toEqual([
      expect.objectContaining({
        id: 'photo-move',
        checklistNodeId: 'node-target',
        storedFileName: 'SOURCE_1.jpeg',
        reserveLocation: null,
      }),
    ]);
    expect(targetDetail.json().photos[0].storagePath).toContain('Docelowy_folder');
    expect(existsSync(targetDetail.json().photos[0].storagePath)).toBe(true);
    expect(checklist.find((node) => node.id === 'node-source')).toMatchObject({
      photoCount: 0,
      status: 'OPEN',
    });
    expect(checklist.find((node) => node.id === 'node-target')).toMatchObject({
      photoCount: 1,
      status: 'COMPLETE',
    });
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
    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/chat-batches?status=PENDING_REVIEW`,
    });
    const photos = projects.getNodePhotos(project.id, 'node-work');
    await app.close();

    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toEqual({ importedPhotos: 1, checklistNodeCount: 1, sourceFileCount: 1 });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({
        id: batch.id,
        status: 'PENDING_REVIEW',
        reviewReason: 'Opis nie wyglada na adres ani punkt checklisty',
        files: [expect.objectContaining({ fileName: 'skip.png' })],
      }),
    ]);
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
    writeFileSync(join(normalFolder, 'photo.png'), 'normal-image');
    writeFileSync(join(noDescriptionFolder, 'photo.png'), 'no-description-image');
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
    const statusResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/chat-import/status`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ imported: 2, waitingForClassification: 1, pendingReview: 1, cleared: 0 });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      state: 'COMPLETED',
      processedFiles: 2,
      totalFiles: 2,
      imported: 2,
      waitingForClassification: 1,
      pendingReview: 1,
    });
  });

  it('clears Google Chat working queues for a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-clear-route-'));
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
    const statuses = [
      'WAITING_FOR_CLASSIFICATION',
      'READY_FOR_IMPORT',
      'PENDING_REVIEW',
      'IMPORTED',
    ] as const;

    for (const status of statuses) {
      const chatFolder = join(dir, 'chat', status);
      mkdirSync(chatFolder, { recursive: true });
      writeFileSync(join(chatFolder, 'photo.png'), 'image');
      chatBatches.importManifest({
        projectId: project.id,
        status,
        manifest: {
          source: 'google-chat',
          spaceName: 'spaces/AAA',
          spaceDisplayName: 'Budowa',
          messageName: `spaces/AAA/messages/${status}`,
          messageText: status,
          createTime: '2026-04-27T10:00:00Z',
          folderName: status,
          folderPath: chatFolder,
          files: [{ fileName: 'photo.png', contentName: 'photo.png', contentType: 'image/png' }],
        },
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/chat-batches/clear-working`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    const remaining = chatBatches.listBatches(project.id).map((batch) => batch.status);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cleared: 3 });
    expect(remaining).toEqual(['IMPORTED']);
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
