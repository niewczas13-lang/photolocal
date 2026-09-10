import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateUser, listAppUsers, upsertAppUser } from './app-auth.js';
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

  it('lists users and marks whether the password is still the default login password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-auth-list-'));
    process.env.PHOTO_LOCAL_AUTH = 'enabled';
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.PHOTO_BASE_DIR = join(dir, 'photos');

    const { app, db } = await buildApp();
    upsertAppUser(db, 'Karol', 'inne-haslo');

    const users = listAppUsers(db);

    await app.close();

    expect(users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          username: 'aniela',
          defaultPasswordWorks: true,
          displayedPassword: 'aniela',
        }),
        expect.objectContaining({
          username: 'karol',
          defaultPasswordWorks: false,
          displayedPassword: null,
        }),
      ]),
    );
  });

  it('protects Google connection endpoints and allows the OAuth callback with browser cookies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-auth-google-'));
    process.env.PHOTO_LOCAL_AUTH = 'enabled';
    process.env.PHOTO_LOCAL_DB = join(dir, 'test.sqlite');
    process.env.GOOGLE_CHAT_CREDENTIALS_FILE = join(dir, 'credentials.json');
    process.env.GOOGLE_CHAT_TOKEN_FILE = join(dir, 'token.json');
    process.env.GOOGLE_CHAT_OAUTH_REDIRECT_URI = 'https://romek.example/api/google-chat/auth/callback';
    writeFileSync(process.env.GOOGLE_CHAT_CREDENTIALS_FILE, JSON.stringify({ web: { client_id: 'test', client_secret: 'secret' } }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly',
    }))));
    const { app } = await buildApp();
    try {
      expect((await app.inject('/api/google-chat/auth/status')).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/google-chat/auth/start', payload: {} })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'aniela', password: 'aniela' } });
      const appCookie = String(login.headers['set-cookie']).split(';')[0];
      const start = await app.inject({ method: 'POST', url: '/api/google-chat/auth/start',
        headers: { cookie: appCookie, origin: 'https://romek.example' }, payload: { returnPath: '/#/projects/one/import' } });
      expect(start.statusCode).toBe(200);
      const binding = String(start.headers['set-cookie']).split(';')[0];
      const state = new URL(start.json().authorizationUrl).searchParams.get('state');
      const callback = await app.inject({ url: `/api/google-chat/auth/callback?code=test-code&state=${state}`,
        headers: { cookie: `${appCookie}; ${binding}` } });
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe('/?googleChatAuth=connected#/projects/one/import');
    } finally {
      await app.close();
      vi.unstubAllGlobals();
      for (const key of ['GOOGLE_CHAT_CREDENTIALS_FILE', 'GOOGLE_CHAT_TOKEN_FILE', 'GOOGLE_CHAT_OAUTH_REDIRECT_URI']) delete process.env[key];
    }
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
