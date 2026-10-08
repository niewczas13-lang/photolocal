# Functions only. Loading this file never stops, starts, or changes a task or process.

function Throw-PhotoLocalNativeSafeError {
  param($Record, [string]$Fallback)
  $known = @('NATIVE_IDENTITY_UNVERIFIED', 'NATIVE_TASK_UNSUPPORTED', 'NATIVE_WRITERS_PRESENT',
    'NATIVE_STATE_CHANGED', 'NATIVE_STOP_TIMEOUT', 'NATIVE_STOP_FAILED', 'NATIVE_PORT_BUSY',
    'NATIVE_ROLLBACK_FORBIDDEN', 'NATIVE_ROLLBACK_STATE_INVALID', 'NATIVE_RESTORE_FAILED',
    'NATIVE_PRIVATE_DIRECTORY_INVALID', 'NATIVE_RUN_STATE_EXISTS')
  if ($Record.Exception.Message -cin $known) { throw $Record.Exception.Message }
  throw $Fallback
}

function Assert-PhotoLocalNativeDirectory {
  param([string]$Path)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00\r\n]' -or
      @($Path -split '[\\/]' | Where-Object { $_ -in @('.', '..') }).Count -gt 0) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
  $item = New-Object IO.DirectoryInfo([IO.Path]::GetFullPath($Path))
  if (-not $item.Exists) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
  $ancestor = $item
  while ($null -ne $ancestor) {
    $ancestor.Refresh()
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $ancestor = $ancestor.Parent
  }
  $item.FullName.TrimEnd('\')
}

function Assert-PhotoLocalNativeFile {
  param([string]$Path)
  $null = Assert-PhotoLocalNativeDirectory -Path ([IO.Path]::GetDirectoryName($Path))
  $item = New-Object IO.FileInfo($Path)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
  $item
}

function ConvertTo-PhotoLocalNativeSid {
  param([string]$Account)
  if ($Account -match '^S-1-\d+(?:-\d+)+$') { return (New-Object Security.Principal.SecurityIdentifier($Account)).Value }
  (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-PhotoLocalNativeFileHash {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Assert-PhotoLocalNativeAccount {
  param([string]$ExpectedSid)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    if ($identity.User.Value -cne $ExpectedSid) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
  } finally { $identity.Dispose() }
}

function Assert-PhotoLocalNativeRunDirectory {
  param([string]$RunDirectory, [string]$StagingRoot, [string]$ExpectedSid)
  try {
    $data = Assert-PhotoLocalNativeDirectory -Path (Join-Path $StagingRoot 'docker-data')
    $run = Assert-PhotoLocalNativeDirectory -Path $RunDirectory
    if ([IO.Path]::GetDirectoryName($run) -ine $data -or
        [IO.Path]::GetFileName($run) -cnotmatch '^production-[0-9a-f]{32}$') { throw 'INVALID' }
    $acl = (New-Object IO.DirectoryInfo($run)).GetAccessControl()
    $allowed = @($ExpectedSid, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne $allowed.Count) { throw 'INVALID' }
    foreach ($rule in $rules) {
      if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or
          $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or
          [string]$rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or
          [string]$rule.PropagationFlags -ne 'None') { throw 'INVALID' }
    }
    $run
  } catch { throw 'NATIVE_PRIVATE_DIRECTORY_INVALID' }
}

function Get-PhotoLocalNativeListeners {
  try {
    @(Get-NetTCPConnection -State Listen -LocalPort 4873 -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }
    throw 'NATIVE_IDENTITY_UNVERIFIED'
  }
}

function Get-PhotoLocalNativeProcessObject {
  param([int]$ProcessId, [switch]$AllowMissing)
  try { Get-Process -Id $ProcessId -ErrorAction Stop }
  catch {
    if ($AllowMissing -and $_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return $null }
    throw 'NATIVE_IDENTITY_UNVERIFIED'
  }
}

function Stop-PhotoLocalNativeProcessObject {
  param([System.Diagnostics.Process]$Process)
  # Windows has no graceful Node SIGTERM here. Never kill a PID obtained from a stale file.
  Stop-Process -InputObject $Process -ErrorAction Stop
}

function Wait-PhotoLocalNativePoll { Start-Sleep -Milliseconds 500 }

function Test-PhotoLocalNativeHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4873/health' -TimeoutSec 2 -ErrorAction Stop
    $response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json -ErrorAction Stop).ok -eq $true
  } catch { $false }
}

