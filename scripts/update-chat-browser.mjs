import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PROJECT = 'photolocal-production';
const IMAGE = /^sha256:[a-f0-9]{64}$/;
export const PROFILE_VOLUME = 'photolocal-production-chat-browser-profile';
const BROWSER_ENVIRONMENT = {
  GOOGLE_CHAT_BROWSER_CDP_URL: 'http://chat-browser:9223',
  GOOGLE_CHAT_BROWSER_VNC_HOST: 'chat-browser',
  GOOGLE_CHAT_BROWSER_VNC_PORT: '5900',
};
const INSPECT = '{"id":{{json .Id}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"state":{{json .State}},"mounts":{{json .Mounts}},"environment":{{json .Config.Env}},"host":{{json .HostConfig}},"user":{{json .Config.User}},"networks":{{json .NetworkSettings.Networks}}}';
const decode = value => String(value).replaceAll('$$', '$');
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(suffix = 'INVALID_CONFIGURATION') {
  const code = `CHAT_BROWSER_UPDATE_${suffix}`;
  throw Object.assign(new Error(code), { code });
}

export function buildChatBrowserOverride({ imageId, browserImageId, disableSandbox = false }) {
  if (!IMAGE.test(imageId) || !IMAGE.test(browserImageId)) fail('INVALID_IMAGE');
  if (typeof disableSandbox !== 'boolean') fail();
  return {
    services: {
      photolocal: { image: imageId, environment: { ...BROWSER_ENVIRONMENT } },
      'chat-browser': {
        image: browserImageId, pull_policy: 'never', hostname: 'photolocal-chat-browser',
        user: '1000:1000', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
        read_only: true, tmpfs: ['/tmp:mode=1777,size=512m'], shm_size: 268435456,
        init: true, restart: 'unless-stopped', stop_grace_period: '30s',
        environment: { CHAT_BROWSER_DISABLE_SANDBOX: String(disableSandbox) },
        volumes: [{ type: 'volume', source: 'chat_browser_profile', target: '/profile' }],
        networks: { default: null },
      },
    },
    volumes: { chat_browser_profile: { name: PROFILE_VOLUME } },
  };
}

function normalizeBrowser(service) {
  const value = structuredClone(service);
  value.shm_size = Number(value.shm_size);
  for (const key of ['command', 'entrypoint']) if (value[key] === null) delete value[key];
  if (isDeepStrictEqual(value.networks, { default: {} })) value.networks.default = null;
  for (const mount of value.volumes ?? []) {
    if (isDeepStrictEqual(mount.volume, {})) delete mount.volume;
    if (mount.read_only === false) delete mount.read_only;
  }
  return value;
}

export function verifyChatBrowserMerge(before, after, override) {
  const expected = structuredClone(before);
  if (!expected.services?.photolocal?.environment) fail();
  expected.services.photolocal.image = override.services.photolocal.image;
  Object.assign(expected.services.photolocal.environment, override.services.photolocal.environment);
  expected.services['chat-browser'] = normalizeBrowser(override.services['chat-browser']);
  expected.volumes = { ...expected.volumes, ...override.volumes };
  const actual = structuredClone(after);
  actual.services['chat-browser'] = normalizeBrowser(actual.services['chat-browser']);
  if (!isDeepStrictEqual(expected, actual)) fail('UNSAFE_COMPOSE_MERGE');
}

function pathKey(value) {
  return win32.normalize(value).replace(/[\\/]$/, '').toLowerCase();
}

async function localPath(value, directory) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || /[,\x00-\x1f\x7f]/.test(value) ||
      /[<>:"|?*]/.test(value.slice(2)) || value.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part))) fail();
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
    const timer = setTimeout(() => { child.kill(); reject(new Error('TIMEOUT')); }, timeout);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size <= 4 * 1024 * 1024) { if (name === 'stdout') stdout += chunk; else stderr += chunk; }
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolveCall({ code, stdout, stderr }); });
  });
}

function bindKey(value) {
  let translated = decode(value).replaceAll('\\', '/');
  translated = translated.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/');
  return pathKey(translated);
}

