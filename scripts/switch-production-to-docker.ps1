param([string]$RunDirectory, [switch]$WorkStopped)

. (Join-Path $PSScriptRoot 'prepare-production-deployment.ps1') -NetworkPrefix 'X:\unused' -PublicUrl 'https://unused.invalid'
. (Join-Path $PSScriptRoot 'windows-native-cutover.ps1')
$script:PhotoLocalSwitchRoot = Split-Path -Parent $PSScriptRoot

function Write-PhotoLocalCutoverMessage {
  param([string]$Message)
  Write-Host $Message
}

function Write-PhotoLocalCutoverJson {
  param([string]$Path, $Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 12 -Compress))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Read-PhotoLocalCutoverJson {
  param([string]$Path)
  $null = Assert-PhotoLocalDeploymentDirectory -Path ([IO.Path]::GetDirectoryName($Path))
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4194304) { throw 'CUTOVER_PREPARATION_INVALID' }
  # Progress is atomically replaced by Node. Allow rename while this reader is open.
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
  try { $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
}

function Get-PhotoLocalCutoverPlan {
  param([string]$RunDirectory, [string]$ExpectedSid)
  if ($RunDirectory -notmatch '^[A-Za-z]:[\\/]' -or $RunDirectory -match '[,\x00-\x1f]' -or
      @($RunDirectory -split '[\\/]' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count) { throw 'CUTOVER_INPUT_INVALID' }
  $run = Assert-PhotoLocalDeploymentDirectory -Path $RunDirectory
  $staging = Assert-PhotoLocalDeploymentDirectory -Path $script:PhotoLocalSwitchRoot
  if ((Split-Path -Leaf $run) -cnotmatch '^production-[0-9a-f]{32}$' -or
      [IO.Path]::GetDirectoryName($run) -ine (Join-Path $staging 'docker-data')) { throw 'CUTOVER_PREPARATION_INVALID' }
  $acl = (New-Object IO.DirectoryInfo($run)).GetAccessControl()
  $allowed = @($ExpectedSid, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne $allowed.Count -or
      $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ExpectedSid) { throw 'PRIVATE_DIRECTORY_INVALID' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or
        $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or
        [string]$rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or
        [string]$rule.PropagationFlags -ne 'None') { throw 'PRIVATE_DIRECTORY_INVALID' }
  }
  $manifest = Read-PhotoLocalCutoverJson -Path (Join-Path $run 'production-preparation.json')
  if ($manifest.version -ne 1 -or $manifest.status -cne 'PRODUCTION_CONFIG_PREPARED' -or
      $manifest.runDirectory -ine $run -or $manifest.stagingRoot -ine $staging -or
      $manifest.imageId -cnotmatch '^sha256:[0-9a-f]{64}$' -or
      $manifest.composeFile -ine (Join-Path $run 'compose.production.json') -or
      $manifest.emptyEnvironmentFile -ine (Join-Path $run 'empty.env')) { throw 'CUTOVER_PREPARATION_INVALID' }
  $production = Assert-PhotoLocalDeploymentDirectory -Path $manifest.productionRoot
  $uri = $null
  if (-not [Uri]::TryCreate($manifest.publicUrl, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'CUTOVER_PREPARATION_INVALID' }
  @{ runDirectory = $run; productionRoot = $production; stagingRoot = $staging;
    imageId = $manifest.imageId; publicUrl = $manifest.publicUrl;
    composeFile = $manifest.composeFile; emptyEnvironmentFile = $manifest.emptyEnvironmentFile }
}

function ConvertTo-PhotoLocalWindowsArgument {
  param([AllowEmptyString()][string]$Value)
  # CommandLineToArgvW/CRT quoting, without PowerShell/cmd interpretation.
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  '"' + $escaped + '"'
}

function Show-PhotoLocalCutoverProgress {
  param([string]$RunDirectory)
  try {
    $value = Read-PhotoLocalCutoverJson -Path (Join-Path $RunDirectory 'cutover-progress.json')
    $labels = @{ snapshot = 'Kopia bazy'; copy_downloads = 'Kopiowanie pobranych zdjec'; copy_local_photos = 'Kopiowanie zdjec lokalnych'; migrate = 'Dostosowanie sciezek w kopii bazy'; audit = 'Sprawdzanie kopii i dostepu do plikow'; verified = 'Kopia sprawdzona' }
    if ($value.version -ne 1 -or $value.phase -isnot [string] -or -not $labels.ContainsKey($value.phase)) { return }
    $text = $labels[$value.phase]
    if ((Test-PhotoLocalDeploymentCount $value.files) -and (Test-PhotoLocalDeploymentCount $value.totalFiles)) {
      $text += ': ' + $value.files + '/' + $value.totalFiles + ' plikow'
    }
    Write-PhotoLocalCutoverMessage $text
  } catch { }
}

function Invoke-PhotoLocalCutoverProcess {
  param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
    [string]$InputText = '', [int]$TimeoutSeconds = 120, [string]$ProgressDirectory = '')
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Executable
  $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-PhotoLocalWindowsArgument $_ }) -join ' ')
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  foreach ($key in @(Get-PhotoLocalDeploymentSourceKeys)) { $info.EnvironmentVariables.Remove($key) }
  $process = New-Object Diagnostics.Process
  $bytes = $null; $started = $false
  try {
    $process.StartInfo = $info
    $started = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $bytes = [Text.Encoding]::UTF8.GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Flush(); $process.StandardInput.BaseStream.Close()
    [Array]::Clear($bytes, 0, $bytes.Length); $bytes = $null; $InputText = $null
    $watch = [Diagnostics.Stopwatch]::StartNew(); $lastProgress = -15
    while (-not $process.WaitForExit(1000)) {
      if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'CUTOVER_PROCESS_TIMEOUT' }
      if ($ProgressDirectory -and $watch.Elapsed.TotalSeconds - $lastProgress -ge 15) {
        Show-PhotoLocalCutoverProgress -RunDirectory $ProgressDirectory
        $lastProgress = $watch.Elapsed.TotalSeconds
      }
    }
    $streams = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
    if (-not $streams.Wait(5000)) { throw 'CUTOVER_CAPTURE_FAILED' }
    @{ ExitCode = $process.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
  } finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($started -and -not $process.HasExited) {
      # Only this helper/CLI process tree. Docker daemon and application processes
      # are not its children; any scoped probe cleanup is reported separately.
      & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Invoke-PhotoLocalCutoverDocker {
  param($Plan, [string[]]$Arguments, [int]$TimeoutSeconds = 60)
  $docker = @(Get-Command docker.exe -CommandType Application -ErrorAction Stop)[0].Source
  $child = Invoke-PhotoLocalCutoverProcess -Executable $docker -Arguments $Arguments -WorkingDirectory $Plan.stagingRoot -TimeoutSeconds $TimeoutSeconds
  $log = Join-Path $Plan.runDirectory ('docker-call-' + [guid]::NewGuid().ToString('N') + '.json')
  Write-PhotoLocalCutoverJson -Path $log -Value $child
  $child
}

function ConvertTo-PhotoLocalCutoverCounts {
  param($Value)
  $result = [ordered]@{}
  foreach ($table in @('projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files')) {
    if (-not (Test-PhotoLocalDeploymentCount $Value.$table)) { throw 'CUTOVER_COUNTS_MISMATCH' }
    $result[$table] = $Value.$table
  }
  if ($result.projects -le 0) { throw 'CUTOVER_COUNTS_MISMATCH' }
  $result
}

function ConvertTo-PhotoLocalCutoverGaps {
  param($Value)
  if (-not (Test-PhotoLocalDeploymentCount $Value.projectFolders) -or -not (Test-PhotoLocalDeploymentCount $Value.photoSamples)) { throw 'CUTOVER_AUDIT_INVALID' }
  @{ projectFolders = $Value.projectFolders; photoSamples = $Value.photoSamples }
}

function Get-PhotoLocalCutoverFailureCode {
  param([string]$Message)
  $allowed = @('CUTOVER_INPUT_INVALID', 'CUTOVER_PREPARATION_INVALID', 'CUTOVER_PREPARATION_CHANGED', 'CUTOVER_ALREADY_ATTEMPTED',
    'CUTOVER_DESTINATION_NOT_EMPTY', 'CUTOVER_PREFLIGHT_REQUIRED', 'CUTOVER_NATIVE_STOP_REQUIRED', 'CUTOVER_SOURCE_CHANGED',
    'CUTOVER_AUDIT_INVALID', 'CUTOVER_COUNTS_MISMATCH', 'CUTOVER_UNACCEPTED_STORAGE_GAPS', 'CUTOVER_NEW_STORAGE_GAPS',
    'CUTOVER_MIGRATION_FAILED', 'CUTOVER_PROBE_TIMEOUT', 'CUTOVER_CONTAINER_CLEANUP_REQUIRED', 'CUTOVER_OPERATION_FAILED',
    'CUTOVER_PROCESS_TIMEOUT', 'CUTOVER_CAPTURE_FAILED', 'CUTOVER_CHILD_REPORT_INVALID', 'CUTOVER_CONTAINER_IDENTITY_INVALID',
    'CUTOVER_PRODUCTION_EXISTS', 'CUTOVER_DOCKER_QUERY_FAILED', 'CUTOVER_STAGING_STOP_FAILED', 'CUTOVER_PORT_BUSY',
    'CUTOVER_DOCKER_START_FAILED', 'CUTOVER_HEALTH_CHECK_FAILED', 'CUTOVER_PUBLIC_CHECK_FAILED',
    'DOCKER_NOT_RUNNING', 'DOCKER_OWNER_UNAVAILABLE', 'WRONG_WINDOWS_ACCOUNT', 'PRIVATE_DIRECTORY_INVALID',
    'LOCAL_DIRECTORY_INVALID', 'REPARSE_PATH_UNSUPPORTED', 'SOURCE_ENV_OVERRIDE_REVIEW_REQUIRED', 'SOURCE_DATABASE_INVALID',
    'LOCAL_STORAGE_UNAVAILABLE', 'LOCAL_STORAGE_SCAN_LIMIT', 'INSUFFICIENT_DISK_SPACE', 'DOCKER_IMAGE_UNAVAILABLE', 'PRODUCTION_COMPOSE_INVALID',
    'LOCAL_COPY_SOURCE_CHANGED', 'LOCAL_COPY_VERIFICATION_FAILED', 'LOCAL_COPY_FAILED', 'LOCAL_COPY_LIMIT_EXCEEDED',
    'LOCAL_COPY_INVALID_PATH', 'LOCAL_COPY_DESTINATION_NOT_EMPTY', 'LOCAL_COPY_UNSAFE_PATH', 'LOCAL_COPY_DESTINATION_CHANGED', 'LOCAL_COPY_SCAN_LIMIT', 'LOCAL_COPY_TIMEOUT',
    'SNAPSHOT_FAILED', 'SNAPSHOT_TIMEOUT', 'NATIVE_STOP_FAILED', 'NATIVE_PRIVATE_DIRECTORY_INVALID', 'NATIVE_RUN_STATE_EXISTS',
    'NATIVE_IDENTITY_UNVERIFIED', 'NATIVE_TASK_UNSUPPORTED', 'NATIVE_WRITERS_PRESENT',
    'NATIVE_STATE_CHANGED', 'NATIVE_STOP_TIMEOUT', 'NATIVE_PORT_BUSY', 'NATIVE_ROLLBACK_FORBIDDEN', 'NATIVE_ROLLBACK_STATE_INVALID', 'NATIVE_RESTORE_FAILED')
  if ($Message -cin $allowed) { $Message } else { 'CUTOVER_OPERATION_FAILED' }
}

function Invoke-PhotoLocalDataFinalizer {
  param($Plan, [ValidateSet('preflight', 'finalize')][string]$Mode, $EnvironmentScopes)
  $helper = Join-Path $Plan.stagingRoot 'scripts\finalize-production-data.mjs'
  $null = Assert-PhotoLocalDeploymentDirectory -Path ([IO.Path]::GetDirectoryName($helper))
  $item = Get-Item -LiteralPath $helper -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'CUTOVER_PREPARATION_INVALID' }
  $node = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
  $payload = @{mode = $Mode; runDirectory = $Plan.runDirectory; environmentScopes = $EnvironmentScopes} | ConvertTo-Json -Depth 8 -Compress
  try {
    $timeout = $(if ($Mode -eq 'preflight') { 900 } else { 4500 })
    $child = Invoke-PhotoLocalCutoverProcess -Executable $node -Arguments @($helper) -WorkingDirectory $Plan.stagingRoot -InputText $payload -TimeoutSeconds $timeout -ProgressDirectory $Plan.runDirectory
  } finally { $payload = $null }
  Write-PhotoLocalCutoverJson -Path (Join-Path $Plan.runDirectory ($Mode + '-child.json')) -Value $child
  try { $value = $child.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'CUTOVER_CHILD_REPORT_INVALID' }
  $expected = $(if ($Mode -eq 'preflight') {'CUTOVER_PREFLIGHT_OK'} else {'FINAL_COPY_VERIFIED'})
  if ($child.ExitCode -ne 0) { throw (Get-PhotoLocalCutoverFailureCode ([string]$value.status)) }
  if ($value.status -cne $expected -or $value.runDirectory -ine $Plan.runDirectory -or
      $value.productionRoot -ine $Plan.productionRoot -or $value.stagingRoot -ine $Plan.stagingRoot -or
      $value.imageId -cne $Plan.imageId -or $value.publicUrl -cne $Plan.publicUrl) { throw 'CUTOVER_CHILD_REPORT_INVALID' }
  $marker = $(if ($Mode -eq 'preflight') {'cutover-preflight.json'} else {'final-copy.json'})
  $saved = Read-PhotoLocalCutoverJson -Path (Join-Path $Plan.runDirectory $marker)
  if ($saved.version -ne 1 -or $saved.status -cne $expected -or $saved.runDirectory -ine $Plan.runDirectory) { throw 'CUTOVER_CHILD_REPORT_INVALID' }
  $counts = ConvertTo-PhotoLocalCutoverCounts $value.counts
  $savedCounts = ConvertTo-PhotoLocalCutoverCounts $saved.counts
  foreach ($key in $counts.Keys) { if ($counts[$key] -ne $savedCounts[$key]) { throw 'CUTOVER_COUNTS_MISMATCH' } }
  @{status = $expected; runDirectory = $Plan.runDirectory; counts = $counts; nasGaps = (ConvertTo-PhotoLocalCutoverGaps $value.nasGaps)}
}

