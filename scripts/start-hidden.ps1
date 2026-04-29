$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $root "photo-local.pid"
$logFile = Join-Path $logDir "app.log"
$errFile = Join-Path $logDir "err.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path (Join-Path $root ".env"))) {
  Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
}

$port = 4873
$envLines = Get-Content (Join-Path $root ".env")
foreach ($line in $envLines) {
  if ($line -match "^PHOTO_LOCAL_PORT=(.+)$") {
    $port = [int]$Matches[1]
  }
}

$appUrl = "http://127.0.0.1:$port"
$healthUrl = "$appUrl/health"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1 | Out-Null
  Start-Process $appUrl
  exit 0
} catch {
}

$npm = "npm.cmd"
$process = Start-Process -FilePath $npm `
  -ArgumentList "run start" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile `
  -PassThru

Set-Content -Path $pidFile -Value $process.Id

for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1 | Out-Null
    Start-Process $appUrl
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Add-Content -Path $logFile -Value "Photo Local did not become healthy on $healthUrl"
Start-Process $appUrl
