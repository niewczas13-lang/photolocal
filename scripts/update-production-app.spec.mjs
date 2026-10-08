import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { updateProductionApp } from './update-production-app.mjs';

const PROJECT = 'photolocal-production';
const ORIGINAL_IMAGE = 'sha256:' + 'a'.repeat(64);
const NEW_IMAGE = 'sha256:' + 'b'.repeat(64);
const REVISION = 'c'.repeat(40);
const SECRET = 'private-env-value-for-regression';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'photolocal-app-update-'));
  t.after(async () => {
    assert.match(basename(root), /^photolocal-app-update-/);
    await rm(root, { recursive: true, force: true });
  });
  const stagingRoot = join(root, 'staging');
  const runDirectory = join(stagingRoot, 'docker-data', 'production-' + 'd'.repeat(32));
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(stagingRoot, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(runDirectory, 'empty.env'), '');
  const files = [
    join(runDirectory, 'compose.production.json'),
    ...Array.from({ length: 9 }, (_, index) => join(runDirectory, `compose.previous-${index}.json`)),
  ];
  for (const file of files) await writeFile(file, JSON.stringify({ existing: basename(file) }));
  const mounts = ['data', 'google', 'downloads', 'local-photos', 'photos'].map((folder, index) => ({
    Type: 'bind', Source: join(runDirectory, folder),
    Destination: ['/data', '/google', '/downloads', '/legacy-local-photos', '/photos'][index],
    RW: true, Mode: 'rw',
  }));
  mounts.push({
    Type: 'volume', Source: '/var/lib/docker/volumes/production-nas/_data',
    Name: 'photolocal-production-nas-existing', Destination: '/nas', RW: true, Mode: 'rw',
  });
  const environment = {
    PHOTO_LOCAL_AUTH: 'enabled', PHOTO_LOCAL_DB: '/data/photo-local.sqlite',
    GOOGLE_CHAT_DOWNLOAD_ROOT: '/downloads', OLLAMA_URL: 'http://host.docker.internal:11434',
    GOOGLE_CHAT_BROWSER_CDP_URL: 'http://chat-browser:9223', PRIVATE_SETTING: SECRET,
    LITERAL_DOLLARS: 'keep$$this$literal',
  };
  const before = {
    name: PROJECT,
    services: {
      photolocal: {
        image: ORIGINAL_IMAGE, user: '1000:1000', environment,
        ports: [{ host_ip: '0.0.0.0', published: '4873', target: 4873, protocol: 'tcp' }],
        volumes: mounts.map(mount => mount.Type === 'bind' ? {
          type: 'bind', source: mount.Source, target: mount.Destination,
          bind: { create_host_path: false },
        } : { type: 'volume', source: 'production_nas', target: '/nas' }),
      },
      'chat-browser': {
        image: 'sha256:' + 'e'.repeat(64),
        volumes: [{ type: 'volume', source: 'chat_browser_profile', target: '/profile' }],
        security_opt: ['no-new-privileges:true'],
      },
    },
    volumes: {
      production_nas: { external: true, name: mounts.at(-1).Name },
      chat_browser_profile: { name: 'photolocal-production-chat-browser-profile' },
    },
    networks: { default: { name: PROJECT + '_default' } },
  };
  let app = {
    id: '1'.repeat(64), name: '/' + PROJECT + '-photolocal-1', image: ORIGINAL_IMAGE,
    labels: {
      'com.docker.compose.project': PROJECT,
      'com.docker.compose.service': 'photolocal',
      'com.docker.compose.project.working_dir': runDirectory,
      'com.docker.compose.project.config_files': files.join(','),
    },
    running: true, health: 'healthy', mounts,
    ports: { '4873/tcp': [{ HostIp: '0.0.0.0', HostPort: '4873' }] },
    environment: Object.entries(environment).map(([key, value]) => `${key}=${value.replaceAll('$$', '$')}`),
  };
  options.preflightMutate?.(app, before, files);
  const original = structuredClone(app);
  const calls = [];
  const composeFiles = args => args.flatMap((value, index) => value === '-f' ? [args[index + 1]] : []);
  let upCount = 0;
  let sourceRevision = options.headMismatch ? 'f'.repeat(40) : REVISION;
  let sourceStatus = options.trackedDirty ? ' M backend/src/server.ts' : '';
  const run = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === 'git') {
      assert.equal(args[0], '-C');
      assert.equal(args[1], stagingRoot);
      if (args[2] === 'rev-parse') return { code: 0, stdout: sourceRevision, stderr: '' };
      if (args[2] === 'status') {
        if (args.includes('--untracked-files=all')) {
          assert.ok(args.includes('--'));
          assert.ok(args.includes('backend/src'));
          assert.ok(args.includes('frontend/src'));
          return { code: 0, stdout: options.untrackedSource ? '?? backend/src/local-only.ts' : '', stderr: '' };
        }
        assert.ok(args.includes('--untracked-files=no'));
        return { code: 0, stdout: sourceStatus, stderr: '' };
      }
      assert.fail('Unexpected Git command');
    }
    assert.equal(executable, 'docker');
    if (args[0] === 'ps') {
      assert.ok(args.includes('label=com.docker.compose.project=' + PROJECT));
      assert.ok(args.includes('label=com.docker.compose.service=photolocal'));
      if (!app && options.absentQueryFailure) return { code: 1, stdout: '', stderr: SECRET };
      return { code: 0, stdout: !app ? '' : options.duplicateContainer ? app.id + '\n' + '2'.repeat(64) : app.id, stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return { code: 0, stdout: JSON.stringify(app), stderr: '' };
    }
    if (args[0] === 'build') {
      await options.onBuild?.();
      if (options.buildFailure) return { code: 1, stdout: '', stderr: SECRET };
      if (options.fileDrift) await writeFile(files[4], 'changed during build');
      if (options.containerDrift) app.environment.push('CHANGED=unexpected');
      if (options.sourceDrift) sourceRevision = 'f'.repeat(40);
      if (options.trackedDrift) sourceStatus = ' M backend/src/server.ts';
      return { code: 0, stdout: 'built', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const id = options.sameImage ? ORIGINAL_IMAGE : NEW_IMAGE;
      if (args.at(-1) === ORIGINAL_IMAGE && args.includes('{{.Id}}')) {
        return { code: 0, stdout: ORIGINAL_IMAGE, stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ id, revision: options.wrongRevision ? 'f'.repeat(40) : REVISION }),
        stderr: '',
      };
    }
    if (args[0] === 'compose') {
      const selected = composeFiles(args);
      assert.deepEqual(selected.slice(0, files.length), files);
      assert.equal(args[args.indexOf('-p') + 1], PROJECT);
      assert.equal(args[args.indexOf('--project-directory') + 1], runDirectory);
      assert.equal(args[args.indexOf('--env-file') + 1], join(runDirectory, 'empty.env'));
      if (args.includes('config')) {
        const config = structuredClone(before);
        if (selected.length > files.length) {
          const override = JSON.parse(await readFile(selected.at(-1), 'utf8'));
          assert.deepEqual(Object.keys(override), ['services']);
          assert.deepEqual(Object.keys(override.services), ['photolocal']);
          assert.deepEqual(Object.keys(override.services.photolocal), ['image']);
          config.services.photolocal.image = override.services.photolocal.image;
          if (options.mergeDrift) config.volumes.chat_browser_profile.name = 'different-profile';
        }
        return { code: 0, stdout: JSON.stringify(config), stderr: '' };
      }
      if (args.includes('up')) {
        upCount += 1;
        const applyingNew = selected.length > files.length;
        app = structuredClone(original);
        app.id = String(upCount + 1).repeat(64);
        app.image = applyingNew ? NEW_IMAGE : ORIGINAL_IMAGE;
        app.labels['com.docker.compose.project.config_files'] = selected.join(',');
        app.mounts.reverse();
        if (applyingNew && (options.startFailure || options.startAbsent)) {
          app.health = 'unhealthy';
          if (options.startAbsent) app = undefined;
          if (options.rollbackDrift) await writeFile(files[3], 'changed after failed start');
          return { code: 1, stdout: '', stderr: SECRET };
        }
        if (applyingNew && options.healthFailure) app.health = 'unhealthy';
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    assert.fail('Unexpected command: ' + JSON.stringify(args));
  };
  return { input: { stagingRoot, runDirectory, revision: REVISION }, run, calls, files, before, original, app: () => app };
}

test('updates only the application while retaining every active override and data mount', async t => {
  const f = await fixture(t);
  const result = await updateProductionApp(f.input, { run: f.run });
  assert.equal(result.status, 'PRODUCTION_APP_UPDATED');
  assert.equal(result.applicationUpdated, true);
  assert.equal(result.imageId, NEW_IMAGE);
  assert.equal(result.revision, REVISION);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  const build = f.calls.filter(call => call.args[0] === 'build');
  assert.equal(build.length, 1);
  assert.equal(build[0].args.at(-1), f.input.stagingRoot);
  assert.ok(build[0].args.includes('org.opencontainers.image.revision=' + REVISION));
  const updates = f.calls.filter(call => call.args.includes('up'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].args.slice(updates[0].args.indexOf('up')), [
    'up', '--no-deps', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal',
  ]);
  assert.ok(f.calls.indexOf(build[0]) < f.calls.indexOf(updates[0]));
  assert.equal(f.calls.some(call => call.args.includes('down') || call.args.includes('restart')), false);
  assert.deepEqual(f.app().mounts.sort((a, b) => a.Destination.localeCompare(b.Destination)),
    f.original.mounts.sort((a, b) => a.Destination.localeCompare(b.Destination)));
});

test('prepare-only builds and checks the replacement without changing any service', async t => {
  const f = await fixture(t);
  const result = await updateProductionApp({ ...f.input, prepareOnly: true }, { run: f.run });
  assert.equal(result.status, 'PRODUCTION_APP_PREPARED');
  assert.equal(result.applicationUpdated, false);
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
  assert.equal(f.app().image, ORIGINAL_IMAGE);
});

test('a failed build never stops or replaces the running application', async t => {
  const f = await fixture(t, { buildFailure: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), error => {
    assert.equal(error.code, 'PRODUCTION_APP_UPDATE_BUILD_FAILED');
    assert.equal(error.applicationMayHaveChanged, false);
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
  assert.equal(f.app().id, f.original.id);
});

for (const drift of ['fileDrift', 'containerDrift']) {
  test(`${drift} before cutover aborts without replacing the application`, async t => {
    const f = await fixture(t, { [drift]: true });
    await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
      code: 'PRODUCTION_APP_UPDATE_ACTIVE_CONFIGURATION_CHANGED',
      applicationMayHaveChanged: false,
    });
    assert.equal(f.calls.some(call => call.args.includes('up')), false);
  });
}

test('a merged change to the browser profile is rejected before cutover', async t => {
  const f = await fixture(t, { mergeDrift: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_UNSAFE_COMPOSE_MERGE',
  });
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
});

for (const failure of ['startFailure', 'healthFailure']) {
  test(`${failure} restores the old image with the full original configuration`, async t => {
    const f = await fixture(t, { [failure]: true });
    await assert.rejects(updateProductionApp(f.input, { run: f.run }), error => {
      assert.equal(error.rollbackStatus, 'RESTORED');
      assert.ok(error.rollbackReport);
      assert.equal(String(error).includes(SECRET), false);
      return true;
    });
    const updates = f.calls.filter(call => call.args.includes('up'));
    assert.equal(updates.length, 2);
    assert.equal(updates[1].args.at(-1), 'photolocal');
    assert.deepEqual(updates[1].args.flatMap((value, index) => value === '-f' ? [updates[1].args[index + 1]] : []), f.files);
    assert.equal(f.app().image, ORIGINAL_IMAGE);
    assert.equal(f.app().health, 'healthy');
    assert.equal(f.app().labels['com.docker.compose.project.config_files'], f.files.join(','));
  });
}

test('configuration drift after a failed start blocks an unsafe rollback', async t => {
  const f = await fixture(t, { startFailure: true, rollbackDrift: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), error => {
    assert.equal(error.rollbackStatus, 'FAILED');
    assert.equal(error.rollbackCode, 'PRODUCTION_APP_UPDATE_ACTIVE_CONFIGURATION_CHANGED');
    return true;
  });
  assert.equal(f.calls.filter(call => call.args.includes('up')).length, 1);
});

test('an image with the wrong source revision cannot replace production', async t => {
  const f = await fixture(t, { wrongRevision: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_INVALID_IMAGE',
  });
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
});

test('an already current image leaves the running container and Compose files unchanged', async t => {
  const f = await fixture(t, { sameImage: true });
  const result = await updateProductionApp(f.input, { run: f.run });
  assert.equal(result.status, 'PRODUCTION_APP_CURRENT');
  assert.equal(result.applicationUpdated, false);
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
  assert.equal(f.app().id, f.original.id);
});

for (const [name, mutate, code] of [
  ['another project', app => { app.labels['com.docker.compose.project'] = 'photolocal-staging'; }, 'CONTAINER_IDENTITY_INVALID'],
  ['another service', app => { app.labels['com.docker.compose.service'] = 'chat-browser'; }, 'CONTAINER_IDENTITY_INVALID'],
  ['another container name', app => { app.name = '/unexpected'; }, 'CONTAINER_IDENTITY_INVALID'],
  ['a stopped app', app => { app.running = false; }, 'APP_VERIFICATION_FAILED'],
  ['an unhealthy app', app => { app.health = 'unhealthy'; }, 'APP_VERIFICATION_FAILED'],
  ['a different port', app => { app.ports['4873/tcp'][0].HostPort = '4874'; }, 'APP_VERIFICATION_FAILED'],
  ['a different NAS volume', app => { app.mounts.at(-1).Name = 'another-nas'; }, 'APP_VERIFICATION_FAILED'],
  ['a different Compose project', (_app, config) => { config.name = 'photolocal-staging'; }, 'APP_VERIFICATION_FAILED'],
  ['an override outside the run directory', app => {
    app.labels['com.docker.compose.project.config_files'] += ',' + join(tmpdir(), 'outside.json');
  }, 'INVALID_CONFIGURATION'],
]) {
  test(`preflight rejects ${name} before building or updating anything`, async t => {
    const f = await fixture(t, { preflightMutate: mutate });
    await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
      code: 'PRODUCTION_APP_UPDATE_' + code,
      applicationMayHaveChanged: false,
    });
    assert.equal(f.calls.some(call => call.args[0] === 'build' || call.args.includes('up')), false);
  });
}

