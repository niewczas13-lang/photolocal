import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { snapshotDatabase } from './snapshot-staging-database.mjs';
import { invokeDocker } from './test-smb-access.mjs';

const IMAGE = 'photolocal:staging';
const VOLUME = /^photolocal-staging-nas-[a-f0-9]+$/;
const slash = value => value.replaceAll('\\', '/');
const literal = value => value.replaceAll('$', () => '$$');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const inside = (candidate, root) => {
  const difference = win32.relative(root, candidate);
  return difference === '' || (!difference.startsWith('..\\') && difference !== '..' && !win32.isAbsolute(difference));
};
function fail(code, details = {}) { throw Object.assign(new Error(code), { code, ...details }); }

export function buildCopyConfiguration({ productionRoot, stagingRoot, runDirectory, networkPrefix, storage }) {
  if (!storage || storage.version !== 1 || storage.containerPath !== '/nas' || !VOLUME.test(storage.volumeName) ||
      typeof storage.subdirectory !== 'string' || /[\\:\x00-\x1f]/.test(storage.subdirectory) ||
      storage.subdirectory.split('/').some(part => ['', '.', '..'].includes(part)) ||
      typeof networkPrefix !== 'string' || !/^[a-z]:[\\/]/i.test(networkPrefix) ||
      networkPrefix.split(/[\\/]/).some(part => part === '..' || part === '.') ||
      ![productionRoot, stagingRoot, runDirectory].every(value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[,\x00-\x1f]/.test(value)) ||
      inside(stagingRoot, productionRoot) || inside(productionRoot, stagingRoot) ||
      !inside(runDirectory, win32.join(stagingRoot, 'docker-data')) || same(runDirectory, win32.join(stagingRoot, 'docker-data'))) {
    fail('INVALID_CONFIGURATION');
  }
  const localPhotos = win32.join(productionRoot, 'backend', 'zdjęcia');
  const legacyDownloads = win32.join(productionRoot, 'pobierzchat', 'pobrane_zdjecia');
  const nasRoot = `/nas/${storage.subdirectory}`;
  const bind = (source, target, readOnly = false) => ({
    type: 'bind', source: literal(slash(source)), target, read_only: readOnly, bind: { create_host_path: false },
  });
  return {
    mapping: [
      { from: win32.normalize(networkPrefix), to: nasRoot },
      { from: localPhotos, to: '/legacy-local-photos' },
      { from: legacyDownloads, to: '/legacy-downloads' },
    ],
    override: {
      services: { photolocal: {
        environment: { PHOTO_LOCAL_SHARED_ROOTS: literal(JSON.stringify([
          { path: '/photos', label: 'Test staging' }, { path: nasRoot, label: 'NAS (odczyt)' },
        ])) },
        volumes: [
          bind(win32.join(runDirectory, 'data'), '/data'),
          { type: 'volume', source: 'staging_nas', target: '/nas', read_only: true, volume: { nocopy: true } },
          bind(localPhotos, '/legacy-local-photos', true),
          bind(legacyDownloads, '/legacy-downloads', true),
        ],
      } },
      volumes: { staging_nas: { external: true, name: storage.volumeName } },
    },
  };
}

/** Fail before starting any service if merge rules or local settings broaden staging access. */
export function verifyResolvedConfiguration(config, { stagingRoot, productionRoot, runDirectory, storage }) {
  const app = config?.services?.photolocal;
  if (config?.name !== 'photolocal-staging' || Object.keys(config.services).length !== 1 || app?.image !== IMAGE ||
      app.ports?.length !== 1 || app.ports[0].host_ip !== '127.0.0.1' ||
      String(app.ports[0].published) !== '4874' || Number(app.ports[0].target) !== 4873 ||
      app.volumes?.length !== 7) fail('UNSAFE_STAGING_CONFIGURATION');
  const targets = new Set(app.volumes.map(mount => mount.target));
  if (targets.size !== 7) fail('UNSAFE_STAGING_CONFIGURATION');
  for (const [target, expected, readOnly] of [
    ['/data', win32.join(runDirectory, 'data'), false],
    ['/legacy-local-photos', win32.join(productionRoot, 'backend', 'zdjęcia'), true],
    ['/legacy-downloads', win32.join(productionRoot, 'pobierzchat', 'pobrane_zdjecia'), true],
  ]) {
    const mount = app.volumes.find(value => value.target === target);
    if (mount?.type !== 'bind' || !same(mount.source, expected) || Boolean(mount.read_only) !== readOnly) fail('UNSAFE_STAGING_CONFIGURATION');
  }
  for (const target of ['/google', '/photos', '/downloads']) {
    const mount = app.volumes.find(value => value.target === target);
    if (mount?.type !== 'bind' || !inside(mount.source, win32.join(stagingRoot, 'docker-data')) || mount.read_only) fail('UNSAFE_STAGING_CONFIGURATION');
  }
  const nas = app.volumes.find(value => value.target === '/nas');
  if (nas?.type !== 'volume' || nas.source !== 'staging_nas' || nas.read_only !== true || nas.volume?.nocopy !== true ||
      config.volumes?.staging_nas?.external !== true || config.volumes.staging_nas.name !== storage.volumeName) fail('UNSAFE_STAGING_CONFIGURATION');
}

