$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $root "backend"
$serverFile = Join-Path $backendDir "dist\server.js"
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $root "photo-local.pid"
$outFile = Join-Path $logDir "autostart.out.log"
$errFile = Join-Path $logDir "autostart.err.log"
$logFile = Join-Path $logDir "autostart.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-AutostartLog([string]$message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$timestamp] $message"
}

if (-not (Test-Path (Join-Path $root ".env")) -and (Test-Path (Join-Path $root ".env.example"))) {
  Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
  Write-AutostartLog "Utworzono .env z .env.example"
}

$port = 4873
$envPath = Join-Path $root ".env"
if (Test-Path $envPath) {
  foreach ($line in Get-Content $envPath) {
    if ($line -match "^PHOTO_LOCAL_PORT=(.+)$") {
      $port = [int]$Matches[1]
    }
  }
}

$healthUrl = "http://127.0.0.1:$port/health"

try {
  Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1 | Out-Null
  Write-AutostartLog "Serwer juz dziala na porcie $port"
  exit 0
} catch {
}

if (-not (Test-Path $serverFile)) {
  Write-AutostartLog "Brak backend\dist\server.js - uruchamiam build"
  $build = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run build" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "autostart-build.out.log") `
    -RedirectStandardError (Join-Path $logDir "autostart-build.err.log") `
    -Wait `
    -PassThru

  if ($build.ExitCode -ne 0) {
    Write-AutostartLog "Build zakonczyl sie bledem: $($build.ExitCode)"
    exit $build.ExitCode
  }
}

Write-AutostartLog "Uruchamiam Photo Local na porcie $port"
$process = Start-Process -FilePath "node.exe" `
  -ArgumentList "dist/server.js" `
  -WorkingDirectory $backendDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile `
  -PassThru

Set-Content -Path $pidFile -Value $process.Id

for ($i = 0; $i -lt 120; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1 | Out-Null
    Write-AutostartLog "Photo Local wystartowal poprawnie. PID: $($process.Id)"
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Write-AutostartLog "Nie udalo sie potwierdzic healthcheck: $healthUrl"
exit 1
