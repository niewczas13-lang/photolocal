import fs from 'node:fs';
import { resolve, win32 as path } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCopyConfiguration, verifyResolvedConfiguration } from './prepare-staging-copy.mjs';
import { diagnoseStagingCopy } from './diagnose-staging-copy.mjs';
import { invokeDocker } from './test-smb-access.mjs';

const TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function matchingCounts(expected, actual) {
  if (TABLES.some(key => !Number.isSafeInteger(expected?.[key]) || expected[key] < 0 || expected[key] !== actual?.[key])) fail('STAGING_PREVIEW_COUNTS_MISMATCH');
}
function validateAudit(audit, counts) {
  matchingCounts(counts, audit?.counts);
  for (const [group, yes, no] of [['projectFolders', 'accessible', 'missing'], ['photoSamples', 'readable', 'unreadable']]) {
    const values = audit[group];
    if (!values || ['checked', yes, no].some(key => !Number.isSafeInteger(values[key]) || values[key] < 0) ||
        values.checked !== values[yes] + values[no]) fail('STAGING_PREVIEW_AUDIT_INVALID');
  }
  if (audit.projectFolders.checked !== counts.projects || (counts.projects > 0 && !audit.projectFolders.accessible) ||
      (counts.photos > 0 && !audit.photoSamples.readable)) fail('STAGING_PREVIEW_STORAGE_UNAVAILABLE');
}

