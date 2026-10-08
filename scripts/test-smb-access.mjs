import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE_ID = /^photolocal-smb-probe-[a-f0-9]+$/;
const OUTPUT_LIMIT = 64 * 1024;
const PYTHON_PROBE = `import os, sys
print('PROBE_STARTED', flush=True)
try:
    with os.scandir(sys.argv[1]) as entries:
        for index, entry in enumerate(entries):
            if index >= 7:
                break
    print('DIRECTORY_READ_OK', flush=True)
except FileNotFoundError:
    print('DIRECTORY_MISSING', flush=True)
    sys.exit(4)
except PermissionError:
    print('DIRECTORY_ACCESS_DENIED', flush=True)
    sys.exit(5)
except OSError:
    print('OTHER_ERROR', flush=True)
    sys.exit(6)
`;

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

function composeLiteral(value) {
  return value.replaceAll('$', () => '$$');
}

/** Build an isolated probe; writes require an explicit opt-in and never start the application. */
export function buildProbeConfig(input, probeId) {
  if (!PROBE_ID.test(probeId) || !input || typeof input !== 'object') reject('INVALID_INPUT');
  if (input.checkFilesAndWrite !== undefined && typeof input.checkFilesAndWrite !== 'boolean') reject('INVALID_INPUT');
  const checkFilesAndWrite = input.checkFilesAndWrite === true;
  for (const key of ['server', 'share', 'subdirectory', 'username', 'domain', 'password', 'image']) {
    if (typeof input[key] !== 'string' || input[key].length > 4096) reject('INVALID_INPUT');
  }
  for (const key of ['username', 'domain', 'password']) {
    if (/[,\x00\r\n]/.test(input[key])) reject('CREDENTIAL_FORMAT_UNSUPPORTED');
  }
  if (!input.username.trim() || !input.password) reject('INVALID_INPUT');
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(input.server) || input.server.includes('..')) reject('INVALID_INPUT');
  if (!input.share || /[\\/\x00-\x1f]/.test(input.share) || ['.', '..'].includes(input.share)) reject('INVALID_INPUT');
  if (!input.subdirectory || /[\\:\x00-\x1f]/.test(input.subdirectory) ||
      input.subdirectory.split('/').some((part) => ['', '.', '..'].includes(part))) reject('INVALID_INPUT');
  if (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(input.image)) reject('INVALID_INPUT');

  const options = [
    checkFilesAndWrite ? 'rw' : 'ro', 'vers=3.1.1', 'uid=1000', 'gid=1000',
    checkFilesAndWrite ? 'file_mode=0660' : 'file_mode=0440',
    checkFilesAndWrite ? 'dir_mode=0770' : 'dir_mode=0550',
    `addr=${input.server}`, `username=${input.username}`, `password=${input.password}`,
  ];
  if (input.domain) options.push(`domain=${input.domain}`);
  const command = ['-c', PYTHON_PROBE, composeLiteral(`/probe/${input.subdirectory}`)];
  if (checkFilesAndWrite) {
    command[1] = composeLiteral(readFileSync(new URL('./smb-storage-probe.py', import.meta.url), 'utf8'));
    command.push(probeId);
  }
  return {
    services: {
      probe: {
        image: input.image,
        pull_policy: 'never',
        container_name: probeId,
        user: '1000:1000',
        network_mode: 'none',
        read_only: true,
        healthcheck: { disable: true },
        logging: { driver: 'none' },
        entrypoint: ['/opt/venv/bin/python'],
        command,
        volumes: [{ type: 'volume', source: 'remote', target: '/probe', read_only: !checkFilesAndWrite, volume: { nocopy: true } }],
      },
    },
    volumes: {
      remote: {
        name: `${probeId}-remote`,
        driver: 'local',
        driver_opts: {
          type: 'cifs',
          device: composeLiteral(`//${input.server}/${input.share}`),
          o: composeLiteral(options.join(',')),
        },
      },
    },
  };
}

/** Secrets may appear in either stream: retain bounded output privately, never forward it. */
export function invokeDocker(args, stdin = '', timeoutMs = 90000) {
  return new Promise((resolveResult) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let fallback;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      resolveResult({ code, stdout, stderr, timedOut });
    };
    child.stdout.on('data', (data) => { stdout = (stdout + data.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(null));
    child.on('close', finish);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // Kill only this probe's CLI process tree, never any daemon or other container.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
        killer.unref();
      } else {
        child.kill('SIGKILL');
      }
      fallback = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, 3000);
    }, timeoutMs);
    child.stdin.end(stdin, 'utf8');
  });
}

