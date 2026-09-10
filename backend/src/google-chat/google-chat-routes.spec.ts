import Fastify from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoogleChatAuth } from './google-chat-auth.js';
import { GoogleChatDownloadManager, type GoogleChatProcessRunner } from './google-chat-downloader.js';
import { GoogleChatOperationQueue } from './google-chat-files.js';
import { registerGoogleChatRoutes } from './google-chat-routes.js';

function fixture(runner: GoogleChatProcessRunner = async () => ({ code: 0, stdout: '[]', stderr: '' })) {
  const root = mkdtempSync(join(tmpdir(), 'photo-local-google-routes-'));
  const config = { credentialsFile: join(root, 'credentials.json'), tokenFile: join(root, 'token.json'),
    redirectUri: 'https://romek.example/api/google-chat/auth/callback' };
  writeFileSync(config.credentialsFile, JSON.stringify({ web: { client_id: 'client', client_secret: 'secret' } }));
  const auth = new GoogleChatAuth(config, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly',
  }))) });
  const queue = new GoogleChatOperationQueue();
  const manager = new GoogleChatDownloadManager({ ...config, pythonCommand: 'python', scriptPath: join(root, 'chat.py'),
    downloadRoot: join(root, 'downloads'), stateFile: join(root, 'job.json') }, queue, runner);
  const app = Fastify({ logger: false });
  registerGoogleChatRoutes(app, { getProject: (id) => id === 'project' ? { id } : null,
    assignGoogleChatSpace: vi.fn() }, auth, manager);
  return { app, auth, manager };
}

describe('Google Chat routes', () => {
  it('uses an HttpOnly same-browser cookie and returns to the saved hash route', async () => {
    const { app } = fixture();
    try {
      const start = await app.inject({ method: 'POST', url: '/api/google-chat/auth/start',
        headers: { origin: 'https://romek.example' }, payload: { returnPath: '/#/projects/project/import' } });
      expect(start.statusCode).toBe(200);
      const cookie = String(start.headers['set-cookie']);
      expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Lax/); expect(cookie).toMatch(/Secure/);
      const state = new URL(start.json().authorizationUrl).searchParams.get('state');
      const callback = await app.inject({ url: `/api/google-chat/auth/callback?state=${state}&code=authorization-code`,
        headers: { cookie: cookie.split(';')[0] } });
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe('/?googleChatAuth=connected#/projects/project/import');
      expect(callback.body).not.toContain('access');
      const status = await app.inject('/api/google-chat/auth/status');
      expect(status.json()).toMatchObject({ state: 'CONNECTED', canConnect: true });
    } finally { await app.close(); }
  });

  it('rejects cross-origin connection attempts and invalid return input', async () => {
    const { app } = fixture();
    try {
      const crossOrigin = await app.inject({ method: 'POST', url: '/api/google-chat/auth/start', headers: { origin: 'https://untrusted.example' }, payload: {} });
      expect(crossOrigin.statusCode).toBe(403);
      const badInput = await app.inject({ method: 'POST', url: '/api/google-chat/auth/start', payload: { returnPath: 1 } });
      expect(badInput.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('reports Google authorization loss without logging out of PhotoLocal', async () => {
    const { app } = fixture(async () => ({ code: 3, stdout: '', stderr: 'PHOTO_LOCAL_AUTH_REQUIRED secret-token' }));
    try {
      const result = await app.inject('/api/google-chat/spaces');
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ code: 'GOOGLE_AUTH_REQUIRED' });
      expect(result.body).not.toContain('secret-token');
    } finally { await app.close(); }
  });

  it('validates the project and space before launching a job', async () => {
    const runner = vi.fn<GoogleChatProcessRunner>();
    const { app } = fixture(runner);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/projects/missing/google-chat/download', payload: { spaceName: 'spaces/one' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/projects/project/google-chat/download', payload: { spaceName: ['spaces/one'] } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/projects/project/google-chat/download', payload: { spaceName: '../../escape' } })).statusCode).toBe(400);
      expect(runner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('verifies replacement legacy credentials and makes an authorization-paused job resumable', async () => {
    const runner = vi.fn<GoogleChatProcessRunner>()
      .mockResolvedValueOnce({ code: 3, stdout: '', stderr: 'PHOTO_LOCAL_AUTH_REQUIRED' })
      .mockResolvedValueOnce({ code: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const { app, manager, auth } = fixture(runner);
    try {
      manager.start({ projectId: 'project', spaceName: 'spaces/one', spaceDisplayName: 'One' });
      await manager.waitForIdle();
      writeFileSync(auth.config.tokenFile, JSON.stringify({ refresh_token: 'replacement-legacy-grant' }));
      writeFileSync(auth.config.credentialsFile, JSON.stringify({ installed: { client_id: 'legacy' } }));
      const checked = await app.inject({ method: 'POST', url: '/api/google-chat/auth/check' });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ state: 'CONNECTED', canConnect: false });
      expect(manager.getStatus().state).toBe('PAUSED');
      const resumed = await app.inject({ method: 'POST', url: '/api/projects/project/google-chat/download/resume' });
      expect(resumed.statusCode).toBe(202);
      await manager.waitForIdle();
      expect(manager.getStatus().state).toBe('COMPLETED');
    } finally { await app.close(); }
  });
});
