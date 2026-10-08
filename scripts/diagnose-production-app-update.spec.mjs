import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HELPER = new URL('./diagnose-production-app-update.mjs', import.meta.url);
const OLD_IMAGE = 'sha256:' + 'a'.repeat(64);
const NEW_IMAGE = 'sha256:' + 'b'.repeat(64);
const REVISION = 'c'.repeat(40);
const SECRET = 'diagnostic-private-value-do-not-print';
const hash = value => createHash('sha256').update(value).digest('hex');

async function diagnose(input, dependencies) {
  assert.ok(existsSync(HELPER), 'read-only diagnostic helper must exist');
  return (await import(HELPER.href)).diagnoseProductionAppUpdate(input, dependencies);
}

async function fixture(t, options = {}) {
  const stagingRoot = await realpath(await mkdtemp(join(tmpdir(), 'photolocal-diagnostic-')));
  t.after(async () => {
    assert.match(basename(stagingRoot), /^photolocal-diagnostic-/);
    await rm(stagingRoot, { recursive: true, force: true });
  });
  const runDirectory = join(stagingRoot, 'docker-data', 'production-' + 'd'.repeat(32));
  await mkdir(runDirectory, { recursive: true });
  const files = Array.from({ length: 10 }, (_, index) => join(runDirectory,
    index === 0 ? 'compose.production.json' : `compose.previous-${index}.json`));
  const entries = [];
  for (const file of files) {
    const content = JSON.stringify({ fixture: basename(file) }) + '\n';
    await writeFile(file, content);
    entries.push({ path: file, hash: hash(content) });
  }
  const overridePath = join(runDirectory, 'compose.app-update-' + 'e'.repeat(32) + '.json');
  await writeFile(overridePath, JSON.stringify({ services: { photolocal: { image: NEW_IMAGE } } }));
  await writeFile(join(runDirectory, 'empty.env'), '');
  const rollbackReport = join(runDirectory, 'app-update-rollback-' + 'e'.repeat(32) + '.json');
  const report = { version: 1, runDirectory, previousImageId: OLD_IMAGE, imageId: NEW_IMAGE,
    revision: REVISION, files: entries, overridePath };
  await writeFile(rollbackReport, JSON.stringify(report));
  const environment = { PHOTO_LOCAL_AUTH: 'enabled', PHOTO_LOCAL_DB: '/data/photo-local.sqlite',
    PRIVATE_SETTING: SECRET, LITERAL_DOLLARS: 'keep$$this$literal' };
  const imageEnvironment = ['NODE_VERSION=24.1.0', 'PATH=/opt/venv/bin:/usr/local/bin',
    'PRIVATE_SETTING=image-default'];
  const before = { name: 'photolocal-production', services: { photolocal: {
    image: OLD_IMAGE, environment,
    volumes: [{ type: 'bind', source: join(runDirectory, 'data'), target: '/data',
      bind: { create_host_path: false } }, { type: 'volume', source: 'nas', target: '/nas' }],
  }, 'chat-browser': { image: 'browser:existing' } }, volumes: { nas: { name: 'production-nas' } } };
  const after = structuredClone(before);
  after.services.photolocal.image = NEW_IMAGE;
  const expectedEnvironment = { NODE_VERSION: '24.1.0', PATH: '/opt/venv/bin:/usr/local/bin',
    ...Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replaceAll('$$', '$')])) };
  const app = { id: '1'.repeat(64), name: '/photolocal-production-photolocal-1', image: NEW_IMAGE,
    labels: { 'com.docker.compose.project': 'photolocal-production', 'com.docker.compose.service': 'photolocal',
      'com.docker.compose.project.working_dir': runDirectory,
      'com.docker.compose.project.config_files': [...files, overridePath].join(',') },
    running: true, health: 'healthy', ports: { '4873/tcp': [{ HostIp: '0.0.0.0', HostPort: '4873' }] },
    environment: Object.entries(expectedEnvironment).map(([key, value]) => `${key}=${value}`),
    mounts: [{ Type: 'bind', Source: join(runDirectory, 'data'), Destination: '/data', RW: true,
      Mode: 'rw', Propagation: 'rprivate' }, { Type: 'volume', Name: 'production-nas',
      Source: '/var/lib/docker/volumes/production-nas/_data', Destination: '/nas', RW: true, Mode: 'rw' }],
  };
  options.mutate?.(app, after);
  const calls = [];
  let inspections = 0;
  const run = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    assert.equal(executable, 'docker');
    if (options.queryFailure) return { code: 1, stdout: SECRET, stderr: SECRET };
    if (args[0] === 'ps') return { code: 0, stdout: app.id, stderr: '' };
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (++inspections === 2) options.finalInspectMutate?.(app);
      return { code: 0, stdout: JSON.stringify(app), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 0,
      stdout: JSON.stringify({ id: NEW_IMAGE, revision: REVISION, environment: imageEnvironment }), stderr: '' };
    assert.equal(args[0], 'compose');
    assert.ok(args.includes('config'));
    assert.ok(args.includes('--format'));
    const selected = args.flatMap((value, index) => value === '-f' ? [args[index + 1]] : []);
    assert.deepEqual(selected.slice(0, 10), files);
    assert.equal(args[args.indexOf('--env-file') + 1], join(runDirectory, 'empty.env'));
    return { code: 0, stdout: JSON.stringify(selected.length === 10 ? before : after), stderr: '' };
  };
  const contents = async () => Object.fromEntries(await Promise.all((await readdir(runDirectory))
    .map(async name => [name, hash(await readFile(join(runDirectory, name)))])));
  return { input: { stagingRoot, rollbackReport }, run, calls, app, files, before, after, imageEnvironment, contents };
}

