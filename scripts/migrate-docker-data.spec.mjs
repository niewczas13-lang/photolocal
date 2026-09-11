import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { migrateDockerData, remapPath, validateMappings } from './migrate-docker-data.mjs';

const mapping = [
  { from: 'P:\\Projects', to: '/photos' },
  { from: 'D:\\downloads', to: '/downloads' },
  { from: '\\\\server\\archive', to: '/archive' },
];

describe('Windows to Linux path mapping', () => {
  it('maps drive and UNC prefixes with segment boundaries and Windows case rules', () => {
    const validated = validateMappings(mapping);
    assert.equal(remapPath('p:\\projects\\Projekt A\\Foto.jpg', validated), '/photos/Projekt A/Foto.jpg');
    assert.equal(remapPath('\\\\SERVER\\archive\\Foto.jpg', validated), '/archive/Foto.jpg');
    assert.equal(remapPath('D:/downloads/batch/file.jpg', validated), '/downloads/batch/file.jpg');
    assert.equal(remapPath('P:\\Projects', validated), '/photos');
    assert.throws(() => remapPath('P:\\Projects-other\\file.jpg', validated), /Unmapped absolute path/);
  });

  it('uses the most specific Windows prefix', () => {
    const validated = validateMappings([
      { from: 'P:\\Projects', to: '/photos' },
      { from: 'P:\\Projects\\Special', to: '/special' },
    ]);
    assert.equal(remapPath('P:\\Projects\\Special\\f.jpg', validated), '/special/f.jpg');
  });

  it('preserves null/relative paths and permits existing Linux paths only in mapped roots', () => {
    const validated = validateMappings(mapping);
    assert.equal(remapPath(null, validated), null);
    assert.equal(remapPath('relative/file.jpg', validated), 'relative/file.jpg');
    assert.equal(remapPath('/photos/Foto.jpg', validated), '/photos/Foto.jpg');
    assert.throws(() => remapPath('/PHOTOS/Foto.jpg', validated), /Unmapped absolute path/);
    assert.throws(() => remapPath('/private/Foto.jpg', validated), /Unmapped absolute path/);
    assert.throws(() => remapPath('C:ambiguous.jpg', validated), /Unsupported path/);
    assert.throws(() => remapPath('P:\\Projects\\..\\secret.jpg', validated), /Unsupported path/);
  });

  for (const invalid of [
    [], {}, [null], [{ from: 'relative', to: '/photos' }],
    [{ from: 'C:relative', to: '/photos' }],
    [{ from: 'C:\\Photos', to: 'photos' }],
    [{ from: 'C:\\Photos', to: '/photos/../private' }],
    [{ from: 'C:\\Photos', to: '/photos\\nested' }],
    [{ from: 'C:\\Photos', to: '/photos' }, { from: 'c:\\photos', to: '/other' }],
    [{ from: 'C:\\Photos', to: '/photos' }, { from: 'D:\\Photos', to: '/photos/inner' }],
  ]) {
    it(`rejects invalid or ambiguous mapping ${JSON.stringify(invalid)}`, () => {
      assert.throws(() => validateMappings(invalid), /mapping/i);
    });
  }
});

