import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Download, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type {
  ChatAcceptReadyResult,
  ChatBatch,
  ChatClassificationStatus,
  ChatImportResult,
  GoogleChatDownloadStatus,
  GoogleChatSpace,
} from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';

interface ChatImportPanelProps {
  projectId: string;
  batches: ChatBatch[];
  onChanged: () => Promise<void>;
}

type LastResult =
  | { type: 'import'; result: ChatImportResult }
  | { type: 'classify-started'; result: ChatClassificationStatus }
  | { type: 'accept'; result: ChatAcceptReadyResult }
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

export default function ChatImportPanel({ projectId, batches, onChanged }: ChatImportPanelProps) {
  const [defaultChatRoot, setDefaultChatRoot] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [busyAction, setBusyAction] = useState<'spaces' | 'download' | 'import' | 'classify' | 'accept' | null>(null);
  const [lastResult, setLastResult] = useState<LastResult>(null);
  const [classificationStatus, setClassificationStatus] = useState<ChatClassificationStatus | null>(null);
  const [spaces, setSpaces] = useState<GoogleChatSpace[]>([]);
  const [selectedSpaceName, setSelectedSpaceName] = useState('');
  const [downloadStatus, setDownloadStatus] = useState<GoogleChatDownloadStatus | null>(null);
  const [pendingAutoImportKey, setPendingAutoImportKey] = useState<string | null>(null);
  const [completedAutoImportKey, setCompletedAutoImportKey] = useState<string | null>(null);

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

  const selectedSpace = spaces.find((space) => space.name === selectedSpaceName);

  const loadSpaces = async () => {
    setBusyAction('spaces');
    try {
      const result = await api.listGoogleChatSpaces();
      setSpaces(result);
      if (!selectedSpaceName && result[0]) setSelectedSpaceName(result[0].name);
    } catch (error) {
      console.error(error);
      alert('Blad podczas pobierania listy pokojow Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const startDownload = async () => {
    if (!selectedSpace || !defaultChatRoot) return;
    setBusyAction('download');
    try {
      const result = await api.startGoogleChatDownload(projectId, selectedSpace.name, selectedSpace.displayName);
      setDownloadStatus(result);
      setPendingAutoImportKey(result.startedAt ?? null);
      setCompletedAutoImportKey(null);
      setRootPath(`${defaultChatRoot}\\${safeFolderName(selectedSpace.displayName)}`);
    } catch (error) {
      console.error(error);
      alert('Blad podczas startu pobierania z Google Chat');
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (action: 'import' | 'classify' | 'accept') => {
    setBusyAction(action);
    try {
      if (action === 'import') {
        const result = await api.importChatFolders(projectId, rootPath);
        setLastResult({ type: 'import', result });
      }
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

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const config = await api.getConfig();
        if (!cancelled) {
          setDefaultChatRoot(config.googleChatDownloadRoot);
          setRootPath((current) => current || config.googleChatDownloadRoot);
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
      setRootPath(downloadRoot);
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
              Wskaz folder z pobranymi paczkami, potem uruchom klasyfikacje. Pewne wyniki trafia do zakladki Do importu.
            </p>
          </div>

          <div className="rounded-md border p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="font-semibold text-sm">Pobieranie z Google Chat</h4>
                <p className="text-sm text-muted-foreground">Wybierz pokoj i pobierz zdjecia bez odpalania skryptu bokiem.</p>
              </div>
              <Button variant="outline" disabled={busyAction !== null} onClick={() => void loadSpaces()}>
                {busyAction === 'spaces' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <RefreshCw size={16} className="mr-2" />}
                Zaladuj pokoje
              </Button>
            </div>

            <div className="grid md:grid-cols-[1fr_auto] gap-3">
              <select
                value={selectedSpaceName}
                onChange={(event) => setSelectedSpaceName(event.target.value)}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
              >
                <option value="">Wybierz pokoj</option>
                {spaces.map((space) => (
                  <option key={space.name} value={space.name}>
                    {space.displayName} ({space.name})
                  </option>
                ))}
              </select>
              <Button disabled={!selectedSpace || !defaultChatRoot || busyAction !== null} onClick={() => void startDownload()}>
                {busyAction === 'download' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <MessageSquare size={16} className="mr-2" />}
                Pobierz zdjecia
              </Button>
            </div>

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

          <div className="grid md:grid-cols-[1fr_auto] gap-3">
            <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} />
            <Button disabled={!rootPath.trim() || busyAction !== null} onClick={() => void runAction('import')}>
              {busyAction === 'import' ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Download size={16} className="mr-2" />}
              Importuj paczki
            </Button>
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
          </div>

          {lastResult && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              {lastResult.type === 'import' && (
                <span>
                  Import: {lastResult.result.imported} paczek, do Qwena: {lastResult.result.waitingForClassification},
                  review: {lastResult.result.pendingReview}.
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
                <p className="text-muted-foreground">Aktualnie: {classificationStatus.currentFolderName}</p>
              )}
              {classificationStatus.state === 'RUNNING' && (
                <p className="text-muted-foreground">Model moze zajac VRAM i CPU/GPU do konca tej operacji.</p>
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
