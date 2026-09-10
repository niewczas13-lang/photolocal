import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./lock-autologon-session.ps1', import.meta.url));
const sid = 'S-1-5-21-111-222-333-1001';
const windowsOnly = { skip: process.platform !== 'win32' };
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

function powershell(code) {
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const result = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(`
Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility -ErrorAction Stop
$PSModuleAutoLoadingPreference = 'None'
${code}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function runScenario({ currentSid = sid, sessionId = 1, consoles = [1], locks = ['$true'],
  identityError = false, consoleError = false, lockError = false } = {}) {
  return powershell(`
$ErrorActionPreference = 'Stop'
. ${literal(runner)} -ExpectedSid ${literal(sid)}
$script:consoleReads = 0
$script:lockRequests = 0
$script:waits = 0
$script:consoleIds = @(${consoles.join(',')})
$script:lockResults = @(${locks.join(',')})
function Get-PhotoLocalLockIdentity {
  ${identityError ? "throw 'private error'" : `
  [pscustomobject]@{ Sid = ${literal(currentSid)}; SessionId = ${sessionId} }`}
}
function Get-PhotoLocalActiveConsoleSessionId {
  $script:consoleReads++
  ${consoleError ? "throw 'private error'" : `
  $script:consoleIds[[Math]::Min($script:consoleReads - 1, $script:consoleIds.Count - 1)]`}
}
function Request-PhotoLocalWorkstationLock {
  $script:lockRequests++
  ${lockError ? "throw 'private error'" : `
  $script:lockResults[[Math]::Min($script:lockRequests - 1, $script:lockResults.Count - 1)]`}
}
function Wait-PhotoLocalLockRetry { $script:waits++ }
$result = Invoke-PhotoLocalConsoleLock -ExpectedSid ${literal(sid)}
[pscustomobject]@{
  result = $result
  consoleReads = $script:consoleReads
  lockRequests = $script:lockRequests
  waits = $script:waits
} | ConvertTo-Json -Compress -Depth 4
`);
}

test('console lock runner exists', () => {
  assert.equal(fs.existsSync(runner), true);
});

function traceScenario(t, body, { prepare } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photolocal-lock-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  prepare?.(root);
  const result = powershell(`
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${literal(root)}
. ${literal(runner)} -ExpectedSid ${literal(sid)}
$script:locks = 0
function Get-PhotoLocalLockIdentity { [pscustomobject]@{ Sid = ${literal(sid)}; SessionId = 1 } }
function Get-PhotoLocalActiveConsoleSessionId { return 1 }
function Request-PhotoLocalWorkstationLock { $script:locks++; return $true }
function Wait-PhotoLocalLockRetry { }
${body}
`);
  return { root, result };
}

function traceFiles(root) {
  const directory = path.join(root, 'PhotoLocal', 'console-lock');
  return fs.readdirSync(directory)
    .filter((name) => /^console-lock-\d{8}T\d{9}Z-[0-9a-f]{32}\.jsonl$/.test(name))
    .map((name) => path.join(directory, name));
}

test('dot-sourcing and invoking lock functions do not enable disk diagnostics', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$result = Invoke-PhotoLocalConsoleLock -ExpectedSid ${literal(sid)}
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('diagnostics record START and native-init progress before compilation without credentials', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$script:phasesAtCompilation = @()
function Add-Type {
  $file = [IO.Directory]::GetFiles((Join-Path $env:LOCALAPPDATA 'PhotoLocal\\console-lock'), '*.jsonl')[0]
  $script:phasesAtCompilation = @([IO.File]::ReadAllLines($file) | ForEach-Object { (ConvertFrom-Json $_).event })
}
function Get-PhotoLocalActiveConsoleSessionId { Initialize-PhotoLocalLockNativeApi; return 1 }
$result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ status = $result.status; phasesAtCompilation = $script:phasesAtCompilation; locks = $script:locks } | ConvertTo-Json -Compress
`);
  assert.deepEqual(result.phasesAtCompilation, ['START', 'IDENTITY_CHECKED', 'NATIVE_INIT_START']);
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 1);
  const files = traceFiles(root);
  assert.equal(files.length, 1);
  const text = fs.readFileSync(files[0], 'utf8');
  assert.equal(text.includes(sid), false);
  assert.equal(text.includes('private error'), false);
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((item) => item.event), [
    'START', 'IDENTITY_CHECKED', 'NATIVE_INIT_START', 'NATIVE_INIT_DONE',
    'CONSOLE_CHECK', 'LOCK_REQUEST_START', 'LOCK_REQUEST_DONE', 'FINAL',
  ]);
  assert.equal(events[1].sessionId, 1);
  assert.equal(events[4].consoleSessionId, 1);
  assert.equal(events[4].attempt, 1);
  assert.equal(events[6].accepted, true);
  assert.equal(events.at(-1).status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(events.at(-1).exitCode, 0);
  assert.ok(events.every((item) => Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0));
  assert.ok(events.every((item) => Number.isFinite(Date.parse(item.utc))));
});

