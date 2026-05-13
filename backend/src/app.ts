import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { pickWindowsFolder } from './filesystem/native-folder-picker.js';
import { acceptChatInvite, listChatInvites, openChatInvitesSetup } from './google-chat/chat-invites.js';
import { registerProjectRoutes } from './projects/projects-routes.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  runMigrations(db);

  await app.register(multipart, {
    limits: {
      fileSize: 250 * 1024 * 1024,
      files: 100,
    },
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({
    googleChatDownloadRoot: config.googleChatDownloadRoot,
    googleChatInviteProfileDir: config.googleChatInviteProfileDir,
  }));
  app.post('/api/folders/pick', async (request, reply) => {
    const { initialPath } = (request.body ?? {}) as { initialPath?: string };

    try {
      return await pickWindowsFolder(initialPath);
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Unable to pick folder',
      });
    }
  });

  app.post('/api/google-chat/invites/list', async (request, reply) => {
    const body = (request.body ?? {}) as { whitelist?: string };
    try {
      return await listChatInvites({
        config: {
          profileDir: config.googleChatInviteProfileDir,
          headless: config.googleChatInviteHeadless,
        },
        whitelist: body.whitelist ?? '',
      });
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Unable to load Google Chat invites',
      });
    }
  });

  app.post('/api/google-chat/invites/setup', async (_request, reply) => {
    try {
      return await openChatInvitesSetup({
        config: {
          profileDir: config.googleChatInviteProfileDir,
          headless: false,
        },
      });
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Unable to open Google Chat invite setup',
      });
    }
  });

  app.post('/api/google-chat/invites/accept', async (request, reply) => {
    const body = (request.body ?? {}) as { whitelist?: string; inviteKey?: string };
    if (!body.inviteKey) return reply.status(400).send({ error: 'inviteKey is required' });

    try {
      return await acceptChatInvite({
        config: {
          profileDir: config.googleChatInviteProfileDir,
          headless: config.googleChatInviteHeadless,
        },
        whitelist: body.whitelist ?? '',
        inviteKey: body.inviteKey,
      });
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Unable to accept Google Chat invite',
      });
    }
  });

  await registerProjectRoutes(app, db);

  if (existsSync(config.frontendDistPath)) {
    await app.register(fastifyStatic, {
      root: config.frontendDistPath,
      prefix: '/',
    });
  }

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, config, db };
}