function verifyApp(config, app, runDirectory, { requireHealthy = true } = {}) {
  const service = config.services?.photolocal;
  if (!service || service.image !== app.image || service.environment?.PHOTO_LOCAL_AUTH !== 'enabled' ||
      service.environment.PHOTO_LOCAL_DB !== '/data/photo-local.sqlite' || service.environment.GOOGLE_CHAT_DOWNLOAD_ROOT !== '/downloads' ||
      (requireHealthy && (app.state?.Status !== 'running' || app.state.Health?.Status !== 'healthy')) || !IMAGE.test(app.image)) fail();
  const environment = Object.fromEntries((app.environment ?? []).map(value => {
    const equals = value.indexOf('='); return [value.slice(0, equals), value.slice(equals + 1)];
  }));
  for (const [key, value] of Object.entries(service.environment)) if (environment[key] !== decode(value)) fail('ACTIVE_CONFIGURATION_CHANGED');
  const targets = { '/data': 'data', '/google': 'google', '/downloads': 'downloads', '/legacy-local-photos': 'local-photos', '/photos': 'photos' };
  if (service.volumes?.length !== 6 || app.mounts?.length !== 6) fail();
  for (const mount of service.volumes) {
    const actual = app.mounts.find(value => value.Destination === mount.target);
    if (!actual || !actual.RW || mount.read_only === true || actual.Type !== mount.type) fail();
    if (mount.type === 'bind') {
      if (!targets[mount.target] || mount.bind?.create_host_path !== false ||
          bindKey(mount.source) !== pathKey(join(runDirectory, targets[mount.target])) || bindKey(actual.Source) !== bindKey(mount.source)) fail();
    } else if (mount.type !== 'volume' || mount.target !== '/nas' || !config.volumes?.[mount.source]?.external ||
        !/^photolocal-production-nas-[a-f0-9]{32}$/.test(actual.Name) || config.volumes[mount.source].name !== actual.Name) fail();
  }
}

function verifyBrowser(browser, imageId) {
  const host = browser.host;
  const security = (host?.SecurityOpt ?? []).map(value => value === 'no-new-privileges' ? 'no-new-privileges:true' : value);
  const mounts = browser.mounts ?? [];
  const temporary = mounts.filter(value => value.Type === 'tmpfs' && value.Destination === '/tmp');
  const profile = mounts.filter(value => value.Type === 'volume' && value.Destination === '/profile' && value.Name === PROFILE_VOLUME && value.RW);
  if (browser.image !== imageId || browser.state?.Status !== 'running' || browser.state.Health?.Status !== 'healthy' ||
      browser.user !== '1000:1000' || host?.ReadonlyRootfs !== true || Number(host.ShmSize) !== 268435456 ||
      host.Privileged === true || (host.CapAdd?.length ?? 0) !== 0 || (host.Devices?.length ?? 0) !== 0 ||
      (host.DeviceRequests?.length ?? 0) !== 0 || host.NetworkMode !== `${PROJECT}_default` ||
      !['', undefined].includes(host.PidMode) || !['', undefined].includes(host.UTSMode) ||
      !['', 'private', undefined].includes(host.IpcMode) || !isDeepStrictEqual(Object.keys(browser.networks ?? {}), [`${PROJECT}_default`]) ||
      !isDeepStrictEqual(host.CapDrop, ['ALL']) || !isDeepStrictEqual(security, ['no-new-privileges:true']) ||
      Object.keys(host.PortBindings ?? {}).length !== 0 || profile.length !== 1 || temporary.length > 1 || mounts.length !== profile.length + temporary.length ||
      !isDeepStrictEqual(host.Tmpfs, { '/tmp': 'mode=1777,size=512m' })) fail('BROWSER_ISOLATION_FAILED');
}

