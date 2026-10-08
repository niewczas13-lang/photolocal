param(
  [string]$RunDirectory = 'C:\PhotoLocal-staging\docker-data\production-938460e57d394e1bbe0c1371e4dd391e',
  [switch]$PrepareOnly,
  [switch]$WorkStopped,
  [switch]$DisableSandbox,
  [string]$RollbackReport
)

# Load existing process quoting, timeout and private-directory checks as functions only.
. (Join-Path $PSScriptRoot 'switch-production-to-docker.ps1') -RunDirectory $RunDirectory -WorkStopped:$WorkStopped
$script:PhotoLocalChatUpdateRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PhotoLocalChatBrowserUpdate {
  param([string]$RunDirectory, [switch]$PrepareOnly, [switch]$WorkStopped, [switch]$DisableSandbox, [string]$RollbackReport)
  $mayHaveChanged = $false
  $phase = 'preflight'
  try {
    if (-not $PrepareOnly -and -not $WorkStopped) { throw 'CHAT_BROWSER_UPDATE_WORK_STOPPED_REQUIRED' }
    if ($RollbackReport -and ($PrepareOnly -or $DisableSandbox)) { throw 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION' }
    if ($RunDirectory -notmatch '^[A-Za-z]:[\\/]' -or $RunDirectory -match '[,\x00-\x1f]' -or
        @($RunDirectory -split '[\\/]' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count) { throw 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION' }
    $staging = Assert-PhotoLocalDeploymentDirectory -Path $script:PhotoLocalChatUpdateRoot
    $identity = Get-PhotoLocalDeploymentIdentity
    if ($identity.Owners.Count -ne 1 -or $identity.Owners[0] -cne $identity.Sid) { throw 'CHAT_BROWSER_UPDATE_WRONG_WINDOWS_ACCOUNT' }
    $run = Assert-PhotoLocalNativeRunDirectory -RunDirectory $RunDirectory -StagingRoot $staging -ExpectedSid $identity.Sid
    $node = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
    if (-not $RollbackReport) {
      $git = @(Get-Command git.exe -CommandType Application -ErrorAction Stop)[0].Source
      $status = Invoke-PhotoLocalCutoverProcess -Executable $git -Arguments @('-C', $staging, 'status', '--porcelain', '--untracked-files=no') -WorkingDirectory $staging
      if ($status.ExitCode -ne 0 -or $status.Stdout.Trim()) { throw 'CHAT_BROWSER_UPDATE_GIT_WORKTREE_NOT_CLEAN' }
      $phase = 'git_pull'
      Write-Host 'Aktualizacja kodu i budowanie obrazow. Dane Romka pozostaja w obecnych katalogach.'
      $pull = Invoke-PhotoLocalCutoverProcess -Executable $git -Arguments @('-C', $staging, 'pull', '--ff-only') -WorkingDirectory $staging -TimeoutSeconds 180
      if ($pull.ExitCode -ne 0) { throw 'CHAT_BROWSER_UPDATE_GIT_PULL_FAILED' }
    } else {
      if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($RollbackReport)) -ine $run -or
          [IO.Path]::GetFileName($RollbackReport) -cnotmatch '^chat-browser-rollback-[a-f0-9]{32}\.json$') { throw 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION' }
      Write-Host 'Przywracanie poprzedniego obrazu aplikacji na obecnych danych.'
    }
    $helper = Join-Path $staging 'scripts\update-chat-browser.mjs'
    $null = Assert-PhotoLocalDeploymentDirectory -Path ([IO.Path]::GetDirectoryName($helper))
    $file = Get-Item -LiteralPath $helper -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION' }
    $payload = @{ stagingRoot = $staging; runDirectory = $run; prepareOnly = [bool]$PrepareOnly;
      workStopped = [bool]$WorkStopped; disableSandbox = [bool]$DisableSandbox; rollbackReport = $RollbackReport } | ConvertTo-Json -Compress
    $phase = 'update'
    # A lost child response cannot prove whether application recreation began.
    $mayHaveChanged = -not $PrepareOnly
    $child = Invoke-PhotoLocalCutoverProcess -Executable $node -Arguments @($helper) -WorkingDirectory $staging -InputText $payload -TimeoutSeconds 2850
    try { $report = $child.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID' }
    $recovery = $null
    if ($report.rollbackReport) {
      if ($report.rollbackReport -isnot [string] -or $report.rollbackReport -match '[,\x00-\x1f]' -or
          [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($report.rollbackReport)) -ine $run -or
          [IO.Path]::GetFileName($report.rollbackReport) -cnotmatch '^chat-browser-rollback-[a-f0-9]{32}\.json$') { throw 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID' }
      $recovery = $report.rollbackReport
    }
    if ($report.status -ceq 'CHAT_BROWSER_UPDATE_FAILED') {
      $allowed = @('INVALID_CONFIGURATION', 'INVALID_IMAGE', 'UNSAFE_COMPOSE_MERGE', 'ACTIVE_CONFIGURATION_CHANGED',
        'BROWSER_ISOLATION_FAILED', 'WORK_STOPPED_REQUIRED', 'DOCKER_QUERY_FAILED', 'CONTAINER_IDENTITY_INVALID',
        'COMPOSE_FAILED', 'PROFILE_VOLUME_NOT_OWNED', 'BUILD_FAILED', 'BROWSER_START_FAILED', 'APP_START_FAILED', 'APP_VERIFICATION_FAILED', 'ROLLBACK_FAILED') |
        ForEach-Object { 'CHAT_BROWSER_UPDATE_' + $_ }
      if ($report.code -cnotin $allowed -or $report.phase -cnotin @('preflight', 'build', 'browser_start', 'application_start', 'rollback') -or
          $report.applicationMayHaveChanged -isnot [bool]) { throw 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID' }
      return @{ status = 'CHAT_BROWSER_UPDATE_FAILED'; code = $report.code; phase = $report.phase;
        applicationMayHaveChanged = $report.applicationMayHaveChanged; rollbackReport = $recovery }
    }
    $expectedStatus = if ($RollbackReport) { 'CHAT_BROWSER_ROLLED_BACK' } elseif ($PrepareOnly) { 'CHAT_BROWSER_PREPARED' } else { 'CHAT_BROWSER_UPDATED' }
    $uri = $null
    if ($child.ExitCode -ne 0 -or $report.status -cne $expectedStatus -or
        $report.applicationUpdated -isnot [bool] -or $report.applicationUpdated -eq [bool]$PrepareOnly -or
        (-not $RollbackReport -and ($report.sandboxEnabled -isnot [bool] -or $report.sandboxEnabled -eq [bool]$DisableSandbox)) -or
        -not [Uri]::TryCreate($report.url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID' }
    @{ status = $expectedStatus; url = $uri.GetLeftPart([UriPartial]::Authority); runDirectory = $run;
      sandboxEnabled = $report.sandboxEnabled; applicationUpdated = $report.applicationUpdated; rollbackReport = $recovery }
  } catch {
    $allowed = @('CHAT_BROWSER_UPDATE_WORK_STOPPED_REQUIRED', 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION',
      'CHAT_BROWSER_UPDATE_WRONG_WINDOWS_ACCOUNT', 'CHAT_BROWSER_UPDATE_GIT_WORKTREE_NOT_CLEAN',
      'CHAT_BROWSER_UPDATE_GIT_PULL_FAILED', 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID')
    $code = if ($_.Exception.Message -cin $allowed) { $_.Exception.Message } else { 'CHAT_BROWSER_UPDATE_OPERATION_FAILED' }
    @{ status = 'CHAT_BROWSER_UPDATE_FAILED'; code = $code; phase = $phase; applicationMayHaveChanged = $mayHaveChanged }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-PhotoLocalChatBrowserUpdate -RunDirectory $RunDirectory -PrepareOnly:$PrepareOnly -WorkStopped:$WorkStopped -DisableSandbox:$DisableSandbox -RollbackReport $RollbackReport
  $result | ConvertTo-Json -Depth 4
  if ($result.status -ceq 'CHAT_BROWSER_UPDATE_FAILED') { exit 1 }
}
