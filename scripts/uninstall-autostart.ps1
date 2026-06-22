$ErrorActionPreference = "Stop"

$taskName = "PhotoLocal Autostart"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (-not $task) {
  Write-Host "Autostart nie byl zainstalowany."
  exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Autostart zostal usuniety."
