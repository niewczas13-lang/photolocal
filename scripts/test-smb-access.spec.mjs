import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildProbeConfig, runProbe } from './test-smb-access.mjs';

const PROBE_ID = 'photolocal-smb-probe-ab12';
const INPUT = {
  server: '192.0.2.70',
  share: 'Photos',
  subdirectory: 'Projects',
  username: 'photo user',
  domain: 'EXAMPLE-PC',
  password: 'private-test-password',
  image: 'photolocal:staging',
};

function successfulInvocation() {
  return { code: 0, stdout: 'DIRECTORY_READ_OK\n', stderr: '' };
}

function isCleanup(args) {
  return ['container', 'volume'].includes(args[0]) && args.includes('rm');
}

function assertScopedProject(call) {
  if (isCleanup(call.args)) {
    assert.equal(call.stdin, '');
    assert.equal(call.args.at(-1), call.args[0] === 'container' ? PROBE_ID : `${PROBE_ID}-remote`);
    return;
  }
  const projectFlag = call.args.findIndex((arg) => arg === '-p' || arg === '--project-name');
  const config = call.stdin ? JSON.parse(call.stdin) : {};
  const project = projectFlag >= 0 ? call.args[projectFlag + 1] : config.name;
  assert.equal(project, PROBE_ID, 'Docker operations must target only the isolated probe project');
}

async function exerciseProbe(result, cleanupResult = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const report = await runProbe(INPUT, {
    probeId: PROBE_ID,
    invoke: async (args, stdin) => {
      calls.push({ args, stdin });
      return isCleanup(args) ? cleanupResult : result;
    },
  });
  return { report, calls };
}

test('probe mounts the requested SMB share read-only in an isolated existing image', () => {
  const config = buildProbeConfig(INPUT, PROBE_ID);
  assert.deepEqual(Object.keys(config.services), ['probe']);
  assert.deepEqual(Object.keys(config.volumes), ['remote']);
  const service = config.services.probe;
  const volume = config.volumes.remote;
  assert.equal(service.image, INPUT.image);
  assert.equal(service.container_name, PROBE_ID);
  assert.equal(service.pull_policy, 'never');
  assert.equal(service.network_mode, 'none');
  assert.equal(service.read_only, true);
  assert.equal(service.ports, undefined);
  assert.equal(service.restart, undefined);
  assert.equal(volume.driver, 'local');
  assert.equal(volume.name, `${PROBE_ID}-remote`);
  assert.equal(volume.driver_opts.type, 'cifs');
  assert.equal(volume.driver_opts.device, '//192.0.2.70/Photos');
  const mountOptions = volume.driver_opts.o.split(',');
  for (const option of ['ro', 'vers=3.1.1', 'uid=1000', 'gid=1000']) {
    assert.ok(mountOptions.includes(option), `Missing mount option ${option}`);
  }
  assert.equal(service.volumes.length, 1);
  const mount = service.volumes[0];
  assert.equal(mount.type, 'volume');
  assert.equal(mount.source, 'remote');
  assert.equal(mount.read_only, true);
  assert.equal(mount.volume.nocopy, true);
});

test('explicit storage test allows only its volume to be writable and retains an isolated container', () => {
  const config = buildProbeConfig({ ...INPUT, checkFilesAndWrite: true }, PROBE_ID);
  const service = config.services.probe;
  const options = config.volumes.remote.driver_opts.o.split(',');
  assert.ok(options.includes('rw'));
  assert.ok(!options.includes('ro'));
  assert.ok(options.includes('file_mode=0660'));
  assert.ok(options.includes('dir_mode=0770'));
  assert.equal(service.read_only, true);
  assert.equal(service.network_mode, 'none');
  assert.equal(service.volumes[0].read_only, false);
  assert.equal(service.volumes[0].volume.nocopy, true);
  assert.equal(service.command.at(-1), PROBE_ID);
  assert.ok(service.command[1].includes('STORAGE_READ_WRITE_OK'));
});

