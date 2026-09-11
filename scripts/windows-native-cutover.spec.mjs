import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./windows-native-cutover.ps1', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windows = { skip: process.platform !== 'win32' };

function fixture(t) {
  // Windows CI may supply TEMP as an 8.3 alias; production requires canonical paths.
  const tempRoot = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(tempRoot, 'photolocal-native-cutover-'));
  const production = join(root, 'production');
  const staging = join(root, 'staging');
  for (const path of [join(production, 'backend', 'dist'), join(production, 'scripts'), join(production, 'logs'), join(staging, 'scripts'), join(staging, 'docker-data')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(production, 'backend', 'dist', 'server.js'), '// Fixture, never run');
  for (const directory of [production, staging]) writeFileSync(join(directory, 'scripts', 'start-autostart.ps1'), '# Fixture, never run');
  writeFileSync(join(production, 'node.exe'), 'Fixture, never run');
  t.after(() => {
    assert.equal(dirname(resolve(root)).toLowerCase(), tempRoot.toLowerCase());
    assert.match(basename(root), /^photolocal-native-cutover-/);
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    assert.equal(realpathSync(root).toLowerCase(), resolve(root).toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  return { root, production, staging };
}

function ps(body) {
  const source = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\nImport-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility,CimCmdlets,ScheduledTasks,NetTCPIP\n$PSModuleAutoLoadingPreference='None'\n. ${quote(helper)}\n${body}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_PRINT_THIS_SECRET/);
  return JSON.parse(result.stdout.trim());
}

function setup(f) {
  return `
    $production=${quote(f.production)}; $staging=${quote(f.staging)}
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:nativeId=14287; $script:created=[datetime]::Now.AddMinutes(-2); $script:alive=$true; $script:listening=$true
    $script:mutations=@(); $script:children=@(); $script:taskChangeOnDisable=$false
    $exe=Join-Path $production 'node.exe'; $runner=Join-Path $production 'scripts\\start-autostart.ps1'
    $script:command='"'+$exe+'" dist/server.js'
    $script:task=[pscustomobject]@{TaskName='PhotoLocal Autostart';TaskPath='\\';State='Ready';Description='Fixture';
      Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');Arguments=('-NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"');WorkingDirectory=''});
      Principal=[pscustomobject]@{UserId=$sid;LogonType='Interactive';RunLevel='Limited'};
      Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'};UserId=$sid;Enabled=$true;Delay='';StartBoundary='';EndBoundary=''});
      Settings=[pscustomobject]@{Enabled=$true;MultipleInstances='IgnoreNew';StartWhenAvailable=$true;RestartCount=3;RestartInterval='PT1M'}}
    function Write-FixtureEvidence {
      [IO.File]::WriteAllText((Join-Path $production 'photo-local.pid'),[string]$script:nativeId)
      [IO.File]::SetLastWriteTime((Join-Path $production 'photo-local.pid'),$script:created)
      [IO.File]::WriteAllText((Join-Path $production 'logs\\autostart.log'),('['+$script:created.AddSeconds(2).ToString('yyyy-MM-dd HH:mm:ss')+'] Photo Local wystartowal poprawnie. PID: '+$script:nativeId))
    }
    Write-FixtureEvidence
    function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) if ($script:listening) {[pscustomobject]@{LocalPort=4873;OwningProcess=$script:nativeId}} }
    function Get-CimInstance {
      param($ClassName,$Filter,$ErrorAction)
      if ($script:alive) {[pscustomobject]@{Name='node.exe';ProcessId=$script:nativeId;ParentProcessId=1;CreationDate=$script:created;ExecutablePath=$exe;CommandLine=$script:command}}
      $script:children
    }
    function Invoke-CimMethod { param($InputObject,$MethodName,$ErrorAction) @{ReturnValue=0;Sid=$sid} }
    function Get-PhotoLocalNativeProcessObject {
      param($ProcessId,[switch]$AllowMissing)
      if (-not $script:alive -or $ProcessId -ne $script:nativeId) {if ($AllowMissing) {return $null}; throw 'NATIVE_IDENTITY_UNVERIFIED'}
      $item=[pscustomobject]@{Id=$script:nativeId;StartTime=$script:created}; $item | Add-Member ScriptMethod Dispose {}; $item
    }
    function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) if ($TaskPath -ne '\\' -or $TaskName -ne 'PhotoLocal Autostart') {throw 'BAD_TASK_TARGET'}; $script:task }
    function Export-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) '<Task><Safe>fixture</Safe></Task>' }
    function Disable-ScheduledTask {
      param($TaskPath,$TaskName,$ErrorAction)
      if ($TaskPath -ne '\\' -or $TaskName -ne 'PhotoLocal Autostart') {throw 'BAD_TASK_TARGET'}
      if (-not (Test-Path -LiteralPath (Join-Path $run 'native-task-disable-intent.json'))) {throw 'NO_DURABLE_INTENT'}
      $script:mutations+='disable'; $script:task.Settings.Enabled=$false; $script:task.State='Disabled'
      if ($script:taskChangeOnDisable) {$script:created=$script:created.AddSeconds(20)}
    }
    function Enable-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) if ($TaskPath -ne '\\' -or $TaskName -ne 'PhotoLocal Autostart') {throw 'BAD_TASK_TARGET'}; $script:mutations+='enable';$script:task.Settings.Enabled=$true;$script:task.State='Ready' }
    function Start-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) if ($TaskPath -ne '\\' -or $TaskName -ne 'PhotoLocal Autostart') {throw 'BAD_TASK_TARGET'}; $script:mutations+='start';$script:nativeId=15288;$script:created=[datetime]::Now;$script:alive=$true;$script:listening=$true;Write-FixtureEvidence }
    function Stop-PhotoLocalNativeProcessObject { param($Process) if ($Process.Id -ne 14287) {throw 'BAD_PROCESS_TARGET'}; $script:mutations+='stop';$script:alive=$false;$script:listening=$false }
    function Test-PhotoLocalNativeHealth { $true }
    function Wait-PhotoLocalNativePoll { }
    function New-FixtureRun {
      $path=Join-Path $staging ('docker-data\\production-'+[guid]::NewGuid().ToString('N'))
      $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false)
      foreach ($account in @($sid,'S-1-5-18','S-1-5-32-544')) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($account)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
      (New-Object IO.DirectoryInfo($path)).Create($acl); $path
    }
    $run=New-FixtureRun
    function Read-State { Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid }
    function Stop-Native($state) { Stop-PhotoLocalNativeForCutover -ExpectedState $state -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid -RunDirectory $run }
    function Restore-Native { Restore-PhotoLocalNativeAfterFailedCutover -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid -RunDirectory $run }
    function Error-Code([scriptblock]$Action) {try {$null=& $Action; 'NO_ERROR'} catch {$_.Exception.Message}}
  `;
}

test('dot sourcing performs no task, process, registry or network actions', windows, () => {
  assert.equal(ps(`'FUNCTIONS_LOADED' | ConvertTo-Json`), 'FUNCTIONS_LOADED');
});

test('verified identity is closed and task fingerprint survives disabling only', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $before=Read-State
    $script:task.Settings.Enabled=$false;$script:task.State='Disabled'
    $after=Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid -AllowDisabled
    @{before=$before;after=$after;mutations=@($script:mutations)} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(value.before.ProcessId, 14287);
  assert.equal(value.before.TaskEnabled, true);
  assert.equal(value.after.TaskEnabled, false);
  assert.match(value.before.TaskFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(value.before.TaskFingerprint, value.after.TaskFingerprint);
  assert.deepEqual(value.mutations, []);
});

test('wrong commands, runner, task or process evidence refuse without mutations and redact errors', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $codes=@()
    $savedCommand=$script:command;$script:command+=' --token NEVER_PRINT_THIS_SECRET';$codes+=Error-Code {Read-State};$script:command=$savedCommand
    $script:task.Actions[0].Arguments+=' NEVER_PRINT_THIS_SECRET';$codes+=Error-Code {Read-State};$script:task.Actions[0].Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'
    [IO.File]::SetLastWriteTime((Join-Path $production 'photo-local.pid'),$script:created.AddHours(-1));$codes+=Error-Code {Read-State};Write-FixtureEvidence
    [IO.File]::WriteAllText((Join-Path $production 'logs\\autostart.log'),'NEVER_PRINT_THIS_SECRET');$codes+=Error-Code {Read-State};Write-FixtureEvidence
    [IO.File]::WriteAllText((Join-Path $staging 'scripts\\start-autostart.ps1'),'changed');$codes+=Error-Code {Read-State}
    @{codes=$codes;mutations=@($script:mutations)} | ConvertTo-Json -Compress
  `);
  assert.ok(value.codes.every(code => /^NATIVE_[A-Z_]+$/.test(code) && code !== 'NO_ERROR'));
  assert.deepEqual(value.mutations, []);
});

test('current Python descendants block and older reused-parent entries do not', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $script:children=@([pscustomobject]@{Name='python.exe';ProcessId=22001;ParentProcessId=14287;CreationDate=$script:created.AddSeconds(10)})
    $blocked=Error-Code {Read-State}
    $script:children[0].CreationDate=$script:created.AddHours(-1)
    $accepted=Read-State
    @{blocked=$blocked;accepted=$accepted.ProcessId;mutations=@($script:mutations)} | ConvertTo-Json -Compress
  `);
  assert.equal(value.blocked, 'NATIVE_WRITERS_PRESENT');
  assert.equal(value.accepted, 14287);
  assert.deepEqual(value.mutations, []);
});

