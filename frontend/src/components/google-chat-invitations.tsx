import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search, UserPlus } from 'lucide-react';
import { api, ApiError } from '../api';
import type { GoogleChatBrowserSession, GoogleChatInvite, GoogleChatInviteSessionStatus } from '../types';
import { Button } from './ui/button';
import { GoogleChatBrowserDialog } from './google-chat-browser-dialog';

interface GoogleChatInvitationsProps {
  isBusy?: boolean;
  onJoined: () => Promise<void>;
}

export function GoogleChatInvitations({ isBusy = false, onJoined }: GoogleChatInvitationsProps) {
  const [invites, setInvites] = useState<GoogleChatInvite[]>([]);
  const [session, setSession] = useState<GoogleChatInviteSessionStatus | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [activity, setActivity] = useState<'find' | 'accept' | 'login' | null>(null);
  const [acceptingKey, setAcceptingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [browserSession, setBrowserSession] = useState<GoogleChatBrowserSession | null>(null);
  const currentRequest = useRef<AbortController | null>(null);
  const browserLease = useRef<GoogleChatBrowserSession | null>(null);

  useEffect(() => () => {
    currentRequest.current?.abort();
    if (browserLease.current) {
      void api.closeGoogleChatBrowser(browserLease.current.sessionId).catch(() => undefined);
      browserLease.current = null;
    }
  }, []);

  const reportError = (cause: unknown) => {
    setError(cause instanceof Error && cause.name === 'TimeoutError'
      ? 'Serwer nie odpowiedział na czas. Wyszukaj zaproszenia ponownie, aby sprawdzić ich stan.'
      : cause instanceof Error ? cause.message : 'Nie udało się obsłużyć zaproszeń.');
    if (cause instanceof ApiError && cause.code === 'BROWSER_LOGIN_REQUIRED') {
      setSession({ state: 'NEEDS_LOGIN', message: 'Wymagane logowanie Google.', url: null,
        title: null, checkedAt: new Date().toISOString() });
    }
  };

  const begin = (action: 'find' | 'accept' | 'login') => {
    if (currentRequest.current || isBusy || browserLease.current) return null;
    const controller = new AbortController();
    currentRequest.current = controller;
    setActivity(action);
    setError(null);
    setNotice(null);
    return controller;
  };
  const finish = (controller: AbortController) => {
    if (currentRequest.current === controller) currentRequest.current = null;
    if (!controller.signal.aborted) { setActivity(null); setAcceptingKey(null); }
  };

  const findInvites = async () => {
    const controller = begin('find');
    if (!controller) return;
    setInvites([]);
    setHasSearched(false);
    try {
      const result = await api.listGoogleChatInvites(controller.signal);
      if (controller.signal.aborted) return;
      setSession(result.session);
      setInvites(result.session.state === 'ACTIVE' ? result.invites : []);
      setHasSearched(true);
    } catch (cause) { if (!controller.signal.aborted) reportError(cause); }
    finally { finish(controller); }
  };

  const acceptInvite = async (invite: GoogleChatInvite) => {
    if (invite.canAccept === false) return;
    const controller = begin('accept');
    if (!controller) return;
    setAcceptingKey(invite.key);
    try {
      const result = await api.acceptGoogleChatInvite(invite.key, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.accepted) throw new Error('Nie potwierdzono przyjęcia zaproszenia. Wyszukaj zaproszenia ponownie.');
      setInvites(current => current.filter(candidate => candidate.key !== invite.key));
      setNotice(`Zaakceptowano zaproszenie do pokoju ${invite.roomName ?? 'Google Chat'}.`);
      try { await onJoined(); }
      catch {
        if (!controller.signal.aborted) setError('Zaproszenie przyjęto, ale nie udało się odświeżyć pokojów. Odśwież listę.');
      }
    } catch (cause) {
      if (!controller.signal.aborted) { setInvites([]); setHasSearched(false); reportError(cause); }
    } finally { finish(controller); }
  };

  const openBrowser = async () => {
    const controller = begin('login');
    if (!controller) return;
    try {
      const result = await api.startGoogleChatBrowser(controller.signal);
      if (controller.signal.aborted) {
        void api.closeGoogleChatBrowser(result.sessionId).catch(() => undefined);
        return;
      }
      browserLease.current = result;
      setBrowserSession(result);
      setInvites([]);
      setHasSearched(false);
    } catch (cause) { if (!controller.signal.aborted) reportError(cause); }
    finally { finish(controller); }
  };

  const closeBrowser = async () => {
    const lease = browserLease.current;
    if (!lease) return;
    browserLease.current = null;
    setBrowserSession(null);
    setActivity('login');
    try {
      await api.closeGoogleChatBrowser(lease.sessionId);
      setNotice('Okno logowania zamknięte. Kliknij „Znajdź zaproszenia”, aby sprawdzić konto.');
    } catch (cause) { reportError(cause); }
    finally { setActivity(null); }
  };

  const disabled = isBusy || activity !== null || browserSession !== null;
  return (
    <section aria-label="Zaproszenia Google Chat" className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">Zaproszenia do pokojów</h4>
          <p className="text-sm text-muted-foreground">Wyszukaj zaproszenia i zaakceptuj wybrany pokój.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={disabled} onClick={() => void openBrowser()}>
            {activity === 'login' ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
            Zaloguj Google w Romku
          </Button>
          <Button disabled={disabled} onClick={() => void findInvites()}>
            {activity === 'find' ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Znajdź zaproszenia
          </Button>
        </div>
      </div>
      {session?.state === 'NEEDS_LOGIN' && <p role="status" className="text-sm">
        Zaloguj to samo konto Google co do pobierania zdjęć, używając przycisku „Zaloguj Google w Romku”.
      </p>}
      {session?.state === 'UNKNOWN' && <p role="status" className="text-sm">{session.message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {hasSearched && session?.state === 'ACTIVE' && invites.length === 0 && (
        <p className="text-sm text-muted-foreground">Brak oczekujących zaproszeń.</p>
      )}
      {invites.map(invite => (
        <article key={invite.key} className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-background p-3">
          <div className="min-w-0 flex-1">
            <h5 className="break-words font-semibold">{invite.roomName ?? 'Pokój Google Chat'}</h5>
            {invite.senderEmail && <p className="break-words text-sm text-muted-foreground">Od: {invite.senderEmail}</p>}
            <p className="break-words text-sm text-muted-foreground">{invite.textPreview}</p>
            {invite.canAccept === false && <p className="mt-1 text-sm">{invite.reason ?? 'Nie można jednoznacznie rozpoznać tego zaproszenia.'}</p>}
          </div>
          <Button size="sm" disabled={disabled || invite.canAccept === false}
            aria-label={`Akceptuj zaproszenie: ${invite.roomName ?? 'Pokój Google Chat'}`}
            onClick={() => void acceptInvite(invite)}>
            {acceptingKey === invite.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
            Akceptuj
          </Button>
        </article>
      ))}
      {browserSession && <GoogleChatBrowserDialog session={browserSession} onClose={() => void closeBrowser()} />}
    </section>
  );
}
