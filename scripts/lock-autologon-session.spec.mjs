import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64'),
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