test('stop writes intent before disabling and writes exact stopped marker only after source stops', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State;$report=Stop-Native $state
    @{report=$report;mutations=@($script:mutations);marker=(Get-Content -Raw -LiteralPath (Join-Path $run 'native-stopped.json') | ConvertFrom-Json);saved=(Get-Content -Raw -LiteralPath (Join-Path $run 'native-before.json') | ConvertFrom-Json);xml=(Test-Path -LiteralPath (Join-Path $run 'native-task-before.xml'))} | ConvertTo-Json -Depth 7 -Compress
  `);
  assert.equal(value.report.status, 'NATIVE_STOPPED');
  assert.deepEqual(value.mutations, ['disable', 'stop']);
  assert.deepEqual(value.marker, { version: 1, productionRoot: f.production, sourceStopped: true });
  assert.equal(value.saved.state.ProcessId, 14287);
  assert.equal(value.xml, true);
});

test('state change after disabling never kills replacement and retains recovery evidence', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State;$script:taskChangeOnDisable=$true
    $code=Error-Code {Stop-Native $state}
    @{code=$code;mutations=@($script:mutations);marker=(Test-Path -LiteralPath (Join-Path $run 'native-stopped.json'));intent=(Test-Path -LiteralPath (Join-Path $run 'native-task-disable-intent.json'))} | ConvertTo-Json -Compress
  `);
  assert.equal(value.code, 'NATIVE_STATE_CHANGED');
  assert.deepEqual(value.mutations, ['disable']);
  assert.equal(value.marker, false);
  assert.equal(value.intent, true);
});