function ConvertTo-PhotoLocalNativeCanonicalValue {
  param($Value, [string[]]$Exclude = @())
  if ($null -eq $Value) { return $null }
  if ($Value -is [string] -or $Value -is [bool] -or $Value -is [ValueType]) { return [string]$Value }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [System.Collections.IDictionary]) {
    $items = @(); foreach ($item in $Value) { $items += ,(ConvertTo-PhotoLocalNativeCanonicalValue $item) }
    return ,$items
  }
  $result = [ordered]@{}
  $properties = $Value.PSObject.Properties
  if ($Value -is [Microsoft.Management.Infrastructure.CimInstance]) { $properties = $Value.CimInstanceProperties }
  foreach ($property in @($properties | Sort-Object Name)) {
    if ($property.Name -in $Exclude -or $property.Name -in @('CimClass', 'CimInstanceProperties', 'CimSystemProperties', 'PSComputerName', 'RunspaceId')) { continue }
    $result[$property.Name] = ConvertTo-PhotoLocalNativeCanonicalValue $property.Value
  }
  $result
}

function Get-PhotoLocalNativeTaskState {
  param([string]$ProductionRoot, [string]$StagingRoot, [string]$ExpectedSid, [switch]$AllowDisabled)
  try {
    $runner = Join-Path $ProductionRoot 'scripts\start-autostart.ps1'
    $stagingRunner = Join-Path $StagingRoot 'scripts\start-autostart.ps1'
    $null = Assert-PhotoLocalNativeFile $runner; $null = Assert-PhotoLocalNativeFile $stagingRunner
    $runnerHash = Get-PhotoLocalNativeFileHash $runner
    if ($runnerHash -cne (Get-PhotoLocalNativeFileHash $stagingRunner)) { throw 'NATIVE_TASK_UNSUPPORTED' }
    $task = Get-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop
    $actions = @($task.Actions); $triggers = @($task.Triggers)
    $expectedExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $expectedArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"'
    $enabled = $task.Settings.Enabled -eq $true
    if ($task.TaskName -cne 'PhotoLocal Autostart' -or $task.TaskPath -cne '\' -or
        $actions.Count -ne 1 -or $triggers.Count -ne 1 -or
        $actions[0].Execute -ine $expectedExe -or $actions[0].Arguments -ine $expectedArguments -or
        ($actions[0].WorkingDirectory -and $actions[0].WorkingDirectory.TrimEnd('\') -ine $ProductionRoot) -or
        (ConvertTo-PhotoLocalNativeSid $task.Principal.UserId) -cne $ExpectedSid -or
        [string]$task.Principal.LogonType -ne 'Interactive' -or [string]$task.Principal.RunLevel -ne 'Limited' -or
        $triggers[0].CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or
        (ConvertTo-PhotoLocalNativeSid $triggers[0].UserId) -cne $ExpectedSid -or
        $triggers[0].Enabled -ne $true -or ($triggers[0].Delay -and $triggers[0].Delay -ne 'PT0S') -or
        $triggers[0].StartBoundary -or $triggers[0].EndBoundary -or
        ($enabled -and [string]$task.State -ne 'Ready') -or
        (-not $enabled -and (-not $AllowDisabled -or [string]$task.State -ne 'Disabled'))) { throw 'NATIVE_TASK_UNSUPPORTED' }
    $definition = [ordered]@{
      Actions = ConvertTo-PhotoLocalNativeCanonicalValue $task.Actions
      Principal = ConvertTo-PhotoLocalNativeCanonicalValue $task.Principal
      Triggers = ConvertTo-PhotoLocalNativeCanonicalValue $task.Triggers
      Settings = ConvertTo-PhotoLocalNativeCanonicalValue $task.Settings -Exclude @('Enabled')
      Description = [string]$task.Description
      SourceRunnerHash = $runnerHash
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($definition | ConvertTo-Json -Depth 20 -Compress))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    @{ TaskFingerprint = $fingerprint; TaskEnabled = $enabled; SourceRunnerHash = $runnerHash }
  } catch { Throw-PhotoLocalNativeSafeError $_ 'NATIVE_TASK_UNSUPPORTED' }
}

function Assert-PhotoLocalNativeDescendants {
  param($Processes, $Native)
  $pending = New-Object 'System.Collections.Generic.Queue[object]'
  $pending.Enqueue($Native)
  $seen = @{}
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($child in @($Processes | Where-Object { $_.ParentProcessId -eq $parent.ProcessId })) {
      if (-not $child.CreationDate) { throw 'NATIVE_WRITERS_PRESENT' }
      # Ignore an older process whose parent ID has subsequently been reused by this app.
      if (([datetime]$child.CreationDate).ToUniversalTime() -lt ([datetime]$parent.CreationDate).ToUniversalTime()) { continue }
      if ($seen.ContainsKey([string]$child.ProcessId)) { throw 'NATIVE_WRITERS_PRESENT' }
      $seen[[string]$child.ProcessId] = $true
      if ($child.Name -ine 'conhost.exe') { throw 'NATIVE_WRITERS_PRESENT' }
      $pending.Enqueue($child)
    }
  }
}

function Assert-PhotoLocalNativeNoRemainingWriters {
  param($State)
  $root = [pscustomobject]@{ProcessId=$State.ProcessId;CreationDate=[datetime]::ParseExact($State.CreatedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)}
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  Assert-PhotoLocalNativeDescendants -Processes $processes -Native $root
}

function Get-PhotoLocalNativeCutoverState {
  param([string]$ProductionRoot, [string]$StagingRoot, [string]$ExpectedSid, [switch]$AllowDisabled)
  try {
    Assert-PhotoLocalNativeAccount $ExpectedSid
    $production = Assert-PhotoLocalNativeDirectory $ProductionRoot
    $staging = Assert-PhotoLocalNativeDirectory $StagingRoot
    $task = Get-PhotoLocalNativeTaskState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid -AllowDisabled:$AllowDisabled
    $listeners = @(Get-PhotoLocalNativeListeners)
    if ($listeners.Count -ne 1 -or [long]$listeners[0] -le 0) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $nativeId = [int]$listeners[0]
    $pidFile = Assert-PhotoLocalNativeFile (Join-Path $production 'photo-local.pid')
    $pidText = [IO.File]::ReadAllText($pidFile.FullName).Trim()
    if ($pidText -notmatch '^\d{1,10}$' -or [long]$pidText -ne $nativeId) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $matching = @($processes | Where-Object { $_.ProcessId -eq $nativeId })
    if ($matching.Count -ne 1) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $native = $matching[0]
    if ($native.Name -ine 'node.exe' -or -not $native.CreationDate -or -not $native.ExecutablePath) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $null = Assert-PhotoLocalNativeFile $native.ExecutablePath
    $null = Assert-PhotoLocalNativeFile (Join-Path $production 'backend\dist\server.js')
    $escapedExe = [regex]::Escape([string]$native.ExecutablePath)
    $commandPattern = '^(?:"' + $escapedExe + '"|' + $escapedExe + ')\s+(?:"dist[/\\]server\.js"|dist[/\\]server\.js)\s*$'
    if ($native.CommandLine -notmatch $commandPattern) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $owner = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $ExpectedSid) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $process = Get-PhotoLocalNativeProcessObject -ProcessId $nativeId
    try { $created = $process.StartTime.ToUniversalTime() } finally { $process.Dispose() }
    if ([math]::Abs(($created - ([datetime]$native.CreationDate).ToUniversalTime()).TotalSeconds) -gt 1 -or
        [math]::Abs(($pidFile.LastWriteTimeUtc - $created).TotalSeconds) -gt 180) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    $logFile = Assert-PhotoLocalNativeFile (Join-Path $production 'logs\autostart.log')
    $matchedLog = $false
    foreach ($line in @(Get-Content -LiteralPath $logFile.FullName -Tail 200 -ErrorAction Stop)) {
      if ($line -match '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] Photo Local wystartowal poprawnie\. PID: (\d+)$' -and [long]$Matches[2] -eq $nativeId) {
        $stamp = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal).ToUniversalTime()
        $seconds = ($stamp - $created).TotalSeconds
        if ($seconds -ge -2 -and $seconds -le 600) { $matchedLog = $true }
      }
    }
    if (-not $matchedLog) { throw 'NATIVE_IDENTITY_UNVERIFIED' }
    Assert-PhotoLocalNativeDescendants -Processes $processes -Native $native
    @{ ProcessId = $nativeId; CreatedUtc = $created.ToString('o'); ExecutablePath = [string]$native.ExecutablePath;
      TaskFingerprint = $task.TaskFingerprint; TaskEnabled = $task.TaskEnabled; SourceRunnerHash = $task.SourceRunnerHash }
  } catch { Throw-PhotoLocalNativeSafeError $_ 'NATIVE_IDENTITY_UNVERIFIED' }
}