test('multiple matching app containers cannot authorize an update', async t => {
  const f = await fixture(t, { duplicateContainer: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID',
  });
  assert.equal(f.calls.some(call => call.args[0] === 'build' || call.args.includes('up')), false);
});

test('a nonempty environment file cannot change the preserved production environment', async t => {
  const f = await fixture(t);
  await writeFile(join(f.input.runDirectory, 'empty.env'), 'PRIVATE_SETTING=' + SECRET);
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION',
  });
  assert.equal(f.calls.some(call => call.args[0] === 'build' || call.args.includes('up')), false);
});

test('the update lock rejects a concurrent run until the first update finishes', async t => {
  let signalBuild;
  let releaseBuild;
  let builds = 0;
  const entered = new Promise(resolve => { signalBuild = resolve; });
  const gate = new Promise(resolve => { releaseBuild = resolve; });
  const f = await fixture(t, {
    onBuild: async () => {
      if (++builds === 1) { signalBuild(); await gate; }
    },
  });
  const first = updateProductionApp(f.input, { run: f.run });
  await entered;
  try {
    await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
      code: 'PRODUCTION_APP_UPDATE_LOCKED', applicationMayHaveChanged: false,
    });
    releaseBuild();
    assert.equal((await first).status, 'PRODUCTION_APP_UPDATED');
    assert.equal(builds, 1);
    await assert.rejects(readFile(join(f.input.runDirectory, 'production-app-update.lock')), { code: 'ENOENT' });
  } finally {
    releaseBuild();
    await first.catch(() => {});
  }
});

