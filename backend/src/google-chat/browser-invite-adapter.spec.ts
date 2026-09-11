import type { Browser, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { DockerBrowserInviteAdapter, resolvePrivateCdpWebSocket } from './browser-invite-adapter.js';

describe('private CDP browser adapter', () => {
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
    const evaluate = vi.fn(async () => ({ cards: [{ fingerprint: 'row', text: 'Alpha Invitation from: sender@example.test Join', spaceName: 'spaces/A', action: 'join', canAccept: true }], clicked: false }));
    const page = { goto: vi.fn(), url: () => 'https://chat.google.com/app/browse', setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => undefined), evaluate } as unknown as Page;
    const close = vi.fn();
    const browser = { contexts: () => [{ pages: () => [page] }], close } as unknown as Browser;
    const adapter = new DockerBrowserInviteAdapter('http://chat-browser:9223', {
      connect: vi.fn(async () => browser), fetch: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/test' }))),
    });
    const result = await adapter.list();
    expect(result.invites[0]).toMatchObject({ roomName: 'Alpha', spaceName: 'spaces/A' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]).toHaveLength(1);
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
