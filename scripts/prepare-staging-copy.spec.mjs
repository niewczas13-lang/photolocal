import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildCopyConfiguration, prepareStagingCopy, startPreparedCopy, verifyResolvedConfiguration } from './prepare-staging-copy.mjs';
import { snapshotDatabase } from './snapshot-staging-database.mjs';
import { migrateDockerData } from './migrate-docker-data.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storage = { version: 1, volumeName: 'photolocal-staging-nas-ab12', containerPath: '/nas', subdirectory: 'Projects' };
const paths = {
  productionRoot: 'C:\\PhotoLocal', stagingRoot: 'C:\\PhotoLocal-staging',
  runDirectory: 'C:\\PhotoLocal-staging\\docker-data\\migration-ab12',
  networkPrefix: 'Z:\\Projects', storage,
};

test('copy mapping leaves production files on read-only mounts and gives SQLite a new staging directory', () => {
  const { mapping, override } = buildCopyConfiguration(paths);
  assert.deepEqual(mapping, [
    { from: 'Z:\\Projects', to: '/nas/Projects' },
    { from: 'C:\\PhotoLocal\\backend\\zdjęcia', to: '/legacy-local-photos' },
    { from: 'C:\\PhotoLocal\\pobierzchat\\pobrane_zdjecia', to: '/legacy-downloads' },
  ]);
  const mounts = override.services.photolocal.volumes;
  assert.equal(mounts.find(m => m.target === '/data').source, 'C:/PhotoLocal-staging/docker-data/migration-ab12/data');
  assert.ok(mounts.filter(m => m.target !== '/data').every(m => m.read_only));
  assert.deepEqual(override.volumes.staging_nas, { external: true, name: storage.volumeName });
  assert.equal(override.services.photolocal.environment.PHOTO_LOCAL_SHARED_ROOTS.includes('/nas/Projects'), true);
});

test('unsafe network mapping and mismatched manifest are rejected before a Docker operation', () => {
  for (const patch of [
    { networkPrefix: 'Z:\\Projects\\..\\secret' },
    { networkPrefix: '/nas/Projects' },
    { storage: { ...storage, subdirectory: '../secret' } },
    { storage: { ...storage, volumeName: 'unrelated-volume' } },
    { storage: { ...storage, containerPath: '/photos' } },
  ]) assert.throws(() => buildCopyConfiguration({ ...paths, ...patch }), { code: 'INVALID_CONFIGURATION' });
});

test('actual Compose merge replaces the data mount and preserves Google and isolated staging settings', async (context) => {
  const temp = await mkdtemp(join(tmpdir(), 'photolocal-copy-config-'));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const plan = buildCopyConfiguration(paths);
  const overridePath = join(temp, 'override.json');
  await writeFile(overridePath, JSON.stringify(plan.override));
  const result = spawnSync('docker', ['compose', '-p', 'photolocal-staging', '--env-file', join(repo, '.env.docker.example'), '-f', join(repo, 'compose.yaml'), '-f', overridePath, 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1', DOCKER_CONTEXT: '', PHOTO_LOCAL_HOST_PORT: '4874', PHOTO_LOCAL_BIND_IP: '127.0.0.1' },
  });
  if (result.error?.code === 'ENOENT') return context.skip('Docker CLI unavailable');
  assert.equal(result.status, 0, 'Compose accepts the override without an engine');
  const config = JSON.parse(result.stdout);
  const app = config.services.photolocal;
  assert.equal(app.environment.GOOGLE_CHAT_TOKEN_FILE, '/google/token.json');
  assert.equal(app.environment.GOOGLE_CHAT_JOB_STATE_FILE, '/data/google-chat-download.json');
  assert.equal(app.volumes.filter(m => m.target === '/data').length, 1);
  assert.ok(app.volumes.filter(m => ['/nas', '/legacy-local-photos', '/legacy-downloads'].includes(m.target)).every(m => m.read_only));
  assert.equal(app.ports[0].host_ip, '127.0.0.1');
  assert.equal(app.ports[0].published, '4874');
});