test('diagnostic directory failure does not prevent locking', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`, { prepare: (root) => fs.writeFileSync(path.join(root, 'PhotoLocal'), 'occupied') });
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 1);
  assert.equal(fs.readFileSync(path.join(root, 'PhotoLocal'), 'utf8'), 'occupied');
});

test('an append failure after START does not prevent locking', windowsOnly, (t) => {
  const { result } = traceScenario(t, `
$script:traceHandle = $null
function Get-PhotoLocalLockIdentity {
  $file = [IO.Directory]::GetFiles((Join-Path $env:LOCALAPPDATA 'PhotoLocal\\console-lock'), '*.jsonl')[0]
  $script:traceHandle = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  [pscustomobject]@{ Sid = ${literal(sid)}; SessionId = 1 }
}
try { $result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)} }
finally { if ($script:traceHandle) { $script:traceHandle.Dispose() } }
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 1);
});

test('separate runs retain the latest 20 own files and preserve unrelated files and directories', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$first = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
$second = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ first = $first.status; second = $second.status; locks = $script:locks } | ConvertTo-Json -Compress
`, { prepare: (root) => {
    const directory = path.join(root, 'PhotoLocal', 'console-lock');
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 20; index++) {
      fs.writeFileSync(path.join(directory, `console-lock-20250101T000000000Z-${index.toString(16).padStart(32, '0')}.jsonl`), '{}\n');
    }
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep');
    fs.writeFileSync(path.join(directory, 'console-lock-not-ours.jsonl'), 'keep');
    fs.mkdirSync(path.join(directory, 'console-lock-20250101T000000000Z-ffffffffffffffffffffffffffffffff.jsonl'));
  } });
  assert.equal(result.first, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.second, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 2);
  const directory = path.join(root, 'PhotoLocal', 'console-lock');
  const files = traceFiles(root).filter((file) => fs.statSync(file).isFile());
  assert.equal(files.length, 20);
  const newFiles = files.filter((file) => !path.basename(file).startsWith('console-lock-20250101'));
  assert.equal(newFiles.length, 2);
  assert.ok(newFiles.every((file) => fs.readFileSync(file, 'utf8').includes('"event":"FINAL"')));
  assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(directory, 'console-lock-not-ours.jsonl'), 'utf8'), 'keep');
  assert.equal(fs.statSync(path.join(directory, 'console-lock-20250101T000000000Z-ffffffffffffffffffffffffffffffff.jsonl')).isDirectory(), true);
});

test('failed lock retries keep trace size bounded and finish with a fixed failure', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
function Request-PhotoLocalWorkstationLock { $script:locks++; throw 'private error with credentials' }
$result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 'LOCK_REQUEST_FAILED');
  assert.equal(result.locks, 15);
  const text = fs.readFileSync(traceFiles(root)[0], 'utf8');
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.length <= 64);
  assert.ok(Buffer.byteLength(text) < 16384);
  assert.equal(text.includes('credentials'), false);
  assert.equal(events.at(-1).status, 'LOCK_REQUEST_FAILED');
  assert.equal(events.at(-1).exitCode, 5);
});

test('retention remains bounded when old filenames have future timestamps', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`, { prepare: (root) => {
    const directory = path.join(root, 'PhotoLocal', 'console-lock');
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 20; index++) {
      fs.writeFileSync(path.join(directory, `console-lock-20990101T000000000Z-${index.toString(16).padStart(32, '0')}.jsonl`), '{}\n');
    }
  } });
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  const files = traceFiles(root);
  assert.equal(files.length, 20);
  assert.equal(files.filter((file) => fs.readFileSync(file, 'utf8').includes('"event":"FINAL"')).length, 1);
});

test('a redirected trace directory is untouched and does not prevent locking', windowsOnly, (t) => {
  const { root, result } = traceScenario(t, `
$result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid ${literal(sid)}
@{ status = $result.status; locks = $script:locks } | ConvertTo-Json -Compress
`, { prepare: (root) => {
    const target = path.join(root, 'redirect-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'PhotoLocal'), 'junction');
  } });
  assert.equal(result.status, 'LOCK_REQUEST_ACCEPTED');
  assert.equal(result.locks, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'redirect-target')), []);
});

test('requests lock for the expected user on the physical console', windowsOnly, () => {
  const actual = runScenario();
  assert.deepEqual(actual.result, { status: 'LOCK_REQUEST_ACCEPTED', attempts: 1, exitCode: 0 });
  assert.equal(actual.lockRequests, 1);
  assert.equal(actual.waits, 0);
});

test('does not lock another user or call the console API for a wrong SID', windowsOnly, () => {
  const actual = runScenario({ currentSid: 'S-1-5-21-111-222-333-1002' });
  assert.deepEqual(actual.result, { status: 'WRONG_USER', attempts: 0, exitCode: 2 });
  assert.equal(actual.consoleReads, 0);
  assert.equal(actual.lockRequests, 0);
});

