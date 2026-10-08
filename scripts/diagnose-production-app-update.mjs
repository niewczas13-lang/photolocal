import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PROJECT = 'photolocal-production';
const SERVICE = 'photolocal';
const CONTAINER = '/photolocal-production-photolocal-1';
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const REPORT = /^app-update-rollback-[a-f0-9]{32}\.json$/;
const PROXY_KEYS = new Set(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'FTP_PROXY', 'ftp_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']);
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"environment":{{json .Config.Env}}}';
const IMAGE_INSPECT = '{"id":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"environment":{{json .Config.Env}}}';
const fail = () => { throw Object.assign(new Error('PRODUCTION_APP_DIAGNOSTIC_FAILED'), { code: 'PRODUCTION_APP_DIAGNOSTIC_FAILED' }); };
const key = value => {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const decode = value => String(value).replaceAll('$$', '$');
const hash = value => createHash('sha256').update(value).digest('hex');
const bindKey = value => key(value.replaceAll('\\', '/')
  .replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/'));
const validKey = value => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const entries = values => {
  if (!Array.isArray(values)) fail();
  const result = values.map(value => {
    if (typeof value !== 'string' || !value.includes('=')) fail();
    const equals = value.indexOf('=');
    const name = value.slice(0, equals);
    if (!validKey(name)) fail();
    return [name, value.slice(equals + 1)];
  });
  if (new Set(result.map(([name]) => name)).size !== result.length) fail();
  return Object.fromEntries(result);
};
async function localPath(value, directory) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[,\x00-\x1f]/.test(value) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..')) fail();
  const absolute = resolve(value);
  for (let current = absolute; current !== parse(current).root; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) fail();
  }
  const stat = await lstat(absolute);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || key(await realpath(absolute)) !== key(absolute)) fail();
  return absolute;
}
async function contents(path) {
  await localPath(path, false);
  const value = await readFile(path);
  if (value.length > 4 * 1024 * 1024) fail();
  return value;
}
function nativeRun(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000,
    maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true });
  return { code: result.status, stdout: result.stdout ?? '' };
}