test('resolved configuration validation rejects public ports and writable production mounts', () => {
  const { override } = buildCopyConfiguration(paths);
  const config = { name: 'photolocal-staging', services: { photolocal: {
    image: 'photolocal:staging', ports: [{ host_ip: '127.0.0.1', published: '4874', target: 4873 }],
    volumes: [...override.services.photolocal.volumes,
      ...['google', 'downloads', 'photos'].map(name => ({ type: 'bind', source: `C:/PhotoLocal-staging/docker-data/${name}`, target: `/${name}` }))],
  } }, volumes: override.volumes };
  assert.doesNotThrow(() => verifyResolvedConfiguration(config, paths));
  const exposed = structuredClone(config);
  exposed.services.photolocal.ports[0].host_ip = '0.0.0.0';
  assert.throws(() => verifyResolvedConfiguration(exposed, paths), { code: 'UNSAFE_STAGING_CONFIGURATION' });
  const writable = structuredClone(config);
  writable.services.photolocal.volumes.find(m => m.target === '/legacy-downloads').read_only = false;
  assert.throws(() => verifyResolvedConfiguration(writable, paths), { code: 'UNSAFE_STAGING_CONFIGURATION' });
  const productionData = structuredClone(config);
  productionData.services.photolocal.volumes.find(m => m.target === '/data').source = 'C:/PhotoLocal/backend/data';
  assert.throws(() => verifyResolvedConfiguration(productionData, paths), { code: 'UNSAFE_STAGING_CONFIGURATION' });
});

