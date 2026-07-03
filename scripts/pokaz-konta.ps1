$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
Set-Location $appRoot

& npm.cmd run auth:list-users
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
