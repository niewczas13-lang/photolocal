import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoogleChatAuth } from './google-chat-auth.js';

const SCOPES = ['https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'photo-local-oauth-'));
  const credentialsFile = join(directory, 'credentials.json');
  const tokenFile = join(directory, 'token.json');
  writeFileSync(credentialsFile, JSON.stringify({ web: { client_id: 'test-client', client_secret: 'test-secret' } }));
  let now = Date.now();
  const fetchToken = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: SCOPES.join(' '),
  }), { status: 200 }));
  const auth = new GoogleChatAuth({ credentialsFile, tokenFile, redirectUri: 'https://romek.example/api/google-chat/auth/callback' }, { fetch: fetchToken, now: () => now });
  return { auth, credentialsFile, tokenFile, fetchToken, expire: () => { now += 11 * 60_000; } };
}

describe('Google Chat web OAuth', () => {
  it('requests offline read-only access with state and PKCE', async () => {
    const { auth } = fixture();
    const result = await auth.begin('browser-one', '/#/projects/project-one/import');
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(SCOPES);
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(30);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('requires the originating browser and rejects replay', async () => {
    const { auth, fetchToken } = fixture();
    const begin = await auth.begin('browser-one', '/#/projects/one/import');
    const state = new URL(begin.authorizationUrl).searchParams.get('state')!;
    await expect(auth.complete({ state, code: 'code', binding: 'different-browser' })).rejects.toThrow(/sesja/i);
    expect(fetchToken).not.toHaveBeenCalled();
    expect(await auth.complete({ state, code: 'code', binding: 'browser-one' })).toEqual({ returnPath: '/?googleChatAuth=connected#/projects/one/import', outcome: 'connected' });
    await expect(auth.complete({ state, code: 'code', binding: 'browser-one' })).rejects.toThrow(/sesja/i);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('expires state and does not exchange credentials after expiry', async () => {
    const { auth, fetchToken, expire } = fixture();
    const begin = await auth.begin('browser', '/');
    expire();
    await expect(auth.complete({ state: new URL(begin.authorizationUrl).searchParams.get('state')!, code: 'code', binding: 'browser' })).rejects.toThrow(/sesja/i);
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it('keeps existing credentials intact when consent is denied or exchange lacks refresh access', async () => {
    const { auth, tokenFile, fetchToken } = fixture();
    const previous = JSON.stringify({ refresh_token: 'existing-refresh' });
    writeFileSync(tokenFile, previous);
    let begin = await auth.begin('browser', '//untrusted.example/');
    expect(await auth.complete({ state: new URL(begin.authorizationUrl).searchParams.get('state')!, error: 'access_denied', binding: 'browser' })).toEqual({ returnPath: '/?googleChatAuth=denied', outcome: 'denied' });
    expect(readFileSync(tokenFile, 'utf8')).toBe(previous);
    fetchToken.mockResolvedValue(new Response(JSON.stringify({ access_token: 'incomplete', expires_in: 3600, scope: SCOPES.join(' ') })));
    begin = await auth.begin('browser', '/');
    await expect(auth.complete({ state: new URL(begin.authorizationUrl).searchParams.get('state')!, code: 'code', binding: 'browser' })).rejects.toThrow(/dostępu/i);
    expect(readFileSync(tokenFile, 'utf8')).toBe(previous);
  });

  it('saves authorized-user credentials for Python without exposing them in status', async () => {
    const { auth, tokenFile, fetchToken } = fixture();
    const begin = await auth.begin('browser', '/');
    await auth.complete({ state: new URL(begin.authorizationUrl).searchParams.get('state')!, code: 'code', binding: 'browser' });
    const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
    expect(token).toMatchObject({ token: 'test-access', refresh_token: 'test-refresh', client_id: 'test-client', client_secret: 'test-secret', token_uri: 'https://oauth2.googleapis.com/token', scopes: SCOPES });
    const status = await auth.status(false);
    expect(status).toMatchObject({ state: 'CONNECTED', canConnect: true });
    expect(JSON.stringify(status)).not.toMatch(/test-secret|test-access|test-refresh/);
    const body = fetchToken.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBeTruthy();
  });

  it('does not accept installed clients for browser callback or unsafe redirect URIs', async () => {
    const { auth, credentialsFile } = fixture();
    writeFileSync(credentialsFile, JSON.stringify({ installed: { client_id: 'installed', client_secret: 'secret' } }));
    expect(await auth.status(false)).toMatchObject({ state: 'NOT_CONFIGURED', canConnect: false });
    await expect(auth.begin('browser', '/')).rejects.toThrow(/konfiguracji/i);
    const invalid = new GoogleChatAuth({ credentialsFile, tokenFile: 'unused', redirectUri: 'http://public.example/callback' });
    await expect(invalid.begin('browser', '/')).rejects.toThrow(/konfiguracji/i);
  });
});
