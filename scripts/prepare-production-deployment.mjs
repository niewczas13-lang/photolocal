import { createHash } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { buildProductionConfiguration, verifyResolvedProductionConfiguration } from './production-deployment-config.mjs';
import { invokeDocker } from './test-smb-access.mjs';

export const SOURCE_SETTING_NAMES = [
  'PHOTO_LOCAL_DB', 'PHOTO_LOCAL_LOG', 'PHOTO_LOCAL_PORT', 'PHOTO_LOCAL_HOST',
  'PHOTO_LOCAL_AUTH', 'PHOTO_LOCAL_SHARED_ROOTS', 'GOOGLE_CHAT_DOWNLOAD_ROOT',
  'ADRESY_APP_BASE_URL', 'ADRESY_APP_API_KEY', 'ADRESY_APP_REVERSE_RADIUS_METERS',
  'NOMINATIM_BASE_URL', 'NOMINATIM_USER_AGENT', 'OLLAMA_URL',
  'OLLAMA_NOTES_MODEL', 'OLLAMA_VISION_MODEL', 'OLLAMA_VISION_MODELS',
];
const SCOPES = ['https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];
const TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const IMAGE = 'photolocal:staging';
const own = (object, name) => Object.hasOwn(object, name);
const digest = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function fail(code, details = {}) { throw Object.assign(new Error(code), { code, ...details }); }
function insideWindows(candidate, root) {
  const difference = win32.relative(root, candidate);
  return difference !== '' && difference !== '..' && !difference.startsWith('..\\') && !win32.isAbsolute(difference);
}

/** Preserve agreed source settings; terminal-only or conflicting overrides need review. */
export function resolveSourceEnvironment(document, scopes) {
  if (!document || typeof document !== 'object' || !scopes ||
      !['process', 'user', 'machine'].every(name => scopes[name] && typeof scopes[name] === 'object' && !Array.isArray(scopes[name]))) {
    fail('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED');
  }
  const normalize = object => {
    const normalized = {};
    for (const [key, value] of Object.entries(object)) {
      const name = key.toUpperCase();
      if (!SOURCE_SETTING_NAMES.includes(name)) continue;
      if (own(normalized, name) && normalized[name] !== value) {
        fail('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', { settingNames: [name] });
      }
      normalized[name] = value;
    }
    return normalized;
  };
  document = normalize(document);
  scopes = Object.fromEntries(['process', 'user', 'machine'].map(name => [name, normalize(scopes[name])]));
  const registered = { ...scopes.machine, ...scopes.user };
  const result = {};
  const conflicts = [];
  for (const name of SOURCE_SETTING_NAMES) {
    const hasFile = own(document, name);
    const hasProcess = own(scopes.process, name);
    const hasRegistered = own(registered, name);
    if ([document, scopes.process, registered].some(object => own(object, name) && typeof object[name] !== 'string')) {
      conflicts.push(name); continue;
    }
    if ((hasRegistered && (!hasProcess || registered[name] !== scopes.process[name])) ||
        (hasProcess && !hasRegistered && (!hasFile || document[name] !== scopes.process[name])) ||
        (hasFile && hasProcess && document[name] !== scopes.process[name])) {
      conflicts.push(name); continue;
    }
    if (hasProcess) result[name] = scopes.process[name];
    else if (hasFile) result[name] = document[name];
  }
  if (conflicts.length) fail('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', { settingNames: conflicts });
  return result;
}

async function plainPath(path, kind = 'directory') {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile()) ||
        !samePath(await realpath(path), resolve(path))) throw new Error();
    return info;
  } catch { fail('LOCAL_STORAGE_UNAVAILABLE'); }
}

