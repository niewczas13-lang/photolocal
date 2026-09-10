import { buildApp } from './app.js';

const { app, config } = await buildApp();

await app.listen({ port: config.port, host: config.host });

let isClosing = false;
const shutdown = async (): Promise<void> => {
  if (isClosing) return;
  isClosing = true;
  try {
    await app.close();
  } catch {
    app.log.error('Nie udało się poprawnie zatrzymać serwera.');
    process.exitCode = 1;
  }
};
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
