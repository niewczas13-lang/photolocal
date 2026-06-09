import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { registerAuthGuard, registerAuthRoutes } from './auth/app-auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { pickWindowsFolder } from './filesystem/native-folder-picker.js';
import {
  createSharedFolder,
  listSharedFolderChildren,
  listSharedFolderRoots,
} from './filesystem/shared-folder-browser.js';
import { acceptChatInvite, listChatInvites, openChatInvitesSetup } from './google-chat/chat-invites.js';
import { registerProjectRoutes } from './projects/projects-routes.js';

function shouldEnableAuth(): boolean {
  if (process.env.PHOTO_LOCAL_AUTH === 'enabled') return true;
  if (process.env.PHOTO_LOCAL_AUTH === 'disabled') return false;
  return process.env.NODE_ENV !== 'test';
}

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

  registerAuthRoutes(app, db);
  if (shouldEnableAuth()) registerAuthGuard(app, db);

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

  app.get('/api/shared-folders/roots', async (_request, reply) => {
    try {
      return { roots: await listSharedFolderRoots() };
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Unable to list shared folders',
      });
    }
  });

  app.post('/api/shared-folders/list', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) return reply.status(400).send({ error: 'path is required' });

    try {
      return await listSharedFolderChildren(body.path);
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Unable to list folder',
      });
    }
  });

  app.post('/api/shared-folders/create', async (request, reply) => {
    const body = (request.body ?? {}) as { parentPath?: string; folderName?: string };
    if (!body.parentPath) return reply.status(400).send({ error: 'parentPath is required' });
    if (!body.folderName) return reply.status(400).send({ error: 'folderName is required' });

    try {
      return await createSharedFolder(body.parentPath, body.folderName);
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Unable to create folder',
      });
    }
  });

  app.post('/api/google-chat/invites/list', async (_request, reply) => {
    try {
      return await listChatInvites({
        config: {
          profileDir: config.googleChatInviteProfileDir,
          headless: config.googleChatInviteHeadless,
          debugPort: config.googleChatInviteDebugPort,
        },
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
          debugPort: config.googleChatInviteDebugPort,
        },
      });
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Unable to open Google Chat invite setup',
      });
    }
  });

  app.post('/api/google-chat/invites/accept', async (request, reply) => {
    const body = (request.body ?? {}) as { inviteKey?: string };
    if (!body.inviteKey) return reply.status(400).send({ error: 'inviteKey is required' });

    try {
      return await acceptChatInvite({
        config: {
          profileDir: config.googleChatInviteProfileDir,
          headless: config.googleChatInviteHeadless,
          debugPort: config.googleChatInviteDebugPort,
        },
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