/** Read-only diagnosis. Environment values and complete configurations stay in memory. */
export async function diagnoseProductionAppUpdate(input, { run = nativeRun } = {}) {
  try {
    if (input?.rollbackReport !== undefined && !isAbsolute(input.rollbackReport)) fail();
    const staging = await localPath(input?.stagingRoot, true);
    const call = async args => {
      const response = await run('docker', args);
      if (response.code !== 0 || typeof response.stdout !== 'string') fail();
      return response.stdout.trim();
    };
    const id = await call(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
      '--filter', `label=com.docker.compose.service=${SERVICE}`, '--format', '{{.ID}}', '--no-trunc']);
    if (!/^[a-f0-9]{64}$/.test(id)) fail();
    const app = JSON.parse(await call(['container', 'inspect', '--format', INSPECT, id]));
    if (app.id !== id || app.name !== CONTAINER || app.labels?.['com.docker.compose.project'] !== PROJECT ||
        app.labels?.['com.docker.compose.service'] !== SERVICE || !IMAGE.test(app.image)) fail();
    const directory = await localPath(app.labels['com.docker.compose.project.working_dir'], true);
    if (key(dirname(directory)) !== key(join(staging, 'docker-data')) || !/^production-[a-f0-9]{32}$/.test(basename(directory))) fail();
    let reportPath = input.rollbackReport;
    if (!reportPath) {
      const names = (await readdir(directory)).filter(name => REPORT.test(name));
      if (!names.length || names.length > 1000) fail();
      const candidates = await Promise.all(names.map(async name => {
        const path = await localPath(join(directory, name), false);
        return { path, time: (await lstat(path)).mtimeMs };
      }));
      reportPath = candidates.sort((a, b) => b.time - a.time || b.path.localeCompare(a.path))[0].path;
    }
    if (key(dirname(reportPath)) !== key(directory) || !REPORT.test(basename(reportPath))) fail();
    const report = JSON.parse(String(await contents(reportPath)));
    if (report.version !== 1 || key(report.runDirectory) !== key(directory) || !IMAGE.test(report.previousImageId) ||
        !IMAGE.test(report.imageId) || !/^[a-f0-9]{40}$/.test(report.revision) || !Array.isArray(report.files) ||
        !report.files.length || report.files.length > 64) fail();
    const files = report.files.map(entry => {
      if (typeof entry.path !== 'string' || key(dirname(entry.path)) !== key(directory) || !/^[a-f0-9]{64}$/.test(entry.hash)) fail();
      return entry.path;
    });
    if (new Set(files.map(key)).size !== files.length || key(files[0]) !== key(join(directory, 'compose.production.json')) ||
        key(dirname(report.overridePath)) !== key(directory) || !/^compose\.app-update-[a-f0-9]{32}\.json$/.test(basename(report.overridePath))) fail();
    const fileHashes = (await Promise.all(report.files.map(async entry => hash(await contents(entry.path)) === entry.hash))).every(Boolean);
    const override = JSON.parse(String(await contents(report.overridePath)));
    if (!isDeepStrictEqual(override, { services: { [SERVICE]: { image: report.imageId } } })) fail();
    if ((await contents(join(directory, 'empty.env'))).length !== 0) fail();
    const updatedFiles = [...files, report.overridePath];
    const compose = async selected => JSON.parse(await call(['compose', '--ansi', 'never', '-p', PROJECT,
      '--project-directory', directory, '--env-file', join(directory, 'empty.env'),
      ...selected.flatMap(file => ['-f', file]), 'config', '--format', 'json']));
    const before = await compose(files);
    const after = await compose(updatedFiles);
    const service = after.services?.[SERVICE];
    if (!service?.environment || typeof service.environment !== 'object' || Array.isArray(service.environment) ||
        Object.keys(service.environment).some(name => !validKey(name))) fail();
    const image = JSON.parse(await call(['image', 'inspect', '--format', IMAGE_INSPECT, report.imageId]));
    if (image.id !== report.imageId || (image.environment !== null && !Array.isArray(image.environment))) fail();
    const configured = Object.fromEntries(Object.entries(service.environment).map(([name, value]) => [name, decode(value)]));
    const expectedEnvironment = { ...entries(image.environment ?? []), ...configured };
    const actualEnvironment = entries(app.environment);
    const environment = {
      configuredMismatch: Object.keys(configured).filter(name => actualEnvironment[name] !== configured[name]).sort(),
      missing: Object.keys(expectedEnvironment).filter(name => !Object.hasOwn(actualEnvironment, name)).sort(),
      extra: Object.keys(actualEnvironment).filter(name => !Object.hasOwn(expectedEnvironment, name)).sort(),
      changed: Object.keys(expectedEnvironment).filter(name => Object.hasOwn(actualEnvironment, name) && actualEnvironment[name] !== expectedEnvironment[name]).sort(),
    };
    if (!Array.isArray(service.volumes) || !Array.isArray(app.mounts) ||
        new Set(service.volumes.map(mount => mount.target)).size !== service.volumes.length ||
        new Set(app.mounts.map(mount => mount.Destination)).size !== app.mounts.length) fail();
    const mounts = service.volumes.map(mount => {
      if (typeof mount.target !== 'string' || !/^\/[A-Za-z0-9_./-]{0,255}$/.test(mount.target)) fail();
      const actual = app.mounts.find(value => value.Destination === mount.target);
      const mode = typeof actual?.Mode === 'string' && actual.Mode.split(',').every(value =>
        ['', 'rw', 'ro', 'z', 'Z', 'cached', 'delegated', 'consistent'].includes(value)) ? actual.Mode : 'unknown';
      return { target: mount.target, type: ['bind', 'volume'].includes(actual?.Type) ? actual.Type : 'unknown', mode,
        propagation: ['rprivate', 'private', 'rshared', 'shared', 'rslave', 'slave', ''].includes(actual?.Propagation) ? actual.Propagation : 'unknown',
        typeMatches: actual?.Type === mount.type, readWriteMatches: actual?.RW === !Boolean(mount.read_only),
        sourceMatches: mount.type !== 'bind' || (typeof actual?.Source === 'string' && typeof mount.source === 'string' &&
          mount.bind?.create_host_path === false && bindKey(actual.Source) === bindKey(decode(mount.source))),
        nameMatches: mount.type !== 'volume' || (typeof after.volumes?.[mount.source]?.name === 'string' && actual?.Name === decode(after.volumes[mount.source].name)) };
    });
    const expectedConfig = structuredClone(before);
    if (!expectedConfig.services?.[SERVICE]) fail();
    expectedConfig.services[SERVICE].image = report.imageId;
    const actualFiles = app.labels['com.docker.compose.project.config_files']?.split(',');
    const finalApp = JSON.parse(await call(['container', 'inspect', '--format', INSPECT, id]));
    return { status: 'PRODUCTION_APP_UPDATE_DIAGNOSED', revision: report.revision, imageId: report.imageId,
      previousImageId: report.previousImageId, configFileCount: updatedFiles.length, rawMountBaselineAvailable: false,
      checks: { image: app.image === report.imageId && service.image === report.imageId,
        stableContainer: isDeepStrictEqual(app, finalApp),
        imageRevision: image.revision === report.revision, healthy: app.running === true && app.health === 'healthy',
        ports: isDeepStrictEqual(app.ports, { '4873/tcp': [{ HostIp: '0.0.0.0', HostPort: '4873' }] }),
        runDirectory: key(app.labels['com.docker.compose.project.working_dir']) === key(directory),
        configFilesExact: app.labels['com.docker.compose.project.config_files'] === updatedFiles.join(','),
        configFilesCanonical: Array.isArray(actualFiles) && isDeepStrictEqual(actualFiles.map(key), updatedFiles.map(key)),
        fileHashes, composeOnlyImage: before.name === PROJECT && after.name === PROJECT && isDeepStrictEqual(after, expectedConfig),
        configuredEnvironment: environment.configuredMismatch.length === 0,
        fullEnvironment: !environment.missing.length && !environment.extra.length && !environment.changed.length,
        mounts: app.mounts.length === mounts.length && mounts.every(mount => mount.typeMatches && mount.readWriteMatches && mount.sourceMatches && mount.nameMatches) },
      environment, unexpectedEnvironmentKeys: environment.extra,
      unexpectedKeysAreDockerProxyDefaults: environment.extra.length > 0 && environment.extra.every(name => PROXY_KEYS.has(name)), mounts };
  } catch { fail(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await diagnoseProductionAppUpdate({
      stagingRoot: dirname(dirname(fileURLToPath(import.meta.url))), rollbackReport: process.argv[2],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ status: 'PRODUCTION_APP_DIAGNOSTIC_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
