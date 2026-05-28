param(
  [string] $Login = '',
  [string] $Password = '',
  [string] $RepeatPassword = ''
)

$ErrorActionPreference = 'Stop'

function Read-PlainPassword {
  param([string] $Prompt)

  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

$appRoot = Split-Path -Parent $PSScriptRoot
Set-Location $appRoot

if ([string]::IsNullOrWhiteSpace($Login)) {
  $Login = Read-Host 'Nadaj login'
}

if ([string]::IsNullOrWhiteSpace($Login)) {
  throw 'Login nie moze byc pusty.'
}

if ($Password -eq '') {
  $Password = Read-PlainPassword 'Nadaj haslo'
}

if ($RepeatPassword -eq '') {
  $RepeatPassword = Read-PlainPassword 'Powtorz haslo'
}

if ($Password -eq '') {
  throw 'Haslo nie moze byc puste.'
}

if ($Password -ne $RepeatPassword) {
  throw 'Hasla nie sa takie same. Konto nie zostalo dodane.'
}

& npm.cmd run auth:add-user -- $Login $Password
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