function ConvertTo-PhotoLocalCutoverContainer {
  param($Value, [string]$Project, [string]$ImageId, [string]$HostIp, [string]$HostPort)
  if ($Value.id -cnotmatch '^[0-9a-f]{64}$' -or $Value.image -cne $ImageId -or
      $Value.project -cne $Project -or $Value.service -cne 'photolocal' -or
      $Value.running -isnot [bool]) { throw 'CUTOVER_CONTAINER_IDENTITY_INVALID' }
  $portKeys = @(if ($Value.ports -is [Collections.IDictionary]) { $Value.ports.Keys } else { $Value.ports.PSObject.Properties.Name })
  $binding = @($Value.ports.'4873/tcp')
  if ($portKeys.Count -ne 1 -or $portKeys[0] -cne '4873/tcp' -or $binding.Count -ne 1 -or
      $binding[0].HostIp -cne $HostIp -or $binding[0].HostPort -cne $HostPort) { throw 'CUTOVER_CONTAINER_IDENTITY_INVALID' }
  $health = $(if ($Value.health -cin @('healthy', 'unhealthy', 'starting', 'none')) { $Value.health } else { 'none' })
  @{id = $Value.id; running = $Value.running; health = $health}
}

function Get-PhotoLocalCutoverContainer {
  param($Plan, [string]$Target, [string]$Project, [string]$HostIp, [string]$HostPort)
  # Never inspect Env, labels wholesale, mounts or storage-driver options.
  $format = '{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"ports":{{json .HostConfig.PortBindings}}}'
  $child = Invoke-PhotoLocalCutoverDocker -Plan $Plan -Arguments @('container', 'inspect', '--format', $format, $Target)
  if ($child.ExitCode -ne 0) { throw 'CUTOVER_DOCKER_QUERY_FAILED' }
  try { $value = $child.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'CUTOVER_CONTAINER_IDENTITY_INVALID' }
  ConvertTo-PhotoLocalCutoverContainer -Value $value -Project $Project -ImageId $Plan.imageId -HostIp $HostIp -HostPort $HostPort
}

