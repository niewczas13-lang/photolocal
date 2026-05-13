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
          text: 'Budowa OPP0013\nZaproszenie od Jan Kowalski jan@gmail.com\nDolacz',
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
});

