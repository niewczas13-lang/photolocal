import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Loader2, MessageSquare, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api';
import type {
  ChatAcceptReadyResult,
  ChatBatch,
  ChatClassificationStatus,
  ChatImportResult,
  GoogleChatDownloadStatus,
  GoogleChatInvite,
  GoogleChatInviteSessionStatus,
  GoogleChatSpace,
  ProjectSummary,
} from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { getSuggestedGoogleChatSpaces } from './chat-space-suggestions';

interface ChatImportPanelProps {
  projectId: string;
  project: ProjectSummary;
  batches: ChatBatch[];
  onChanged: () => Promise<void>;
}

type LastResult =
  | { type: 'import'; result: ChatImportResult }
  | { type: 'classify-started'; result: ChatClassificationStatus }
  | { type: 'accept'; result: ChatAcceptReadyResult }
  | { type: 'clear'; result: { cleared: number } }
  | null;

function safeFolderName(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 200) || 'brak_nazwy';
}

function formatElapsed(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'brak';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export default function ChatImportPanel({ projectId, project, batches, onChanged }: ChatImportPanelProps) {
  const [defaultChatRoot, setDefaultChatRoot] = useState('');
  const [assignedSpace, setAssignedSpace] = useState<GoogleChatSpace | null>(() =>
    project.googleChatSpaceName
      ? {
          name: project.googleChatSpaceName,
          displayName: project.googleChatSpaceDisplayName ?? project.googleChatSpaceName,
          spaceType: '',
        }
      : null,
  );
  const [isChangingSpace, setIsChangingSpace] = useState(false);
  const [lastDownloadAt, setLastDownloadAt] = useState<string | null>(project.googleChatLastDownloadAt);
  const [busyAction, setBusyAction] = useState<
    'spaces' | 'download' | 'clear' | 'classify' | 'accept' | 'invites' | 'invite-setup' | 'accept-invite' | null
  >(null);
  const [lastResult, setLastResult] = useState<LastResult>(null);
  const [classificationStatus, setClassificationStatus] = useState<ChatClassificationStatus | null>(null);
  const [spaces, setSpaces] = useState<GoogleChatSpace[]>([]);
  const [selectedSpaceName, setSelectedSpaceName] = useState('');
  const [downloadStatus, setDownloadStatus] = useState<GoogleChatDownloadStatus | null>(null);
  const [pendingAutoImportKey, setPendingAutoImportKey] = useState<string | null>(null);
  const [completedAutoImportKey, setCompletedAutoImportKey] = useState<string | null>(null);
  const [refreshedClassificationKey, setRefreshedClassificationKey] = useState<string | null>(null);
  const [invites, setInvites] = useState<GoogleChatInvite[]>([]);
  const [inviteProfileDir, setInviteProfileDir] = useState('');
  const [inviteSession, setInviteSession] = useState<GoogleChatInviteSessionStatus | null>(null);
  const [acceptingInviteKey, setAcceptingInviteKey] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      waiting: batches.filter((batch) => batch.status === 'WAITING_FOR_CLASSIFICATION').length,
      ready: batches.filter((batch) => batch.status === 'READY_FOR_IMPORT').length,
      review: batches.filter((batch) => batch.status === 'PENDING_REVIEW').length,
      imported: batches.filter((batch) => batch.status === 'IMPORTED').length,
      rejected: batches.filter((batch) => batch.status === 'REJECTED').length,
    }),
    [batches],
  );

  const suggestedSpaces = useMemo(() => getSuggestedGoogleChatSpaces(project, spaces), [project, spaces]);
  const selectedSpace = spaces.find((space) => space.name === selectedSpaceName);
  const activeDownloadSpace = assignedSpace && !isChangingSpace ? assignedSpace : selectedSpace;
  const showSpacePicker = !assignedSpace || isChangingSpace;

  const loadSpaces = async () => {
    setBusyAction('spaces');
    try {
      const result = await api.listGoogleChatSpaces();
      setSpaces(result);
      const [firstSuggested] = getSuggestedGoogleChatSpaces(project, result);
      if (firstSuggested?.space) setSelectedSpaceName(firstSuggested.space.name);
    } catch (error) {
      console.error(error);
      alert('Blad podczas pobierania listy pokojow Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const loadInvites = async () => {
    setBusyAction('invites');
    try {
      const result = await api.listGoogleChatInvites();
      setInvites(result.invites);
      setInviteProfileDir(result.profileDir);
      setInviteSession(result.session);
    } catch (error) {
      console.error(error);
      alert('Blad podczas pobierania zaproszen Google Chat. Jesli Chrome otworzyl sie pierwszy raz, zaloguj konto bota i sprobuj ponownie.');
    } finally {
      setBusyAction(null);
    }
  };

  const openInviteSetup = async () => {
    setBusyAction('invite-setup');
    try {
      const result = await api.openGoogleChatInviteSetup();
      setInviteProfileDir(result.profileDir);
      setInviteSession(result.session);
    } catch (error) {
      console.error(error);
      alert('Blad podczas otwierania Chrome do logowania Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const acceptInvite = async (invite: GoogleChatInvite) => {
    setBusyAction('accept-invite');
    setAcceptingInviteKey(invite.key);
    try {
      const result = await api.acceptGoogleChatInvite(invite.key);
      if (!result.accepted) {
        alert('Nie udalo sie zaakceptowac zaproszenia. Odswiez liste i sprobuj ponownie.');
      }
      await loadInvites();
    } catch (error) {
      console.error(error);
      alert('Blad podczas akceptacji zaproszenia Google Chat');
    } finally {
      setAcceptingInviteKey(null);
      setBusyAction(null);
    }
  };

  const startDownload = async () => {
    if (!activeDownloadSpace || !defaultChatRoot) return;
    setBusyAction('download');
    try {
      const result = await api.startGoogleChatDownload(projectId, activeDownloadSpace.name, activeDownloadSpace.displayName);
      setDownloadStatus(result);
      setAssignedSpace(activeDownloadSpace);
      setLastDownloadAt(result.startedAt ?? new Date().toISOString());
      setIsChangingSpace(false);
      setPendingAutoImportKey(result.startedAt ?? null);
      setCompletedAutoImportKey(null);
    } catch (error) {
      console.error(error);
      alert('Blad podczas startu pobierania z Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (action: 'classify' | 'accept') => {
    setBusyAction(action);
    try {
      if (action === 'classify') {
        setClassificationStatus({ state: 'RUNNING', processed: 0, total: counts.waiting });
        const result = await api.classifyChatBatches(projectId);
        setLastResult({ type: 'classify-started', result });
        setClassificationStatus(result);
      }
      if (action === 'accept') {
        const result = await api.acceptReadyChatBatches(projectId);
        setLastResult({ type: 'accept', result });
      }
      await onChanged();
    } catch (error) {
      console.error(error);
      alert('Blad podczas operacji importu z Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const clearQueues = async () => {
    const toClear = counts.waiting + counts.ready + counts.review;
    if (toClear === 0) return;
    const confirmed = window.confirm(
      `Wyczyscic kolejke Qwen, Do importu i Review? Usunietych zostanie ${toClear} paczek roboczych.`,
    );
    if (!confirmed) return;

    setBusyAction('clear');
    try {
      const result = await api.clearChatQueues(projectId);
      setLastResult({ type: 'clear', result });
      await onChanged();
    } catch (error) {
      console.error(error);
      alert('Blad podczas czyszczenia kolejek Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const config = await api.getConfig();
        if (!cancelled) {
          setDefaultChatRoot(config.googleChatDownloadRoot);
        }
      } catch (error) {
        console.error(error);
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAssignedSpace(
      project.googleChatSpaceName
        ? {
            name: project.googleChatSpaceName,
            displayName: project.googleChatSpaceDisplayName ?? project.googleChatSpaceName,
            spaceType: '',
          }
        : null,
    );
    setLastDownloadAt(project.googleChatLastDownloadAt);
    setIsChangingSpace(false);
  }, [project.googleChatLastDownloadAt, project.googleChatSpaceDisplayName, project.googleChatSpaceName, projectId]);

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = async () => {
      try {
        const status = await api.getChatClassificationStatus(projectId);
        if (!cancelled) setClassificationStatus(status);
      } catch (error) {
        console.error(error);
      }
    };

    void refreshStatus();
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId]);

  useEffect(() => {
    if (
      classificationStatus?.state !== 'COMPLETED' ||
      !classificationStatus.finishedAt ||
      refreshedClassificationKey === classificationStatus.finishedAt
    ) {
      return;
    }

    setRefreshedClassificationKey(classificationStatus.finishedAt);
    void onChanged();
  }, [classificationStatus, onChanged, refreshedClassificationKey]);

  useEffect(() => {
    if (
      downloadStatus?.state !== 'COMPLETED' ||
      downloadStatus.projectId !== projectId ||
      !downloadStatus.startedAt ||
      downloadStatus.startedAt !== pendingAutoImportKey ||
      completedAutoImportKey === downloadStatus.startedAt ||
      !defaultChatRoot
    ) {
      return;
    }

    const importDownloaded = async () => {
      setCompletedAutoImportKey(downloadStatus.startedAt ?? null);
      const downloadRoot = `${defaultChatRoot}\\${safeFolderName(downloadStatus.spaceDisplayName ?? '')}`;
      try {
        const result = await api.importChatFolders(projectId, downloadRoot);
        setLastResult({ type: 'import', result });
        await onChanged();
      } catch (error) {
        console.error(error);
        alert('Pobieranie zakonczone, ale import paczek z folderu Google Chat nie powiodl sie');
      }
    };

    void importDownloaded();
  }, [completedAutoImportKey, defaultChatRoot, downloadStatus, onChanged, pendingAutoImportKey, projectId]);

  useEffect(() => {
    let cancelled = false;

    const refreshDownloadStatus = async () => {
      try {
        const status = await api.getGoogleChatDownloadStatus(projectId);
        if (!cancelled) setDownloadStatus(status);
      } catch (error) {
        console.error(error);
      }
    };

    void refreshDownloadStatus();
    const interval = window.setInterval(() => {
      void refreshDownloadStatus();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId]);

  const progressPercent =
    classificationStatus && classificationStatus.total > 0
      ? Math.round((classificationStatus.processed / classificationStatus.total) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-4 flex flex-col gap-4">
          <div>
            <h3 className="text-lg font-semibold">Import z Google Chat</h3>
            <p className="text-sm text-muted-foreground">
              Pobierz zdjecia z pokoju, a paczki same trafia do kolejki Qwen, Do importu albo Review.
            </p>
          </div>

          <div className="rounded-md border p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="font-semibold text-sm">Zaproszenia do pokojow</h4>
                <p className="text-sm text-muted-foreground">
                  Laduje widok Google Chat z filtrem pokojow, do ktorych konto bota jeszcze nie dolaczylo.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busyAction !== null} onClick={() => void openInviteSetup()}>
                  {busyAction === 'invite-setup' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <UserPlus size={16} className="mr-2" />}
                  Otworz logowanie
                </Button>
                <Button variant="outline" disabled={busyAction !== null} onClick={() => void loadInvites()}>
                  {busyAction === 'invites' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <RefreshCw size={16} className="mr-2" />}
                  Zaladuj zaproszenia
                </Button>
              </div>
            </div>

            <div className="rounded-md bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Profil sesji Chrome</p>
                {inviteSession && (
                  <Badge
                    variant={
                      inviteSession.state === 'ACTIVE'
                        ? 'outline'
                        : inviteSession.state === 'NEEDS_LOGIN'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {inviteSession.state === 'ACTIVE'
                      ? 'Sesja aktywna'
                      : inviteSession.state === 'NEEDS_LOGIN'
                        ? 'Trzeba sie zalogowac'
                        : 'Status niepewny'}
                  </Badge>
                )}
              </div>
              <p className="break-all text-muted-foreground">
                {inviteProfileDir || 'Zostanie pokazany po pierwszym zaladowaniu zaproszen.'}
              </p>
              <p className="mt-2 text-muted-foreground">
                {inviteSession?.message ??
                  'Najpierw kliknij Otworz logowanie. Chrome zostanie otwarty i nie zamknie sie automatycznie, wiec spokojnie zaloguj konto bota. Potem kliknij Zaladuj zaproszenia.'}
              </p>
              {inviteSession?.url && <p className="mt-1 break-all text-xs text-muted-foreground">{inviteSession.url}</p>}
            </div>

            {invites.length > 0 ? (
              <div className="grid gap-2">
                {invites.map((invite) => (
                  <div key={invite.key} className="min-w-0 rounded-md border bg-background p-3 text-sm flex flex-col gap-2 overflow-hidden">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold break-words">{invite.roomName ?? 'Pokoj Google Chat'}</p>
                        <p className="text-muted-foreground break-words">
                          Zaproszenie od: {invite.senderEmail ?? 'nie wykryto maila'}
                        </p>
                      </div>
                    </div>
                    <p className="max-h-12 overflow-hidden break-words text-muted-foreground">{invite.textPreview}</p>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={busyAction !== null}
                        onClick={() => void acceptInvite(invite)}
                      >
                        {acceptingInviteKey === invite.key ? (
                          <Loader2 size={16} className="mr-2 animate-spin" />
                        ) : (
                          <CheckCircle2 size={16} className="mr-2" />
                        )}
                        Dolacz
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Brak zaladowanych zaproszen. Kliknij zaladowanie, zeby odczytac aktualna liste z Google Chat.
              </p>
            )}

          </div>

          <div className="rounded-md border p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="font-semibold text-sm">Pobieranie z Google Chat</h4>
                <p className="text-sm text-muted-foreground">
                  {assignedSpace && !isChangingSpace
                    ? 'Ten projekt ma juz przypisany pokoj. Aktualizacja sprawdzi, czy doszly nowe zdjecia.'
                    : 'Wybierz pokoj i pobierz zdjecia bez odpalania skryptu bokiem.'}
                </p>
              </div>
              {showSpacePicker && (
                <Button variant="outline" disabled={busyAction !== null} onClick={() => void loadSpaces()}>
                  {busyAction === 'spaces' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <RefreshCw size={16} className="mr-2" />}
                  Zaladuj pokoje
                </Button>
              )}
            </div>

            {assignedSpace && !isChangingSpace ? (
              <div className="rounded-md border bg-muted/20 p-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Przypisany pokoj</p>
                  <p className="break-words font-semibold">{assignedSpace.displayName}</p>
                  <p className="break-all text-xs text-muted-foreground">{assignedSpace.name}</p>
                  <p className="text-xs text-muted-foreground">Ostatnie pobranie: {formatDateTime(lastDownloadAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!defaultChatRoot || busyAction !== null} onClick={() => void startDownload()}>
                    {busyAction === 'download' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <MessageSquare size={16} className="mr-2" />}
                    Zaktualizuj zdjecia
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setIsChangingSpace(true);
                      void loadSpaces();
                    }}
                  >
                    Zmien pokoj
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid md:grid-cols-[1fr_auto] gap-3">
                <select
                  value={selectedSpaceName}
                  onChange={(event) => setSelectedSpaceName(event.target.value)}
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                >
                  <option value="">Wybierz pokoj</option>
                  {suggestedSpaces.map(({ space, isSuggested }) => (
                    <option key={space.name} value={space.name}>
                      {isSuggested ? '★ ' : ''}
                      {space.displayName} ({space.name})
                    </option>
                  ))}
                </select>
                <Button disabled={!selectedSpace || !defaultChatRoot || busyAction !== null} onClick={() => void startDownload()}>
                  {busyAction === 'download' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <MessageSquare size={16} className="mr-2" />}
                  {assignedSpace ? 'Pobierz i zmien pokoj' : 'Pobierz zdjecia'}
                </Button>
              </div>
            )}

            {downloadStatus && downloadStatus.state !== 'IDLE' && (
              <div className="rounded-md bg-muted/30 p-3 text-sm flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">Pobieranie: {downloadStatus.state}</span>
                  {downloadStatus.spaceDisplayName && (
                    <span className="text-muted-foreground">{downloadStatus.spaceDisplayName}</span>
                  )}
                </div>
                {downloadStatus.error && <p className="text-destructive">{downloadStatus.error}</p>}
                {downloadStatus.recentLines.length > 0 && (
                  <pre className="max-h-36 overflow-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">
                    {downloadStatus.recentLines.join('\n')}
                  </pre>
                )}
              </div>
            )}
          </div>

          <div className="grid sm:grid-cols-5 gap-2">
            <Badge variant="outline" className="justify-center py-2">Czeka na Qwen: {counts.waiting}</Badge>
            <Badge variant="outline" className="justify-center py-2">Do importu: {counts.ready}</Badge>
            <Badge variant="outline" className="justify-center py-2">Review: {counts.review}</Badge>
            <Badge variant="outline" className="justify-center py-2">Zaimportowane: {counts.imported}</Badge>
            <Badge variant="outline" className="justify-center py-2">Odrzucone: {counts.rejected}</Badge>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busyAction !== null} onClick={() => void runAction('classify')}>
              {busyAction === 'classify' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Bot size={16} className="mr-2" />}
              Weryfikuj Qwen
            </Button>
            <Button variant="secondary" disabled={busyAction !== null} onClick={() => void runAction('accept')}>
              {busyAction === 'accept' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <CheckCircle2 size={16} className="mr-2" />}
              Importuj zaakceptowane
            </Button>
            <Button
              variant="destructive"
              disabled={busyAction !== null || counts.waiting + counts.ready + counts.review === 0}
              onClick={() => void clearQueues()}
            >
              {busyAction === 'clear' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Trash2 size={16} className="mr-2" />}
              Wyczysc kolejki
            </Button>
          </div>

          {lastResult && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              {lastResult.type === 'import' && (
                <span>
                  Import: {lastResult.result.imported} paczek, do Qwena: {lastResult.result.waitingForClassification},
                  review: {lastResult.result.pendingReview}, wyczyszczono stara kolejke: {lastResult.result.cleared}.
                </span>
              )}
              {lastResult.type === 'classify-started' && (
                <span>
                  Qwen wystartowal w tle. Postep widac ponizej.
                </span>
              )}
              {lastResult.type === 'accept' && (
                <span>
                  Auto-akceptacja: paczki {lastResult.result.importedBatches}, zdjecia {lastResult.result.importedPhotos},
                  pominiete: {lastResult.result.skippedBatches}.
                </span>
              )}
              {lastResult.type === 'clear' && (
                <span>Wyczyszczono kolejki robocze: {lastResult.result.cleared} paczek.</span>
              )}
            </div>
          )}

          {classificationStatus && classificationStatus.state !== 'IDLE' && (
            <div className="rounded-md border p-3 text-sm flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  Qwen: {classificationStatus.state === 'RUNNING' ? 'pracuje' : classificationStatus.state}
                </span>
                <span className="text-muted-foreground">
                  {classificationStatus.processed}/{classificationStatus.total}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
              {classificationStatus.currentFolderName && (
                <div className="rounded-md bg-muted/30 p-2 text-sm">
                  <p className="font-medium">Aktualnie: {classificationStatus.currentFolderName}</p>
                  <p className="text-muted-foreground">
                    {classificationStatus.currentStep ?? 'Przetwarzanie'} · czas paczki:{' '}
                    {formatElapsed(classificationStatus.currentElapsedMs)}
                  </p>
                </div>
              )}
              {classificationStatus.state === 'RUNNING' && (
                <p className="text-muted-foreground">Model moze zajac VRAM i CPU/GPU do konca tej operacji.</p>
              )}
              {classificationStatus.diagnostics && (
                <div className="rounded-md border bg-muted/20 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Ollama debug</span>
                    <Badge variant={classificationStatus.diagnostics.ollamaReachable ? 'outline' : 'destructive'}>
                      {classificationStatus.diagnostics.ollamaReachable ? 'polaczona' : 'brak polaczenia'}
                    </Badge>
                    <Badge variant={classificationStatus.diagnostics.modelLoaded ? 'outline' : 'secondary'}>
                      {classificationStatus.diagnostics.modelLoaded ? 'model zaladowany' : 'model niezaladowany'}
                    </Badge>
                  </div>
                  <div className="mt-2 grid gap-1 text-muted-foreground md:grid-cols-2">
                    <span>Model: {classificationStatus.diagnostics.model}</span>
                    <span>Processor: {classificationStatus.diagnostics.processor ?? 'brak danych z Ollamy'}</span>
                    <span>VRAM modelu: {classificationStatus.diagnostics.sizeVram ?? 'brak danych'}</span>
                    <span>Rozmiar modelu: {classificationStatus.diagnostics.size ?? 'brak danych'}</span>
                    {classificationStatus.diagnostics.gpu && (
                      <>
                        <span>GPU: {classificationStatus.diagnostics.gpu.name}</span>
                        <span>
                          Uzycie GPU: {classificationStatus.diagnostics.gpu.utilizationGpuPercent ?? '?'}%
                        </span>
                        <span>
                          VRAM karty: {classificationStatus.diagnostics.gpu.memoryUsedMiB ?? '?'} /
                          {classificationStatus.diagnostics.gpu.memoryTotalMiB ?? '?'} MB
                        </span>
                        <span>Temp: {classificationStatus.diagnostics.gpu.temperatureC ?? '?'}°C</span>
                      </>
                    )}
                  </div>
                  {classificationStatus.diagnostics.error && (
                    <p className="mt-2 text-amber-700">{classificationStatus.diagnostics.error}</p>
                  )}
                </div>
              )}
              {classificationStatus.error && <p className="text-destructive">{classificationStatus.error}</p>}
              {classificationStatus.recentDecisions && classificationStatus.recentDecisions.length > 0 && (
                <div className="mt-2 flex flex-col gap-2 border-t pt-3">
                  <span className="font-medium">Ostatnie decyzje debug</span>
                  {classificationStatus.recentDecisions.map((decision, index) => (
                    <div key={`${decision.folderName}-${index}`} className="rounded-md bg-muted/40 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{decision.folderName}</span>
                        <Badge variant="outline">{decision.status}</Badge>
                        <Badge variant="outline">{decision.reserveLocation}</Badge>
                        <span className="text-muted-foreground">conf {decision.confidence.toFixed(2)}</span>
                      </div>
                      <p className="text-muted-foreground">
                        Opis: {decision.messageText || 'brak'}; dopasowanie:{' '}
                        {decision.matchedChecklistNodeName ?? 'brak jednoznacznego'}
                      </p>
                      {decision.reviewReason && <p className="text-amber-700">Powod: {decision.reviewReason}</p>}
                      {decision.visualEvidence.length > 0 && (
                        <p className="text-muted-foreground">Dowody: {decision.visualEvidence.join(', ')}</p>
                      )}
                      {decision.rawResponsePreview && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-muted-foreground">Raw JSON</summary>
                          <pre className="mt-1 max-h-28 overflow-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">
                            {decision.rawResponsePreview}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