test('an existing staging-copy manifest prevents snapshotting or touching Docker', { skip: process.platform !== 'win32' }, async (context) => {
  const temp = await mkdtemp(join(tmpdir(), 'photolocal-copy-existing-'));
  context.after(async () => {
    assert.ok(resolve(temp).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(temp, { recursive: true, force: true });
  });
  const stagingRoot = join(temp, 'staging');
  await mkdir(join(stagingRoot, 'docker-data'), { recursive: true });
  await writeFile(join(stagingRoot, 'docker-data', 'staging-copy.json'), 'existing');
  let calls = 0;
  await assert.rejects(prepareStagingCopy({ productionRoot: join(temp, 'production'), stagingRoot, networkPrefix: 'Z:\\Projects' }, {
    snapshot: async () => { calls++; }, invoke: async () => { calls++; },
  }), { code: 'COPY_ALREADY_PREPARED' });
  assert.equal(calls, 0);
  assert.equal(await readFile(join(stagingRoot, 'docker-data', 'staging-copy.json'), 'utf8'), 'existing');
});

for (const outcome of ['ok', 'files_missing', 'invalid_database', 'cleanup_failed']) {
test(`native snapshot and migration pipeline publishes ready settings only when storage is verified (${outcome})`, { skip: process.platform !== 'win32' }, async (context) => {
  const temp = await mkdtemp(join(tmpdir(), 'photolocal-staging-pipeline-'));
  context.after(async () => {
    assert.ok(resolve(temp).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(temp, { recursive: true, force: true });
  });
  const productionRoot = join(temp, 'production');
  const stagingRoot = join(temp, 'staging');
  for (const path of [join(productionRoot, 'backend', 'data'), join(productionRoot, 'backend', 'zdjęcia'),
    join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'), ...['data', 'google', 'downloads', 'photos'].map(name => join(stagingRoot, 'docker-data', name))]) await mkdir(path, { recursive: true });
  await writeFile(join(stagingRoot, '.env.docker'), 'PHOTO_LOCAL_HOST_PORT=4874\n');
  await writeFile(join(stagingRoot, 'docker-data', 'storage.json'), JSON.stringify(storage));
  const source = join(productionRoot, 'backend', 'data', 'photo-local.sqlite');
  const writer = new Database(source);
  context.after(() => { if (writer.open) writer.close(); });
  writer.pragma('journal_mode = WAL');
  writer.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,base_folder TEXT); CREATE TABLE photos(id TEXT PRIMARY KEY,project_id TEXT, storage_path TEXT); INSERT INTO projects VALUES('one','Z:\\Projects\\Job'); INSERT INTO photos VALUES('photo','one','Z:\\Projects\\Job\\photo.jpg');");
  const expectedCounts = { projects: 1, photos: 1, map_note_photos: null, chat_photo_batches: null, chat_photo_files: null };
  let runDirectory;
  const calls = [];
  const options = {
    snapshot: input => {
      assert.equal(input.source, source);
      return snapshotDatabase({ ...input, runtimeRoot: join(repo, 'backend') });
    },
    invoke: async args => {
      calls.push(args);
      if (args[0] === 'compose') {
        const overridePath = args[args.lastIndexOf('-f') + 1];
        runDirectory = dirname(overridePath);
        const config = JSON.parse(await readFile(overridePath, 'utf8'));
        config.name = 'photolocal-staging';
        const app = config.services.photolocal;
        app.image = 'photolocal:staging';
        app.ports = [{ host_ip: '127.0.0.1', published: '4874', target: 4873 }];
        app.volumes.push(...['google', 'photos', 'downloads'].map(name => ({ type: 'bind', source: join(stagingRoot, 'docker-data', name), target: `/${name}` })));
        return { code: 0, stdout: JSON.stringify(config), stderr: '' };
      }
      if (args[0] === 'container') return { code: 1, stdout: '', stderr: outcome === 'cleanup_failed' ? 'synthetic removal error' : 'No such container' };
      assert.equal(args[0], 'run');
      assert.ok(args.includes('--read-only'));
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      if (args.includes('/app/scripts/migrate-docker-data.mjs')) {
        assert.ok(!args.some(arg => arg.includes(productionRoot)), 'migration container must never mount production');
        await migrateDockerData({ source: join(runDirectory, 'source.sqlite'), output: join(runDirectory, 'data', 'photo-local.sqlite'), mapping: JSON.parse(await readFile(join(runDirectory, 'mapping.json'), 'utf8')) });
        const migrated = new Database(join(runDirectory, 'data', 'photo-local.sqlite'), { readonly: true });
        try { assert.equal(migrated.prepare('SELECT base_folder FROM projects').pluck().get(), '/nas/Projects/Job'); } finally { migrated.close(); }
        return { code: 0, stdout: 'Migrated', stderr: '' };
      }
      assert.ok(args.includes('/app/scripts/audit-staging-copy.mjs'));
      assert.ok(args.filter(arg => arg.startsWith('type=')).every(arg => arg.includes('readonly')));
      const status = outcome === 'files_missing' ? 'STAGING_COPY_FILES_MISSING' : outcome === 'invalid_database' ? 'STAGING_COPY_INVALID_DATABASE' : 'STAGING_COPY_VERIFIED';
      return { code: outcome === 'ok' ? 0 : 1, stderr: '', stdout: JSON.stringify({ status, counts: expectedCounts, projectFolders: { checked: 1, accessible: outcome === 'ok' ? 1 : 0, missing: outcome === 'ok' ? 0 : 1 }, photoSamples: { checked: 1, readable: 1, unreadable: 0 } }) };
    },
  };
  const prepare = prepareStagingCopy({ productionRoot, stagingRoot, networkPrefix: 'Z:\\Projects' }, options);
  if (outcome !== 'ok') {
    const code = { files_missing: 'STAGING_COPY_FILES_MISSING', invalid_database: 'STAGING_COPY_INVALID_DATABASE', cleanup_failed: 'TEMPORARY_CONTAINER_CLEANUP_REQUIRED' }[outcome];
    await assert.rejects(prepare, error => {
      assert.equal(error.code, code);
      assert.equal(error.runDirectory, runDirectory);
      if (outcome === 'cleanup_failed') assert.match(error.containerName, /^photolocal-staging-migrate-/);
      return true;
    });
    await assert.rejects(readFile(join(stagingRoot, 'docker-data', 'staging-copy.json')), { code: 'ENOENT' });
  } else {
    const report = await prepare;
    assert.equal(report.status, 'STAGING_COPY_READY');
    assert.deepEqual(report.counts, expectedCounts);
    assert.deepEqual(JSON.parse(await readFile(join(stagingRoot, 'docker-data', 'staging-copy.json'), 'utf8')), report);
  }
  assert.ok(!calls.some(args => args.includes('up') || args.includes('stop') || args.includes('down')));
  assert.equal(writer.prepare('SELECT base_folder FROM projects').pluck().get(), 'Z:\\Projects\\Job');
  writer.close();
});
}

test('starting a verified copy targets only staging and suppresses raw Docker mount errors', async () => {
  const report = { status: 'STAGING_COPY_READY', composeFile: 'C:\\PhotoLocal-staging\\docker-data\\migration-ab12\\compose.staging-copy.json' };
  let args;
  const started = await startPreparedCopy(report, 'C:\\PhotoLocal-staging', { invoke: async input => {
    args = input;
    return { code: 0, stdout: 'Healthy', stderr: '' };
  } });
  assert.equal(started.status, 'STAGING_COPY_RUNNING');
  assert.equal(args[args.indexOf('-p') + 1], 'photolocal-staging');
  assert.deepEqual(args.slice(-9), ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal']);
  await assert.rejects(startPreparedCopy(report, 'C:\\PhotoLocal-staging', { invoke: async () => ({ code: 1, stdout: '', stderr: 'password=DO_NOT_ECHO' }) }), error => error.code === 'STAGING_START_FAILED' && !String(error).includes('DO_NOT_ECHO'));
  await assert.rejects(startPreparedCopy({ ...report, status: 'STAGING_COPY_FILES_MISSING' }, 'C:\\PhotoLocal-staging'), { code: 'COPY_NOT_VERIFIED' });
});
