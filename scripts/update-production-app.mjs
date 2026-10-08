import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PROJECT = 'photolocal-production';
const SERVICE = 'photolocal';
const CONTAINER = '/' + PROJECT + '-' + SERVICE + '-1';
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}},"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"environment":{{json .Config.Env}}}';
const IMAGE_INSPECT = '{"id":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"environment":{{json .Config.Env}}}';
const UP = ['up', '--no-deps', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', SERVICE];
// Root repair tools and runtime data are outside the Docker build input allowlist.
const BUILD_INPUT_PATHS = [
  'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
  'backend/src', 'backend/package.json', 'backend/tsconfig.json',
  'frontend/src', 'frontend/public', 'frontend/package.json', 'frontend/tsconfig*.json',
  'frontend/vite.config.ts', 'frontend/index.html',
  'pobierzchat/chat.py', 'pobierzchat/requirements.txt',
  'scripts/copy-schema.mjs', 'scripts/migrate-docker-data.mjs',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const decode = value => String(value).replaceAll('$$', '$');
const pathKey = value => {
  const key = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

function fail(suffix = 'INVALID_CONFIGURATION') {
  const code = 'PRODUCTION_APP_UPDATE_' + suffix;
  throw Object.assign(new Error(code), { code });
}

function json(value, suffix) {
  try { return JSON.parse(value); } catch { fail(suffix); }
}

async function localPath(value, directory) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[,\x00-\x1f]/.test(value) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..')) fail();
  const absolute = resolve(value);
  let current = absolute;
  while (current !== parse(current).root) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) fail();
    current = dirname(current);
  }
  const stat = await lstat(absolute);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || pathKey(await realpath(absolute)) !== pathKey(absolute)) fail();
  return absolute;
}

async function nativeRun(executable, args, { timeout = 30000 } = {}) {
  return new Promise((resolveCall, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('TIMEOUT'));
    }, timeout);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size <= 4 * 1024 * 1024) {
          if (name === 'stdout') stdout += chunk;
          else stderr += chunk;
        }
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolveCall({ code, stdout, stderr }); });
  });
}

function orderedMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.some(mount => !mount || typeof mount.Destination !== 'string') ||
      new Set(mounts.map(mount => mount.Destination)).size !== mounts.length) fail('CONTAINER_IDENTITY_INVALID');
  return [...mounts].sort((a, b) => a.Destination.localeCompare(b.Destination));
}

function environmentValues(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.includes('='))) fail('CONTAINER_IDENTITY_INVALID');
  const entries = values.map(value => {
    const equals = value.indexOf('=');
    return [value.slice(0, equals), value.slice(equals + 1)];
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) fail('CONTAINER_IDENTITY_INVALID');
  return Object.fromEntries(entries);
}

function bindKey(value) {
  const translated = value.replaceAll('\\', '/')
    .replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/');
  return pathKey(translated);
}

function mountIdentities(mounts) {
  return orderedMounts(mounts).map(mount => {
    if (!['bind', 'volume'].includes(mount.Type) || typeof mount.Source !== 'string' ||
        !mount.Source || typeof mount.RW !== 'boolean' ||
        (mount.Mode !== undefined && typeof mount.Mode !== 'string') ||
        (mount.Type === 'volume' && (typeof mount.Name !== 'string' || !mount.Name))) {
      fail('CONTAINER_IDENTITY_INVALID');
    }
    // RW and Propagation describe effective access. Their duplicate Mode tokens
    // and the Engine's default z for named volumes depend on the creation API.
    const propagation = mount.Propagation || 'rprivate';
    const options = [...new Set((mount.Mode ?? '').split(',').filter(option =>
      !['', 'rw', 'ro'].includes(option) && !(mount.Type === 'volume' && option === 'z') &&
      !(mount.Type === 'bind' && option === propagation &&
        ['private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave'].includes(option))))].sort();
    return {
      Type: mount.Type, Destination: mount.Destination, RW: mount.RW,
      Source: mount.Type === 'bind' ? bindKey(mount.Source) : mount.Source.replace(/\/+$/, '') || '/',
      Name: mount.Name ?? '', Driver: mount.Driver ?? '',
      Propagation: propagation, options,
    };
  });
}