/** Count every local regular file, including hidden manifests, without following links. */
export async function inventoryLocalTree(root, { maxEntries = 250_000, maxMs = 60_000, now = () => performance.now() } = {}) {
  const started = now();
  const pending = [resolve(root)];
  const report = { files: 0, bytes: 0 };
  let entries = 0;
  try {
    while (pending.length) {
      const directory = pending.pop();
      await plainPath(directory);
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++entries > maxEntries || now() - started >= maxMs) fail('LOCAL_STORAGE_SCAN_LIMIT');
        if (entry.isSymbolicLink()) fail('LOCAL_STORAGE_UNAVAILABLE');
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) fail('LOCAL_STORAGE_UNAVAILABLE');
        if (info.isDirectory()) pending.push(path);
        else if (info.isFile()) {
          report.files += 1;
          report.bytes += info.size;
          if (!Number.isSafeInteger(report.bytes)) fail('LOCAL_STORAGE_SCAN_LIMIT');
        } else fail('LOCAL_STORAGE_UNAVAILABLE');
      }
    }
    return report;
  } catch (error) {
    if (['LOCAL_STORAGE_UNAVAILABLE', 'LOCAL_STORAGE_SCAN_LIMIT'].includes(error.code)) throw error;
    fail('LOCAL_STORAGE_UNAVAILABLE');
  }
}

async function smallFile(path) {
  const info = await plainPath(path, 'file');
  if (info.size > 1024 * 1024) fail('LOCAL_STORAGE_UNAVAILABLE');
  return readFile(path);
}

