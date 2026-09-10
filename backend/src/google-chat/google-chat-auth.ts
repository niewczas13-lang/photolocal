import { createHash, randomBytes } from 'node:crypto';
import { readJsonObject, writeJsonAtomic } from './google-chat-files.js';

const SCOPES = [
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_LIFETIME_MS = 10 * 60_000;

export interface GoogleChatAuthConfig {
  credentialsFile: string;
  tokenFile: string;
  redirectUri: string;
}

interface WebClient { clientId: string; clientSecret: string; }
interface PendingAuthorization {
  bindingHash: string;
  verifier: string;
  returnPath: string;
  expiresAt: number;
  client: WebClient;
}

export interface GoogleChatConnectionStatus {
  state: 'CONNECTED' | 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'NOT_CONFIGURED';
  canConnect: boolean;
  message: string;
  inviteMode: 'WINDOWS_BROWSER' | 'GOOGLE_CHAT_LINK';
}

interface AuthorizationResult { returnPath: string; outcome: 'connected' | 'denied'; }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function safeReturnPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) return '/';
  const url = new URL(path, 'https://photolocal.invalid');
  if (url.origin !== 'https://photolocal.invalid' || url.pathname.startsWith('/api/')) return '/';
  for (const key of ['code', 'state', 'error', 'googleChatAuth']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

function resultPath(path: string, result: string): string {
  const url = new URL(path, 'https://photolocal.invalid');
  url.searchParams.set('googleChatAuth', result);
  return `${url.pathname}${url.search}${url.hash}`;
}

export class GoogleChatAuth {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly fetchToken: typeof fetch;
  private readonly now: () => number;

  constructor(readonly config: GoogleChatAuthConfig, dependencies: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetchToken = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  private readClient(): WebClient | null {
    let redirect: URL;
    try { redirect = new URL(this.config.redirectUri); } catch { return null; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
    if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback))
      || redirect.username || redirect.password || redirect.hash || redirect.search
      || redirect.pathname !== '/api/google-chat/auth/callback') return null;
    const document = readJsonObject(this.config.credentialsFile);
    if (!document?.web || typeof document.web !== 'object') return null;
    const web = document.web as Record<string, unknown>;
    return typeof web.client_id === 'string' && web.client_id.trim()
      && typeof web.client_secret === 'string' && web.client_secret.trim()
      ? { clientId: web.client_id, clientSecret: web.client_secret } : null;
  }

  hasPending(): boolean {
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= this.now()) this.pending.delete(state);
    }
    return this.pending.size > 0;
  }

  async status(authRequired: boolean): Promise<GoogleChatConnectionStatus> {
    const canConnect = Boolean(this.readClient());
    const token = readJsonObject(this.config.tokenFile);
    const connected = typeof token?.refresh_token === 'string' && token.refresh_token.length > 0;
    const state = authRequired ? 'AUTH_REQUIRED' : connected ? 'CONNECTED'
      : canConnect ? 'NOT_CONNECTED' : 'NOT_CONFIGURED';
    const messages: Record<GoogleChatConnectionStatus['state'], string> = {
      CONNECTED: 'Zapisano połączenie Google do pobierania zdjęć.',
      AUTH_REQUIRED: 'Google wymaga ponownego połączenia konta. Pobrane zdjęcia pozostają zapisane.',
      NOT_CONNECTED: 'Połącz konto Google, aby wyświetlać czaty i pobierać zdjęcia.',
      NOT_CONFIGURED: 'Logowanie Google przez aplikację wymaga konfiguracji na serwerze.',
    };
    return { state, canConnect, message: messages[state], inviteMode: process.platform === 'win32' ? 'WINDOWS_BROWSER' : 'GOOGLE_CHAT_LINK' };
  }

  async begin(binding: string, returnPath: string): Promise<{ authorizationUrl: string }> {
    const client = this.readClient();
    if (!client) throw new Error('Brak konfiguracji internetowego logowania Google na serwerze.');
    if (!binding) throw new Error('Nieprawidłowa sesja logowania Google.');
    this.hasPending();
    if (this.pending.size >= 50) throw new Error('Zbyt wiele rozpoczętych logowań. Spróbuj później.');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { client, bindingHash: digest(binding), verifier,
      returnPath: safeReturnPath(returnPath), expiresAt: this.now() + STATE_LIFETIME_MS });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: this.config.redirectUri,
      response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline',
      prompt: 'consent select_account', state, code_challenge: digest(verifier),
      code_challenge_method: 'S256' }).toString();
    return { authorizationUrl: url.toString() };
  }

  async complete(input: { state: string; code?: string; error?: string; binding: string }): Promise<AuthorizationResult> {
    this.hasPending();
    const pending = this.pending.get(input.state);
    if (!pending || !input.binding || pending.bindingHash !== digest(input.binding)) {
      throw new Error('Sesja logowania Google wygasła lub jest nieprawidłowa. Połącz konto ponownie.');
    }
    this.pending.delete(input.state);
    if (input.error) return { returnPath: resultPath(pending.returnPath, 'denied'), outcome: 'denied' };
    if (!input.code || input.code.length > 4096) throw new Error('Brak poprawnego kodu logowania Google.');
    let response: Response;
    try {
      response = await this.fetchToken(TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: input.code, client_id: pending.client.clientId,
          client_secret: pending.client.clientSecret, redirect_uri: this.config.redirectUri,
          grant_type: 'authorization_code', code_verifier: pending.verifier }) });
    } catch { throw new Error('Nie udało się połączyć z Google. Spróbuj ponownie.'); }
    if (!response.ok) throw new Error('Google odrzuciło logowanie. Połącz konto ponownie.');
    let token: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      token = parsed as Record<string, unknown>;
    } catch { throw new Error('Google zwróciło nieprawidłową odpowiedź logowania.'); }
    const scopes = typeof token.scope === 'string' ? token.scope.split(' ') : [];
    if (typeof token.access_token !== 'string' || !token.access_token
      || typeof token.refresh_token !== 'string' || !token.refresh_token
      || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
      || !SCOPES.every((scope) => scopes.includes(scope))) {
      throw new Error('Nie przyznano pełnego dostępu do pobierania zdjęć. Połącz konto i zaakceptuj wymagane uprawnienia.');
    }
    // Never combine a new access token with a different account's old refresh grant.
    writeJsonAtomic(this.config.tokenFile, { token: token.access_token, refresh_token: token.refresh_token,
      token_uri: TOKEN_URL, client_id: pending.client.clientId, client_secret: pending.client.clientSecret,
      scopes: SCOPES, expiry: new Date(this.now() + token.expires_in * 1000).toISOString() });
    return { returnPath: resultPath(pending.returnPath, 'connected'), outcome: 'connected' };
  }
}
