param(
  [string]$ProductionRoot = 'C:\PhotoLocal',
  [ValidateRange(1, 65535)][int]$Port = 4873
)

function Get-PhotoLocalProductionInventory {
  param([string]$ProductionRoot, [int]$Port = 4873)

  # Read-only observations, not authorization to stop any process. Never print
  # environment values, process command lines, task arguments or raw exceptions.
  $root = (Get-Item -LiteralPath $ProductionRoot -ErrorAction Stop).FullName
  $knownSettings = @(
    'PHOTO_LOCAL_HOST', 'PHOTO_LOCAL_PORT', 'PHOTO_LOCAL_DB', 'PHOTO_LOCAL_LOG',
    'PHOTO_LOCAL_AUTH', 'PHOTO_LOCAL_SHARED_ROOTS', 'GOOGLE_CHAT_PYTHON',
    'GOOGLE_CHAT_DOWNLOAD_ROOT', 'GOOGLE_CHAT_CREDENTIALS_FILE', 'GOOGLE_CHAT_TOKEN_FILE',
    'GOOGLE_CHAT_OAUTH_REDIRECT_URI', 'GOOGLE_CHAT_JOB_STATE_FILE',
    'GOOGLE_CHAT_INVITE_PROFILE_DIR', 'GOOGLE_CHAT_INVITE_HEADLESS',
    'GOOGLE_CHAT_BROWSER_PATH', 'GOOGLE_CHROME_PATH', 'GOOGLE_EDGE_PATH',
    'ADRESY_APP_BASE_URL', 'ADRESY_APP_API_KEY', 'ADRESY_APP_REVERSE_RADIUS_METERS',
    'NOMINATIM_BASE_URL', 'NOMINATIM_USER_AGENT', 'OLLAMA_URL',
    'OLLAMA_NOTES_MODEL', 'OLLAMA_VISION_MODEL', 'OLLAMA_VISION_MODELS'
  )
  $environmentStatus = 'MISSING'
  $declaredSettings = @()
  $environmentPath = Join-Path $root '.env'
  if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
    try {
      # Assignment-name inventory only. This is not a dotenv parser or the
      # running process's effective configuration, particularly for multiline values.
      $environmentLines = Get-Content -LiteralPath $environmentPath -Encoding UTF8 -ErrorAction Stop
      $declaredSettings = @($environmentLines | ForEach-Object {
        if ($_ -cmatch '^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=') {
          if ($Matches[1] -cin $knownSettings) { $Matches[1] }
        }
      } | Sort-Object -Unique)
      $environmentStatus = 'READ'
    } catch { $environmentStatus = 'UNAVAILABLE' }
    $environmentLines = $null
  }

  $locations = [ordered]@{}
  foreach ($location in @(
    @{ Name = 'database'; Relative = 'backend\data\photo-local.sqlite'; Key = 'PHOTO_LOCAL_DB' },
    @{ Name = 'downloads'; Relative = 'pobierzchat\pobrane_zdjecia'; Key = 'GOOGLE_CHAT_DOWNLOAD_ROOT' },
    @{ Name = 'localPhotos'; Relative = ('backend\zdj' + [char]0x119 + 'cia'); Key = '' }
  )) {
    $locationPath = Join-Path $root $location.Relative
    $locations[$location.Name] = [ordered]@{
      path = $locationPath
      exists = [bool](Test-Path -LiteralPath $locationPath)
      configurationOverrideDeclared = $(if ($location.Key -and $environmentStatus -eq 'UNAVAILABLE') { $null } else { [bool]($location.Key -and $location.Key -cin $declaredSettings) })
      isResolvedLivePath = $false
    }
  }

  $storedProcessId = $null
  $pidFile = Join-Path $root 'photo-local.pid'
  try {
    $pidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop).Trim()
    $parsedProcessId = 0
    if ([int]::TryParse($pidText, [ref]$parsedProcessId) -and $parsedProcessId -gt 0) {
      $storedProcessId = $parsedProcessId
    }
  } catch { }
  $processQueryStatus = 'READ'
  try { $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
  catch { $processes = @(); $processQueryStatus = 'UNAVAILABLE' }
  $listenerQueryStatus = 'READ'
  try { $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port }) }
  catch { $connections = @(); $listenerQueryStatus = 'UNAVAILABLE' }
  $listeners = @($connections | ForEach-Object {
    $connection = $_
    $ownerProcessId = [int]$connection.OwningProcess
    $owner = @($processes | Where-Object { $_.ProcessId -eq $ownerProcessId }) | Select-Object -First 1
    $entry = Join-Path $root 'backend\dist\server.js'
    $entryPattern = '(?:^|\s)"?(?:' + [regex]::Escape($entry) + '|dist[\\/]server\.js)"?(?:\s|$)'
    $descendants = @()
    if ($null -ne $owner) {
      $seen = @($ownerProcessId)
      $parents = @($owner)
      # A CIM snapshot cannot prove process ownership across PID reuse. Check
      # creation times and describe matches only; do not kill from this report.
      while ($parents.Count -gt 0) {
        $next = @()
        foreach ($parent in $parents) {
          foreach ($child in $processes) {
            if ($child.ParentProcessId -eq $parent.ProcessId -and
                $child.ProcessId -notin $seen -and
                $null -ne $child.CreationDate -and $null -ne $parent.CreationDate -and
                $child.CreationDate -ge $parent.CreationDate) {
              $seen += [int]$child.ProcessId
              $next += $child
              $descendants += [ordered]@{ processId = [int]$child.ProcessId; name = $child.Name }
            }
          }
        }
        $parents = $next
      }
    }
    [ordered]@{
      address = $connection.LocalAddress
      port = [int]$connection.LocalPort
      processId = $ownerProcessId
      processMetadataAvailable = ($null -ne $owner)
      name = $(if ($null -ne $owner) { $owner.Name } else { $null })
      executablePath = $(if ($null -ne $owner) { $owner.ExecutablePath } else { $null })
      createdUtc = $(if ($null -ne $owner -and $null -ne $owner.CreationDate) { $owner.CreationDate.ToUniversalTime().ToString('o') } else { $null })
      matchesPidFile = ($null -ne $storedProcessId -and $storedProcessId -eq $ownerProcessId)
      containsExpectedEntrypoint = [bool]($null -ne $owner -and $owner.CommandLine -match $entryPattern)
      descendants = @($descendants)
    }
  })

  $autostart = [ordered]@{ status = 'UNAVAILABLE' }
  try {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskPath '\' -TaskName 'PhotoLocal Autostart' -ErrorAction Stop
    $expectedAction = Join-Path $root 'scripts\start-autostart.ps1'
    $actionPattern = '(?:^|\s)"?' + [regex]::Escape($expectedAction) + '"?(?:\s|$)'
    $autostart = [ordered]@{
      status = 'READ'
      state = [string]$task.State
      enabled = [bool]$task.Settings.Enabled
      logonType = [string]$task.Principal.LogonType
      lastRunUtc = $taskInfo.LastRunTime.ToUniversalTime().ToString('o')
      lastResult = $taskInfo.LastTaskResult
      actionCount = @($task.Actions).Count
      containsExpectedScriptPath = [bool](@($task.Actions | Where-Object { $_.Arguments -match $actionPattern }).Count -gt 0)
    }
  } catch { }

  $freeBytes = $null
  try {
    $driveId = [IO.Path]::GetPathRoot($root).TrimEnd('\')
    $drive = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID -eq $driveId } | Select-Object -First 1
    if ($null -ne $drive) { $freeBytes = $drive.FreeSpace }
  } catch { }
  [ordered]@{
    status = 'READ_ONLY_INVENTORY'
    readiness = 'NOT_ASSESSED'
    productionRoot = $root
    serverEntryExists = [bool](Test-Path -LiteralPath (Join-Path $root 'backend\dist\server.js') -PathType Leaf)
    environmentFile = [ordered]@{ status = $environmentStatus; declaredSettings = @($declaredSettings); liveProcessOverrides = 'NOT_INSPECTED' }
    defaultLocations = $locations
    processQueryStatus = $processQueryStatus
    listenerQueryStatus = $listenerQueryStatus
    listeners = @($listeners)
    autostart = $autostart
    freeBytes = $freeBytes
    activeApplicationJobs = 'NOT_INSPECTED'
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    Get-PhotoLocalProductionInventory -ProductionRoot $ProductionRoot -Port $Port | ConvertTo-Json -Depth 8
  } catch {
    [pscustomobject]@{ status = 'INVENTORY_FAILED'; readiness = 'NOT_ASSESSED' } | ConvertTo-Json
    exit 1
  }
}
