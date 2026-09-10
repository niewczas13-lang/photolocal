import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildProductionConfiguration } from './production-deployment-config.mjs';
import { preflightProductionCutover, finalizeProductionData } from './finalize-production-data.mjs';
import { snapshotDatabase } from './snapshot-staging-database.mjs';
import { inspectSourceDatabase } from './prepare-production-deployment.mjs';

const windows = { skip: process.platform !== 'win32' };
const counts = { projects: 1, photos: 2, map_note_photos: 0, chat_photo_batches: 2, chat_photo_files: 3 };
const scopes = { process: {}, user: {}, machine: {} };
const hash = value => createHash('sha256').update(value).digest('hex');
const audit = () => ({ status: 'STAGING_COPY_VERIFIED', counts: { ...counts },
  projectFolders: { checked: 1, accessible: 1, missing: 0 }, photoSamples: { checked: 2, readable: 2, unreadable: 0 },
  projectsWithoutPhotos: 0, failures: [], failuresTruncated: 0 });
function gap(path = '/nas/Projects/missing.jpg', reason = 'ENOENT') {
  return { ...audit(), status: 'STAGING_COPY_FILES_MISSING', photoSamples: { checked: 2, readable: 1, unreadable: 1 },
    failures: [{ kind: 'photo', projectId: 'project-one', photoId: 'photo-one', path, reason }] };
}