function Assert-PhotoLocalNativeSameState {
  param($Actual, $Expected)
  if ($Actual.ProcessId -ne $Expected.ProcessId -or $Actual.CreatedUtc -cne $Expected.CreatedUtc -or
      $Actual.ExecutablePath -ine $Expected.ExecutablePath -or $Actual.TaskFingerprint -cne $Expected.TaskFingerprint -or
      $Actual.SourceRunnerHash -cne $Expected.SourceRunnerHash) { throw 'NATIVE_STATE_CHANGED' }
}

function Write-PhotoLocalNativeFreshFile {
  param([string]$Path, [string]$Text)
  if (Test-Path -LiteralPath $Path) { throw 'NATIVE_RUN_STATE_EXISTS' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
  } finally { $stream.Dispose() }
}

function Test-PhotoLocalNativeOriginalAlive {
  param($State)
  $process = Get-PhotoLocalNativeProcessObject -ProcessId $State.ProcessId -AllowMissing
  if ($null -eq $process) { return $false }
  try { $process.StartTime.ToUniversalTime().ToString('o') -ceq $State.CreatedUtc }
  finally { $process.Dispose() }
}

function Stop-PhotoLocalNativeForCutover {
  param($ExpectedState, [string]$ProductionRoot, [string]$StagingRoot, [string]$ExpectedSid, [string]$RunDirectory)
  try {
    Assert-PhotoLocalNativeAccount $ExpectedSid
    $production = Assert-PhotoLocalNativeDirectory $ProductionRoot
    $staging = Assert-PhotoLocalNativeDirectory $StagingRoot
    $run = Assert-PhotoLocalNativeRunDirectory -RunDirectory $RunDirectory -StagingRoot $staging -ExpectedSid $ExpectedSid
    foreach ($name in @('native-before.json', 'native-task-before.xml', 'native-task-disable-intent.json', 'native-stopped.json', 'production-start-attempted.json')) {
      if (Test-Path -LiteralPath (Join-Path $run $name)) { throw 'NATIVE_RUN_STATE_EXISTS' }
    }
    $actual = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
    Assert-PhotoLocalNativeSameState -Actual $actual -Expected $ExpectedState
    if (-not $ExpectedState.TaskEnabled -or -not $actual.TaskEnabled) { throw 'NATIVE_STATE_CHANGED' }
    $xml = Export-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop
    if (-not $xml -or ([xml]$xml).DocumentElement.LocalName -ne 'Task') { throw 'NATIVE_TASK_UNSUPPORTED' }
    $saved = [ordered]@{version=1;productionRoot=$production;stagingRoot=$staging;expectedSid=$ExpectedSid;state=$actual}
    Write-PhotoLocalNativeFreshFile -Path (Join-Path $run 'native-before.json') -Text ($saved | ConvertTo-Json -Depth 5 -Compress)
    Write-PhotoLocalNativeFreshFile -Path (Join-Path $run 'native-task-before.xml') -Text ([string]$xml)
    $again = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
    Assert-PhotoLocalNativeSameState -Actual $again -Expected $actual
    Write-PhotoLocalNativeFreshFile -Path (Join-Path $run 'native-task-disable-intent.json') -Text '{"version":1,"taskName":"PhotoLocal Autostart","taskPath":"\\"}'
    Disable-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop | Out-Null
    try {
      $disabled = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid -AllowDisabled
      Assert-PhotoLocalNativeSameState -Actual $disabled -Expected $actual
      if ($disabled.TaskEnabled) { throw 'NATIVE_STATE_CHANGED' }
    } catch { throw 'NATIVE_STATE_CHANGED' }
    $process = Get-PhotoLocalNativeProcessObject -ProcessId $actual.ProcessId
    try {
      if ($process.StartTime.ToUniversalTime().ToString('o') -cne $actual.CreatedUtc) { throw 'NATIVE_STATE_CHANGED' }
      Stop-PhotoLocalNativeProcessObject -Process $process
    } finally { $process.Dispose() }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      $alive = Test-PhotoLocalNativeOriginalAlive -State $actual
      $listeners = @(Get-PhotoLocalNativeListeners)
      if (-not $alive -and $listeners.Count -eq 0) {
        # A downloader could have been spawned between the final inspection and termination.
        # Do not publish a quiescence marker or kill that child; preserve evidence for recovery.
        Assert-PhotoLocalNativeNoRemainingWriters -State $actual
        if (@(Get-PhotoLocalNativeListeners).Count -gt 0) { throw 'NATIVE_PORT_BUSY' }
        $marker = [ordered]@{version=1;productionRoot=$production;sourceStopped=$true}
        Write-PhotoLocalNativeFreshFile -Path (Join-Path $run 'native-stopped.json') -Text ($marker | ConvertTo-Json -Compress)
        return @{status='NATIVE_STOPPED';processId=$actual.ProcessId}
      }
      Wait-PhotoLocalNativePoll
    }
    if (@(Get-PhotoLocalNativeListeners).Count -gt 0 -and -not (Test-PhotoLocalNativeOriginalAlive -State $actual)) { throw 'NATIVE_PORT_BUSY' }
    throw 'NATIVE_STOP_TIMEOUT'
  } catch { Throw-PhotoLocalNativeSafeError $_ 'NATIVE_STOP_FAILED' }
}

