import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const wrapper = fileURLToPath(new URL('./prepare-production-deployment.ps1', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windows = { skip: process.platform !== 'win32' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'photolocal-production-wrapper-'));
  const production = join(root, 'production');
  const staging = join(root, 'staging');
  mkdirSync(production);
  mkdirSync(join(staging, 'docker-data'), { recursive: true });
  mkdirSync(join(staging, 'scripts'));
  writeFileSync(join(staging, 'scripts', 'prepare-production-deployment.mjs'), '// Fixture only; never executed.');
  t.after(() => {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.match(basename(root), /^photolocal-production-wrapper-/);
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    assert.equal(realpathSync(root).toLowerCase(), resolve(root).toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  return { root, production, staging };
}

function ps(body) {
  const source = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\nImport-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility,CimCmdlets\n$PSModuleAutoLoadingPreference='None'\n. ${quote(wrapper)} -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'\n${body}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_PRINT_THIS_SECRET/);
  return JSON.parse(result.stdout.trim());
}

function setup(f, extra = '') {
  return `
    $production=${quote(f.production)}; $staging=${quote(f.staging)}
    $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    function Get-PhotoLocalDeploymentIdentity { @{Sid=$currentSid;Owners=@($currentSid)} }
    function Get-PhotoLocalDeploymentScopeVariables {
      param($Scope)
      switch ($Scope) {
        Process { @{ ADRESY_APP_API_KEY='NEVER_PRINT_THIS_SECRET'; PHOTO_LOCAL_LOG=''; UNRELATED='NEVER_PRINT_THIS_SECRET' } }
        User { @{ OLLAMA_VISION_MODEL=('za' + [char]0x17c + [char]0xf3 + [char]0x142 + [char]0x107); OTHER_TOKEN='NEVER_PRINT_THIS_SECRET' } }
        Machine { @{ PHOTO_LOCAL_SHARED_ROOTS='[]' } }
      }
    }
    $script:childCalls=0; $script:captured=$null
    function Invoke-PhotoLocalDeploymentNode {
      param($StagingRoot,$RunDirectory,$Payload)
      $script:childCalls++; $script:captured=$Payload
      $report=@{status='PRODUCTION_CONFIG_PREPARED';runDirectory=$RunDirectory;sourceDatabase=(Join-Path $production 'backend\\data\\photo-local.sqlite');localFiles=@{downloads=@{files=2;bytes=123};localPhotos=@{files=3;bytes=456}};requiredFreeBytes=1024;availableFreeBytes=4096;google=@{webClient=$true;refreshTokenCopied=$true;publicCallbackListed=$true};preservedIntegrationSettings=@('ADRESY_APP_API_KEY','OLLAMA_VISION_MODEL');productionCutover='NOT_PERFORMED';nextStep='FINAL_SNAPSHOT_REQUIRED';secret='NEVER_PRINT_THIS_SECRET'}
      $report.sourceCounts=@{projects=32;photos=14000;map_note_photos=0;chat_photo_batches=2800;chat_photo_files=5500}
      ${extra}
      @{ExitCode=0;TimedOut=$false;Stdout=($report | ConvertTo-Json -Depth 8 -Compress);Stderr='NEVER_PRINT_THIS_SECRET'}
    }
  `;
}

test('preparation sends only allowlisted scopes, preserves empty values, and prints a closed safe report', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    $report=Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $production -StagingRoot $staging -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'
    $acl=(New-Object IO.DirectoryInfo($report.runDirectory)).GetAccessControl()
    $sids=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value} | Sort-Object -Unique)
    @{report=$report;childCalls=$script:childCalls;processKeys=@($script:captured.environmentScopes.process.Keys | Sort-Object);emptyPreserved=($script:captured.environmentScopes.process.Contains('PHOTO_LOCAL_LOG') -and $script:captured.environmentScopes.process.PHOTO_LOCAL_LOG -ceq '');unicodePreserved=($script:captured.environmentScopes.user.OLLAMA_VISION_MODEL.Length -eq 6);aclProtected=$acl.AreAccessRulesProtected;aclSids=$sids;expectedSid=$currentSid;privateLogsExist=((Test-Path -LiteralPath (Join-Path $report.runDirectory 'wrapper.stdout.log')) -and (Test-Path -LiteralPath (Join-Path $report.runDirectory 'wrapper.stderr.log')))} | ConvertTo-Json -Depth 10 -Compress
  `);
  assert.equal(result.report.status, 'PRODUCTION_CONFIG_PREPARED');
  assert.equal(result.childCalls, 1);
  assert.deepEqual(result.processKeys, ['ADRESY_APP_API_KEY', 'PHOTO_LOCAL_LOG']);
  assert.equal(result.emptyPreserved, true);
  assert.equal(result.unicodePreserved, true);
  assert.equal(result.aclProtected, true);
  assert.deepEqual(result.aclSids.sort(), ['S-1-5-18', 'S-1-5-32-544', result.expectedSid].sort());
  assert.equal(result.privateLogsExist, true);
  assert.equal(result.report.productionCutover, 'NOT_PERFORMED');
  assert.equal(result.report.localFiles.downloads.bytes, 123);
  assert.equal(result.report.sourceCounts.projects, 32);
  assert.equal('secret' in result.report, false);
});

test('wrong Docker owner fails before creating a run directory or starting Node', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Get-PhotoLocalDeploymentIdentity { @{Sid=$currentSid;Owners=@('S-1-5-21-100-200-300-9999')} }
    $report=Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $production -StagingRoot $staging -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'
    @{report=$report;childCalls=$script:childCalls;runs=@(Get-ChildItem -LiteralPath (Join-Path $staging 'docker-data')).Count} | ConvertTo-Json -Depth 6 -Compress
  `);
  assert.equal(result.report.status, 'WRONG_WINDOWS_ACCOUNT');
  assert.equal(result.childCalls, 0);
  assert.equal(result.runs, 0);
});

