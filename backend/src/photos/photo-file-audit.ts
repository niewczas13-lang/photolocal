import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type PhotoFileAuditSource = 'checklist' | 'map_note' | 'project';

export type PhotoFileAuditIssueCode =
  | 'PROJECT_FOLDER_MISSING'
  | 'STORAGE_MISSING'
  | 'STORAGE_NOT_FILE'
  | 'THUMBNAIL_MISSING'
  | 'THUMBNAIL_NOT_FILE'
  | 'SIZE_MISMATCH'
  | 'OUTSIDE_PROJECT_FOLDER'
  | 'ACCESS_ERROR';

export interface PhotoFileAuditProgressEvent {
  phase: 'start' | 'project' | 'done';
  processedProjects: number;
  totalProjects: number;
  projectId: string | null;
  projectName: string | null;
}

export interface PhotoFileAuditOptions {
  projectIds?: string[];
  onProgress?: (event: PhotoFileAuditProgressEvent) => void;
}

export interface PhotoFileAuditIssue {
  code: PhotoFileAuditIssueCode;
  source: PhotoFileAuditSource;
  projectId: string;
  projectName: string;
  photoId: string | null;
  targetPath: string | null;
  sourceFileName: string | null;
  storedFileName: string | null;
  storagePath: string | null;
  thumbnailPath: string | null;
  dbFileSize: number | null;
  diskFileSize: number | null;
  message: string;
}

export interface PhotoFileAuditResult {
  projectCount: number;
  checklistPhotoRows: number;
  notePhotoRows: number;
  missingProjectFolders: number;
  missingStorageFiles: number;
  missingThumbnailFiles: number;
  thumbnailFallbackOnly: number;
  sizeMismatches: number;
  outsideProjectPaths: number;
  accessErrors: number;
  issues: PhotoFileAuditIssue[];
}

interface ProjectRow {
  id: string;
  name: string;
  baseFolder: string;
}

interface PhotoRow {
  source: Exclude<PhotoFileAuditSource, 'project'>;
  id: string;
  projectId: string;
  projectName: string;
  baseFolder: string;
  targetPath: string | null;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  fileSize: number | null;
}

interface PathInspection {
  exists: boolean;
  isFile: boolean;
  size: number | null;
  errorMessage: string | null;
}

