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
const previewFooter = (name = 'Radom OPP30 etap2 budowa Rzeszowska', sender = 'sender@example.test') => `
  <div role="alertdialog" aria-labelledby="room-label sender-label join-label block-label" jsdata="jUcABe;space/ROOM_A;$148">
    <div id="room-label">${name}</div><div id="sender-label">Masz zaproszenie od: ${sender}</div>
    <div><button id="block-label">Zablokuj</button><button id="join-label">Dołącz</button></div>
  </div>`;
const googlePreview = (footer: string) => `<div role="dialog" aria-label="Wyświetl podgląd pokoju">
  <h1>piątek, 11 wrz</h1><h2>Message sender</h2><a href="/room/OTHER">Room mentioned in a message</a>
  ${footer}</div>`;
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

  it('joins the matched Google invitation footer without borrowing IDs from conversation links', () => {
    const fixture = page(googlePreview(previewFooter()) + '<button>Dołącz</button>');
    const result = clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: null, expectedSenderEmail: 'sender@example.test' });
    expect(result).toEqual({ clicked: true, spaceName: 'spaces/ROOM_A' });
    expect(fixture.clicks()).toBe(1);
  });

  it.each([
    ['different room', previewFooter('Radom OPP31')],
    ['different sender', previewFooter(undefined, 'other@example.test')],
    ['duplicate footer', previewFooter() + previewFooter()],
    ['duplicate join', previewFooter().replace('</div>\n  </div>', '<button>Dołącz</button></div>\n  </div>')],
    ['hidden footer', `<section style="display:none">${previewFooter()}</section>`],
    ['disabled join', previewFooter().replace('<button id="join-label">', '<button id="join-label" disabled>')],
    ['missing room ID', previewFooter().replace('jUcABe;space/ROOM_A;$148', '')],
    ['unknown metadata', previewFooter().replace('jUcABe;space/ROOM_A;$148', 'deferred-c65')],
    ['unknown model', previewFooter().replace('jUcABe;', 'unknown;')],
    ['topic ID instead of room', previewFooter().replace('space/ROOM_A', 'topic/ROOM_A')],
    ['conflicting room metadata', previewFooter().replace('jUcABe;space/ROOM_A;$148', 'jUcABe;space/ROOM_A;$148 jUcABe;space/OTHER;$149')],
  ])('does not join an invitation with %s', (_label, footer) => {
    const fixture = page(googlePreview(footer));
    expect(clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: null, expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it('does not use a room name from conversation headings when the invitation footer differs', () => {
    const fixture = page(googlePreview(previewFooter('Different room')).replace('piątek, 11 wrz', 'Wanted room'));
    expect(clickBrowserPreviewJoin({ roomName: 'Wanted room', expectedSpaceName: null,
      expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it('requires the selected sender and the same ID when it is already known', () => {
    const fixture = page(googlePreview(previewFooter()));
    for (const input of [
      { roomName: 'Radom OPP30 etap2 budowa Rzeszowska', expectedSpaceName: null, expectedSenderEmail: null },
      { roomName: 'Radom OPP30 etap2 budowa Rzeszowska', expectedSpaceName: 'spaces/OTHER', expectedSenderEmail: 'sender@example.test' },
    ]) expect(clickBrowserPreviewJoin(input).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
    expect(clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: 'spaces/ROOM_A', expectedSenderEmail: 'sender@example.test' })).toEqual({ clicked: true, spaceName: 'spaces/ROOM_A' });
  });

  it('does not borrow an aria-labelledby target outside the invitation footer', () => {
    const fixture = page('<div id="elsewhere">Radom OPP30 etap2 budowa Rzeszowska</div>'
      + googlePreview(previewFooter().replace('room-label sender-label', 'elsewhere sender-label')));
    expect(clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: null, expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it('refuses two matching footers even when their label IDs differ', () => {
    const second = previewFooter().replace(/(room|sender|join|block)-label/g, '$1-second').replace('space/ROOM_A', 'space/ROOM_B');
    const fixture = page(googlePreview(previewFooter() + second));
    expect(clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: null, expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it('does not borrow labels and Join from a nested alertdialog', () => {
    const child = previewFooter().replace('jUcABe;space/ROOM_A;$148', 'deferred-c65');
    const fixture = page(googlePreview(`<div role="alertdialog" jsdata="jUcABe;space/WRONG_PARENT;$1"
      aria-labelledby="room-label sender-label join-label block-label">${child}</div>`));
    expect(clickBrowserPreviewJoin({ roomName: 'Radom OPP30 etap2 budowa Rzeszowska',
      expectedSpaceName: null, expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    expect(fixture.clicks()).toBe(0);
  });

  it('preserves diacritics and the complete room name when matching the footer', () => {
    const fixture = page(googlePreview(previewFooter('Zagłoby 40')));
    for (const roomName of ['Zagloby 40', 'Zagłoby', 'Zagłoby 4', 'ZAGŁOBY 40']) {
      expect(clickBrowserPreviewJoin({ roomName, expectedSpaceName: null,
        expectedSenderEmail: 'sender@example.test' }).clicked).toBe(false);
    }
    expect(fixture.clicks()).toBe(0);
  });
});
