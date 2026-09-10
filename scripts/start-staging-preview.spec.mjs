import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 as path } from 'node:path';
import test from 'node:test';
import { buildCopyConfiguration } from './prepare-staging-copy.mjs';
import { startStagingPreview } from './start-staging-preview.mjs';

function fixture() {
  const productionRoot = 'C:\\PhotoLocal';
  const stagingRoot = 'C:\\PhotoLocal-staging';
  const runDirectory = path.join(stagingRoot, 'docker-data', 'migration-example');
  const storage = { version: 1, volumeName: 'photolocal-staging-nas-ab12', containerPath: '/nas', subdirectory: 'Projects' };
  const counts = { projects: 32, photos: 14258, map_note_photos: 0, chat_photo_batches: 2843, chat_photo_files: 5587 };
  const plan = buildCopyConfiguration({ productionRoot, stagingRoot, runDirectory, storage, networkPrefix: 'Z:\\Projects' });
  const resolved = { ...structuredClone(plan.override), name: 'photolocal-staging' };
  Object.assign(resolved.services.photolocal, { image: 'photolocal:staging', ports: [{ host_ip: '127.0.0.1', published: '4874', target: 4873 }] });
  Object.assign(resolved.services.photolocal.environment, { PHOTO_LOCAL_AUTH: 'enabled', PHOTO_LOCAL_DB: '/data/photo-local.sqlite' });
  resolved.services.photolocal.volumes.push(...['google', 'photos', 'downloads'].map(name => ({ type: 'bind', source: path.join(stagingRoot, 'docker-data', name), target: `/${name}`, bind: { create_host_path: false } })));
  const diagnosis = { status: 'STAGING_DIAGNOSIS_COMPLETE', counts, projectFolders: { checked: 32, accessible: 30, missing: 2 }, photoSamples: { checked: 75, readable: 54, unreadable: 21 }, locations: [], reportPath: path.join(runDirectory, 'diagnosis-ab12.json') };
  const manifest = path.join(stagingRoot, 'docker-data', 'staging-preview.json');
  const files = new Map([
    [path.join(stagingRoot, 'docker-data', 'storage.json'), storage],
    [path.join(runDirectory, 'mapping.json'), plan.mapping],
    [path.join(runDirectory, 'compose.staging-copy.json'), plan.override],
    [path.join(runDirectory, 'snapshot.json'), { status: 'SNAPSHOT_OK', output: path.join(runDirectory, 'source.sqlite'), counts }],
    [path.join(runDirectory, 'audit.json'), { ...diagnosis, status: 'STAGING_COPY_FILES_MISSING' }],
  ].map(([key, value]) => [key, JSON.stringify(value)]));
  const calls = [];
  const io = {
    readFileSync: name => { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); },
    writeFileSync: (name, data, options) => { assert.equal(options.flag, 'wx'); assert.equal(files.has(name), false); files.set(name, data); },
    lstatSync: name => ({ isSymbolicLink: () => false, isDirectory: () => !name.endsWith('.sqlite'), isFile: () => name.endsWith('.sqlite'), size: 4096 }),
    realpathSync: name => name,
  };
  const options = { io, diagnose: async input => { calls.push(['diagnose', input]); return structuredClone(diagnosis); }, invoke: async args => {
    calls.push(args);
    return { code: 0, stdout: args.includes('config') ? JSON.stringify(resolved) : 'Healthy', stderr: '' };
  } };
  return { runDirectory, stagingRoot, manifest, files, resolved, diagnosis, calls, options };
}

