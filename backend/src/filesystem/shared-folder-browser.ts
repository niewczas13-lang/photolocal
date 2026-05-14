import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
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
  const candidate = resolve(candidatePath).toLowerCase();
  const root = resolve(rootPath).toLowerCase();
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export async function listSharedFolderChildren(path: string): Promise<SharedFolderListResult> {
  const roots = await listSharedFolderRoots();
  const root = roots.find((entry) => isPathInside(path, entry.path));
  if (!root) {
    throw new Error('Folder musi byc na zmapowanym dysku udostepnionym');
  }

  const currentPath = resolve(path);
  const entries = await readdir(currentPath, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(currentPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'pl'));

  const parentCandidate = dirname(currentPath);
  const parentPath =
    parentCandidate !== currentPath && isPathInside(parentCandidate, root.path) && basename(currentPath)
      ? parentCandidate
      : null;

  return {
    currentPath,
    parentPath,
    entries: folders,
  };
}