test('untrusted child paths, counters, and status text cannot reach the public report', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    $results=@()
    foreach ($case in @('path','counter','source-count','status','keys')) {
      function Invoke-PhotoLocalDeploymentNode {
        param($StagingRoot,$RunDirectory,$Payload)
        $report=@{status='PRODUCTION_CONFIG_PREPARED';runDirectory=$RunDirectory;sourceDatabase=(Join-Path $production 'backend\\data\\photo-local.sqlite');localFiles=@{downloads=@{files=1;bytes=0};localPhotos=@{files=0;bytes=0}};requiredFreeBytes=1;availableFreeBytes=2;google=@{webClient=$true;refreshTokenCopied=$true;publicCallbackListed=$true};preservedIntegrationSettings=@();productionCutover='NOT_PERFORMED';nextStep='FINAL_SNAPSHOT_REQUIRED'}
        $report.sourceCounts=@{projects=32;photos=14000;map_note_photos=0;chat_photo_batches=2800;chat_photo_files=5500}
        if ($case -eq 'path') {$report.sourceDatabase='C:\\NEVER_PRINT_THIS_SECRET.sqlite'}
        if ($case -eq 'counter') {$report.localFiles.downloads.bytes=-1}
        if ($case -eq 'source-count') {$report.sourceCounts.projects=9007199254740992}
        if ($case -eq 'status') {$report.status='NEVER_PRINT_THIS_SECRET'}
        if ($case -eq 'keys') {$report.preservedIntegrationSettings=@('NEVER_PRINT_THIS_SECRET')}
        @{ExitCode=0;TimedOut=$false;Stdout=($report | ConvertTo-Json -Depth 8 -Compress);Stderr='NEVER_PRINT_THIS_SECRET'}
      }
      $report=Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $production -StagingRoot $staging -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'
      $results+=$report.status
    }
    ConvertTo-Json -InputObject @($results) -Compress
  `);
  assert.deepEqual(result, Array(5).fill('INVALID_PREPARATION_REPORT'));
});

test('timeout and sanitized child failures never claim preparation succeeded', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Invoke-PhotoLocalDeploymentNode { @{ExitCode=1;TimedOut=$true;Stdout='NEVER_PRINT_THIS_SECRET';Stderr='NEVER_PRINT_THIS_SECRET'} }
    $timeout=Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $production -StagingRoot $staging -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'
    function Invoke-PhotoLocalDeploymentNode {
      param($StagingRoot,$RunDirectory,$Payload)
      @{ExitCode=1;TimedOut=$false;Stdout=(@{status='SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED';runDirectory=$RunDirectory;settingNames=@('PHOTO_LOCAL_DB','ADRESY_APP_API_KEY');secret='NEVER_PRINT_THIS_SECRET'} | ConvertTo-Json -Compress);Stderr='NEVER_PRINT_THIS_SECRET'}
    }
    $failure=Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $production -StagingRoot $staging -NetworkPrefix 'Z:\\Projects' -PublicUrl 'https://example.invalid'
    @{timeout=$timeout;failure=$failure} | ConvertTo-Json -Depth 7 -Compress
  `);
  assert.equal(result.timeout.status, 'PREPARATION_TIMEOUT');
  assert.equal(result.failure.status, 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED');
  assert.deepEqual(result.failure.settingNames, ['PHOTO_LOCAL_DB', 'ADRESY_APP_API_KEY']);
  assert.equal(result.failure.productionCutover, 'NOT_PERFORMED');
});