function listProjects(db: Database.Database, projectIds: string[] | undefined): ProjectRow[] {
  if (!projectIds || projectIds.length === 0) {
    return db
      .prepare(
        `SELECT id, name, base_folder AS baseFolder
         FROM projects
         ORDER BY updated_at DESC, name ASC`,
      )
      .all() as ProjectRow[];
  }

  const placeholders = projectIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, name, base_folder AS baseFolder
       FROM projects
       WHERE id IN (${placeholders})
       ORDER BY updated_at DESC, name ASC`,
    )
    .all(...projectIds) as ProjectRow[];
}

function listChecklistPhotoRows(db: Database.Database, projectId: string): PhotoRow[] {
  return db
    .prepare(
      `SELECT
         'checklist' AS source,
         photo.id,
         photo.project_id AS projectId,
         project.name AS projectName,
         project.base_folder AS baseFolder,
         node.path AS targetPath,
         photo.source_file_name AS sourceFileName,
         photo.stored_file_name AS storedFileName,
         photo.storage_path AS storagePath,
         photo.thumbnail_path AS thumbnailPath,
         photo.file_size AS fileSize
       FROM photos photo
       JOIN projects project ON project.id = photo.project_id
       LEFT JOIN checklist_nodes node ON node.id = photo.checklist_node_id
       WHERE photo.project_id = ?
       ORDER BY node.path ASC, photo.uploaded_at ASC, photo.id ASC`,
    )
    .all(projectId) as PhotoRow[];
}

function listMapNotePhotoRows(db: Database.Database, projectId: string): PhotoRow[] {
  return db
    .prepare(
      `SELECT
         'map_note' AS source,
         photo.id,
         photo.project_id AS projectId,
         project.name AS projectName,
         project.base_folder AS baseFolder,
         COALESCE(note.target_label, note.body, 'Notatka mapy') AS targetPath,
         photo.source_file_name AS sourceFileName,
         photo.stored_file_name AS storedFileName,
         photo.storage_path AS storagePath,
         photo.thumbnail_path AS thumbnailPath,
         photo.file_size AS fileSize
       FROM map_note_photos photo
       JOIN projects project ON project.id = photo.project_id
       LEFT JOIN map_notes note ON note.id = photo.note_id
       WHERE photo.project_id = ?
       ORDER BY note.created_at ASC, photo.uploaded_at ASC, photo.id ASC`,
    )
    .all(projectId) as PhotoRow[];
}

function inspectPath(path: string | null): PathInspection {
  if (!path) {
    return { exists: false, isFile: false, size: null, errorMessage: null };
  }

  try {
    if (!existsSync(path)) {
      return { exists: false, isFile: false, size: null, errorMessage: null };
    }

    const stats = statSync(path);
    return {
      exists: true,
      isFile: stats.isFile(),
      size: stats.isFile() ? stats.size : null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      exists: false,
      isFile: false,
      size: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function isInsideFolder(path: string | null, folder: string): boolean {
  if (!path || !folder) return false;

  const relativePath = relative(resolve(folder), resolve(path));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function addIssue(result: PhotoFileAuditResult, issue: PhotoFileAuditIssue): void {
  result.issues.push(issue);

  if (issue.code === 'PROJECT_FOLDER_MISSING') result.missingProjectFolders += 1;
  if (issue.code === 'STORAGE_MISSING' || issue.code === 'STORAGE_NOT_FILE') result.missingStorageFiles += 1;
  if (issue.code === 'THUMBNAIL_MISSING' || issue.code === 'THUMBNAIL_NOT_FILE') result.missingThumbnailFiles += 1;
  if (issue.code === 'SIZE_MISMATCH') result.sizeMismatches += 1;
  if (issue.code === 'OUTSIDE_PROJECT_FOLDER') result.outsideProjectPaths += 1;
  if (issue.code === 'ACCESS_ERROR') result.accessErrors += 1;
}

function auditPhotoRow(result: PhotoFileAuditResult, row: PhotoRow): void {
  if (!isInsideFolder(row.storagePath, row.baseFolder)) {
    addIssue(result, {
      code: 'OUTSIDE_PROJECT_FOLDER',
      source: row.source,
      projectId: row.projectId,
      projectName: row.projectName,
      photoId: row.id,
      targetPath: row.targetPath,
      sourceFileName: row.sourceFileName,
      storedFileName: row.storedFileName,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      dbFileSize: row.fileSize,
      diskFileSize: null,
      message: 'Sciezka duzego pliku jest poza folderem projektu.',
    });
  }

  const storage = inspectPath(row.storagePath);
  const thumbnail = inspectPath(row.thumbnailPath);

  if (storage.errorMessage) {
    addIssue(result, {
      code: 'ACCESS_ERROR',
      source: row.source,
      projectId: row.projectId,
      projectName: row.projectName,
      photoId: row.id,
      targetPath: row.targetPath,
      sourceFileName: row.sourceFileName,
      storedFileName: row.storedFileName,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      dbFileSize: row.fileSize,
      diskFileSize: null,
      message: `Nie da sie odczytac duzego pliku: ${storage.errorMessage}`,
    });
  } else if (!storage.exists) {
    addIssue(result, {
      code: 'STORAGE_MISSING',
      source: row.source,
      projectId: row.projectId,
      projectName: row.projectName,
      photoId: row.id,
      targetPath: row.targetPath,
      sourceFileName: row.sourceFileName,
      storedFileName: row.storedFileName,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      dbFileSize: row.fileSize,
      diskFileSize: null,
      message: thumbnail.exists
        ? 'Brakuje duzego pliku, ale miniatura istnieje - UI moze pokazywac miniaturke po kliknieciu.'
        : 'Brakuje duzego pliku zdjecia.',
    });
    if (thumbnail.exists && thumbnail.isFile) {
      result.thumbnailFallbackOnly += 1;
    }
  } else if (!storage.isFile) {
    addIssue(result, {
      code: 'STORAGE_NOT_FILE',
      source: row.source,
      projectId: row.projectId,
      projectName: row.projectName,
      photoId: row.id,
      targetPath: row.targetPath,
      sourceFileName: row.sourceFileName,
      storedFileName: row.storedFileName,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      dbFileSize: row.fileSize,
      diskFileSize: null,
      message: 'Sciezka duzego zdjecia istnieje, ale nie jest plikiem.',
    });
  } else if (row.fileSize !== null && storage.size !== null && row.fileSize !== storage.size) {
    addIssue(result, {
      code: 'SIZE_MISMATCH',
      source: row.source,
      projectId: row.projectId,
      projectName: row.projectName,
      photoId: row.id,
      targetPath: row.targetPath,
      sourceFileName: row.sourceFileName,
      storedFileName: row.storedFileName,
      storagePath: row.storagePath,
      thumbnailPath: row.thumbnailPath,
      dbFileSize: row.fileSize,
      diskFileSize: storage.size,
      message: 'Rozmiar pliku na dysku rozni sie od rozmiaru zapisanego w bazie.',
    });
  }

  if (row.thumbnailPath) {
    if (thumbnail.errorMessage) {
      addIssue(result, {
        code: 'ACCESS_ERROR',
        source: row.source,
        projectId: row.projectId,
        projectName: row.projectName,
        photoId: row.id,
        targetPath: row.targetPath,
        sourceFileName: row.sourceFileName,
        storedFileName: row.storedFileName,
        storagePath: row.storagePath,
        thumbnailPath: row.thumbnailPath,
        dbFileSize: row.fileSize,
        diskFileSize: null,
        message: `Nie da sie odczytac miniatury: ${thumbnail.errorMessage}`,
      });
    } else if (!thumbnail.exists) {
      addIssue(result, {
        code: 'THUMBNAIL_MISSING',
        source: row.source,
        projectId: row.projectId,
        projectName: row.projectName,
        photoId: row.id,
        targetPath: row.targetPath,
        sourceFileName: row.sourceFileName,
        storedFileName: row.storedFileName,
        storagePath: row.storagePath,
        thumbnailPath: row.thumbnailPath,
        dbFileSize: row.fileSize,
        diskFileSize: null,
        message: 'Brakuje miniatury zapisanej w bazie.',
      });
    } else if (!thumbnail.isFile) {
      addIssue(result, {
        code: 'THUMBNAIL_NOT_FILE',
        source: row.source,
        projectId: row.projectId,
        projectName: row.projectName,
        photoId: row.id,
        targetPath: row.targetPath,
        sourceFileName: row.sourceFileName,
        storedFileName: row.storedFileName,
        storagePath: row.storagePath,
        thumbnailPath: row.thumbnailPath,
        dbFileSize: row.fileSize,
        diskFileSize: null,
        message: 'Sciezka miniatury istnieje, ale nie jest plikiem.',
      });
    }
  }
}

export function auditProjectPhotoFiles(
  db: Database.Database,
  options: PhotoFileAuditOptions = {},
): PhotoFileAuditResult {
  const projects = listProjects(db, options.projectIds);
  const result: PhotoFileAuditResult = {
    projectCount: projects.length,
    checklistPhotoRows: 0,
    notePhotoRows: 0,
    missingProjectFolders: 0,
    missingStorageFiles: 0,
    missingThumbnailFiles: 0,
    thumbnailFallbackOnly: 0,
    sizeMismatches: 0,
    outsideProjectPaths: 0,
    accessErrors: 0,
    issues: [],
  };

  options.onProgress?.({
    phase: 'start',
    processedProjects: 0,
    totalProjects: projects.length,
    projectId: null,
    projectName: null,
  });

  projects.forEach((project, index) => {
    options.onProgress?.({
      phase: 'project',
      processedProjects: index + 1,
      totalProjects: projects.length,
      projectId: project.id,
      projectName: project.name,
    });

    const baseFolder = inspectPath(project.baseFolder);
    if (!baseFolder.exists) {
      addIssue(result, {
        code: 'PROJECT_FOLDER_MISSING',
        source: 'project',
        projectId: project.id,
        projectName: project.name,
        photoId: null,
        targetPath: null,
        sourceFileName: null,
        storedFileName: null,
        storagePath: project.baseFolder,
        thumbnailPath: null,
        dbFileSize: null,
        diskFileSize: null,
        message: 'Brakuje glownego folderu projektu.',
      });
    }

    const checklistRows = listChecklistPhotoRows(db, project.id);
    const noteRows = listMapNotePhotoRows(db, project.id);
    result.checklistPhotoRows += checklistRows.length;
    result.notePhotoRows += noteRows.length;

    for (const row of checklistRows) auditPhotoRow(result, row);
    for (const row of noteRows) auditPhotoRow(result, row);
  });

  options.onProgress?.({
    phase: 'done',
    processedProjects: projects.length,
    totalProjects: projects.length,
    projectId: null,
    projectName: null,
  });

  return result;
}

function csvValue(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function writePhotoFileAuditCsv(filePath: string, issues: PhotoFileAuditIssue[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const header = [
    'project_name',
    'project_id',
    'source',
    'issue_code',
    'photo_id',
    'target_path',
    'source_file_name',
    'stored_file_name',
    'storage_path',
    'thumbnail_path',
    'db_file_size',
    'disk_file_size',
    'message',
  ];
  const rows = issues.map((issue) =>
    [
      issue.projectName,
      issue.projectId,
      issue.source,
      issue.code,
      issue.photoId,
      issue.targetPath,
      issue.sourceFileName,
      issue.storedFileName,
      issue.storagePath,
      issue.thumbnailPath,
      issue.dbFileSize,
      issue.diskFileSize,
      issue.message,
    ]
      .map(csvValue)
      .join(';'),
  );

  writeFileSync(filePath, [header.join(';'), ...rows].join('\r\n'), 'utf8');
}
