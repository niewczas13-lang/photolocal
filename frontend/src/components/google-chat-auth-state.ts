interface GoogleChatReturnLocation {
  pathname: string;
  search: string;
  hash: string;
}

export function getGoogleChatAuthReturnPath(location: GoogleChatReturnLocation): string {
  const search = new URLSearchParams(location.search);
  search.delete('googleChatAuth');
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

export function getGoogleChatAuthCallbackMessage(search: string): string | null {
  const result = new URLSearchParams(search).get('googleChatAuth');
  if (result === 'connected') {
    return 'Połączono Google. Jeśli pobieranie było przerwane, kliknij „Wznów pobieranie” poniżej.';
  }
  if (result === 'denied') return 'Anulowano zgodę Google. Możesz ponownie połączyć konto.';
  if (result === 'failed') return 'Nie udało się połączyć Google. Spróbuj ponownie.';
  return null;
}
