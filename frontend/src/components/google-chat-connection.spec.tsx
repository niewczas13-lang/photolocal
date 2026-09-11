import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoogleChatConnection, GoogleChatInvitesLink } from './google-chat-connection';
import type { GoogleChatAuthStatus } from '../types';

function connection(state: GoogleChatAuthStatus['state']): string {
  return renderToStaticMarkup(<GoogleChatConnection
    status={{ state, canConnect: state !== 'NOT_CONFIGURED', message: 'Stan połączenia', inviteMode: 'GOOGLE_CHAT_LINK' }}
    onStatusChange={() => {}}
    refreshKey={0}
  />);
}

describe('Google Chat connection controls', () => {
  it('offers reconnect when the Google API session expired', () => {
    expect(connection('AUTH_REQUIRED')).toContain('Połącz ponownie Google');
  });

  it('offers the first connection when no account has been connected', () => {
    expect(connection('NOT_CONNECTED')).toContain('Połącz Google');
  });

  it('does not offer login when OAuth has not been configured', () => {
    expect(connection('NOT_CONFIGURED')).not.toContain('Połącz Google');
    expect(connection('NOT_CONFIGURED')).toContain('Brak konfiguracji');
  });

  it.each(['AUTH_REQUIRED', 'NOT_CONFIGURED'] as const)(
    'allows an explicit token check in %s even when web OAuth is unavailable', (state) => {
      const markup = renderToStaticMarkup(<GoogleChatConnection
        status={{ state, canConnect: false, message: 'Sprawdź token', inviteMode: 'WINDOWS_BROWSER' }}
        onStatusChange={() => {}}
        refreshKey={0}
      />);
      const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
        ?.find((element) => element.includes('Sprawdź połączenie'));

      expect(button).toBeDefined();
      expect(button).not.toContain('disabled=""');
      expect(button).not.toContain('aria-disabled="true"');
    },
  );

  it('describes the API connection separately from browser invites', () => {
    expect(connection('CONNECTED')).toContain('Google połączone');
    expect(connection('CONNECTED')).toContain('Sesja Google Chat w przeglądarce jest osobna');
  });

  it('opens Google Chat for invites on Linux using the same Google account', () => {
    const markup = renderToStaticMarkup(<GoogleChatInvitesLink />);
    expect(markup).toContain('href="https://chat.google.com"');
    expect(markup).toContain('tego samego konta Google');
    expect(markup).not.toContain('Otworz logowanie');
  });
});
