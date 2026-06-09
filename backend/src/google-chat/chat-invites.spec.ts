import { describe, expect, it } from 'vitest';
import {
  buildInviteBrowserLaunchInfo,
  buildInviteLauncherStartedStatus,
  buildInviteLoginLauncherInfo,
  mapRawInviteCandidates,
} from './chat-invites.js';

describe('chat invites helpers', () => {
  it('maps raw Google Chat card text to invite candidates', () => {
    const [invite] = mapRawInviteCandidates(
      [
        {
          buttonIndex: 0,
          text: 'Budowa OPP0013\nZaproszenie od Jan Kowalski jan@gmail.com\nDolacz',
        },
      ],
    );

    expect(invite).toMatchObject({
      roomName: 'Budowa OPP0013',
      senderEmail: 'jan@gmail.com',
    });
    expect(invite.key).toHaveLength(16);
  });

  it('extracts a readable room name from compact Google Chat invite text', () => {
    const [invite] = mapRawInviteCandidates(
      [
        {
          buttonIndex: 0,
          text:
            'PURDA 02 X/04017460 26 uzytkownikow Pawel Dudzinski Z zewnatrz - ' +
            'Zaproszenie od: niewczas13@gmail.com Podglad Dolacz',
        },
      ],
    );

    expect(invite).toMatchObject({
      roomName: 'PURDA 02 X/04017460',
      senderEmail: 'niewczas13@gmail.com',
    });
  });

  it('handles Google Chat text where action labels are glued to the sender email', () => {
    const [invite] = mapRawInviteCandidates(
      [
        {
          buttonIndex: 0,
          text:
            'PURDA 02 X/04017460 26 u\u017cytkownik\u00f3wPawe\u0142 Dudzi\u0144skiPawe\u0142 Dudzi\u0144skiZ zewn\u0105trz \u2022 ' +
            'Zaproszenie od: niewczas13@gmail.comPodgl\u0105dDo\u0142\u0105cz',
        },
      ],
    );

    expect(invite).toMatchObject({
      roomName: 'PURDA 02 X/04017460',
      senderEmail: 'niewczas13@gmail.com',
    });
    expect(invite.textPreview).not.toMatch(/Podgl\u0105d|Do\u0142\u0105cz/i);
  });

  it('builds a manual launch command for the Google Chat browser profile', () => {
    const launch = buildInviteBrowserLaunchInfo({
      config: {
        profileDir: 'C:\\PhotoLocal\\backend\\data\\google-chat-browser-profile',
        headless: false,
        debugPort: 9333,
      },
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    expect(launch).toMatchObject({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      debugPort: 9333,
      profileDir: 'C:\\PhotoLocal\\backend\\data\\google-chat-browser-profile',
    });
    expect(launch.command).toContain('powershell -NoProfile -ExecutionPolicy Bypass -Command');
    expect(launch.command).toContain("Start-Process -FilePath 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'");
    expect(launch.command).toContain("'--remote-debugging-port=9333'");
    expect(launch.command).toContain("'--user-data-dir=C:\\PhotoLocal\\backend\\data\\google-chat-browser-profile'");
    expect(launch.command).toContain('chat.google.com/app/browse');
  });

  it('builds a CMD launcher command for the PhotoLocal Google Chat login bat', () => {
    const launcher = buildInviteLoginLauncherInfo({
      launcherPath: 'C:\\PhotoLocal\\otworz-logowanie-google-chat.bat',
    });

    expect(launcher).toMatchObject({
      launcherPath: 'C:\\PhotoLocal\\otworz-logowanie-google-chat.bat',
      command: 'cmd.exe /d /k "C:\\PhotoLocal\\otworz-logowanie-google-chat.bat"',
    });
    expect(launcher.command).not.toContain('start ""');
  });

  it('returns a launcher-started status without requiring Chrome CDP to be ready', () => {
    const status = buildInviteLauncherStartedStatus();

    expect(status).toMatchObject({
      state: 'UNKNOWN',
      url: null,
      title: null,
    });
    expect(status.message).toContain('Uruchomiono okno logowania');
    expect(status.message).not.toContain('CDP');
  });
});
