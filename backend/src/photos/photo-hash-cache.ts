import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif',
]);

export interface PhotoHashProgressEvent {
  phase: 'counting' | 'hashing' | 'done';
  projectId: string | null;
  projectName: string | null;
  processed: number;
  total: number;
  percent: number;
  currentPath: string | null;
  message: string;
}

export interface HashProjectPhotoFoldersOptions {
  projectIds?: string[];
  onProgress?: (event: PhotoHashProgressEvent) => void;
}

export interface HashProjectPhotoFoldersResult {
  projectCount: number;
  filesFound: number;
  hashedFiles: number;
  skippedUnchanged: number;
  updatedPhotoRows: number;
  duplicateGroups: number;
  duplicateFiles: number;
  errorCount: number;
  errors: Array<{ projectId: string; path: string; message: string }>;
}

interface ProjectFolderRow {
  id: string;
  name: string;
  baseFolder: string;
}

interface CacheRow {
  contentHash: string;
  fileSize: number | null;
  modifiedMtimeMs: number | null;
}

interface PhotoHashRow {
  id: string;
  contentHash: string | null;
  storagePath: string;
  baseFolder: string;
}

interface RejectedChatFileHashRow {
  id: string;
  contentHash: string | null;
  sourcePath: string;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isSupportedImagePath(path: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isInsideFolder(path: string, folder: string): boolean {
  if (!path || !folder) return false;
  const relativePath = relative(folder, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function collectImageFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];

  const entries = readdirSync(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.thumbnails') continue;
      files.push(...collectImageFiles(entryPath));
      continue;
    }
    if (entry.isFile() && isSupportedImagePath(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function progressPercent(processed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.round((processed / total) * 100));
}

function listProjectRows(db: Database.Database, projectIds: string[] | undefined): ProjectFolderRow[] {
  if (!projectIds || projectIds.length === 0) {
    return db
      .prepare(
        `SELECT id, name, base_folder AS baseFolder
         FROM projects
         ORDER BY updated_at DESC, name ASC`,
      )
      .all() as ProjectFolderRow[];
  }

  const placeholders = projectIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, name, base_folder AS baseFolder
       FROM projects
       WHERE id IN (${placeholders})
       ORDER BY updated_at DESC, name ASC`,
    )
    .all(...projectIds) as ProjectFolderRow[];
}

export async function hashProjectPhotoFolders(
  db: Database.Database,
  options: HashProjectPhotoFoldersOptions = {},
): Promise<HashProjectPhotoFoldersResult> {
  const projects = listProjectRows(db, options.projectIds);
  const projectFiles = new Map<string, string[]>();
  const result: HashProjectPhotoFoldersResult = {
    projectCount: projects.length,
    filesFound: 0,
    hashedFiles: 0,
    skippedUnchanged: 0,
    updatedPhotoRows: 0,
    duplicateGroups: 0,
    duplicateFiles: 0,
    errorCount: 0,
    errors: [],
  };

  options.onProgress?.({
    phase: 'counting',
    projectId: null,
    projectName: null,
    processed: 0,
    total: 0,
    percent: 0,
    currentPath: null,
    message: 'Licze zdjecia w folderach projektow',
  });

  for (const project of projects) {
    const files = collectImageFiles(project.baseFolder);
    projectFiles.set(project.id, files);
    result.filesFound += files.length;
  }

  const selectCache = db.prepare(
    `SELECT content_hash AS contentHash,
            file_size AS fileSize,
            modified_mtime_ms AS modifiedMtimeMs
     FROM project_photo_hash_cache
     WHERE project_id = ? AND storage_path = ?`,
  );
  const upsertCache = db.prepare(
    `INSERT INTO project_photo_hash_cache (
      project_id, storage_path, content_hash, file_size, modified_mtime_ms, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, storage_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      file_size = excluded.file_size,
      modified_mtime_ms = excluded.modified_mtime_ms,
      scanned_at = excluded.scanned_at`,
  );
  const deleteStaleCache = db.prepare(
    `DELETE FROM project_photo_hash_cache
     WHERE project_id = ? AND scanned_at != ?`,
  );
  const updatePhotoHash = db.prepare(
    `UPDATE photos
     SET content_hash = ?
     WHERE project_id = ? AND storage_path = ? AND COALESCE(content_hash, '') != ?`,
  );
  const scanStartedAt = new Date().toISOString();
  let processed = 0;

  for (const project of projects) {
    const files = projectFiles.get(project.id) ?? [];
    for (const filePath of files) {
      processed += 1;
      try {
        const fileStat = statSync(filePath);
        const cached = selectCache.get(project.id, filePath) as CacheRow | undefined;
        const canReuseHash =
          cached &&
          cached.fileSize === fileStat.size &&
          cached.modifiedMtimeMs === fileStat.mtimeMs &&
          cached.contentHash;
        const contentHash = canReuseHash ? cached.contentHash : sha256(readFileSync(filePath));

        if (canReuseHash) {
          result.skippedUnchanged += 1;
        } else {
          result.hashedFiles += 1;
        }

        upsertCache.run(project.id, filePath, contentHash, fileStat.size, fileStat.mtimeMs, scanStartedAt);
        result.updatedPhotoRows += updatePhotoHash.run(contentHash, project.id, filePath, contentHash).changes;
      } catch (error) {
        result.errorCount += 1;
        result.errors.push({
          projectId: project.id,
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      options.onProgress?.({
        phase: 'hashing',
        projectId: project.id,
        projectName: project.name,
        processed,
        total: result.filesFound,
        percent: progressPercent(processed, result.filesFound),
        currentPath: filePath,
        message: `${basename(filePath)} (${processed}/${result.filesFound})`,
      });
    }

    deleteStaleCache.run(project.id, scanStartedAt);
  }

  for (const project of projects) {
    const duplicateRows = db
      .prepare(
        `SELECT COUNT(*) AS fileCount
         FROM project_photo_hash_cache
         WHERE project_id = ?
         GROUP BY content_hash
         HAVING COUNT(*) > 1`,
      )
      .all(project.id) as Array<{ fileCount: number }>;
    result.duplicateGroups += duplicateRows.length;
    result.duplicateFiles += duplicateRows.reduce((sum, row) => sum + Number(row.fileCount), 0);
  }

  options.onProgress?.({
    phase: 'done',
    projectId: null,
    projectName: null,
    processed: result.filesFound,
    total: result.filesFound,
    percent: 100,
    currentPath: null,
    message: 'Zakonczono haszowanie zdjec',
  });

  return result;
}

export function listKnownProjectPhotoHashes(db: Database.Database, projectId: string): string[] {
  const hashes = new Set<string>();
  const cacheRows = db
    .prepare(
      `SELECT content_hash AS contentHash
       FROM project_photo_hash_cache
       WHERE project_id = ?
         AND content_hash IS NOT NULL
         AND content_hash != ''`,
    )
    .all(projectId) as Array<{ contentHash: string }>;

  for (const row of cacheRows) hashes.add(row.contentHash);

  const photoRows = db
    .prepare(
      `SELECT
         photo.id,
         photo.content_hash AS contentHash,
         photo.storage_path AS storagePath,
         project.base_folder AS baseFolder
       FROM photos photo
       JOIN projects project ON project.id = photo.project_id
       WHERE photo.project_id = ?`,
    )
    .all(projectId) as PhotoHashRow[];
  const updatePhotoHash = db.prepare(
    `UPDATE photos
     SET content_hash = ?
     WHERE id = ?`,
  );
  const upsertCache = db.prepare(
    `INSERT INTO project_photo_hash_cache (
      project_id, storage_path, content_hash, file_size, modified_mtime_ms, scanned_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(project_id, storage_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      file_size = excluded.file_size,
      modified_mtime_ms = excluded.modified_mtime_ms,
      scanned_at = excluded.scanned_at`,
  );

  for (const row of photoRows) {
    if (!isInsideFolder(row.storagePath, row.baseFolder)) continue;

    let contentHash = row.contentHash;
    if (!contentHash) {
      try {
        const fileStat = statSync(row.storagePath);
        contentHash = sha256(readFileSync(row.storagePath));
        updatePhotoHash.run(contentHash, row.id);
        upsertCache.run(projectId, row.storagePath, contentHash, fileStat.size, fileStat.mtimeMs);
      } catch {
        continue;
      }
    }

    hashes.add(contentHash);
  }

  const rejectedRows = db
    .prepare(
      `SELECT file.id,
              file.content_hash AS contentHash,
              file.source_path AS sourcePath
       FROM chat_photo_files file
       JOIN chat_photo_batches batch ON batch.id = file.batch_id
       WHERE batch.project_id = ?
         AND batch.status = 'REJECTED'`,
    )
    .all(projectId) as RejectedChatFileHashRow[];
  const updateChatFileHash = db.prepare(
    `UPDATE chat_photo_files
     SET content_hash = ?
     WHERE id = ?`,
  );

  for (const row of rejectedRows) {
    let contentHash = row.contentHash;
    if (!contentHash) {
      try {
        contentHash = sha256(readFileSync(row.sourcePath));
        updateChatFileHash.run(contentHash, row.id);
      } catch {
        continue;
      }
    }

    hashes.add(contentHash);
  }

  return [...hashes];
}
