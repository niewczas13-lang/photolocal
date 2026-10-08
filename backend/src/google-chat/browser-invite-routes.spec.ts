import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthGuard, registerAuthRoutes, upsertAppUser, createSession } from '../auth/app-auth.js';
import { runMigrations } from '../db/migrations.js';
import { BrowserInviteService } from './browser-invite-service.js';
import { registerBrowserInviteRoutes } from './browser-invite-routes.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const db = new Database(':memory:'); runMigrations(db);
  const a = createSession(db, upsertAppUser(db, 'browser-a', 'test-password'));
  const b = createSession(db, upsertAppUser(db, 'browser-b', 'test-password'));
  const adapter = { list: vi.fn(async () => ({ invites: [], state: 'ACTIVE' as const })), accept: vi.fn(async () => ({ spaceName: 'spaces/A' })) };
  const service = new BrowserInviteService(adapter, async () => []);
  const upstreams: Duplex[] = [];
  const written: Buffer[] = [];
  const connect = vi.fn(() => {
    const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { written.push(Buffer.from(chunk)); done(); } });
    upstreams.push(stream); queueMicrotask(() => stream.emit('connect'));
    return stream as unknown as Socket;
  });
  const app = Fastify(); await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  registerAuthRoutes(app, db); registerAuthGuard(app, db);
  registerBrowserInviteRoutes(app, db, { service, origin: 'https://romek.example.test', vncHost: 'chat-browser', vncPort: 5900, connect });
  await app.ready();
  cleanup.push(async () => { service.close(); await app.close(); db.close(); });
  const headers = { origin: 'https://romek.example.test', cookie: `photo_local_session=${a.token}` };
  return { app, db, a, b, headers, service, adapter, connect, upstreams, written };
}

describe('browser invite HTTP and websocket boundary', () => {
  it('requires a valid app cookie and exact configured Origin even with a valid bearer token', async () => {
    const f = await fixture();
    for (const headers of [{}, { authorization: `Bearer ${f.a.token}`, origin: f.headers.origin },
      { ...f.headers, origin: 'https://attacker.example.test' }, { cookie: f.headers.cookie }]) {
      const response = await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers });
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(f.connect).not.toHaveBeenCalled(); expect(f.adapter.list).not.toHaveBeenCalled();
    const good = await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers: f.headers });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ sessionId: expect.any(String), expiresAt: expect.any(String), websocketPath: expect.stringMatching(/^\/api\/google-chat\/invites\/browser\//) });
    expect(JSON.stringify(good.json())).not.toContain(f.a.token);
  });

  it('rejects another owner, cross-origin websocket upgrades and guessed leases before upstream dial', async () => {
    const f = await fixture();
    const lease = (await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers: f.headers })).json();
    await expect(f.app.injectWS(lease.websocketPath, { headers: { ...f.headers, origin: 'https://attacker.example.test' } })).rejects.toThrow();
    await expect(f.app.injectWS(lease.websocketPath, { headers: { ...f.headers, cookie: `photo_local_session=${f.b.token}` } })).rejects.toThrow();
    await expect(f.app.injectWS('/api/google-chat/invites/browser/' + 'x'.repeat(43) + '/socket', { headers: f.headers })).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('proxies only binary VNC to the fixed sidecar and logout closes the connection immediately', async () => {
    const f = await fixture();
    const lease = (await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers: f.headers })).json();
    const socket = await f.app.injectWS(lease.websocketPath, { headers: f.headers });
    expect(f.connect).toHaveBeenCalledWith({ host: 'chat-browser', port: 5900 });
    const received = once(socket, 'message');
    f.upstreams[0].push(Buffer.from('RFB 003.008\n'));
    expect((await received)[0].toString()).toBe('RFB 003.008\n');
    socket.send(Buffer.from('client-input'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(Buffer.concat(f.written).toString()).toBe('client-input');
    const closed = once(socket, 'close');
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: f.headers })).statusCode).toBe(200);
    await closed;
    expect(f.upstreams[0].destroyed).toBe(true);
    expect((await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers: f.headers })).statusCode).toBe(401);
  });

  it('socket disconnect frees the lease and subsequent DELETE is idempotent', async () => {
    const f = await fixture();
    const lease = (await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/browser/start', headers: f.headers })).json();
    const socket = await f.app.injectWS(lease.websocketPath, { headers: f.headers });
    const closed = once(socket, 'close'); socket.close(); await closed;
    const response = await f.app.inject({ method: 'DELETE', url: `/api/google-chat/invites/browser/${lease.sessionId}`, headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ released: true });
    expect((await f.app.inject({ method: 'POST', url: '/api/google-chat/invites/list', headers: f.headers })).statusCode).toBe(200);
  });
});
