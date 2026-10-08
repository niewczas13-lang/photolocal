import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { invokeDocker } from './test-smb-access.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_FAILURES = 50;
const ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'ELOOP', 'ETIMEDOUT']);
function fail(code, details = {}) { throw Object.assign(new Error(code), { code, ...details }); }
function errorCode(error) { return ERROR_CODES.has(error?.code) ? error.code : 'IO_ERROR'; }

/** Translate only explicitly mapped paths; NAS checks use UNC independently of mapped drives. */
export function compareFailurePaths(failures, mappings, windowsShare, subdirectory) {
  if (typeof windowsShare !== 'string' || !/^\\\\[^\\/:,\x00-\x1f]+\\[^\\/:,\x00-\x1f]+$/.test(windowsShare) ||
      windowsShare.split('\\').some(part => ['.', '..'].includes(part))) fail('INVALID_WINDOWS_SHARE');
  if (typeof subdirectory !== 'string' || /[\\:\x00-\x1f]/.test(subdirectory) ||
      subdirectory.split('/').some(part => ['', '.', '..'].includes(part))) fail('INVALID_MAPPING');
  const checkedMappings = mappings.filter(mapping => typeof mapping.from === 'string' && /^[a-z]:[\\/]/i.test(mapping.from) &&
    typeof mapping.to === 'string' && posix.isAbsolute(mapping.to) && !mapping.to.includes('\\') &&
    ![mapping.from, mapping.to].some(path => path.split(/[\\/]/).some(part => part === '..' || part === '.')));
  return failures.slice(0, MAX_FAILURES).map(failure => {
    const check = { ...failure, linuxResult: failure.reason, windowsPath: null };
    if (typeof failure.path !== 'string' || !posix.isAbsolute(failure.path) || /[\\\x00-\x1f]/.test(failure.path) ||
        failure.path.split('/').some(part => part === '..' || part === '.')) return check;
    const mapping = [...checkedMappings].sort((a, b) => b.to.length - a.to.length).find(entry => {
      const relative = posix.relative(entry.to, failure.path);
      return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative));
    });
    if (!mapping) return check;
    const relative = posix.relative(mapping.to, failure.path);
    if (mapping.to === `/nas/${subdirectory}`) check.windowsPath = win32.join(windowsShare, ...subdirectory.split('/'), ...relative.split('/'));
    else if (['/legacy-local-photos', '/legacy-downloads'].includes(mapping.to)) check.windowsPath = win32.join(mapping.from, ...relative.split('/'));
    return check;
  });
}

