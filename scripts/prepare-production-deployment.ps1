param(
  [string]$ProductionRoot = 'C:\PhotoLocal',
  [string]$StagingRoot = 'C:\PhotoLocal-staging',
  [Parameter(Mandatory = $true)][string]$NetworkPrefix,
  [Parameter(Mandatory = $true)][string]$PublicUrl
)

function Get-PhotoLocalDeploymentSourceKeys {
  @('PHOTO_LOCAL_DB', 'PHOTO_LOCAL_LOG', 'PHOTO_LOCAL_PORT', 'PHOTO_LOCAL_HOST',
    'PHOTO_LOCAL_AUTH', 'PHOTO_LOCAL_SHARED_ROOTS', 'GOOGLE_CHAT_DOWNLOAD_ROOT',
    'ADRESY_APP_BASE_URL', 'ADRESY_APP_API_KEY', 'ADRESY_APP_REVERSE_RADIUS_METERS',
    'NOMINATIM_BASE_URL', 'NOMINATIM_USER_AGENT', 'OLLAMA_URL',
    'OLLAMA_NOTES_MODEL', 'OLLAMA_VISION_MODEL', 'OLLAMA_VISION_MODELS')
}

function Get-PhotoLocalDeploymentIdentity {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $sid = $identity.User.Value } finally { $identity.Dispose() }
  $owners = @()
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -Filter "Name='com.docker.backend.exe'" -ErrorAction Stop)) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw 'DOCKER_OWNER_UNAVAILABLE' }
    $owners += [string]$owner.Sid
  }
  @{ Sid = $sid; Owners = @($owners | Sort-Object -Unique) }
}

function Assert-PhotoLocalDeploymentDirectory {
  param([string]$Path)
  if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw 'LOCAL_DIRECTORY_INVALID' }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $directory = New-Object IO.DirectoryInfo($fullPath)
  if (-not $directory.Exists) { throw 'LOCAL_DIRECTORY_INVALID' }
  $ancestor = $directory
  while ($null -ne $ancestor) {
    $ancestor.Refresh()
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_PATH_UNSUPPORTED' }
    $ancestor = $ancestor.Parent
  }
  $directory.FullName
}

