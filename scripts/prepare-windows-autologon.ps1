param()

# Password entry belongs exclusively to Microsoft's interactive Autologon GUI.
$ErrorActionPreference = 'Stop'

function ConvertTo-PhotoLocalAccountSid {
    param([string]$Account)
    if ($Account -match '^S-1-') { return $Account }
    return (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-PhotoLocalAutologonIdentity {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    $owners = @()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='com.docker.backend.exe'")) {
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw 'DOCKER_OWNER_UNAVAILABLE' }
        $owners += $owner.Sid
    }
    $runCommand = Get-ItemPropertyValue -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'Docker Desktop' -ErrorAction SilentlyContinue
    return @{
        IsAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
        Sid = $identity.User.Value; Account = $identity.Name
        Owners = @($owners | Select-Object -Unique); RunCommand = $runCommand
    }
}

function Assert-PhotoLocalAutologonIdentity {
    param($Identity)
    if (-not $Identity.IsAdmin) { throw 'ADMIN_REQUIRED' }
    if ($Identity.Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'WINDOWS_ACCOUNT_UNSUPPORTED' }
    if (@($Identity.Owners).Count -eq 0) { throw 'DOCKER_NOT_RUNNING' }
    if (@($Identity.Owners).Count -ne 1 -or $Identity.Owners[0] -ne $Identity.Sid) { throw 'WRONG_WINDOWS_ACCOUNT' }
    if ([string]$Identity.RunCommand -notmatch 'Docker Desktop\.exe') { throw 'DOCKER_SIGN_IN_ENTRY_MISSING' }
}

function New-PhotoLocalConsoleLockSpec {
    param([string]$Root, [string]$Sid)
    $runner = Join-Path $Root 'scripts\lock-autologon-session.ps1'
    return @{
        Name = 'PhotoLocal Docker Console Lock'
        Description = 'PhotoLocal console lock v1: current Docker owner, interactive console logon only.'
        UserId = $Sid; LogonType = 'Interactive'; RunLevel = 'Limited'
        Execute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '" -ExpectedSid "' + $Sid + '"'
        WorkingDirectory = $Root
    }
}

function Test-PhotoLocalConsoleLockTask {
    param($Task, $Spec)
    try {
        $actions = @($Task.Actions); $triggers = @($Task.Triggers)
        return ($Task.Description -eq $Spec.Description -and $Task.Settings.Enabled -and
            $actions.Count -eq 1 -and $triggers.Count -eq 1 -and
            $actions[0].Execute -eq $Spec.Execute -and $actions[0].Arguments -eq $Spec.Arguments -and
            $actions[0].WorkingDirectory -eq $Spec.WorkingDirectory -and
            (ConvertTo-PhotoLocalAccountSid $Task.Principal.UserId) -eq $Spec.UserId -and
            [string]$Task.Principal.LogonType -eq 'Interactive' -and [string]$Task.Principal.RunLevel -eq 'Limited' -and
            $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $triggers[0].Enabled -and
            (ConvertTo-PhotoLocalAccountSid $triggers[0].UserId) -eq $Spec.UserId -and
            (-not $triggers[0].Delay -or $triggers[0].Delay -eq 'PT0S') -and
            $Task.Settings.StartWhenAvailable -and -not $Task.Settings.DisallowStartIfOnBatteries -and
            -not $Task.Settings.StopIfGoingOnBatteries -and -not $Task.Settings.RunOnlyIfIdle -and
            -not $Task.Settings.RunOnlyIfNetworkAvailable -and
            [string]$Task.Settings.MultipleInstances -eq 'IgnoreNew' -and $Task.Settings.ExecutionTimeLimit -eq 'PT1M')
    } catch { return $false }
}

function Assert-PhotoLocalLockTaskAvailable {
    param($Spec)
    $existing = Get-ScheduledTask -TaskPath '\' -TaskName $Spec.Name -ErrorAction SilentlyContinue
    if ($existing -and -not (Test-PhotoLocalConsoleLockTask -Task $existing -Spec $Spec)) { throw 'LOCK_TASK_CONFLICT' }
}