/** Called in a short-lived native child so an unresponsive network path has a deadline. */
export function checkWindowsPaths(checks) {
  return checks.slice(0, MAX_FAILURES).map(check => {
    let descriptor;
    let windowsResult = 'PATH_NOT_MAPPED';
    if (typeof check.windowsPath === 'string') {
      try {
        if (check.kind === 'project_folder') {
          windowsResult = fs.statSync(check.windowsPath).isDirectory() ? 'READ_OK' : 'NOT_DIRECTORY';
        } else if (check.kind === 'photo') {
          descriptor = fs.openSync(check.windowsPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
          windowsResult = !fs.fstatSync(descriptor).isFile() ? 'NOT_REGULAR_FILE'
            : fs.readSync(descriptor, Buffer.alloc(64), 0, 64, 0) > 0 ? 'READ_OK' : 'EMPTY_FILE';
        }
      } catch (error) { windowsResult = errorCode(error); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    return { ...check, windowsResult };
  });
}

function nativeCheck(checks) {
  const result = spawnSync(process.execPath, [SCRIPT, '--windows-check'], {
    input: JSON.stringify(checks), encoding: 'utf8', timeout: 60_000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed) && parsed.length === checks.length) return parsed;
    } catch { /* Return a fixed diagnostic status below. */ }
  }
  const windowsResult = result.error?.code === 'ETIMEDOUT' ? 'WINDOWS_CHECK_TIMEOUT' : 'WINDOWS_CHECK_FAILED';
  return checks.map(check => ({ ...check, windowsResult }));
}

export function groupComparisons(checks) {
  const groups = new Map();
  for (const check of checks) {
    const key = JSON.stringify([check.kind, check.projectId, check.linuxResult, check.windowsResult]);
    const current = groups.get(key);
    if (current) current.count++;
    else groups.set(key, { kind: check.kind, projectId: check.projectId, linuxResult: check.linuxResult,
      windowsResult: check.windowsResult, count: 1, exampleLinuxPath: check.path, exampleWindowsPath: check.windowsPath });
  }
  return [...groups.values()];
}

export async function diagnoseStagingCopy({ runDirectory, windowsShare, locate = false }, {
  invoke = invokeDocker, nativeCheck: checkNative = nativeCheck,
} = {}) {
  runDirectory = resolve(runDirectory);
  const mapping = JSON.parse(fs.readFileSync(join(runDirectory, 'mapping.json'), 'utf8'));
  const override = JSON.parse(fs.readFileSync(join(runDirectory, 'compose.staging-copy.json'), 'utf8'));
  const volumeName = override.volumes?.staging_nas?.name;
  const nasMapping = mapping.find(entry => typeof entry.to === 'string' && entry.to.startsWith('/nas/'));
  if (!/^photolocal-staging-nas-[a-f0-9]+$/.test(volumeName) || !nasMapping || /[,\x00-\x1f]/.test(runDirectory)) fail('INVALID_DIAGNOSIS_CONFIGURATION');
  const subdirectory = nasMapping.to.slice('/nas/'.length);
  if (typeof locate !== 'boolean') fail('INVALID_ARGUMENTS');
  if (!locate) compareFailurePaths([], mapping, windowsShare, subdirectory); // Validate before any Docker call.
  const binds = ['/legacy-local-photos', '/legacy-downloads'].map(target => {
    const mount = override.services?.photolocal?.volumes?.find(entry => entry.target === target);
    if (mount?.type !== 'bind' || mount.read_only !== true || typeof mount.source !== 'string' ||
        !win32.isAbsolute(mount.source) || /[,\x00-\x1f]/.test(mount.source)) fail('INVALID_DIAGNOSIS_CONFIGURATION');
    return ['--mount', `type=bind,source=${mount.source.replaceAll('$$', '$')},target=${target},readonly`];
  }).flat();
  // --mount would create an empty local volume if the retained CIFS volume disappeared.
  // Inspect only name, driver and filesystem type; its mount options contain credentials.
  const inspected = await invoke(['volume', 'inspect', '--format', '{{.Name}}|{{.Driver}}|{{index .Options "type"}}', volumeName], '', 30_000);
  if (inspected.code === 1 && /no such volume/i.test(inspected.stderr)) fail('STAGING_STORAGE_VOLUME_MISSING');
  if (inspected.timedOut || inspected.code !== 0 || inspected.stdout.trim() !== `${volumeName}|local|cifs`) fail('STAGING_STORAGE_VOLUME_UNAVAILABLE');
  const containerName = `photolocal-staging-diagnose-${randomUUID().replaceAll('-', '')}`;
  let result;
  try {
    result = await invoke(['run', '--name', containerName, '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none',
      '--mount', `type=bind,source=${join(runDirectory, 'data')},target=/data,readonly`,
      '--mount', `type=volume,source=${volumeName},target=/nas,readonly,volume-nocopy`, ...binds,
      '--mount', `type=bind,source=${join(dirname(SCRIPT), 'audit-staging-copy.mjs')},target=/app/scripts/audit-staging-copy.mjs,readonly`,
      '--entrypoint', 'node', 'photolocal:staging', '/app/scripts/audit-staging-copy.mjs', '--database', '/data/photo-local.sqlite', '--details', ...(locate ? ['--locate'] : [])], '', 180_000);
  } finally {
    const cleanup = await invoke(['container', 'rm', '--force', containerName], '', 30_000);
    if (cleanup.timedOut || (cleanup.code !== 0 && !(cleanup.code === 1 && /no such container/i.test(cleanup.stderr)))) fail('DIAGNOSIS_CLEANUP_REQUIRED', { containerName });
  }
  if (result.timedOut || ![0, 1].includes(result.code)) fail('DIAGNOSIS_AUDIT_FAILED');
  let audit;
  try { audit = JSON.parse(result.stdout); } catch { fail('DIAGNOSIS_AUDIT_FAILED'); }
  if (!Array.isArray(audit.failures) || !['STAGING_COPY_VERIFIED', 'STAGING_COPY_FILES_MISSING'].includes(audit.status)) fail('DIAGNOSIS_AUDIT_FAILED');
  if (locate && audit.failures.some(failure => !failure.location)) fail('DIAGNOSIS_AUDIT_FAILED');
  const comparisons = locate ? undefined : checkNative(compareFailurePaths(audit.failures, mapping, windowsShare, subdirectory));
  const reportPath = join(runDirectory, `diagnosis-${randomUUID().replaceAll('-', '')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ audit, comparisons }, null, 2), { flag: 'wx', mode: 0o600 });
  return { status: 'STAGING_DIAGNOSIS_COMPLETE', counts: audit.counts, projectFolders: audit.projectFolders,
    photoSamples: audit.photoSamples, failuresTruncated: audit.failuresTruncated,
    ...(locate ? { locations: audit.failures } : { comparisons: groupComparisons(comparisons) }), reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'run-directory': { type: 'string' }, 'windows-share': { type: 'string' }, 'windows-check': { type: 'boolean' }, locate: { type: 'boolean' } } });
    if (values['windows-check']) {
      const input = fs.readFileSync(0, 'utf8');
      if (input.length > 64 * 1024) fail('INVALID_CHECK_INPUT');
      process.stdout.write(JSON.stringify(checkWindowsPaths(JSON.parse(input))) + '\n');
    } else {
      if (!values['run-directory'] || (!values.locate && !values['windows-share'])) fail('INVALID_ARGUMENTS');
      process.stdout.write(JSON.stringify(await diagnoseStagingCopy({ runDirectory: values['run-directory'], windowsShare: values['windows-share'], locate: values.locate }), null, 2) + '\n');
    }
  } catch (error) {
    const status = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'STAGING_DIAGNOSIS_FAILED';
    const report = { status };
    if (/^photolocal-staging-diagnose-[a-f0-9]{32}$/.test(error.containerName)) report.containerName = error.containerName;
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = 1;
  }
}
