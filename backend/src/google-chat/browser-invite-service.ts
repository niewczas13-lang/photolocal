import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GOOGLE_CHAT_INVITES_URL, type ChatInviteSessionState } from './chat-invites.js';

export interface BrowserInviteTarget {
  fingerprint: string;
  roomName: string | null;
  senderEmail: string | null;
  textPreview: string;
  spaceName: string | null;
  canAccept: boolean;
  reason?: string;
}
export interface BrowserInviteAdapter {
  list(): Promise<{ invites: BrowserInviteTarget[]; state: ChatInviteSessionState }>;
  accept(target: BrowserInviteTarget): Promise<{ spaceName: string }>;
}
export class BrowserInviteError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) {
    super(message);
  }
}
interface LoginLease {
  id: string; owner: string; expiresAt: number; attached: boolean;
  timer: ReturnType<typeof setTimeout>; disconnect?: () => void;
}
interface ListedInvite { owner: string; expiresAt: number; target: BrowserInviteTarget }
const BUSY = () => new BrowserInviteError('BROWSER_BUSY', 'Zakończ otwartą sesję logowania lub poczekaj na zakończenie obsługi zaproszeń.');

export class BrowserInviteService {
  private lease: LoginLease | null = null;
  private running = false;
  private closed = false;
  private readonly listed = new Map<string, ListedInvite>();
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly adapter: BrowserInviteAdapter,
    private readonly listSpaces: (signal?: AbortSignal) => Promise<Array<{ name: string }>>,
    options: { wait?: (milliseconds: number) => Promise<void> } = {}) {
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds));
  }

  startLogin(owner: string): { sessionId: string; expiresAt: string; websocketPath: string } {
    this.assertAvailable();
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 600_000;
    const timer = setTimeout(() => this.dropLease(), 30_000);
    timer.unref();
    this.lease = { id, owner, expiresAt, attached: false, timer };
    this.listed.clear();
    return { sessionId: id, expiresAt: new Date(expiresAt).toISOString(),
      websocketPath: `/api/google-chat/invites/browser/${id}/socket` };
  }

  assertLogin(owner: string, id: string): void {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.dropLease();
    if (!this.lease || this.lease.id !== id || this.lease.owner !== owner) {
      throw new BrowserInviteError('BROWSER_SESSION_EXPIRED', 'Sesja przeglądarki wygasła. Otwórz ją ponownie.', 410);
    }
    if (this.lease.attached) throw BUSY();
  }

  claimLogin(owner: string, id: string, disconnect: () => void): void {
    this.assertLogin(owner, id);
    clearTimeout(this.lease!.timer);
    this.lease!.timer = setTimeout(() => this.dropLease(), this.lease!.expiresAt - Date.now());
    this.lease!.timer.unref();
    this.lease!.attached = true;
    this.lease!.disconnect = disconnect;
  }

  releaseLogin(owner: string, id: string): void {
    if (!this.lease) return;
    if (this.lease.owner !== owner) throw new BrowserInviteError('BROWSER_SESSION_FORBIDDEN', 'Ta sesja należy do innego użytkownika.', 403);
    if (this.lease.id !== id) {
      throw new BrowserInviteError('BROWSER_SESSION_EXPIRED', 'Ta sesja przeglądarki jest już zamknięta.', 410);
    }
    this.dropLease();
  }

  releaseOwner(owner: string): void {
    if (this.lease?.owner === owner) this.dropLease();
    for (const [key, entry] of this.listed) if (entry.owner === owner) this.listed.delete(key);
  }

  close(): void { this.closed = true; this.dropLease(); this.listed.clear(); }

  private dropLease(): void {
    const lease = this.lease;
    this.lease = null;
    if (lease) { clearTimeout(lease.timer); lease.disconnect?.(); }
  }

  private assertAvailable(): void {
    if (this.closed) throw new BrowserInviteError('BROWSER_UNAVAILABLE', 'Przeglądarka jest niedostępna.', 503);
    if (this.lease && this.lease.expiresAt <= Date.now()) this.dropLease();
    if (this.lease || this.running) throw BUSY();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    this.running = true;
    try { return await operation(); }
    catch (error) {
      if (error instanceof BrowserInviteError) throw error;
      throw new BrowserInviteError('BROWSER_UNAVAILABLE', 'Nie udało się odczytać przeglądarki Google. Sprawdź logowanie i spróbuj ponownie.', 502);
    } finally { this.running = false; }
  }

  private async confirmationSpaces(): Promise<Array<{ name: string }>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('GOOGLE_CONFIRMATION_TIMEOUT')); }, 10_000);
      timer.unref();
    });
    try { return await Promise.race([this.listSpaces(controller.signal), timeout]); }
    finally { clearTimeout(timer); }
  }

  async list(owner: string) {
    return this.exclusive(async () => {
      const result = await this.adapter.list();
      for (const [key, entry] of this.listed) {
        if (entry.owner === owner || entry.expiresAt <= Date.now()) this.listed.delete(key);
      }
      if (this.listed.size > 500) this.listed.clear();
      const invites = (result.state === 'ACTIVE' ? result.invites : []).slice(0, 200).map((target) => {
        const key = randomBytes(32).toString('base64url');
        this.listed.set(key, { owner, target, expiresAt: Date.now() + 300_000 });
        return { key, roomName: target.roomName, senderEmail: target.senderEmail,
          textPreview: target.textPreview, canAccept: target.canAccept, reason: target.reason };
      });
      return { invites, url: GOOGLE_CHAT_INVITES_URL, profileDir: '', session: {
        state: result.state, url: result.state === 'NEEDS_LOGIN' ? null : GOOGLE_CHAT_INVITES_URL,
        title: null, checkedAt: new Date().toISOString(),
        message: result.state === 'NEEDS_LOGIN' ? 'Zaloguj Google w oknie przeglądarki aplikacji.'
          : result.state === 'ACTIVE' ? 'Odczytano zaproszenia z Google Chat.' : 'Nie rozpoznano ekranu Google Chat. Otwórz okno logowania.',
      } };
    });
  }

  async accept(owner: string, key: string) {
    return this.exclusive(async () => {
      const entry = this.listed.get(key);
      if (!entry || entry.owner !== owner || entry.expiresAt <= Date.now()) {
        throw new BrowserInviteError('INVITE_NOT_LISTED', 'Odśwież zaproszenia przed przyjęciem wybranego czatu.', 404);
      }
      if (!entry.target.canAccept) throw new BrowserInviteError('INVITE_ID_UNAVAILABLE', 'Nie można jednoznacznie rozpoznać tego czatu. Sprawdź zaproszenie w oknie Google.');
      let before: Array<{ name: string }>;
      try { before = await this.confirmationSpaces(); }
      catch { throw new BrowserInviteError('INVITE_ACCOUNT_UNCONFIRMED', 'Połącz konto Google do pobierania, aby potwierdzić przyjęcie zaproszenia.'); }
      if (entry.target.spaceName && before.some((space) => space.name === entry.target.spaceName)) {
        throw new BrowserInviteError('INVITE_ACCOUNT_UNCONFIRMED', 'Ten czat jest już dostępny przez API. Sprawdź, czy przeglądarka i pobieranie używają tego samego konta Google.');
      }
      // Consume a listed key before any potential Google-side write. An uncertain result needs a fresh discovery.
      this.listed.delete(key);
      const result = await this.adapter.accept(entry.target);
      if (!/^spaces\/[A-Za-z0-9_-]+$/.test(result.spaceName) || before.some((space) => space.name === result.spaceName)) {
        throw new BrowserInviteError('INVITE_ACCEPTANCE_UNCONFIRMED', 'Nie potwierdzono przyjęcia zaproszenia dla połączonego konta Google. Odśwież czaty.');
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await this.wait(750);
        try {
          const spaces = await this.confirmationSpaces();
          if (spaces.some((space) => space.name === result.spaceName)) {
            return { accepted: true, invite: { key, roomName: entry.target.roomName,
              senderEmail: entry.target.senderEmail, textPreview: entry.target.textPreview } };
          }
        } catch { /* The UI click alone does not establish membership. */ }
      }
      throw new BrowserInviteError('INVITE_ACCEPTANCE_UNCONFIRMED', 'Kliknięto przyjęcie, ale Google nie potwierdził jeszcze dostępu do tego czatu. Odśwież czaty i sprawdź konto Google.');
    });
  }
}
