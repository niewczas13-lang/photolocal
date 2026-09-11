import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SharedFolderRoot {
  path: string;
  label: string;
  providerName: string | null;
}

export interface SharedFolderEntry {
  name: string;
  path: string;
}

export interface SharedFolderListResult {
  currentPath: string;
  parentPath: string | null;
  entries: SharedFolderEntry[];
}

export interface SharedFolderCreateResult {
  path: string;
}

interface LogicalDiskRow {
  DeviceID?: string;
  ProviderName?: string | null;
  VolumeName?: string | null;
}

function asArray<T>(value: T | T[] | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function driveRoot(deviceId: string): string {
  return `${deviceId.replace(/[\\/]$/, '')}\\`;
}

export async function listSharedFolderRoots(): Promise<SharedFolderRoot[]> {
  const configuredRoots = process.env.PHOTO_LOCAL_SHARED_ROOTS;
  if (configuredRoots !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(configuredRoots);
    } catch {
      throw new Error('PHOTO_LOCAL_SHARED_ROOTS musi byc tablica JSON katalogow');
    }
    if (!Array.isArray(value)) {
      throw new Error('PHOTO_LOCAL_SHARED_ROOTS musi byc tablica JSON katalogow');
    }
    return Promise.all(value.map(async (entry: unknown): Promise<SharedFolderRoot> => {
      if (
        !entry || typeof entry !== 'object' || !('path' in entry) ||
        typeof entry.path !== 'string' || !isAbsolute(entry.path) ||
        ('label' in entry && typeof entry.label !== 'string')
      ) {
        throw new Error('PHOTO_LOCAL_SHARED_ROOTS wymaga bezwzglednej sciezki i opcjonalnej etykiety');
      }
      const path = await realpath(entry.path);
      if (!(await stat(path)).isDirectory()) {
        throw new Error('PHOTO_LOCAL_SHARED_ROOTS moze wskazywac tylko katalogi');
      }
      const label = 'label' in entry && typeof entry.label === 'string' ? entry.label.trim() : '';
      return { path, label: label || basename(path) || path, providerName: null };
    }));
  }
  if (process.platform !== 'win32') return [];

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=4" |
  Select-Object DeviceID, ProviderName, VolumeName |
  ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const rows = asArray(JSON.parse(trimmed) as LogicalDiskRow | LogicalDiskRow[]);
  return rows
    .filter((row) => row.DeviceID)
    .map((row) => {
      const root = driveRoot(row.DeviceID!);
      const name = row.VolumeName?.trim() || row.ProviderName?.trim() || 'Dysk udostepniony';
      return {
        path: root,
        label: `${name} (${row.DeviceID})`,
        providerName: row.ProviderName?.trim() || null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  // node:path follows the host's case sensitivity (win32 versus POSIX).
  const difference = relative(resolve(rootPath), resolve(candidatePath));
  return difference === '' || (
    difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
  );
}

async function resolveSharedFolder(path: string): Promise<{ currentPath: string; rootPath: string }> {
  const roots = await listSharedFolderRoots();
  for (const root of roots) {
    const rootPath = await realpath(root.path).catch(() => null);
    if (!rootPath || (!isPathInside(path, root.path) && !isPathInside(path, rootPath))) continue;
    const currentPath = await realpath(path);
    if (isPathInside(currentPath, rootPath)) return { currentPath, rootPath };
  }
  throw new Error('Folder musi byc w katalogu udostepnionym');
}

export async function listSharedFolderChildren(path: string): Promise<SharedFolderListResult> {
  const { currentPath, rootPath } = await resolveSharedFolder(path);
  const entries = await readdir(currentPath, { withFileTypes: true });
  const candidates = await Promise.all(entries.map(async (entry): Promise<SharedFolderEntry | null> => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
    const childPath = resolve(currentPath, entry.name);
    try {
      const canonicalPath = await realpath(childPath);
      if (!isPathInside(canonicalPath, rootPath) || !(await stat(canonicalPath)).isDirectory()) {
        return null;
      }
      return { name: entry.name, path: childPath };
    } catch {
      // A disappearing or unreadable child must not break the entire listing.
      return null;
    }
  }));
  const folders = candidates
    .filter((entry): entry is SharedFolderEntry => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name, 'pl'));

  const parentCandidate = dirname(currentPath);
  const parentPath =
    parentCandidate !== currentPath && isPathInside(parentCandidate, rootPath) && basename(currentPath)
      ? parentCandidate
      : null;

  return {
    currentPath,
    parentPath,
    entries: folders,
  };
}

function validateFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Nazwa folderu jest wymagana');
  }
  if (trimmed === '.' || trimmed === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) {
    throw new Error('Nazwa folderu zawiera niedozwolone znaki');
  }
  return trimmed;
}

export async function createSharedFolder(parentPath: string, folderName: string): Promise<SharedFolderCreateResult> {
  const { currentPath, rootPath } = await resolveSharedFolder(parentPath);
  const safeName = validateFolderName(folderName);
  const targetPath = resolve(currentPath, safeName);
  if (!isPathInside(targetPath, rootPath)) {
    throw new Error('Nie mozna utworzyc folderu poza katalogiem udostepnionym');
  }

  await mkdir(targetPath, { recursive: false });
  return { path: targetPath };
}
