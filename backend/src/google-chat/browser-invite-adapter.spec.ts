import { createServer, type RequestListener, type Server } from 'node:http';
import type { Browser, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { DockerBrowserInviteAdapter, resolvePrivateCdpWebSocket } from './browser-invite-adapter.js';
import type { BrowserInviteTarget } from './browser-invite-service.js';

async function withCdpServer(handler: RequestListener, check: (url: string, server: Server) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server port');
    await check(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('private CDP browser adapter', () => {
  it('sends the Chromium-required Host header over real HTTP, including the adapter default transport', async () => {
    const hosts: Array<string | undefined> = [];
    await withCdpServer((request, response) => {
      hosts.push(request.headers.host);
      if (request.headers.host !== 'localhost' || request.url !== '/json/version') {
        response.writeHead(500).end('Host header is specified and is not an IP address or localhost.');
        return;
      }
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test-id' }));
    }, async (url) => {
      const expected = `${url.replace('http:', 'ws:')}/devtools/browser/test-id`;
      await expect(resolvePrivateCdpWebSocket(url)).resolves.toBe(expected);
      const page = { goto: vi.fn(), url: () => 'https://accounts.google.com/signin', setDefaultTimeout: vi.fn() } as unknown as Page;
      const close = vi.fn();
      const connect = vi.fn(async () => ({ contexts: () => [{ pages: () => [page] }], close }) as unknown as Browser);
      await expect(new DockerBrowserInviteAdapter(url, { connect }).list()).resolves.toMatchObject({ state: 'NEEDS_LOGIN' });
      expect(connect).toHaveBeenCalledWith(expected);
      expect(close).toHaveBeenCalledOnce();
    });
    expect(hosts).toEqual(['localhost', 'localhost']);
  });

  it('sends the Chromium-required Host header in the real WebSocket handshake too', async () => {
    const hosts: Array<string | undefined> = [];
    await withCdpServer((request, response) => {
      hosts.push(request.headers.host);
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test-id' }));
    }, async (url, server) => {
      server.once('upgrade', (request, socket) => {
        hosts.push(request.headers.host);
        // Capture the actual Playwright handshake, then stop before any CDP commands.
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
      await expect(new DockerBrowserInviteAdapter(url).list()).rejects.toThrow(/connectOverCDP/);
    });
    expect(hosts).toEqual(['localhost', 'localhost']);
  });

  it('rejects redirects without contacting the redirect destination', async () => {
    const paths: Array<string | undefined> = [];
    await withCdpServer((request, response) => {
      paths.push(request.url);
      response.writeHead(302, { Location: '/other-endpoint' }).end();
    }, async (url) => {
      await expect(resolvePrivateCdpWebSocket(url)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
    });
    expect(paths).toEqual(['/json/version']);
  });

  it('stops an oversized streaming response before waiting for its end', async () => {
    await withCdpServer((_request, response) => {
      response.writeHead(200);
      response.write('x'.repeat(16_385));
      // Deliberately leave the response open: enforce the limit during reception.
    }, async (url) => {
      const started = Date.now();
      await expect(resolvePrivateCdpWebSocket(url)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  it('enforces one absolute deadline even while response data keeps arriving', async () => {
    await withCdpServer((_request, response) => {
      response.writeHead(200);
      response.write(' ');
      const timer = setInterval(() => response.write(' '), 50);
      response.once('close', () => clearInterval(timer));
    }, async (url) => {
      const started = Date.now();
      await expect(resolvePrivateCdpWebSocket(url)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(Date.now() - started).toBeLessThan(8_000);
    });
  }, 10_000);

  it('rejects an interrupted response without exposing its contents', async () => {
    await withCdpServer((_request, response) => {
      response.writeHead(200);
      response.write('{"private":"test-content');
      setImmediate(() => response.destroy());
    }, async (url) => {
      await expect(resolvePrivateCdpWebSocket(url)).rejects.toMatchObject({
        code: 'BROWSER_UNAVAILABLE',
        message: 'Przeglądarka Google jest niedostępna. Spróbuj ponownie za chwilę.',
      });
    });
  });

  it('rewrites only a validated browser debugger path to the configured private authority', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc-123' })));
    expect(await resolvePrivateCdpWebSocket('http://chat-browser:9223', request)).toBe('ws://chat-browser:9223/devtools/browser/abc-123');
    expect(request).toHaveBeenCalledWith('http://chat-browser:9223/json/version', expect.objectContaining({ headers: { Host: 'localhost' } }));
    for (const url of ['ws://example.test/devtools/browser/id', 'ws://localhost:9222/not-browser', 'ws://localhost:9222/devtools/browser/id?token=private']) {
      request.mockResolvedValueOnce(new Response(JSON.stringify({ webSocketDebuggerUrl: url })));
      await expect(resolvePrivateCdpWebSocket('http://chat-browser:9223', request)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
    }
  });

  it('discovery uses the persistent browser page and closes the CDP attachment, without clicking', async () => {
    const evaluate = vi.fn(async () => ({ cards: [{ fingerprint: 'row', text: 'Alpha Invitation from: sender@example.test Join', spaceName: 'spaces/A', action: 'join', canAccept: true }], clicked: false, screenState: 'INVITES' }));
    const page = { goto: vi.fn(), url: () => 'https://chat.google.com/app/browse', setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => undefined), waitForTimeout: vi.fn(async () => undefined), evaluate } as unknown as Page;
    const close = vi.fn();
    const browser = { contexts: () => [{ pages: () => [page] }], close } as unknown as Browser;
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => browser), fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/test' }))),
    });
    const result = await adapter.list();
    expect(result.invites[0]).toMatchObject({ roomName: 'Alpha', spaceName: 'spaces/A' });
    for (const call of evaluate.mock.calls) expect(call).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('lists the settled invitation identity after Google removes temporary comma placeholders', async () => {
    let reads = 0;
    const evaluate = vi.fn(async () => {
      const text = ++reads <= 4 ? 'Alpha , , Invitation from: sender@example.test Preview' : 'Alpha Invitation from: sender@example.test Preview';
      return { cards: [{ fingerprint: JSON.stringify([null, text]), text, spaceName: null, action: 'view', canAccept: true }], screenState: 'INVITES' };
    });
    const page = { goto: vi.fn(), url: () => 'https://chat.google.com/app/browse', setDefaultTimeout: vi.fn(),
      waitForFunction: vi.fn(async () => undefined), waitForTimeout: vi.fn(async () => undefined), evaluate } as unknown as Page;
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => ({ contexts: () => [{ pages: () => [page] }], close: vi.fn() }) as unknown as Browser),
      fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' }))),
    });
    const result = await adapter.list();
    expect(result.state).toBe('ACTIVE');
    expect(result.invites[0]).toMatchObject({
      fingerprint: JSON.stringify([null, 'Alpha Invitation from: sender@example.test Preview']), roomName: 'Alpha',
    });
    for (const call of evaluate.mock.calls) expect(call).toHaveLength(1);
  });

  it('does not publish an invitation whose identity keeps changing throughout the loading limit', async () => {
    let reads = 0;
    const evaluate = vi.fn(async () => ({ cards: [{ fingerprint: `changing-${++reads}`, text: 'Alpha Invitation from: sender@example.test Preview',
      spaceName: null, action: 'view', canAccept: true }], screenState: 'INVITES' }));
    const wait = vi.fn(async () => undefined);
    const page = { goto: vi.fn(), url: () => 'https://chat.google.com/app/browse', setDefaultTimeout: vi.fn(),
      waitForFunction: vi.fn(async () => undefined), waitForTimeout: wait, evaluate } as unknown as Page;
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => ({ contexts: () => [{ pages: () => [page] }], close: vi.fn() }) as unknown as Browser),
      fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' }))),
    });
    expect(await adapter.list()).toEqual({ invites: [], state: 'UNKNOWN' });
    expect(wait.mock.calls.length).toBeLessThanOrEqual(20);
    for (const call of evaluate.mock.calls) expect(call).toHaveLength(1);
  });

  it('waits for the exact selected invitation after reloading before clicking it once', async () => {
    const target: BrowserInviteTarget = { fingerprint: 'selected', roomName: 'Alpha', senderEmail: null,
      textPreview: 'Alpha invitation', spaceName: 'spaces/A', canAccept: true };
    const selected = { ...target, text: 'Alpha invitation', action: 'join' };
    const other = { ...selected, fingerprint: 'other', spaceName: 'spaces/B' };
    const scans = [
      { cards: [], screenState: 'UNKNOWN' },
      { cards: [other], screenState: 'INVITES' },
      { cards: [other, selected], screenState: 'INVITES' },
    ];
    const clicks: unknown[] = [];
    const evaluate = vi.fn(async (_operation, input) => {
      if (input) { clicks.push(input); return { clicked: true, spaceName: 'spaces/A' }; }
      return scans.shift();
    });
    const page = { goto: vi.fn(), url: () => 'https://chat.google.com/app/browse',
      setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined), evaluate } as unknown as Page;
    const close = vi.fn();
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => ({ contexts: () => [{ pages: () => [page] }], close }) as unknown as Browser),
      fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' }))),
    });
    await expect(adapter.accept(target)).resolves.toEqual({ spaceName: 'spaces/A' });
    expect(clicks).toEqual([{ fingerprint: 'selected', action: 'join' }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('a login redirect returns NEEDS_LOGIN without extracting account form contents', async () => {
    const evaluate = vi.fn();
    const page = { goto: vi.fn(), url: () => 'https://accounts.google.com/signin', setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => undefined), evaluate } as unknown as Page;
    const close = vi.fn();
    const browser = { contexts: () => [{ pages: () => [page] }], close } as unknown as Browser;
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => browser), fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/test' }))),
    });
    expect(await adapter.list()).toEqual({ invites: [], state: 'NEEDS_LOGIN' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
