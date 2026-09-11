[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-[0-9]+(?:-[0-9]+)+$')]
    [string]$ExpectedSid
)

$script:PhotoLocalLockTrace = $null

function Write-PhotoLocalLockTrace {
    param([string]$Event, [hashtable]$Details = @{})
    try {
        if (-not $script:PhotoLocalLockTrace) { return }
        $trace = $script:PhotoLocalLockTrace
        $entry = [ordered]@{
            utc = [DateTime]::UtcNow.ToString('o')
            elapsedMs = $trace.Clock.ElapsedMilliseconds
            event = $Event
        }
        foreach ($key in $Details.Keys) { $entry[$key] = $Details[$key] }
        $line = ConvertTo-Json -InputObject $entry -Compress
        [IO.File]::AppendAllText($trace.Path, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch { } # Diagnostics must never change whether the console gets locked.
}

function Initialize-PhotoLocalLockTrace {
    $script:PhotoLocalLockTrace = $null
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        if ($env:LOCALAPPDATA -notmatch '^[A-Za-z]:\\') { return }
        $base = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
        if (-not [IO.Directory]::Exists($base)) { return }
        # Reject redirected ancestors before creating or pruning local trace files.
        $ancestor = New-Object IO.DirectoryInfo($base)
        while ($ancestor) {
            if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
            $ancestor = $ancestor.Parent
        }
        $directory = $base
        foreach ($part in @('PhotoLocal', 'console-lock')) {
            $directory = [IO.Path]::Combine($directory, $part)
            $item = [IO.Directory]::CreateDirectory($directory)
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
        }
        $name = 'console-lock-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N') + '.jsonl'
        $tracePath = [IO.Path]::Combine($directory, $name)
        $file = [IO.File]::Open($tracePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $file.Dispose()
        $script:PhotoLocalLockTrace = @{ Path = $tracePath; Clock = $clock }
        Write-PhotoLocalLockTrace -Event 'START'
        try {
            # Only regular files with our exact generated name are eligible, never directories or links.
            $files = @((New-Object IO.DirectoryInfo($directory)).GetFiles('console-lock-*.jsonl') | Where-Object {
                $_.Name -cmatch '^console-lock-\d{8}T\d{9}Z-[0-9a-f]{32}\.jsonl$' -and
                $_.FullName -ne $tracePath -and
                $_.DirectoryName -eq $directory -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
            } | Sort-Object LastWriteTimeUtc, Name -Descending)
            # Keep this run and the 19 most recently written prior runs, even after a clock change.
            foreach ($old in @($files | Select-Object -Skip 19)) {
                $old.Refresh()
                if ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) { break }
                if ($old.DirectoryName -eq $directory -and
                    -not ($old.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    [IO.File]::Delete($old.FullName)
                }
            }
        } catch { }
    } catch { $script:PhotoLocalLockTrace = $null }
}

function Initialize-PhotoLocalLockNativeApi {
    if (-not ('PhotoLocal.AutologonNative' -as [type])) {
        Write-PhotoLocalLockTrace -Event 'NATIVE_INIT_START'
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
        Write-PhotoLocalLockTrace -Event 'NATIVE_INIT_DONE'
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
        Write-PhotoLocalLockTrace -Event 'IDENTITY_CHECKED' -Details @{ sessionId = $identity.SessionId }
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
            Write-PhotoLocalLockTrace -Event 'CONSOLE_CHECK' -Details @{ attempt = $attempt; consoleSessionId = $consoleSessionId }
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
                Write-PhotoLocalLockTrace -Event 'LOCK_REQUEST_START' -Details @{ attempt = $attempt }
                try { $accepted = Request-PhotoLocalWorkstationLock } catch { }
                Write-PhotoLocalLockTrace -Event 'LOCK_REQUEST_DONE' -Details @{ attempt = $attempt; accepted = [bool]$accepted }
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

function Invoke-PhotoLocalConsoleLockRun {
    param([Parameter(Mandatory = $true)][string]$ExpectedSid)

    Initialize-PhotoLocalLockTrace
    try {
        $result = Invoke-PhotoLocalConsoleLock -ExpectedSid $ExpectedSid
        Write-PhotoLocalLockTrace -Event 'FINAL' -Details @{ status = $result.status; exitCode = $result.exitCode }
        return $result
    } finally { $script:PhotoLocalLockTrace = $null }
}

# Dot-sourcing loads the functions without touching the desktop or native APIs.
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-PhotoLocalConsoleLockRun -ExpectedSid $ExpectedSid
    $result | Select-Object status, attempts | ConvertTo-Json -Compress
    exit $result.exitCode
}