function classify(result) {
  if (result.timedOut) return 'TIMEOUT';
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.includes('PROBE_STARTED')) {
    if (lines.includes('TEST_FOLDER_CLEANUP_REQUIRED')) return 'TEST_FOLDER_CLEANUP_REQUIRED';
    if (result.code === 0 && lines.includes('STORAGE_READ_WRITE_OK')) return 'STORAGE_READ_WRITE_OK';
    for (const status of ['STORAGE_WRITE_DENIED', 'PHOTO_SAMPLE_NOT_FOUND', 'STORAGE_PROBE_ERROR']) {
      if (lines.includes(status)) return status;
    }
  }
  if (result.code === 0 && lines.includes('DIRECTORY_READ_OK')) return 'DIRECTORY_READ_OK';
  if (lines.includes('PROBE_STARTED') && lines.includes('DIRECTORY_ACCESS_DENIED')) {
    return 'DIRECTORY_ACCESS_DENIED';
  }
  if (lines.includes('DIRECTORY_MISSING')) return 'DIRECTORY_MISSING';
  // Classify privately; the actual Docker message can contain a password.
  const error = result.stderr.toLowerCase();
  if (/permission denied|access denied|logon failure/.test(error)) return 'MOUNT_ACCESS_DENIED';
  if (/no such image|image .*not found/.test(error)) return 'IMAGE_MISSING';
  if (/no route to host|host is down|network is unreachable|connection refused/.test(error)) return 'UNREACHABLE';
  if (/not supported|no such device|unknown filesystem/.test(error)) return 'UNSUPPORTED';
  if (/timed out|timeout/.test(error)) return 'TIMEOUT';
  return 'OTHER_ERROR';
}

/** Exactly one authentication attempt; cleanup is limited to generated resource names. */
export async function runProbe(input, {
  invoke = invokeDocker,
  probeId = `photolocal-smb-probe-${randomUUID().replaceAll('-', '')}`,
} = {}) {
  const report = { status: 'OTHER_ERROR', cleanup: 'NOT_NEEDED', probeId: PROBE_ID.test(probeId) ? probeId : '' };
  let config;
  try {
    config = JSON.stringify(buildProbeConfig(input, probeId));
  } catch (error) {
    report.status = error?.code === 'CREDENTIAL_FORMAT_UNSUPPORTED' ? error.code : 'INVALID_INPUT';
    return report;
  }
  let uncertain = false;
  try {
    const result = await invoke([
      'compose', '--ansi', 'never', '-p', probeId, '-f', '-',
      'run', '--rm', '--no-deps', '-T', '--name', probeId, 'probe',
    ], config);
    uncertain = Boolean(result.timedOut) || result.code === null;
    report.status = classify(result);
  } catch {
    report.status = 'OTHER_ERROR';
    uncertain = true;
  } finally {
    config = undefined;
    report.cleanup = 'CLEAN';
    for (const [args, absent] of [
      [['container', 'rm', '--force', probeId], /no such container/i],
      [['volume', 'rm', `${probeId}-remote`], /no such volume/i],
    ]) {
      try {
        const result = await invoke(args, '', 30000);
        if (result.timedOut || (result.code !== 0 && !(result.code === 1 && absent.test(result.stderr)))) {
          report.cleanup = 'REQUIRED';
        }
      } catch {
        report.cleanup = 'REQUIRED';
      }
    }
    // Docker removal cannot prove that an interrupted Python probe cleaned its SMB folder.
    const interruptedWrite = input.checkFilesAndWrite === true && report.status === 'OTHER_ERROR';
    if (uncertain || interruptedWrite || report.status === 'TEST_FOLDER_CLEANUP_REQUIRED') report.cleanup = 'REQUIRED';
  }
  return report;
}

async function main() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 32768) reject('INVALID_INPUT');
    }
    const input = JSON.parse(raw);
    raw = '';
    const report = await runProbe(input, { probeId: input.probeId });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = ['DIRECTORY_READ_OK', 'STORAGE_READ_WRITE_OK'].includes(report.status) && report.cleanup === 'CLEAN' ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ status: 'INVALID_INPUT', cleanup: 'NOT_NEEDED', probeId: '' }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