test('storage read/write success and leftover test folder are reported distinctly', async () => {
  for (const [marker, cleanup] of [
    ['STORAGE_READ_WRITE_OK', 'CLEAN'],
    ['TEST_FOLDER_CLEANUP_REQUIRED', 'REQUIRED'],
    ['STORAGE_WRITE_DENIED', 'CLEAN'],
    ['PHOTO_SAMPLE_NOT_FOUND', 'CLEAN'],
  ]) {
    const report = await runProbe({ ...INPUT, checkFilesAndWrite: true }, {
      probeId: PROBE_ID,
      invoke: async (args) => args[0] === 'compose'
        ? { code: marker === 'STORAGE_READ_WRITE_OK' ? 0 : 1, stdout: `PROBE_STARTED\n${marker}\n`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    });
    assert.equal(report.status, marker);
    assert.equal(report.cleanup, cleanup);
  }
});

test('storage success marker with a failed exit cannot report success', async () => {
  const report = await runProbe({ ...INPUT, checkFilesAndWrite: true }, {
    probeId: PROBE_ID,
    invoke: async (args) => args[0] === 'compose'
      ? { code: 1, stdout: 'PROBE_STARTED\nSTORAGE_READ_WRITE_OK\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  assert.notEqual(report.status, 'STORAGE_READ_WRITE_OK');
});

test('an abruptly terminated write probe cannot report complete cleanup from Docker removal alone', async () => {
  for (const code of [137, 143, 1, 0]) {
    const report = await runProbe({ ...INPUT, checkFilesAndWrite: true }, {
      probeId: PROBE_ID,
      invoke: async (args) => args[0] === 'compose'
        ? { code, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    });
    assert.equal(report.status, 'OTHER_ERROR');
    assert.equal(report.cleanup, 'REQUIRED');
  }
});

test('write mode cannot be enabled by a string or other truthy value', () => {
  assert.throws(() => buildProbeConfig({ ...INPUT, checkFilesAndWrite: 'false' }, PROBE_ID), { code: 'INVALID_INPUT' });
});

for (const password of [
  ' leading and trailing spaces ',
  'cash$HOME${PRIVATE_VALUE}$$end',
  'quotes\'"and`backtick',
  'back\\slash\\value',
  'zażółć gęślą jaźń 🔑',
]) {
  test(`password round-trips through JSON and Compose interpolation: ${JSON.stringify(password)}`, () => {
    const config = buildProbeConfig({ ...INPUT, password }, PROBE_ID);
    const serialized = JSON.stringify(config);
    const reloaded = JSON.parse(serialized);
    const options = reloaded.volumes.remote.driver_opts.o;
    const encodedPassword = options.split(',').find((option) => option.startsWith('password='));
    assert.ok(encodedPassword, 'The mount must receive a password option');
    const value = encodedPassword.slice('password='.length);
    assert.equal(value.replaceAll('$$', '$'), password);
    assert.equal(value, password.replaceAll('$', () => '$$'));
  });
}

for (const checkFilesAndWrite of [false, true]) {
test(`Docker Compose preserves literal credentials and embedded code offline with write opt-in=${checkFilesAndWrite}`, (context) => {
  const password = ' synthetic $HOME ${PRIVATE_VALUE} $$ \'" \\ zażółć 🔑 ';
  const config = buildProbeConfig({ ...INPUT, password, checkFilesAndWrite }, PROBE_ID);
  const result = spawnSync('docker', [
    'compose', '--project-name', PROBE_ID, '--file', '-', 'config', '--format', 'json',
  ], {
    input: JSON.stringify(config),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: {
      ...process.env,
      DOCKER_HOST: 'tcp://127.0.0.1:1',
      DOCKER_CONTEXT: '',
      COMPOSE_ANSI: 'never',
    },
  });
  if (result.error?.code === 'ENOENT') {
    context.skip('Docker CLI is unavailable');
    return;
  }
  assert.ok(!result.error, 'Offline Docker Compose configuration validation must finish without error');
  assert.equal(result.status, 0, 'Docker Compose must accept the generated configuration without contacting a daemon');
  assert.ok(result.stderr.trim() === '', 'Docker Compose must not warn about unintended variable interpolation');
  let resolved;
  try {
    resolved = JSON.parse(result.stdout);
  } catch {
    assert.fail('Docker Compose must produce valid JSON configuration');
  }
  const option = resolved.volumes.remote.driver_opts.o.split(',').find((value) => value.startsWith('password='));
  const renderedPassword = option?.slice('password='.length);
  // Compose re-escapes dollar signs when serializing its resolved model as a reusable config.
  assert.ok(renderedPassword === password.replaceAll('$', () => '$$'), 'Docker Compose must preserve the literal credential in its serialized model');
  assert.ok(renderedPassword.replaceAll('$$', '$') === password, 'Decoded Compose configuration must preserve every credential character');
  assert.equal(resolved.services.probe.pull_policy, 'never');
  assert.equal(resolved.services.probe.read_only, true);
  assert.equal(resolved.services.probe.network_mode, 'none');
  assert.equal(resolved.services.probe.volumes[0].read_only ?? false, !checkFilesAndWrite);
  assert.equal(resolved.services.probe.volumes[0].volume.nocopy, true);
  assert.deepEqual(resolved.services.probe.command, config.services.probe.command);
});
}

for (const password of ['comma,in-password', 'nul\0in-password', 'cr\rin-password', 'lf\nin-password']) {
  test(`unsupported credential format is rejected before Docker: ${JSON.stringify(password)}`, async () => {
    let invocationCount = 0;
    assert.throws(() => buildProbeConfig({ ...INPUT, password }, PROBE_ID), {
      code: 'CREDENTIAL_FORMAT_UNSUPPORTED',
    });
    const report = await runProbe({ ...INPUT, password }, {
      probeId: PROBE_ID,
      invoke: async () => {
        invocationCount += 1;
        return successfulInvocation();
      },
    });
    assert.equal(invocationCount, 0);
    assert.equal(report.status, 'CREDENTIAL_FORMAT_UNSUPPORTED');
    assert.equal(report.cleanup, 'NOT_NEEDED');
    assert.equal(JSON.stringify(report).includes(password), false);
  });
}

for (const credentialField of ['username', 'domain']) {
  for (const [characterName, character] of [['comma', ','], ['NUL', '\0'], ['CR', '\r'], ['LF', '\n']]) {
    test(`${credentialField} containing ${characterName} is rejected before Docker`, async () => {
      const input = { ...INPUT, [credentialField]: `private${character}credential` };
      let invocationCount = 0;
      assert.throws(() => buildProbeConfig(input, PROBE_ID), { code: 'CREDENTIAL_FORMAT_UNSUPPORTED' });
      const report = await runProbe(input, {
        probeId: PROBE_ID,
        invoke: async () => {
          invocationCount += 1;
          return successfulInvocation();
        },
      });
      assert.equal(invocationCount, 0);
      assert.equal(report.status, 'CREDENTIAL_FORMAT_UNSUPPORTED');
      assert.equal(report.cleanup, 'NOT_NEEDED');
      assert.equal(JSON.stringify(report).includes('private'), false);
    });
  }
}

for (const subdirectory of ['..', '../outside', 'Projects/../../outside', '..\\outside', '/etc', 'C:\\private']) {
  test(`untrusted directory cannot escape the mounted share: ${JSON.stringify(subdirectory)}`, async () => {
    let invocationCount = 0;
    assert.throws(() => buildProbeConfig({ ...INPUT, subdirectory }, PROBE_ID), {
      code: 'INVALID_INPUT',
    });
    const report = await runProbe({ ...INPUT, subdirectory }, {
      probeId: PROBE_ID,
      invoke: async () => {
        invocationCount += 1;
        return successfulInvocation();
      },
    });
    assert.equal(invocationCount, 0);
    assert.equal(report.status, 'INVALID_INPUT');
    assert.equal(report.cleanup, 'NOT_NEEDED');
  });
}

test('successful read reports success and removes only its generated project', async () => {
  const { report, calls } = await exerciseProbe(successfulInvocation());
  assert.deepEqual(report, { status: 'DIRECTORY_READ_OK', cleanup: 'CLEAN', probeId: PROBE_ID });
  assert.ok(calls.some((call) => !isCleanup(call.args)));
  assert.equal(calls.filter((call) => isCleanup(call.args)).length, 2);
  assert.deepEqual(calls.slice(-2).map((call) => call.args), [
    ['container', 'rm', '--force', PROBE_ID],
    ['volume', 'rm', `${PROBE_ID}-remote`],
  ]);
  assert.ok(isCleanup(calls.at(-1).args), 'Cleanup must follow the probe');
  for (const call of calls) {
    assertScopedProject(call);
    assert.equal(call.args.some((arg) => String(arg).includes(INPUT.password)), false);
    assert.equal(call.args.includes('prune'), false);
  }
});

test('failed mount returns a fixed status and never echoes secret-bearing Docker output', async () => {
  const { report, calls } = await exerciseProbe({
    code: 1,
    stdout: `sensitive stdout ${INPUT.password}`,
    stderr: `error mounting volume: permission denied; password=${INPUT.password}`,
  });
  assert.deepEqual(report, { status: 'MOUNT_ACCESS_DENIED', cleanup: 'CLEAN', probeId: PROBE_ID });
  assert.equal(JSON.stringify(report).includes(INPUT.password), false);
  assert.equal(calls.filter((call) => isCleanup(call.args)).length, 2);
  for (const call of calls) {
    assertScopedProject(call);
    assert.equal(call.args.some((arg) => String(arg).includes(INPUT.password)), false);
  }
});

test('directory denial after the probe starts is distinct from a rejected mount', async () => {
  const { report } = await exerciseProbe({
    code: 5, stdout: 'PROBE_STARTED\nDIRECTORY_ACCESS_DENIED\n', stderr: '',
  });
  assert.equal(report.status, 'DIRECTORY_ACCESS_DENIED');
  assert.equal(report.cleanup, 'CLEAN');
});

test('a directory-denial marker without a started probe does not diagnose filesystem permissions', async () => {
  const { report } = await exerciseProbe({
    code: 1, stdout: 'DIRECTORY_ACCESS_DENIED\n', stderr: 'mount failed: permission denied',
  });
  assert.equal(report.status, 'MOUNT_ACCESS_DENIED');
});

test('success marker cannot override a failed process exit', async () => {
  const { report } = await exerciseProbe({ code: 1, stdout: 'DIRECTORY_READ_OK\n', stderr: '' });
  assert.notEqual(report.status, 'DIRECTORY_READ_OK');
  assert.equal(report.cleanup, 'CLEAN');
});

test('zero exit without the directory-read marker does not claim a successful read', async () => {
  const { report } = await exerciseProbe({ code: 0, stdout: 'Container started\n', stderr: '' });
  assert.equal(report.status, 'OTHER_ERROR');
});

test('success marker must be a complete line, not part of unrelated Docker output', async () => {
  const { report } = await exerciseProbe({
    code: 0,
    stdout: 'failed_DIRECTORY_READ_OK_untrusted\n',
    stderr: '',
  });
  assert.equal(report.status, 'OTHER_ERROR');
});

for (const [status, result] of [
  ['UNREACHABLE', { code: 1, stdout: '', stderr: 'mount failed: no route to host' }],
  ['UNSUPPORTED', { code: 1, stdout: '', stderr: 'mount failed: operation not supported' }],
  ['TIMEOUT', { code: null, stdout: '', stderr: '', timedOut: true }],
  ['IMAGE_MISSING', { code: 1, stdout: '', stderr: 'No such image: photolocal:staging' }],
  ['DIRECTORY_MISSING', { code: 1, stdout: 'DIRECTORY_MISSING\n', stderr: '' }],
]) {
  test(`${status} remains distinguishable and still triggers scoped cleanup`, async () => {
    const { report, calls } = await exerciseProbe(result);
    assert.equal(report.status, status);
    assert.equal(report.cleanup, status === 'TIMEOUT' ? 'REQUIRED' : 'CLEAN');
    assert.equal(calls.filter((call) => isCleanup(call.args)).length, 2);
    for (const call of calls) assertScopedProject(call);
  });
}

test('failed cleanup is reported as required without revealing its output', async () => {
  const { report } = await exerciseProbe(successfulInvocation(), {
    code: 1,
    stdout: '',
    stderr: `volume still in use; password=${INPUT.password}`,
  });
  assert.deepEqual(report, { status: 'DIRECTORY_READ_OK', cleanup: 'REQUIRED', probeId: PROBE_ID });
  assert.equal(JSON.stringify(report).includes(INPUT.password), false);
});

test('an invocation rejection also attempts cleanup and hides exception content', async () => {
  const calls = [];
  const report = await runProbe(INPUT, {
    probeId: PROBE_ID,
    invoke: async (args, stdin) => {
      calls.push({ args, stdin });
      if (!isCleanup(args)) throw new Error(`spawn failed with ${INPUT.password}`);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(report.status, 'OTHER_ERROR');
  assert.equal(report.cleanup, 'REQUIRED');
  assert.equal(calls.filter((call) => isCleanup(call.args)).length, 2);
  assert.equal(JSON.stringify(report).includes(INPUT.password), false);
});

test('cleanup treats already-absent container and volume as clean', async () => {
  const report = await runProbe(INPUT, {
    probeId: PROBE_ID,
    invoke: async (args) => {
      if (args[0] === 'container') {
        return { code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${PROBE_ID}` };
      }
      if (args[0] === 'volume') {
        return { code: 1, stdout: '', stderr: `Error response from daemon: no such volume: ${PROBE_ID}-remote` };
      }
      return successfulInvocation();
    },
  });
  assert.equal(report.status, 'DIRECTORY_READ_OK');
  assert.equal(report.cleanup, 'CLEAN');
});

test('cleanup still removes the volume after container removal throws', async () => {
  const calls = [];
  const report = await runProbe(INPUT, {
    probeId: PROBE_ID,
    invoke: async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === 'container') throw new Error(`cleanup error containing ${INPUT.password}`);
      if (args[0] === 'volume') return { code: 0, stdout: '', stderr: '' };
      return successfulInvocation();
    },
  });
  assert.equal(report.status, 'DIRECTORY_READ_OK');
  assert.equal(report.cleanup, 'REQUIRED');
  assert.ok(calls.some((call) => call.args[0] === 'volume'));
  assert.equal(JSON.stringify(report).includes(INPUT.password), false);
});

for (const probeId of ['photolocal-staging', '--all', 'photolocal-smb-probe-../../outside', 'photolocal-smb-probe-']) {
  test(`invalid probe identifier cannot target unrelated Docker resources: ${probeId}`, async () => {
    let invocationCount = 0;
    assert.throws(() => buildProbeConfig(INPUT, probeId), { code: 'INVALID_INPUT' });
    const report = await runProbe(INPUT, {
      probeId,
      invoke: async () => {
        invocationCount += 1;
        return successfulInvocation();
      },
    });
    assert.equal(invocationCount, 0);
    assert.equal(report.status, 'INVALID_INPUT');
    assert.equal(report.cleanup, 'NOT_NEEDED');
  });
}