function Assert-PhotoLocalProductionAbsent {
  param($Plan)
  $child = Invoke-PhotoLocalCutoverDocker -Plan $Plan -Arguments @('ps', '-aq', '--filter', 'label=com.docker.compose.project=photolocal-production')
  if ($child.ExitCode -ne 0) { throw 'CUTOVER_DOCKER_QUERY_FAILED' }
  if ($child.Stdout.Trim()) { throw 'CUTOVER_PRODUCTION_EXISTS' }
}

function Get-PhotoLocalStagingForCutover {
  param($Plan)
  Get-PhotoLocalCutoverContainer -Plan $Plan -Target 'photolocal-staging-photolocal-1' -Project 'photolocal-staging' -HostIp '127.0.0.1' -HostPort '4874'
}

function Stop-PhotoLocalStagingForCutover {
  param($Plan, $Expected)
  $fresh = Get-PhotoLocalCutoverContainer -Plan $Plan -Target $Expected.id -Project 'photolocal-staging' -HostIp '127.0.0.1' -HostPort '4874'
  if ($fresh.id -cne $Expected.id) { throw 'CUTOVER_CONTAINER_IDENTITY_INVALID' }
  Write-PhotoLocalCutoverJson -Path (Join-Path $Plan.runDirectory 'staging-before.json') -Value $fresh
  if ($fresh.running) {
    $child = Invoke-PhotoLocalCutoverDocker -Plan $Plan -Arguments @('stop', '--time', '30', $fresh.id) -TimeoutSeconds 60
    if ($child.ExitCode -ne 0) { throw 'CUTOVER_STAGING_STOP_FAILED' }
  }
  $after = Get-PhotoLocalCutoverContainer -Plan $Plan -Target $Expected.id -Project 'photolocal-staging' -HostIp '127.0.0.1' -HostPort '4874'
  if ($after.running) { throw 'CUTOVER_STAGING_STOP_FAILED' }
}

