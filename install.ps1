$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "[1/5] Sprawdzanie Node.js..."
node --version | Out-Host
npm --version | Out-Host

Write-Host "[2/6] Sprawdzanie Python..."
python --version | Out-Host
python -m pip install --upgrade pip
python -m pip install -r ".\pobierzchat\requirements.txt"

Write-Host "[3/6] Przygotowanie .env..."
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

Write-Host "[4/6] Instalacja paczek Node..."
npm install --workspaces

Write-Host "[5/6] Sprawdzanie Ollama..."
try {
  ollama --version | Out-Host
  ollama pull qwen2.5vl:3b
} catch {
  Write-Host "Nie znaleziono Ollama albo nie jest dostepna w PATH."
  Write-Host "Zainstaluj Ollama z https://ollama.com/download i uruchom ponownie ten skrypt."
  throw
}

Write-Host "[6/6] Build aplikacji..."
npm run build

Write-Host ""
Write-Host "Gotowe. Uruchom aplikacje:"
Write-Host ".\start.bat"
