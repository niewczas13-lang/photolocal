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
  googleChatCredentialsFile: string;
  googleChatTokenFile: string;
  googleChatOAuthRedirectUri: string;
  googleChatJobStateFile: string;
  googleChatInviteProfileDir: string;
  googleChatInviteHeadless: boolean;
  googleChatInviteDebugPort: number;
  googleChatInviteLauncherPath: string;
  googleChatInviteMode: 'DOCKER_BROWSER' | 'LEGACY_WINDOWS' | 'LINK_ONLY';
  googleChatBrowserCdpUrl: string | null;
  googleChatBrowserVncHost: string;
  googleChatBrowserVncPort: number;
  googleChatBrowserOrigin: string | null;
  adresyAppBaseUrl: string;
  adresyAppApiKey: string | null;
  adresyAppReverseRadiusMeters: number;
  nominatimBaseUrl: string;
  nominatimUserAgent: string;
}

export function resolveBrowserInviteConfig(environment: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Pick<AppConfig,
  'googleChatInviteMode' | 'googleChatBrowserCdpUrl' | 'googleChatBrowserVncHost' | 'googleChatBrowserVncPort' | 'googleChatBrowserOrigin'> {
  const cdpUrl = environment.GOOGLE_CHAT_BROWSER_CDP_URL?.trim() || null;
  const vncHost = environment.GOOGLE_CHAT_BROWSER_VNC_HOST?.trim() || 'chat-browser';
  const vncPort = Number(environment.GOOGLE_CHAT_BROWSER_VNC_PORT ?? 5900);
  if (!cdpUrl) return { googleChatInviteMode: platform === 'win32' ? 'LEGACY_WINDOWS' : 'LINK_ONLY',
    googleChatBrowserCdpUrl: null, googleChatBrowserVncHost: vncHost, googleChatBrowserVncPort: 5900, googleChatBrowserOrigin: null };
  try {
    const endpoint = new URL(cdpUrl);
    const publicUrl = new URL(environment.GOOGLE_CHAT_OAUTH_REDIRECT_URI ?? '');
    if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || !/^[A-Za-z0-9.-]+$/.test(vncHost) || !Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535
      || publicUrl.username || publicUrl.password || (publicUrl.protocol !== 'https:'
        && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)))) throw new Error();
    return { googleChatInviteMode: 'DOCKER_BROWSER', googleChatBrowserCdpUrl: endpoint.origin,
      googleChatBrowserVncHost: vncHost, googleChatBrowserVncPort: vncPort, googleChatBrowserOrigin: publicUrl.origin };
  } catch { throw new Error('GOOGLE_CHAT_BROWSER_CONFIGURATION_INVALID'); }
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
  const googleChatDownloadRoot = process.env.GOOGLE_CHAT_DOWNLOAD_ROOT
    ? resolve(process.env.GOOGLE_CHAT_DOWNLOAD_ROOT)
    : resolve(__dirname, '../../pobierzchat/pobrane_zdjecia');
  const googleChatCredentialsFile = process.env.GOOGLE_CHAT_CREDENTIALS_FILE
    ? resolve(process.env.GOOGLE_CHAT_CREDENTIALS_FILE)
    : resolve(__dirname, '../../pobierzchat/credentials.json');
  const googleChatTokenFile = process.env.GOOGLE_CHAT_TOKEN_FILE
    ? resolve(process.env.GOOGLE_CHAT_TOKEN_FILE)
    : resolve(__dirname, '../../pobierzchat/token.json');
  const googleChatOAuthRedirectUri = process.env.GOOGLE_CHAT_OAUTH_REDIRECT_URI?.trim() ?? '';
  const googleChatJobStateFile = process.env.GOOGLE_CHAT_JOB_STATE_FILE
    ? resolve(process.env.GOOGLE_CHAT_JOB_STATE_FILE)
    : resolve(dirname(dbPath), 'google-chat-download.json');
  const googleChatInviteProfileDir = process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR
    ? resolve(process.env.GOOGLE_CHAT_INVITE_PROFILE_DIR)
    : resolve(dirname(dbPath), 'google-chat-browser-profile');
  const googleChatInviteHeadless = process.env.GOOGLE_CHAT_INVITE_HEADLESS === 'true';
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
    ...resolveBrowserInviteConfig(),
    port,
    host,
    dbPath,
    logPath,
    frontendDistPath,
    googleChatPythonCommand,
    googleChatScriptPath,
    googleChatDownloadRoot,
    googleChatCredentialsFile,
    googleChatTokenFile,
    googleChatOAuthRedirectUri,
    googleChatJobStateFile,
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