function Assert-PhotoLocalCutoverPortFree {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 4873 })
  if ($listeners.Count) { throw 'CUTOVER_PORT_BUSY' }
}

function Start-PhotoLocalProductionCompose {
  param($Plan)
  $child = Invoke-PhotoLocalCutoverDocker -Plan $Plan -Arguments @('compose', '--ansi', 'never', '-p', 'photolocal-production',
    '--project-directory', $Plan.runDirectory, '--env-file', $Plan.emptyEnvironmentFile, '-f', $Plan.composeFile,
    'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'photolocal') -TimeoutSeconds 180
  if ($child.ExitCode -ne 0) { throw 'CUTOVER_DOCKER_START_FAILED' }
}

function Get-PhotoLocalCutoverWebResponse {
  param([string]$Url)
  # Use normal TLS validation. A proxy returning another app must not count as success.
  $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 3 -ErrorAction Stop
  } finally { [Net.ServicePointManager]::SecurityProtocol = $previousProtocol }
  if ($response.StatusCode -ne 200) { throw 'CUTOVER_HEALTH_CHECK_FAILED' }
  $response.Content
}

function Test-PhotoLocalProductionAfterSwitch {
  param($Plan, $ExpectedCounts)
  $container = Get-PhotoLocalCutoverContainer -Plan $Plan -Target 'photolocal-production-photolocal-1' -Project 'photolocal-production' -HostIp '0.0.0.0' -HostPort '4873'
  if (-not $container.running -or $container.health -cne 'healthy') { throw 'CUTOVER_HEALTH_CHECK_FAILED' }
  $code = 'const {createRequire}=require("node:module");const Database=createRequire("/app/backend/package.json")("better-sqlite3");const db=new Database("/data/photo-local.sqlite",{readonly:true,fileMustExist:true});try{const tables=["projects","photos","map_note_photos","chat_photo_batches","chat_photo_files"];const counts=db.transaction(()=>Object.fromEntries(tables.map(t=>[t,db.prepare("SELECT count(*) AS n FROM "+t).get().n])))();process.stdout.write(JSON.stringify(counts));}finally{db.close();}'
  $child = Invoke-PhotoLocalCutoverDocker -Plan $Plan -Arguments @('exec', $container.id, 'node', '-e', $code)
  if ($child.ExitCode -ne 0) { throw 'CUTOVER_COUNTS_MISMATCH' }
  try { $counts = ConvertTo-PhotoLocalCutoverCounts ($child.Stdout | ConvertFrom-Json -ErrorAction Stop) } catch { throw 'CUTOVER_COUNTS_MISMATCH' }
  foreach ($key in $counts.Keys) { if ($counts[$key] -ne $ExpectedCounts[$key]) { throw 'CUTOVER_COUNTS_MISMATCH' } }
  try {
    $privateHealth = (Get-PhotoLocalCutoverWebResponse 'http://127.0.0.1:4873/health') | ConvertFrom-Json -ErrorAction Stop
    if ($privateHealth.ok -ne $true) { throw 'CUTOVER_HEALTH_CHECK_FAILED' }
  } catch { throw 'CUTOVER_HEALTH_CHECK_FAILED' }
  try {
    $nonce = [guid]::NewGuid().ToString('N')
    $public = $Plan.publicUrl.TrimEnd('/')
    $publicHealth = (Get-PhotoLocalCutoverWebResponse ($public + '/health?cutover=' + $nonce)) | ConvertFrom-Json -ErrorAction Stop
    if ($publicHealth.ok -ne $true) { throw 'CUTOVER_PUBLIC_CHECK_FAILED' }
    $localHtml = [string](Get-PhotoLocalCutoverWebResponse ('http://127.0.0.1:4873/?cutover=' + $nonce))
    $publicHtml = [string](Get-PhotoLocalCutoverWebResponse ($public + '/?cutover=' + $nonce))
    if ($localHtml.Length -lt 100 -or $localHtml -cne $publicHtml) { throw 'CUTOVER_PUBLIC_CHECK_FAILED' }
  } catch { throw 'CUTOVER_PUBLIC_CHECK_FAILED' }
  @{status = 'PRODUCTION_VERIFIED'; counts = $counts; publicVerified = $true}
}