test('diagnostic checks all active ordered files without writes or Docker mutations', async t => {
  const f = await fixture(t);
  const snapshot = await f.contents();
  const result = await diagnose(f.input, { run: f.run });
  assert.equal(result.status, 'PRODUCTION_APP_UPDATE_DIAGNOSED');
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.rawMountBaselineAvailable, false);
  assert.equal(result.configFileCount, 11);
  assert.deepEqual(result.environment, { configuredMismatch: [], missing: [], extra: [], changed: [] });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(await f.contents(), snapshot);
  for (const call of f.calls) {
    assert.equal(call.args.some(arg => ['build', 'up', 'pull', 'down', 'stop', 'start', 'restart', 'kill'].includes(arg)), false);
  }
});

test('diagnostic reveals additional proxy key names while keeping all values private', async t => {
  const f = await fixture(t, { mutate: app => app.environment.push('HTTP_PROXY=' + SECRET, 'http_proxy=' + SECRET) });
  const result = await diagnose(f.input, { run: f.run });
  assert.equal(result.checks.configuredEnvironment, true);
  assert.equal(result.checks.fullEnvironment, false);
  assert.deepEqual(result.environment.extra, ['HTTP_PROXY', 'http_proxy']);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('diagnostic identifies configured value changes by key name only', async t => {
  const f = await fixture(t, { mutate: app => {
    app.environment = app.environment.map(value => value.startsWith('PRIVATE_SETTING=') ? 'PRIVATE_SETTING=another-' + SECRET : value);
  } });
  const result = await diagnose(f.input, { run: f.run });
  assert.equal(result.checks.configuredEnvironment, false);
  assert.deepEqual(result.environment.configuredMismatch, ['PRIVATE_SETTING']);
  assert.deepEqual(result.environment.changed, ['PRIVATE_SETTING']);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('diagnostic distinguishes semantic mount mismatch from safe mode metadata', async t => {
  const f = await fixture(t, { mutate: app => { app.mounts[0].Mode = ''; app.mounts[1].Name = 'different-nas'; } });
  const result = await diagnose(f.input, { run: f.run });
  assert.equal(result.checks.mounts, false);
  assert.equal(result.mounts.find(mount => mount.target === '/data').mode, '');
  assert.equal(result.mounts.find(mount => mount.target === '/data').sourceMatches, true);
  assert.equal(result.mounts.find(mount => mount.target === '/nas').nameMatches, false);
  assert.equal(JSON.stringify(result).includes(f.input.stagingRoot), false);
});

test('diagnostic detects saved file drift and supports latest report selection', async t => {
  const f = await fixture(t);
  await writeFile(f.files[7], SECRET);
  const result = await diagnose({ stagingRoot: f.input.stagingRoot }, { run: f.run });
  assert.equal(result.checks.fileHashes, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('diagnostic reports concurrent container metadata changes as unstable', async t => {
  const f = await fixture(t, { finalInspectMutate: app => app.environment.push('CHANGED=' + SECRET) });
  const result = await diagnose(f.input, { run: f.run });
  assert.equal(result.checks.stableContainer, false);
  assert.equal(f.calls.filter(call => call.args[0] === 'container').length, 2);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('CLI selects the checkout containing the helper when launched from another folder', async t => {
  assert.ok(existsSync(HELPER), 'read-only diagnostic helper must exist');
  const f = await fixture(t);
  const scripts = join(f.input.stagingRoot, 'scripts');
  const unrelated = join(f.input.stagingRoot, 'unrelated-prompt-folder');
  await mkdir(scripts);
  await mkdir(unrelated);
  const helperPath = join(scripts, 'diagnose-production-app-update.mjs');
  await writeFile(helperPath, await readFile(HELPER));
  const child = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const app = ${JSON.stringify(f.app)};
    const before = ${JSON.stringify(f.before)};
    const after = ${JSON.stringify(f.after)};
    cp.spawnSync = (_executable, args) => {
      let value;
      if (args[0] === 'ps') return { status: 0, stdout: app.id };
      if (args[0] === 'container') value = app;
      else if (args[0] === 'image') value = { id: ${JSON.stringify(NEW_IMAGE)},
        revision: ${JSON.stringify(REVISION)}, environment: ${JSON.stringify(f.imageEnvironment)} };
      else if (args[0] === 'compose' && args.includes('config')) {
        value = args.filter(value => value === '-f').length === 10 ? before : after;
      } else throw new Error('Unexpected command');
      return { status: 0, stdout: JSON.stringify(value) };
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(helperPath)}];
    await import(pathToFileURL(process.argv[1]).href);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: unrelated, encoding: 'utf8', timeout: 30000, shell: false, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'PRODUCTION_APP_UPDATE_DIAGNOSED');
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr, '');
});

test('Docker query failure exposes a fixed diagnostic code only', async t => {
  const f = await fixture(t, { queryFailure: true });
  await assert.rejects(diagnose(f.input, { run: f.run }), error => {
    assert.equal(error.code, 'PRODUCTION_APP_DIAGNOSTIC_FAILED');
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
});

test('CLI invalid report input does not echo secrets or query Docker', () => {
  assert.ok(existsSync(HELPER), 'read-only diagnostic helper must exist');
  const result = spawnSync(process.execPath, [fileURLToPath(HELPER), SECRET], {
    encoding: 'utf8', timeout: 30000, shell: false, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(SECRET), false);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'PRODUCTION_APP_DIAGNOSTIC_FAILED' });
});