function Restore-PhotoLocalNativeAfterFailedCutover {
  param([string]$ProductionRoot, [string]$StagingRoot, [string]$ExpectedSid, [string]$RunDirectory)
  try {
    Assert-PhotoLocalNativeAccount $ExpectedSid
    $production = Assert-PhotoLocalNativeDirectory $ProductionRoot
    $staging = Assert-PhotoLocalNativeDirectory $StagingRoot
    $run = Assert-PhotoLocalNativeRunDirectory -RunDirectory $RunDirectory -StagingRoot $staging -ExpectedSid $ExpectedSid
    if (Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json')) { throw 'NATIVE_ROLLBACK_FORBIDDEN' }
    try {
      $null = Assert-PhotoLocalNativeFile (Join-Path $run 'native-task-disable-intent.json')
      $file = Assert-PhotoLocalNativeFile (Join-Path $run 'native-before.json')
      if ($file.Length -gt 16384) { throw 'INVALID' }
      $saved = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json -ErrorAction Stop
      $state = $saved.state
      if ($saved.version -ne 1 -or $saved.productionRoot -ine $production -or $saved.stagingRoot -ine $staging -or
          $saved.expectedSid -cne $ExpectedSid -or $state.TaskEnabled -ne $true -or
          $state.ProcessId -isnot [int] -or $state.ProcessId -le 0 -or
          $state.TaskFingerprint -cnotmatch '^[0-9a-f]{64}$' -or $state.SourceRunnerHash -cnotmatch '^[0-9a-f]{64}$' -or
          -not $state.ExecutablePath -or -not $state.CreatedUtc) { throw 'INVALID' }
      $null = [datetime]::ParseExact($state.CreatedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    } catch { throw 'NATIVE_ROLLBACK_STATE_INVALID' }
    $task = Get-PhotoLocalNativeTaskState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid -AllowDisabled
    if ($task.TaskFingerprint -cne $state.TaskFingerprint -or $task.SourceRunnerHash -cne $state.SourceRunnerHash) { throw 'NATIVE_STATE_CHANGED' }
    $listeners = @(Get-PhotoLocalNativeListeners)
    if ($listeners.Count -gt 0) {
      if ($listeners.Count -ne 1 -or $listeners[0] -ne $state.ProcessId -or -not (Test-PhotoLocalNativeOriginalAlive -State $state)) { throw 'NATIVE_PORT_BUSY' }
      $current = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid -AllowDisabled
      Assert-PhotoLocalNativeSameState -Actual $current -Expected $state
      if (Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json')) { throw 'NATIVE_ROLLBACK_FORBIDDEN' }
      if (-not $task.TaskEnabled) { Enable-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop | Out-Null }
      $verified = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
      Assert-PhotoLocalNativeSameState -Actual $verified -Expected $state
      return @{status='NATIVE_STILL_RUNNING'}
    }
    if (Test-PhotoLocalNativeOriginalAlive -State $state) { throw 'NATIVE_ROLLBACK_STATE_INVALID' }
    Assert-PhotoLocalNativeNoRemainingWriters -State $state
    # Recheck the irreversible boundary immediately before enabling or starting native work.
    if (Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json')) { throw 'NATIVE_ROLLBACK_FORBIDDEN' }
    if (-not $task.TaskEnabled) { Enable-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop | Out-Null }
    $enabled = Get-PhotoLocalNativeTaskState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
    if ($enabled.TaskFingerprint -cne $state.TaskFingerprint -or $enabled.SourceRunnerHash -cne $state.SourceRunnerHash -or
        @(Get-PhotoLocalNativeListeners).Count -gt 0) { throw 'NATIVE_STATE_CHANGED' }
    if (Test-Path -LiteralPath (Join-Path $run 'production-start-attempted.json')) { throw 'NATIVE_ROLLBACK_FORBIDDEN' }
    Start-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop | Out-Null
    for ($attempt = 0; $attempt -lt 150; $attempt++) {
      try {
        $restored = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
        if ($restored.TaskFingerprint -cne $state.TaskFingerprint -or $restored.SourceRunnerHash -cne $state.SourceRunnerHash) { throw 'NATIVE_STATE_CHANGED' }
        if (Test-PhotoLocalNativeHealth) {
          $verified = Get-PhotoLocalNativeCutoverState -ProductionRoot $production -StagingRoot $staging -ExpectedSid $ExpectedSid
          Assert-PhotoLocalNativeSameState -Actual $verified -Expected $restored
          return @{status='NATIVE_RESTORED'}
        }
      } catch {
        if ($_.Exception.Message -eq 'NATIVE_STATE_CHANGED') { throw 'NATIVE_STATE_CHANGED' }
      }
      Wait-PhotoLocalNativePoll
    }
    throw 'NATIVE_RESTORE_FAILED'
  } catch { Throw-PhotoLocalNativeSafeError $_ 'NATIVE_RESTORE_FAILED' }
}