async function freeBytes(path) {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

/** Inspect committed counts; the final snapshot will establish its own counts later. */
export function inspectSourceDatabase(path, runtimeRoot, { Database } = {}) {
  let database;
  try {
    const NativeDatabase = Database ?? createRequire(join(runtimeRoot, 'package.json'))('better-sqlite3');
    database = new NativeDatabase(path, { readonly: true, fileMustExist: true, timeout: 5000 });
    const tableExists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const counts = Object.fromEntries(TABLES.map(table => {
      if (!tableExists.get(table)) throw new Error();
      const count = database.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
      if (!Number.isSafeInteger(count) || count < 0) throw new Error();
      return [table, count];
    }));
    if (counts.projects === 0) throw new Error();
    return counts;
  } catch { fail('SOURCE_DATABASE_INVALID'); }
  finally { if (database) database.close(); }
}

function verifyGoogle(client, token, callback) {
  if (!client?.web || !['client_id', 'client_secret'].every(key => typeof client.web[key] === 'string' && client.web[key].trim())) {
    fail('GOOGLE_WEB_CLIENT_INVALID');
  }
  if (!Array.isArray(client.web.redirect_uris) || !client.web.redirect_uris.includes(callback)) fail('GOOGLE_CALLBACK_NOT_LISTED');
  if (!token || token.client_id !== client.web.client_id || token.client_secret !== client.web.client_secret ||
      typeof token.refresh_token !== 'string' || !token.refresh_token ||
      !Array.isArray(token.scopes) || !SCOPES.every(scope => token.scopes.includes(scope))) fail('GOOGLE_TOKEN_INVALID');
}

/** Prepare private settings only. Database snapshot/copy and service cutover happen later. */
export async function prepareProductionDeployment(input, {
  parseDotenv, invoke = invokeDocker, getFreeBytes = freeBytes, inspectDatabase = inspectSourceDatabase,
} = {}) {
  if (process.platform !== 'win32') fail('PREPARATION_FAILED');
  const { productionRoot, stagingRoot, runDirectory, networkPrefix, publicUrl, environmentScopes } = input ?? {};
  if (![productionRoot, stagingRoot, runDirectory].every(value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)) ||
      !insideWindows(runDirectory, win32.join(stagingRoot, 'docker-data')) ||
      !/^production-[a-f0-9]{32}$/.test(win32.basename(runDirectory))) fail('PRIVATE_DIRECTORY_INVALID');
  await plainPath(productionRoot);
  await plainPath(stagingRoot);
  await plainPath(runDirectory);
  if ((await readdir(runDirectory)).length !== 0) fail('PRIVATE_DIRECTORY_INVALID');
  const parse = parseDotenv ?? createRequire(join(productionRoot, 'backend', 'package.json'))('dotenv').parse;
  const environmentBytes = await smallFile(join(productionRoot, '.env'));
  const sourceEnvironment = resolveSourceEnvironment(parse(environmentBytes.toString('utf8')), environmentScopes);
  // The deployed native 21aac58 uses its fixed download root. Do not silently
  // reinterpret an ignored setting as a different source tree during migration.
  if (sourceEnvironment.GOOGLE_CHAT_DOWNLOAD_ROOT) fail('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', { settingNames: ['GOOGLE_CHAT_DOWNLOAD_ROOT'] });
  const storageBytes = await smallFile(join(stagingRoot, 'docker-data', 'production-storage.json'));
  const storage = JSON.parse(storageBytes.toString('utf8'));
  const imageResult = await invoke(['image', 'inspect', '--format', '{{.Id}}', IMAGE], '', 30_000);
  if (imageResult.code !== 0 || imageResult.timedOut || !/^sha256:[a-f0-9]{64}$/.test(imageResult.stdout.trim())) fail('DOCKER_IMAGE_UNAVAILABLE');
  const imageId = imageResult.stdout.trim();
  const configurationInput = { productionRoot, stagingRoot, runDirectory, networkPrefix, publicUrl, sourceEnvironment, storage, imageId };
  const { source, mapping, compose, integrationSettingNames } = buildProductionConfiguration(configurationInput);
  const databaseInfo = await plainPath(source.databasePath, 'file');
  const sourceCounts = inspectDatabase(source.databasePath, join(productionRoot, 'backend'));
  const localFiles = {
    downloads: await inventoryLocalTree(source.downloadsPath),
    localPhotos: await inventoryLocalTree(source.localPhotosPath),
  };
  let databaseBytes = databaseInfo.size;
  for (const suffix of ['-wal', '-journal']) {
    try {
      const info = await lstat(source.databasePath + suffix);
      if (!info.isFile() || info.isSymbolicLink()) fail('LOCAL_STORAGE_UNAVAILABLE');
      databaseBytes += info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const requiredFreeBytes = localFiles.downloads.bytes + localFiles.localPhotos.bytes + databaseBytes * 3 + 1024 ** 3;
  const availableFreeBytes = await getFreeBytes(runDirectory);
  if (!Number.isSafeInteger(availableFreeBytes) || availableFreeBytes < requiredFreeBytes) fail('INSUFFICIENT_DISK_SPACE');

  const stagingEnvironment = parse((await smallFile(join(stagingRoot, '.env.docker'))).toString('utf8'));
  const googleSource = stagingEnvironment.PHOTO_LOCAL_GOOGLE_DIR
    ? win32.resolve(stagingRoot, stagingEnvironment.PHOTO_LOCAL_GOOGLE_DIR) : join(stagingRoot, 'docker-data', 'google');
  if (!insideWindows(googleSource, win32.join(stagingRoot, 'docker-data'))) fail('GOOGLE_WEB_CLIENT_INVALID');
  await plainPath(googleSource);
  let clientBytes;
  let tokenBytes;
  let client;
  let token;
  try {
    clientBytes = await smallFile(join(googleSource, 'credentials.json'));
    client = JSON.parse(clientBytes.toString('utf8'));
  } catch { fail('GOOGLE_WEB_CLIENT_INVALID'); }
  try {
    tokenBytes = await smallFile(join(googleSource, 'token.json'));
    token = JSON.parse(tokenBytes.toString('utf8'));
  } catch { fail('GOOGLE_TOKEN_INVALID'); }
  const callback = `${new URL(publicUrl).origin}/api/google-chat/auth/callback`;
  verifyGoogle(client, token, callback);

  for (const name of ['data', 'google', 'downloads', 'local-photos', 'photos']) await mkdir(join(runDirectory, name), { mode: 0o700 });
  const composeFile = join(runDirectory, 'compose.production.json');
  const composeBytes = JSON.stringify(compose, null, 2) + '\n';
  await writeFile(composeFile, composeBytes, { flag: 'wx', mode: 0o600 });
  const emptyEnvironmentFile = join(runDirectory, 'empty.env');
  await writeFile(emptyEnvironmentFile, '', { flag: 'wx', mode: 0o600 });
  const composeResult = await invoke(['compose', '--ansi', 'never', '-p', 'photolocal-production',
    '--project-directory', runDirectory, '--env-file', emptyEnvironmentFile, '-f', composeFile,
    'config', '--format', 'json'], '', 30_000);
  try {
    if (composeResult.code !== 0 || composeResult.timedOut) throw new Error();
    verifyResolvedProductionConfiguration(JSON.parse(composeResult.stdout), configurationInput);
  } catch { fail('PRODUCTION_COMPOSE_INVALID'); }
  await writeFile(join(runDirectory, 'google', 'credentials.json'), clientBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(runDirectory, 'google', 'token.json'), tokenBytes, { flag: 'wx', mode: 0o600 });
  const mappingFile = join(runDirectory, 'mapping.json');
  const mappingBytes = JSON.stringify(mapping, null, 2) + '\n';
  await writeFile(mappingFile, mappingBytes, { flag: 'wx', mode: 0o600 });
  const report = {
    status: 'PRODUCTION_CONFIG_PREPARED', runDirectory, sourceDatabase: source.databasePath, sourceCounts,
    localFiles, requiredFreeBytes, availableFreeBytes,
    google: { webClient: true, refreshTokenCopied: true, publicCallbackListed: true },
    preservedIntegrationSettings: integrationSettingNames,
    productionCutover: 'NOT_PERFORMED', nextStep: 'FINAL_SNAPSHOT_REQUIRED',
  };
  const manifest = {
    version: 1, status: report.status, createdUtc: new Date().toISOString(),
    productionRoot, stagingRoot, runDirectory, networkPrefix, publicUrl, imageId,
    source, googleSource, storage, composeFile, mappingFile, emptyEnvironmentFile,
    hashes: { sourceEnvironment: digest(environmentBytes), storage: digest(storageBytes),
      compose: digest(composeBytes), mapping: digest(mappingBytes), googleClient: digest(clientBytes) },
    configurationSource: 'REGISTERED_ENVIRONMENT_AND_DOTENV',
    effectiveNativeProcessEnvironment: 'NOT_INSPECTED',
    localFiles, sourceCounts, requiredFreeBytes, finalSnapshotRequired: true,
  };
  await writeFile(join(runDirectory, 'production-preparation.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(runDirectory, 'preparation-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}

const PUBLIC_ERRORS = new Set(['SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', 'GOOGLE_WEB_CLIENT_INVALID',
  'GOOGLE_TOKEN_INVALID', 'GOOGLE_CALLBACK_NOT_LISTED', 'LOCAL_STORAGE_UNAVAILABLE',
  'LOCAL_STORAGE_SCAN_LIMIT', 'INSUFFICIENT_DISK_SPACE', 'DOCKER_IMAGE_UNAVAILABLE',
  'PRODUCTION_COMPOSE_INVALID', 'PRIVATE_DIRECTORY_INVALID', 'SOURCE_DATABASE_INVALID']);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input;
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 128 * 1024) fail('PREPARATION_FAILED');
    }
    input = JSON.parse(raw);
    raw = '';
    const report = await prepareProductionDeployment(input);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    const report = { status: PUBLIC_ERRORS.has(error?.code) ? error.code : 'PREPARATION_FAILED' };
    if (typeof input?.runDirectory === 'string' && /^production-[a-f0-9]{32}$/.test(win32.basename(input.runDirectory))) report.runDirectory = input.runDirectory;
    if (Array.isArray(error?.settingNames)) report.settingNames = error.settingNames.filter(name => SOURCE_SETTING_NAMES.includes(name));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 1;
  }
}