function verifyApp(config, app, directory, files) {
  const service = config.services?.[SERVICE];
  if (config.name !== PROJECT || !service || service.image !== app.image || !IMAGE.test(app.image) ||
      app.running !== true || app.health !== 'healthy' || app.name !== CONTAINER ||
      pathKey(app.labels['com.docker.compose.project.working_dir']) !== pathKey(directory) ||
      app.labels['com.docker.compose.project.config_files'] !== files.join(',') ||
      service.environment?.PHOTO_LOCAL_AUTH !== 'enabled' ||
      service.environment.PHOTO_LOCAL_DB !== '/data/photo-local.sqlite') fail('APP_VERIFICATION_FAILED');
  const ports = { '4873/tcp': [{ HostIp: '0.0.0.0', HostPort: '4873' }] };
  if (!isDeepStrictEqual(app.ports, ports)) fail('APP_VERIFICATION_FAILED');
  const environment = environmentValues(app.environment);
  for (const [key, value] of Object.entries(service.environment)) {
    if (environment[key] !== decode(value)) fail('ACTIVE_CONFIGURATION_CHANGED');
  }
  const mounts = orderedMounts(app.mounts);
  if (!Array.isArray(service.volumes) || mounts.length !== service.volumes.length ||
      new Set(service.volumes.map(mount => mount.target)).size !== service.volumes.length ||
      !service.volumes.some(mount => mount.target === '/data')) fail('APP_VERIFICATION_FAILED');
  for (const mount of service.volumes) {
    const actual = mounts.find(value => value.Destination === mount.target);
    if (!actual || actual.Type !== mount.type || actual.RW !== !Boolean(mount.read_only)) fail('APP_VERIFICATION_FAILED');
    if (mount.type === 'bind') {
      if (mount.bind?.create_host_path !== false || bindKey(actual.Source) !== bindKey(decode(mount.source))) fail('APP_VERIFICATION_FAILED');
    } else if (mount.type === 'volume') {
      const volume = config.volumes?.[mount.source];
      if (!volume || typeof volume.name !== 'string' || actual.Name !== decode(volume.name)) fail('APP_VERIFICATION_FAILED');
    } else fail('APP_VERIFICATION_FAILED');
  }
}

function sameActiveApp(left, right) {
  return left.id === right.id && left.name === right.name && left.image === right.image &&
    left.running === right.running && left.health === right.health &&
    isDeepStrictEqual(left.labels, right.labels) && isDeepStrictEqual(left.ports, right.ports) &&
    isDeepStrictEqual(orderedMounts(left.mounts), orderedMounts(right.mounts)) &&
    isDeepStrictEqual(environmentValues(left.environment), environmentValues(right.environment));
}

