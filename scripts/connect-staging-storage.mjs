import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProbeConfig, invokeDocker } from './test-smb-access.mjs';

const PROBE_ID = /^photolocal-smb-probe-[a-f0-9]{32}$/;
const VOLUME_NAME = /^photolocal-staging-nas-[a-f0-9]{32}$/;

function exists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function classify(result) {
  if (result.timedOut) return 'TIMEOUT';
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.includes('PROBE_STARTED')) {
    if (result.code === 0 && lines.includes('DIRECTORY_READ_OK')) return 'STAGING_STORAGE_READY';
    if (lines.includes('DIRECTORY_ACCESS_DENIED')) return 'DIRECTORY_ACCESS_DENIED';
    if (lines.includes('DIRECTORY_MISSING')) return 'DIRECTORY_MISSING';
  }
  const error = result.stderr.toLowerCase();
  if (/permission denied|access denied|logon failure/.test(error)) return 'MOUNT_ACCESS_DENIED';
  if (/no such image|image .*not found/.test(error)) return 'IMAGE_MISSING';
  if (/no route to host|host is down|network is unreachable|connection refused/.test(error)) return 'UNREACHABLE';
  if (/not supported|no such device|unknown filesystem/.test(error)) return 'UNSUPPORTED';
  if (/timed out|timeout/.test(error)) return 'TIMEOUT';
  return 'OTHER_ERROR';
}

async function removeOwned(invoke, type, name) {
  try {
    const result = await invoke(type === 'container' ? ['container', 'rm', '--force', name] : ['volume', 'rm', name], '', 30000);
    return !result.timedOut && (result.code === 0 ||
      (result.code === 1 && new RegExp(`no such ${type}`, 'i').test(result.stderr)));
  } catch { return false; }
}

/** Create one verified read-only CIFS volume. Passwords remain only in Docker volume metadata. */
export async function connectStagingStorage(input, {
  invoke = invokeDocker,
  probeId = `photolocal-smb-probe-${randomUUID().replaceAll('-', '')}`,
  volumeName = `photolocal-staging-nas-${randomUUID().replaceAll('-', '')}`,
} = {}) {
  const report = { status: 'INVALID_INPUT', cleanup: 'NOT_NEEDED',
    probeId: PROBE_ID.test(probeId) ? probeId : '',
    volumeName: VOLUME_NAME.test(volumeName) ? volumeName : '', manifestPath: '' };
  let config;
  let manifestPath;
  try {
    if (!PROBE_ID.test(probeId) || !VOLUME_NAME.test(volumeName) || !input ||
        input.checkFilesAndWrite !== undefined || typeof input.outputDirectory !== 'string' ||
        !isAbsolute(input.outputDirectory)) return report;
    const outputDirectory = realpathSync(input.outputDirectory);
    if (!lstatSync(outputDirectory).isDirectory()) return report;
    manifestPath = join(outputDirectory, 'storage.json');
    if (exists(manifestPath)) { report.status = 'STORAGE_MANIFEST_EXISTS'; return report; }
    config = buildProbeConfig(input, probeId);
    config.volumes.remote.name = volumeName;
  } catch (error) {
    if (error?.code === 'CREDENTIAL_FORMAT_UNSUPPORTED') report.status = error.code;
    return report;
  }

  // Refuse a collision without touching any resource that this invocation does not own.
  try {
    for (const [type, name] of [['volume', volumeName], ['container', probeId]]) {
      const inspected = await invoke([type, 'inspect', '--format', '{{.Name}}', name], '', 30000);
      if (inspected.code === 0 && !inspected.timedOut) {
        report.status = 'STORAGE_RESOURCE_EXISTS'; return report;
      }
      if (inspected.timedOut || inspected.code !== 1 || !new RegExp(`no such ${type}`, 'i').test(inspected.stderr)) {
        report.status = inspected.timedOut ? 'TIMEOUT' : 'OTHER_ERROR'; return report;
      }
    }
  } catch { report.status = 'OTHER_ERROR'; return report; }

  let uncertain = false;
  let keepVolume = false;
  let temporaryManifest;
  let ownsTemporaryManifest = false;
  try {
    const result = await invoke([
      'compose', '--ansi', 'never', '-p', probeId, '-f', '-',
      'run', '--rm', '--no-deps', '-T', '--name', probeId, 'probe',
    ], JSON.stringify(config));
    uncertain = Boolean(result.timedOut) || result.code === null;
    report.status = classify(result);
  } catch {
    uncertain = true;
    report.status = 'OTHER_ERROR';
  } finally {
    config = undefined;
    report.cleanup = 'CLEAN';
    const containerRemoved = await removeOwned(invoke, 'container', probeId);
    if (!containerRemoved) {
      report.cleanup = 'REQUIRED';
      if (report.status === 'STAGING_STORAGE_READY') report.status = 'STORAGE_CLEANUP_FAILED';
    }
    if (report.status === 'STAGING_STORAGE_READY' && containerRemoved && !uncertain) {
      try {
        const manifest = { version: 1, volumeName, containerPath: '/nas', subdirectory: input.subdirectory };
        temporaryManifest = `${manifestPath}.${probeId}.tmp`;
        const temporaryFile = openSync(temporaryManifest, 'wx', 0o600);
        ownsTemporaryManifest = true;
        try { writeFileSync(temporaryFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8'); }
        finally { closeSync(temporaryFile); }
        // A hard link publishes the complete file atomically and refuses any existing target.
        linkSync(temporaryManifest, manifestPath);
        keepVolume = true;
        report.manifestPath = manifestPath;
      } catch (error) {
        report.status = error?.code === 'EEXIST' ? 'STORAGE_MANIFEST_EXISTS' : 'STORAGE_MANIFEST_FAILED';
      } finally {
        if (ownsTemporaryManifest) {
          try { unlinkSync(temporaryManifest); } catch (error) {
            if (error.code !== 'ENOENT') { report.cleanup = 'REQUIRED'; report.status = 'STORAGE_CLEANUP_FAILED'; }
          }
        }
      }
    }
    if (!keepVolume && !(await removeOwned(invoke, 'volume', volumeName))) report.cleanup = 'REQUIRED';
    if (uncertain) report.cleanup = 'REQUIRED';
  }
  return report;
}

async function main() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 32768) throw new Error('INVALID_INPUT');
    }
    const input = JSON.parse(raw);
    raw = '';
    const report = await connectStagingStorage(input, { probeId: input.probeId, volumeName: input.volumeName });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.status === 'STAGING_STORAGE_READY' && report.cleanup === 'CLEAN' ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ status: 'INVALID_INPUT', cleanup: 'NOT_NEEDED', probeId: '', volumeName: '', manifestPath: '' }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
