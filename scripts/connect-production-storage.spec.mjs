import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectProductionStorage } from './connect-production-storage.mjs';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const probeId = 'photolocal-smb-probe-0123456789abcdef0123456789abcdef';
const volumeName = 'photolocal-production-nas-0123456789abcdef0123456789abcdef';
const sentinel = 'SYNTHETIC_PRIVATE_$\'"\\zażółć 🔑';
const credentials = { server: '192.0.2.70', share: 'Photos', subdirectory: 'Projects', username: 'photo user', domain: 'EXAMPLE-PC', password: sentinel, image: 'photolocal:staging' };
const success = { code: 0, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\nSTORAGE_READ_WRITE_OK\n', stderr: '', timedOut: false };
const absent = { code: 1, stdout: '', stderr: 'Error: No such volume', timedOut: false };

function temporaryDirectory(context) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, 'photolocal production storage '));
  context.after(() => {
    assert.ok(resolve(directory).startsWith(`${root}${sep}`));
    assert.notEqual(resolve(directory), root);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function dockerSequence(results, containerInspection = { ...absent, stderr: 'Error: No such container' }) {
  const calls = [];
  return { calls, invoke: async (args, stdin, timeout) => {
    calls.push({ args, stdin, timeout });
    if (args[0] === 'container' && args[1] === 'inspect') return containerInspection;
    const result = results.shift();
    assert.ok(result, 'No unexpected Docker calls');
    if (result instanceof Error) throw result;
    return result;
  } };
}

test('successful connection publishes a credential-free manifest and retains only the verified read-write volume', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  writeFileSync(join(outputDirectory, 'storage.json'), 'existing read-only staging manifest');
  const fake = dockerSequence([absent, success, success]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'PRODUCTION_STORAGE_READY');
  assert.equal(report.cleanup, 'CLEAN');
  assert.equal(report.volumeName, volumeName);
  assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, 'production-storage.json'), 'utf8')), {
    version: 2, accessMode: 'rw', volumeName, containerPath: '/nas', subdirectory: 'Projects',
  });
  assert.deepEqual(readdirSync(outputDirectory).sort(), ['production-storage.json', 'storage.json']);
  assert.equal(readFileSync(join(outputDirectory, 'storage.json'), 'utf8'), 'existing read-only staging manifest');
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(fake.calls[0].args, ['volume', 'inspect', '--format', '{{.Name}}', volumeName]);
  assert.deepEqual(fake.calls[1].args, ['container', 'inspect', '--format', '{{.Name}}', probeId]);
  assert.deepEqual(fake.calls[3].args, ['container', 'rm', '--force', probeId]);
  const config = JSON.parse(fake.calls[2].stdin);
  assert.equal(config.volumes.remote.name, volumeName);
  assert.ok(config.volumes.remote.driver_opts.o.startsWith('rw,'));
  assert.equal(config.services.probe.volumes[0].read_only, false);
  assert.equal(config.services.probe.read_only, true);
  assert.equal(config.services.probe.network_mode, 'none');
  assert.equal(config.services.probe.user, '1000:1000');
  assert.equal(config.services.probe.command.at(-1), probeId);
  assert.ok(config.services.probe.command[1].includes('TEST_FOLDER_CLEANUP_REQUIRED'));
  assert.ok(!readFileSync(report.manifestPath, 'utf8').includes('SYNTHETIC_PRIVATE_'));
  assert.ok(!JSON.stringify(fake.calls.map(({ args }) => args)).includes('SYNTHETIC_PRIVATE_'));
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE_'));
});

test('an existing manifest is never overwritten and prevents any Docker operation', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  writeFileSync(join(outputDirectory, 'production-storage.json'), 'existing');
  const fake = dockerSequence([]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_MANIFEST_EXISTS');
  assert.equal(report.cleanup, 'NOT_NEEDED');
  assert.equal(readFileSync(join(outputDirectory, 'production-storage.json'), 'utf8'), 'existing');
  assert.equal(fake.calls.length, 0);
});

test('a pre-existing Docker volume is neither reused nor removed', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([success]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_RESOURCE_EXISTS');
  assert.equal(report.cleanup, 'NOT_NEEDED');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(readdirSync(outputDirectory), []);
});

test('a pre-existing probe container is never removed', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([absent], success);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_RESOURCE_EXISTS');
  assert.equal(report.cleanup, 'NOT_NEEDED');
  assert.ok(fake.calls.every(({ args }) => args[1] === 'inspect'));
  assert.deepEqual(readdirSync(outputDirectory), []);
});

