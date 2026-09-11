import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import { auditStagingCopy } from './audit-staging-copy.mjs';

describe('read-only staging copy audit', () => {
  let directory;
  let databasePath;
  let storage;
  let db;

  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'photolocal-staging-audit-'));
    databasePath = join(directory, 'copy.sqlite');
    storage = join(directory, 'photos');
    fs.mkdirSync(storage);
    db = new Database(databasePath);
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, base_folder TEXT);
      CREATE TABLE photos (id TEXT PRIMARY KEY, project_id TEXT, storage_path TEXT);
      CREATE TABLE map_note_photos (id TEXT PRIMARY KEY);
      CREATE TABLE chat_photo_batches (id TEXT PRIMARY KEY);
      CREATE TABLE chat_photo_files (id TEXT PRIMARY KEY);
    `);
  });

  afterEach(() => {
    mock.restoreAll();
    if (db.open) db.close();
    const checked = resolve(directory);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.ok(checked.startsWith(join(resolve(tmpdir()), 'photolocal-staging-audit-')));
    fs.rmSync(checked, { recursive: true, force: true });
  });

  function project(id, folder = join(storage, id)) {
    fs.mkdirSync(folder, { recursive: true });
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, 'Private project title', folder);
    return folder;
  }

  function photo(id, projectId, path, contents = 'photo-data') {
    if (contents !== null) fs.writeFileSync(path, contents);
    db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(id, projectId, path);
  }

  function audit(options = {}) {
    if (db.open) db.close();
    return auditStagingCopy(databasePath, { allowedRoots: [storage], ...options });
  }

  it('reports all five counts, every project folder and nonempty original samples without private data', () => {
    const folder = project('p1');
    project('p2');
    photo('f1', 'p1', join(folder, 'private-original.jpg'));
    db.exec("INSERT INTO map_note_photos VALUES ('m1'); INSERT INTO chat_photo_batches VALUES ('b1'); INSERT INTO chat_photo_files VALUES ('c1');");
    const report = audit();
    assert.deepEqual(report, {
      status: 'STAGING_COPY_VERIFIED',
      counts: { projects: 2, photos: 1, map_note_photos: 1, chat_photo_batches: 1, chat_photo_files: 1 },
      projectFolders: { checked: 2, accessible: 2, missing: 0 },
      photoSamples: { checked: 1, readable: 1, unreadable: 0 },
      projectsWithoutPhotos: 1,
    });
    const output = JSON.stringify(report);
    for (const secret of [directory, 'private-original', 'Private project title', 'p1', 'p2']) {
      assert.equal(output.includes(secret), false);
    }
  });

  it('samples only the first three original rows ordered by id for each project', () => {
    const first = project('p1');
    const second = project('p2');
    photo('z-missing', 'p1', join(first, 'missing.jpg'), null);
    for (const id of ['c', 'a', 'b']) photo(id, 'p1', join(first, `${id}.jpg`));
    photo('second', 'p2', join(second, 'second.jpg'));
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_VERIFIED');
    assert.deepEqual(report.photoSamples, { checked: 4, readable: 4, unreadable: 0 });
    assert.equal(report.counts.photos, 5);
  });

  it('reads at most 64 bytes of a sampled file and leaves database, files and directory entries unchanged', () => {
    const folder = project('p1');
    const original = join(folder, 'large.jpg');
    photo('f1', 'p1', original, Buffer.alloc(1024 * 1024, 97));
    db.close();
    const beforeDb = fs.readFileSync(databasePath);
    const beforeFile = fs.readFileSync(original);
    const beforeDirectory = fs.readdirSync(directory);
    const beforeStorage = fs.readdirSync(folder);
    const originalRead = fs.readSync;
    let totalRequested = 0;
    mock.method(fs, 'readSync', (descriptor, buffer, offset, length, position) => {
      totalRequested += length;
      assert.ok(length > 0 && length <= 64);
      return originalRead(descriptor, buffer, offset, length, position);
    });
    assert.equal(audit().status, 'STAGING_COPY_VERIFIED');
    assert.equal(totalRequested, 64);
    mock.restoreAll();
    assert.deepEqual(fs.readFileSync(databasePath), beforeDb);
    assert.deepEqual(fs.readFileSync(original), beforeFile);
    assert.deepEqual(fs.readdirSync(directory), beforeDirectory);
    assert.deepEqual(fs.readdirSync(folder), beforeStorage);
  });

  it('reports absent project folders and missing, empty or nonregular photo paths', () => {
    const folder = project('p1');
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p2', 'Missing private project', join(storage, 'gone'));
    photo('a', 'p1', join(folder, 'missing.jpg'), null);
    photo('b', 'p1', join(folder, 'empty.jpg'), '');
    photo('c', 'p1', folder, null);
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_FILES_MISSING');
    assert.deepEqual(report.projectFolders, { checked: 2, accessible: 1, missing: 1 });
    assert.deepEqual(report.photoSamples, { checked: 3, readable: 0, unreadable: 3 });
  });

  it('rejects sibling prefixes, traversal and relative paths from database values', () => {
    project('p1');
    const sibling = join(directory, 'photos-private');
    fs.mkdirSync(sibling);
    const secret = join(sibling, 'secret.jpg');
    fs.writeFileSync(secret, 'private-data');
    db.prepare('UPDATE projects SET base_folder = ?').run(sibling);
    photo('a', 'p1', secret, null);
    photo('b', 'p1', join(storage, 'p1') + '/../p1/allowed.jpg', null);
    photo('c', 'p1', 'relative.jpg', null);
    const originalOpen = fs.openSync;
    mock.method(fs, 'openSync', (...args) => {
      assert.notEqual(args[0], secret, 'outside file must never be opened');
      return originalOpen(...args);
    });
    const report = audit();
    assert.equal(report.projectFolders.missing, 1);
    assert.equal(report.photoSamples.unreadable, 3);
  });

  it('rejects a symlink inside an allowed root that resolves outside that root', (context) => {
    const folder = project('p1');
    const outside = join(directory, 'private.jpg');
    fs.writeFileSync(outside, 'private-data');
    const link = join(folder, 'linked.jpg');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        context.skip('Creating symlinks requires Windows permission');
        return;
      }
      throw error;
    }
    photo('a', 'p1', link, null);
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_FILES_MISSING');
    assert.equal(report.photoSamples.unreadable, 1);
  });

  it('reports absent optional tables as unavailable and permits projects with no photo rows', () => {
    project('p1');
    db.exec('DROP TABLE map_note_photos; DROP TABLE chat_photo_batches; DROP TABLE chat_photo_files;');
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_VERIFIED');
    assert.deepEqual(report.counts, { projects: 1, photos: 0, map_note_photos: null, chat_photo_batches: null, chat_photo_files: null });
    assert.equal(report.projectsWithoutPhotos, 1);
  });

  it('does not verify an empty database or silently create a missing database', () => {
    assert.equal(audit().status, 'STAGING_COPY_INVALID_DATABASE');
    const absent = join(directory, 'not-present.sqlite');
    assert.equal(auditStagingCopy(absent).status, 'STAGING_COPY_INVALID_DATABASE');
    assert.equal(fs.existsSync(absent), false);
  });

  it('rejects missing required tables with a safe report', () => {
    project('p1');
    db.exec('DROP TABLE photos;');
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_INVALID_DATABASE');
    assert.equal(JSON.stringify(report).includes(directory), false);
  });

  it('CLI emits only a safe JSON report and failure exit code for a missing database', () => {
    const script = fileURLToPath(new URL('./audit-staging-copy.mjs', import.meta.url));
    const absent = join(directory, 'private-secret.sqlite');
    const child = spawnSync(process.execPath, [script, '--database', absent], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.equal(JSON.parse(child.stdout).status, 'STAGING_COPY_INVALID_DATABASE');
    assert.equal(child.stdout.includes('private-secret'), false);
    assert.equal(fs.existsSync(absent), false);
  });

  it('details distinguish missing, empty and permission-denied originals without raw error messages', () => {
    const folder = project('p1');
    const missing = join(folder, 'missing.jpg');
    const empty = join(folder, 'empty.jpg');
    const denied = join(folder, 'denied.jpg');
    photo('a', 'p1', missing, null);
    photo('b', 'p1', empty, '');
    photo('c', 'p1', denied);
    const originalOpen = fs.openSync;
    mock.method(fs, 'openSync', (...args) => {
      if (args[0] === denied) throw Object.assign(new Error('PRIVATE_ERROR_SECRET'), { code: 'EACCES' });
      return originalOpen(...args);
    });
    const report = audit({ includeFailures: true });
    assert.deepEqual(report.failures, [
      { kind: 'photo', projectId: 'p1', photoId: 'a', path: missing, reason: 'ENOENT' },
      { kind: 'photo', projectId: 'p1', photoId: 'b', path: empty, reason: 'EMPTY_FILE' },
      { kind: 'photo', projectId: 'p1', photoId: 'c', path: denied, reason: 'EACCES' },
    ]);
    assert.equal(report.failuresTruncated, 0);
    assert.equal(JSON.stringify(report).includes('PRIVATE_ERROR_SECRET'), false);
  });

  it('details classify a project file and a photo directory by their actual type', () => {
    const folder = project('p1');
    const file = join(folder, 'ordinary.jpg');
    fs.writeFileSync(file, 'data');
    db.prepare('UPDATE projects SET base_folder = ?').run(file);
    photo('a', 'p1', folder, null);
    assert.deepEqual(audit({ includeFailures: true }).failures, [
      { kind: 'project_folder', projectId: 'p1', photoId: null, path: file, reason: 'NOT_DIRECTORY' },
      { kind: 'photo', projectId: 'p1', photoId: 'a', path: folder, reason: 'NOT_REGULAR_FILE' },
    ]);
  });

  it('details distinguish an unavailable mount, paths outside roots and rejected relative paths', () => {
    const folder = project('p1');
    const offlineRoot = join(directory, 'not-mounted');
    const offlinePhoto = join(offlineRoot, 'original.jpg');
    const outside = join(directory, 'outside.jpg');
    db.prepare('UPDATE projects SET base_folder = ?').run(offlineRoot);
    photo('a', 'p1', offlinePhoto, null);
    photo('b', 'p1', outside, null);
    photo('c', 'p1', 'relative.jpg', null);
    const report = audit({ includeFailures: true, allowedRoots: [storage, offlineRoot] });
    assert.deepEqual(report.failures, [
      { kind: 'project_folder', projectId: 'p1', photoId: null, path: offlineRoot, reason: 'MOUNT_UNAVAILABLE' },
      { kind: 'photo', projectId: 'p1', photoId: 'a', path: offlinePhoto, reason: 'MOUNT_UNAVAILABLE' },
      { kind: 'photo', projectId: 'p1', photoId: 'b', path: outside, reason: 'OUTSIDE_ROOT' },
      { kind: 'photo', projectId: 'p1', photoId: 'c', path: 'relative.jpg', reason: 'PATH_REJECTED' },
    ]);
    assert.ok(fs.statSync(folder).isDirectory());
  });

  it('details allowlist operating-system error codes and hide all other errors', () => {
    const folder = project('p1');
    for (const id of ['a', 'b', 'c']) photo(id, 'p1', join(folder, `${id}.jpg`));
    const realpath = fs.realpathSync;
    const errors = new Map([
      [join(folder, 'a.jpg'), 'EPERM'],
      [join(folder, 'b.jpg'), 'ENOTDIR'],
      [join(folder, 'c.jpg'), 'PRIVATE_ERROR_CODE'],
    ]);
    mock.method(fs, 'realpathSync', (...args) => {
      if (errors.has(args[0])) throw Object.assign(new Error('PRIVATE_ERROR_MESSAGE'), { code: errors.get(args[0]) });
      return realpath(...args);
    });
    const report = audit({ includeFailures: true });
    assert.deepEqual(report.failures.map((failure) => failure.reason), ['EPERM', 'ENOTDIR', 'IO_ERROR']);
    assert.equal(JSON.stringify(report).includes('PRIVATE_ERROR'), false);
  });

  it('details cap stored failures at 50 while retaining full audit counts and truncation count', () => {
    const insert = db.prepare('INSERT INTO projects VALUES (?, ?, ?)');
    for (let index = 0; index < 55; index += 1) {
      insert.run(String(index).padStart(2, '0'), 'Private project title', join(storage, `missing-${index}`));
    }
    const report = audit({ includeFailures: true });
    assert.equal(report.projectFolders.checked, 55);
    assert.equal(report.projectFolders.missing, 55);
    assert.equal(report.failures.length, 50);
    assert.equal(report.failuresTruncated, 5);
    assert.equal(report.failures[0].projectId, '00');
    assert.equal(report.failures.at(-1).projectId, '49');
  });

  it('failure paths remain absent unless details are explicitly enabled', () => {
    project('p1');
    photo('a', 'p1', join(storage, 'secret-private.jpg'), null);
    const report = audit();
    assert.equal(report.status, 'STAGING_COPY_FILES_MISSING');
    assert.equal(Object.hasOwn(report, 'failures'), false);
    assert.equal(Object.hasOwn(report, 'failuresTruncated'), false);
    assert.equal(JSON.stringify(report).includes(directory), false);
    const truthy = audit({ includeFailures: 'true' });
    assert.equal(Object.hasOwn(truthy, 'failures'), false);
  });

  it('CLI accepts --details explicitly and retains its safe error report', () => {
    const script = fileURLToPath(new URL('./audit-staging-copy.mjs', import.meta.url));
    const absent = join(directory, 'not-present.sqlite');
    const child = spawnSync(process.execPath, [script, '--database', absent, '--details'], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const report = JSON.parse(child.stdout);
    assert.equal(report.status, 'STAGING_COPY_INVALID_DATABASE');
    assert.deepEqual(report.failures, []);
    assert.equal(report.failuresTruncated, 0);
    assert.equal(fs.existsSync(absent), false);
  });

  it('locate finds the first absent middle directory without searching the NAS tree recursively', () => {
    const folder = project('p1');
    fs.mkdirSync(join(folder, 'Actual directory'));
    db.prepare('UPDATE projects SET base_folder = ?').run(join(folder, 'missing', 'deeper'));
    const report = audit({ locateFailures: true });
    const location = report.failures[0].location;
    assert.equal(location.deepestDirectory, fs.realpathSync(folder));
    assert.equal(location.firstMissingSegment, 'missing');
    assert.equal(location.reason, 'ENOENT');
    assert.deepEqual(location.nearbyDirectories, ['Actual directory']);
    assert.deepEqual(location.scan, { complete: true, truncated: false, entriesRead: 1 });
    assert.equal(location.walkTruncated, false);
  });

  it('locate suggests actual similar filenames with case, diacritic, underscore and space differences', () => {
    const folder = project('p1');
    const actualName = 'ŻÓŁĆ_2024.JPG';
    const missingName = 'zolc 2024.jpg';
    fs.writeFileSync(join(folder, actualName), 'original');
    photo('a', 'p1', join(folder, missingName), null);
    const report = audit({ locateFailures: true });
    const location = report.failures[0].location;
    assert.equal(location.firstMissingSegment, missingName);
    assert.equal(location.deepestDirectory, fs.realpathSync(folder));
    assert.deepEqual(location.suggestions, [actualName]);
    assert.equal(fs.existsSync(join(folder, missingName)), false);
  });

  it('locate never scans outside allowed roots and does not describe permission errors as missing', () => {
    const folder = project('p1');
    const denied = join(folder, 'denied.jpg');
    photo('a', 'p1', denied);
    photo('b', 'p1', join(directory, 'outside.jpg'), null);
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (...args) => {
      if (args[0] === denied) throw Object.assign(new Error('private'), { code: 'EACCES' });
      return realOpen(...args);
    });
    let listingCalls = 0;
    mock.method(fs, 'opendirSync', () => { listingCalls += 1; throw new Error('must not list'); });
    const report = audit({ locateFailures: true });
    const [permission, outside] = report.failures.map((failure) => failure.location);
    assert.equal(permission.firstMissingSegment, null);
    assert.equal(permission.reason, 'EACCES');
    assert.equal(permission.deepestDirectory, fs.realpathSync(folder));
    assert.equal(outside.reason, 'OUTSIDE_ROOT');
    assert.equal(outside.deepestDirectory, null);
    assert.equal(listingCalls, 0);
  });

  it('locate lists at most 2000 entries once for a shared parent and returns at most 12 suggestions', () => {
    const folder = project('p1');
    for (let index = 0; index < 2003; index += 1) fs.writeFileSync(join(folder, `photo-prefix-${index}.jpg`), '');
    photo('a', 'p1', join(folder, 'photo-prefix-missing.jpg'), null);
    photo('b', 'p1', join(folder, 'photo-prefix-other.jpg'), null);
    const realOpendir = fs.opendirSync;
    let listingCalls = 0;
    let entryReads = 0;
    mock.method(fs, 'opendirSync', (...args) => {
      listingCalls += 1;
      const handle = realOpendir(...args);
      return {
        readSync() { entryReads += 1; return handle.readSync(); },
        closeSync() { handle.closeSync(); },
      };
    });
    const report = audit({ locateFailures: true });
    assert.equal(listingCalls, 1);
    assert.equal(entryReads, 2000);
    for (const failure of report.failures) {
      assert.equal(failure.location.suggestions.length, 12);
      assert.deepEqual(failure.location.scan, { complete: false, truncated: true, entriesRead: 2000 });
    }
  });

  it('locate bounds directory walking to 64 components', () => {
    let deepest = storage;
    for (let index = 0; index < 64; index += 1) {
      deepest = join(deepest, 'a');
      fs.mkdirSync(deepest);
    }
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p1', 'private', join(deepest, 'unvisited', 'deeper'));
    const report = audit({ locateFailures: true });
    const location = report.failures[0].location;
    assert.equal(location.deepestDirectory, fs.realpathSync(deepest));
    assert.equal(location.firstMissingSegment, null);
    assert.equal(location.walkTruncated, true);
    assert.equal(location.scan.entriesRead, 0);
  });

  it('locate limits pretty JSON to 48 KiB without changing counts', () => {
    const longPrefix = 'VeryLongPrivateMissingFolder'.repeat(7);
    const insert = db.prepare('INSERT INTO projects VALUES (?, ?, ?)');
    for (let index = 0; index < 50; index += 1) {
      const longId = `p${index}-` + 'x'.repeat(1600);
      insert.run(longId, 'private', join(storage, `${longPrefix}-${index}`, longPrefix));
    }
    const report = audit({ locateFailures: true });
    assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2) + '\n', 'utf8') <= 48 * 1024);
    assert.equal(report.projectFolders.checked, 50);
    assert.equal(report.projectFolders.missing, 50);
    assert.ok(report.failuresTruncated > 0);
    assert.equal(report.failures.length + report.failuresTruncated, 50);
  });

  it('CLI --locate implies details while ordinary details remain location-free', () => {
    project('p1');
    photo('a', 'p1', join(storage, 'missing.jpg'), null);
    const details = audit({ includeFailures: true });
    assert.equal(Object.hasOwn(details.failures[0], 'location'), false);
    const script = fileURLToPath(new URL('./audit-staging-copy.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script, '--database', databasePath, '--locate'], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    const report = JSON.parse(child.stdout);
    assert.equal(report.status, 'STAGING_COPY_FILES_MISSING');
    assert.ok(report.failures[0].location);
    assert.equal(child.stderr, '');
  });
});