test('a failed build releases its lock so a later update can run', async t => {
  const options = { buildFailure: true };
  const f = await fixture(t, options);
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_BUILD_FAILED',
  });
  await assert.rejects(readFile(join(f.input.runDirectory, 'production-app-update.lock')), { code: 'ENOENT' });
  options.buildFailure = false;
  assert.equal((await updateProductionApp(f.input, { run: f.run })).status, 'PRODUCTION_APP_UPDATED');
});

test('a failed start with no remaining app container restores the full old configuration', async t => {
  const f = await fixture(t, { startAbsent: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_APP_START_FAILED', rollbackStatus: 'RESTORED',
  });
  assert.equal(f.calls.filter(call => call.args.includes('up')).length, 2);
  assert.equal(f.app().image, ORIGINAL_IMAGE);
  assert.equal(f.app().health, 'healthy');
  assert.equal(f.app().labels['com.docker.compose.project.config_files'], f.files.join(','));
});

test('a failed query cannot be mistaken for an absent app during rollback', async t => {
  const f = await fixture(t, { startAbsent: true, absentQueryFailure: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_APP_START_FAILED', rollbackStatus: 'FAILED',
    rollbackCode: 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED',
  });
  assert.equal(f.calls.filter(call => call.args.includes('up')).length, 1);
});

