import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { observeSessionDeletion, readAuthenticatedCookieSession } from '../auth/app-auth.js';
import { BrowserInviteError, BrowserInviteService } from './browser-invite-service.js';

const ownerId = (token: string) => createHash('sha256').update(token).digest('hex');
interface BrowserInviteRouteOptions {
  service: BrowserInviteService; origin: string; vncHost: string; vncPort: number;
  connect?: (options: { host: string; port: number }) => Socket;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof BrowserInviteError) return reply.status(error.statusCode).send({ code: error.code, error: error.message });
  return reply.status(502).send({ code: 'BROWSER_UNAVAILABLE', error: 'Nie udało się obsłużyć przeglądarki Google. Spróbuj ponownie.' });
}

export function registerBrowserInviteRoutes(app: FastifyInstance, db: Database.Database, options: BrowserInviteRouteOptions): void {
  const { service } = options;
  const sessions = new WeakMap<FastifyRequest, string>();
  const unsubscribe = observeSessionDeletion(db, token => service.releaseOwner(ownerId(token)));
  app.addHook('preClose', async () => { service.close(); });
  app.addHook('onClose', async () => { unsubscribe(); service.close(); });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const session = readAuthenticatedCookieSession(db, request);
    if (!session) return reply.status(401).send({ code: 'APP_COOKIE_REQUIRED', error: 'Zaloguj się ponownie do aplikacji.' });
    if (request.headers.origin !== options.origin) {
      return reply.status(403).send({ code: 'BROWSER_ORIGIN_REJECTED', error: 'Otwórz logowanie Google z właściwego adresu aplikacji.' });
    }
    sessions.set(request, ownerId(session.token));
  };
  const owner = (request: FastifyRequest) => sessions.get(request)!;
  const sessionId = (request: FastifyRequest): string => {
    const id = (request.params as { sessionId?: unknown }).sessionId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw new BrowserInviteError('BROWSER_SESSION_INVALID', 'Nieprawidłowa sesja przeglądarki.', 400);
    }
    return id;
  };

  app.post('/api/google-chat/invites/browser/start', { preValidation: authenticate, logLevel: 'silent' }, async (request, reply) => {
    try { return service.startLogin(owner(request)); } catch (error) { return sendError(reply, error); }
  });
  app.delete('/api/google-chat/invites/browser/:sessionId', { preValidation: authenticate, logLevel: 'silent' }, async (request, reply) => {
    try { service.releaseLogin(owner(request), sessionId(request)); return { released: true }; }
    catch (error) { return sendError(reply, error); }
  });
  app.post('/api/google-chat/invites/list', { preValidation: authenticate }, async (request, reply) => {
    try { return await service.list(owner(request)); } catch (error) { return sendError(reply, error); }
  });
  app.post('/api/google-chat/invites/accept', { preValidation: authenticate }, async (request, reply) => {
    const body = request.body as { inviteKey?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.inviteKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.inviteKey)) {
      return reply.status(400).send({ code: 'INVITE_KEY_INVALID', error: 'Wybierz zaproszenie z odświeżonej listy.' });
    }
    try { return await service.accept(owner(request), body.inviteKey); } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/google-chat/invites/browser/:sessionId/socket', {
    websocket: true, logLevel: 'silent', preValidation: [authenticate, async (request, reply) => {
      try { service.assertLogin(owner(request), sessionId(request)); } catch (error) { return sendError(reply, error); }
    }],
  }, (socket, request) => {
    const id = sessionId(request);
    const leaseOwner = owner(request);
    let upstream: Socket | null = null;
    let finished = false;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimer); clearInterval(sessionTimer);
      upstream?.destroy();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Session closed');
      try { service.releaseLogin(leaseOwner, id); } catch { /* A newer lease belongs to another connection. */ }
    };
    try { service.claimLogin(leaseOwner, id, finish); }
    catch { socket.close(1008, 'Session unavailable'); return; }

    // Attach synchronously: no initial VNC handshake bytes may be lost during asynchronous setup.
    socket.on('message', (data: RawData, binary: boolean) => {
      if (!binary || !upstream || finished) { finish(); return; }
      const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      if (bytes.length > 1024 * 1024 || upstream.writableLength > 4 * 1024 * 1024) { finish(); return; }
      if (!upstream.write(bytes)) socket.pause();
    });
    socket.on('close', finish); socket.on('error', finish);
    try {
      upstream = (options.connect ?? connectTcp)({ host: options.vncHost, port: options.vncPort });
      connectionTimer = setTimeout(finish, 5_000); connectionTimer.unref();
      upstream.on('connect', () => { clearTimeout(connectionTimer); });
      upstream.on('drain', () => { if (!finished) socket.resume(); });
      upstream.on('data', (bytes: Buffer) => {
        if (finished || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4 * 1024 * 1024) { finish(); return; }
        socket.send(bytes, { binary: true }, error => { if (error) finish(); });
      });
      upstream.on('error', finish); upstream.on('end', finish); upstream.on('close', finish);
      sessionTimer = setInterval(() => {
        try {
          const session = readAuthenticatedCookieSession(db, request);
          if (!session || ownerId(session.token) !== leaseOwner) finish();
        } catch { finish(); }
      }, 5_000);
      sessionTimer.unref();
    } catch { finish(); }
  });
}