async function absent(path, code) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail(code);
}

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(path), path)) fail('DIRECTORY_UNAVAILABLE');
}

function composeArgs(stagingRoot, composeFile) {
  return ['compose', '--ansi', 'never', '-p', 'photolocal-staging', '--project-directory', stagingRoot,
    '--env-file', join(stagingRoot, '.env.docker'), '-f', join(stagingRoot, 'compose.yaml'), '-f', composeFile];
}

export async function prepareStagingCopy({ productionRoot, stagingRoot, networkPrefix }, {
  snapshot = snapshotDatabase, invoke = invokeDocker,
} = {}) {
  if (process.platform !== 'win32') fail('WINDOWS_RUNTIME_REQUIRED');
  productionRoot = resolve(productionRoot);
  stagingRoot = resolve(stagingRoot);
  const manifestPath = join(stagingRoot, 'docker-data', 'staging-copy.json');
  await absent(manifestPath, 'COPY_ALREADY_PREPARED');
  const storage = JSON.parse(await readFile(join(stagingRoot, 'docker-data', 'storage.json'), 'utf8'));
  // Validate all paths before creating any copy or Docker resource.
  buildCopyConfiguration({ productionRoot, stagingRoot, networkPrefix, storage, runDirectory: join(stagingRoot, 'docker-data', 'preflight') });
  for (const path of [productionRoot, stagingRoot, join(stagingRoot, 'docker-data'),
    join(productionRoot, 'backend', 'zdjęcia'), join(productionRoot, 'pobierzchat', 'pobrane_zdjecia')]) await directory(path);
  await readFile(join(stagingRoot, '.env.docker')); // Missing settings must fail before snapshot creation.
  const runDirectory = await mkdtemp(join(stagingRoot, 'docker-data', 'migration-'));
  try {
    const dataDirectory = join(runDirectory, 'data');
    await mkdir(dataDirectory);
    const configuration = { productionRoot, stagingRoot, runDirectory, networkPrefix, storage };
    const { mapping, override } = buildCopyConfiguration(configuration);
    const composeFile = join(runDirectory, 'compose.staging-copy.json');
    await writeFile(composeFile, JSON.stringify(override, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(join(runDirectory, 'mapping.json'), JSON.stringify(mapping), { flag: 'wx', mode: 0o600 });
    let result = await invoke([...composeArgs(stagingRoot, composeFile), 'config', '--format', 'json'], '', 30_000);
    if (result.code !== 0 || result.timedOut) fail('COMPOSE_VALIDATION_FAILED');
    let resolved;
    try { resolved = JSON.parse(result.stdout); } catch { fail('COMPOSE_VALIDATION_FAILED'); }
    verifyResolvedConfiguration(resolved, configuration);
    // Catch junctions in writable staging mounts as well as lexical escapes.
    for (const mount of resolved.services.photolocal.volumes.filter(m => m.type === 'bind' && !m.read_only)) await directory(mount.source);
    const source = join(productionRoot, 'backend', 'data', 'photo-local.sqlite');
    const snapshotReport = await snapshot({ source, output: join(runDirectory, 'source.sqlite'), runtimeRoot: join(productionRoot, 'backend') });
    await writeFile(join(runDirectory, 'snapshot.json'), JSON.stringify(snapshotReport, null, 2), { flag: 'wx', mode: 0o600 });

    async function isolatedRun(suffix, args, timeout) {
      const name = `photolocal-staging-${suffix}-${randomUUID().replaceAll('-', '')}`;
      await writeFile(join(runDirectory, `container-${suffix}.json`), JSON.stringify({ containerName: name }), { flag: 'wx', mode: 0o600 });
      let response;
      try {
        response = await invoke(['run', '--name', name, '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none', ...args], '', timeout);
      } finally {
        const cleanup = await invoke(['container', 'rm', '--force', name], '', 30_000);
        if (cleanup.timedOut || (cleanup.code !== 0 && !(cleanup.code === 1 && /no such container/i.test(cleanup.stderr)))) fail('TEMPORARY_CONTAINER_CLEANUP_REQUIRED', { containerName: name });
      }
      if (response.timedOut || response.code === null) fail('STAGING_COPY_OPERATION_TIMEOUT', { containerName: name });
      return response;
    }

    result = await isolatedRun('migrate', [
      '--mount', `type=bind,source=${runDirectory},target=/migration`, '--entrypoint', 'node', IMAGE,
      '/app/scripts/migrate-docker-data.mjs', '--source', '/migration/source.sqlite',
      '--output', '/migration/data/photo-local.sqlite', '--mapping', '/migration/mapping.json',
    ], 120_000);
    if (result.code !== 0) fail('DATABASE_MIGRATION_FAILED');
    const auditScript = join(dirname(fileURLToPath(import.meta.url)), 'audit-staging-copy.mjs');
    result = await isolatedRun('audit', [
      '--mount', `type=bind,source=${dataDirectory},target=/data,readonly`,
      '--mount', `type=volume,source=${storage.volumeName},target=/nas,readonly,volume-nocopy`,
      '--mount', `type=bind,source=${join(productionRoot, 'backend', 'zdjęcia')},target=/legacy-local-photos,readonly`,
      '--mount', `type=bind,source=${join(productionRoot, 'pobierzchat', 'pobrane_zdjecia')},target=/legacy-downloads,readonly`,
      '--mount', `type=bind,source=${auditScript},target=/app/scripts/audit-staging-copy.mjs,readonly`,
      '--entrypoint', 'node', IMAGE, '/app/scripts/audit-staging-copy.mjs', '--database', '/data/photo-local.sqlite',
    ], 180_000);
    let audit;
    try { audit = JSON.parse(result.stdout); } catch { fail('STAGING_COPY_AUDIT_FAILED'); }
    await writeFile(join(runDirectory, 'audit.json'), JSON.stringify(audit, null, 2), { flag: 'wx', mode: 0o600 });
    if (result.code !== 0 || audit.status !== 'STAGING_COPY_VERIFIED') {
      const status = ['STAGING_COPY_FILES_MISSING', 'STAGING_COPY_INVALID_DATABASE'].includes(audit.status) ? audit.status : 'STAGING_COPY_AUDIT_FAILED';
      fail(status);
    }
    if (Object.entries(snapshotReport.counts).some(([table, count]) => audit.counts?.[table] !== count)) fail('STAGING_COPY_COUNTS_MISMATCH');
    const report = {
      status: 'STAGING_COPY_READY', version: 1, composeFile, runDirectory, counts: audit.counts,
      projectFolders: audit.projectFolders, photoSamples: audit.photoSamples,
    };
    await writeFile(manifestPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    error.runDirectory = runDirectory;
    throw error;
  }
}

/** Start only the verified loopback staging service, retaining raw Docker errors privately. */
export async function startPreparedCopy(report, stagingRoot, { invoke = invokeDocker } = {}) {
  if (report?.status !== 'STAGING_COPY_READY' || typeof report.composeFile !== 'string' ||
      !inside(report.composeFile, win32.join(stagingRoot, 'docker-data')) ||
      win32.basename(report.composeFile) !== 'compose.staging-copy.json') fail('COPY_NOT_VERIFIED');
  const result = await invoke([...composeArgs(stagingRoot, report.composeFile),
    'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal'], '', 150_000);
  if (result.code !== 0 || result.timedOut) fail('STAGING_START_FAILED', { runDirectory: win32.dirname(report.composeFile) });
  return { ...report, status: 'STAGING_COPY_RUNNING', url: 'http://localhost:4874' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      'production-root': { type: 'string' }, 'staging-root': { type: 'string' }, 'network-prefix': { type: 'string' }, start: { type: 'boolean' },
    } });
    if (!values['production-root'] || !values['staging-root'] || !values['network-prefix']) fail('INVALID_CONFIGURATION');
    let report = await prepareStagingCopy({ productionRoot: values['production-root'], stagingRoot: values['staging-root'], networkPrefix: values['network-prefix'] });
    if (values.start) report = await startPreparedCopy(report, values['staging-root']);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'STAGING_COPY_PREPARATION_FAILED';
    const report = { status: code };
    if (typeof error.runDirectory === 'string') report.runDirectory = error.runDirectory;
    if (typeof error.containerName === 'string' && /^photolocal-staging-(migrate|audit)-[a-f0-9]{32}$/.test(error.containerName)) report.containerName = error.containerName;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 1;
  }
}
