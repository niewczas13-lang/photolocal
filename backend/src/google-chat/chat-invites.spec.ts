import { describe, expect, it } from 'vitest';
import { isInviteSenderAllowed, mapRawInviteCandidates, parseInviteWhitelist } from './chat-invites.js';

describe('chat invites helpers', () => {
  it('parses whitelist entries from lines, commas and semicolons', () => {
    expect(parseInviteWhitelist('jan@gmail.com\n *@gmail.com;firma.pl')).toEqual([
      'jan@gmail.com',
      '*@gmail.com',
      'firma.pl',
    ]);
  });

  it('allows exact emails and domains', () => {
    expect(isInviteSenderAllowed('jan@gmail.com', ['jan@gmail.com'])).toBe(true);
    expect(isInviteSenderAllowed('adam@gmail.com', ['*@gmail.com'])).toBe(true);
    expect(isInviteSenderAllowed('adam@gmail.com', ['gmail.com'])).toBe(true);
    expect(isInviteSenderAllowed('adam@other.com', ['gmail.com'])).toBe(false);
  });

  it('maps raw Google Chat card text to invite candidates', () => {
    const [invite] = mapRawInviteCandidates(
      [
        {
          buttonIndex: 0,
          text: 'Budowa OPP0013\nZaproszenie od Jan Kowalski jan@gmail.com\nDołącz',
        },
      ],
      '*@gmail.com',
    );

    expect(invite).toMatchObject({
      roomName: 'Budowa OPP0013',
      senderEmail: 'jan@gmail.com',
      allowed: true,
    });
    expect(invite.key).toHaveLength(16);
  });

  it('extracts a readable room name from compact Google Chat invite text', () => {
    const [invite] = mapRawInviteCandidates(
      [
        {
          buttonIndex: 0,
          text: 'PURDA 02 X/04017460 26 uzytkownikow Pawel Dudzinski Z zewnatrz • Zaproszenie od: niewczas13@gmail.com Podglad Dolacz',
        },
      ],
      '*@gmail.com',
    );

    expect(invite).toMatchObject({
      roomName: 'PURDA 02 X/04017460 26 uzytkownikow Pawel Dudzinski',
      senderEmail: 'niewczas13@gmail.com',
      allowed: true,
    });
  });
});

