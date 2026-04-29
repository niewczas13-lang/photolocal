import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const MANIFEST_FILE_NAME = 'manifest.json';
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

export interface ChatManifestFile {
  fileName: string;
  contentName: string;
  contentType: string;
}

export interface ChatManifest {
  source: 'google-chat';
  spaceName: string;
  spaceDisplayName: string;
  messageName: string;
  messageText: string;
  createTime: string;
  folderName: string;
  folderPath: string;
  files: ChatManifestFile[];
}

interface RawChatManifest {
  source?: unknown;
  spaceName?: unknown;
  spaceDisplayName?: unknown;
  messageName?: unknown;
  messageText?: unknown;
  createTime?: unknown;
  folderName?: unknown;
  files?: unknown;
}

interface RawChatManifestFile {
  fileName?: unknown;
  contentName?: unknown;
  contentType?: unknown;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isSupportedImage(fileName: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function normalizeFile(file: RawChatManifestFile): ChatManifestFile | null {
  const fileName = toStringValue(file.fileName);

  if (!fileName || !isSupportedImage(fileName)) {
    return null;
  }

  return {
    fileName,
    contentName: toStringValue(file.contentName),
    contentType: toStringValue(file.contentType),
  };
}

function normalizeFiles(value: unknown): ChatManifestFile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((file): file is RawChatManifestFile => file !== null && typeof file === 'object')
    .map(normalizeFile)
    .filter((file): file is ChatManifestFile => file !== null);
}

function contentTypeForFile(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

function messageTextFromFolderName(folderName: string): string {
  return folderName.replace(/^\d{4}-\d{2}-\d{2}_/, '').trim();
}

export async function readChatManifest(manifestPath: string): Promise<ChatManifest> {
  const rawText = await readFile(manifestPath, 'utf8');
  const raw = JSON.parse(rawText) as RawChatManifest;
  const source = raw.source === 'google-chat' ? raw.source : 'google-chat';

  return {
    source,
    spaceName: toStringValue(raw.spaceName),
    spaceDisplayName: toStringValue(raw.spaceDisplayName),
    messageName: toStringValue(raw.messageName),
    messageText: toStringValue(raw.messageText),
    createTime: toStringValue(raw.createTime),
    folderName: toStringValue(raw.folderName),
    folderPath: dirname(manifestPath),
    files: normalizeFiles(raw.files),
  };
}

async function collectManifestPaths(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await collectManifestPaths(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name === MANIFEST_FILE_NAME) {
      paths.push(entryPath);
    }
  }

  return paths;
}

export async function findChatManifests(rootPath: string): Promise<ChatManifest[]> {
  const manifestPaths = await collectManifestPaths(rootPath);
  manifestPaths.sort((left, right) => left.localeCompare(right));

  const manifests = await Promise.all(manifestPaths.map((manifestPath) => readChatManifest(manifestPath)));
  const manifestFolders = new Set(manifests.map((manifest) => manifest.folderPath));
  const legacyManifests = await collectLegacyManifests(rootPath, manifestFolders);

  return [...manifests, ...legacyManifests].sort((left, right) => left.folderPath.localeCompare(right.folderPath));
}

async function collectLegacyManifests(rootPath: string, manifestFolders: Set<string>): Promise<ChatManifest[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const imageFiles = files.filter(isSupportedImage).sort((left, right) => left.localeCompare(right));
  const manifests: ChatManifest[] = [];

  if (!manifestFolders.has(rootPath) && imageFiles.length > 0) {
    const folderName = basename(rootPath);
    manifests.push({
      source: 'google-chat',
      spaceName: '',
      spaceDisplayName: basename(dirname(rootPath)),
      messageName: `legacy-folder:${rootPath}`,
      messageText: messageTextFromFolderName(folderName),
      createTime: '',
      folderName,
      folderPath: rootPath,
      files: imageFiles.map((fileName) => ({
        fileName,
        contentName: fileName,
        contentType: contentTypeForFile(fileName),
      })),
    });
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      manifests.push(...(await collectLegacyManifests(join(rootPath, entry.name), manifestFolders)));
    }
  }

  return manifests;
}
