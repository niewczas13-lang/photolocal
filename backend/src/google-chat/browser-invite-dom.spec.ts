import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectBrowserInviteDom, clickBrowserPreviewJoin } from './browser-invite-dom.js';

function page(html: string) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', { href: 'https://chat.google.com/app/browse' });
  let clicks = 0;
  for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => clicks++);
  return { document, clicks: () => clicks };
}
const card = (name: string, id: string, action = 'Join') => `<article><a href="https://chat.google.com/room/${id}">${name}</a> Invitation from: sender@example.test <button>${action}</button></article>`;
afterEach(() => vi.unstubAllGlobals());
describe('pending invitation DOM identity', () => {
  it('distinguishes an explicit empty-inbox message from a loading/error shell', () => {
    page('<nav>Google Chat Spaces Browse spaces</nav><p>Loading your conversations</p>');
    expect(inspectBrowserInviteDom().screenState).toBe('UNKNOWN');
    page('<h1>Browse spaces</h1><p>No invitations</p>');
    expect(inspectBrowserInviteDom().screenState).toBe('EMPTY');
  });
  it('discovers pending cards without clicking and excludes unrelated/hidden join controls', () => {
    const fixture = page(`<button>Join</button><article hidden>${card('Hidden', 'H')}</article>${card('Alpha', 'A')}`);
    const result = inspectBrowserInviteDom();
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].spaceName).toBe('spaces/A');
    expect(fixture.clicks()).toBe(0);
  });
  it('matches the card again after DOM order changes and never chooses a button index', () => {
    page(card('Alpha', 'A') + card('Beta', 'B'));
    const first = inspectBrowserInviteDom().cards[0];
    const fixture = page(card('Beta', 'B') + card('Alpha', 'A'));
    let alpha = 0;
    fixture.document.querySelectorAll('button')[1].addEventListener('click', () => alpha++);
    expect(inspectBrowserInviteDom({ fingerprint: first.fingerprint, action: 'join' }).clicked).toBe(true);
    expect(alpha).toBe(1);
    expect(fixture.clicks()).toBe(1);
  });
  it('never borrows a nested invite identity for an unrelated ancestor toolbar Join', () => {
    const fixture = page(`<section><button>Join</button>${card('Alpha', 'A', 'Preview')}</section>`);
    const result = inspectBrowserInviteDom();
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].action).toBe('view');
    expect(inspectBrowserInviteDom({ fingerprint: result.cards[0].fingerprint, action: 'join' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });
  it('ignores hidden ancestors for invitation cards and preview join controls', () => {
    const fixture = page(`<section style="display:none">${card('Hidden', 'H')}</section>${card('Shown', 'S')}`);
    expect(inspectBrowserInviteDom().cards.map(item => item.spaceName)).toEqual(['spaces/S']);
    expect(fixture.clicks()).toBe(0);
    const preview = page('<section style="display:none"><div role="dialog"><h1>Hidden</h1><a href="/room/H">Hidden</a><button>Join</button></div></section>');
    expect(clickBrowserPreviewJoin({ roomName: 'Hidden', expectedSpaceName: 'spaces/H' }).clicked).toBe(false);
    expect(preview.clicks()).toBe(0);
  });
  it('refuses duplicate identity, unrelated decline buttons, and identity-free direct joins', () => {
    const fixture = page(card('Same', 'A') + card('Same', 'A') + '<article>No ID Invitation from: sender@example.test <button>Join</button></article><article>Invitation from: x <button>Do not join</button></article>');
    const result = inspectBrowserInviteDom();
    expect(result.cards).toHaveLength(3);
    expect(result.cards.every(item => !item.canAccept)).toBe(true);
    expect(inspectBrowserInviteDom({ fingerprint: result.cards[0].fingerprint, action: 'join' }).clicked).toBe(false);
    expect(inspectBrowserInviteDom({ fingerprint: result.cards[2].fingerprint, action: 'join' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });
  it('preview itself may be opened but join requires the exact preview room identity', () => {
    const fixture = page('<article>Alpha Invitation from: sender@example.test <button>Preview</button></article>');
    const candidate = inspectBrowserInviteDom().cards[0];
    expect(candidate.canAccept).toBe(true);
    expect(inspectBrowserInviteDom({ fingerprint: candidate.fingerprint, action: 'view' }).clicked).toBe(true);
    expect(fixture.clicks()).toBe(1);
    const preview = page('<div role="dialog"><h1>Alpha</h1><a href="/room/A">Alpha</a><button>Join</button></div><button>Join</button>');
    expect(clickBrowserPreviewJoin({ roomName: 'Alpha', expectedSpaceName: 'spaces/WRONG' }).clicked).toBe(false);
    expect(clickBrowserPreviewJoin({ roomName: 'Alpha', expectedSpaceName: null })).toEqual({ clicked: true, spaceName: 'spaces/A' });
    expect(preview.clicks()).toBe(1);
  });
});
