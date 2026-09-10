import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { inspectSourceDatabase, inventoryLocalTree, resolveSourceEnvironment } from './prepare-production-deployment.mjs';
import { buildProductionConfiguration, verifyResolvedProductionConfiguration } from './production-deployment-config.mjs';
import { snapshotDatabase } from './snapshot-staging-database.mjs';
import { invokeDocker } from './test-smb-access.mjs';

const TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const CONTAINER = /^photolocal-production-(preflight|final)-(migrate|audit)-[a-f0-9]{32}$/;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
function fail(code, fields = {}) { throw Object.assign(new Error(code), { code, ...fields }); }
function inside(path, root) {
  const relative = win32.relative(root, path);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}
function safeError(error) {
  const candidate = error?.code;
  const code = typeof candidate === 'string' && /^(CUTOVER_|LOCAL_COPY_|LOCAL_STORAGE_|SOURCE_|SNAPSHOT_)[A-Z_]+$/.test(candidate)
    ? candidate : ['INSUFFICIENT_DISK_SPACE', 'DOCKER_IMAGE_UNAVAILABLE', 'PRODUCTION_COMPOSE_INVALID'].includes(candidate)
      ? candidate : 'CUTOVER_OPERATION_FAILED';
  return Object.assign(new Error(code), { code }, CONTAINER.test(error?.containerName) ? { containerName: error.containerName } : {});
}
async function plain(path, file = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !(file ? info.isFile() : info.isDirectory()) || !same(await realpath(path), resolve(path))) fail('CUTOVER_PREPARATION_INVALID');
  return info;
}
async function small(path) {
  if ((await plain(path, true)).size > 4 * 1024 * 1024) fail('CUTOVER_PREPARATION_INVALID');
  return readFile(path);
}
async function json(path) { return JSON.parse((await small(path)).toString('utf8')); }
async function absent(path, code = 'CUTOVER_ALREADY_ATTEMPTED') {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail(code);
}
async function publish(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function progress(runDirectory, phase, counters = {}) {
  const report = { version: 1, phase, updatedUtc: new Date().toISOString() };
  for (const key of ['files', 'bytes', 'totalFiles', 'totalBytes']) {
    if (Number.isSafeInteger(counters[key]) && counters[key] >= 0) report[key] = counters[key];
  }
  const temporary = join(runDirectory, `.cutover-progress-${randomUUID()}.tmp`);
  let owned = false;
  try {
    await writeFile(temporary, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    owned = true;
    await rename(temporary, join(runDirectory, 'cutover-progress.json'));
    owned = false;
  } finally { if (owned) await unlink(temporary); }
}
async function freeBytes(path) { const info = await statfs(path); return info.bavail * info.bsize; }
async function sourceMetadata(path) {
  const result = {};
  for (const suffix of ['', '-wal', '-journal']) {
    try {
      await plain(path + suffix, true);
      const info = await lstat(path + suffix, { bigint: true });
      result[suffix || 'database'] = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]));
    } catch (error) { if (error.code !== 'ENOENT' || suffix === '') throw error; result[suffix] = null; }
  }
  return result;
}
function matchingCounts(expected, actual) {
  if (TABLES.some(key => !Number.isSafeInteger(expected?.[key]) || expected[key] < 0 || expected[key] !== actual?.[key]) || expected.projects === 0) fail('CUTOVER_COUNTS_MISMATCH');
}
function failureKey(value) { return JSON.stringify([value.kind, value.projectId, value.photoId, value.path, value.reason]); }
function auditGaps(audit, expectedCounts) {
  matchingCounts(expectedCounts, audit?.counts);
  if (!['STAGING_COPY_VERIFIED', 'STAGING_COPY_FILES_MISSING'].includes(audit.status) ||
      !Array.isArray(audit.failures) || audit.failuresTruncated !== 0) fail('CUTOVER_AUDIT_INVALID');
  for (const [group, yes, no] of [['projectFolders', 'accessible', 'missing'], ['photoSamples', 'readable', 'unreadable']]) {
    const values = audit[group];
    if (!values || ['checked', yes, no].some(key => !Number.isSafeInteger(values[key]) || values[key] < 0) ||
        values.checked !== values[yes] + values[no]) fail('CUTOVER_AUDIT_INVALID');
  }
  if (audit.projectFolders.checked !== expectedCounts.projects || !audit.projectFolders.accessible ||
      (expectedCounts.photos > 0 && !audit.photoSamples.readable)) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
  const keys = new Set();
  for (const value of audit.failures) {
    if (!value || !['project_folder', 'photo'].includes(value.kind) || typeof value.projectId !== 'string' ||
        !value.projectId || (value.kind === 'photo' ? typeof value.photoId !== 'string' || !value.photoId : value.photoId !== null) ||
        value.reason !== 'ENOENT' || typeof value.path !== 'string' || !value.path.startsWith('/nas/') ||
        value.path.includes('\\') || /[\x00-\x1f]/.test(value.path) || value.path !== posix.normalize(value.path) ||
        value.path.split('/').some(part => part === '.' || part === '..')) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
    const key = failureKey(value);
    if (keys.has(key)) fail('CUTOVER_AUDIT_INVALID');
    keys.add(key);
  }
  if (audit.failures.length !== audit.projectFolders.missing + audit.photoSamples.unreadable ||
      audit.failures.filter(value => value.kind === 'project_folder').length !== audit.projectFolders.missing ||
      (audit.status === 'STAGING_COPY_VERIFIED') !== (audit.failures.length === 0)) fail('CUTOVER_AUDIT_INVALID');
  return { projectFolders: audit.projectFolders.missing, photoSamples: audit.photoSamples.unreadable };
}
function failuresOnly(audit) {
  return audit.failures.map(({ kind, projectId, photoId, path, reason }) => ({ kind, projectId, photoId, path, reason }));
}
async function acceptedPreview(manifest, currentAudit) {
  if (currentAudit.failures.length === 0) return;
  try {
    const dataRoot = join(manifest.stagingRoot, 'docker-data');
    const preview = await json(join(dataRoot, 'staging-preview.json'));
    if (preview.version !== 1 || preview.status !== 'PREVIEW_READY' || preview.failuresTruncated !== 0 ||
        typeof preview.runDirectory !== 'string' || !same(dirname(preview.runDirectory), dataRoot) ||
        !/^migration-[a-zA-Z0-9_-]+$/.test(win32.basename(preview.runDirectory)) ||
        typeof preview.diagnosisReportPath !== 'string' || !same(dirname(preview.diagnosisReportPath), preview.runDirectory)) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
    await plain(preview.runDirectory);
    const mapping = await json(join(preview.runDirectory, 'mapping.json'));
    const nasMapping = Array.isArray(mapping) && mapping.find(value => value.to === `/nas/${manifest.storage.subdirectory}`);
    if (!nasMapping || !same(nasMapping.from, manifest.networkPrefix)) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
    const diagnosis = await json(preview.diagnosisReportPath);
    auditGaps(diagnosis.audit, preview.counts);
    if (!Array.isArray(preview.locations) || !isDeepStrictEqual(preview.locations.map(failureKey).sort(), diagnosis.audit.failures.map(failureKey).sort())) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
    const accepted = new Set(preview.locations.map(failureKey));
    if (currentAudit.failures.some(value => !accepted.has(failureKey(value)))) fail('CUTOVER_UNACCEPTED_STORAGE_GAPS');
  } catch { fail('CUTOVER_UNACCEPTED_STORAGE_GAPS'); }
}