function Invoke-PhotoLocalProductionSwitch {
  param([string]$RunDirectory, [switch]$WorkStopped)
  if (-not $WorkStopped) { return @{status = 'WORK_PAUSE_REQUIRED'; productionCutover = 'NOT_PERFORMED'} }
  $plan = $null; $ownedAttempt = $false; $scopes = $null
  try {
    $identity = Get-PhotoLocalDeploymentIdentity
    if (@($identity.Owners).Count -eq 0) { throw 'DOCKER_NOT_RUNNING' }
    if (@($identity.Owners).Count -ne 1 -or $identity.Owners[0] -cne $identity.Sid) { throw 'WRONG_WINDOWS_ACCOUNT' }
    $plan = Get-PhotoLocalCutoverPlan -RunDirectory $RunDirectory -ExpectedSid $identity.Sid
    foreach ($name in @('production-start-attempted.json', 'native-task-disable-intent.json', 'native-stopped.json', 'cutover-coordinator-attempt.json', 'cutover-preflight-attempt.json')) {
      if (Test-Path -LiteralPath (Join-Path $plan.runDirectory $name)) { throw 'CUTOVER_ALREADY_ATTEMPTED' }
    }
    $native = Get-PhotoLocalNativeCutoverState -ProductionRoot $plan.productionRoot -StagingRoot $plan.stagingRoot -ExpectedSid $identity.Sid
    Assert-PhotoLocalProductionAbsent -Plan $plan
    $staging = Get-PhotoLocalStagingForCutover -Plan $plan
    $scopes = Get-PhotoLocalDeploymentEnvironmentScopes
    Write-PhotoLocalCutoverJson -Path (Join-Path $plan.runDirectory 'cutover-coordinator-attempt.json') -Value @{version = 1; startedUtc = [DateTime]::UtcNow.ToString('o')}
    $ownedAttempt = $true
    Write-PhotoLocalCutoverMessage 'Kontrola przed przerwa: aktualna baza, obraz Dockera, wolne miejsce i dostep do plikow.'
    $preflight = Invoke-PhotoLocalDataFinalizer -Plan $plan -Mode preflight -EnvironmentScopes $scopes
    if ($preflight.status -cne 'CUTOVER_PREFLIGHT_OK') { throw 'CUTOVER_CHILD_REPORT_INVALID' }
    Write-PhotoLocalCutoverMessage 'Rozpoczyna sie przerwa: zatrzymanie podgladu i starej Romki. Nie zamykaj tego okna.'
    Stop-PhotoLocalStagingForCutover -Plan $plan -Expected $staging
    $stopped = Stop-PhotoLocalNativeForCutover -ExpectedState $native -ProductionRoot $plan.productionRoot -StagingRoot $plan.stagingRoot -ExpectedSid $identity.Sid -RunDirectory $plan.runDirectory
    if ($stopped.status -cne 'NATIVE_STOPPED') { throw 'NATIVE_STOP_TIMEOUT' }
    $final = Invoke-PhotoLocalDataFinalizer -Plan $plan -Mode finalize -EnvironmentScopes $scopes
    if ($final.status -cne 'FINAL_COPY_VERIFIED') { throw 'CUTOVER_CHILD_REPORT_INVALID' }
    $counts = ConvertTo-PhotoLocalCutoverCounts $final.counts
    $gaps = ConvertTo-PhotoLocalCutoverGaps $final.nasGaps
    Assert-PhotoLocalCutoverPortFree
    Assert-PhotoLocalProductionAbsent -Plan $plan
    # From this durable boundary onwards the new app may accept writes. Even an
    # uncertain Docker response must never cause automatic stale native recovery.
    Write-PhotoLocalCutoverJson -Path (Join-Path $plan.runDirectory 'production-start-attempted.json') -Value @{version = 1; runDirectory = $plan.runDirectory; createdUtc = [DateTime]::UtcNow.ToString('o'); counts = $counts}
    Write-PhotoLocalCutoverMessage 'Kopia sprawdzona. Uruchamianie produkcji w Dockerze na porcie 4873.'
    Start-PhotoLocalProductionCompose -Plan $plan
    $verified = Test-PhotoLocalProductionAfterSwitch -Plan $plan -ExpectedCounts $counts
    if ($verified.status -cne 'PRODUCTION_VERIFIED' -or $verified.publicVerified -ne $true) { throw 'CUTOVER_HEALTH_CHECK_FAILED' }
    $report = [ordered]@{status = 'PRODUCTION_RUNNING'; runDirectory = $plan.runDirectory; publicUrl = $plan.publicUrl;
      counts = $counts; nasGaps = $gaps; nativeAutostart = 'DISABLED'; staging = 'STOPPED'; publicVerified = $true; manualCheckRequired = $true}
    Write-PhotoLocalCutoverJson -Path (Join-Path $plan.runDirectory 'cutover-result.json') -Value $report
    $report
  } catch {
    $code = Get-PhotoLocalCutoverFailureCode $_.Exception.Message
    $status = 'CUTOVER_NOT_STARTED'; $recovery = $null
    if ($null -ne $plan) {
      if (Test-Path -LiteralPath (Join-Path $plan.runDirectory 'production-start-attempted.json')) {
        $status = 'PRODUCTION_NEEDS_ATTENTION'
      } elseif ($ownedAttempt -and (Test-Path -LiteralPath (Join-Path $plan.runDirectory 'native-task-disable-intent.json'))) {
        try {
          $restored = Restore-PhotoLocalNativeAfterFailedCutover -ProductionRoot $plan.productionRoot -StagingRoot $plan.stagingRoot -ExpectedSid $identity.Sid -RunDirectory $plan.runDirectory
          if ($restored.status -cnotin @('NATIVE_RESTORED', 'NATIVE_STILL_RUNNING')) { throw 'NATIVE_RESTORE_FAILED' }
          $status = 'CUTOVER_FAILED_NATIVE_RESTORED'; $recovery = $restored.status
        } catch { $status = 'NATIVE_RECOVERY_NEEDS_ATTENTION'; $recovery = Get-PhotoLocalCutoverFailureCode $_.Exception.Message }
      }
    }
    $report = [ordered]@{status = $status; failureCode = $code; runDirectory = $(if ($plan) {$plan.runDirectory} else {$null})}
    if ($recovery) { $report.recovery = $recovery }
    if ($ownedAttempt) {
      try { Write-PhotoLocalCutoverJson -Path (Join-Path $plan.runDirectory ('cutover-failure-' + [guid]::NewGuid().ToString('N') + '.json')) -Value $report } catch { }
    }
    $report
  } finally { $scopes = $null }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  $report = Invoke-PhotoLocalProductionSwitch -RunDirectory $RunDirectory -WorkStopped:$WorkStopped
  $report | ConvertTo-Json -Depth 10
  if ($report.status -cne 'PRODUCTION_RUNNING') { exit 1 }
}
