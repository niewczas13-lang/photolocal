import { buildApp } from './app.js';

const { app, config } = await buildApp();

await app.listen({ port: config.port, host: '127.0.0.1' });