for (const [result, status, cleanup] of [
  [{ code: 1, stdout: '', stderr: `permission denied password=${sentinel}`, timedOut: false }, 'MOUNT_ACCESS_DENIED', 'CLEAN'],
  [{ code: 5, stdout: 'PROBE_STARTED\nDIRECTORY_ACCESS_DENIED\n', stderr: sentinel, timedOut: false }, 'DIRECTORY_ACCESS_DENIED', 'CLEAN'],
  [{ ...success, code: 1 }, 'OTHER_ERROR', 'REQUIRED'],
  [{ code: null, stdout: '', stderr: sentinel, timedOut: true }, 'TIMEOUT', 'REQUIRED'],
  [new Error(sentinel), 'OTHER_ERROR', 'REQUIRED'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\nTEST_FOLDER_CLEANUP_REQUIRED\n' }, 'TEST_FOLDER_CLEANUP_REQUIRED', 'REQUIRED'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\nSTORAGE_WRITE_DENIED\n', code: 1 }, 'STORAGE_WRITE_DENIED', 'CLEAN'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_SAMPLE_NOT_FOUND\n', code: 1 }, 'PHOTO_SAMPLE_NOT_FOUND', 'CLEAN'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\nSTORAGE_PROBE_ERROR\n', code: 1 }, 'STORAGE_PROBE_ERROR', 'CLEAN'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\n', code: 137, stderr: 'permission denied' }, 'OTHER_ERROR', 'REQUIRED'],
  [{ ...success, stdout: 'PROBE_STARTED\nDIRECTORY_READ_OK\n' }, 'OTHER_ERROR', 'REQUIRED'],
  [{ ...success, stdout: 'PROBE_STARTED\nSTORAGE_READ_WRITE_OK\n' }, 'OTHER_ERROR', 'REQUIRED'],
  [{ ...success, stdout: 'PROBE_STARTED\nPHOTO_READ_OK\nSTORAGE_READ_WRITE_OK\nTEST_FOLDER_CLEANUP_REQUIRED\n' }, 'TEST_FOLDER_CLEANUP_REQUIRED', 'REQUIRED'],
]) {
  test(`failed connection ${status} cleans only its exact owned resources without publishing`, async (context) => {
    const outputDirectory = temporaryDirectory(context);
    const fake = dockerSequence([absent, result, success, success]);
    const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
    assert.equal(report.status, status);
    assert.equal(report.cleanup, cleanup);
    assert.deepEqual(fake.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args), [
      ['container', 'rm', '--force', probeId], ['volume', 'rm', volumeName],
    ]);
    assert.deepEqual(readdirSync(outputDirectory), []);
    assert.ok(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE_'));
  });
}

test('failed temporary container removal prevents publication and reports cleanup required', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([absent, success, { code: 1, stdout: '', stderr: sentinel }, success]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_CLEANUP_FAILED');
  assert.equal(report.cleanup, 'REQUIRED');
  assert.deepEqual(readdirSync(outputDirectory), []);
});

test('publication collision preserves the other manifest and removes only the newly created volume', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([absent, success, success, success]);
  const invoke = async (...args) => {
    const result = await fake.invoke(...args);
    if (args[0][0] === 'compose') writeFileSync(join(outputDirectory, 'production-storage.json'), 'other process');
    return result;
  };
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { invoke, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_MANIFEST_EXISTS');
  assert.equal(report.cleanup, 'CLEAN');
  assert.equal(readFileSync(join(outputDirectory, 'production-storage.json'), 'utf8'), 'other process');
  assert.deepEqual(readdirSync(outputDirectory), ['production-storage.json']);
  assert.deepEqual(fake.calls.at(-1).args, ['volume', 'rm', volumeName]);
});

test('publication temp collision never deletes a pre-existing file', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const temporaryPath = join(outputDirectory, `production-storage.json.${probeId}.tmp`);
  writeFileSync(temporaryPath, 'existing private file');
  const fake = dockerSequence([absent, success, success, success]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'STORAGE_MANIFEST_EXISTS');
  assert.equal(readFileSync(temporaryPath, 'utf8'), 'existing private file');
  assert.ok(!existsSync(join(outputDirectory, 'production-storage.json')));
});

test('unsupported credentials and unsafe resource IDs fail before Docker', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  for (const [input, options, expected] of [
    [{ ...credentials, password: 'a,b' }, { probeId, volumeName }, 'CREDENTIAL_FORMAT_UNSUPPORTED'],
    [credentials, { probeId, volumeName: 'production' }, 'INVALID_INPUT'],
    [credentials, { probeId, volumeName: 'photolocal-staging-nas-0123456789abcdef0123456789abcdef' }, 'INVALID_INPUT'],
    [credentials, { probeId: 'production', volumeName }, 'INVALID_INPUT'],
    [{ ...credentials, checkFilesAndWrite: true }, { probeId, volumeName }, 'INVALID_INPUT'],
  ]) {
    const fake = dockerSequence([]);
    const report = await connectProductionStorage({ ...input, outputDirectory }, { ...fake, ...options });
    assert.equal(report.status, expected);
    assert.equal(fake.calls.length, 0);
  }
});

test('uncertain resource inspection stops before creation or cleanup', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([{ ...absent, timedOut: true }]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.status, 'TIMEOUT');
  assert.equal(report.cleanup, 'NOT_NEEDED');
  assert.equal(fake.calls.length, 1);
});

