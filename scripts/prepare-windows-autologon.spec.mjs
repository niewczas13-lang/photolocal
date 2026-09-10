import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./prepare-windows-autologon.ps1', import.meta.url));
const sid = 'S-1-5-21-100-200-300-1001';
function ps(body) {
  const code = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n. '${script.replaceAll("'", "''")}'\n${body}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.trim());
}
const identity = `@{ IsAdmin=$true; Sid='${sid}'; Account='EXAMPLE\\operator'; Owners=@('${sid}'); RunCommand='"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" -autostart' }`;
function scenario(overrides = '') {
  return ps(`
    $script:calls=@()
    function Get-PhotoLocalAutologonIdentity { return ${identity} }
    function Assert-PhotoLocalLockTaskAvailable { $script:calls+='preflight' }
    function Get-PhotoLocalAutologonTool { $script:calls+='download'; return 'C:\\Verified\\Autologon64.exe' }
    function Ensure-PhotoLocalConsoleLockTask { $script:calls+='task' }
    function Show-PhotoLocalAutologon { $script:calls+='gui' }
    function Get-PhotoLocalAutologonState { $script:calls+='check'; return @{Enabled='1'; Sid='${sid}'} }
    ${overrides}
    try { $report=Invoke-PhotoLocalAutologonSetup -Root 'C:\\Staging'; $status=$report.Status } catch { $status=$_.Exception.Message }
    @{status=$status; calls=@($script:calls)} | ConvertTo-Json -Compress
  `);
}
const windows = { skip: process.platform !== 'win32' };

