import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
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
  }));

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
