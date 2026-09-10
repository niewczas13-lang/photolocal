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

  function audit() {
    if (db.open) db.close();
    return auditStagingCopy(databasePath, { allowedRoots: [storage] });
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
});