function New-PhotoLocalDeploymentRunDirectory {
  param([string]$DataRoot, [string]$Sid, [string]$Name = ('production-' + [guid]::NewGuid().ToString('N')))
  $data = Assert-PhotoLocalDeploymentDirectory -Path $DataRoot
  if ($Name -cnotmatch '^production-[0-9a-f]{32}$') { throw 'PRIVATE_DIRECTORY_INVALID' }
  $path = [IO.Path]::GetFullPath((Join-Path $data $Name))
  if ([IO.Path]::GetDirectoryName($path) -ine $data.TrimEnd('\')) { throw 'PRIVATE_DIRECTORY_INVALID' }
  if (Test-Path -LiteralPath $path) { throw 'PRIVATE_DIRECTORY_EXISTS' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($Sid)))
  foreach ($accountSid in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
    $account = New-Object Security.Principal.SecurityIdentifier($accountSid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  # Windows PowerShell 5: supply the protected ACL when the directory is created,
  # before any credentials or other private output can be written inside it.
  $directory = New-Object IO.DirectoryInfo($path)
  $directory.Create($acl)
  $null = Assert-PhotoLocalDeploymentDirectory -Path $path
  $actual = $directory.GetAccessControl()
  $allowed = @($Sid, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne $allowed.Count) { throw 'PRIVATE_DIRECTORY_INVALID' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or
        $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or
        [string]$rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or
        [string]$rule.PropagationFlags -ne 'None') { throw 'PRIVATE_DIRECTORY_INVALID' }
  }
  $path
}

function Get-PhotoLocalDeploymentScopeVariables {
  param([string]$Scope)
  [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]$Scope)
}

function Get-PhotoLocalDeploymentEnvironmentScopes {
  $result = @{}
  foreach ($scope in @('Process', 'User', 'Machine')) {
    $source = Get-PhotoLocalDeploymentScopeVariables -Scope $scope
    $selected = @{}
    foreach ($key in @(Get-PhotoLocalDeploymentSourceKeys)) {
      $matching = @($source.Keys | Where-Object { [string]$_ -ieq $key })
      if ($matching.Count -gt 1) { throw 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED' }
      if ($matching.Count -eq 1) { $selected[$key] = [string]$source[$matching[0]] }
    }
    $result[$scope.ToLowerInvariant()] = $selected
  }
  $result
}

function New-PhotoLocalDeploymentStartInfo {
  param([string]$NodePath, [string]$HelperPath, [string]$WorkingDirectory)
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $NodePath
  $info.Arguments = '"' + $HelperPath + '"'
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  # Source settings travel only in the private stdin payload, never in the
  # command line or as additional inherited integration-secret environment values.
  foreach ($key in @(Get-PhotoLocalDeploymentSourceKeys)) { $info.EnvironmentVariables.Remove($key) }
  $info
}

function Invoke-PhotoLocalDeploymentNode {
  param([string]$StagingRoot, [string]$RunDirectory, [hashtable]$Payload)
  $helper = Join-Path $StagingRoot 'scripts\prepare-production-deployment.mjs'
  $null = Assert-PhotoLocalDeploymentDirectory -Path ([IO.Path]::GetDirectoryName($helper))
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'HELPER_MISSING' }
  if ((Get-Item -LiteralPath $helper -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_PATH_UNSUPPORTED' }
  $node = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
  $process = New-Object Diagnostics.Process
  $bytes = $null
  try {
    $process.StartInfo = New-PhotoLocalDeploymentStartInfo -NodePath $node -HelperPath $helper -WorkingDirectory $StagingRoot
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $json = ConvertTo-Json -InputObject $Payload -Depth 8 -Compress
    # PowerShell 5 has no StandardInputEncoding property; bypass its text writer.
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $json = $null
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.BaseStream.Close()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $bytes = $null
    $timedOut = -not $process.WaitForExit(240000)
    if ($timedOut -and -not $process.HasExited) {
      # Only this newly launched helper and its children, never any application.
      & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
      [void]$process.WaitForExit(5000)
    }
    $streams = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
    if (-not $streams.Wait(5000)) { throw 'PREPARATION_CAPTURE_FAILED' }
    @{ ExitCode = $(if ($process.HasExited) { $process.ExitCode } else { 1 }); TimedOut = $timedOut; Stdout = $stdout.Result; Stderr = $stderr.Result }
  } finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    try {
      if (-not $process.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
      }
    } catch { }
    $process.Dispose()
  }
}

function Test-PhotoLocalDeploymentCount {
  param($Value)
  (($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and
    $Value -ge 0 -and $Value -le 9007199254740991 -and [math]::Truncate([double]$Value) -eq [double]$Value)
}

function ConvertTo-PhotoLocalDeploymentReport {
  param($Child, [string]$RunDirectory, [string]$ProductionRoot)
  if ($Child.TimedOut) { throw 'PREPARATION_TIMEOUT' }
  try { $report = $Child.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'INVALID_PREPARATION_REPORT' }
  $failures = @('SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', 'GOOGLE_WEB_CLIENT_INVALID', 'GOOGLE_TOKEN_INVALID',
    'GOOGLE_CALLBACK_NOT_LISTED', 'LOCAL_STORAGE_UNAVAILABLE', 'LOCAL_STORAGE_SCAN_LIMIT',
    'INSUFFICIENT_DISK_SPACE', 'DOCKER_IMAGE_UNAVAILABLE', 'PRODUCTION_COMPOSE_INVALID',
    'PRIVATE_DIRECTORY_INVALID', 'SOURCE_DATABASE_INVALID', 'PREPARATION_FAILED')
  if ($report.status -isnot [string] -or $report.runDirectory -isnot [string] -or
      $report.runDirectory -cne $RunDirectory -or
      ($report.status -cne 'PRODUCTION_CONFIG_PREPARED' -and $report.status -cnotin $failures)) { throw 'INVALID_PREPARATION_REPORT' }
  $safe = [ordered]@{ status = $report.status; runDirectory = $RunDirectory; productionCutover = 'NOT_PERFORMED' }
  if ($report.status -cne 'PRODUCTION_CONFIG_PREPARED') {
    if ($Child.ExitCode -eq 0) { throw 'INVALID_PREPARATION_REPORT' }
    if ($null -ne $report.settingNames) {
      $keys = @(Get-PhotoLocalDeploymentSourceKeys)
      $names = @($report.settingNames)
      if ($names.Count -gt $keys.Count -or @($names | Where-Object { $_ -isnot [string] -or $_ -cnotin $keys }).Count -gt 0) { throw 'INVALID_PREPARATION_REPORT' }
      $safe.settingNames = $names
    }
    return $safe
  }
  if ($Child.ExitCode -ne 0 -or $report.productionCutover -cne 'NOT_PERFORMED' -or
      $report.nextStep -cne 'FINAL_SNAPSHOT_REQUIRED' -or $report.sourceDatabase -isnot [string] -or
      $report.sourceDatabase -notmatch '^[A-Za-z]:[\\/]') { throw 'INVALID_PREPARATION_REPORT' }
  $source = [IO.Path]::GetFullPath($report.sourceDatabase)
  if (-not $source.StartsWith($ProductionRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'INVALID_PREPARATION_REPORT' }
  $safe.sourceDatabase = $source
  $safe.sourceCounts = [ordered]@{}
  foreach ($table in @('projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files')) {
    if (-not (Test-PhotoLocalDeploymentCount $report.sourceCounts.$table)) { throw 'INVALID_PREPARATION_REPORT' }
    $safe.sourceCounts[$table] = $report.sourceCounts.$table
  }
  $safe.localFiles = [ordered]@{}
  foreach ($kind in @('downloads', 'localPhotos')) {
    $counts = $report.localFiles.$kind
    if (-not (Test-PhotoLocalDeploymentCount $counts.files) -or -not (Test-PhotoLocalDeploymentCount $counts.bytes)) { throw 'INVALID_PREPARATION_REPORT' }
    $safe.localFiles[$kind] = [ordered]@{ files = $counts.files; bytes = $counts.bytes }
  }
  if (-not (Test-PhotoLocalDeploymentCount $report.requiredFreeBytes) -or
      -not (Test-PhotoLocalDeploymentCount $report.availableFreeBytes)) { throw 'INVALID_PREPARATION_REPORT' }
  $safe.requiredFreeBytes = $report.requiredFreeBytes
  $safe.availableFreeBytes = $report.availableFreeBytes
  if ($report.google.webClient -isnot [bool] -or -not $report.google.webClient -or
      $report.google.refreshTokenCopied -isnot [bool] -or -not $report.google.refreshTokenCopied -or
      $report.google.publicCallbackListed -isnot [bool]) { throw 'INVALID_PREPARATION_REPORT' }
  $safe.google = [ordered]@{ webClient = $true; refreshTokenCopied = $true; publicCallbackListed = $report.google.publicCallbackListed }
  $integrationKeys = @(Get-PhotoLocalDeploymentSourceKeys | Where-Object { $_ -match '^(ADRESY_|NOMINATIM_|OLLAMA_)' })
  $preserved = @($report.preservedIntegrationSettings)
  if ($preserved.Count -gt $integrationKeys.Count -or @($preserved | Where-Object { $_ -isnot [string] -or $_ -cnotin $integrationKeys }).Count -gt 0) { throw 'INVALID_PREPARATION_REPORT' }
  $safe.preservedIntegrationSettings = $preserved
  $safe.nextStep = 'FINAL_SNAPSHOT_REQUIRED'
  $safe
}

function Invoke-PhotoLocalDeploymentPreparation {
  param([string]$ProductionRoot, [string]$StagingRoot, [string]$NetworkPrefix, [string]$PublicUrl)
  $run = $null
  $payload = $null
  try {
    $identity = Get-PhotoLocalDeploymentIdentity
    if (@($identity.Owners).Count -eq 0) { throw 'DOCKER_NOT_RUNNING' }
    if (@($identity.Owners).Count -ne 1 -or $identity.Owners[0] -cne $identity.Sid) { throw 'WRONG_WINDOWS_ACCOUNT' }
    $production = Assert-PhotoLocalDeploymentDirectory -Path $ProductionRoot
    $staging = Assert-PhotoLocalDeploymentDirectory -Path $StagingRoot
    $data = Assert-PhotoLocalDeploymentDirectory -Path (Join-Path $staging 'docker-data')
    $scopes = Get-PhotoLocalDeploymentEnvironmentScopes
    $run = New-PhotoLocalDeploymentRunDirectory -DataRoot $data -Sid $identity.Sid
    $payload = @{ productionRoot = $production; stagingRoot = $staging; runDirectory = $run;
      networkPrefix = $NetworkPrefix; publicUrl = $PublicUrl; environmentScopes = $scopes }
    $child = Invoke-PhotoLocalDeploymentNode -StagingRoot $staging -RunDirectory $run -Payload $payload
    $payload = $null
    # Fresh directory; capture private raw output only after Node has completed.
    [IO.File]::WriteAllText((Join-Path $run 'wrapper.stdout.log'), [string]$child.Stdout, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $run 'wrapper.stderr.log'), [string]$child.Stderr, (New-Object Text.UTF8Encoding($false)))
    ConvertTo-PhotoLocalDeploymentReport -Child $child -RunDirectory $run -ProductionRoot $production
  } catch {
    $allowed = @('DOCKER_OWNER_UNAVAILABLE', 'DOCKER_NOT_RUNNING', 'WRONG_WINDOWS_ACCOUNT',
      'LOCAL_DIRECTORY_INVALID', 'REPARSE_PATH_UNSUPPORTED', 'PRIVATE_DIRECTORY_EXISTS',
      'PRIVATE_DIRECTORY_INVALID', 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', 'HELPER_MISSING',
      'PREPARATION_TIMEOUT', 'PREPARATION_CAPTURE_FAILED', 'INVALID_PREPARATION_REPORT')
    $status = $(if ($_.Exception.Message -cin $allowed) { $_.Exception.Message } else { 'PREPARATION_LAUNCH_FAILED' })
    [ordered]@{ status = $status; runDirectory = $run; productionCutover = 'NOT_PERFORMED' }
  } finally { $payload = $null; $scopes = $null }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  $report = Invoke-PhotoLocalDeploymentPreparation -ProductionRoot $ProductionRoot -StagingRoot $StagingRoot -NetworkPrefix $NetworkPrefix -PublicUrl $PublicUrl
  $report | ConvertTo-Json -Depth 8
  if ($report.status -ne 'PRODUCTION_CONFIG_PREPARED') { exit 1 }
}
