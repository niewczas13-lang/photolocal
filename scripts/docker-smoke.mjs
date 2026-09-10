import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { image: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  process.stdout.write('Usage: node scripts/docker-smoke.mjs --image <already-built-linux-image>\n' +
    'Creates synthetic named volumes and network-disabled containers; deletes only its own resources.\n');
  process.exit(0);
}
if (!values.image || values.image.startsWith('-')) throw new Error('--image is required');

const runId = randomUUID();
const prefix = `photolocal-smoke-${runId}`;
const labelKey = 'io.photolocal.smoke';
const containerName = `${prefix}-app`;
const seedName = `${prefix}-seed`;
const volumes = ['data', 'google', 'downloads', 'photos'].map((directory) => ({
  name: `${prefix}-${directory}`, destination: `/${directory}`,
}));
const probe = await readFile(new URL('./docker-smoke.probe.mjs', import.meta.url), 'utf8');

async function docker(args, { input = '', allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`docker ${args[0]} ${args[1] ?? ''} failed: ${stderr || error.message}`));
      } else {
        resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    // Docker's error/exit above reports an early failure; EPIPE must not crash cleanup.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

const runtimeArgs = [
  '--pull=never', '--network=none', '--label', `${labelKey}=${runId}`,
  '--env', 'PHOTO_LOCAL_SMOKE_TEST=1',
  '--env', 'PHOTO_LOCAL_AUTH=enabled',
  '--env', 'PHOTO_LOCAL_SHARED_ROOTS=[{"path":"/photos","label":"CI photos"}]',
  '--env', 'GOOGLE_CHAT_OAUTH_REDIRECT_URI=https://photolocal-ci.invalid/api/google-chat/auth/callback',
  '--env', 'OLLAMA_URL=http://127.0.0.1:9',
  ...volumes.flatMap(({ name, destination }) => ['--mount', `type=volume,src=${name},dst=${destination}`]),
];

async function inspectContainer() {
  const result = await docker(['inspect', containerName]);
  return JSON.parse(result.stdout)[0];
}

async function assertIsolated() {
  const container = await inspectContainer();
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
  assert.equal(container.Config.User, 'node');
  assert.deepEqual(container.Config.Cmd, ['node', 'backend/dist/server.js']);
  assert.equal(container.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(container.Mounts.length, volumes.length);
  for (const { name, destination } of volumes) {
    const mount = container.Mounts.find((entry) => entry.Destination === destination);
    assert.ok(mount, `Missing persistent directory: ${destination}`);
    assert.equal(mount.Type, 'volume');
    assert.equal(mount.Name, name);
    assert.equal(mount.RW, true);
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const container = await inspectContainer();
    if (container.State.Health?.Status === 'healthy') return;
    if (!container.State.Running || container.State.OOMKilled) {
      throw new Error('Container stopped before becoming healthy');
    }
    await delay(1_000);
  }
  throw new Error('Container did not become healthy within 90 seconds');
}

async function startContainer() {
  await docker(['run', '--detach', '--name', containerName, '--init', '--restart=unless-stopped',
    '--health-interval=1s', '--health-timeout=5s', '--health-start-period=1s', '--health-retries=60',
    ...runtimeArgs, values.image]);
  await assertIsolated();
  await waitForHealth();
}

async function checkApplication(mode) {
  const result = await docker(['exec', '--interactive', containerName,
    'node', '--input-type=module', '-', mode], { input: probe });
  process.stdout.write(`${result.stdout}\n`);
}

async function removeOwnedContainer(name) {
  const inspected = await docker(['inspect', name], { allowFailure: true });
  if (!inspected.ok) return;
  const container = JSON.parse(inspected.stdout)[0];
  if (container.Config.Labels?.[labelKey] !== runId) {
    throw new Error('Refusing to delete a container not created by this smoke test');
  }
  await docker(['rm', '--force', name]);
}

async function cleanup() {
  const failures = [];
  for (const name of [seedName, containerName]) {
    try { await removeOwnedContainer(name); } catch (error) { failures.push(error); }
  }
  for (const { name } of volumes) {
    try {
      const inspected = await docker(['volume', 'inspect', name], { allowFailure: true });
      if (!inspected.ok) continue;
      if (JSON.parse(inspected.stdout)[0].Labels?.[labelKey] !== runId) {
        throw new Error('Refusing to delete a volume not created by this smoke test');
      }
      await docker(['volume', 'rm', name]);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Smoke-test resource cleanup failed');
}

try {
  const image = JSON.parse((await docker(['image', 'inspect', values.image])).stdout)[0];
  assert.equal(image.Os, 'linux', 'Smoke test requires a Linux image');
  for (const { name } of volumes) {
    await docker(['volume', 'create', '--label', `${labelKey}=${runId}`, name]);
  }
  const seeded = await docker(['run', '--rm', '--interactive', '--name', seedName, ...runtimeArgs,
    values.image, 'node', '--input-type=module', '-', 'seed'], { input: probe });
  process.stdout.write(`${seeded.stdout}\n`);

  await startContainer();
  await checkApplication('initial');

  await docker(['restart', '--time', '20', containerName]);
  await waitForHealth();
  await assertIsolated();
  await checkApplication('restored');
  process.stdout.write('Session and persisted files survived a container restart.\n');

  await docker(['stop', '--time', '20', containerName]);
  const stopped = await inspectContainer();
  assert.equal(stopped.State.ExitCode, 0, 'SIGTERM must shut the application down cleanly');
  await removeOwnedContainer(containerName);
  await startContainer();
  await checkApplication('restored');
  await checkApplication('logout');
  process.stdout.write('Session and persisted files survived container recreation. Docker smoke passed.\n');
} catch (error) {
  const logs = await docker(['logs', '--tail', '100', containerName], { allowFailure: true });
  if (logs.ok) process.stderr.write(`${logs.stdout}\n${logs.stderr}\n`);
  process.stderr.write(`${error instanceof Error ? error.stack : 'Docker smoke failed'}\n`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cleanup failed'}\n`);
    process.exitCode = 1;
  }
}
