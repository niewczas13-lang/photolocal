import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const originalCwd = process.cwd();
const originalDb = process.env.PHOTO_LOCAL_DB;
const originalLog = process.env.PHOTO_LOCAL_LOG;
const originalInviteHeadless = process.env.GOOGLE_CHAT_INVITE_HEADLESS;

describe('config', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    if (originalDb == null) delete process.env.PHOTO_LOCAL_DB;
    else process.env.PHOTO_LOCAL_DB = originalDb;
    if (originalLog == null) delete process.env.PHOTO_LOCAL_LOG;
    else process.env.PHOTO_LOCAL_LOG = originalLog;
    if (originalInviteHeadless == null) delete process.env.GOOGLE_CHAT_INVITE_HEADLESS;
    else process.env.GOOGLE_CHAT_INVITE_HEADLESS = originalInviteHeadless;
  });

  it('keeps default data paths under backend regardless of current working directory', () => {
    delete process.env.PHOTO_LOCAL_DB;
    delete process.env.PHOTO_LOCAL_LOG;
    process.chdir(join(backendRoot, '..'));

    const config = loadConfig();

    expect(config.dbPath).toBe(join(backendRoot, 'data', 'photo-local.sqlite'));
    expect(config.logPath).toBe(join(backendRoot, 'logs', 'app.log'));
  });

  it('uses visible Google Chat invite browser by default', () => {
    delete process.env.GOOGLE_CHAT_INVITE_HEADLESS;

    const config = loadConfig();

    expect(config.googleChatInviteHeadless).toBe(false);
  });

  it('allows explicitly enabling headless Google Chat invite browser', () => {
    process.env.GOOGLE_CHAT_INVITE_HEADLESS = 'true';

    const config = loadConfig();

    expect(config.googleChatInviteHeadless).toBe(true);
  });

  it('uses explicit mounted Google paths and stores job state beside the database', () => {
    process.env.GOOGLE_CHAT_TOKEN_FILE = join(backendRoot, 'data', 'google', 'token.json');
    process.env.GOOGLE_CHAT_CREDENTIALS_FILE = join(backendRoot, 'data', 'google', 'client.json');
    process.env.GOOGLE_CHAT_DOWNLOAD_ROOT = join(backendRoot, 'data', 'downloads');
    process.env.GOOGLE_CHAT_OAUTH_REDIRECT_URI = 'https://romek.example/api/google-chat/auth/callback';
    process.env.PHOTO_LOCAL_DB = join(backendRoot, 'data', 'custom.sqlite');
    try {
      const config = loadConfig();
      expect(config.googleChatTokenFile).toBe(process.env.GOOGLE_CHAT_TOKEN_FILE);
      expect(config.googleChatCredentialsFile).toBe(process.env.GOOGLE_CHAT_CREDENTIALS_FILE);
      expect(config.googleChatDownloadRoot).toBe(process.env.GOOGLE_CHAT_DOWNLOAD_ROOT);
      expect(config.googleChatOAuthRedirectUri).toBe(process.env.GOOGLE_CHAT_OAUTH_REDIRECT_URI);
      expect(config.googleChatJobStateFile).toBe(join(backendRoot, 'data', 'google-chat-download.json'));
    } finally {
      for (const key of ['GOOGLE_CHAT_TOKEN_FILE', 'GOOGLE_CHAT_CREDENTIALS_FILE', 'GOOGLE_CHAT_DOWNLOAD_ROOT', 'GOOGLE_CHAT_OAUTH_REDIRECT_URI']) delete process.env[key];
    }
  });
});
