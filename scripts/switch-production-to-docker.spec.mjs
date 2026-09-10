import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const wrapper = fileURLToPath(new URL('./switch-production-to-docker.ps1', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windows = { skip: process.platform !== 'win32' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'photolocal-switch-test-'));
  const run = join(root, 'production-0123456789abcdef0123456789abcdef');
  mkdirSync(run);
  t.after(() => {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.match(basename(root), /^photolocal-switch-test-/);
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    assert.equal(realpathSync(root).toLowerCase(), resolve(root).toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  return { root, run };
}

function ps(body) {
  const source = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\nImport-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility,CimCmdlets,NetTCPIP,ScheduledTasks\n$PSModuleAutoLoadingPreference='None'\n. ${quote(wrapper)}\n${body}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_PRINT_THIS_SECRET/);
  return JSON.parse(result.stdout.trim());
}

function setup(f) {
  return `
    $run=${quote(f.run)}; $script:calls=New-Object 'Collections.Generic.List[string]'
    $script:counts=@{projects=32;photos=14396;map_note_photos=0;chat_photo_batches=2878;chat_photo_files=5593}
    $script:plan=@{runDirectory=$run;productionRoot='C:\\PhotoLocal';stagingRoot='C:\\PhotoLocal-staging';imageId=('sha256:' + ('a'*64));publicUrl='https://example.invalid';composeFile=(Join-Path $run 'compose.production.json');emptyEnvironmentFile=(Join-Path $run 'empty.env')}
    function Get-PhotoLocalDeploymentIdentity { $script:calls.Add('identity'); @{Sid='S-1-5-21-1';Owners=@('S-1-5-21-1')} }
    function Get-PhotoLocalCutoverPlan { $script:calls.Add('plan'); $script:plan }
    function Get-PhotoLocalDeploymentEnvironmentScopes { @{process=@{};user=@{};machine=@{}} }
    function Get-PhotoLocalNativeCutoverState { $script:calls.Add('native-check'); @{ProcessId=1234;CreatedUtc='2026-09-10T18:01:13Z';TaskFingerprint='test';TaskEnabled=$true} }
    function Assert-PhotoLocalProductionAbsent { $script:calls.Add('production-absent') }
    function Get-PhotoLocalStagingForCutover { $script:calls.Add('staging-check'); @{id=('b'*64);running=$true} }
    function Invoke-PhotoLocalDataFinalizer {
      param($Plan,$Mode,$EnvironmentScopes)
      $script:calls.Add($Mode)
      @{status=$(if($Mode -eq 'preflight'){'CUTOVER_PREFLIGHT_OK'}else{'FINAL_COPY_VERIFIED'});runDirectory=$run;counts=$script:counts;nasGaps=@{projectFolders=2;photoSamples=21}}
    }
    function Stop-PhotoLocalStagingForCutover { $script:calls.Add('staging-stop') }
    function Stop-PhotoLocalNativeForCutover {
      $script:calls.Add('native-stop')
      [IO.File]::WriteAllText((Join-Path $run 'native-task-disable-intent.json'),'{}')
      [IO.File]::WriteAllText((Join-Path $run 'native-stopped.json'),'{}')
      @{status='NATIVE_STOPPED'}
    }
    function Assert-PhotoLocalCutoverPortFree { $script:calls.Add('port-free') }
    function Start-PhotoLocalProductionCompose {
      $script:calls.Add('docker-up')
      if (-not (Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json'))) {throw 'MISSING_START_BOUNDARY'}
    }
    function Test-PhotoLocalProductionAfterSwitch { $script:calls.Add('verify'); @{status='PRODUCTION_VERIFIED';counts=$script:counts;publicVerified=$true} }
    function Restore-PhotoLocalNativeAfterFailedCutover { $script:calls.Add('restore'); @{status='NATIVE_RESTORED'} }
    function Write-PhotoLocalCutoverMessage { }
  `;
}

test('switch requires the operator work-pause assertion before any discovery or mutation', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'WORK_PAUSE_REQUIRED');
  assert.deepEqual(result.calls, []);
});

