$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$taskName = "PhotoLocal Autostart"
$runner = Join-Path $PSScriptRoot "start-autostart.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path $runner)) {
  throw "Brak pliku startowego: $runner"
}

$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Uruchamia Photo Local po zalogowaniu uzytkownika Windows." `
  -Force | Out-Null

Write-Host "Autostart zostal dodany."
Write-Host "Zadanie: $taskName"
Write-Host "Uzytkownik: $currentUser"
Write-Host "Katalog aplikacji: $root"
Write-Host ""
Write-Host "Uwaga: to startuje po zalogowaniu tego uzytkownika Windows."
Write-Host "Jesli ma dzialac jeszcze przed logowaniem, trzeba uruchomic jako usluge Windows i unikac mapowanych dyskow typu Z:."