function Ensure-PhotoLocalConsoleLockTask {
    param($Spec)
    Assert-PhotoLocalLockTaskAvailable -Spec $Spec
    if (-not (Get-ScheduledTask -TaskPath '\' -TaskName $Spec.Name -ErrorAction SilentlyContinue)) {
        $action = New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Arguments -WorkingDirectory $Spec.WorkingDirectory
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Spec.UserId
        $principal = New-ScheduledTaskPrincipal -UserId $Spec.UserId -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
        # No Force: a concurrent or unrelated task with this name must never be overwritten.
        Register-ScheduledTask -TaskPath '\' -TaskName $Spec.Name -Description $Spec.Description -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    }
    $installed = Get-ScheduledTask -TaskPath '\' -TaskName $Spec.Name
    if (-not (Test-PhotoLocalConsoleLockTask -Task $installed -Spec $Spec)) { throw 'LOCK_TASK_VERIFICATION_FAILED' }
}

function Assert-PhotoLocalMicrosoftSignature {
    param([string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ([string]$signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw 'MICROSOFT_SIGNATURE_REQUIRED'
    }
}

function Get-PhotoLocalAutologonTool {
    param([string]$Root)
    $dataRoot = Join-Path $Root 'docker-data'
    $runner = Join-Path $Root 'scripts\lock-autologon-session.ps1'
    if (-not (Test-Path -LiteralPath $dataRoot -PathType Container) -or -not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'STAGING_FILES_MISSING' }
    if (((Get-Item -LiteralPath $dataRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ((Get-Item -LiteralPath $runner).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'STAGING_PATH_UNSAFE' }
    $directory = Join-Path $dataRoot ('windows-autologon-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    # The GUI runs elevated. Restrict its staging directory to this account, SYSTEM and administrators.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $account = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $archivePath = Join-Path $directory 'Autologon.zip'
    $toolPath = Join-Path $directory 'Autologon64.exe'
    if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'USE_X64_WINDOWS_POWERSHELL' }
    $oldProtocols = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocols -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://download.sysinternals.com/files/AutoLogon.zip' -OutFile $archivePath -TimeoutSec 60 | Out-Null
    } finally { [Net.ServicePointManager]::SecurityProtocol = $oldProtocols }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName -ceq 'Autologon64.exe' })
        if ($entries.Count -ne 1 -or $entries[0].Length -lt 1 -or $entries[0].Length -gt 10MB) { throw 'AUTOLOGON_ARCHIVE_INVALID' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $toolPath, $false)
    } finally { $zip.Dispose() }
    Assert-PhotoLocalMicrosoftSignature -Path $toolPath
    return $toolPath
}

function Show-PhotoLocalAutologon {
    param([string]$Path, [string]$Account)
    Assert-PhotoLocalMicrosoftSignature -Path $Path
    Write-Host ('Konto Windows wlasciciela Dockera: ' + $Account)
    Write-Host 'W oknie Microsoft sprawdz User/Domain, wpisz HASLO WINDOWS (nie PIN, Google ani SMB) i kliknij Enable.'
    Write-Host 'Po komunikacie narzedzia zamknij jego okno. Haslo pozostaje tylko w narzedziu Microsoft i systemie Windows.'
    # A visible window is required for the user to enter the password locally. No arguments contain credentials.
    Start-Process -FilePath $Path -WindowStyle Normal -Wait | Out-Null
}

function Get-PhotoLocalAutologonState {
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $enabled = Get-ItemPropertyValue -LiteralPath $key -Name AutoAdminLogon -ErrorAction SilentlyContinue
    if ([string]$enabled -ne '1') { return @{ Enabled = $enabled; Sid = $null } }
    $user = Get-ItemPropertyValue -LiteralPath $key -Name DefaultUserName -ErrorAction SilentlyContinue
    $domain = Get-ItemPropertyValue -LiteralPath $key -Name DefaultDomainName -ErrorAction SilentlyContinue
    $sid = $null
    if ($user -and $domain) {
        try { $sid = ConvertTo-PhotoLocalAccountSid ($domain + '\' + $user) } catch { $sid = $null }
    }
    return @{ Enabled = $enabled; Sid = $sid }
}

function Invoke-PhotoLocalAutologonSetup {
    param([string]$Root)
    $identity = Get-PhotoLocalAutologonIdentity
    Assert-PhotoLocalAutologonIdentity -Identity $identity
    $spec = New-PhotoLocalConsoleLockSpec -Root $Root -Sid $identity.Sid
    Assert-PhotoLocalLockTaskAvailable -Spec $spec
    $tool = Get-PhotoLocalAutologonTool -Root $Root
    Ensure-PhotoLocalConsoleLockTask -Spec $spec
    Show-PhotoLocalAutologon -Path $tool -Account $identity.Account
    $state = Get-PhotoLocalAutologonState
    if ([string]$state.Enabled -ne '1') { throw 'AUTOLOGON_NOT_CONFIGURED' }
    if ($state.Sid -ne $identity.Sid) { throw 'AUTOLOGON_ACCOUNT_MISMATCH' }
    return [pscustomobject]@{
        Status = 'AUTOLOGON_CONFIGURED_REBOOT_NOT_TESTED'
        WindowsAccount = $identity.Account; LockTask = $spec.Name; AutologonTool = $tool
        ConsoleLock = 'CONFIGURED_NOT_TESTED'; ProductionCutover = 'NOT_PERFORMED'
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        Invoke-PhotoLocalAutologonSetup -Root $root | Format-List
    } catch {
        $status = $_.Exception.Message
        if ($status -notmatch '^[A-Z_]+$') { $status = 'AUTOLOGON_SETUP_FAILED' }
        [pscustomobject]@{ Status = $status; RebootTest = 'NOT_PERFORMED' } | Format-List
        exit 1
    }
}