test('coordinator orders preflight, isolated stops, fresh copy, irreversible start boundary and verification', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray());saved=(Get-Content -Raw -LiteralPath (Join-Path $run 'cutover-result.json') | ConvertFrom-Json)} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'PRODUCTION_RUNNING');
  assert.equal(result.report.counts.photos, 14396);
  assert.equal(result.report.manualCheckRequired, true);
  assert.equal(result.saved.status, 'PRODUCTION_RUNNING');
  assert.deepEqual(result.calls, ['identity', 'plan', 'native-check', 'production-absent', 'staging-check', 'preflight', 'staging-stop', 'native-stop', 'finalize', 'port-free', 'production-absent', 'docker-up', 'verify']);
});

test('failed preflight leaves both applications untouched and returns only a safe error code', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Invoke-PhotoLocalDataFinalizer { throw 'NEVER_PRINT_THIS_SECRET' }
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'CUTOVER_NOT_STARTED');
  assert.equal(result.report.failureCode, 'CUTOVER_OPERATION_FAILED');
  assert.equal(result.calls.includes('native-stop'), false);
  assert.equal(result.calls.includes('staging-stop'), false);
  assert.equal(result.calls.includes('restore'), false);
});

test('a copy failure after native stop restores native without starting the Docker app', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Invoke-PhotoLocalDataFinalizer {
      param($Plan,$Mode,$EnvironmentScopes)
      $script:calls.Add($Mode)
      if ($Mode -eq 'finalize') { throw 'LOCAL_COPY_SOURCE_CHANGED' }
      @{status='CUTOVER_PREFLIGHT_OK';counts=$script:counts;nasGaps=@{projectFolders=2;photoSamples=21}}
    }
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'CUTOVER_FAILED_NATIVE_RESTORED');
  assert.equal(result.report.failureCode, 'LOCAL_COPY_SOURCE_CHANGED');
  assert.equal(result.calls.at(-1), 'restore');
  assert.equal(result.calls.includes('docker-up'), false);
});

test('a partially failed disable operation triggers recovery from its intent marker', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Stop-PhotoLocalNativeForCutover {
      [IO.File]::WriteAllText((Join-Path $run 'native-task-disable-intent.json'),'{}')
      throw 'NATIVE_STATE_CHANGED'
    }
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'CUTOVER_FAILED_NATIVE_RESTORED');
  assert.equal(result.calls.at(-1), 'restore');
});

test('an uncertain Docker start never restores the old database', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Start-PhotoLocalProductionCompose { $script:calls.Add('docker-up'); throw 'CUTOVER_PROCESS_TIMEOUT' }
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray());boundary=(Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json'))} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'PRODUCTION_NEEDS_ATTENTION');
  assert.equal(result.boundary, true);
  assert.equal(result.calls.includes('restore'), false);
});

test('public verification failure preserves running production and reports attention', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Test-PhotoLocalProductionAfterSwitch { throw 'CUTOVER_PUBLIC_CHECK_FAILED' }
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'PRODUCTION_NEEDS_ATTENTION');
  assert.equal(result.report.failureCode, 'CUTOVER_PUBLIC_CHECK_FAILED');
  assert.equal(result.calls.includes('restore'), false);
});

