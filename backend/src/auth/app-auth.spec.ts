import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticateUser, upsertAppUser } from './app-auth.js';
import { buildApp } from '../app.js';
import { ProjectsRepository } from '../projects/projects-repository.js';

describe('app auth', () => {
  afterEach(() => {
    delete process.env.PHOTO_LOCAL_AUTH;
    delete process.env.PHOTO_LOCAL_DB;
    delete process.env.PHOTO_BASE_DIR;
  });

  it('seeds default users and protects API routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-auth-'));
    process.env.PHOTO_LOCAL_AUTH = 'enabled';
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app } = await buildApp();

    const blocked = await app.inject({ method: 'GET', url: '/api/projects' });
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'aniela', password: 'zle' }),
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'aniela', password: 'aniela' }),
    });
    const karolLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'karol', password: 'karol' }),
    });
    const token = login.json().token as string;
    const authorized = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const renewedCookie = me.headers['set-cookie'];

    await app.close();

    expect(blocked.statusCode).toBe(401);
    expect(badLogin.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(karolLogin.statusCode).toBe(200);
    expect(karolLogin.json()).toMatchObject({ user: { username: 'karol' } });
    expect(login.json()).toMatchObject({ user: { username: 'aniela' } });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(32);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual([]);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: 'aniela' } });
    expect(renewedCookie).toContain('photo_local_session=');
  });

  it('creates or updates a local app user with an explicit password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-auth-upsert-'));
    process.env.PHOTO_LOCAL_AUTH = 'enabled';
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();

    const created = upsertAppUser(db, 'Karol', 'inne-haslo');
    const badPassword = authenticateUser(db, 'karol', 'karol');
    const goodPassword = authenticateUser(db, 'karol', 'inne-haslo');

    await app.close();

    expect(created.username).toBe('karol');
    expect(badPassword).toBeNull();
    expect(goodPassword).toMatchObject({ username: 'karol' });
  });

  it('allows browser image requests to use the login session cookie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-auth-photo-'));
    process.env.PHOTO_LOCAL_AUTH = 'enabled';
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    const repository = new ProjectsRepository(db);
    const projectFolder = join(dir, 'photos', 'PROJEKT');
    const storagePath = join(projectFolder, 'photo.jpeg');
    mkdirSync(projectFolder, { recursive: true });
    writeFileSync(storagePath, 'photo-bytes');
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
          id: 'node-photo',
          projectId: 'project-temp',
          parentId: null,
          name: 'Zdjecia',
          path: 'Zdjecia',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });
    repository.addPhoto({
      id: 'photo-1',
      projectId: project.id,
      checklistNodeId: 'node-photo',
      sourceFileName: 'photo.jpeg',
      storedFileName: 'photo.jpeg',
      storagePath,
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 10,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'pawel', password: 'pawel' }),
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const photoResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/photos/photo-1/file`,
      headers: { cookie: cookie?.split(';')[0] ?? '' },
    });

    await app.close();

    expect(login.statusCode).toBe(200);
    expect(cookie).toContain('photo_local_session=');
    expect(photoResponse.statusCode).toBe(200);
    expect(photoResponse.body).toBe('photo-bytes');
  });
});