/** Build a replacement and change only the existing production application service. */
export async function updateProductionApp(input, { run = nativeRun } = {}) {
  let phase = 'preflight';
  let applicationMayHaveChanged = false;
  let rollbackReport;
  let rollbackStatus;
  let rollbackCode;
  let rollback;
  let lock;
  let lockPath;
  let lockIdentity;
  let lockDigest;
  try {
    if (!input || !/^[a-f0-9]{40}$/.test(input.revision) ||
        (input.prepareOnly !== undefined && typeof input.prepareOnly !== 'boolean')) fail();
    const staging = await localPath(input.stagingRoot, true);
    const directory = await localPath(input.runDirectory, true);
    if (pathKey(dirname(directory)) !== pathKey(join(staging, 'docker-data')) ||
        !/^production-[a-f0-9]{32}$/.test(basename(directory))) fail();
    lockPath = join(directory, 'production-app-update.lock');
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('LOCKED');
      throw error;
    }
    lockIdentity = await lock.stat();
    const lockContent = JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid, revision: input.revision }) + '\n';
    await lock.writeFile(lockContent);
    lockDigest = digest(lockContent);
    await localPath(join(staging, 'Dockerfile'), false);
    const call = async (args, suffix, timeout) => {
      let result;
      try { result = await run('docker', args, { timeout }); } catch { fail(suffix); }
      if (result.code !== 0) fail(suffix);
      return result.stdout.trim();
    };
    const verifySource = async () => {
      for (const args of [
        ['-C', staging, 'rev-parse', 'HEAD'],
        ['-C', staging, 'status', '--porcelain', '--untracked-files=no'],
        ['-C', staging, 'status', '--porcelain', '--untracked-files=all', '--', ...BUILD_INPUT_PATHS],
      ]) {
        let response;
        try { response = await run('git', args, { timeout: 30000 }); } catch { fail('SOURCE_QUERY_FAILED'); }
        if (response.code !== 0) fail('SOURCE_QUERY_FAILED');
        if (args[2] === 'rev-parse' ? response.stdout.trim() !== input.revision : response.stdout.trim() !== '') fail('SOURCE_CHANGED');
      }
    };
    const inspect = async ({ allowAbsent = false } = {}) => {
      const id = await call(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
        '--filter', `label=com.docker.compose.service=${SERVICE}`, '--format', '{{.ID}}', '--no-trunc'], 'DOCKER_QUERY_FAILED');
      if (allowAbsent && id === '') return undefined;
      if (!/^[a-f0-9]{64}$/.test(id)) fail('CONTAINER_IDENTITY_INVALID');
      const app = json(await call(['container', 'inspect', '--format', INSPECT, id], 'DOCKER_QUERY_FAILED'), 'DOCKER_QUERY_FAILED');
      if (app.id !== id || app.name !== CONTAINER || app.labels?.['com.docker.compose.project'] !== PROJECT ||
          app.labels?.['com.docker.compose.service'] !== SERVICE || !IMAGE.test(app.image)) fail('CONTAINER_IDENTITY_INVALID');
      return app;
    };
    const original = await inspect();
    if (typeof original.labels['com.docker.compose.project.working_dir'] !== 'string' ||
        pathKey(original.labels['com.docker.compose.project.working_dir']) !== pathKey(directory)) fail('CONTAINER_IDENTITY_INVALID');
    const files = original.labels['com.docker.compose.project.config_files']?.split(',');
    if (!files?.length || files.length > 64 || new Set(files.map(pathKey)).size !== files.length ||
        pathKey(files[0]) !== pathKey(join(directory, 'compose.production.json'))) fail();
    const fingerprints = new Map([[lockPath, lockDigest]]);
    for (const file of [...files, join(directory, 'empty.env')]) {
      if (pathKey(dirname(file)) !== pathKey(directory)) fail();
      await localPath(file, false);
      const contents = await readFile(file);
      if (contents.length > 4 * 1024 * 1024 || (basename(file) === 'empty.env' && contents.length !== 0)) fail();
      fingerprints.set(file, digest(contents));
    }
    const compose = extra => ['compose', '--ansi', 'never', '-p', PROJECT, '--project-directory', directory,
      '--env-file', join(directory, 'empty.env'), ...[...files, ...extra].flatMap(file => ['-f', file])];
    const before = json(await call([...compose([]), 'config', '--format', 'json'], 'COMPOSE_FAILED'), 'COMPOSE_FAILED');
    verifyApp(before, original, directory, files);
    const assertFilesUnchanged = async () => {
      for (const [file, hash] of fingerprints) {
        try {
          await localPath(file, false);
          if (digest(await readFile(file)) !== hash) fail('ACTIVE_CONFIGURATION_CHANGED');
        } catch { fail('ACTIVE_CONFIGURATION_CHANGED'); }
      }
    };
    const assertActiveUnchanged = async () => {
      await verifySource();
      await assertFilesUnchanged();
      if (!sameActiveApp(original, await inspect())) fail('ACTIVE_CONFIGURATION_CHANGED');
    };
    phase = 'build';
    await verifySource();
    const unique = randomUUID().replaceAll('-', '');
    const tag = `photolocal:app-update-${unique}`;
    await call(['build', '--label', 'org.opencontainers.image.revision=' + input.revision,
      '-t', tag, '-f', join(staging, 'Dockerfile'), staging], 'BUILD_FAILED', 20 * 60 * 1000);
    const image = json(await call(['image', 'inspect', '--format', IMAGE_INSPECT, tag], 'INVALID_IMAGE'), 'INVALID_IMAGE');
    if (!IMAGE.test(image.id) || image.revision !== input.revision ||
        (image.environment !== null && !Array.isArray(image.environment))) fail('INVALID_IMAGE');
    // Docker overlays Compose settings onto the replacement image's own defaults.
    // Base-image NODE_VERSION, PATH and other defaults may legitimately change.
    const replacementEnvironment = {
      ...environmentValues(image.environment ?? []),
      ...Object.fromEntries(Object.entries(before.services[SERVICE].environment)
        .map(([key, value]) => [key, decode(value)])),
    };
    await assertActiveUnchanged();
    const result = {
      runDirectory: directory, previousImageId: original.image, imageId: image.id,
      revision: input.revision, applicationUpdated: false,
    };
    if (image.id === original.image) return { ...result, status: 'PRODUCTION_APP_CURRENT' };
    const overridePath = join(directory, `compose.app-update-${unique}.json`);
    const content = JSON.stringify({ services: { [SERVICE]: { image: image.id } } }, null, 2) + '\n';
    await writeFile(overridePath, content, { flag: 'wx', mode: 0o600 });
    fingerprints.set(overridePath, digest(content));
    const updatedFiles = [...files, overridePath];
    const args = compose([overridePath]);
    const after = json(await call([...args, 'config', '--format', 'json'], 'COMPOSE_FAILED'), 'COMPOSE_FAILED');
    const expected = structuredClone(before);
    expected.services[SERVICE].image = image.id;
    if (!isDeepStrictEqual(after, expected)) fail('UNSAFE_COMPOSE_MERGE');
    await assertActiveUnchanged();
    if (input.prepareOnly) return { ...result, status: 'PRODUCTION_APP_PREPARED', overridePath };
    rollbackReport = join(directory, `app-update-rollback-${unique}.json`);
    await writeFile(rollbackReport, JSON.stringify({
      version: 1, status: 'PRODUCTION_APP_ROLLBACK_READY', runDirectory: directory,
      previousImageId: original.image, imageId: image.id, revision: input.revision,
      files: files.map(path => ({ path, hash: fingerprints.get(path) })), overridePath,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    rollback = async () => {
      await assertFilesUnchanged();
      const current = await inspect({ allowAbsent: true });
      if (current && (![original.image, image.id].includes(current.image) ||
          pathKey(current.labels['com.docker.compose.project.working_dir']) !== pathKey(directory) ||
          ![files.join(','), updatedFiles.join(',')].includes(current.labels['com.docker.compose.project.config_files']) ||
          !isDeepStrictEqual(current.ports, original.ports) ||
          !isDeepStrictEqual(mountIdentities(current.mounts), mountIdentities(original.mounts)) ||
          !isDeepStrictEqual(environmentValues(current.environment), current.image === original.image
            ? environmentValues(original.environment) : replacementEnvironment))) fail('ACTIVE_CONFIGURATION_CHANGED');
      if (await call(['image', 'inspect', '--format', '{{.Id}}', original.image], 'ROLLBACK_FAILED') !== original.image) fail('ROLLBACK_FAILED');
      await call([...compose([]), ...UP], 'ROLLBACK_FAILED', 150000);
      const restored = await inspect();
      verifyApp(before, restored, directory, files);
      if (!isDeepStrictEqual(mountIdentities(restored.mounts), mountIdentities(original.mounts)) ||
          !isDeepStrictEqual(environmentValues(restored.environment), environmentValues(original.environment))) fail('ROLLBACK_FAILED');
    };
    await assertActiveUnchanged();
    phase = 'application_start';
    applicationMayHaveChanged = true;
    await call([...args, ...UP], 'APP_START_FAILED', 150000);
    const current = await inspect();
    verifyApp(after, current, directory, updatedFiles);
    if (!isDeepStrictEqual(mountIdentities(current.mounts), mountIdentities(original.mounts)) ||
        !isDeepStrictEqual(environmentValues(current.environment), replacementEnvironment)) fail('APP_VERIFICATION_FAILED');
    return { ...result, status: 'PRODUCTION_APP_UPDATED', applicationUpdated: true, overridePath, rollbackReport };
  } catch (error) {
    if (applicationMayHaveChanged && rollback) {
      try { await rollback(); rollbackStatus = 'RESTORED'; }
      catch (rollbackError) {
        rollbackStatus = 'FAILED';
        rollbackCode = /^PRODUCTION_APP_UPDATE_[A-Z_]+$/.test(rollbackError?.code ?? '')
          ? rollbackError.code : 'PRODUCTION_APP_UPDATE_ROLLBACK_FAILED';
      }
    }
    const code = /^PRODUCTION_APP_UPDATE_[A-Z_]+$/.test(error?.code ?? '')
      ? error.code : 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION';
    throw Object.assign(new Error(code), { code, phase, applicationMayHaveChanged, rollbackStatus, rollbackCode, rollbackReport });
  } finally {
    if (lock) {
      try {
        await lock.close();
        const identity = await lstat(lockPath);
        if (identity.dev === lockIdentity.dev && identity.ino === lockIdentity.ino &&
            (!lockDigest || digest(await readFile(lockPath)) === lockDigest)) await unlink(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          const code = 'PRODUCTION_APP_UPDATE_LOCK_RELEASE_FAILED';
          throw Object.assign(new Error(code), { code, phase, applicationMayHaveChanged, rollbackStatus, rollbackCode, rollbackReport });
        }
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 131072) fail();
    }
    process.stdout.write(JSON.stringify(await updateProductionApp(json(input, 'INVALID_CONFIGURATION'))) + '\n');
  } catch (error) {
    const code = /^PRODUCTION_APP_UPDATE_[A-Z_]+$/.test(error?.code ?? '')
      ? error.code : 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION';
    process.stdout.write(JSON.stringify({
      status: 'PRODUCTION_APP_UPDATE_FAILED', code, phase: error.phase ?? 'preflight',
      applicationMayHaveChanged: error.applicationMayHaveChanged ?? false,
      rollbackStatus: error.rollbackStatus, rollbackCode: error.rollbackCode, rollbackReport: error.rollbackReport,
    }) + '\n');
    process.exitCode = 1;
  }
}
