import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const sentinel = 'SYNTHETIC_PRIVATE_$\'"\\zażółć 🔑';
const expectedPayload = {
  server: '192.0.2.70',
  share: 'Photos',
  subdirectory: 'Projects',
  username: 'photo user',
  domain: 'EXAMPLE-PC',
  password: sentinel,
  image: 'photolocal:staging',
};

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWrapper(context, helperSource, checkFilesAndWrite = false) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'photolocal smb wrapper '));
  context.after(() => {
    const absoluteDirectory = resolve(directory);
    assert.ok(absoluteDirectory.startsWith(`${temporaryRoot}${sep}`));
    assert.notEqual(absoluteDirectory, temporaryRoot);
    rmSync(absoluteDirectory, { recursive: true, force: true });
  });
  copyFileSync(join(scriptsDirectory, 'test-smb-access.ps1'), join(directory, 'test-smb-access.ps1'));
  writeFileSync(join(directory, 'test-smb-access.mjs'), helperSource, 'utf8');
  const runner = `
$ErrorActionPreference = 'Stop'
function Get-Credential {
  param([string]$UserName, [string]$Message)
  $syntheticPassword = New-Object System.Security.SecureString
  foreach ($syntheticCharacter in ${powershellLiteral(sentinel)}.ToCharArray()) { $syntheticPassword.AppendChar($syntheticCharacter) }
  return New-Object System.Management.Automation.PSCredential('EXAMPLE-PC\\photo user', $syntheticPassword)
}
& (Join-Path $PSScriptRoot 'test-smb-access.ps1') -Server '192.0.2.70' -Share 'Photos' -Subdirectory 'Projects' -UserName 'EXAMPLE-PC\\photo user' -Image 'photolocal:staging' ${checkFilesAndWrite ? '-CheckFilesAndWrite' : ''}
`;
  const runnerPath = join(directory, 'runner.ps1');
  writeFileSync(runnerPath, `\uFEFF${runner}`, 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
  });
  assert.ok(!result.error, 'PowerShell wrapper must finish within its test timeout');
  assert.equal(result.status, 0, 'PowerShell runner must finish successfully');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes('SYNTHETIC_PRIVATE_'), 'Wrapper must not expose any credential sentinel');
  assert.ok(existsSync(join(directory, 'helper-started')), 'Fake helper must actually run before testing wrapper behavior');
  return output;
}

for (const checkFilesAndWrite of [false, true]) {
test(`Windows PowerShell 5 wrapper preserves private UTF-8 credentials and write opt-in=${checkFilesAndWrite}`, {
  skip: process.platform !== 'win32',
}, (context) => {
  const output = runWrapper(context, `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('./helper-started', import.meta.url), 'started');
const input = JSON.parse(readFileSync(0, 'utf8'));
const expected = ${JSON.stringify({ ...expectedPayload, checkFilesAndWrite })};
const matches = Object.entries(expected).every(([key, value]) => input[key] === value);
const validId = /^photolocal-smb-probe-[a-f0-9]+$/.test(input.probeId);
if (!matches || !validId) process.exit(1);
process.stdout.write(JSON.stringify({ status: ${JSON.stringify(checkFilesAndWrite ? 'STORAGE_READ_WRITE_OK' : 'DIRECTORY_READ_OK')}, cleanup: 'CLEAN', probeId: input.probeId }));
`, checkFilesAndWrite);
  const expectedStatus = checkFilesAndWrite ? 'STORAGE_READ_WRITE_OK' : 'DIRECTORY_READ_OK';
  assert.ok(new RegExp(`Status\\s*:\\s*${expectedStatus}`).test(output), 'Wrapper must display the validated success status');
  assert.ok(/Cleanup\s*:\s*CLEAN/.test(output), 'Wrapper must display validated cleanup status');
  assert.ok(!output.includes('PROBE_LAUNCH_FAILED'), 'Credential transport must succeed');
});
}

test('Windows PowerShell wrapper suppresses secret-bearing raw child output and stack traces', {
  skip: process.platform !== 'win32',
}, (context) => {
  const output = runWrapper(context, `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('./helper-started', import.meta.url), 'started');
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write('invalid-report ' + input.password);
process.stderr.write('RAW_STACK_SENTINEL Error: ' + input.password + '\\n    at privateHelper (fake:1:1)');
process.exitCode = 1;
`);
  assert.ok(output.includes('PROBE_LAUNCH_FAILED'), 'Wrapper must report only its fixed launch-failure code');
  assert.ok(!output.includes('RAW_STACK_SENTINEL'), 'Wrapper must hide raw child stack traces');
  assert.ok(!output.includes('invalid-report'), 'Wrapper must hide malformed child stdout');
  assert.ok(!output.includes('privateHelper'), 'Wrapper must hide stack frames');
});
