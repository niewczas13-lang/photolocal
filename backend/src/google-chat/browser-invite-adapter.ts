import { get } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { GOOGLE_CHAT_INVITES_URL, mapRawInviteCandidates } from './chat-invites.js';
import { inspectBrowserInviteDom, clickBrowserPreviewJoin } from './browser-invite-dom.js';
import { BrowserInviteError, type BrowserInviteAdapter, type BrowserInviteTarget } from './browser-invite-service.js';

const unavailable = () => new BrowserInviteError('BROWSER_UNAVAILABLE', 'Przeglądarka Google jest niedostępna. Spróbuj ponownie za chwilę.', 502);

type CdpVersionRequest = (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>;

// Node's fetch ignores Host overrides. Chromium requires localhost here even though
// the TCP connection goes to the private Docker bridge, so use the HTTP client.
const requestCdpVersion: CdpVersionRequest = (url, options) => new Promise((resolve, reject) => {
  const request = get(url, {
    headers: { Host: 'localhost' }, signal: options.signal ?? undefined, agent: false,
    maxHeaderSize: 16_384,
  }, (response) => {
    response.on('error', reject);
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      reject(unavailable());
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16_384) {
        request.destroy(unavailable());
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      resolve({ ok: true, text: async () => body });
    });
  });
  request.on('error', reject);
});