/** Start an existing incomplete copy for isolated viewing; never migrate or repair production paths. */
export async function startStagingPreview({ runDirectory }, { io = fs, diagnose = diagnoseStagingCopy, invoke = invokeDocker } = {}) {
  if (typeof runDirectory !== 'string' || !/^[a-z]:[\\/]/i.test(runDirectory) || /[,\x00-\x1f]/.test(runDirectory) ||
      runDirectory.split(/[\\/]/).some(part => part === '.' || part === '..')) fail('INVALID_PREVIEW_DIRECTORY');
  runDirectory = path.normalize(runDirectory);
  const dataRoot = path.dirname(runDirectory);
  const stagingRoot = path.dirname(dataRoot);
  if (path.basename(dataRoot) !== 'docker-data' || !/^migration-[a-zA-Z0-9_-]+$/.test(path.basename(runDirectory))) fail('INVALID_PREVIEW_DIRECTORY');
  const read = name => JSON.parse(io.readFileSync(name, 'utf8'));
  const optional = name => { try { return read(name); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
  const manifestPath = path.join(dataRoot, 'staging-preview.json');
  const composeFile = path.join(runDirectory, 'compose.staging-copy.json');
  if (optional(path.join(dataRoot, 'staging-copy.json')) !== undefined) fail('STAGING_COPY_ALREADY_PREPARED');
  const previous = optional(manifestPath);
  if (previous !== undefined && (previous?.version !== 1 || previous?.status !== 'PREVIEW_READY' ||
      !same(previous?.runDirectory, runDirectory) || !same(previous?.composeFile, composeFile))) fail('STAGING_PREVIEW_ALREADY_SELECTED');
  const mapping = read(path.join(runDirectory, 'mapping.json'));
  const override = read(composeFile);
  const snapshot = read(path.join(runDirectory, 'snapshot.json'));
  const audit = read(path.join(runDirectory, 'audit.json'));
  const storage = read(path.join(dataRoot, 'storage.json'));
  const local = override.services?.photolocal?.volumes?.find(mount => mount.target === '/legacy-local-photos');
  if (typeof local?.source !== 'string') fail('INVALID_PREVIEW_CONFIGURATION');
  const productionRoot = path.dirname(path.dirname(local.source.replaceAll('$$', '$')));
  const networkPrefix = Array.isArray(mapping) && mapping.find(entry => entry.to === `/nas/${storage.subdirectory}`)?.from;
  const configuration = { productionRoot, stagingRoot, runDirectory, networkPrefix, storage };
  const expected = buildCopyConfiguration(configuration);
  if (JSON.stringify(expected.mapping) !== JSON.stringify(mapping) || snapshot.status !== 'SNAPSHOT_OK' ||
      !same(snapshot.output, path.join(runDirectory, 'source.sqlite')) ||
      !['STAGING_COPY_FILES_MISSING', 'STAGING_COPY_VERIFIED'].includes(audit.status)) fail('INVALID_PREVIEW_CONFIGURATION');
  matchingCounts(snapshot.counts, audit.counts);
  function present(name, file = false) {
    const info = io.lstatSync(name);
    if (info.isSymbolicLink() || !(file ? info.isFile() && info.size > 0 : info.isDirectory()) ||
        !same(io.realpathSync(name), name)) fail('STAGING_PREVIEW_PATH_UNAVAILABLE');
  }
  for (const name of [stagingRoot, dataRoot, runDirectory, path.join(runDirectory, 'data')]) present(name);
  present(path.join(runDirectory, 'data', 'photo-local.sqlite'), true);
  present(path.join(runDirectory, 'source.sqlite'), true);
  const diagnosis = await diagnose({ runDirectory, locate: true });
  if (diagnosis?.status !== 'STAGING_DIAGNOSIS_COMPLETE' || !Array.isArray(diagnosis.locations) ||
      typeof diagnosis.reportPath !== 'string' || !same(path.dirname(diagnosis.reportPath), runDirectory)) fail('STAGING_PREVIEW_AUDIT_INVALID');
  validateAudit(diagnosis, snapshot.counts);
  const args = ['compose', '--ansi', 'never', '-p', 'photolocal-staging', '--project-directory', stagingRoot,
    '--env-file', path.join(stagingRoot, '.env.docker'), '-f', path.join(stagingRoot, 'compose.yaml'), '-f', composeFile];
  const configResult = await invoke([...args, 'config', '--format', 'json'], '', 30_000);
  if (configResult.code !== 0 || configResult.timedOut) fail('STAGING_PREVIEW_CONFIGURATION_FAILED');
  let resolved;
  try { resolved = JSON.parse(configResult.stdout); } catch { fail('STAGING_PREVIEW_CONFIGURATION_FAILED'); }
  verifyResolvedConfiguration(resolved, configuration);
  const app = resolved.services.photolocal;
  if (app.environment?.PHOTO_LOCAL_AUTH !== 'enabled' || app.environment?.PHOTO_LOCAL_DB !== '/data/photo-local.sqlite' ||
      app.privileged || app.network_mode === 'host') fail('UNSAFE_STAGING_CONFIGURATION');
  for (const mount of app.volumes.filter(mount => mount.type === 'bind')) {
    if (mount.bind?.create_host_path !== false) fail('UNSAFE_STAGING_CONFIGURATION');
    present(mount.source);
  }
  const report = { status: 'PREVIEW_READY', version: 1, composeFile, runDirectory, counts: diagnosis.counts,
    storageSampleChecksPassed: diagnosis.projectFolders.missing === 0 && diagnosis.photoSamples.unreadable === 0,
    projectFolders: diagnosis.projectFolders, photoSamples: diagnosis.photoSamples,
    diagnosisReportPath: diagnosis.reportPath, locations: diagnosis.locations, failuresTruncated: diagnosis.failuresTruncated };
  if (previous === undefined) io.writeFileSync(manifestPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  const started = await invoke([...args, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal'], '', 150_000);
  if (started.code !== 0 || started.timedOut) fail('STAGING_PREVIEW_START_FAILED');
  return { ...report, status: 'STAGING_PREVIEW_RUNNING', url: 'http://localhost:4874' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'run-directory': { type: 'string' } } });
    process.stdout.write(JSON.stringify(await startStagingPreview({ runDirectory: values['run-directory'] }), null, 2) + '\n');
  } catch (error) {
    const status = /^[A-Z_]+$/.test(error.code) ? error.code : 'STAGING_PREVIEW_FAILED';
    process.stdout.write(JSON.stringify({ status }) + '\n');
    process.exitCode = 1;
  }
}
