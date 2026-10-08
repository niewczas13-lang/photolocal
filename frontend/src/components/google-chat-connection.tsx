import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { GoogleChatAuthStatus } from '../types';
import { getGoogleChatAuthCallbackMessage, getGoogleChatAuthReturnPath } from './google-chat-auth-state';
import { Badge } from './ui/badge';
import { Button, buttonVariants } from './ui/button';

interface GoogleChatConnectionProps {
  status: GoogleChatAuthStatus | null;
  onStatusChange: (status: GoogleChatAuthStatus | null) => void;
  refreshKey: number;
  isBusy?: boolean;
}

export function GoogleChatConnection({
  status, onStatusChange, refreshKey, isBusy = false,
}: GoogleChatConnectionProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackMessage] = useState(() => typeof window === 'undefined'
    ? null : getGoogleChatAuthCallbackMessage(window.location.search));
  const connectController = useRef<AbortController | null>(null);
  const statusRequest = useRef<{ controller: AbortController; isExplicit: boolean } | null>(null);

  const refreshStatus = useCallback(async (isExplicit: boolean) => {
    if (!isExplicit && statusRequest.current?.isExplicit &&
        !statusRequest.current.controller.signal.aborted) return;
    statusRequest.current?.controller.abort();
    const request = { controller: new AbortController(), isExplicit };
    statusRequest.current = request;
    setIsChecking(true);
    try {
      const result = isExplicit
        ? await api.checkGoogleChatAuth(request.controller.signal)
        : await api.getGoogleChatAuthStatus(request.controller.signal);
      if (request.controller.signal.aborted) return;
      onStatusChange(result);
      setError(null);
    } catch (cause) {
      if (request.controller.signal.aborted) return;
      if (!isExplicit) onStatusChange(null);
      setError(cause instanceof Error ? cause.message : 'Nie udało się sprawdzić połączenia Google.');
    } finally {
      if (!request.controller.signal.aborted) setIsChecking(false);
      if (statusRequest.current === request) statusRequest.current = null;
    }
  }, [onStatusChange]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('googleChatAuth')) {
      window.history.replaceState(window.history.state, '', getGoogleChatAuthReturnPath(window.location));
    }
    return () => {
      connectController.current?.abort();
      statusRequest.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const onFocus = () => { void refreshStatus(false); };
    void refreshStatus(false);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshKey, refreshStatus]);

  const connect = async () => {
    if (connectController.current || !status?.canConnect) return;
    const controller = new AbortController();
    connectController.current = controller;
    setIsConnecting(true);
    setError(null);
    try {
      const result = await api.startGoogleChatAuth(
        getGoogleChatAuthReturnPath(window.location), controller.signal,
      );
      if (!controller.signal.aborted) window.location.assign(result.authorizationUrl);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Nie udało się otworzyć logowania Google.');
      }
    } finally {
      if (!controller.signal.aborted) {
        connectController.current = null;
        setIsConnecting(false);
      }
    }
  };

  const labels: Record<GoogleChatAuthStatus['state'], string> = {
    CONNECTED: 'Google połączone',
    AUTH_REQUIRED: 'Wymagane ponowne połączenie',
    NOT_CONNECTED: 'Google niepołączone',
    NOT_CONFIGURED: 'Brak konfiguracji',
  };

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3" aria-label="Połączenie Google">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">Połączenie Google do pobierania zdjęć</h4>
          <Badge variant={status?.state === 'AUTH_REQUIRED' ? 'destructive' : 'outline'}>
            {status ? labels[status.state] : 'Sprawdzanie połączenia'}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.canConnect && (
            <Button disabled={isBusy || isConnecting} onClick={() => void connect()}>
              {isConnecting ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
              {status.state === 'NOT_CONNECTED' ? 'Połącz Google' : 'Połącz ponownie Google'}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={isChecking || isConnecting}
            onClick={() => void refreshStatus(true)}
          >
            <RefreshCw size={16} className={isChecking ? 'animate-spin' : ''} />
            Sprawdź połączenie
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {status?.message ?? 'Sprawdzam dostęp do zdjęć z Google Chat.'}
      </p>
      <p className="text-xs text-muted-foreground">
        Logowanie otworzy się w tej przeglądarce. Sesja Google Chat w przeglądarce jest osobna
        i służy do akceptowania zaproszeń do pokojów.
      </p>
      {callbackMessage && <p role="status" className="text-sm">{callbackMessage}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

export function GoogleChatInvitesLink() {
  return (
    <section className="flex flex-col gap-3 rounded-md border p-3" aria-label="Zaproszenia Google Chat">
      <h4 className="text-sm font-semibold">Zaproszenia do pokojów</h4>
      <p className="text-sm text-muted-foreground">
        Otwórz Google Chat i zaakceptuj zaproszenie, korzystając z tego samego konta Google,
        które połączono z PhotoLocal. Po powrocie odśwież listę pokojów.
      </p>
      <a
        href="https://chat.google.com"
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ variant: 'outline', className: 'self-start' })}
      >
        <ExternalLink size={16} />
        Otwórz Google Chat
      </a>
    </section>
  );
}