for (const changed of ['headMismatch', 'trackedDirty', 'sourceDrift', 'trackedDrift']) {
  test(`${changed} refuses to deploy source that does not match the requested clean revision`, async t => {
    const f = await fixture(t, { [changed]: true });
    await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
      code: 'PRODUCTION_APP_UPDATE_SOURCE_CHANGED', applicationMayHaveChanged: false,
    });
    assert.equal(f.calls.some(call => call.args.includes('up')), false);
    if (changed === 'headMismatch' || changed === 'trackedDirty') {
      assert.equal(f.calls.some(call => call.args[0] === 'build'), false);
    }
  });
}

test('the CLI returns a bounded failure report without exposing invalid input', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./update-production-app.mjs', import.meta.url))], {
    input: JSON.stringify({ revision: SECRET }), encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(SECRET), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'PRODUCTION_APP_UPDATE_FAILED', code: 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION',
    phase: 'preflight', applicationMayHaveChanged: false,
  });
});

test('untracked source included by the Docker build context prevents building production', async t => {
  const f = await fixture(t, { untrackedSource: true });
  await assert.rejects(updateProductionApp(f.input, { run: f.run }), {
    code: 'PRODUCTION_APP_UPDATE_SOURCE_CHANGED', applicationMayHaveChanged: false,
  });
  assert.equal(f.calls.some(call => call.args[0] === 'build' || call.args.includes('up')), false);
});

test('untracked root repair tools are retained and excluded from source verification', async t => {
  const f = await fixture(t);
  const tools = ['napraw-photolocal.ps1', 'utrwal-dropbox.ps1'];
  for (const tool of tools) await writeFile(join(f.input.stagingRoot, tool), 'local repair tool');
  const result = await updateProductionApp({ ...f.input, prepareOnly: true }, { run: f.run });
  assert.equal(result.status, 'PRODUCTION_APP_PREPARED');
  const checks = f.calls.filter(call => call.executable === 'git' && call.args.includes('--untracked-files=all'));
  assert.ok(checks.length >= 2);
  for (const check of checks) for (const tool of tools) assert.equal(check.args.includes(tool), false);
  for (const tool of tools) assert.equal(await readFile(join(f.input.stagingRoot, tool), 'utf8'), 'local repair tool');
});