async function fixture(context) {
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'photolocal-finalize-'));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${tempRoot}${sep}`));
    assert.notEqual(resolve(root), tempRoot);
    await rm(root, { recursive: true, force: true });
  });
  const productionRoot = join(root, 'production');
  const stagingRoot = join(root, 'staging');
  const runDirectory = join(stagingRoot, 'docker-data', `production-${'b'.repeat(32)}`);
  for (const path of [join(productionRoot, 'backend', 'data'), join(productionRoot, 'backend', 'zdjęcia'),
    join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'), join(stagingRoot, 'docker-data', 'google'),
    ...['data', 'google', 'downloads', 'local-photos', 'photos'].map(name => join(runDirectory, name))]) await mkdir(path, { recursive: true });
  const storage = { version: 2, accessMode: 'rw', containerPath: '/nas', subdirectory: 'Projects', volumeName: `photolocal-production-nas-${'c'.repeat(32)}` };
  const configInput = { productionRoot, stagingRoot, runDirectory, networkPrefix: 'Z:\\Projects', publicUrl: 'https://photos.example.test', imageId: `sha256:${'a'.repeat(64)}`, storage, sourceEnvironment: {} };
  const config = buildProductionConfiguration(configInput);
  await writeFile(config.source.databasePath, 'original native database');
  await writeFile(join(config.source.downloadsPath, 'download.jpg'), 'download contents');
  await writeFile(join(config.source.localPhotosPath, 'local.jpg'), 'local contents');
  const environment = 'PHOTO_LOCAL_PORT=4873\n';
  const storageBytes = JSON.stringify(storage);
  const composeBytes = JSON.stringify(config.compose);
  const mappingBytes = JSON.stringify(config.mapping);
  const clientBytes = '{}';
  await writeFile(join(productionRoot, '.env'), environment);
  await writeFile(join(stagingRoot, 'docker-data', 'production-storage.json'), storageBytes);
  await writeFile(join(stagingRoot, 'docker-data', 'google', 'credentials.json'), clientBytes);
  await writeFile(join(runDirectory, 'google', 'credentials.json'), clientBytes);
  await writeFile(join(runDirectory, 'google', 'token.json'), '{}');
  const composeFile = join(runDirectory, 'compose.production.json');
  const mappingFile = join(runDirectory, 'mapping.json');
  const emptyEnvironmentFile = join(runDirectory, 'empty.env');
  await writeFile(composeFile, composeBytes);
  await writeFile(mappingFile, mappingBytes);
  await writeFile(emptyEnvironmentFile, '');
  const manifest = { version: 1, status: 'PRODUCTION_CONFIG_PREPARED', ...configInput, source: config.source,
    googleSource: join(stagingRoot, 'docker-data', 'google'), composeFile, mappingFile, emptyEnvironmentFile,
    hashes: { sourceEnvironment: hash(environment), storage: hash(storageBytes), compose: hash(composeBytes), mapping: hash(mappingBytes), googleClient: hash(clientBytes) } };
  delete manifest.sourceEnvironment;
  await writeFile(join(runDirectory, 'production-preparation.json'), JSON.stringify(manifest));
  const previewRun = join(stagingRoot, 'docker-data', 'migration-known');
  await mkdir(previewRun);
  await writeFile(join(previewRun, 'mapping.json'), JSON.stringify(config.mapping));
  const diagnosisReportPath = join(previewRun, `diagnosis-${'d'.repeat(32)}.json`);
  await writeFile(diagnosisReportPath, JSON.stringify({ audit: gap() }));
  await writeFile(join(stagingRoot, 'docker-data', 'staging-preview.json'), JSON.stringify({
    version: 1, status: 'PREVIEW_READY', runDirectory: previewRun, diagnosisReportPath,
    counts, projectFolders: gap().projectFolders, photoSamples: gap().photoSamples,
    locations: gap().failures, failuresTruncated: 0,
  }));
  const calls = [];
  const audits = [];
  let snapshotCalls = 0;
  const deps = {
    parseDotenv: () => ({}), getFreeBytes: async () => 100 * 1024 ** 3, inspectDatabase: () => ({ ...counts }),
    snapshot: async ({ output }) => {
      snapshotCalls += 1;
      await writeFile(output, `fresh snapshot ${snapshotCalls}`, { flag: 'wx' });
      return { status: 'SNAPSHOT_OK', output, counts: { ...counts } };
    },
    invoke: async args => {
      calls.push(args);
      if (args[0] === 'image') return { code: 0, stdout: configInput.imageId, stderr: '' };
      if (args[0] === 'volume') return { code: 0, stdout: storage.volumeName, stderr: '' };
      if (args[0] === 'compose') return { code: 0, stdout: JSON.stringify(config.compose), stderr: '' };
      if (args[0] === 'container') return { code: 0, stdout: '', stderr: '' };
      assert.equal(args[0], 'run');
      assert.ok(args.includes('--network') && args.includes('none'));
      assert.ok(args.includes('--read-only'));
      assert.equal(args[args.indexOf('--entrypoint') + 1], 'node');
      if (args.includes('/app/scripts/migrate-docker-data.mjs')) {
        const mount = args.find(value => value.startsWith('type=bind,') && /target=\/data(?:,|$)/.test(value));
        const destination = /source=([^,]+)/.exec(mount)[1];
        await writeFile(join(destination, 'photo-local.sqlite'), 'migrated private snapshot', { flag: 'wx' });
        return { code: 0, stdout: '', stderr: '' };
      }
      assert.ok(args.includes('--details'));
      assert.ok(args.filter(value => value.startsWith('type=')).every(value => value.includes('readonly')));
      const report = audits.shift() ?? audit();
      return { code: report.status === 'STAGING_COPY_VERIFIED' ? 0 : 1, stdout: JSON.stringify(report), stderr: '' };
    },
  };
  return { root, input: { runDirectory, environmentScopes: scopes }, deps, calls, audits, configInput, config, manifest,
    get snapshots() { return snapshotCalls; },
    stopped: () => writeFile(join(runDirectory, 'native-stopped.json'), JSON.stringify({ version: 1, productionRoot, sourceStopped: true }), { flag: 'wx' }),
  };
}

test('preflight takes a fresh isolated baseline and permits only documented NAS ENOENT gaps', windows, async context => {
  const f = await fixture(context);
  f.audits.push(gap());
  const result = await preflightProductionCutover(f.input, f.deps);
  assert.equal(result.status, 'CUTOVER_PREFLIGHT_OK');
  assert.deepEqual(result.nasGaps, { projectFolders: 0, photoSamples: 1 });
  assert.equal(f.snapshots, 1);
  const marker = JSON.parse(await readFile(join(f.input.runDirectory, 'cutover-preflight.json'), 'utf8'));
  assert.deepEqual(marker.baselineFailures, gap().failures);
  assert.deepEqual(marker.counts, counts);
  assert.equal(await readFile(f.config.source.databasePath, 'utf8'), 'original native database');
  assert.ok(f.calls.every(args => !['up', 'down', 'restart', 'stop'].some(command => args.includes(command))));
});

test('finalize requires the native-stop marker and uses a new snapshot plus verified local copies', windows, async context => {
  const f = await fixture(context);
  f.audits.push(gap(), gap());
  await preflightProductionCutover(f.input, f.deps);
  await assert.rejects(finalizeProductionData(f.input, f.deps), { code: 'CUTOVER_NATIVE_STOP_REQUIRED' });
  assert.equal(f.snapshots, 1);
  await f.stopped();
  const result = await finalizeProductionData(f.input, f.deps);
  assert.equal(result.status, 'FINAL_COPY_VERIFIED');
  assert.equal(f.snapshots, 2);
  assert.deepEqual(result.counts, counts);
  assert.deepEqual(result.nasGaps, { projectFolders: 0, photoSamples: 1 });
  assert.equal(await readFile(join(f.input.runDirectory, 'downloads', 'download.jpg'), 'utf8'), 'download contents');
  assert.equal(await readFile(join(f.input.runDirectory, 'local-photos', 'local.jpg'), 'utf8'), 'local contents');
  assert.equal(JSON.parse(await readFile(join(f.input.runDirectory, 'final-copy.json'), 'utf8')).status, 'FINAL_COPY_VERIFIED');
  assert.equal(JSON.parse(await readFile(join(f.input.runDirectory, 'cutover-progress.json'), 'utf8')).phase, 'verified');
});

for (const report of [gap('/legacy-local-photos/missing.jpg'), gap('/nas/Projects/missing.jpg', 'EACCES'),
  { ...gap(), failuresTruncated: 1 }, { ...audit(), counts: { ...counts, photos: 3 } },
  gap('/nas/Projects/new-before-cutover.jpg'), { ...gap(), photoSamples: { checked: 1, readable: 0, unreadable: 1 } }]) {
  test('preflight refuses local gaps, denied NAS access, truncation and mismatched counts', windows, async context => {
    const f = await fixture(context);
    f.audits.push(report);
    await assert.rejects(preflightProductionCutover(f.input, f.deps));
    await assert.rejects(readFile(join(f.input.runDirectory, 'cutover-preflight.json')), { code: 'ENOENT' });
  });
}

test('finalize rejects new NAS failures without publishing a successful final copy', windows, async context => {
  const f = await fixture(context);
  f.audits.push(gap(), gap('/nas/Projects/new-missing.jpg'));
  await preflightProductionCutover(f.input, f.deps);
  await f.stopped();
  await assert.rejects(finalizeProductionData(f.input, f.deps), { code: 'CUTOVER_NEW_STORAGE_GAPS' });
  await assert.rejects(readFile(join(f.input.runDirectory, 'final-copy.json')), { code: 'ENOENT' });
});

test('changed prepared settings and nonempty final destinations fail before baseline snapshot', windows, async context => {
  const f = await fixture(context);
  await writeFile(join(f.input.runDirectory, 'downloads', 'existing'), 'retain');
  await assert.rejects(preflightProductionCutover(f.input, f.deps), { code: 'CUTOVER_DESTINATION_NOT_EMPTY' });
  assert.equal(f.snapshots, 0);
  assert.equal(await readFile(join(f.input.runDirectory, 'downloads', 'existing'), 'utf8'), 'retain');
  const other = await fixture(context);
  await writeFile(join(other.configInput.productionRoot, '.env'), 'CHANGED=private-value');
  await assert.rejects(preflightProductionCutover(other.input, other.deps), { code: 'CUTOVER_PREPARATION_CHANGED' });
  assert.equal(other.snapshots, 0);
});

test('preflight cannot be repeated on an already used prepared run', windows, async context => {
  const f = await fixture(context);
  await preflightProductionCutover(f.input, f.deps);
  await assert.rejects(preflightProductionCutover(f.input, f.deps), { code: 'CUTOVER_ALREADY_ATTEMPTED' });
  assert.equal(f.snapshots, 1);
});

test('failed snapshot attempt cannot reuse the same prepared run', windows, async context => {
  const f = await fixture(context);
  f.deps.snapshot = () => { throw Object.assign(new Error('SNAPSHOT_TIMEOUT'), { code: 'SNAPSHOT_TIMEOUT' }); };
  await assert.rejects(preflightProductionCutover(f.input, f.deps), { code: 'SNAPSHOT_TIMEOUT' });
  await assert.rejects(preflightProductionCutover(f.input, f.deps), { code: 'CUTOVER_ALREADY_ATTEMPTED' });
});

test('disk capacity and final source counts are checked again rather than trusting preparation', windows, async context => {
  const f = await fixture(context);
  f.deps.getFreeBytes = async () => 0;
  await assert.rejects(preflightProductionCutover(f.input, f.deps), { code: 'INSUFFICIENT_DISK_SPACE' });
  assert.equal(f.snapshots, 0);
  const final = await fixture(context);
  await preflightProductionCutover(final.input, final.deps);
  await final.stopped();
  final.deps.inspectDatabase = () => ({ ...counts, chat_photo_files: 4 });
  await assert.rejects(finalizeProductionData(final.input, final.deps), { code: 'CUTOVER_COUNTS_MISMATCH' });
});

test('source database changes after snapshot prevent final verification even if counts stay equal', windows, async context => {
  const f = await fixture(context);
  await preflightProductionCutover(f.input, f.deps);
  await f.stopped();
  const realInvoke = f.deps.invoke;
  f.deps.invoke = async args => {
    const result = await realInvoke(args);
    if (args[0] === 'run' && args.includes('--details')) await writeFile(f.config.source.databasePath, 'unexpected native writer');
    return result;
  };
  await assert.rejects(finalizeProductionData(f.input, f.deps), { code: 'CUTOVER_SOURCE_CHANGED' });
});

test('real native SQLite WAL snapshots and readonly counts satisfy the stopped-source metadata guard', windows, async context => {
  const f = await fixture(context);
  const runtimeRoot = fileURLToPath(new URL('../backend/', import.meta.url));
  const Database = createRequire(join(runtimeRoot, 'package.json'))('better-sqlite3');
  await rm(f.config.source.databasePath);
  const writer = new Database(f.config.source.databasePath);
  try {
    writer.pragma('journal_mode = WAL');
    for (const [name, count] of Object.entries(counts)) {
      writer.exec(`CREATE TABLE ${name}(id INTEGER)`);
      const insert = writer.prepare(`INSERT INTO ${name}(id) VALUES(?)`);
      for (let index = 0; index < count; index += 1) insert.run(index);
    }
    f.deps.snapshot = options => snapshotDatabase({ ...options, runtimeRoot });
    f.deps.inspectDatabase = path => inspectSourceDatabase(path, runtimeRoot);
    await preflightProductionCutover(f.input, f.deps);
  } finally { writer.close(); }
  await f.stopped();
  const result = await finalizeProductionData(f.input, f.deps);
  assert.equal(result.status, 'FINAL_COPY_VERIFIED');
  assert.deepEqual(result.counts, counts);
});

test('temporary cleanup failure reports only the generated container name and hides raw Docker output', windows, async context => {
  const f = await fixture(context);
  const realInvoke = f.deps.invoke;
  f.deps.invoke = args => args[0] === 'container'
    ? { code: 1, stdout: '', stderr: 'PRIVATE_DOCKER_FAILURE password=value' } : realInvoke(args);
  await assert.rejects(preflightProductionCutover(f.input, f.deps), error => {
    assert.equal(error.code, 'CUTOVER_CONTAINER_CLEANUP_REQUIRED');
    assert.match(error.containerName, /^photolocal-production-[a-z-]+-[a-f0-9]{32}$/);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_DOCKER_FAILURE'));
    return true;
  });
});