test('failed retained-volume removal is reported without any unrelated cleanup', async (context) => {
  const outputDirectory = temporaryDirectory(context);
  const fake = dockerSequence([absent, { ...success, code: 1 }, success, { code: 1, stdout: '', stderr: sentinel }]);
  const report = await connectProductionStorage({ ...credentials, outputDirectory }, { ...fake, probeId, volumeName });
  assert.equal(report.cleanup, 'REQUIRED');
  assert.equal(report.manifestPath, '');
  assert.deepEqual(fake.calls.at(-1).args, ['volume', 'rm', volumeName]);
});

function psLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

function runWrapper(context, helper, existingManifest = false, unicodeOutputDirectory = false) {
  const directory = temporaryDirectory(context);
  const outputDirectory = unicodeOutputDirectory ? join(directory, 'zdjęcia zażółć') : directory;
  if (unicodeOutputDirectory) mkdirSync(outputDirectory);
  copyFileSync(join(scriptsDirectory, 'connect-production-storage.ps1'), join(directory, 'connect-production-storage.ps1'));
  writeFileSync(join(directory, 'connect-production-storage.mjs'), helper, 'utf8');
  if (existingManifest) writeFileSync(join(directory, 'production-storage.json'), 'existing');
  writeFileSync(join(directory, 'runner.ps1'), `\uFEFF
$ErrorActionPreference = 'Stop'
${unicodeOutputDirectory ? '[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(852)' : ''}
function Get-Credential {
  param([string]$UserName, [string]$Message)
  Set-Content -LiteralPath (Join-Path $PSScriptRoot 'prompted') -Value 'yes'
  $syntheticPassword = New-Object System.Security.SecureString
  foreach ($syntheticCharacter in ${psLiteral(sentinel)}.ToCharArray()) { $syntheticPassword.AppendChar($syntheticCharacter) }
  return New-Object System.Management.Automation.PSCredential('EXAMPLE-PC\\photo user', $syntheticPassword)
}
& (Join-Path $PSScriptRoot 'connect-production-storage.ps1') -Server '192.0.2.70' -Share 'Photos' -Subdirectory 'Projects' -UserName 'EXAMPLE-PC\\photo user' -OutputDirectory ${psLiteral(outputDirectory)}
exit $LASTEXITCODE
`, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'runner.ps1')], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
  });
  assert.ok(!result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes('SYNTHETIC_PRIVATE_'));
  return { directory, output, exitCode: result.status };
}

test('Windows PowerShell 5 transports credentials privately and renders only validated fields', { skip: process.platform !== 'win32' }, (context) => {
  const result = runWrapper(context, `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(new URL('./helper-started', import.meta.url), 'started');
const input = JSON.parse(readFileSync(0, 'utf8'));
const expected = ${JSON.stringify(credentials)};
if (!Object.entries(expected).every(([key,value]) => input[key] === value)) process.exit(1);
process.stdout.write(JSON.stringify({ status: 'PRODUCTION_STORAGE_READY', cleanup: 'CLEAN', probeId: input.probeId, volumeName: input.volumeName, manifestPath: join(input.outputDirectory, 'production-storage.json') }));
`);
  assert.ok(existsSync(join(result.directory, 'helper-started')));
  assert.match(result.output, /Status\s*:\s*PRODUCTION_STORAGE_READY/);
  assert.equal(result.exitCode, 0);
});

test('Windows wrapper refuses an existing manifest before asking for credentials', { skip: process.platform !== 'win32' }, (context) => {
  const result = runWrapper(context, 'throw new Error("must not start");', true);
  assert.ok(!existsSync(join(result.directory, 'prompted')));
  assert.match(result.output, /STORAGE_MANIFEST_EXISTS/);
  assert.equal(result.exitCode, 1);
});

test('Windows PowerShell 5 decodes a UTF-8 manifest path even with an OEM 852 console', { skip: process.platform !== 'win32' }, (context) => {
  const result = runWrapper(context, `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(new URL('./helper-started', import.meta.url), 'started');
const input = JSON.parse(readFileSync(0, 'utf8'));
if (!input.outputDirectory.endsWith('zdjęcia zażółć')) process.exit(1);
process.stdout.write(JSON.stringify({ status: 'PRODUCTION_STORAGE_READY', cleanup: 'CLEAN', probeId: input.probeId, volumeName: input.volumeName, manifestPath: join(input.outputDirectory, 'production-storage.json') }));
`, false, true);
  assert.ok(existsSync(join(result.directory, 'helper-started')));
  assert.match(result.output, /Status\s*:\s*PRODUCTION_STORAGE_READY/);
  assert.equal(result.exitCode, 0);
});

test('Windows wrapper suppresses raw stdout and stderr even when helper fails', { skip: process.platform !== 'win32' }, (context) => {
  const result = runWrapper(context, `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('./helper-started', import.meta.url), 'started');
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write('INVALID_REPORT ' + input.password);
process.stderr.write('RAW_PRIVATE_STACK ' + input.password);
process.exitCode = 1;
`);
  assert.ok(existsSync(join(result.directory, 'helper-started')));
  assert.match(result.output, /STORAGE_LAUNCH_FAILED/);
  assert.ok(!result.output.includes('RAW_PRIVATE_STACK'));
  assert.equal(result.exitCode, 1);
});
