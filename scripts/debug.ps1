$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host ""
Write-Host "=== Photo Local DEBUG ==="
Write-Host "Folder: $root"
Write-Host ""

if (-not (Test-Path ".env")) {
  Write-Host "Brak .env - kopiuje .env.example"
  Copy-Item ".env.example" ".env"
}

$port = 4873
foreach ($line in Get-Content ".env") {
  if ($line -match "^PHOTO_LOCAL_PORT=(.+)$") {
    $port = [int]$Matches[1]
  }
}

$appUrl = "http://127.0.0.1:$port"
$healthUrl = "$appUrl/health"

Write-Host "Port: $port"
Write-Host "URL:  $appUrl"
Write-Host ""

if (-not (Get-Command "node.exe" -ErrorAction SilentlyContinue)) {
  Write-Host "BLAD: Nie widze node.exe w PATH."
  Write-Host "Zainstaluj Node.js albo odpal z terminala, w ktorym npm dziala."
  return
}

if (-not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
  Write-Host "BLAD: Nie widze npm.cmd w PATH."
  Write-Host "Zainstaluj Node.js albo odpal z terminala, w ktorym npm dziala."
  return
}

$listener = netstat -ano | Select-String -Pattern ":$port\s+.*LISTENING" | Select-Object -First 1
if ($listener) {
  $pidOnPort = ($listener.Line.Trim() -split "\s+")[-1]
  Write-Host "Port $port jest juz zajety przez PID $pidOnPort."

  $isHealthy = $false
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $isHealthy = $true
    }
  } catch {
    $isHealthy = $false
  }

  if ($isHealthy) {
    Write-Host "Aplikacja juz dziala i odpowiada na /health."
    Write-Host "Otwieram: $appUrl"
    try {
      Start-Process $appUrl
    } catch {
      Write-Host "Nie udalo sie automatycznie otworzyc przegladarki. Wejdz recznie na $appUrl"
    }
    Write-Host ""
    Write-Host "Jesli chcesz widziec logi nowego uruchomienia, najpierw zamknij dzialajacy proces:"
    Write-Host "  stop.bat"
    return
  } else {
    Write-Host "Port jest zajety, ale aplikacja nie odpowiada na /health."
    Write-Host "To zwykle znaczy, ze zostal wiszacy proces."
    Write-Host ""
    Write-Host "Najprosciej:"
    Write-Host "  stop.bat"
    Write-Host "  debug.bat"
    Write-Host ""
    Write-Host "Awaryjnie tylko dla tego PID:"
    Write-Host "  taskkill /PID $pidOnPort /F"
    return
  }
}

if (-not (Test-Path "backend\dist\server.js")) {
  Write-Host "Brak backend\dist\server.js - robie build."
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "BUILD PADL. Blad jest powyzej."
    return
  }
}

Write-Host "Startuje backend w tym oknie. Logi beda ponizej."
Write-Host "Zatrzymanie: Ctrl+C"
Write-Host ""

& npm.cmd run start
$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "Proces zakonczyl sie kodem: $exitCode"
Write-Host "To okno zostaje otwarte, bo to debug."
