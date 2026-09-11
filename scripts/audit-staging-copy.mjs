import Database from 'better-sqlite3';
import fs from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const ALLOWED_ROOTS = ['/nas', '/legacy-local-photos', '/legacy-downloads', '/photos', '/downloads'];
const MAX_FAILURES = 50;
const MAX_DIRECTORY_ENTRIES = 2000;
const MAX_PATH_COMPONENTS = 64;
const MAX_LOCATE_JSON_BYTES = 48 * 1024;
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

function comparableName(name) {
  return name.normalize('NFD').toLowerCase().replace(/\p{M}/gu, '')
    .replaceAll('ł', 'l').replace(/[_\s]/g, '');
}

function similarName(name, requested) {
  const actual = comparableName(name);
  const expected = comparableName(requested);
  if (actual === expected) return true;
  if (Math.min(actual.length, expected.length) < 3) return false;
  if (actual.startsWith(expected) || expected.startsWith(actual)) return true;
  const prefixLength = Math.min(12, actual.length, expected.length);
  return prefixLength >= 4 && actual.slice(0, prefixLength) === expected.slice(0, prefixLength);
}

function listNearbyDirectory(parent, root, cache) {
  if (cache.has(parent)) return cache.get(parent);
  const listing = { entries: [], scan: { complete: false, truncated: false, entriesRead: 0 } };
  let handle;
  try {
    const actual = fs.realpathSync(parent);
    if (!inside(actual, root.actual)) {
      listing.scan.reason = 'OUTSIDE_ROOT';
      return listing;
    }
    handle = fs.opendirSync(actual);
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES; index += 1) {
      const entry = handle.readSync();
      if (entry === null) {
        listing.scan.complete = true;
        break;
      }
      listing.scan.entriesRead += 1;
      if (!entry.isSymbolicLink()) listing.entries.push({ name: entry.name, isDirectory: entry.isDirectory() });
    }
    // If the limit was reached, completeness is unknown: never read an extra entry to find out.
    listing.scan.truncated = !listing.scan.complete;
  } catch (error) {
    listing.scan.reason = filesystemReason(error);
  } finally {
    if (handle) {
      try { handle.closeSync(); } catch (error) { listing.scan.reason = filesystemReason(error); }
    }
    cache.set(parent, listing);
  }
  return listing;
}

/** Trace only the requested path; sibling names are suggestions, never replacement paths. */
function locateFailure(failure, roots, cache) {
  const location = {
    status: 'PATH_UNAVAILABLE', deepestDirectory: null, firstMissingSegment: null,
    reason: failure.reason, suggestions: [], nearbyDirectories: [],
    scan: { complete: false, truncated: false, entriesRead: 0 }, walkTruncated: false,
  };
  const value = failure.path;
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    location.reason = 'PATH_REJECTED';
    return location;
  }
  const normalized = resolve(value);
  const root = roots.find(entry => inside(normalized, entry.lexical));
  if (!root) { location.reason = 'OUTSIDE_ROOT'; return location; }
  if (!root.actual) { location.reason = 'MOUNT_UNAVAILABLE'; return location; }
  location.deepestDirectory = root.actual;
  let current = root.lexical;
  const components = relative(root.lexical, normalized).split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < Math.min(components.length, MAX_PATH_COMPONENTS); index += 1) {
    current = join(current, components[index]);
    try {
      const actual = fs.realpathSync(current);
      if (!inside(actual, root.actual)) { location.reason = 'OUTSIDE_ROOT'; return location; }
      const info = fs.statSync(actual);
      if (info.isDirectory()) location.deepestDirectory = actual;
      else if (index < components.length - 1) { location.reason = 'ENOTDIR'; return location; }
    } catch (error) {
      location.reason = filesystemReason(error);
      if (location.reason !== 'ENOENT') return location;
      location.status = 'MISSING_SEGMENT';
      location.firstMissingSegment = components[index];
      const listing = listNearbyDirectory(location.deepestDirectory, root, cache);
      location.scan = { ...listing.scan };
      const directoryExpected = index < components.length - 1 || failure.kind === 'project_folder';
      location.suggestions = listing.entries
        .filter(entry => entry.isDirectory === directoryExpected && similarName(entry.name, components[index]))
        .slice(0, 12).map(entry => entry.name);
      if (location.suggestions.length === 0) {
        location.nearbyDirectories = listing.entries.filter(entry => entry.isDirectory).slice(0, 12).map(entry => entry.name);
      }
      return location;
    }
  }
  if (components.length > MAX_PATH_COMPONENTS) {
    location.status = 'WALK_LIMIT';
    location.walkTruncated = true;
    location.reason = null;
  } else {
    // The path now exists; preserve the original read failure without claiming a missing component.
    location.status = 'EXACT_PATH_EXISTS';
  }
  return location;
}

function boundLocateReport(report) {
  while (report.failures.length > 0 &&
      Buffer.byteLength(JSON.stringify(report, null, 2) + '\n', 'utf8') > MAX_LOCATE_JSON_BYTES) {
    report.failures.pop();
    report.failuresTruncated += 1;
  }
}

/** Inspect a completed migrated copy. Paths appear only with the explicit includeFailures opt-in. */
export function auditStagingCopy(databasePath, {
  allowedRoots = ALLOWED_ROOTS, includeFailures = false, locateFailures = false,
} = {}) {
  const report = newReport(includeFailures === true || locateFailures === true);
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
    if (locateFailures === true) {
      const listingCache = new Map();
      for (const failure of report.failures) failure.location = locateFailure(failure, roots, listingCache);
    }
  } catch {
    report.status = 'STAGING_COPY_INVALID_DATABASE';
  } finally {
    if (database) database.close();
  }
  if (locateFailures === true) boundLocateReport(report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report = newReport();
  try {
    const { values } = parseArgs({ options: {
      database: { type: 'string' }, details: { type: 'boolean' }, locate: { type: 'boolean' },
    }, strict: true });
    report = newReport(values.details === true || values.locate === true);
    if (typeof values.database === 'string' && isAbsolute(values.database)) {
      report = auditStagingCopy(values.database, { includeFailures: values.details, locateFailures: values.locate });
    }
  } catch {
    // Keep parse errors and SQLite errors out of the report: either can contain private paths.
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'STAGING_COPY_VERIFIED' ? 0 : 1;
}
