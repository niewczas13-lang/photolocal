import { describe, expect, it } from 'vitest';
import { getGoogleChatAuthCallbackMessage, getGoogleChatAuthReturnPath } from './google-chat-auth-state';

describe('Google Chat browser return', () => {
  it('keeps the project hash route and unrelated query parameters', () => {
    expect(getGoogleChatAuthReturnPath({
      pathname: '/', search: '?theme=dark&googleChatAuth=connected', hash: '#/projects/1/import',
    })).toBe('/?theme=dark#/projects/1/import');
  });

  it('explains reconnect success without starting downloads automatically', () => {
    expect(getGoogleChatAuthCallbackMessage('?googleChatAuth=connected')).toContain('Wznów pobieranie');
  });

  it.each(['denied', 'failed'])('explains the %s callback without claiming success', (result) => {
    const message = getGoogleChatAuthCallbackMessage(`?googleChatAuth=${result}`);
    expect(message).toBeTruthy();
    expect(message).not.toContain('Połączono');
  });

  it('ignores an unknown callback value', () => {
    expect(getGoogleChatAuthCallbackMessage('?googleChatAuth=other')).toBeNull();
  });
});
