param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Share,
  [Parameter(Mandatory = $true)][string]$Subdirectory,
  [Parameter(Mandatory = $true)][string]$UserName,
  [string]$Image = 'photolocal:staging'
)

$ErrorActionPreference = 'Stop'
$probeProcess = $null
$probePayload = $null
$probeCredential = $null
$probeNetworkCredential = $null
$probeInputBytes = $null
$probeId = 'photolocal-smb-probe-' + [guid]::NewGuid().ToString('N')
try {
  $nodePath = @(Get-Command node.exe -CommandType Application)[0].Source
  $helperPath = Join-Path $PSScriptRoot 'test-smb-access.mjs'
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'HELPER_MISSING' }
  Write-Host 'Test SMB: jedno logowanie, tylko odczyt. Wpisz haslo w oknie lokalnym.'
  $probeCredential = Get-Credential -UserName $UserName -Message 'Haslo do udzialu SMB (nie do Romka ani Google)'
  if ($null -eq $probeCredential) { throw 'CANCELLED' }
  $probeNetworkCredential = $probeCredential.GetNetworkCredential()
  $probePayload = @{
    probeId = $probeId
    server = $Server; share = $Share; subdirectory = $Subdirectory; image = $Image
    username = $probeNetworkCredential.UserName; domain = $probeNetworkCredential.Domain
    password = $probeNetworkCredential.Password
  } | ConvertTo-Json -Compress

  $probeStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $probeStartInfo.FileName = $nodePath
  $probeStartInfo.Arguments = '"' + $helperPath + '"'
  $probeStartInfo.UseShellExecute = $false
  $probeStartInfo.CreateNoWindow = $true
  $probeStartInfo.RedirectStandardInput = $true
  $probeStartInfo.RedirectStandardOutput = $true
  $probeStartInfo.RedirectStandardError = $true
  $probeProcess = New-Object System.Diagnostics.Process
  $probeProcess.StartInfo = $probeStartInfo
  [void]$probeProcess.Start()
  $probeOutput = $probeProcess.StandardOutput.ReadToEndAsync()
  $probeErrors = $probeProcess.StandardError.ReadToEndAsync()
  # Windows PowerShell 5 has no ProcessStartInfo.StandardInputEncoding property.
  $probeInputBytes = [System.Text.Encoding]::UTF8.GetBytes($probePayload)
  $probeProcess.StandardInput.BaseStream.Write($probeInputBytes, 0, $probeInputBytes.Length)
  $probeProcess.StandardInput.BaseStream.Flush()
  $probeProcess.StandardInput.BaseStream.Close()
  [Array]::Clear($probeInputBytes, 0, $probeInputBytes.Length)
  $probeInputBytes = $null
  $probePayload = $null
  $probeNetworkCredential = $null
  $probeCredential = $null
  if (-not $probeProcess.WaitForExit(200000)) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $probeProcess.Id /T /F *> $null
    [pscustomobject]@{ Status = 'TIMEOUT'; Cleanup = 'REQUIRED'; ProbeId = $probeId } | Format-List
    return
  }

  # Never print raw child output: Docker mount errors may contain credentials.
  $probeReport = $probeOutput.Result | ConvertFrom-Json
  $allowedStatuses = @('DIRECTORY_READ_OK', 'ACCESS_DENIED', 'UNREACHABLE', 'UNSUPPORTED', 'TIMEOUT', 'IMAGE_MISSING', 'DIRECTORY_MISSING', 'OTHER_ERROR', 'CREDENTIAL_FORMAT_UNSUPPORTED', 'INVALID_INPUT')
  if ($probeReport.status -notin $allowedStatuses -or $probeReport.cleanup -notin @('CLEAN', 'REQUIRED', 'NOT_NEEDED')) { throw 'INVALID_REPORT' }
  if ($probeReport.probeId -ne '' -and $probeReport.probeId -notmatch '^photolocal-smb-probe-[a-f0-9]+$') { throw 'INVALID_REPORT' }
  [pscustomobject]@{
    Status = $probeReport.status; Cleanup = $probeReport.cleanup; ProbeId = $probeReport.probeId
  } | Format-List
} catch {
  Write-Host 'PROBE_LAUNCH_FAILED - zglos ten kod oraz ponizszy identyfikator, bez surowych logow Dockera.'
  Write-Host $probeId
} finally {
  if ($null -ne $probeInputBytes) { [Array]::Clear($probeInputBytes, 0, $probeInputBytes.Length) }
  $probeInputBytes = $null
  $probePayload = $null
  $probeNetworkCredential = $null
  $probeCredential = $null
  if ($null -ne $probeProcess) { $probeProcess.Dispose() }
}
