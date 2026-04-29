$ErrorActionPreference = "SilentlyContinue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $root "photo-local.pid"

if (Test-Path $pidFile) {
  $pidValue = Get-Content $pidFile | Select-Object -First 1
  if ($pidValue) {
    Stop-Process -Id ([int]$pidValue) -Force
  }
  Remove-Item $pidFile -Force
}

# Fallback: kill anything on the port
$port = 4873
if (Test-Path (Join-Path $root ".env")) {
  $envLines = Get-Content (Join-Path $root ".env")
  foreach ($line in $envLines) {
    if ($line -match "^PHOTO_LOCAL_PORT=(.+)$") {
      $port = [int]$Matches[1]
    }
  }
}

$netstat = netstat -ano | findstr ":$port" | findstr "LISTENING"
if ($netstat) {
  $pidOnPort = $netstat.Trim().Split(' ') | Select-Object -Last 1
  if ($pidOnPort -match "^\d+$") {
    Stop-Process -Id ([int]$pidOnPort) -Force
  }
}