test('reused or public run directory cannot authorize stopping', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State
    [IO.File]::WriteAllText((Join-Path $run 'native-before.json'),'{}')
    $used=Error-Code {Stop-Native $state}
    $run=Join-Path $staging ('docker-data\\production-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($run) | Out-Null
    $public=Error-Code {Stop-Native $state}
    @{used=$used;public=$public;mutations=@($script:mutations)} | ConvertTo-Json -Compress
  `);
  assert.equal(value.used, 'NATIVE_RUN_STATE_EXISTS');
  assert.equal(value.public, 'NATIVE_PRIVATE_DIRECTORY_INVALID');
  assert.deepEqual(value.mutations, []);
});

test('rollback enables the still-running original without starting another process', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State
    function Stop-PhotoLocalNativeProcessObject {param($Process);throw 'NEVER_PRINT_THIS_SECRET'}
    $code=Error-Code {Stop-Native $state};$report=Restore-Native
    @{code=$code;report=$report;mutations=@($script:mutations)} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(value.code, 'NATIVE_STOP_FAILED');
  assert.equal(value.report.status, 'NATIVE_STILL_RUNNING');
  assert.deepEqual(value.mutations, ['disable', 'enable']);
});

test('rollback restarts only the verified saved task after source is gone', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State;$null=Stop-Native $state;$report=Restore-Native
    @{report=$report;mutations=@($script:mutations);current=Read-State} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(value.report.status, 'NATIVE_RESTORED');
  assert.deepEqual(value.mutations, ['disable', 'stop', 'enable', 'start']);
  assert.equal(value.current.ProcessId, 15288);
});

test('rollback refuses public start marker, changed definition and foreign port before mutations', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State;$null=Stop-Native $state;$script:mutations=@()
    $script:task.Settings.RestartCount=2;$changed=Error-Code {Restore-Native};$script:task.Settings.RestartCount=3
    $script:nativeId=33333;$script:alive=$true;$script:listening=$true;$busy=Error-Code {Restore-Native}
    [IO.File]::WriteAllText((Join-Path $run 'production-start-attempted.json'),'{}');$forbidden=Error-Code {Restore-Native}
    @{changed=$changed;busy=$busy;forbidden=$forbidden;mutations=@($script:mutations)} | ConvertTo-Json -Compress
  `);
  assert.equal(value.changed, 'NATIVE_STATE_CHANGED');
  assert.equal(value.busy, 'NATIVE_PORT_BUSY');
  assert.equal(value.forbidden, 'NATIVE_ROLLBACK_FORBIDDEN');
  assert.deepEqual(value.mutations, []);
});

