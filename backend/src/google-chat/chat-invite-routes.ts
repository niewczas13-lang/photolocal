import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { acceptChatInvite, listChatInvites, openChatInvitesSetup } from './chat-invites.js';
import { DockerBrowserInviteAdapter } from './browser-invite-adapter.js';
import { BrowserInviteService } from './browser-invite-service.js';
import { registerBrowserInviteRoutes } from './browser-invite-routes.js';

export function registerChatInviteRoutes(app: FastifyInstance, db: Database.Database, config: AppConfig,
  manager: { listSpaces(signal?: AbortSignal): Promise<Array<{ name: string }>> }): void {
  if (config.googleChatInviteMode === 'DOCKER_BROWSER') {
    const service = new BrowserInviteService(new DockerBrowserInviteAdapter(config.googleChatBrowserCdpUrl!), signal => manager.listSpaces(signal));
    registerBrowserInviteRoutes(app, db, { service, origin: config.googleChatBrowserOrigin!,
      vncHost: config.googleChatBrowserVncHost, vncPort: config.googleChatBrowserVncPort });
    return;
  }
  const browserConfig = { profileDir: config.googleChatInviteProfileDir, headless: config.googleChatInviteHeadless,
    debugPort: config.googleChatInviteDebugPort, launcherPath: config.googleChatInviteLauncherPath };
  app.post('/api/google-chat/invites/list', async (_request, reply) => {
    try { return await listChatInvites({ config: browserConfig }); }
    catch (error) { return reply.status(500).send({ error: error instanceof Error ? error.message : 'Unable to load Google Chat invites' }); }
  });
  app.post('/api/google-chat/invites/setup', async (_request, reply) => {
    try { return await openChatInvitesSetup({ config: { ...browserConfig, headless: false } }); }
    catch (error) { return reply.status(500).send({ error: error instanceof Error ? error.message : 'Unable to open Google Chat invite setup' }); }
  });
  app.post('/api/google-chat/invites/accept', async (request, reply) => {
    const body = (request.body ?? {}) as { inviteKey?: unknown };
    if (typeof body.inviteKey !== 'string' || !body.inviteKey || body.inviteKey.length > 128) return reply.status(400).send({ error: 'inviteKey is required' });
    try { return await acceptChatInvite({ config: browserConfig, inviteKey: body.inviteKey }); }
    catch (error) { return reply.status(500).send({ error: error instanceof Error ? error.message : 'Unable to accept Google Chat invite' }); }
  });
}
