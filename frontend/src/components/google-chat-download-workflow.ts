import type { GoogleChatDownloadStatus } from '../types';

interface GoogleChatDownloadWaitOptions {
  getStatus: () => Promise<GoogleChatDownloadStatus>;
  onStatus: (status: GoogleChatDownloadStatus) => void;
  wait: () => Promise<void>;
  isCurrent: () => boolean;
}

export async function waitForCompletedGoogleChatDownload(
  initialStatus: GoogleChatDownloadStatus,
  options: GoogleChatDownloadWaitOptions,
): Promise<GoogleChatDownloadStatus> {
  const assertCurrent = () => {
    if (!options.isCurrent()) throw new Error('Zmieniono projekt lub zamknięto panel.');
  };
  let status = initialStatus;
  assertCurrent();
  options.onStatus(status);
  while (status.state === 'RUNNING') {
    await options.wait();
    assertCurrent();
    status = await options.getStatus();
    assertCurrent();
    options.onStatus(status);
  }
  if (status.state !== 'COMPLETED') {
    throw new Error(status.error ?? getGoogleChatDownloadLabel(status.state));
  }
  return status;
}

export function canResumeGoogleChatDownload(status: GoogleChatDownloadStatus | null): boolean {
  return Boolean(status?.spaceName &&
    ['FAILED', 'AUTH_REQUIRED', 'PAUSED', 'PARTIAL_FAILURE'].includes(status.state));
}

export function canReplaceGoogleChatDownload(status: GoogleChatDownloadStatus | null): boolean {
  return status?.state !== 'RUNNING';
}

export function getGoogleChatImportRoot(
  defaultRoot: string,
  status: GoogleChatDownloadStatus,
): string {
  if (status.rootPath) return status.rootPath;
  const folderName = (status.spaceDisplayName ?? status.spaceName ?? 'brak_nazwy')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 200) || 'brak_nazwy';
  const separator = defaultRoot.includes('\\') ? '\\' : '/';
  return `${defaultRoot.replace(/[\\/]+$/g, '')}${separator}${folderName}`;
}

export function getGoogleChatDownloadLabel(state: GoogleChatDownloadStatus['state']): string {
  const labels: Record<GoogleChatDownloadStatus['state'], string> = {
    IDLE: 'Gotowe do pobierania',
    RUNNING: 'Pobieranie trwa',
    COMPLETED: 'Pobieranie zakończone',
    FAILED: 'Pobieranie przerwane',
    AUTH_REQUIRED: 'Wymagane ponowne połączenie Google',
    PAUSED: 'Pobieranie wstrzymane',
    PARTIAL_FAILURE: 'Nie pobrano wszystkich plików',
  };
  return labels[state];
}
