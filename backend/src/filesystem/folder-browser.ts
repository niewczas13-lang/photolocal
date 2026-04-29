import { readdir } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

export interface FolderBrowserEntry {
  name: string;
  path: string;
}

export interface FolderBrowserResult {
  currentPath: string;
  parentPath: string | null;
  entries: FolderBrowserEntry[];
}

export async function listFolders(inputPath?: string): Promise<FolderBrowserResult> {
  const currentPath = resolve(inputPath?.trim() || process.cwd());
  const root = parse(currentPath).root;
  const parentPath = currentPath === root ? null : dirname(currentPath);
  const entries = await readdir(currentPath, { withFileTypes: true });

  return {
    currentPath,
    parentPath,
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: resolve(currentPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'pl')),
  };
}
