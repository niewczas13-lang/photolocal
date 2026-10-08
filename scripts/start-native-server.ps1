param([switch]$CheckOnly, [string]$Root = (Split-Path -Parent $PSScriptRoot))

. (Join-Path $PSScriptRoot 'stop-native-server.ps1')

function Start-PhotoLocalNativeServer {
  param([string]$Root)
  Assert-PhotoLocalNativePortFree
  $backendPath = [IO.Path]::GetFullPath((Join-Path $Root 'backend'))
  $serverPath = Join-Path $backendPath 'dist\server.js'
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'Brak zbudowanego backend/dist/server.js.' }
  $logsPath = Join-Path $Root 'logs'
  if (-not (Test-Path -LiteralPath $logsPath)) { $null = New-Item -ItemType Directory -Path $logsPath }
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  $null = Start-Process -FilePath $node -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $backendPath `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsPath 'server.out.log') `
    -RedirectStandardError (Join-Path $logsPath 'server.err.log') -PassThru -ErrorAction Stop
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    if ($CheckOnly) { Assert-PhotoLocalNativePortFree }
    else { Start-PhotoLocalNativeServer -Root $Root }
    exit 0
  } catch {
    Write-Host ('[BLAD] ' + $_.Exception.Message)
    exit 1
  }
}