test('actual unregistered PS5 CIM task definitions fingerprint settings and ignore only Enabled', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $script:task.Actions=@(New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'))
    $script:task.Principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $script:task.Triggers=@(New-ScheduledTaskTrigger -AtLogOn -User $sid)
    $script:task.Settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $before=Read-State
    $script:task.Settings.Enabled=$false;$script:task.State='Disabled'
    $disabled=Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid -AllowDisabled
    $script:task.Settings.RestartCount=2
    $changed=Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $sid -AllowDisabled
    @{before=$before.TaskFingerprint;disabled=$disabled.TaskFingerprint;changed=$changed.TaskFingerprint;mutations=@($script:mutations)} | ConvertTo-Json -Compress
  `);
  assert.equal(value.before, value.disabled);
  assert.notEqual(value.before, value.changed);
  assert.deepEqual(value.mutations, []);
});

test('stop refuses a process handle whose creation changed after final state verification', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    $state=Read-State;$script:handleCalls=0
    function Get-PhotoLocalNativeProcessObject {
      param($ProcessId,[switch]$AllowMissing)
      $script:handleCalls++
      $stamp=$script:created
      if ($script:handleCalls -ge 4) {$stamp=$stamp.AddSeconds(1)}
      $item=[pscustomobject]@{Id=$script:nativeId;StartTime=$stamp};$item | Add-Member ScriptMethod Dispose {};$item
    }
    $code=Error-Code {Stop-Native $state}
    @{code=$code;mutations=@($script:mutations);marker=(Test-Path -LiteralPath (Join-Path $run 'native-stopped.json'))} | ConvertTo-Json -Compress
  `);
  assert.equal(value.code, 'NATIVE_STATE_CHANGED');
  assert.deepEqual(value.mutations, ['disable']);
  assert.equal(value.marker, false);
});

test('stop timeout retains rollback evidence and never declares a stopped source', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    function Stop-PhotoLocalNativeProcessObject {param($Process);$script:mutations+='stop'}
    $state=Read-State;$code=Error-Code {Stop-Native $state}
    @{code=$code;mutations=@($script:mutations);marker=(Test-Path -LiteralPath (Join-Path $run 'native-stopped.json'));intent=(Test-Path -LiteralPath (Join-Path $run 'native-task-disable-intent.json'))} | ConvertTo-Json -Compress
  `);
  assert.equal(value.code, 'NATIVE_STOP_TIMEOUT');
  assert.deepEqual(value.mutations, ['disable', 'stop']);
  assert.equal(value.marker, false);
  assert.equal(value.intent, true);
});

test('a Python descendant appearing during termination blocks stopped marker and restart', windows, t => {
  const f = fixture(t);
  const value = ps(`${setup(f)}
    function Stop-PhotoLocalNativeProcessObject {
      param($Process)
      $script:mutations+='stop';$script:alive=$false;$script:listening=$false
      $script:children=@([pscustomobject]@{Name='python.exe';ProcessId=22001;ParentProcessId=14287;CreationDate=$script:created.AddSeconds(30)})
    }
    $state=Read-State;$stopCode=Error-Code {Stop-Native $state};$restoreCode=Error-Code {Restore-Native}
    @{stopCode=$stopCode;restoreCode=$restoreCode;mutations=@($script:mutations);marker=(Test-Path -LiteralPath (Join-Path $run 'native-stopped.json'))} | ConvertTo-Json -Compress
  `);
  assert.equal(value.stopCode, 'NATIVE_WRITERS_PRESENT');
  assert.equal(value.restoreCode, 'NATIVE_WRITERS_PRESENT');
  assert.deepEqual(value.mutations, ['disable', 'stop']);
  assert.equal(value.marker, false);
});