export async function resolvePrivateCdpWebSocket(cdpUrl: string, request: CdpVersionRequest = requestCdpVersion): Promise<string> {
  try {
    const configured = new URL(cdpUrl);
    if (configured.protocol !== 'http:' || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) throw unavailable();
    const response = await request(`${configured.origin}/json/version`, { headers: { Host: 'localhost' },
      redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw unavailable();
    const body = await response.text();
    if (body.length > 16_384) throw unavailable();
    const parsed: unknown = JSON.parse(body);
    const address = parsed && typeof parsed === 'object' && 'webSocketDebuggerUrl' in parsed ? parsed.webSocketDebuggerUrl : null;
    if (typeof address !== 'string') throw unavailable();
    const endpoint = new URL(address);
    if (endpoint.protocol !== 'ws:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !['localhost', '127.0.0.1', '[::1]', configured.hostname].includes(endpoint.hostname)
      || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(endpoint.pathname)) throw unavailable();
    return `ws://${configured.host}${endpoint.pathname}`;
  } catch { throw unavailable(); }
}

export class DockerBrowserInviteAdapter implements BrowserInviteAdapter {
  private readonly connect: (url: string) => Promise<Browser>;
  private readonly request: CdpVersionRequest;
  constructor(private readonly cdpUrl: string, options: {
    connect?: (url: string) => Promise<Browser>; fetch?: CdpVersionRequest;
  } = {}) {
    // Chromium applies its Host check to the WebSocket upgrade as well as HTTP discovery.
    this.connect = options.connect ?? ((url) => chromium.connectOverCDP(url, {
      timeout: 10_000, headers: { Host: 'localhost' },
    }));
    this.request = options.fetch ?? requestCdpVersion;
  }

  private async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.connect(await resolvePrivateCdpWebSocket(this.cdpUrl, this.request));
    try {
      const context = browser.contexts()[0];
      if (!context) throw unavailable();
      const page = context.pages().find((candidate) => {
        try { return ['chat.google.com', 'accounts.google.com'].includes(new URL(candidate.url()).hostname); }
        catch { return false; }
      }) ?? await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(GOOGLE_CHAT_INVITES_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      if (new URL(page.url()).hostname === 'chat.google.com') {
        await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 50, null, { timeout: 10_000 }).catch(() => undefined);
      }
      return await operation(page);
    } finally {
      // close() on a connectOverCDP Browser disconnects our client, preserving the headed browser/profile.
      await browser.close();
    }
  }

  async list() {
    return this.withPage(async (page) => {
      const hostname = new URL(page.url()).hostname;
      if (hostname === 'accounts.google.com') return { invites: [], state: 'NEEDS_LOGIN' as const };
      if (hostname !== 'chat.google.com') return { invites: [], state: 'UNKNOWN' as const };
      let result = await page.evaluate(inspectBrowserInviteDom);
      const snapshot = (scan: ReturnType<typeof inspectBrowserInviteDom>) => JSON.stringify([
        scan.screenState, scan.cards.map(card => JSON.stringify([card.fingerprint, card.action, card.canAccept])).sort(),
      ]);
      let previous = snapshot(result);
      let stableReadings = 0;
      // Google can remove temporary card text after the first render. Require
      // two seconds of unchanged identities before exposing them for acceptance.
      for (let attempt = 0; stableReadings < 4 && attempt < 20; attempt++) {
        await page.waitForTimeout(500);
        result = await page.evaluate(inspectBrowserInviteDom);
        const current = snapshot(result);
        stableReadings = result.screenState !== 'UNKNOWN' && current === previous ? stableReadings + 1 : 0;
        previous = current;
      }
      if (stableReadings < 4) return { invites: [], state: 'UNKNOWN' as const };
      if (!result.cards.length && result.screenState !== 'EMPTY') return { invites: [], state: 'UNKNOWN' as const };
      const invites = result.cards.map((card): BrowserInviteTarget => {
        const display = mapRawInviteCandidates([{ buttonIndex: 0, text: card.text }])[0];
        const englishRoomName = card.text.split(/\s+(?:invitation from:|invited by:)/i);
        return { fingerprint: card.fingerprint, roomName: englishRoomName.length > 1 ? englishRoomName[0] : display.roomName,
          senderEmail: display.senderEmail, textPreview: display.textPreview, spaceName: card.spaceName,
          canAccept: card.canAccept, reason: card.canAccept ? undefined : 'Nie można jednoznacznie rozpoznać ID tego czatu. Sprawdź zaproszenie w oknie Google.' };
      });
      return { invites, state: 'ACTIVE' as const };
    });
  }

  async accept(target: BrowserInviteTarget): Promise<{ spaceName: string }> {
    return this.withPage(async (page) => {
      if (new URL(page.url()).hostname !== 'chat.google.com') {
        throw new BrowserInviteError('BROWSER_LOGIN_REQUIRED', 'Zaloguj Google w oknie przeglądarki aplikacji.');
      }
      let scan = await page.evaluate(inspectBrowserInviteDom);
      // Chat's navigation can be ready while invitation cards are still loading.
      // Wait for the exact listed identity; never substitute a different card.
      for (let attempt = 0; !scan.cards.some(card => card.fingerprint === target.fingerprint) && attempt < 20; attempt++) {
        await page.waitForTimeout(500);
        scan = await page.evaluate(inspectBrowserInviteDom);
      }
      const candidates = scan.cards.filter(card => card.fingerprint === target.fingerprint && card.canAccept);
      if (candidates.length !== 1) throw new BrowserInviteError('INVITE_CHANGED', 'Zaproszenie zmieniło się lub jest niejednoznaczne. Odśwież listę.');
      const candidate = candidates[0];
      const clicked = await page.evaluate(inspectBrowserInviteDom, { fingerprint: target.fingerprint, action: candidate.action });
      if (!clicked.clicked) throw new BrowserInviteError('INVITE_CHANGED', 'Nie znaleziono dokładnie wybranego zaproszenia. Odśwież listę.');
      if (candidate.action === 'join' && clicked.spaceName) return { spaceName: clicked.spaceName };
      for (let attempt = 0; attempt < 20; attempt++) {
        const preview = await page.evaluate(clickBrowserPreviewJoin, { roomName: target.roomName, expectedSpaceName: target.spaceName });
        if (preview.clicked && preview.spaceName) return { spaceName: preview.spaceName };
        await page.waitForTimeout(500);
      }
      throw new BrowserInviteError('INVITE_ID_UNAVAILABLE', 'Nie można potwierdzić tożsamości czatu w podglądzie. Nie kliknięto Dołącz. Sprawdź zaproszenie w oknie Google.');
    });
  }
}
