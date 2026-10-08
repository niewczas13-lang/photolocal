param(
  [string]$ApplicationRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$RunDirectory,
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'

function Get-PhotoLocalAppUpdateExecutable {
  param([string]$Name)
  @(Get-Command $Name -CommandType Application -ErrorAction Stop)[0].Source
}

function ConvertTo-PhotoLocalAppUpdateArgument {
  param([AllowEmptyString()][string]$Value)
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  '"' + $escaped + '"'
}

function Invoke-PhotoLocalAppUpdateProcess {
  param(
    [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
    [string]$InputText = '', [int]$TimeoutSeconds = 120
  )
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Executable
  $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-PhotoLocalAppUpdateArgument $_ }) -join ' ')
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  $process = New-Object Diagnostics.Process
  $started = $false
  try {
    $process.StartInfo = $info
    $started = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $bytes = [Text.Encoding]::UTF8.GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.BaseStream.Close()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'PRODUCTION_APP_UPDATE_PROCESS_TIMEOUT' }
    $streams = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
    if (-not $streams.Wait(5000)) { throw 'PRODUCTION_APP_UPDATE_PROCESS_TIMEOUT' }
    @{ ExitCode = $process.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
  } finally {
    if ($started -and -not $process.HasExited) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Assert-PhotoLocalAppUpdateDirectory {
  param([string]$Path)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[,\x00-\x1f]' -or
      @($Path -split '[\\/]' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count) {
    throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
  }
  $directory = Get-Item -LiteralPath $Path -ErrorAction Stop
  if (-not $directory.PSIsContainer) { throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION' }
  $current = $directory
  while ($null -ne $current) {
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION' }
    $current = $current.Parent
  }
  $directory.FullName.TrimEnd('\')
}

function Get-PhotoLocalAppUpdateRunDirectory {
  param($Container, [string]$ApplicationRoot, [string]$RequestedRunDirectory)
  $labels = $Container.Config.Labels
  if ($labels.'com.docker.compose.project.config_files' -isnot [string] -or
      -not $labels.'com.docker.compose.project.config_files') {
    throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
  }
  $files = @($labels.'com.docker.compose.project.config_files'.Split(','))
  $firstPath = $files[0].Trim()
  $run = Assert-PhotoLocalAppUpdateDirectory -Path ([IO.Path]::GetDirectoryName($firstPath))
  if ([IO.Path]::GetDirectoryName($run) -ine (Join-Path $ApplicationRoot 'docker-data') -or
      [IO.Path]::GetFileName($run) -cnotmatch '^production-[a-f0-9]{32}$') {
    throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
  }
  if ($RequestedRunDirectory -and
      (Assert-PhotoLocalAppUpdateDirectory -Path $RequestedRunDirectory) -ine $run) {
    throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
  }
  if ($labels.'com.docker.compose.project.working_dir' -isnot [string] -or
      (Assert-PhotoLocalAppUpdateDirectory -Path $labels.'com.docker.compose.project.working_dir') -ine $run) {
    throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
  }
  $hasProductionCompose = $false
  foreach ($filePath in $files) {
    $path = $filePath.Trim()
    if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path -match '[,\x00-\x1f]' -or
        @($path -split '[\\/]' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -or
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -ine $run) {
      throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
    }
    $file = Get-Item -LiteralPath $path -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
    }
    if ($file.Name -ceq 'compose.production.json') { $hasProductionCompose = $true }
  }
  if (-not $hasProductionCompose) { throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION' }
  $run
}

function ConvertTo-PhotoLocalAppUpdateReportPath {
  param($Path, [string]$RunDirectory)
  if ($null -eq $Path -or $Path -eq '') { return $null }
  if ($Path -isnot [string] -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[,\x00-\x1f]' -or
      @($Path -split '[\\/]' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -or
      [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -ine $RunDirectory -or
      [IO.Path]::GetExtension($Path) -cne '.json') {
    throw 'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID'
  }
  [IO.Path]::GetFullPath($Path)
}

function Enter-PhotoLocalAppUpdateLock {
  param([string]$RunDirectory)
  $canonicalRun = [IO.Path]::GetFullPath($RunDirectory).TrimEnd('\').ToUpperInvariant()
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalRun))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
  $mutex = New-Object Threading.Mutex($false, ('Global\PhotoLocalProductionUpdate-' + $digest))
  try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'PRODUCTION_APP_UPDATE_ALREADY_RUNNING' }
    $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-PhotoLocalAppUpdateLock {
  param($Lock)
  try { $Lock.ReleaseMutex() } finally { $Lock.Dispose() }
}

function Invoke-PhotoLocalProductionAppUpdate {
  param([string]$ApplicationRoot, [string]$RunDirectory, [switch]$PrepareOnly)
  $phase = 'preflight'
  $mayHaveChanged = $false
  $updateLock = $null
  try {
    if ($ApplicationRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION' }
    $root = Assert-PhotoLocalAppUpdateDirectory -Path ([IO.Path]::GetFullPath($ApplicationRoot))
    try { $docker = Get-PhotoLocalAppUpdateExecutable -Name 'docker.exe' } catch { throw 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED' }
    $found = Invoke-PhotoLocalAppUpdateProcess -Executable $docker -Arguments @('container', 'ls', '--all',
      '--filter', 'name=^/photolocal-production-photolocal-1$', '--format', '{{.Names}}') -WorkingDirectory $root -TimeoutSeconds 60
    if ($found.ExitCode -ne 0) { throw 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED' }
    if (-not $found.Stdout.Trim()) { return @{ status = 'PRODUCTION_APP_NOT_FOUND'; applicationMayHaveChanged = $false } }
    if ($found.Stdout.Trim() -cne 'photolocal-production-photolocal-1') { throw 'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID' }
    $inspected = Invoke-PhotoLocalAppUpdateProcess -Executable $docker -Arguments @('inspect', 'photolocal-production-photolocal-1') -WorkingDirectory $root -TimeoutSeconds 60
    if ($inspected.ExitCode -ne 0) { throw 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED' }
    try { $containers = @($inspected.Stdout | ConvertFrom-Json -ErrorAction Stop) } catch { throw 'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID' }
    if ($containers.Count -ne 1) { throw 'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID' }
    $container = $containers[0]
    if ($container.Id -cnotmatch '^[a-f0-9]{64}$' -or
        $container.Name -cne '/photolocal-production-photolocal-1' -or
        $container.Config.Labels.'com.docker.compose.project' -cne 'photolocal-production' -or
        $container.Config.Labels.'com.docker.compose.service' -cne 'photolocal' -or
        $container.State.Running -isnot [bool] -or -not $container.State.Running -or
        $container.State.Health.Status -cne 'healthy') {
      throw 'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID'
    }
    $run = Get-PhotoLocalAppUpdateRunDirectory -Container $container -ApplicationRoot $root -RequestedRunDirectory $RunDirectory
    $updateLock = Enter-PhotoLocalAppUpdateLock -RunDirectory $run
    $git = Get-PhotoLocalAppUpdateExecutable -Name 'git.exe'
    $repository = Invoke-PhotoLocalAppUpdateProcess -Executable $git -Arguments @('-C', $root, 'rev-parse', '--show-toplevel') -WorkingDirectory $root
    if ($repository.ExitCode -ne 0 -or [IO.Path]::GetFullPath($repository.Stdout.Trim()).TrimEnd('\') -ine $root) {
      throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION'
    }
    $status = Invoke-PhotoLocalAppUpdateProcess -Executable $git -Arguments @('-C', $root, 'status', '--porcelain=v1', '--untracked-files=no') -WorkingDirectory $root
    if ($status.ExitCode -ne 0 -or $status.Stdout.Trim()) { throw 'PRODUCTION_APP_UPDATE_GIT_WORKTREE_NOT_CLEAN' }
    $branch = Invoke-PhotoLocalAppUpdateProcess -Executable $git -Arguments @('-C', $root, 'branch', '--show-current') -WorkingDirectory $root
    if ($branch.ExitCode -ne 0 -or $branch.Stdout.Trim() -cne 'main') { throw 'PRODUCTION_APP_UPDATE_WRONG_BRANCH' }
    $phase = 'git_pull'
    $pull = Invoke-PhotoLocalAppUpdateProcess -Executable $git -Arguments @('-C', $root, 'pull', '--ff-only') -WorkingDirectory $root -TimeoutSeconds 180
    if ($pull.ExitCode -ne 0) { throw 'PRODUCTION_APP_UPDATE_GIT_PULL_FAILED' }
    $head = Invoke-PhotoLocalAppUpdateProcess -Executable $git -Arguments @('-C', $root, 'rev-parse', 'HEAD') -WorkingDirectory $root
    if ($head.ExitCode -ne 0 -or $head.Stdout.Trim() -cnotmatch '^[a-f0-9]{40}$') { throw 'PRODUCTION_APP_UPDATE_GIT_REVISION_INVALID' }
    $revision = $head.Stdout.Trim()
    $helper = Join-Path $root 'scripts\update-production-app.mjs'
    $null = Assert-PhotoLocalAppUpdateDirectory -Path ([IO.Path]::GetDirectoryName($helper))
    $helperFile = Get-Item -LiteralPath $helper -ErrorAction Stop
    if ($helperFile.PSIsContainer -or ($helperFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION' }
    $node = Get-PhotoLocalAppUpdateExecutable -Name 'node.exe'
    $payload = @{ stagingRoot = $root; runDirectory = $run; revision = $revision; prepareOnly = [bool]$PrepareOnly } | ConvertTo-Json -Compress
    $phase = 'application_start'
    $mayHaveChanged = -not $PrepareOnly
    # Start a new Node process after pull so every MJS dependency is read from the updated checkout.
    $child = Invoke-PhotoLocalAppUpdateProcess -Executable $node -Arguments @($helper) -WorkingDirectory $root -InputText $payload -TimeoutSeconds 2850
    try { $report = $child.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID' }
    $rollbackReport = ConvertTo-PhotoLocalAppUpdateReportPath -Path $report.rollbackReport -RunDirectory $run
    if ($report.status -ceq 'PRODUCTION_APP_UPDATE_FAILED') {
      $allowed = @('INVALID_CONFIGURATION', 'DOCKER_QUERY_FAILED', 'CONTAINER_IDENTITY_INVALID', 'APP_VERIFICATION_FAILED',
        'ACTIVE_CONFIGURATION_CHANGED', 'BUILD_FAILED', 'INVALID_IMAGE', 'COMPOSE_FAILED', 'UNSAFE_COMPOSE_MERGE',
        'APP_START_FAILED', 'ROLLBACK_FAILED', 'LOCKED', 'LOCK_RELEASE_FAILED',
        'SOURCE_CHANGED', 'SOURCE_QUERY_FAILED') | ForEach-Object { 'PRODUCTION_APP_UPDATE_' + $_ }
      if ($child.ExitCode -eq 0 -or $report.code -cnotin $allowed -or
          $report.phase -cnotin @('preflight', 'build', 'application_start') -or
          $report.applicationMayHaveChanged -isnot [bool] -or
          ($report.rollbackStatus -and $report.rollbackStatus -cnotin @('RESTORED', 'FAILED')) -or
          ($report.rollbackCode -and $report.rollbackCode -cnotin $allowed)) {
        throw 'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID'
      }
      return @{ status = 'PRODUCTION_APP_UPDATE_FAILED'; code = $report.code; phase = $report.phase;
        applicationMayHaveChanged = $report.applicationMayHaveChanged; rollbackStatus = $report.rollbackStatus;
        rollbackCode = $report.rollbackCode; rollbackReport = $rollbackReport }
    }
    $allowedStatuses = if ($PrepareOnly) { @('PRODUCTION_APP_PREPARED', 'PRODUCTION_APP_CURRENT') } else { @('PRODUCTION_APP_UPDATED', 'PRODUCTION_APP_CURRENT') }
    if ($child.ExitCode -ne 0 -or $report.status -cnotin $allowedStatuses -or
        $report.runDirectory -ine $run -or $report.revision -cne $revision -or
        $report.previousImageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $report.imageId -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $report.applicationUpdated -isnot [bool] -or
        $report.applicationUpdated -ne ($report.status -ceq 'PRODUCTION_APP_UPDATED')) {
      throw 'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID'
    }
    $override = ConvertTo-PhotoLocalAppUpdateReportPath -Path $report.overridePath -RunDirectory $run
    @{ status = $report.status; runDirectory = $run; revision = $revision; previousImageId = $report.previousImageId;
      imageId = $report.imageId; applicationUpdated = $report.applicationUpdated; overridePath = $override;
      rollbackReport = $rollbackReport }
  } catch {
    $allowed = @('PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION', 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED',
      'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID', 'PRODUCTION_APP_UPDATE_GIT_WORKTREE_NOT_CLEAN',
      'PRODUCTION_APP_UPDATE_GIT_PULL_FAILED', 'PRODUCTION_APP_UPDATE_GIT_REVISION_INVALID',
      'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID', 'PRODUCTION_APP_UPDATE_PROCESS_TIMEOUT',
      'PRODUCTION_APP_UPDATE_ALREADY_RUNNING', 'PRODUCTION_APP_UPDATE_WRONG_BRANCH')
    $code = if ($_.Exception.Message -cin $allowed) { $_.Exception.Message } else { 'PRODUCTION_APP_UPDATE_OPERATION_FAILED' }
    @{ status = 'PRODUCTION_APP_UPDATE_FAILED'; code = $code; phase = $phase; applicationMayHaveChanged = $mayHaveChanged }
  } finally {
    if ($null -ne $updateLock) { Exit-PhotoLocalAppUpdateLock -Lock $updateLock }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-PhotoLocalProductionAppUpdate -ApplicationRoot $ApplicationRoot -RunDirectory $RunDirectory -PrepareOnly:$PrepareOnly
  $result | ConvertTo-Json -Depth 5
  if ($result.code -ceq 'PRODUCTION_APP_UPDATE_WRONG_BRANCH') {
    Write-Host 'Aktualizacja wymaga galezi main. Nie zmieniono galezi ani aplikacji.'
  }
  if ($result.status -ceq 'PRODUCTION_APP_NOT_FOUND') { exit 2 }
  if ($result.status -ceq 'PRODUCTION_APP_UPDATE_FAILED') { exit 1 }
  exit 0
}