test('a reused start boundary is refused before stopping anything, without stale recovery', windows, t => {
  const f = fixture(t);
  writeFileSync(join(f.run, 'production-start-attempted.json'), '{}');
  const result = ps(`${setup(f)}
    $report=Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped
    @{report=$report;calls=@($script:calls.ToArray())} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.report.status, 'PRODUCTION_NEEDS_ATTENTION');
  assert.equal(result.report.failureCode, 'CUTOVER_ALREADY_ATTEMPTED');
  assert.equal(result.calls.includes('native-stop'), false);
  assert.equal(result.calls.includes('restore'), false);
});

test('Windows process invocation preserves spaces, Unicode, dollars, quotes and trailing backslashes without a shell', windows, t => {
  const f = fixture(t);
  const helper = join(f.root, 'argument echo.mjs');
  writeFileSync(helper, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),hasSecret:!!process.env.ADRESY_APP_API_KEY}));");
  const values = ['C:\\Folder with spaces\\', 'a"b', 'a\\"b', '$literal$(not-a-command)', 'zażółć'];
  const result = ps(`
    [Environment]::SetEnvironmentVariable('ADRESY_APP_API_KEY','NEVER_PRINT_THIS_SECRET','Process')
    $child=Invoke-PhotoLocalCutoverProcess -Executable ${quote(process.execPath)} -Arguments @(${[helper, ...values].map(quote).join(',')}) -WorkingDirectory ${quote(f.root)} -TimeoutSeconds 10
    $child.Stdout
  `);
  assert.deepEqual(result.args, values);
  assert.equal(result.hasSecret, false);
});

test('selected Docker metadata refuses a mismatched project or port and never exports arbitrary fields', windows, () => {
  const result = ps(`
    $valid=@{id=('b'*64);image=('sha256:' + ('a'*64));project='photolocal-staging';service='photolocal';running=$true;health='healthy';ports=@{'4873/tcp'=@(@{HostIp='127.0.0.1';HostPort='4874'})};secret='NEVER_PRINT_THIS_SECRET'}
    $safe=ConvertTo-PhotoLocalCutoverContainer -Value $valid -Project 'photolocal-staging' -ImageId $valid.image -HostIp '127.0.0.1' -HostPort '4874'
    $valid.project='another-project'
    try { ConvertTo-PhotoLocalCutoverContainer -Value $valid -Project 'photolocal-staging' -ImageId $valid.image -HostIp '127.0.0.1' -HostPort '4874' | Out-Null; $badProject='MISSED' } catch {$badProject=$_.Exception.Message}
    $valid.project='photolocal-staging'; $valid.ports['4873/tcp'][0].HostIp='0.0.0.0'
    try { ConvertTo-PhotoLocalCutoverContainer -Value $valid -Project 'photolocal-staging' -ImageId $valid.image -HostIp '127.0.0.1' -HostPort '4874' | Out-Null; $badPort='MISSED' } catch {$badPort=$_.Exception.Message}
    @{safe=$safe;badProject=$badProject;badPort=$badPort} | ConvertTo-Json -Depth 6 -Compress
  `);
  assert.equal('secret' in result.safe, false);
  assert.equal(result.badProject, 'CUTOVER_CONTAINER_IDENTITY_INVALID');
  assert.equal(result.badPort, 'CUTOVER_CONTAINER_IDENTITY_INVALID');
});

test('failed native recovery reports attention instead of claiming service was restored', windows, t => {
  const f = fixture(t);
  const result = ps(`${setup(f)}
    function Invoke-PhotoLocalDataFinalizer {
      param($Plan,$Mode,$EnvironmentScopes)
      if ($Mode -eq 'finalize') { throw 'LOCAL_COPY_FAILED' }
      @{status='CUTOVER_PREFLIGHT_OK'}
    }
    function Restore-PhotoLocalNativeAfterFailedCutover { throw 'NATIVE_PORT_BUSY' }
    Invoke-PhotoLocalProductionSwitch -RunDirectory $run -WorkStopped | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.status, 'NATIVE_RECOVERY_NEEDS_ATTENTION');
  assert.equal(result.recovery, 'NATIVE_PORT_BUSY');
});

