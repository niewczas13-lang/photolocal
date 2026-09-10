import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getAuthToken } from './api';

describe('Google Chat API authentication', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.set('photo-local-auth-token', 'app-session');
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it('retains the Google reconnect error code and the PhotoLocal session', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 'GOOGLE_AUTH_REQUIRED', error: 'Połącz ponownie Google',
    }), { status: 409 }));

    await expect(api.listGoogleChatSpaces()).rejects.toMatchObject({
      status: 409, code: 'GOOGLE_AUTH_REQUIRED', message: 'Połącz ponownie Google',
    });
    expect(getAuthToken()).toBe('app-session');
  });

  it('still removes an invalid PhotoLocal session on HTTP 401', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"Unauthorized"}', { status: 401 }));
    await expect(api.getCurrentUser()).rejects.toThrow('Unauthorized');
    expect(getAuthToken()).toBeNull();
  });

  it('sends the current hash route when starting the Google connection', async () => {
    let receivedUrl = '';
    let receivedBody: unknown;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      receivedUrl = url;
      receivedBody = JSON.parse(String(init.body));
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer app-session');
      return new Response('{"authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth"}');
    });
    await api.startGoogleChatAuth('/#/projects/project-1/import');
    expect(receivedUrl).toBe('/api/google-chat/auth/start');
    expect(receivedBody).toEqual({ returnPath: '/#/projects/project-1/import' });
  });

  it('resumes the saved project job without a new space selection', async () => {
    let receivedUrl = '';
    let receivedMethod: string | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      receivedUrl = url;
      receivedMethod = init.method;
      return new Response('{"state":"RUNNING"}');
    });
    await expect(api.resumeGoogleChatDownload('project-1')).resolves.toEqual({ state: 'RUNNING' });
    expect(receivedUrl).toBe('/api/projects/project-1/google-chat/download/resume');
    expect(receivedMethod).toBe('POST');
  });

  it('actively verifies a replaced legacy Google token through the check endpoint', async () => {
    let receivedUrl = '';
    let receivedMethod: string | undefined;
    const signal = new AbortController().signal;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      receivedUrl = url;
      receivedMethod = init.method;
      expect(init.signal).toBe(signal);
      return new Response(JSON.stringify({
        state: 'CONNECTED', canConnect: false,
        message: 'Google połączone', inviteMode: 'WINDOWS_BROWSER',
      }));
    });

    await expect(api.checkGoogleChatAuth(signal)).resolves.toMatchObject({ state: 'CONNECTED' });
    expect(receivedUrl).toBe('/api/google-chat/auth/check');
    expect(receivedMethod).toBe('POST');
  });
});