test('does not lock a remote session when a different console is active', windowsOnly, () => {
  const actual = runScenario({ sessionId: 4, consoles: [1] });
  assert.deepEqual(actual.result, {
    status: 'NON_CONSOLE_SESSION_SKIPPED', attempts: 1, exitCode: 0,
  });
  assert.equal(actual.lockRequests, 0);
  assert.equal(actual.waits, 0);
});

test('refuses noninteractive session zero', windowsOnly, () => {
  const actual = runScenario({ sessionId: 0, consoles: [0] });
  assert.deepEqual(actual.result, { status: 'NON_INTERACTIVE_SESSION', attempts: 0, exitCode: 3 });
  assert.equal(actual.consoleReads, 0);
  assert.equal(actual.lockRequests, 0);
});

test('waits for a console to attach before requesting a lock', windowsOnly, () => {
  const actual = runScenario({ consoles: [4294967295, 4294967295, 1] });
  assert.deepEqual(actual.result, { status: 'LOCK_REQUEST_ACCEPTED', attempts: 3, exitCode: 0 });
  assert.equal(actual.lockRequests, 1);
  assert.equal(actual.waits, 2);
});

test('stops after a bounded wait when no console attaches', windowsOnly, () => {
  const actual = runScenario({ consoles: [4294967295] });
  assert.deepEqual(actual.result, { status: 'CONSOLE_NOT_READY', attempts: 15, exitCode: 4 });
  assert.equal(actual.consoleReads, 15);
  assert.equal(actual.lockRequests, 0);
  assert.equal(actual.waits, 14);
});

test('retries rejected lock requests until Windows accepts one', windowsOnly, () => {
  const actual = runScenario({ locks: ['$false', '$false', '$true'] });
  assert.deepEqual(actual.result, { status: 'LOCK_REQUEST_ACCEPTED', attempts: 3, exitCode: 0 });
  assert.equal(actual.lockRequests, 3);
  assert.equal(actual.waits, 2);
});

test('checks console attachment again after a rejected lock and skips RDP', windowsOnly, () => {
  const actual = runScenario({ consoles: [1, 4], locks: ['$false'] });
  assert.deepEqual(actual.result, {
    status: 'NON_CONSOLE_SESSION_SKIPPED', attempts: 2, exitCode: 0,
  });
  assert.equal(actual.lockRequests, 1);
});

test('reports failed lock requests without retrying indefinitely', windowsOnly, () => {
  const actual = runScenario({ locks: ['$false'] });
  assert.deepEqual(actual.result, { status: 'LOCK_REQUEST_FAILED', attempts: 15, exitCode: 5 });
  assert.equal(actual.lockRequests, 15);
  assert.equal(actual.waits, 14);
});

test('returns a fixed status when identity discovery fails', windowsOnly, () => {
  const actual = runScenario({ identityError: true });
  assert.deepEqual(actual.result, { status: 'LOCK_CHECK_FAILED', attempts: 0, exitCode: 6 });
  assert.equal(actual.lockRequests, 0);
});

test('returns a fixed status if the console API fails', windowsOnly, () => {
  const actual = runScenario({ consoleError: true });
  assert.deepEqual(actual.result, { status: 'LOCK_CHECK_FAILED', attempts: 1, exitCode: 6 });
  assert.equal(actual.lockRequests, 0);
});

test('bounds exceptions from the lock API without exposing exception text', windowsOnly, () => {
  const actual = runScenario({ lockError: true });
  assert.deepEqual(actual.result, { status: 'LOCK_REQUEST_FAILED', attempts: 15, exitCode: 5 });
  assert.equal(actual.lockRequests, 15);
  assert.equal(JSON.stringify(actual).includes('private error'), false);
});

test('native declarations compile under Windows PowerShell 5 without requesting a lock', windowsOnly, () => {
  const actual = powershell(`
$ErrorActionPreference = 'Stop'
. ${literal(runner)} -ExpectedSid ${literal(sid)}
Initialize-PhotoLocalLockNativeApi
$type = 'PhotoLocal.AutologonNative' -as [type]
$lockMethod = $type.GetMethod('LockWorkStation')
$consoleMethod = $type.GetMethod('WTSGetActiveConsoleSessionId')
$attributeType = [System.Runtime.InteropServices.DllImportAttribute]
[pscustomobject]@{
  major = $PSVersionTable.PSVersion.Major
  lockDll = $lockMethod.GetCustomAttributes($attributeType, $false)[0].Value
  lockReturn = $lockMethod.ReturnType.FullName
  consoleDll = $consoleMethod.GetCustomAttributes($attributeType, $false)[0].Value
  consoleReturn = $consoleMethod.ReturnType.FullName
} | ConvertTo-Json -Compress
`);
  assert.deepEqual(actual, {
    major: 5,
    lockDll: 'user32.dll',
    lockReturn: 'System.Boolean',
    consoleDll: 'kernel32.dll',
    consoleReturn: 'System.UInt32',
  });
});
