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
  googleChatInviteDebugPort: number;
  googleChatInviteLauncherPath: string;
  adresyAppBaseUrl: string;
  adresyAppApiKey: string | null;
  adresyAppReverseRadiusMeters: number;
  nominatimBaseUrl: string;
  nominatimUserAgent: string;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PHOTO_LOCAL_PORT ?? 4873);
  const host = process.env.PHOTO_LOCAL_HOST ?? '0.0.0.0';
  const defaultDbPath = resolve(__dirname, '../data/photo-local.sqlite');
  const defaultLogPath = resolve(__dirname, '../logs/app.log');
  const dbPath = process.env.PHOTO_LOCAL_DB ? resolve(process.env.PHOTO_LOCAL_DB) : defaultDbPath;
  const logPath = process.env.PHOTO_LOCAL_LOG ? resolve(process.env.PHOTO_LOCAL_LOG) : defaultLogPath;
  const frontendDistPath = resolve(__dirname, '../../frontend/dist');
  const googleChatPythonCommand = process.env.GOOGLE_CHAT_PYTHON ?? 'python';
  const googleChatScriptPath = resolve(__dirname, '../../pobierzchat/chat.py');
  const googleChatDownloadRoot = resolve(__dirname, '../../pobierzchat/pobrane_zdjecia');
  const googleChatInviteProfileDir = process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR
    ? resolve(process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR)
    : resolve(dirname(dbPath), 'google-chat-browser-profile');
  const googleChatInviteHeadless = process.env.GOOGLE_CHAT_INVITE_HEADLESS !== 'false';
  const rawGoogleChatInviteDebugPort = Number(process.env.GOOGLE_CHAT_INVITE_DEBUG_PORT ?? 9222);
  const googleChatInviteDebugPort =
    Number.isFinite(rawGoogleChatInviteDebugPort) && rawGoogleChatInviteDebugPort > 0
      ? Math.floor(rawGoogleChatInviteDebugPort)
      : 9222;
  const googleChatInviteLauncherPath = resolve(__dirname, '../../otworz-logowanie-google-chat.bat');
  const adresyAppBaseUrl = process.env.ADRESY_APP_BASE_URL ?? 'https://api.adresy.app/api/v1';
  const adresyAppApiKey = process.env.ADRESY_APP_API_KEY?.trim() || null;
  const adresyAppReverseRadiusMeters = Math.max(1, Number(process.env.ADRESY_APP_REVERSE_RADIUS_METERS ?? 200));
  const nominatimBaseUrl = process.env.NOMINATIM_BASE_URL ?? 'https://nominatim.openstreetmap.org';
  const nominatimUserAgent =
    process.env.NOMINATIM_USER_AGENT?.trim() || 'PhotoLocal/0.1 (local reverse geocoding)';

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
    googleChatInviteDebugPort,
    googleChatInviteLauncherPath,
    adresyAppBaseUrl,
    adresyAppApiKey,
    adresyAppReverseRadiusMeters,
    nominatimBaseUrl,
    nominatimUserAgent,
  };
}
