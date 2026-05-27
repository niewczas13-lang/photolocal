import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

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

    await app.close();

    expect(blocked.statusCode).toBe(401);
    expect(badLogin.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { username: 'aniela' } });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(32);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual([]);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: 'aniela' } });
  });
});