test('existing copy starts preview with explicit missing-file warnings and no production mutations', async () => {
  const f = fixture();
  const report = await startStagingPreview({ runDirectory: f.runDirectory }, f.options);
  assert.equal(report.status, 'STAGING_PREVIEW_RUNNING');
  assert.equal(report.storageSampleChecksPassed, false);
  assert.equal(report.projectFolders.missing, 2);
  assert.equal(report.photoSamples.unreadable, 21);
  assert.equal(report.url, 'http://localhost:4874');
  assert.deepEqual(f.calls[0], ['diagnose', { runDirectory: f.runDirectory, locate: true }]);
  const args = f.calls.at(-1);
  assert.equal(args[args.indexOf('-p') + 1], 'photolocal-staging');
  assert.deepEqual(args.slice(-9), ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal']);
  assert.equal(JSON.parse(f.files.get(f.manifest)).status, 'PREVIEW_READY');
  assert.equal(f.files.size, 6, 'only a new separate preview manifest is written');
});

test('the same preview can retry without overwriting its manifest and receives a fresh audit', async () => {
  const f = fixture();
  await startStagingPreview({ runDirectory: f.runDirectory }, f.options);
  const manifest = f.files.get(f.manifest);
  await startStagingPreview({ runDirectory: f.runDirectory }, f.options);
  assert.equal(f.files.get(f.manifest), manifest);
  assert.equal(f.calls.filter(call => call[0] === 'diagnose').length, 2);
});

for (const change of ['count', 'missing-count', 'all-folders', 'all-photos', 'unknown-audit', 'malformed-totals']) {
  test(`unsafe or incomplete audit blocks preview (${change})`, async () => {
    const f = fixture();
    if (change === 'count') f.diagnosis.counts = { ...f.diagnosis.counts, photos: 1 };
    if (change === 'missing-count') delete f.diagnosis.counts.chat_photo_files;
    if (change === 'all-folders') f.diagnosis.projectFolders = { checked: 32, accessible: 0, missing: 32 };
    if (change === 'all-photos') f.diagnosis.photoSamples = { checked: 75, readable: 0, unreadable: 75 };
    if (change === 'unknown-audit') f.diagnosis.status = 'UNKNOWN';
    if (change === 'malformed-totals') f.diagnosis.projectFolders.missing = 0;
    await assert.rejects(startStagingPreview({ runDirectory: f.runDirectory }, f.options));
    assert.equal(f.calls.some(call => call.includes('up')), false);
    assert.equal(f.files.has(f.manifest), false);
  });
}

for (const change of ['public-port', 'writable-nas', 'production-data', 'unauthenticated', 'junction', 'wrong-volume']) {
  test(`unsafe configuration cannot start preview (${change})`, async () => {
    const f = fixture();
    const app = f.resolved.services.photolocal;
    if (change === 'public-port') app.ports[0].host_ip = '0.0.0.0';
    if (change === 'writable-nas') app.volumes.find(m => m.target === '/nas').read_only = false;
    if (change === 'production-data') app.volumes.find(m => m.target === '/data').source = 'C:\\PhotoLocal\\backend\\data';
    if (change === 'unauthenticated') app.environment.PHOTO_LOCAL_AUTH = 'disabled';
    if (change === 'junction') f.options.io.realpathSync = () => 'C:\\PhotoLocal\\backend\\data';
    if (change === 'wrong-volume') f.resolved.volumes.staging_nas.name = 'different-volume';
    await assert.rejects(startStagingPreview({ runDirectory: f.runDirectory }, f.options));
    assert.equal(f.calls.some(call => call.includes('up')), false);
    assert.equal(f.files.has(f.manifest), false);
  });
}

test('other prepared copies and manifests prevent switching the selected staging database', async () => {
  for (const name of ['staging-copy.json', 'staging-preview.json']) {
    const f = fixture();
    const file = path.join(f.stagingRoot, 'docker-data', name);
    f.files.set(file, JSON.stringify({ version: 1, status: 'PREVIEW_READY', runDirectory: 'C:\\elsewhere' }));
    await assert.rejects(startStagingPreview({ runDirectory: f.runDirectory }, f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('failed Docker startup returns a fixed status without exposing captured mount credentials', async () => {
  const f = fixture();
  const invoke = f.options.invoke;
  f.options.invoke = args => args.includes('up') ? { code: 1, stdout: '', stderr: 'password=DO_NOT_ECHO' } : invoke(args);
  await assert.rejects(startStagingPreview({ runDirectory: f.runDirectory }, f.options), error => error.code === 'STAGING_PREVIEW_START_FAILED' && !String(error).includes('DO_NOT_ECHO'));
  assert.equal(JSON.parse(f.files.get(f.manifest)).status, 'PREVIEW_READY');
});

test('relative, nested, and non-migration paths are refused before reading or Docker calls', async () => {
  for (const runDirectory of ['migration-example', 'C:\\PhotoLocal-staging\\docker-data\\data', 'C:\\PhotoLocal-staging\\docker-data\\extra\\migration-example']) {
    const f = fixture();
    await assert.rejects(startStagingPreview({ runDirectory }, f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('native Windows paths and actual offline Compose retain all production mounts read-only', { skip: process.platform !== 'win32' }, async context => {
  const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (available.error?.code === 'ENOENT') return context.skip('Docker CLI unavailable');
  assert.equal(available.status, 0, 'Docker Compose CLI is available');
  const root = fs.mkdtempSync(path.join(tmpdir(), 'photolocal-preview-'));
  context.after(() => {
    assert.equal(path.dirname(root), path.normalize(tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const productionRoot = path.join(root, 'production');
  const stagingRoot = path.join(root, 'staging');
  const runDirectory = path.join(stagingRoot, 'docker-data', 'migration-example');
  for (const folder of [path.join(productionRoot, 'backend', 'zdjęcia'), path.join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'),
    path.join(runDirectory, 'data'), ...['google', 'photos', 'downloads'].map(name => path.join(stagingRoot, 'docker-data', name))]) fs.mkdirSync(folder, { recursive: true });
  const storage = { version: 1, volumeName: 'photolocal-staging-nas-ab12', containerPath: '/nas', subdirectory: 'Projects' };
  const plan = buildCopyConfiguration({ productionRoot, stagingRoot, runDirectory, storage, networkPrefix: 'Z:\\Projects' });
  const f = fixture();
  const audit = { ...f.diagnosis, reportPath: path.join(runDirectory, 'diagnosis-ab12.json') };
  for (const [name, value] of [
    [path.join(stagingRoot, 'docker-data', 'storage.json'), storage],
    [path.join(runDirectory, 'mapping.json'), plan.mapping], [path.join(runDirectory, 'compose.staging-copy.json'), plan.override],
    [path.join(runDirectory, 'snapshot.json'), { status: 'SNAPSHOT_OK', output: path.join(runDirectory, 'source.sqlite'), counts: audit.counts }],
    [path.join(runDirectory, 'audit.json'), { ...audit, status: 'STAGING_COPY_FILES_MISSING' }],
  ]) fs.writeFileSync(name, JSON.stringify(value));
  fs.writeFileSync(path.join(runDirectory, 'source.sqlite'), 'synthetic-source');
  fs.writeFileSync(path.join(runDirectory, 'data', 'photo-local.sqlite'), 'synthetic-copy');
  fs.copyFileSync(new URL('../compose.yaml', import.meta.url), path.join(stagingRoot, 'compose.yaml'));
  fs.writeFileSync(path.join(stagingRoot, '.env.docker'), 'PHOTO_LOCAL_HOST_PORT=4874\nPHOTO_LOCAL_BIND_IP=127.0.0.1\n');
  let upCalled = false;
  const result = await startStagingPreview({ runDirectory }, { diagnose: async () => audit, invoke: async args => {
    if (args.includes('up')) { upCalled = true; return { code: 0, stdout: '', stderr: '' }; }
    const child = spawnSync('docker', args, { encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1', DOCKER_CONTEXT: '', PHOTO_LOCAL_HOST_PORT: '4874', PHOTO_LOCAL_BIND_IP: '127.0.0.1' } });
    assert.equal(child.status, 0, 'actual Compose validates without an engine');
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  } });
  assert.equal(upCalled, true);
  assert.equal(result.status, 'STAGING_PREVIEW_RUNNING');
  assert.equal(fs.readFileSync(path.join(runDirectory, 'source.sqlite'), 'utf8'), 'synthetic-source');
  assert.equal(fs.readFileSync(path.join(runDirectory, 'data', 'photo-local.sqlite'), 'utf8'), 'synthetic-copy');
});