async function validatePrepared(input, deps) {
  if (process.platform !== 'win32' || typeof input?.runDirectory !== 'string' ||
      !/^[a-z]:[\\/]/i.test(input.runDirectory) || /[,\x00-\x1f]/.test(input.runDirectory) ||
      input.runDirectory.split(/[\\/]/).some(part => part === '.' || part === '..') ||
      !/^production-[a-f0-9]{32}$/.test(win32.basename(input.runDirectory))) fail('CUTOVER_INPUT_INVALID');
  const runDirectory = resolve(input.runDirectory);
  await plain(runDirectory);
  const manifestBytes = await small(join(runDirectory, 'production-preparation.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== 1 || manifest.status !== 'PRODUCTION_CONFIG_PREPARED' || !same(manifest.runDirectory, runDirectory) ||
      !same(manifest.composeFile, join(runDirectory, 'compose.production.json')) ||
      !same(manifest.mappingFile, join(runDirectory, 'mapping.json')) ||
      !same(manifest.emptyEnvironmentFile, join(runDirectory, 'empty.env'))) fail('CUTOVER_PREPARATION_INVALID');
  // The pure builder checks lexical root separation before any manifest-selected file is opened.
  buildProductionConfiguration({ ...manifest, sourceEnvironment: {} });
  for (const path of [manifest.productionRoot, manifest.stagingRoot, join(manifest.stagingRoot, 'docker-data')]) await plain(path);
  const environmentBytes = await small(join(manifest.productionRoot, '.env'));
  const parse = deps.parseDotenv ?? createRequire(join(manifest.productionRoot, 'backend', 'package.json'))('dotenv').parse;
  const sourceEnvironment = resolveSourceEnvironment(parse(environmentBytes.toString('utf8')), input.environmentScopes);
  if (sourceEnvironment.GOOGLE_CHAT_DOWNLOAD_ROOT) fail('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED');
  const storageBytes = await small(join(manifest.stagingRoot, 'docker-data', 'production-storage.json'));
  const storage = JSON.parse(storageBytes.toString('utf8'));
  const configurationInput = { ...manifest, sourceEnvironment, storage };
  const configuration = buildProductionConfiguration(configurationInput);
  const composeBytes = await small(manifest.composeFile);
  const mappingBytes = await small(manifest.mappingFile);
  const clientBytes = await small(join(runDirectory, 'google', 'credentials.json'));
  await small(join(runDirectory, 'google', 'token.json'));
  if (!inside(manifest.googleSource, join(manifest.stagingRoot, 'docker-data'))) fail('CUTOVER_PREPARATION_INVALID');
  await plain(manifest.googleSource);
  const originalClientBytes = await small(join(manifest.googleSource, 'credentials.json'));
  const hashes = { sourceEnvironment: hash(environmentBytes), storage: hash(storageBytes), compose: hash(composeBytes),
    mapping: hash(mappingBytes), googleClient: hash(clientBytes) };
  if (!isDeepStrictEqual(hashes, manifest.hashes) || hash(originalClientBytes) !== hashes.googleClient ||
      !isDeepStrictEqual(configuration.source, manifest.source) || !isDeepStrictEqual(storage, manifest.storage) ||
      !isDeepStrictEqual(configuration.compose, JSON.parse(composeBytes.toString('utf8'))) ||
      !isDeepStrictEqual(configuration.mapping, JSON.parse(mappingBytes.toString('utf8'))) ||
      (await small(manifest.emptyEnvironmentFile)).length !== 0) fail('CUTOVER_PREPARATION_CHANGED');
  for (const directory of ['data', 'downloads', 'local-photos', 'photos']) {
    const path = join(runDirectory, directory);
    await plain(path);
    if ((await readdir(path)).length) fail('CUTOVER_DESTINATION_NOT_EMPTY');
  }
  await absent(join(runDirectory, 'final-copy.json'));
  const invoke = deps.invoke ?? invokeDocker;
  const image = await invoke(['image', 'inspect', '--format', '{{.Id}}', manifest.imageId], '', 30_000);
  if (image.timedOut || image.code !== 0 || image.stdout.trim() !== manifest.imageId) fail('DOCKER_IMAGE_UNAVAILABLE');
  const volume = await invoke(['volume', 'inspect', '--format', '{{.Name}}', storage.volumeName], '', 30_000);
  if (volume.timedOut || volume.code !== 0 || volume.stdout.trim() !== storage.volumeName) fail('CUTOVER_PREPARATION_CHANGED');
  const rendered = await invoke(['compose', '--ansi', 'never', '-p', 'photolocal-production', '--project-directory', runDirectory,
    '--env-file', manifest.emptyEnvironmentFile, '-f', manifest.composeFile, 'config', '--format', 'json'], '', 30_000);
  try {
    if (rendered.code !== 0 || rendered.timedOut) throw new Error();
    verifyResolvedProductionConfiguration(JSON.parse(rendered.stdout), configurationInput);
  } catch { fail('PRODUCTION_COMPOSE_INVALID'); }
  return { manifest, configuration, hashes, preparedManifestHash: hash(manifestBytes), invoke, runDirectory };
}

async function checkDisk(context, deps, baseline) {
  const source = context.configuration.source;
  const localFiles = { downloads: await inventoryLocalTree(source.downloadsPath), localPhotos: await inventoryLocalTree(source.localPhotosPath) };
  const metadata = await sourceMetadata(source.databasePath);
  const databaseBytes = Object.values(metadata).filter(Boolean).reduce((sum, info) => sum + Number(info.size), 0);
  const requiredFreeBytes = localFiles.downloads.bytes + localFiles.localPhotos.bytes + databaseBytes * (baseline ? 6 : 4) + 1024 ** 3;
  const availableFreeBytes = await (deps.getFreeBytes ?? freeBytes)(context.runDirectory);
  if (!Number.isSafeInteger(requiredFreeBytes) || !Number.isSafeInteger(availableFreeBytes) || availableFreeBytes < requiredFreeBytes) fail('INSUFFICIENT_DISK_SPACE');
  return { localFiles, requiredFreeBytes, availableFreeBytes };
}
async function isolated(context, stage, kind, args, timeout) {
  const containerName = `photolocal-production-${stage}-${kind}-${randomUUID().replaceAll('-', '')}`;
  await publish(join(context.runDirectory, `container-${stage}-${kind}.json`), { containerName });
  let result;
  try {
    result = await context.invoke(['run', '--name', containerName, '--rm', '--pull', 'never', '--network', 'none',
      '--read-only', '--log-driver', 'none', ...args], '', timeout);
  } finally {
    let cleaned;
    try { cleaned = await context.invoke(['container', 'rm', '--force', containerName], '', 30_000); } catch { /* Report only its generated name. */ }
    if (!cleaned || cleaned.timedOut || (cleaned.code !== 0 && !(cleaned.code === 1 && /no such container/i.test(cleaned.stderr)))) fail('CUTOVER_CONTAINER_CLEANUP_REQUIRED', { containerName });
  }
  if (!result || result.timedOut || result.code === null) fail('CUTOVER_PROBE_TIMEOUT', { containerName });
  return result;
}
async function migrate(context, stage, sourceFile, dataDirectory) {
  const result = await isolated(context, stage, 'migrate', [
    '--mount', `type=bind,source=${sourceFile},target=/source.sqlite,readonly`,
    '--mount', `type=bind,source=${dataDirectory},target=/data`,
    '--mount', `type=bind,source=${context.manifest.mappingFile},target=/mapping.json,readonly`,
    '--entrypoint', 'node', context.manifest.imageId, '/app/scripts/migrate-docker-data.mjs',
    '--source', '/source.sqlite', '--output', '/data/photo-local.sqlite', '--mapping', '/mapping.json',
  ], 180_000);
  if (result.code !== 0) fail('CUTOVER_MIGRATION_FAILED');
  await plain(join(dataDirectory, 'photo-local.sqlite'), true);
}
async function auditCopy(context, stage, dataDirectory, localPaths) {
  const auditScript = join(SCRIPT_DIRECTORY, 'audit-staging-copy.mjs');
  await plain(auditScript, true);
  const result = await isolated(context, stage, 'audit', [
    '--mount', `type=bind,source=${dataDirectory},target=/data,readonly`,
    '--mount', `type=volume,source=${context.manifest.storage.volumeName},target=/nas,readonly,volume-nocopy`,
    '--mount', `type=bind,source=${localPaths.downloadsPath},target=/downloads,readonly`,
    '--mount', `type=bind,source=${localPaths.localPhotosPath},target=/legacy-local-photos,readonly`,
    '--mount', `type=bind,source=${join(context.runDirectory, 'photos')},target=/photos,readonly`,
    '--mount', `type=bind,source=${auditScript},target=/app/scripts/audit-staging-copy.mjs,readonly`,
    '--entrypoint', 'node', context.manifest.imageId, '/app/scripts/audit-staging-copy.mjs', '--database', '/data/photo-local.sqlite', '--details',
  ], 180_000);
  let audit;
  try { audit = JSON.parse(result.stdout); } catch { fail('CUTOVER_AUDIT_INVALID'); }
  if (!((result.code === 0 && audit.status === 'STAGING_COPY_VERIFIED') ||
      (result.code === 1 && audit.status === 'STAGING_COPY_FILES_MISSING'))) fail('CUTOVER_AUDIT_INVALID');
  await publish(join(context.runDirectory, stage === 'preflight' ? 'preflight-audit.json' : 'final-audit.json'), audit);
  return audit;
}
async function takeSnapshot(context, deps, output, reportFile) {
  const snapshot = await (deps.snapshot ?? snapshotDatabase)({ source: context.configuration.source.databasePath,
    output, runtimeRoot: join(context.manifest.productionRoot, 'backend') });
  if (snapshot?.status !== 'SNAPSHOT_OK' || !same(snapshot.output, output)) fail('CUTOVER_COUNTS_MISMATCH');
  matchingCounts(snapshot.counts, snapshot.counts);
  await plain(output, true);
  await publish(join(context.runDirectory, reportFile), snapshot);
  return snapshot;
}
function reportBase(context) {
  const { productionRoot, stagingRoot, imageId, publicUrl, composeFile, emptyEnvironmentFile } = context.manifest;
  return { version: 1, runDirectory: context.runDirectory, productionRoot, stagingRoot, imageId, publicUrl, composeFile, emptyEnvironmentFile };
}

export async function preflightProductionCutover(input, deps = {}) {
  try {
    const context = await validatePrepared(input, deps);
    for (const name of ['preflight-source.sqlite', 'preflight-data', 'cutover-preflight.json', 'cutover-preflight-attempt.json', 'preflight-snapshot.json',
      'preflight-audit.json', 'source.sqlite', 'native-stopped.json', 'container-preflight-migrate.json', 'container-preflight-audit.json']) await absent(join(context.runDirectory, name));
    const disk = await checkDisk(context, deps, true);
    await publish(join(context.runDirectory, 'cutover-preflight-attempt.json'), { version: 1, createdUtc: new Date().toISOString() });
    await progress(context.runDirectory, 'snapshot');
    const sourceFile = join(context.runDirectory, 'preflight-source.sqlite');
    const snapshot = await takeSnapshot(context, deps, sourceFile, 'preflight-snapshot.json');
    const dataDirectory = join(context.runDirectory, 'preflight-data');
    await mkdir(dataDirectory, { mode: 0o700 });
    await progress(context.runDirectory, 'migrate');
    await migrate(context, 'preflight', sourceFile, dataDirectory);
    await progress(context.runDirectory, 'audit');
    const audit = await auditCopy(context, 'preflight', dataDirectory, context.configuration.source);
    const nasGaps = auditGaps(audit, snapshot.counts);
    await acceptedPreview(context.manifest, audit);
    const report = { ...reportBase(context), status: 'CUTOVER_PREFLIGHT_OK', counts: snapshot.counts, nasGaps,
      createdUtc: new Date().toISOString(), preparedManifestHash: context.preparedManifestHash, hashes: context.hashes,
      auditHash: hash(await small(join(context.runDirectory, 'preflight-audit.json'))),
      baselineFailures: failuresOnly(audit), ...disk };
    await publish(join(context.runDirectory, 'cutover-preflight.json'), report);
    return { ...reportBase(context), status: report.status, counts: report.counts, nasGaps,
      requiredFreeBytes: disk.requiredFreeBytes, availableFreeBytes: disk.availableFreeBytes };
  } catch (error) { throw safeError(error); }
}

export async function finalizeProductionData(input, deps = {}) {
  try {
    const context = await validatePrepared(input, deps);
    let baseline;
    try { baseline = await json(join(context.runDirectory, 'cutover-preflight.json')); } catch { fail('CUTOVER_PREFLIGHT_REQUIRED'); }
    if (baseline.version !== 1 || baseline.status !== 'CUTOVER_PREFLIGHT_OK' || !same(baseline.runDirectory, context.runDirectory) ||
        baseline.preparedManifestHash !== context.preparedManifestHash || !isDeepStrictEqual(baseline.hashes, context.hashes)) fail('CUTOVER_PREFLIGHT_REQUIRED');
    const baselineBytes = await small(join(context.runDirectory, 'preflight-audit.json'));
    const baselineAudit = JSON.parse(baselineBytes.toString('utf8'));
    auditGaps(baselineAudit, baseline.counts);
    if (hash(baselineBytes) !== baseline.auditHash || !isDeepStrictEqual(failuresOnly(baselineAudit), baseline.baselineFailures)) fail('CUTOVER_PREFLIGHT_REQUIRED');
    let stopped;
    try { stopped = await json(join(context.runDirectory, 'native-stopped.json')); } catch { fail('CUTOVER_NATIVE_STOP_REQUIRED'); }
    if (stopped.version !== 1 || stopped.sourceStopped !== true || !same(stopped.productionRoot, context.manifest.productionRoot)) fail('CUTOVER_NATIVE_STOP_REQUIRED');
    for (const name of ['source.sqlite', 'snapshot.json', 'final-audit.json', 'container-final-migrate.json', 'container-final-audit.json']) await absent(join(context.runDirectory, name));
    await checkDisk(context, deps, false);
    const databasePath = context.configuration.source.databasePath;
    const before = await sourceMetadata(databasePath);
    await progress(context.runDirectory, 'snapshot');
    const snapshot = await takeSnapshot(context, deps, join(context.runDirectory, 'source.sqlite'), 'snapshot.json');
    const stoppedSource = await sourceMetadata(databasePath);
    // Opening a readonly WAL database can create its previously absent empty WAL
    // and SHM. The database and any existing WAL/journal must remain unchanged.
    const emptyWalCreated = before['-wal'] === null && stoppedSource['-wal']?.size === '0';
    if (!isDeepStrictEqual(before.database, stoppedSource.database) ||
        !isDeepStrictEqual(before['-journal'], stoppedSource['-journal']) ||
        (!isDeepStrictEqual(before['-wal'], stoppedSource['-wal']) && !emptyWalCreated)) fail('CUTOVER_SOURCE_CHANGED');
    const copy = deps.copyTree ?? (await import('./production-file-copy.mjs')).copyVerifiedLocalTree;
    const copiedTrees = {};
    for (const [name, directory, sourceName, phase] of [
      ['downloads', 'downloads', 'downloadsPath', 'copy_downloads'],
      ['localPhotos', 'local-photos', 'localPhotosPath', 'copy_local_photos'],
    ]) {
      await progress(context.runDirectory, phase);
      const copied = await copy({ source: context.configuration.source[sourceName], destination: join(context.runDirectory, directory) },
        { onProgress: counters => progress(context.runDirectory, phase, counters) });
      if (copied?.status !== 'LOCAL_COPY_VERIFIED' || !Number.isSafeInteger(copied.files) || copied.files < 0 ||
          !Number.isSafeInteger(copied.bytes) || copied.bytes < 0 || !/^[a-f0-9]{64}$/.test(copied.treeHash)) fail('LOCAL_COPY_VERIFICATION_FAILED');
      copiedTrees[name] = { files: copied.files, bytes: copied.bytes, treeHash: copied.treeHash };
    }
    await progress(context.runDirectory, 'migrate');
    await migrate(context, 'final', join(context.runDirectory, 'source.sqlite'), join(context.runDirectory, 'data'));
    await progress(context.runDirectory, 'audit');
    const audit = await auditCopy(context, 'final', join(context.runDirectory, 'data'), {
      downloadsPath: join(context.runDirectory, 'downloads'), localPhotosPath: join(context.runDirectory, 'local-photos'),
    });
    const nasGaps = auditGaps(audit, snapshot.counts);
    const accepted = new Set(baseline.baselineFailures.map(failureKey));
    if (audit.failures.some(value => !accepted.has(failureKey(value)))) fail('CUTOVER_NEW_STORAGE_GAPS');
    if (!isDeepStrictEqual(stoppedSource, await sourceMetadata(databasePath))) fail('CUTOVER_SOURCE_CHANGED');
    const currentCounts = await (deps.inspectDatabase ?? inspectSourceDatabase)(databasePath, join(context.manifest.productionRoot, 'backend'));
    matchingCounts(snapshot.counts, currentCounts);
    if (!isDeepStrictEqual(stoppedSource, await sourceMetadata(databasePath))) fail('CUTOVER_SOURCE_CHANGED');
    const report = { ...reportBase(context), status: 'FINAL_COPY_VERIFIED', createdUtc: new Date().toISOString(),
      counts: snapshot.counts, nasGaps, copiedTrees, preparedManifestHash: context.preparedManifestHash,
      finalAuditHash: hash(await small(join(context.runDirectory, 'final-audit.json'))) };
    await publish(join(context.runDirectory, 'final-copy.json'), report);
    await progress(context.runDirectory, 'verified');
    return report;
  } catch (error) { throw safeError(error); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 128 * 1024) fail('CUTOVER_INPUT_INVALID'); }
    const input = JSON.parse(raw);
    raw = '';
    const operation = input.mode === 'preflight' ? preflightProductionCutover : input.mode === 'finalize' ? finalizeProductionData : null;
    if (!operation) fail('CUTOVER_INPUT_INVALID');
    process.stdout.write(JSON.stringify(await operation(input)) + '\n');
  } catch (error) {
    const safe = safeError(error);
    process.stdout.write(JSON.stringify({ status: safe.code, ...(safe.containerName ? { containerName: safe.containerName } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
