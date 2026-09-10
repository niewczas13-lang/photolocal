import Database from 'better-sqlite3';
import fs from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const ALLOWED_ROOTS = ['/nas', '/legacy-local-photos', '/legacy-downloads', '/photos', '/downloads'];
const MAX_FAILURES = 50;
const FILESYSTEM_REASONS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

function newReport(includeFailures = false) {
  const report = {
    status: 'STAGING_COPY_INVALID_DATABASE',
    counts: Object.fromEntries(TABLES.map((table) => [table, null])),
    projectFolders: { checked: 0, accessible: 0, missing: 0 },
    photoSamples: { checked: 0, readable: 0, unreadable: 0 },
    projectsWithoutPhotos: 0,
  };
  if (includeFailures === true) {
    report.failures = [];
    report.failuresTruncated = 0;
  }
  return report;
}

function filesystemReason(error) {
  return FILESYSTEM_REASONS.has(error?.code) ? error.code : 'IO_ERROR';
}

function addFailure(report, kind, projectId, photoId, path, reason) {
  if (!report.failures) return;
  if (report.failures.length < MAX_FAILURES) {
    report.failures.push({ kind, projectId, photoId, path, reason });
  } else {
    report.failuresTruncated += 1;
  }
}

function inside(candidate, root) {
  const difference = relative(root, candidate);
  return difference === '' || (
    difference !== '..' && !difference.startsWith('../') &&
    !difference.startsWith('..\\') && !isAbsolute(difference)
  );
}

function permittedPath(value, roots) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value) ||
      value.split(/[\\/]/).some((part) => part === '.' || part === '..')) return { reason: 'PATH_REJECTED' };
  const normalized = resolve(value);
  const root = roots.find((entry) => inside(normalized, entry.lexical));
  if (!root) return { reason: 'OUTSIDE_ROOT' };
  if (!root.actual) return { reason: 'MOUNT_UNAVAILABLE' };
  try {
    const actual = fs.realpathSync(normalized);
    return inside(actual, root.actual) ? { path: actual } : { reason: 'OUTSIDE_ROOT' };
  } catch (error) {
    return { reason: filesystemReason(error) };
  }
}

function directoryFailure(value, roots) {
  const permitted = permittedPath(value, roots);
  if (permitted.reason) return permitted.reason;
  try {
    return fs.statSync(permitted.path).isDirectory() ? null : 'NOT_DIRECTORY';
  } catch (error) {
    return filesystemReason(error);
  }
}

function originalFailure(value, roots) {
  const permitted = permittedPath(value, roots);
  if (permitted.reason) return permitted.reason;
  let descriptor;
  try {
    // Classify a directory before open, which returns different errors across operating systems.
    if (!fs.statSync(permitted.path).isFile()) return 'NOT_REGULAR_FILE';
    // Nonblocking avoids hanging on a special file; nofollow rejects a swapped final symlink.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0);
    descriptor = fs.openSync(permitted.path, flags);
    if (!fs.fstatSync(descriptor).isFile()) return 'NOT_REGULAR_FILE';
    return fs.readSync(descriptor, Buffer.alloc(64), 0, 64, 0) > 0 ? null : 'EMPTY_FILE';
  } catch (error) {
    return filesystemReason(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Inspect a completed migrated copy. Paths appear only with the explicit includeFailures opt-in. */
export function auditStagingCopy(databasePath, { allowedRoots = ALLOWED_ROOTS, includeFailures = false } = {}) {
  const report = newReport(includeFailures);
  let database;
  try {
    if (!Array.isArray(allowedRoots) || allowedRoots.some((root) =>
      typeof root !== 'string' || !isAbsolute(root))) return report;
    const roots = allowedRoots.map((root) => {
      try {
        const actual = fs.realpathSync(root);
        return { lexical: resolve(root), actual: fs.statSync(actual).isDirectory() ? actual : null };
      } catch {
        return { lexical: resolve(root), actual: null };
      }
    });
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
    const tableExists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    for (const table of TABLES) {
      if (tableExists.get(table)) report.counts[table] = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }
    if (!(report.counts.projects > 0) || report.counts.photos === null) return report;
    const projects = database.prepare('SELECT id, base_folder FROM projects ORDER BY id').all();
    const samples = database.prepare('SELECT id, storage_path FROM photos WHERE project_id = ? ORDER BY id LIMIT 3');
    for (const project of projects) {
      report.projectFolders.checked += 1;
      const folderReason = directoryFailure(project.base_folder, roots);
      if (!folderReason) report.projectFolders.accessible += 1;
      else {
        report.projectFolders.missing += 1;
        addFailure(report, 'project_folder', project.id, null, project.base_folder, folderReason);
      }
      const projectSamples = samples.all(project.id);
      if (projectSamples.length === 0) report.projectsWithoutPhotos += 1;
      for (const sample of projectSamples) {
        report.photoSamples.checked += 1;
        const photoReason = originalFailure(sample.storage_path, roots);
        if (!photoReason) report.photoSamples.readable += 1;
        else {
          report.photoSamples.unreadable += 1;
          addFailure(report, 'photo', project.id, sample.id, sample.storage_path, photoReason);
        }
      }
    }
    report.status = report.projectFolders.missing === 0 && report.photoSamples.unreadable === 0
      ? 'STAGING_COPY_VERIFIED' : 'STAGING_COPY_FILES_MISSING';
  } catch {
    report.status = 'STAGING_COPY_INVALID_DATABASE';
  } finally {
    if (database) database.close();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report = newReport();
  try {
    const { values } = parseArgs({ options: { database: { type: 'string' }, details: { type: 'boolean' } }, strict: true });
    report = newReport(values.details);
    if (typeof values.database === 'string' && isAbsolute(values.database)) {
      report = auditStagingCopy(values.database, { includeFailures: values.details });
    }
  } catch {
    // Keep parse errors and SQLite errors out of the report: either can contain private paths.
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'STAGING_COPY_VERIFIED' ? 0 : 1;
}
