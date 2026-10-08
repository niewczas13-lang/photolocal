param([string]$Root = (Split-Path -Parent $PSScriptRoot))

function Get-PhotoLocalNativeListenerIds {
  try {
    @(Get-NetTCPConnection -State Listen -LocalPort 4873 -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }
    throw 'Nie mozna bezpiecznie ustalic wlasciciela portu 4873.'
  }
}

function Assert-PhotoLocalNativePortFree {
  if (@(Get-PhotoLocalNativeListenerIds).Count -gt 0) {
    throw 'Port 4873 jest zajety. Start natywny przerwany; dzialajaca aplikacja pozostaje bez zmian.'
  }
}

function Stop-PhotoLocalNativeServer {
  param([string]$Root)
  $serverPath = [IO.Path]::GetFullPath((Join-Path $Root 'backend\dist\server.js'))
  $verifiedProcesses = @()
  # Validate ALL owners before stopping any process. A Docker listener must never be stopped here.
  foreach ($processId in @(Get-PhotoLocalNativeListenerIds)) {
    if ([long]$processId -le 0) { throw 'Nieznany wlasciciel portu 4873. Nic nie zostalo zatrzymane.' }
    $native = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    if (-not $native -or $native.Name -ine 'node.exe' -or -not $native.ExecutablePath -or
        [IO.Path]::GetFileName($native.ExecutablePath) -ine 'node.exe' -or -not $native.CreationDate) {
      throw 'Port 4873 nie nalezy do potwierdzonego Node PhotoLocal. Nic nie zostalo zatrzymane.'
    }
    $executable = [regex]::Escape([string]$native.ExecutablePath)
    $server = [regex]::Escape($serverPath)
    $pattern = '^(?:"' + $executable + '"|' + $executable + ')\s+(?:"' + $server + '"|' + $server + ')\s*$'
    if (-not $native.CommandLine -or $native.CommandLine -notmatch $pattern) {
      throw 'Nie mozna potwierdzic sciezki serwera PhotoLocal. Docker i inne procesy pozostaja bez zmian.'
    }
    $process = Get-Process -Id ([int]$processId) -ErrorAction Stop
    if ([math]::Abs(($process.StartTime.ToUniversalTime() - ([datetime]$native.CreationDate).ToUniversalTime()).TotalSeconds) -gt 1) {
      throw 'Proces zmienil sie podczas sprawdzania. Zatrzymanie przerwane.'
    }
    $verifiedProcesses += $process
  }
  foreach ($process in $verifiedProcesses) {
    Stop-Process -InputObject $process -ErrorAction Stop
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    Stop-PhotoLocalNativeServer -Root $Root
    Write-Host 'Natywny serwer PhotoLocal zatrzymany albo port jest wolny.'
    exit 0
  } catch {
    Write-Host ('[BLAD] ' + $_.Exception.Message)
    exit 1
  }
}
