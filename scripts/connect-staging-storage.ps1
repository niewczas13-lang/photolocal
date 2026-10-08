param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Share,
  [Parameter(Mandatory = $true)][string]$Subdirectory,
  [Parameter(Mandatory = $true)][string]$UserName,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$Image = 'photolocal:staging'
)

$ErrorActionPreference = 'Stop'
$storageProcess = $null
$storagePayload = $null
$storageCredential = $null
$storageNetworkCredential = $null
$storageInputBytes = $null
$storageExitCode = 1
$storageProbeId = 'photolocal-smb-probe-' + [guid]::NewGuid().ToString('N')
$storageVolumeName = 'photolocal-staging-nas-' + [guid]::NewGuid().ToString('N')
try {
  $storageOutputDirectory = (Get-Item -LiteralPath $OutputDirectory).FullName
  if (-not (Test-Path -LiteralPath $storageOutputDirectory -PathType Container)) { throw 'INVALID_OUTPUT_DIRECTORY' }
  $storageManifestPath = Join-Path $storageOutputDirectory 'storage.json'
  if (Test-Path -LiteralPath $storageManifestPath) {
    Write-Host 'STORAGE_MANIFEST_EXISTS - konfiguracja juz istnieje; nie zmieniono udzialu.'
    exit 1
  }
  $storageNodePath = @(Get-Command node.exe -CommandType Application)[0].Source
  $storageHelperPath = Join-Path $PSScriptRoot 'connect-staging-storage.mjs'
  if (-not (Test-Path -LiteralPath $storageHelperPath -PathType Leaf)) { throw 'HELPER_MISSING' }
  Write-Host 'Staging: podlaczenie udzialu tylko do odczytu. Haslo pozostanie w konfiguracji wolumenu Dockera. Wpisz je lokalnie.'
  $storageCredential = Get-Credential -UserName $UserName -Message 'Haslo do udzialu SMB (nie do Romka ani Google)'
  if ($null -eq $storageCredential) { throw 'CANCELLED' }
  $storageNetworkCredential = $storageCredential.GetNetworkCredential()
  $storagePayload = @{
    probeId = $storageProbeId; volumeName = $storageVolumeName
    outputDirectory = $storageOutputDirectory
    server = $Server; share = $Share; subdirectory = $Subdirectory; image = $Image
    username = $storageNetworkCredential.UserName; domain = $storageNetworkCredential.Domain
    password = $storageNetworkCredential.Password
  } | ConvertTo-Json -Compress
  $storageStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $storageStartInfo.FileName = $storageNodePath
  $storageStartInfo.Arguments = '"' + $storageHelperPath + '"'
  $storageStartInfo.UseShellExecute = $false
  $storageStartInfo.CreateNoWindow = $true
  $storageStartInfo.RedirectStandardInput = $true
  $storageStartInfo.RedirectStandardOutput = $true
  # Node writes UTF-8 JSON regardless of the console's active OEM code page.
  $storageStartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $storageStartInfo.RedirectStandardError = $true
  $storageProcess = New-Object System.Diagnostics.Process
  $storageProcess.StartInfo = $storageStartInfo
  [void]$storageProcess.Start()
  $storageOutput = $storageProcess.StandardOutput.ReadToEndAsync()
  $storageErrors = $storageProcess.StandardError.ReadToEndAsync()
  # Use BaseStream for UTF-8 input: Windows PowerShell 5 has no StandardInputEncoding.
  $storageInputBytes = [System.Text.Encoding]::UTF8.GetBytes($storagePayload)
  $storageProcess.StandardInput.BaseStream.Write($storageInputBytes, 0, $storageInputBytes.Length)
  $storageProcess.StandardInput.BaseStream.Flush()
  $storageProcess.StandardInput.BaseStream.Close()
  [Array]::Clear($storageInputBytes, 0, $storageInputBytes.Length)
  $storageInputBytes = $null
  $storagePayload = $null
  $storageNetworkCredential = $null
  $storageCredential = $null
  if (-not $storageProcess.WaitForExit(240000)) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $storageProcess.Id /T /F *> $null
    [pscustomobject]@{ Status = 'TIMEOUT'; Cleanup = 'REQUIRED'; ProbeId = $storageProbeId; VolumeName = $storageVolumeName } | Format-List
    exit 1
  }
  # Raw child output and stderr may include passwords. Print only closed validated fields.
  $storageReport = $storageOutput.Result | ConvertFrom-Json
  $storageAllowedStatuses = @('STAGING_STORAGE_READY', 'STORAGE_MANIFEST_EXISTS', 'STORAGE_MANIFEST_FAILED', 'STORAGE_RESOURCE_EXISTS', 'STORAGE_CLEANUP_FAILED', 'MOUNT_ACCESS_DENIED', 'DIRECTORY_ACCESS_DENIED', 'DIRECTORY_MISSING', 'IMAGE_MISSING', 'UNREACHABLE', 'UNSUPPORTED', 'TIMEOUT', 'OTHER_ERROR', 'CREDENTIAL_FORMAT_UNSUPPORTED', 'INVALID_INPUT')
  if ($storageReport.status -notin $storageAllowedStatuses -or $storageReport.cleanup -notin @('CLEAN', 'REQUIRED', 'NOT_NEEDED')) { throw 'INVALID_REPORT' }
  if ($storageReport.probeId -ne '' -and $storageReport.probeId -ne $storageProbeId) { throw 'INVALID_REPORT' }
  if ($storageReport.volumeName -ne '' -and $storageReport.volumeName -ne $storageVolumeName) { throw 'INVALID_REPORT' }
  if ($storageReport.manifestPath -ne '' -and $storageReport.manifestPath -ne $storageManifestPath) { throw 'INVALID_REPORT' }
  [pscustomobject]@{
    Status = $storageReport.status; Cleanup = $storageReport.cleanup
    ProbeId = $storageReport.probeId; VolumeName = $storageReport.volumeName; ManifestPath = $storageReport.manifestPath
  } | Format-List
  if ($storageProcess.ExitCode -eq 0 -and $storageReport.status -eq 'STAGING_STORAGE_READY' -and $storageReport.cleanup -eq 'CLEAN') { $storageExitCode = 0 }
} catch {
  Write-Host 'STORAGE_LAUNCH_FAILED - zglos ten kod i identyfikatory ponizej, bez surowych logow Dockera.'
  [pscustomobject]@{ ProbeId = $storageProbeId; VolumeName = $storageVolumeName } | Format-List
} finally {
  if ($null -ne $storageInputBytes) { [Array]::Clear($storageInputBytes, 0, $storageInputBytes.Length) }
  $storageInputBytes = $null
  $storagePayload = $null
  $storageNetworkCredential = $null
  $storageCredential = $null
  if ($null -ne $storageProcess) { $storageProcess.Dispose() }
}
exit $storageExitCode
