import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./inspect-production-before-cutover.ps1', import.meta.url));
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

function inspect(t, { missingEnv = false, unreadableEnv = false, listenerId = 4242, overrides = '' } = {}) {
  // PowerShell expands 8.3 TEMP aliases; mocks must use the same physical path.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'photolocal inventory ')));
  t.after(() => {
    assert.ok(resolve(root).startsWith(`${realpathSync.native(tmpdir())}${sep}`));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'backend', 'dist'), { recursive: true });
  writeFileSync(join(root, 'backend', 'dist', 'server.js'), '');
  writeFileSync(join(root, 'photo-local.pid'), '4242');
  if (!missingEnv) writeFileSync(join(root, '.env'), [
    'ADRESY_APP_API_KEY=NEVER_PRINT_THIS_SECRET',
    'OLLAMA_URL=http://user:NEVER_PRINT_THIS_SECRET@example.invalid',
    '# PHOTO_LOCAL_PORT=9999',
    'export OLLAMA_VISION_MODEL=custom-model',
    'UNRECOGNIZED_SECRET_KEY=NEVER_PRINT_THIS_SECRET',
    overrides,
  ].join('\n'));
  const harness = join(root, 'test.ps1');
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
# Import system commands before mocking: module autoload must not replace mocks.
Import-Module ScheduledTasks, NetTCPIP, CimCmdlets, Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'
. ${literal(script)}
${unreadableEnv ? `function Get-Content {
  param($LiteralPath, [switch]$Raw, $Encoding)
  if ($LiteralPath -eq ${literal(join(root, '.env'))}) { throw 'NEVER_PRINT_THIS_SECRET' }
  Microsoft.PowerShell.Management\\Get-Content -LiteralPath $LiteralPath -Raw:$Raw -ErrorAction Stop
}` : ''}
function Get-NetTCPConnection { [pscustomobject]@{LocalAddress='0.0.0.0'; LocalPort=4873; OwningProcess=${listenerId}} }
function Get-CimInstance {
  param($ClassName)
  if ($ClassName -eq 'Win32_LogicalDisk') { return [pscustomobject]@{DeviceID='C:'; FreeSpace=123456789} }
  @(
    [pscustomobject]@{ProcessId=4242; ParentProcessId=333; Name='node.exe'; ExecutablePath='C:\\node.exe'; CreationDate=[datetime]'2026-09-10T10:00:00'; CommandLine='"C:\\node.exe" dist/server.js NEVER_PRINT_THIS_SECRET'},
    [pscustomobject]@{ProcessId=4243; ParentProcessId=4242; Name='python.exe'; ExecutablePath='C:\\python.exe'; CreationDate=[datetime]'2026-09-10T10:01:00'; CommandLine='python downloader.py NEVER_PRINT_THIS_SECRET'},
    [pscustomobject]@{ProcessId=999; ParentProcessId=2; Name='python.exe'; ExecutablePath='C:\\python.exe'; CreationDate=[datetime]'2026-09-10T10:01:00'; CommandLine='unrelated NEVER_PRINT_THIS_SECRET'}
  )
}
function Get-ScheduledTask {
  [pscustomobject]@{State='Ready'; Settings=[pscustomobject]@{Enabled=$true}; Principal=[pscustomobject]@{LogonType='Interactive'}; Actions=@([pscustomobject]@{Execute='powershell.exe'; Arguments='-File "${root.replaceAll('\\', '\\')}\\scripts\\start-autostart.ps1" NEVER_PRINT_THIS_SECRET'})}
}
function Get-ScheduledTaskInfo { [pscustomobject]@{LastRunTime=[datetime]'2026-09-10T10:00:00'; LastTaskResult=0} }
Get-PhotoLocalProductionInventory -ProductionRoot ${literal(root)} | ConvertTo-Json -Depth 8
`, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_PRINT_THIS_SECRET|UNRECOGNIZED_SECRET_KEY/);
  return JSON.parse(result.stdout);
}

test('inventory exposes configuration presence and scoped process metadata, never values', { skip: process.platform !== 'win32' }, (t) => {
  const report = inspect(t);
  assert.equal(report.status, 'READ_ONLY_INVENTORY');
  assert.equal(report.environmentFile.status, 'READ');
  assert.deepEqual(report.environmentFile.declaredSettings, ['ADRESY_APP_API_KEY', 'OLLAMA_URL', 'OLLAMA_VISION_MODEL']);
  assert.equal(report.listeners[0].matchesPidFile, true);
  assert.equal(report.listeners[0].containsExpectedEntrypoint, true);
  assert.deepEqual(report.listeners[0].descendants.map((item) => item.processId), [4243]);
  assert.equal(report.autostart.containsExpectedScriptPath, true);
  assert.equal(report.readiness, 'NOT_ASSESSED');
});

test('stale PID or unknown listener is not treated as a verified production process', { skip: process.platform !== 'win32' }, (t) => {
  const report = inspect(t, { listenerId: 777 });
  assert.equal(report.listeners[0].matchesPidFile, false);
  assert.equal(report.listeners[0].processMetadataAvailable, false);
  assert.equal(report.listeners[0].containsExpectedEntrypoint, false);
  assert.deepEqual(report.listeners[0].descendants, []);
});

test('missing environment and custom data locations remain explicit uncertainties', { skip: process.platform !== 'win32' }, (t) => {
  const absent = inspect(t, { missingEnv: true });
  assert.equal(absent.environmentFile.status, 'MISSING');
  assert.equal(absent.environmentFile.liveProcessOverrides, 'NOT_INSPECTED');
  const custom = inspect(t, { overrides: 'PHOTO_LOCAL_DB=C:\\private\\NEVER_PRINT_THIS_SECRET.sqlite' });
  assert.equal(custom.defaultLocations.database.configurationOverrideDeclared, true);
  assert.equal(custom.defaultLocations.database.isResolvedLivePath, false);
});

test('unreadable environment reports unknown overrides instead of absent overrides', { skip: process.platform !== 'win32' }, (t) => {
  const report = inspect(t, { unreadableEnv: true });
  assert.equal(report.environmentFile.status, 'UNAVAILABLE');
  assert.equal(report.defaultLocations.database.configurationOverrideDeclared, null);
  assert.equal(report.defaultLocations.downloads.configurationOverrideDeclared, null);
  assert.equal(report.defaultLocations.localPhotos.configurationOverrideDeclared, false);
});

test('inventory fixtures also work when Windows TEMP uses an 8.3 short-path alias', { skip: process.platform !== 'win32' }, (t) => {
  const temporaryRoot = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(temporaryRoot, 'photolocal inventory short-path ')));
  t.after(() => {
    assert.ok(resolve(root).startsWith(`${resolve(temporaryRoot)}${sep}`));
    rmSync(root, { recursive: true, force: true });
  });
  const shortPath = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${literal(root)}).ShortPath`],
  { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(shortPath.status, 0, shortPath.stderr);
  const alias = shortPath.stdout.trim();
  assert.equal(realpathSync.native(alias), root);
  if (alias.toLowerCase() === root.toLowerCase()) {
    t.skip('The temporary volume does not provide 8.3 aliases.');
    return;
  }
  const result = spawnSync(process.execPath, ['--test',
    '--test-name-pattern=^(inventory exposes|unreadable environment)', fileURLToPath(import.meta.url)], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMP: alias, TEMP: alias },
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests 2(?:\r?\n|$)/, result.stdout + result.stderr);
});