async function rollbackChatBrowser(input, run) {
  const staging = await localPath(input.stagingRoot, true);
  const directory = await localPath(input.runDirectory, true);
  const reportPath = await localPath(input.rollbackReport, false);
  if (input.workStopped !== true || input.prepareOnly || pathKey(dirname(directory)) !== pathKey(join(staging, 'docker-data')) ||
      !/^production-[a-f0-9]{32}$/.test(win32.basename(directory)) || pathKey(dirname(reportPath)) !== pathKey(directory) ||
      !/^chat-browser-rollback-[a-f0-9]{32}\.json$/.test(win32.basename(reportPath))) fail();
  const bytes = await readFile(reportPath);
  if (bytes.length > 65536) fail();
  const report = JSON.parse(bytes);
  if (report.version !== 1 || report.status !== 'CHAT_BROWSER_ROLLBACK_READY' || report.runDirectory !== directory ||
      report.stagingRoot !== staging || !IMAGE.test(report.imageId) || !IMAGE.test(report.proposedImageId) ||
      !Array.isArray(report.files) || report.files.length < 1 || report.files.length > 16 ||
      pathKey(report.files[0].path) !== pathKey(join(directory, 'compose.production.json')) ||
      pathKey(dirname(report.overridePath)) !== pathKey(directory) || !/^compose\.chat-browser-[a-f0-9]{32}\.json$/.test(win32.basename(report.overridePath))) fail();
  const checkFiles = async () => {
    for (const file of [...report.files, { path: report.overridePath, hash: report.overrideHash }]) {
      if (pathKey(dirname(file.path)) !== pathKey(directory) || !/^[a-f0-9]{64}$/.test(file.hash)) fail();
      await localPath(file.path, false);
      if (digest(await readFile(file.path)) !== file.hash) fail('ACTIVE_CONFIGURATION_CHANGED');
    }
    await localPath(join(directory, 'empty.env'), false);
    if ((await readFile(join(directory, 'empty.env'))).length !== 0) fail();
  };
  await checkFiles();
  const call = async (args, timeout = 30000) => {
    const result = await run('docker', args, { timeout });
    if (result.code !== 0) fail('ROLLBACK_FAILED');
    return result.stdout.trim();
  };
  const files = report.files.map(file => file.path);
  const args = ['compose', '--ansi', 'never', '-p', PROJECT, '--project-directory', directory,
    '--env-file', join(directory, 'empty.env'), ...files.flatMap(file => ['-f', file])];
  const before = JSON.parse(await call([...args, 'config', '--format', 'json']));
  if (before.services?.photolocal?.image !== report.imageId) fail();
  const inspect = async () => {
    const id = await call(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', 'label=com.docker.compose.service=photolocal', '--format', '{{.ID}}', '--no-trunc']);
    if (!/^[a-f0-9]{64}$/.test(id)) fail('CONTAINER_IDENTITY_INVALID');
    const app = JSON.parse(await call(['container', 'inspect', '--format', INSPECT, id]));
    if (app.id !== id || app.labels?.['com.docker.compose.project'] !== PROJECT || app.labels?.['com.docker.compose.service'] !== 'photolocal' ||
        pathKey(app.labels['com.docker.compose.project.working_dir']) !== pathKey(directory) || ![report.imageId, report.proposedImageId].includes(app.image) ||
        ![files.join(','), [...files, report.overridePath].join(',')].includes(app.labels['com.docker.compose.project.config_files'])) fail('CONTAINER_IDENTITY_INVALID');
    return app;
  };
  const current = await inspect();
  // Current code may already have written data: restore code only, on the same mounts.
  const expectedCurrent = structuredClone(before);
  expectedCurrent.services.photolocal.image = current.image;
  if (current.image === report.proposedImageId) Object.assign(expectedCurrent.services.photolocal.environment, BROWSER_ENVIRONMENT);
  verifyApp(expectedCurrent, current, directory, { requireHealthy: false });
  await call(['image', 'inspect', '--format', '{{.Id}}', report.imageId]);
  await checkFiles();
  await call([...args, 'up', '--no-deps', '--force-recreate', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal'], 150000);
  const restored = await inspect();
  verifyApp(before, restored, directory);
  if (restored.image !== report.imageId || !isDeepStrictEqual(restored.mounts, current.mounts) || restored.labels['com.docker.compose.project.config_files'] !== files.join(',')) fail('ROLLBACK_FAILED');
  const callback = new URL(decode(before.services.photolocal.environment.GOOGLE_CHAT_OAUTH_REDIRECT_URI));
  return { status: 'CHAT_BROWSER_ROLLED_BACK', url: callback.origin, runDirectory: directory, rollbackReport: reportPath, applicationUpdated: true };
}

export async function updateChatBrowser(input, { run = nativeRun } = {}) {
  let applicationMayHaveChanged = false;
  let phase = 'preflight';
  let rollbackReport;
  try {
    if (input?.rollbackReport) {
      phase = 'rollback'; applicationMayHaveChanged = true;
      return await rollbackChatBrowser(input, run);
    }
    if (!input?.prepareOnly && input?.workStopped !== true) fail('WORK_STOPPED_REQUIRED');
    const staging = await localPath(input.stagingRoot, true);
    const directory = await localPath(input.runDirectory, true);
    if (pathKey(dirname(directory)) !== pathKey(join(staging, 'docker-data')) || !/^production-[a-f0-9]{32}$/.test(win32.basename(directory))) fail();
    const call = async (args, suffix, timeout) => {
      const result = await run('docker', args, { timeout });
      if (result.code !== 0) fail(suffix);
      return result.stdout.trim();
    };
    const inspect = async service => {
      const id = await call(['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}', '--no-trunc'], 'DOCKER_QUERY_FAILED');
      if (!/^[a-f0-9]{64}$/.test(id)) fail('CONTAINER_IDENTITY_INVALID');
      const result = JSON.parse(await call(['container', 'inspect', '--format', INSPECT, id], 'DOCKER_QUERY_FAILED'));
      if (result.id !== id || result.labels?.['com.docker.compose.project'] !== PROJECT || result.labels?.['com.docker.compose.service'] !== service) fail('CONTAINER_IDENTITY_INVALID');
      return result;
    };
    const original = await inspect('photolocal');
    if (pathKey(original.labels['com.docker.compose.project.working_dir'] ?? '') !== pathKey(directory)) fail();
    const files = (original.labels['com.docker.compose.project.config_files'] ?? '').split(',');
    if (files.length > 16 || pathKey(files[0]) !== pathKey(join(directory, 'compose.production.json')) || new Set(files.map(pathKey)).size !== files.length) fail();
    const fingerprints = new Map();
    for (const file of [...files, join(directory, 'empty.env')]) {
      if (pathKey(dirname(file)) !== pathKey(directory)) fail();
      await localPath(file, false);
      const contents = await readFile(file);
      if (contents.length > 4 * 1024 * 1024 || (file.endsWith('empty.env') && contents.length !== 0)) fail();
      fingerprints.set(file, digest(contents));
    }
    const compose = extra => ['compose', '--ansi', 'never', '-p', PROJECT, '--project-directory', directory,
      '--env-file', join(directory, 'empty.env'), ...[...files, ...extra].flatMap(file => ['-f', file])];
    const before = JSON.parse(await call([...compose([]), 'config', '--format', 'json'], 'COMPOSE_FAILED'));
    verifyApp(before, original, directory);
    if (Object.keys(before.services).some(key => !['photolocal', 'chat-browser'].includes(key))) fail();
    if (before.services['chat-browser']) {
      const previous = before.services['chat-browser'];
      const expected = buildChatBrowserOverride({ imageId: original.image, browserImageId: previous.image,
        disableSandbox: previous.environment?.CHAT_BROWSER_DISABLE_SANDBOX === 'true' });
      if (!isDeepStrictEqual(normalizeBrowser(previous), normalizeBrowser(expected.services['chat-browser'])) ||
          !isDeepStrictEqual(before.volumes?.chat_browser_profile, expected.volumes.chat_browser_profile)) fail();
    }
    const verifyProfile = async allowMissing => {
      const profile = await run('docker', ['volume', 'inspect', '--format', '{"labels":{{json .Labels}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}}}', PROFILE_VOLUME]);
      if (profile.code === 0) {
        const volume = JSON.parse(profile.stdout);
        if (volume.labels?.['com.docker.compose.project'] !== PROJECT || volume.labels?.['com.docker.compose.volume'] !== 'chat_browser_profile' ||
            volume.driver !== 'local' || volume.scope !== 'local' || (volume.options !== null && !isDeepStrictEqual(volume.options, {}))) fail('PROFILE_VOLUME_NOT_OWNED');
      } else if (!allowMissing || !/no such volume/i.test(profile.stderr)) fail('DOCKER_QUERY_FAILED');
    };
    await verifyProfile(true);
    const callback = new URL(decode(before.services.photolocal.environment.GOOGLE_CHAT_OAUTH_REDIRECT_URI));
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash) fail();
    phase = 'build';
    const unique = randomUUID().replaceAll('-', '');
    const mainTag = `photolocal:chat-browser-update-${unique}`;
    const browserTag = `photolocal-chat-browser:update-${unique}`;
    for (const [tag, context] of [[mainTag, staging], [browserTag, join(staging, 'docker', 'chat-browser')]]) {
      await call(['build', '-t', tag, '-f', join(context, 'Dockerfile'), context], 'BUILD_FAILED', 20 * 60 * 1000);
    }
    const mainImage = await call(['image', 'inspect', '--format', '{{.Id}}', mainTag], 'INVALID_IMAGE');
    const browserImage = await call(['image', 'inspect', '--format', '{{.Id}}', browserTag], 'INVALID_IMAGE');
    const override = buildChatBrowserOverride({ imageId: mainImage, browserImageId: browserImage, disableSandbox: input.disableSandbox ?? false });
    const overridePath = join(directory, `compose.chat-browser-${unique}.json`);
    await localPath(directory, true);
    const content = JSON.stringify(override, null, 2);
    await writeFile(overridePath, content, { flag: 'wx', mode: 0o600 });
    fingerprints.set(overridePath, digest(content));
    const args = compose([overridePath]);
    const after = JSON.parse(await call([...args, 'config', '--format', 'json'], 'COMPOSE_FAILED'));
    verifyChatBrowserMerge(before, after, override);
    const assertUnchanged = async () => {
      for (const [file, hash] of fingerprints) {
        await localPath(file, false);
        if (digest(await readFile(file)) !== hash) fail('ACTIVE_CONFIGURATION_CHANGED');
      }
      const current = await inspect('photolocal');
      if (current.id !== original.id || current.image !== original.image || !isDeepStrictEqual(current.labels, original.labels) ||
          !isDeepStrictEqual(current.mounts, original.mounts) || !isDeepStrictEqual(current.environment, original.environment)) fail('ACTIVE_CONFIGURATION_CHANGED');
      verifyApp(before, current, directory);
    };
    await assertUnchanged();
    phase = 'browser_start';
    await call([...args, 'up', '--no-deps', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'chat-browser'], 'BROWSER_START_FAILED', 150000);
    verifyBrowser(await inspect('chat-browser'), browserImage);
    await verifyProfile(false);
    await assertUnchanged();
    if (!input.prepareOnly) {
      rollbackReport = join(directory, `chat-browser-rollback-${unique}.json`);
      await writeFile(rollbackReport, JSON.stringify({ version: 1, status: 'CHAT_BROWSER_ROLLBACK_READY',
        stagingRoot: staging, runDirectory: directory, imageId: original.image, proposedImageId: mainImage,
        files: files.map(path => ({ path, hash: fingerprints.get(path) })), overridePath,
        overrideHash: fingerprints.get(overridePath) }, null, 2), { flag: 'wx', mode: 0o600 });
      phase = 'application_start';
      applicationMayHaveChanged = true;
      await call([...args, 'up', '--no-deps', '--force-recreate', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal'], 'APP_START_FAILED', 150000);
      const current = await inspect('photolocal');
      verifyApp(after, current, directory);
      if (current.image !== mainImage || current.labels['com.docker.compose.project.config_files'] !== [...files, overridePath].join(',') ||
          !isDeepStrictEqual(current.mounts, original.mounts)) fail('APP_VERIFICATION_FAILED');
    }
    return { status: input.prepareOnly ? 'CHAT_BROWSER_PREPARED' : 'CHAT_BROWSER_UPDATED',
      url: callback.origin, runDirectory: directory, overridePath, rollbackReport, sandboxEnabled: !input.disableSandbox,
      applicationUpdated: !input.prepareOnly };
  } catch (error) {
    const code = /^CHAT_BROWSER_UPDATE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION';
    throw Object.assign(new Error(code), { code, phase, applicationMayHaveChanged, rollbackReport });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 131072) fail();
    }
    process.stdout.write(`${JSON.stringify(await updateChatBrowser(JSON.parse(input)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'CHAT_BROWSER_UPDATE_FAILED',
      code: /^CHAT_BROWSER_UPDATE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION',
      phase: error.phase ?? 'preflight', applicationMayHaveChanged: error.applicationMayHaveChanged === true,
      rollbackReport: error.rollbackReport })}\n`);
    process.exitCode = 1;
  }
}