test('production verification checks pinned container, fresh counts and both public health and HTML', windows, t => {
  const f = fixture(t);
  const result = ps(`
    $plan=@{runDirectory=${quote(f.run)};stagingRoot=${quote(f.root)};imageId=('sha256:' + ('a'*64));publicUrl='https://example.invalid'}
    $counts=@{projects=32;photos=14396;map_note_photos=0;chat_photo_batches=2878;chat_photo_files=5593}
    $script:urls=New-Object 'Collections.Generic.List[string]'; $script:dockerCalls=New-Object 'Collections.Generic.List[object]'
    function Invoke-PhotoLocalCutoverDocker {
      param($Plan,$Arguments)
      $script:dockerCalls.Add($Arguments)
      if ($Arguments[0] -eq 'container') {
        $value=@{id=('c'*64);image=$plan.imageId;project='photolocal-production';service='photolocal';running=$true;health='healthy';ports=@{'4873/tcp'=@(@{HostIp='0.0.0.0';HostPort='4873'})}}
      } else { $value=$counts }
      @{ExitCode=0;Stdout=($value | ConvertTo-Json -Depth 8 -Compress)}
    }
    function Get-PhotoLocalCutoverWebResponse {
      param($Url)
      $script:urls.Add($Url)
      if ($Url -like '*health*') { return '{"ok":true}' }
      '<html>' + ('verified content '*10) + '</html>'
    }
    $good=Test-PhotoLocalProductionAfterSwitch -Plan $plan -ExpectedCounts $counts
    function Get-PhotoLocalCutoverWebResponse {
      param($Url)
      if ($Url -like '*health*') { return '{"ok":true}' }
      if ($Url -like 'https:*') { return 'A different service from the proxy' }
      '<html>' + ('verified content '*10) + '</html>'
    }
    try { Test-PhotoLocalProductionAfterSwitch -Plan $plan -ExpectedCounts $counts | Out-Null; $mismatch='MISSED' } catch {$mismatch=$_.Exception.Message}
    @{good=$good;urls=@($script:urls.ToArray());docker=@($script:dockerCalls.ToArray());mismatch=$mismatch} | ConvertTo-Json -Depth 10 -Compress
  `);
  assert.equal(result.good.status, 'PRODUCTION_VERIFIED');
  assert.equal(result.mismatch, 'CUTOVER_PUBLIC_CHECK_FAILED');
  assert.equal(result.urls.length, 4);
  assert.equal(result.urls[0], 'http://127.0.0.1:4873/health');
  assert.match(result.urls[1], /^https:\/\/example.invalid\/health\?cutover=/);
  assert.equal(result.docker[1][0], 'exec');
  assert.equal(result.docker[1][1], 'c'.repeat(64));
  assert.match(result.docker[1][4], /readonly:true/);
});

