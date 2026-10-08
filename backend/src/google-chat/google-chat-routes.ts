import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { GoogleChatAuth } from './google-chat-auth.js';
import { GoogleChatDownloadManager, GoogleChatRequestError } from './google-chat-downloader.js';

const COOKIE_NAME = 'photo_local_google_oauth';
interface GoogleChatProjects {
  getProject(id: string): unknown;
  assignGoogleChatSpace(id: string, input: { spaceName: string; spaceDisplayName: string; lastDownloadAt: string }): unknown;
}

function bindingCookie(request: FastifyRequest): string {
  return (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? '';
}

function cookie(value: string, secure: boolean, clear = false): string {
  return `${COOKIE_NAME}=${value}; Path=/api/google-chat/auth; Max-Age=${clear ? 0 : 600}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof GoogleChatRequestError) {
    return reply.status(error.code === 'GOOGLE_AUTH_REQUIRED' ? 409 : 502).send({ code: error.code, error: error.message });
  }
  return reply.status(409).send({ error: error instanceof Error ? error.message : 'Nie udało się wykonać operacji Google Chat.' });
}

export function registerGoogleChatRoutes(app: FastifyInstance, projects: GoogleChatProjects,
  auth: GoogleChatAuth, manager: GoogleChatDownloadManager): void {
  app.addHook('onClose', async () => { await manager.close(); });

  app.get('/api/google-chat/auth/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await auth.status(manager.isAuthRequired()); }
    catch { return reply.status(503).send({ error: 'Nie można odczytać konfiguracji Google na serwerze.' }); }
  });

  app.post('/api/google-chat/auth/check', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (manager.isRunning()) return reply.status(409).send({ error: 'Poczekaj na zakończenie pobierania przed sprawdzeniem połączenia.' });
    try {
      await manager.listSpaces();
      return await auth.status(manager.isAuthRequired());
    } catch (error) {
      if (error instanceof GoogleChatRequestError && error.code === 'GOOGLE_AUTH_REQUIRED') {
        return auth.status(true);
      }
      return reply.status(502).send({ error: 'Nie udało się sprawdzić dostępu do Google. Spróbuj ponownie.' });
    }
  });

  app.post('/api/google-chat/auth/start', async (request, reply) => {
    const body = (request.body ?? {}) as { returnPath?: unknown };
    if (typeof body !== 'object' || Array.isArray(body)
      || (body.returnPath !== undefined && (typeof body.returnPath !== 'string' || body.returnPath.length > 2048))) {
      return reply.status(400).send({ error: 'Nieprawidłowy adres powrotu.' });
    }
    if (manager.isRunning()) return reply.status(409).send({ error: 'Poczekaj na zakończenie pobierania przed zmianą konta Google.' });
    try {
      const configured = await auth.status(manager.isAuthRequired());
      if (!configured.canConnect) return reply.status(409).send({ error: configured.message });
      const origin = new URL(auth.config.redirectUri).origin;
      if (request.headers.origin && request.headers.origin !== origin) {
        return reply.status(403).send({ error: `Otwórz aplikację pod adresem ${origin}, aby połączyć Google.` });
      }
      const binding = randomBytes(32).toString('base64url');
      const result = await auth.begin(binding, typeof body.returnPath === 'string' ? body.returnPath : '/');
      reply.header('Cache-Control', 'no-store');
      reply.header('Set-Cookie', cookie(binding, auth.config.redirectUri.startsWith('https:')));
      return result;
    } catch { return reply.status(409).send({ error: 'Nie udało się rozpocząć logowania Google. Sprawdź konfigurację serwera.' }); }
  });

  app.get('/api/google-chat/auth/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const query = request.query as Record<string, unknown>;
    if (typeof query.state !== 'string' || query.state.length > 200
      || (query.code !== undefined && typeof query.code !== 'string')
      || (query.error !== undefined && typeof query.error !== 'string')) {
      return reply.status(400).send({ error: 'Nieprawidłowy powrót z logowania Google.' });
    }
    try {
      const result = await manager.queue.run(async () => {
        const result = await auth.complete({ state: query.state as string, code: query.code as string | undefined,
          error: query.error as string | undefined, binding: bindingCookie(request) });
        if (result.outcome === 'connected') manager.markConnected();
        return result;
      });
      reply.header('Set-Cookie', cookie('', auth.config.redirectUri.startsWith('https:'), true));
      return reply.redirect(result.returnPath, 303);
    } catch {
      reply.header('Set-Cookie', cookie('', auth.config.redirectUri.startsWith('https:'), true));
      return reply.redirect('/?googleChatAuth=failed', 303);
    }
  });

  app.get('/api/google-chat/spaces', async (_request, reply) => {
    try { return await manager.listSpaces(); } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/projects/:projectId/google-chat/download/status', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProject(projectId)) return reply.status(404).send({ error: 'Project not found' });
    return manager.getStatus(projectId);
  });

  app.post('/api/projects/:projectId/google-chat/download', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProject(projectId)) return reply.status(404).send({ error: 'Project not found' });
    const body = request.body as { spaceName?: unknown; spaceDisplayName?: unknown } | null;
    if (!body || typeof body.spaceName !== 'string' || !/^spaces\/[A-Za-z0-9_-]+$/.test(body.spaceName.trim())
      || (body.spaceDisplayName !== undefined && typeof body.spaceDisplayName !== 'string')
      || (typeof body.spaceDisplayName === 'string' && body.spaceDisplayName.length > 500)) {
      return reply.status(400).send({ error: 'Nieprawidłowy czat.' });
    }
    if (auth.hasPending()) return reply.status(409).send({ error: 'Dokończ logowanie Google przed rozpoczęciem pobierania.' });
    try {
      const spaceName = body.spaceName.trim();
      const spaceDisplayName = typeof body.spaceDisplayName === 'string' ? body.spaceDisplayName.trim() || spaceName : spaceName;
      const result = manager.start({ projectId, spaceName, spaceDisplayName });
      projects.assignGoogleChatSpace(projectId, { spaceName, spaceDisplayName, lastDownloadAt: result.startedAt ?? new Date().toISOString() });
      return reply.status(202).send(result);
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/projects/:projectId/google-chat/download/resume', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProject(projectId)) return reply.status(404).send({ error: 'Project not found' });
    if (auth.hasPending()) return reply.status(409).send({ error: 'Dokończ logowanie Google przed wznowieniem pobierania.' });
    try { return reply.status(202).send(manager.resume(projectId)); }
    catch (error) { return sendError(reply, error); }
  });
}