describe('offline SQLite migration', () => {
  let directory;
  let source;
  let output;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'photo-local-migration-test-'));
    source = join(directory, 'source.sqlite');
    output = join(directory, 'linux.sqlite');
    const db = new Database(source);
    db.exec(await readFile(new URL('../backend/src/db/schema.sql', import.meta.url), 'utf8'));
    db.exec(`
      INSERT INTO projects (id, name, project_type, splitter_topology,
        splitter_topology_source, gpkg_file_name, base_folder)
        VALUES ('p', 'Project', 'SI', 'SINGLE', 'AUTO', 'test.gpkg', 'P:\\Projects\\Project A');
      INSERT INTO checklist_nodes (id, project_id, name, path, node_type)
        VALUES ('c', 'p', 'Photos', 'Logical\\Checklist', 'STATIC');
      INSERT INTO photos (id, project_id, checklist_node_id, source_file_name,
        stored_file_name, storage_path, thumbnail_path)
        VALUES ('f', 'p', 'c', 'f.jpg', 'f.jpg', 'P:\\Projects\\Project A\\f.jpg',
          'P:\\Projects\\Project A\\.thumbnails\\f.webp');
      INSERT INTO map_notes (id, project_id, target_type) VALUES ('n', 'p', 'free');
      INSERT INTO map_note_photos (id, project_id, note_id, source_file_name,
        stored_file_name, storage_path, thumbnail_path)
        VALUES ('mf', 'p', 'n', 'map.jpg', 'map.jpg', 'P:\\Projects\\map.jpg', NULL);
      INSERT INTO project_photo_hash_cache (project_id, storage_path, content_hash)
        VALUES ('p', '\\\\server\\archive\\old.jpg', 'image-hash');
      INSERT INTO chat_photo_batches (id, project_id, source, source_space_name,
        source_space_display_name, source_message_name, folder_name, folder_path, status)
        VALUES ('b', 'p', 'google-chat', 'spaces/test', 'Test', 'messages/test',
          'batch', 'D:\\downloads\\batch', 'PENDING_REVIEW');
      INSERT INTO chat_photo_files (id, batch_id, file_name, content_name, content_type, source_path)
        VALUES ('cf', 'b', 'f.jpg', 'attachments/test', 'image/jpeg', 'D:\\downloads\\batch\\f.jpg');
      INSERT INTO app_users (id, username, password_hash) VALUES ('u', 'test', 'secret-password-hash');
      INSERT INTO app_sessions (token, user_id) VALUES ('secret-session', 'u');
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('backs up and remaps every filesystem column without modifying source or logical paths', async () => {
    const original = await readFile(source);
    const report = await migrateDockerData({ source, output, mapping });
    const db = new Database(output, { readonly: true });
    assert.equal(db.prepare('SELECT base_folder FROM projects').pluck().get(), '/photos/Project A');
    assert.deepEqual(db.prepare('SELECT storage_path, thumbnail_path FROM photos').get(), {
      storage_path: '/photos/Project A/f.jpg', thumbnail_path: '/photos/Project A/.thumbnails/f.webp',
    });
    assert.deepEqual(db.prepare('SELECT storage_path, thumbnail_path FROM map_note_photos').get(), {
      storage_path: '/photos/map.jpg', thumbnail_path: null,
    });
    assert.equal(db.prepare('SELECT storage_path FROM project_photo_hash_cache').pluck().get(), '/archive/old.jpg');
    assert.equal(db.prepare('SELECT folder_path FROM chat_photo_batches').pluck().get(), '/downloads/batch');
    assert.equal(db.prepare('SELECT source_path FROM chat_photo_files').pluck().get(), '/downloads/batch/f.jpg');
    assert.equal(db.prepare('SELECT path FROM checklist_nodes').pluck().get(), 'Logical\\Checklist');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    assert.deepEqual(await readFile(source), original);
    assert.equal(report.columns.length, 8);
    const savedReport = await readFile(`${output}.migration.json`, 'utf8');
    assert.deepEqual(JSON.parse(savedReport).rollbackMapping, mapping.map(({ from, to }) => ({ from: to, to: from })));
    assert.ok(!savedReport.includes('secret-'));
    assert.deepEqual((await readdir(directory)).sort(), ['linux.sqlite', 'linux.sqlite.migration.json', 'source.sqlite']);
  });

  it('includes committed WAL data in its SQLite backup', async () => {
    const writer = new Database(source);
    try {
      writer.pragma('journal_mode = WAL');
      writer.prepare('UPDATE projects SET name = ?').run('Committed in WAL');
      const original = await readFile(source);
      const originalWal = await readFile(`${source}-wal`);
      await migrateDockerData({ source, output, mapping });
      const migrated = new Database(output, { readonly: true });
      assert.equal(migrated.prepare('SELECT name FROM projects').pluck().get(), 'Committed in WAL');
      migrated.close();
      assert.deepEqual(await readFile(source), original);
      assert.deepEqual(await readFile(`${source}-wal`), originalWal);
    } finally {
      writer.close();
    }
  });

  it('never creates SHM or other files beside an offline source with committed WAL', async () => {
    const offlineDirectory = join(directory, 'offline');
    await mkdir(offlineDirectory);
    const offlineSource = join(offlineDirectory, 'snapshot.sqlite');
    const writer = new Database(source);
    try {
      writer.pragma('journal_mode = WAL');
      writer.prepare('UPDATE projects SET name = ?').run('Offline committed WAL');
      await copyFile(source, offlineSource);
      await copyFile(`${source}-wal`, `${offlineSource}-wal`);
    } finally {
      writer.close();
    }
    const original = await readFile(offlineSource);
    const originalWal = await readFile(`${offlineSource}-wal`);
    await migrateDockerData({ source: offlineSource, output, mapping });
    assert.deepEqual((await readdir(offlineDirectory)).sort(), ['snapshot.sqlite', 'snapshot.sqlite-wal']);
    assert.deepEqual(await readFile(offlineSource), original);
    assert.deepEqual(await readFile(`${offlineSource}-wal`), originalWal);
    const migrated = new Database(output, { readonly: true });
    assert.equal(migrated.prepare('SELECT name FROM projects').pluck().get(), 'Offline committed WAL');
    migrated.close();
  });

  it('fails on an unmapped absolute path and removes only its temporary result', async () => {
    const db = new Database(source);
    db.prepare('UPDATE chat_photo_files SET source_path = ?').run('X:\\Unmapped\\f.jpg');
    db.close();
    const original = await readFile(source);
    await writeFile(join(directory, 'unrelated.txt'), 'keep');
    await assert.rejects(migrateDockerData({ source, output, mapping }), /Unmapped absolute path.*chat_photo_files.source_path/);
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual((await readdir(directory)).sort(), ['source.sqlite', 'unrelated.txt']);
  });

  it('rejects existing output, report, and SQLite sidecars without overwriting them', async () => {
    for (const path of [output, `${output}.migration.json`, `${output}-wal`]) {
      await writeFile(path, 'keep');
      await assert.rejects(migrateDockerData({ source, output, mapping }), /already exists/);
      assert.equal(await readFile(path, 'utf8'), 'keep');
      await rm(path);
    }
    await assert.rejects(migrateDockerData({ source, output: source, mapping }), /already exists|source/);
  });

  it('refuses to write an output over a currently absent source sidecar', async () => {
    await assert.rejects(migrateDockerData({ source, output: `${source}-wal`, mapping }), /source/);
    assert.deepEqual(await readdir(directory), ['source.sqlite']);
  });

  it('rolls back a destination collision and retains the original database', async () => {
    const db = new Database(source);
    db.exec(`INSERT INTO project_photo_hash_cache (project_id, storage_path, content_hash) VALUES
      ('p', 'P:\\Projects\\same.jpg', 'a'), ('p', 'p:\\projects\\same.jpg', 'b');`);
    db.close();
    const original = await readFile(source);
    await assert.rejects(migrateDockerData({ source, output, mapping }), /UNIQUE constraint/);
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readdir(directory), ['source.sqlite']);
  });
});