test('production start passes only the selected prepared project and pinned no-build invocation', windows, t => {
  const f = fixture(t);
  const result = ps(`
    $plan=@{runDirectory=${quote(f.run)};composeFile=${quote(join(f.run, 'compose.production.json'))};emptyEnvironmentFile=${quote(join(f.run, 'empty.env'))}}
    function Invoke-PhotoLocalCutoverDocker { param($Plan,$Arguments,$TimeoutSeconds); $script:captured=$Arguments; @{ExitCode=0} }
    Start-PhotoLocalProductionCompose -Plan $plan
    ConvertTo-Json -InputObject @($script:captured) -Compress
  `);
  assert.deepEqual(result, ['compose', '--ansi', 'never', '-p', 'photolocal-production', '--project-directory', f.run,
    '--env-file', join(f.run, 'empty.env'), '-f', join(f.run, 'compose.production.json'), 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal']);
});

test('finalizer wrapper keeps raw output private and requires matching saved success counts', windows, t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts', 'finalize-production-data.mjs'), '// Never executed in this test');
  const result = ps(`
    $plan=@{runDirectory=${quote(f.run)};productionRoot='C:\\PhotoLocal';stagingRoot=${quote(f.root)};imageId=('sha256:' + ('a'*64));publicUrl='https://example.invalid'}
    $value=@{version=1;status='FINAL_COPY_VERIFIED';runDirectory=$plan.runDirectory;productionRoot=$plan.productionRoot;stagingRoot=$plan.stagingRoot;imageId=$plan.imageId;publicUrl=$plan.publicUrl;counts=@{projects=32;photos=14396;map_note_photos=0;chat_photo_batches=2878;chat_photo_files=5593};nasGaps=@{projectFolders=2;photoSamples=21};secret='NEVER_PRINT_THIS_SECRET'}
    Write-PhotoLocalCutoverJson -Path (Join-Path $plan.runDirectory 'final-copy.json') -Value $value
    function Invoke-PhotoLocalCutoverProcess { @{ExitCode=0;Stdout=($value | ConvertTo-Json -Depth 8 -Compress);Stderr='NEVER_PRINT_THIS_SECRET'} }
    $safe=Invoke-PhotoLocalDataFinalizer -Plan $plan -Mode finalize -EnvironmentScopes @{}
    @{safe=$safe;privateLog=(Test-Path -LiteralPath (Join-Path $plan.runDirectory 'finalize-child.json'))} | ConvertTo-Json -Depth 8 -Compress
  `);
  assert.equal(result.safe.status, 'FINAL_COPY_VERIFIED');
  assert.equal(result.privateLog, true);
  assert.equal('secret' in result.safe, false);
});

test('prepared run validation accepts its protected owner ACL and rejects an unprotected run', windows, t => {
  const f = fixture(t);
  const result = ps(`
    $script:PhotoLocalSwitchRoot=${quote(f.root)}
    $staging=${quote(f.root)}; $production=Join-Path $staging 'native-fixture'
    [void][IO.Directory]::CreateDirectory($production)
    $data=Join-Path $staging 'docker-data'; [void][IO.Directory]::CreateDirectory($data)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $private=New-PhotoLocalDeploymentRunDirectory -DataRoot $data -Sid $sid
    $manifest=@{version=1;status='PRODUCTION_CONFIG_PREPARED';runDirectory=$private;productionRoot=$production;stagingRoot=$staging;imageId=('sha256:' + ('a'*64));publicUrl='https://example.invalid';composeFile=(Join-Path $private 'compose.production.json');emptyEnvironmentFile=(Join-Path $private 'empty.env')}
    Write-PhotoLocalCutoverJson -Path (Join-Path $private 'production-preparation.json') -Value $manifest
    $good=Get-PhotoLocalCutoverPlan -RunDirectory $private -ExpectedSid $sid
    $plain=Join-Path $data ('production-' + ('1'*32)); [void][IO.Directory]::CreateDirectory($plain)
    try { Get-PhotoLocalCutoverPlan -RunDirectory $plain -ExpectedSid $sid | Out-Null; $unprotected='MISSED' } catch {$unprotected=$_.Exception.Message}
    @{accepted=($good.runDirectory -eq $private);unprotected=$unprotected} | ConvertTo-Json -Compress
  `);
  assert.equal(result.accepted, true);
  assert.equal(result.unprotected, 'PRIVATE_DIRECTORY_INVALID');
});

test('a helper timeout terminates only the spawned helper and never reports captured secrets', windows, t => {
  const f = fixture(t);
  const helper = join(f.root, 'slow helper.mjs');
  writeFileSync(helper, "process.stderr.write('NEVER_PRINT_THIS_SECRET');setInterval(()=>{},1000);");
  const result = ps(`
    try {
      Invoke-PhotoLocalCutoverProcess -Executable ${quote(process.execPath)} -Arguments @(${quote(helper)}) -WorkingDirectory ${quote(f.root)} -TimeoutSeconds 1 | Out-Null
      $status='MISSED'
    } catch { $status=$_.Exception.Message }
    @{status=$status} | ConvertTo-Json -Compress
  `);
  assert.equal(result.status, 'CUTOVER_PROCESS_TIMEOUT');
});