test('private directory refuses reuse and reparse ancestors without changing existing files', windows, t => {
  const f = fixture(t);
  const result = ps(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $data=${quote(join(f.staging, 'docker-data'))}
    $name='production-0123456789abcdef0123456789abcdef'
    $created=New-PhotoLocalDeploymentRunDirectory -DataRoot $data -Sid $sid -Name $name
    try { New-PhotoLocalDeploymentRunDirectory -DataRoot $data -Sid $sid -Name $name | Out-Null; $reuse='MISSED' } catch {$reuse=$_.Exception.Message}
    $junction=Join-Path ${quote(f.root)} 'linked-staging'
    New-Item -ItemType Junction -Path $junction -Target ${quote(f.staging)} | Out-Null
    try { Assert-PhotoLocalDeploymentDirectory -Path (Join-Path $junction 'docker-data') | Out-Null; $reparse='MISSED' } catch {$reparse=$_.Exception.Message}
    @{reuse=$reuse;reparse=$reparse;originalExists=(Test-Path -LiteralPath $created)} | ConvertTo-Json -Compress
  `);
  assert.equal(result.reuse, 'PRIVATE_DIRECTORY_EXISTS');
  assert.equal(result.reparse, 'REPARSE_PATH_UNSUPPORTED');
  assert.equal(result.originalExists, true);
});

test('child start info hides the window, carries only the helper argument, and removes source environment keys', windows, () => {
  const result = ps(`
    [Environment]::SetEnvironmentVariable('ADRESY_APP_API_KEY','NEVER_PRINT_THIS_SECRET','Process')
    $info=New-PhotoLocalDeploymentStartInfo -NodePath 'C:\\Node\\node.exe' -HelperPath 'C:\\Staging With Spaces\\scripts\\prepare-production-deployment.mjs' -WorkingDirectory 'C:\\Staging With Spaces'
    @{arguments=$info.Arguments;hidden=$info.CreateNoWindow;noShell=(-not $info.UseShellExecute);stdin=$info.RedirectStandardInput;stdout=$info.RedirectStandardOutput;stderr=$info.RedirectStandardError;hasSourceSecret=$info.EnvironmentVariables.ContainsKey('ADRESY_APP_API_KEY');outputEncoding=$info.StandardOutputEncoding.WebName} | ConvertTo-Json -Compress
  `);
  assert.equal(result.arguments, '"C:\\Staging With Spaces\\scripts\\prepare-production-deployment.mjs"');
  for (const field of ['hidden', 'noShell', 'stdin', 'stdout', 'stderr']) assert.equal(result[field], true);
  assert.equal(result.hasSourceSecret, false);
  assert.equal(result.outputEncoding, 'utf-8');
});

test('a redirected helper directory is rejected before looking up or launching Node', windows, t => {
  const f = fixture(t);
  const result = ps(`
    $linked=Join-Path ${quote(f.root)} 'linked-helper'
    New-Item -ItemType Directory -Path $linked | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $linked 'scripts') -Target ${quote(join(f.staging, 'scripts'))} | Out-Null
    function Get-Command { throw 'UNEXPECTED_NODE_LOOKUP' }
    try { Invoke-PhotoLocalDeploymentNode -StagingRoot $linked -RunDirectory ${quote(join(f.staging, 'docker-data'))} -Payload @{} | Out-Null; $status='MISSED' } catch {$status=$_.Exception.Message}
    @{status=$status} | ConvertTo-Json -Compress
  `);
  assert.equal(result.status, 'REPARSE_PATH_UNSUPPORTED');
});
