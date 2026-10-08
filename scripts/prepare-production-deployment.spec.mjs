import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectSourceDatabase, inventoryLocalTree, prepareProductionDeployment, resolveSourceEnvironment } from './prepare-production-deployment.mjs';

const secret = 'SYNTHETIC_PRIVATE_$VALUE';
const imageId = `sha256:${'a'.repeat(64)}`;
const storage = { version: 2, accessMode: 'rw', volumeName: `photolocal-production-nas-${'a'.repeat(32)}`, containerPath: '/nas', subdirectory: 'Projects' };
const publicUrl = 'https://photos.example.invalid';
const scopes = { process: {}, user: {}, machine: {} };
const sourceCounts = { projects: 32, photos: 100, map_note_photos: 0, chat_photo_batches: 20, chat_photo_files: 30 };

async function fixture(t) {
  // Windows CI may supply TEMP as an 8.3 alias; production requires canonical paths.
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'photolocal production prep '));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${tempRoot}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('environment resolution preserves registered integrations and never merges unknown terminal overrides', () => {
  const source = resolveSourceEnvironment({ PHOTO_LOCAL_DB: '.\\data\\photo-local.sqlite' }, {
    process: { ADRESY_APP_API_KEY: secret }, user: { ADRESY_APP_API_KEY: secret }, machine: {},
  });
  assert.equal(source.ADRESY_APP_API_KEY, secret);
  assert.equal(source.PHOTO_LOCAL_DB, '.\\data\\photo-local.sqlite');
  for (const supplied of [
    { ...scopes, process: { ADRESY_APP_API_KEY: secret } },
    { ...scopes, user: { ADRESY_APP_API_KEY: secret } },
    { ...scopes, process: { PHOTO_LOCAL_DB: 'different' }, machine: { PHOTO_LOCAL_DB: 'different' } },
  ]) {
    assert.throws(() => resolveSourceEnvironment({ PHOTO_LOCAL_DB: 'original' }, supplied), (error) => {
      assert.equal(error.code, 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED');
      assert.ok(Array.isArray(error.settingNames));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
  assert.equal(resolveSourceEnvironment({ ADRESY_APP_API_KEY: '' }, { ...scopes, process: { ADRESY_APP_API_KEY: '' } }).ADRESY_APP_API_KEY, '');
});

test('local inventory includes hidden download metadata and rejects junction traversal', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.receipts'));
  await writeFile(join(root, '.spaces.json'), '{}');
  await writeFile(join(root, '.receipts', 'item.json'), 'abc');
  assert.deepEqual(await inventoryLocalTree(root), { files: 2, bytes: 5 });
  await assert.rejects(inventoryLocalTree(root, { maxEntries: 1 }), { code: 'LOCAL_STORAGE_SCAN_LIMIT' });
  const outside = await fixture(t);
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inventoryLocalTree(root), { code: 'LOCAL_STORAGE_UNAVAILABLE' });
});

async function deploymentFixture(t) {
  const root = await fixture(t);
  const productionRoot = join(root, 'PhotoLocal');
  const stagingRoot = join(root, 'PhotoLocal-staging');
  const runDirectory = join(stagingRoot, 'docker-data', `production-${'b'.repeat(32)}`);
  for (const directory of [
    join(productionRoot, 'backend', 'data'), join(productionRoot, 'backend', 'zdjęcia'),
    join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'), runDirectory,
    join(stagingRoot, 'docker-data', 'google'),
  ]) await mkdir(directory, { recursive: true });
  // JSON parser is injected for fixture env files. Production loads dotenv.parse
  // from the installed native backend without importing application configuration.
  await writeFile(join(productionRoot, '.env'), JSON.stringify({ PHOTO_LOCAL_DB: '.\\data\\photo-local.sqlite', ADRESY_APP_API_KEY: secret }));
  await writeFile(join(stagingRoot, '.env.docker'), '{}');
  await writeFile(join(productionRoot, 'backend', 'data', 'photo-local.sqlite'), 'synthetic-db');
  await writeFile(join(productionRoot, 'backend', 'zdjęcia', 'image.jpg'), 'photo');
  await writeFile(join(productionRoot, 'pobierzchat', 'pobrane_zdjecia', '.spaces.json'), '{}');
  await writeFile(join(stagingRoot, 'docker-data', 'production-storage.json'), JSON.stringify(storage));
  const client = { web: { client_id: 'fixture-client', client_secret: secret, redirect_uris: [`${publicUrl}/api/google-chat/auth/callback`] } };
  const token = { client_id: 'fixture-client', client_secret: secret, refresh_token: secret, scopes: ['https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'] };
  await writeFile(join(stagingRoot, 'docker-data', 'google', 'credentials.json'), JSON.stringify(client));
  await writeFile(join(stagingRoot, 'docker-data', 'google', 'token.json'), JSON.stringify(token));
  const input = { productionRoot, stagingRoot, runDirectory, networkPrefix: 'Z:\\Projects', publicUrl, environmentScopes: scopes };
  const calls = [];
  const dependencies = {
    parseDotenv: JSON.parse,
    inspectDatabase: () => sourceCounts,
    getFreeBytes: async () => 10 * 1024 ** 3,
    invoke: async (args) => {
      calls.push(args);
      if (args[0] === 'image') return { code: 0, stdout: imageId, stderr: '', timedOut: false };
      if (args[0] === 'compose' && args.includes('config')) {
        const compose = JSON.parse(await readFile(join(runDirectory, 'compose.production.json'), 'utf8'));
        // Compose serializes literal dollars re-escaped; the builder suite
        // independently verifies this representation with the real Docker CLI.
        return { code: 0, stdout: JSON.stringify(compose), stderr: '', timedOut: false };
      }
      throw new Error('Unexpected Docker mutation');
    },
  };
  return { input, dependencies, calls };
}

test('preparation creates isolated configuration and Google copies without starting services or copying a live database', { skip: process.platform !== 'win32' }, async (t) => {
  const { input, dependencies, calls } = await deploymentFixture(t);
  const report = await prepareProductionDeployment(input, dependencies);
  assert.equal(report.status, 'PRODUCTION_CONFIG_PREPARED');
  assert.equal(report.productionCutover, 'NOT_PERFORMED');
  assert.equal(report.nextStep, 'FINAL_SNAPSHOT_REQUIRED');
  assert.deepEqual(report.sourceCounts, sourceCounts);
  assert.equal(report.sourceDatabase, join(input.productionRoot, 'backend', 'data', 'photo-local.sqlite'));
  assert.deepEqual(report.localFiles, { downloads: { files: 1, bytes: 2 }, localPhotos: { files: 1, bytes: 5 } });
  assert.deepEqual(await readdir(join(input.runDirectory, 'data')), []);
  assert.deepEqual(await readdir(join(input.runDirectory, 'downloads')), []);
  assert.deepEqual(await readdir(join(input.runDirectory, 'local-photos')), []);
  assert.equal(await readFile(join(input.productionRoot, 'backend', 'data', 'photo-local.sqlite'), 'utf8'), 'synthetic-db');
  assert.equal(JSON.parse(await readFile(join(input.runDirectory, 'google', 'token.json'), 'utf8')).refresh_token, secret);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(calls.length, 2);
  const manifest = JSON.parse(await readFile(join(input.runDirectory, 'production-preparation.json'), 'utf8'));
  assert.equal(manifest.status, 'PRODUCTION_CONFIG_PREPARED');
  assert.ok(!JSON.stringify(manifest).includes(secret));
});

test('source database inspection is read-only and rejects an unrelated schema', () => {
  let closed = 0;
  class ReadOnlyDatabase {
    constructor(path, options) {
      assert.equal(path, 'fixture.sqlite');
      assert.equal(options.readonly, true);
      assert.equal(options.fileMustExist, true);
    }
    prepare(sql) {
      const table = /FROM ([a-z_]+)/.exec(sql)?.[1];
      if (sql.includes('sqlite_schema')) return { get: name => name === 'projects' ? { present: 1 } : undefined };
      return { pluck: () => ({ get: () => sourceCounts[table] }) };
    }
    close() { closed += 1; }
  }
  assert.throws(() => inspectSourceDatabase('fixture.sqlite', '.', { Database: ReadOnlyDatabase }), { code: 'SOURCE_DATABASE_INVALID' });
  assert.equal(closed, 1);
});

test('Windows source environment treats casing consistently and refuses conflicting case variants', () => {
  assert.equal(resolveSourceEnvironment({ photo_local_db: 'data.sqlite' }, scopes).PHOTO_LOCAL_DB, 'data.sqlite');
  assert.throws(() => resolveSourceEnvironment({ photo_local_db: 'one', PHOTO_LOCAL_DB: 'two' }, scopes), { code: 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED' });
});

test('native SQLite inspection reads committed WAL counts while the original writer stays usable', async (t) => {
  let Database;
  try { Database = createRequire(import.meta.url)('better-sqlite3'); }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return t.skip('Native backend dependencies unavailable in this job');
    throw error;
  }
  const root = await fixture(t);
  const path = join(root, 'native.sqlite');
  const writer = new Database(path);
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    for (const table of Object.keys(sourceCounts)) {
      writer.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      writer.exec(`INSERT INTO ${table} DEFAULT VALUES`);
    }
    const counts = inspectSourceDatabase(path, fileURLToPath(new URL('../backend', import.meta.url)));
    assert.deepEqual(counts, Object.fromEntries(Object.keys(sourceCounts).map(table => [table, 1])));
    writer.exec('INSERT INTO photos DEFAULT VALUES');
    assert.equal(writer.prepare('SELECT count(*) FROM photos').pluck().get(), 2);
    writer.exec('DROP TABLE chat_photo_files');
    assert.throws(() => inspectSourceDatabase(path, '.', { Database }), { code: 'SOURCE_DATABASE_INVALID' });
  } finally { writer.close(); }
});

test('preparation refuses disk shortage, mismatched Google token and a missing public callback before publishing', { skip: process.platform !== 'win32' }, async (t) => {
  for (const issue of ['disk', 'token', 'callback']) {
    const { input, dependencies } = await deploymentFixture(t);
    if (issue === 'disk') dependencies.getFreeBytes = async () => 1;
    if (issue === 'token') await writeFile(join(input.stagingRoot, 'docker-data', 'google', 'token.json'), JSON.stringify({ refresh_token: secret, client_id: 'different' }));
    if (issue === 'callback') await writeFile(join(input.stagingRoot, 'docker-data', 'google', 'credentials.json'), JSON.stringify({ web: { client_id: 'fixture-client', client_secret: secret, redirect_uris: ['http://localhost:4874/api/google-chat/auth/callback'] } }));
    await assert.rejects(prepareProductionDeployment(input, dependencies), { code: { disk: 'INSUFFICIENT_DISK_SPACE', token: 'GOOGLE_TOKEN_INVALID', callback: 'GOOGLE_CALLBACK_NOT_LISTED' }[issue] });
    assert.ok(!(await readdir(input.runDirectory)).includes('production-preparation.json'));
  }
});

test('preparation never overwrites a previous deployment directory', { skip: process.platform !== 'win32' }, async (t) => {
  const { input, dependencies, calls } = await deploymentFixture(t);
  await writeFile(join(input.runDirectory, 'existing.txt'), 'keep');
  await assert.rejects(prepareProductionDeployment(input, dependencies), { code: 'PRIVATE_DIRECTORY_INVALID' });
  assert.equal(await readFile(join(input.runDirectory, 'existing.txt'), 'utf8'), 'keep');
  assert.equal(calls.length, 0);
});
