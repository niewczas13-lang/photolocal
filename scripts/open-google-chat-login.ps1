param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Read-EnvFileValue {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  foreach ($line in Get-Content $Path) {
    if ($line -match "^\s*#") {
      continue
    }
    if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }

  return $null
}

function Resolve-ConfiguredPath {
  param(
    [string]$Root,
    [string]$Value
  )

  if (-not $Value) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($Value)) {
    return $Value
  }

  return [System.IO.Path]::GetFullPath((Join-Path $Root $Value))
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$envPath = Join-Path $root ".env"
$url = "https://chat.google.com/app/browse?q=&smembership=not_joined&sorganization=all"

$configuredProfile = Read-EnvFileValue -Path $envPath -Name "GOOGLE_CHAT_INVITE_PROFILE_DIR"
$configuredDb = Read-EnvFileValue -Path $envPath -Name "PHOTO_LOCAL_DB"
$configuredPort = Read-EnvFileValue -Path $envPath -Name "GOOGLE_CHAT_INVITE_DEBUG_PORT"
$configuredBrowser = Read-EnvFileValue -Path $envPath -Name "GOOGLE_CHAT_BROWSER_PATH"
$configuredChrome = Read-EnvFileValue -Path $envPath -Name "GOOGLE_CHROME_PATH"
$configuredEdge = Read-EnvFileValue -Path $envPath -Name "GOOGLE_EDGE_PATH"

if ($configuredProfile) {
  $profileDir = Resolve-ConfiguredPath -Root $root -Value $configuredProfile
} elseif ($configuredDb) {
  $dbPath = Resolve-ConfiguredPath -Root $root -Value $configuredDb
  $profileDir = Join-Path (Split-Path -Parent $dbPath) "google-chat-browser-profile"
} else {
  $profileDir = Join-Path $root "backend\data\google-chat-browser-profile"
}

$debugPort = 9222
if ($configuredPort -and [int]::TryParse($configuredPort, [ref]$debugPort) -and $debugPort -gt 0) {
  $debugPort = [int]$debugPort
} else {
  $debugPort = 9222
}

$browserCandidates = @(
  (Resolve-ConfiguredPath -Root $root -Value $configuredBrowser),
  (Resolve-ConfiguredPath -Root $root -Value $configuredChrome),
  (Resolve-ConfiguredPath -Root $root -Value $configuredEdge),
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$browserPath = $browserCandidates | Select-Object -First 1

Write-Host "PhotoLocal - logowanie Google Chat" -ForegroundColor Cyan
Write-Host "Root:       $root"
Write-Host "Profil:     $profileDir"
Write-Host "Port CDP:   $debugPort"

if (-not $browserPath) {
  Write-Host ""
  Write-Host "Nie znaleziono Google Chrome ani Microsoft Edge." -ForegroundColor Red
  Write-Host "Zainstaluj Chrome/Edge albo ustaw GOOGLE_CHAT_BROWSER_PATH w pliku .env."
  exit 1
}

Write-Host "Przegladarka: $browserPath"

$matchingProcesses = Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -in @("chrome.exe", "msedge.exe")) -and
    (
      ($_.CommandLine -like "*$profileDir*") -or
      ($_.CommandLine -like "*remote-debugging-port=$debugPort*")
    )
  }

if ($matchingProcesses.Count -gt 0) {
  Write-Host ""
  Write-Host "Zamykam stare procesy przegladarki PhotoLocal..." -ForegroundColor Yellow
  foreach ($process in $matchingProcesses) {
    Write-Host "  PID $($process.ProcessId) $($process.Name)"
    if (-not $DryRun) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$arguments = @(
  "--remote-debugging-port=$debugPort",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--new-window",
  $url
)

Write-Host ""
Write-Host "Uruchamiam okno logowania..." -ForegroundColor Cyan
Write-Host "$browserPath $($arguments -join ' ')"

if (-not $DryRun) {
  $process = Start-Process -FilePath $browserPath -ArgumentList $arguments -WindowStyle Normal -PassThru
  Start-Sleep -Seconds 4

  $cdpUrl = "http://127.0.0.1:$debugPort/json/version"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $cdpUrl -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      Write-Host ""
      Write-Host "OK: przegladarka dziala i port CDP odpowiada." -ForegroundColor Green
      Write-Host "Zaloguj konto Google w otwartym oknie, potem w PhotoLocal kliknij 'Zaladuj zaproszenia'."
      exit 0
    }
  } catch {
    Write-Host ""
    Write-Host "Przegladarka zostala uruchomiona, ale port CDP jeszcze nie odpowiedzial." -ForegroundColor Yellow
    Write-Host "Jesli okno jest widoczne, zaloguj konto Google i potem kliknij 'Zaladuj zaproszenia'."
    Write-Host "Szczegoly: $($_.Exception.Message)"
  }

  if ($process.HasExited) {
    Write-Host ""
    Write-Host "Proces przegladarki od razu sie zamknal. Sprobuj zmienic GOOGLE_CHAT_INVITE_DEBUG_PORT w .env, np. na 9333." -ForegroundColor Red
    exit 1
  }
}