test('setup checks identity and task collision before preparing the local password GUI', windows, () => {
  assert.deepEqual(scenario(), { status: 'AUTOLOGON_CONFIGURED_REBOOT_NOT_TESTED', calls: ['preflight', 'download', 'task', 'gui', 'check'] });
});
test('wrong Docker owner refuses setup before any download or settings change', windows, () => {
  const result = scenario(`function Get-PhotoLocalAutologonIdentity { $i=${identity}; $i.Owners=@('S-1-5-21-100-200-300-1002'); return $i }`);
  assert.equal(result.status, 'WRONG_WINDOWS_ACCOUNT');
  assert.deepEqual(result.calls, []);
});
test('unelevated invocation and absent Docker sign-in entry fail without side effects', windows, () => {
  for (const [change, expected] of [["$i.IsAdmin=$false", 'ADMIN_REQUIRED'], ["$i.RunCommand=$null", 'DOCKER_SIGN_IN_ENTRY_MISSING']]) {
    const result = scenario(`function Get-PhotoLocalAutologonIdentity { $i=${identity}; ${change}; return $i }`);
    assert.equal(result.status, expected);
    assert.deepEqual(result.calls, []);
  }
});
test('an unrelated lock task is never overwritten and prevents tool launch', windows, () => {
  const result = scenario("function Assert-PhotoLocalLockTaskAvailable { throw 'LOCK_TASK_CONFLICT' }");
  assert.deepEqual(result, { status: 'LOCK_TASK_CONFLICT', calls: [] });
});
test('untrusted download stops before task registration or GUI launch', windows, () => {
  const result = scenario("function Get-PhotoLocalAutologonTool { throw 'MICROSOFT_SIGNATURE_REQUIRED' }");
  assert.deepEqual(result, { status: 'MICROSOFT_SIGNATURE_REQUIRED', calls: ['preflight'] });
});
test('GUI cancellation or a different configured account cannot report success', windows, () => {
  for (const [state, expected] of [["@{Enabled='0';Sid=$null}", 'AUTOLOGON_NOT_CONFIGURED'], ["@{Enabled='1';Sid='S-1-5-21-100-200-300-9999'}", 'AUTOLOGON_ACCOUNT_MISMATCH']]) {
    const result = scenario(`function Get-PhotoLocalAutologonState { return ${state} }`);
    assert.equal(result.status, expected);
  }
});
test('console task is scoped to one account, limited privilege, logon only, and hidden PowerShell', windows, () => {
  const result = ps(`New-PhotoLocalConsoleLockSpec -Root 'C:\\Staging With Spaces' -Sid '${sid}' | ConvertTo-Json -Compress`);
  assert.equal(result.UserId, sid);
  assert.equal(result.LogonType, 'Interactive');
  assert.equal(result.RunLevel, 'Limited');
  assert.match(result.Arguments, /-NonInteractive -WindowStyle Hidden/);
  assert.match(result.Arguments, /-File "C:\\Staging With Spaces\\scripts\\lock-autologon-session\.ps1"/);
  assert.match(result.Arguments, new RegExp(`-ExpectedSid "${sid}"`));
});
test('signature validation requires Windows trust and Microsoft signer organization', windows, () => {
  const result = ps(`
    $script:sig=@{Status='Valid';SignerCertificate=@{Subject='CN=Microsoft Corporation, O=Microsoft Corporation, C=US'}}
    function Get-AuthenticodeSignature { return $script:sig }
    $results=@()
    foreach ($case in @('good','untrusted','wrong-publisher')) {
      if ($case -eq 'untrusted') { $script:sig.Status='UnknownError' }
      if ($case -eq 'wrong-publisher') { $script:sig.Status='Valid'; $script:sig.SignerCertificate.Subject='CN=Microsoft Corporation, O=Someone Else, C=US' }
      try { Assert-PhotoLocalMicrosoftSignature -Path 'C:\\Tool.exe'; $results+='OK' } catch { $results+=$_.Exception.Message }
    }
    ConvertTo-Json -Compress -InputObject @($results)
  `);
  assert.deepEqual(result, ['OK', 'MICROSOFT_SIGNATURE_REQUIRED', 'MICROSOFT_SIGNATURE_REQUIRED']);
});
test('post-GUI verification reads only flag and account names, never password or LSA', windows, () => {
  const result = ps(`
    $script:readNames=@()
    function Get-ItemPropertyValue { param($LiteralPath,$Name) $script:readNames+=$Name; switch($Name) {'AutoAdminLogon' {'1'} 'DefaultUserName' {'operator'} 'DefaultDomainName' {'EXAMPLE'} default {throw 'FORBIDDEN_REGISTRY_VALUE'}} }
    function ConvertTo-PhotoLocalAccountSid { return '${sid}' }
    $state=Get-PhotoLocalAutologonState
    @{names=@($script:readNames);enabled=$state.Enabled;sid=$state.Sid} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result.names, ['AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName']);
  assert.equal(result.enabled, '1');
  assert.equal(result.sid, sid);
});

test('real Windows task objects pass verification, reuse an exact task, and refuse modified actions', windows, () => {
  const result = ps(`
    # Import before mocking: module auto-loading would replace mocks with real cmdlets.
    Import-Module ScheduledTasks,Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility -ErrorAction Stop
    $PSModuleAutoLoadingPreference='None'
    $script:registered=$null
    $script:registerCalls=0
    function Get-ScheduledTask { return $script:registered }
    function Register-ScheduledTask {
      param($TaskPath,$TaskName,$Description,$Action,$Trigger,$Principal,$Settings)
      $script:registerCalls++
      # Construct a real CIM definition without registering anything in Windows.
      $script:registered=New-ScheduledTask -Description $Description -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings
    }
    $currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $spec=New-PhotoLocalConsoleLockSpec -Root 'C:\\Staging With Spaces' -Sid $currentSid
    Ensure-PhotoLocalConsoleLockTask -Spec $spec
    Ensure-PhotoLocalConsoleLockTask -Spec $spec
    $valid=Test-PhotoLocalConsoleLockTask -Task $script:registered -Spec $spec
    $script:registered.Actions[0].Arguments='-Command Write-Output unexpected'
    try { Ensure-PhotoLocalConsoleLockTask -Spec $spec; $conflict='MISSED' } catch { $conflict=$_.Exception.Message }
    @{valid=$valid;registerCalls=$script:registerCalls;conflict=$conflict} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { valid: true, registerCalls: 1, conflict: 'LOCK_TASK_CONFLICT' });
});
