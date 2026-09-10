[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-[0-9]+(?:-[0-9]+)+$')]
    [string]$ExpectedSid
)

function Initialize-PhotoLocalLockNativeApi {
    if (-not ('PhotoLocal.AutologonNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace PhotoLocal {
    public static class AutologonNative {
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool LockWorkStation();

        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();
    }
}
'@ -ErrorAction Stop
    }
}

function Get-PhotoLocalLockIdentity {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $process = [System.Diagnostics.Process]::GetCurrentProcess()
    try {
        [pscustomobject]@{ Sid = $identity.User.Value; SessionId = $process.SessionId }
    } finally {
        $identity.Dispose()
        $process.Dispose()
    }
}

function Get-PhotoLocalActiveConsoleSessionId {
    Initialize-PhotoLocalLockNativeApi
    [PhotoLocal.AutologonNative]::WTSGetActiveConsoleSessionId()
}

function Request-PhotoLocalWorkstationLock {
    Initialize-PhotoLocalLockNativeApi
    [PhotoLocal.AutologonNative]::LockWorkStation()
}

function Wait-PhotoLocalLockRetry {
    Start-Sleep -Seconds 2
}

function Invoke-PhotoLocalConsoleLock {
    param([Parameter(Mandatory = $true)][string]$ExpectedSid)

    $result = [ordered]@{ status = 'LOCK_CHECK_FAILED'; attempts = 0; exitCode = 6 }
    try {
        $identity = Get-PhotoLocalLockIdentity
        if ($identity.Sid -cne $ExpectedSid) {
            $result.status = 'WRONG_USER'
            $result.exitCode = 2
            return [pscustomobject]$result
        }
        if ($identity.SessionId -le 0) {
            $result.status = 'NON_INTERACTIVE_SESSION'
            $result.exitCode = 3
            return [pscustomobject]$result
        }

        for ($attempt = 1; $attempt -le 15; $attempt++) {
            $result.attempts = $attempt
            $consoleSessionId = Get-PhotoLocalActiveConsoleSessionId
            if ($consoleSessionId -eq [uint32]::MaxValue) {
                $result.status = 'CONSOLE_NOT_READY'
                $result.exitCode = 4
            } elseif ($identity.SessionId -ne $consoleSessionId) {
                # A remote session must remain usable after future RDP logons.
                $result.status = 'NON_CONSOLE_SESSION_SKIPPED'
                $result.exitCode = 0
                return [pscustomobject]$result
            } else {
                $accepted = $false
                try { $accepted = Request-PhotoLocalWorkstationLock } catch { }
                if ($accepted) {
                    # Win32 accepts the request asynchronously; this is not proof of a locked screen.
                    $result.status = 'LOCK_REQUEST_ACCEPTED'
                    $result.exitCode = 0
                    return [pscustomobject]$result
                }
                $result.status = 'LOCK_REQUEST_FAILED'
                $result.exitCode = 5
            }
            if ($attempt -lt 15) { Wait-PhotoLocalLockRetry }
        }
    } catch {
        $result.status = 'LOCK_CHECK_FAILED'
        $result.exitCode = 6
    }
    return [pscustomobject]$result
}

# Dot-sourcing loads the functions without touching the desktop or native APIs.
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-PhotoLocalConsoleLock -ExpectedSid $ExpectedSid
    $result | Select-Object status, attempts | ConvertTo-Json -Compress
    exit $result.exitCode
}
