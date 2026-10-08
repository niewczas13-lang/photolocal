import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { snapshotDatabase } from './snapshot-staging-database.mjs';

const runtimeRoot = fileURLToPath(new URL('../backend', import.meta.url));
const cliPath = fileURLToPath(new URL('./snapshot-staging-database.mjs', import.meta.url));
const tables = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];

describe('native online SQLite staging snapshot', () => {
  let directory;
  let source;
  let output;
  let writer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'photolocal-online-snapshot-test-'));
    await mkdir(join(directory, 'production'));
    await mkdir(join(directory, 'staging'));
    source = join(directory, 'production', 'source.sqlite');
    output = join(directory, 'staging', 'snapshot.sqlite');
    writer = new Database(source);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    for (const table of tables) {
      writer.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, private_value TEXT)`);
      writer.prepare(`INSERT INTO ${table} (private_value) VALUES (?)`).run('synthetic-private-data');
    }
  });

  afterEach(async () => {
    if (writer?.open) writer.close();
    const absolute = resolve(directory);
    const expectedParent = resolve(tmpdir());
    assert.equal(dirname(absolute), expectedParent);
    assert.ok(absolute.includes('photolocal-online-snapshot-test-'));
    await rm(absolute, { recursive: true, force: true });
  });

  it('captures committed WAL data while the production writer stays open', async () => {
    assert.ok((await readFile(`${source}-wal`)).length > 0);
    const result = await snapshotDatabase({ source, output, runtimeRoot });
    assert.deepEqual(result, {
      status: 'SNAPSHOT_OK', output,
      counts: Object.fromEntries(tables.map((table) => [table, 1])),
    });
    assert.deepEqual(await readdir(dirname(output)), ['snapshot.sqlite']);
    const snapshot = new Database(output, { readonly: true, fileMustExist: true });
    try {
      assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(snapshot.pragma('journal_mode', { simple: true }), 'delete');
      assert.equal(snapshot.prepare('SELECT private_value FROM photos').pluck().get(), 'synthetic-private-data');
    } finally { snapshot.close(); }
    writer.prepare('INSERT INTO photos (private_value) VALUES (?)').run('after-snapshot');
    assert.equal(writer.prepare('SELECT count(*) FROM photos').pluck().get(), 2);
  });

  it('returns null rather than a misleading zero for a missing table', async () => {
    writer.exec('DROP TABLE map_note_photos');
    const result = await snapshotDatabase({ source, output, runtimeRoot });
    assert.equal(result.counts.photos, 1);
    assert.equal(result.counts.map_note_photos, null);
  });

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    it(`refuses an existing destination${suffix || ' file'} without changing it`, async () => {
      await writeFile(`${output}${suffix}`, 'preserve-this-file');
      await assert.rejects(snapshotDatabase({ source, output, runtimeRoot }), { code: 'OUTPUT_EXISTS' });
      assert.equal(await readFile(`${output}${suffix}`, 'utf8'), 'preserve-this-file');
      assert.deepEqual(await readdir(dirname(output)), [`snapshot.sqlite${suffix}`]);
    });
  }

  it('requires a separate destination directory', async () => {
    await assert.rejects(snapshotDatabase({ source, output: source, runtimeRoot }), {
      code: 'SOURCE_DESTINATION_CONFLICT',
    });
    await assert.rejects(snapshotDatabase({ source, output: join(dirname(source), 'new.sqlite'), runtimeRoot }), {
      code: 'SOURCE_DESTINATION_CONFLICT',
    });
  });

  it('refuses missing source and destination parent without creating either', async () => {
    await assert.rejects(snapshotDatabase({ source: join(dirname(source), 'missing.sqlite'), output, runtimeRoot }), {
      code: 'SOURCE_INVALID',
    });
    await assert.rejects(snapshotDatabase({ source, output: join(directory, 'missing', 'new.sqlite'), runtimeRoot }), {
      code: 'OUTPUT_DIRECTORY_INVALID',
    });
    assert.deepEqual(await readdir(dirname(output)), []);
  });

  it('refuses a non-file source', async () => {
    await assert.rejects(snapshotDatabase({ source: dirname(source), output, runtimeRoot }), { code: 'SOURCE_INVALID' });
  });

  it('refuses a source symlink', async (t) => {
    const sourceLink = join(dirname(source), 'link.sqlite');
    try { await symlink(source, sourceLink, 'file'); } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Windows host does not allow creating test symlinks');
        return;
      }
      throw error;
    }
    await assert.rejects(snapshotDatabase({ source: sourceLink, output, runtimeRoot }), { code: 'SOURCE_INVALID' });
  });

  it('bounds a real backup through its progress callback and removes partial files', async () => {
    let clockCalls = 0;
    const now = () => clockCalls++ === 0 ? 0 : 60_001;
    await assert.rejects(snapshotDatabase({ source, output, runtimeRoot }, { now }), { code: 'SNAPSHOT_TIMEOUT' });
    assert.deepEqual(await readdir(dirname(output)), []);
    assert.equal(writer.prepare('SELECT count(*) FROM photos').pluck().get(), 1);
  });

  it('keeps the completed snapshot consistent when another connection writes during backup', async () => {
    writer.exec('CREATE TABLE padding (bytes BLOB)');
    writer.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(2 * 1024 * 1024);
    let clockCalls = 0;
    let wrote = false;
    const now = () => {
      clockCalls += 1;
      if (clockCalls === 2) {
        writer.prepare('INSERT INTO photos (private_value) VALUES (?)').run('concurrent-commit');
        wrote = true;
      }
      return 0;
    };
    const result = await snapshotDatabase({ source, output, runtimeRoot }, { now });
    assert.equal(wrote, true);
    assert.equal(result.counts.photos, 2);
    assert.deepEqual(await readdir(dirname(output)), ['snapshot.sqlite']);
  });

  it('does not overwrite a destination created while backup is running', async () => {
    let clockCalls = 0;
    const now = () => {
      clockCalls += 1;
      if (clockCalls === 2) writeFileSync(output, 'concurrent-owner');
      return 0;
    };
    await assert.rejects(snapshotDatabase({ source, output, runtimeRoot }, { now }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(output, 'utf8'), 'concurrent-owner');
    assert.deepEqual(await readdir(dirname(output)), ['snapshot.sqlite']);
  });

  it('reports invalid SQLite without leaking database content', async () => {
    writer.close();
    await writeFile(source, 'synthetic-secret-that-must-not-escape');
    await assert.rejects(snapshotDatabase({ source, output, runtimeRoot }), (error) => {
      assert.equal(error.code, 'SNAPSHOT_FAILED');
      assert.equal(error.message, 'SNAPSHOT_FAILED');
      return true;
    });
    assert.deepEqual(await readdir(dirname(output)), []);
  });

  it('uses the requested native runtime and reports a missing runtime safely', async () => {
    await assert.rejects(snapshotDatabase({ source, output, runtimeRoot: directory }), {
      code: 'SQLITE_RUNTIME_UNAVAILABLE',
    });
    assert.deepEqual(await readdir(dirname(output)), []);
  });

  it('rejects a nonexistent runtime root even when its ancestor has dependencies', async () => {
    await assert.rejects(snapshotDatabase({ source, output,
      runtimeRoot: join(runtimeRoot, 'nonexistent-snapshot-runtime-root') }), {
      code: 'SQLITE_RUNTIME_UNAVAILABLE',
    });
    assert.deepEqual(await readdir(dirname(output)), []);
  });

  it('runs the CLI outside the checkout and emits only its summary', async () => {
    const child = spawnSync(process.execPath, [cliPath, '--source', source, '--output', output,
      '--runtime-root', runtimeRoot], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'SNAPSHOT_OK');
    assert.equal(result.counts.photos, 1);
    assert.equal(child.stdout.includes('synthetic-private-data'), false);
  });

  it('prints a fixed CLI failure without raw arguments or exception text', () => {
    const child = spawnSync(process.execPath, [cliPath, '--unknown', 'synthetic-private-data'], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { status: 'INVALID_ARGUMENTS' });
    assert.equal(child.stdout.includes('synthetic-private-data'), false);
  });
});
