import { useEffect, useRef, useState } from 'react';
import type { GoogleChatBrowserSession } from '../types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface GoogleChatBrowserDialogProps {
  session: GoogleChatBrowserSession;
  onClose: () => void;
}

export function GoogleChatBrowserDialog({ session, onClose }: GoogleChatBrowserDialogProps) {
  const screen = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let client: import('@novnc/novnc').default | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const expectedPath = `/api/google-chat/invites/browser/${encodeURIComponent(session.sessionId)}/socket`;
        if (session.websocketPath !== expectedPath) throw new Error('Nieprawidłowy adres okna logowania.');
        const url = new URL(expectedPath, window.location.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const { default: RFB } = await import('@novnc/novnc');
        if (cancelled || !screen.current) return;
        client = new RFB(screen.current, url.toString(), { shared: false });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.addEventListener('connect', () => {
          if (!cancelled) { clearTimeout(timeout); setState('connected'); }
        });
        client.addEventListener('disconnect', () => {
          if (!cancelled) {
            clearTimeout(timeout);
            setState('disconnected');
            setError('Połączenie z oknem logowania zakończyło się. Zamknij je i otwórz ponownie.');
          }
        });
        client.addEventListener('securityfailure', () => {
          if (!cancelled) setError('Nie udało się połączyć z przeglądarką Google.');
        });
        timeout = setTimeout(() => {
          if (!cancelled) {
            client?.disconnect();
            setState('disconnected');
            setError('Okno logowania nie odpowiada. Sprawdź połączenie aplikacji z przeglądarką.');
          }
        }, 20_000);
      } catch (cause) {
        if (!cancelled) {
          setState('disconnected');
          setError(cause instanceof Error ? cause.message : 'Nie można otworzyć logowania Google.');
        }
      }
    };
    void connect();
    return () => { cancelled = true; clearTimeout(timeout); client?.disconnect(); };
  }, [session.sessionId, session.websocketPath]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[1100px] max-h-[95dvh] overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Logowanie Google do zaproszeń</DialogTitle>
          <DialogDescription>
            Zaloguj to samo konto Google co do pobierania zdjęć. Po zalogowaniu zamknij to okno
            i kliknij „Znajdź zaproszenia”. Sesja logowania trwa do 10 minut.
          </DialogDescription>
        </DialogHeader>
        <p role="status" className="text-sm text-muted-foreground">
          {state === 'connecting' ? 'Łączenie z przeglądarką…' : state === 'connected'
            ? 'Okno Google jest gotowe. Kliknij w nie, aby używać klawiatury.' : 'Połączenie zakończone.'}
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div ref={screen} className="h-[min(65dvh,650px)] w-full overflow-hidden rounded-md bg-neutral-900" />
        <div className="flex justify-end">
          <Button onClick={onClose}>Zamknij okno logowania</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
