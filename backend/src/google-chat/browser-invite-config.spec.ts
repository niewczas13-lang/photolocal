import { describe, expect, it } from 'vitest';
import { resolveBrowserInviteConfig } from '../config.js';

describe('private invite browser configuration', () => {
  it('keeps platform fallback without sidecar and advertises Docker only with complete valid setup', () => {
    expect(resolveBrowserInviteConfig({}, 'win32').googleChatInviteMode).toBe('LEGACY_WINDOWS');
    expect(resolveBrowserInviteConfig({}, 'linux').googleChatInviteMode).toBe('LINK_ONLY');
    expect(resolveBrowserInviteConfig({ GOOGLE_CHAT_BROWSER_CDP_URL: 'http://chat-browser:9223',
      GOOGLE_CHAT_BROWSER_VNC_HOST: 'chat-browser', GOOGLE_CHAT_BROWSER_VNC_PORT: '5900',
      GOOGLE_CHAT_OAUTH_REDIRECT_URI: 'https://romek.example.test/api/google-chat/auth/callback' }, 'linux'))
      .toMatchObject({ googleChatInviteMode: 'DOCKER_BROWSER', googleChatBrowserOrigin: 'https://romek.example.test', googleChatBrowserVncPort: 5900 });
  });
  it('fails closed for missing public origin, invalid ports and credential-bearing CDP URLs', () => {
    const base = { GOOGLE_CHAT_BROWSER_CDP_URL: 'http://chat-browser:9223', GOOGLE_CHAT_OAUTH_REDIRECT_URI: 'https://romek.example.test/api/google-chat/auth/callback' };
    for (const environment of [{ ...base, GOOGLE_CHAT_OAUTH_REDIRECT_URI: '' }, { ...base, GOOGLE_CHAT_BROWSER_VNC_PORT: '0' },
      { ...base, GOOGLE_CHAT_BROWSER_CDP_URL: 'http://user:private@chat-browser:9223' }, { ...base, GOOGLE_CHAT_BROWSER_VNC_HOST: 'host/path' }]) {
      expect(() => resolveBrowserInviteConfig(environment, 'linux')).toThrow('GOOGLE_CHAT_BROWSER_CONFIGURATION_INVALID');
    }
  });
});
