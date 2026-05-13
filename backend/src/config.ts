import { config as loadDotenv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../.env') });

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  logPath: string;
  frontendDistPath: string;
  googleChatPythonCommand: string;
  googleChatScriptPath: string;
  googleChatDownloadRoot: string;
  googleChatInviteProfileDir: string;
  googleChatInviteHeadless: boolean;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PHOTO_LOCAL_PORT ?? 4873);
  const host = process.env.PHOTO_LOCAL_HOST ?? '0.0.0.0';
  const dbPath = resolve(process.env.PHOTO_LOCAL_DB ?? './data/photo-local.sqlite');
  const logPath = resolve(process.env.PHOTO_LOCAL_LOG ?? './logs/app.log');
  const frontendDistPath = resolve(__dirname, '../../frontend/dist');
  const googleChatPythonCommand = process.env.GOOGLE_CHAT_PYTHON ?? 'python';
  const googleChatScriptPath = resolve(__dirname, '../../pobierzchat/chat.py');
  const googleChatDownloadRoot = resolve(__dirname, '../../pobierzchat/pobrane_zdjecia');
  const googleChatInviteProfileDir = process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR
    ? resolve(process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR)
    : resolve(dirname(dbPath), 'google-chat-browser-profile');
  const googleChatInviteHeadless = process.env.GOOGLE_CHAT_INVITE_HEADLESS === 'true';

  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  return {
    port,
    host,
    dbPath,
    logPath,
    frontendDistPath,
    googleChatPythonCommand,
    googleChatScriptPath,
    googleChatDownloadRoot,
    googleChatInviteProfileDir,
    googleChatInviteHeadless,
  };
}
