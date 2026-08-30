[CmdletBinding()]
param(
    [string]$DshHome,
    [string]$DshCommand,
    [string]$Version,
    [switch]$AllowDowngrade,
    [switch]$AcceptLicense,
    [switch]$WhatIf,
    [uri]$ReleaseApiUri = 'https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/latest',
    [string]$Operation = 'Install'
)

function ConvertFrom-ChecksumManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Manifest
    )

    $lines = @([regex]::Split($Manifest, '\r?\n'))
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        if ($lines.Count -eq 1) {
            $lines = @()
        }
        else {
            $lines = @($lines[0..($lines.Count - 2)])
        }
    }
    if ($lines.Count -eq 0) {
        throw 'Checksum manifest must contain at least one canonical entry.'
    }

    $result = [ordered]@{}
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $safeReleaseFileNamePattern = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
    $linePattern = '\A(?<hash>[0-9A-Fa-f]{64})  (?<name>' + $safeReleaseFileNamePattern + ')\z'
    $reservedNamePattern = '\A(?i:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|\z)'

    foreach ($line in $lines) {
        $match = [regex]::Match([string]$line, $linePattern)
        if (-not $match.Success) {
            throw 'Checksum manifest contains a malformed entry.'
        }
        $name = $match.Groups['name'].Value
        if ($name -eq '.' -or $name -eq '..' -or $name.StartsWith(' ') -or $name.EndsWith('.') -or $name.EndsWith(' ') -or
            $name -match '[\x00-\x1F]' -or $name -match $reservedNamePattern) {
            throw 'Checksum manifest contains an invalid file name.'
        }
        if (-not $names.Add($name)) {
            throw "Checksum manifest contains a duplicate file name: $name"
        }
        $result[$name] = $match.Groups['hash'].Value.ToLowerInvariant()
    }

    return $result
}

function Compare-SemanticVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,
        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    $versionPattern = '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
    if ($Left -notmatch $versionPattern -or $Right -notmatch $versionPattern) {
        throw 'A semantic version must contain exactly three canonical non-negative integer components.'
    }

    $leftParts = @($Left.Split('.'))
    $rightParts = @($Right.Split('.'))
    for ($index = 0; $index -lt 3; $index++) {
        if ($leftParts[$index].Length -gt $rightParts[$index].Length) { return 1 }
        if ($leftParts[$index].Length -lt $rightParts[$index].Length) { return -1 }
        $comparison = [string]::CompareOrdinal($leftParts[$index], $rightParts[$index])
        if ($comparison -gt 0) { return 1 }
        if ($comparison -lt 0) { return -1 }
    }
    return 0
}

function Test-LocalFixedPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue,
        [object[]]$DriveRecords
    )

    if ($PathValue -notmatch '^[A-Za-z]:\\' -or $PathValue.Contains('/') -or $PathValue.StartsWith('\\')) {
        throw 'Path must be a normalized absolute local Windows path.'
    }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($PathValue)
    }
    catch {
        throw 'Path must be a normalized absolute local Windows path.'
    }
    if (-not [string]::Equals($fullPath, $PathValue, [System.StringComparison]::Ordinal)) {
        throw 'Path must be a normalized absolute local Windows path.'
    }

    $driveId = $fullPath.Substring(0, 2)
    if ($PSBoundParameters.ContainsKey('DriveRecords')) {
        $disk = @($DriveRecords | Where-Object {
            $_ -ne $null -and $_.PSObject.Properties['DeviceID'] -ne $null -and
            [string]::Equals([string]$_.DeviceID, $driveId, [System.StringComparison]::OrdinalIgnoreCase)
        })
        if ($disk.Count -ne 1 -or $disk[0].PSObject.Properties['DriveType'] -eq $null -or [int]$disk[0].DriveType -ne 3) {
            throw 'Path must be on a local fixed Windows drive.'
        }
    }
    else {
        $escapedDriveId = $driveId.Replace("'", "''")
        $disk = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$escapedDriveId'" -ErrorAction Stop)
        if ($disk.Count -ne 1 -or [int]$disk[0].DriveType -ne 3) {
            throw 'Path must be on a local fixed Windows drive.'
        }
    }

    $driveRoot = $fullPath.Substring(0, 3)
    $current = $fullPath
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Path must not traverse an existing reparse point.'
            }
        }
        if ([string]::Equals($current, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($parent -eq $null) {
            $current = $driveRoot
        }
        else {
            $current = $parent.FullName
        }
    }

    return $true
}

function Resolve-SystemTarCommand {
    [CmdletBinding()]
    param()

    try {
        $systemRoot = [string]$env:SystemRoot
        if ([string]::IsNullOrWhiteSpace($systemRoot)) { throw 'invalid' }
        $trustedSystemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
        if ([string]::IsNullOrWhiteSpace($trustedSystemRoot) -or
            -not [string]::Equals($systemRoot, $trustedSystemRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid'
        }
        $nativeDirectory = if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) { 'Sysnative' } else { 'System32' }
        $tarPath = Join-Path (Join-Path $systemRoot $nativeDirectory) 'tar.exe'
        if ($tarPath -notmatch '^[A-Za-z]:\\' -or $tarPath.Contains('/') -or
            -not [string]::Equals([System.IO.Path]::GetFullPath($tarPath), $tarPath, [System.StringComparison]::Ordinal)) {
            throw 'invalid'
        }
        $driveRoot = [System.IO.Path]::GetPathRoot($tarPath)
        $drive = New-Object System.IO.DriveInfo($driveRoot)
        if (-not $drive.IsReady -or $drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw 'invalid' }
        $current = $tarPath
        while ($true) {
            if (Test-Path -LiteralPath $current) {
                $currentItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
                if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
            }
            if ([string]::Equals($current, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
            $parent = [System.IO.Directory]::GetParent($current)
            $current = if ($parent -eq $null) { $driveRoot } else { $parent.FullName }
        }
        if (-not (Test-Path -LiteralPath $tarPath -PathType Leaf)) { throw 'invalid' }
        $tarItem = Get-Item -LiteralPath $tarPath -Force -ErrorAction Stop
        if (($tarItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::Equals([string]$tarItem.FullName, $tarPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid'
        }
        return [string]$tarPath
    }
    catch { throw 'tar_required' }
}

function Resolve-DshHome {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$DshHome,
        [AllowEmptyString()]
        [string]$EnvironmentHome,
        [AllowEmptyString()]
        [string]$UserProfilePath,
        [string[]]$KnownCandidates = @(),
        [string[]]$ExistingDesktopProfiles,
        [object[]]$DriveRecords
    )

    if (-not $PSBoundParameters.ContainsKey('EnvironmentHome')) { $EnvironmentHome = [string]$env:DSH_HOME }
    if (-not $PSBoundParameters.ContainsKey('UserProfilePath')) { $UserProfilePath = [string]$env:USERPROFILE }
    $hasInjectedProfiles = $PSBoundParameters.ContainsKey('ExistingDesktopProfiles')
    $hasInjectedDrives = $PSBoundParameters.ContainsKey('DriveRecords')

    $validateCandidate = {
        param([string]$Candidate)
        if ($hasInjectedDrives) {
            Test-LocalFixedPath -PathValue $Candidate -DriveRecords $DriveRecords | Out-Null
        }
        else {
            Test-LocalFixedPath -PathValue $Candidate | Out-Null
        }
        $desktopProfile = Resolve-ContainedLiteralPath -Root $Candidate -RelativePath 'profiles\desktop' -ErrorCategory 'profile_reparse_rejected'
        if ($hasInjectedDrives) { Test-LocalFixedPath -PathValue $desktopProfile -DriveRecords $DriveRecords | Out-Null }
        else { Test-LocalFixedPath -PathValue $desktopProfile | Out-Null }
        if ($hasInjectedProfiles) {
            return @($ExistingDesktopProfiles | Where-Object {
                [string]::Equals([string]$_, $Candidate, [System.StringComparison]::OrdinalIgnoreCase)
            }).Count -gt 0
        }
        return Test-Path -LiteralPath (Join-Path $Candidate 'profiles\desktop') -PathType Container
    }

    if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
        if (-not (& $validateCandidate $DshHome)) { throw 'The explicit DSH home does not contain a desktop profile.' }
        return $DshHome
    }
    if (-not [string]::IsNullOrWhiteSpace($EnvironmentHome)) {
        if (-not (& $validateCandidate $EnvironmentHome)) { throw 'The DSH_HOME environment path does not contain a desktop profile.' }
        return $EnvironmentHome
    }
    if (-not [string]::IsNullOrWhiteSpace($UserProfilePath)) {
        $defaultHome = Join-Path $UserProfilePath '.dsh'
        if (& $validateCandidate $defaultHome) { return $defaultHome }
    }

    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($KnownCandidates)) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) { continue }
        if (& $validateCandidate ([string]$candidate)) {
            $alreadyAdded = @($matches | Where-Object {
                [string]::Equals($_, [string]$candidate, [System.StringComparison]::OrdinalIgnoreCase)
            }).Count -gt 0
            if (-not $alreadyAdded) { $matches.Add([string]$candidate) }
        }
    }
    if ($matches.Count -eq 0) { throw 'Unable to resolve a DSH home; specify -DshHome.' }
    if ($matches.Count -gt 1) { throw 'Multiple DSH homes were found; specify -DshHome.' }
    return $matches[0]
}

function Resolve-DshCommand {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$DshCommand,
        [string[]]$PathCommands,
        [string[]]$ManagedCommands,
        [string[]]$ExistingCommands,
        [object[]]$DriveRecords
    )

    $hasInjectedExisting = $PSBoundParameters.ContainsKey('ExistingCommands')
    $hasInjectedDrives = $PSBoundParameters.ContainsKey('DriveRecords')
    $validateCommand = {
        param([string]$Candidate)
        if ($hasInjectedDrives) {
            Test-LocalFixedPath -PathValue $Candidate -DriveRecords $DriveRecords | Out-Null
        }
        else {
            Test-LocalFixedPath -PathValue $Candidate | Out-Null
        }
        if ([System.IO.Path]::GetExtension($Candidate) -notin @('.cmd', '.exe', '.ps1')) {
            throw 'DSH command must be a .cmd, .exe, or .ps1 application path.'
        }
        if ($hasInjectedExisting) {
            return @($ExistingCommands | Where-Object {
                [string]::Equals([string]$_, $Candidate, [System.StringComparison]::OrdinalIgnoreCase)
            }).Count -gt 0
        }
        return Test-Path -LiteralPath $Candidate -PathType Leaf
    }

    if (-not [string]::IsNullOrWhiteSpace($DshCommand)) {
        if (-not (& $validateCommand $DshCommand)) { throw 'The explicit DSH command does not exist.' }
        return $DshCommand
    }

    if (-not $PSBoundParameters.ContainsKey('PathCommands')) {
        $PathCommands = @(Get-Command dsh -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Path })
    }
    $pathMatches = @($PathCommands | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) -and (& $validateCommand ([string]$_)) })
    $pathMatches = @($pathMatches | Select-Object -Unique)
    if ($pathMatches.Count -gt 1) { throw 'Multiple DSH commands were found on PATH; specify -DshCommand.' }
    if ($pathMatches.Count -eq 1) { return [string]$pathMatches[0] }

    if (-not $PSBoundParameters.ContainsKey('ManagedCommands')) {
        $ManagedCommands = @()
        if (-not [string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
            $ManagedCommands += Join-Path $env:LOCALAPPDATA 'DSH Desktop\dsh.cmd'
            $ManagedCommands += Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\dsh.cmd'
        }
    }
    $managedMatches = @($ManagedCommands | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) -and (& $validateCommand ([string]$_)) })
    $managedMatches = @($managedMatches | Select-Object -Unique)
    if ($managedMatches.Count -gt 1) { throw 'Multiple managed DSH commands were found; specify -DshCommand.' }
    if ($managedMatches.Count -eq 1) { return [string]$managedMatches[0] }
    throw 'Unable to resolve a DSH command; specify -DshCommand.'
}

function Select-OwnedDshProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$ProcessRecords,
        [Parameter(Mandatory = $true)]
        [string[]]$OwnedRoots
    )

    $canonicalRoots = @()
    foreach ($root in @($OwnedRoots)) {
        if ([string]::IsNullOrWhiteSpace([string]$root) -or [string]$root -notmatch '^[A-Za-z]:\\' -or [string]$root -match '/') {
            throw 'Owned process roots must be normalized absolute local Windows paths.'
        }
        $fullRoot = [System.IO.Path]::GetFullPath([string]$root).TrimEnd('\')
        if (-not [string]::Equals($fullRoot, ([string]$root).TrimEnd('\'), [System.StringComparison]::Ordinal)) {
            throw 'Owned process roots must be normalized absolute local Windows paths.'
        }
        $canonicalRoots += $fullRoot
    }

    $normalizePathToken = {
        param([string]$Token)
        if ([string]::IsNullOrWhiteSpace($Token) -or $Token -notmatch '^[A-Za-z]:\\' -or $Token.Contains('/')) {
            return $null
        }
        try {
            $normalizedToken = [System.IO.Path]::GetFullPath($Token)
            if (-not [string]::Equals($normalizedToken, $Token, [System.StringComparison]::Ordinal)) {
                return $null
            }
            return $normalizedToken.TrimEnd('\')
        }
        catch {
            return $null
        }
    }
    $isWithinRoot = {
        param([string]$Candidate, [string]$Root)
        if ([string]::Equals($Candidate, $Root, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        return $Candidate.Length -gt $Root.Length -and
            $Candidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -and
            $Candidate[$Root.Length] -eq '\'
    }
    $splitCommandLine = {
        param([string]$CommandLine)
        if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
        $insideDoubleQuotes = $false
        for ($index = 0; $index -lt $CommandLine.Length; $index++) {
            if ($CommandLine[$index] -eq '"') {
                $backslashCount = 0
                for ($before = $index - 1; $before -ge 0 -and $CommandLine[$before] -eq '\'; $before--) {
                    $backslashCount++
                }
                if (($backslashCount % 2) -eq 0) { $insideDoubleQuotes = -not $insideDoubleQuotes }
            }
        }
        if ($insideDoubleQuotes) { return @() }

        try {
            if ($null -eq ('DshInstaller.NativeCommandLine' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace DshInstaller {
    public static class NativeCommandLine {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static string[] Split(string commandLine) {
            int argumentCount;
            IntPtr arguments = CommandLineToArgvW(commandLine, out argumentCount);
            if (arguments == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                string[] result = new string[argumentCount];
                for (int index = 0; index < argumentCount; index++) {
                    IntPtr argument = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
                    result[index] = Marshal.PtrToStringUni(argument);
                }
                return result;
            }
            finally {
                LocalFree(arguments);
            }
        }
    }
}
'@ | Out-Null
            }
            return @([DshInstaller.NativeCommandLine]::Split($CommandLine))
        }
        catch {
            return @()
        }
    }

    foreach ($processRecord in @($ProcessRecords)) {
        if ($processRecord -eq $null) { continue }
        $executablePath = [string]$processRecord.ExecutablePath
        $commandLine = [string]$processRecord.CommandLine
        $isOwned = $false
        $pathCandidates = New-Object System.Collections.Generic.List[string]
        $normalizedExecutable = & $normalizePathToken $executablePath
        if ($normalizedExecutable -ne $null) { $pathCandidates.Add([string]$normalizedExecutable) }
        foreach ($token in @(& $splitCommandLine $commandLine)) {
            if ([string]$token -match '^-') { continue }
            $normalizedToken = & $normalizePathToken ([string]$token)
            if ($normalizedToken -ne $null) { $pathCandidates.Add([string]$normalizedToken) }
        }
        foreach ($candidate in $pathCandidates) {
            foreach ($root in $canonicalRoots) {
                if (& $isWithinRoot $candidate $root) {
                    $isOwned = $true
                    break
                }
            }
            if ($isOwned) { break }
        }
        if ($isOwned) { Write-Output $processRecord }
    }
}

function Write-InstallerLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$OperationLog,
        [Parameter(Mandatory = $true)]
        [string]$EventName,
        [Parameter(Mandatory = $true)]
        [object]$Data
    )

    $eventNames = @('InstallerPhase', 'InstallerIntegrity', 'InstallerProcessGate', 'InstallerResult')
    if ($eventNames -cnotcontains $EventName) {
        throw 'Unsafe installer log event.'
    }

    $orderedFields = @('operation', 'phase', 'resultCode', 'driveRoot', 'version', 'assetHash', 'rollbackResult', 'processId', 'errorCategory')
    $eventFields = @{
        InstallerPhase = @('operation', 'phase', 'resultCode', 'driveRoot', 'version', 'errorCategory')
        InstallerIntegrity = @('operation', 'phase', 'resultCode', 'driveRoot', 'version', 'assetHash', 'errorCategory')
        InstallerProcessGate = @('operation', 'phase', 'resultCode', 'driveRoot', 'processId', 'errorCategory')
        InstallerResult = @('operation', 'phase', 'resultCode', 'driveRoot', 'version', 'rollbackResult', 'errorCategory')
    }
    $allowedFields = @($eventFields[$EventName])
    if ($Data -is [System.Collections.IDictionary]) {
        $providedFields = @($Data.Keys | ForEach-Object { [string]$_ })
    }
    else {
        $providedFields = @($Data.PSObject.Properties | ForEach-Object { [string]$_.Name })
    }
    foreach ($field in $providedFields) {
        if ($allowedFields -notcontains $field) { throw "Unsafe installer log field: $field" }
    }

    $entry = [ordered]@{ event = $EventName }
    foreach ($field in $orderedFields) {
        if ($providedFields -contains $field) {
            if ($Data -is [System.Collections.IDictionary]) { $value = $Data[$field] } else { $value = $Data.$field }
            $valid = $false
            switch ($field) {
                'operation' {
                    $valid = $value -is [string] -and @('Install', 'Uninstall') -ccontains [string]$value
                }
                'phase' {
                    $valid = $value -is [string] -and @('discovery', 'integrity', 'process-gate', 'plan', 'mutation', 'rollback', 'complete') -ccontains [string]$value
                }
                'resultCode' {
                    $valid = ($value -is [byte] -or $value -is [int16] -or $value -is [int32] -or $value -is [int64]) -and
                        [int64]$value -ge 0 -and [int64]$value -le 255
                }
                'driveRoot' {
                    $valid = $value -is [string] -and [string]$value -cmatch '\A[A-Za-z]:\\\z'
                }
                'version' {
                    $valid = $value -is [string] -and [string]$value -match '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
                }
                'assetHash' {
                    $valid = $value -is [string] -and [string]$value -cmatch '\A[0-9a-f]{64}\z'
                }
                'rollbackResult' {
                    $valid = $value -is [string] -and @('not-required', 'succeeded', 'failed', 'incomplete') -ccontains [string]$value
                }
                'processId' {
                    $valid = ($value -is [byte] -or $value -is [int16] -or $value -is [int32] -or $value -is [int64]) -and
                        [int64]$value -gt 0 -and [int64]$value -le [int32]::MaxValue
                }
                'errorCategory' {
                    $valid = $value -is [string] -and @('none', 'input', 'path', 'network', 'http', 'integrity', 'cli', 'profile', 'process-running', 'validation', 'rollback', 'rollback_incomplete', 'temporary-cleanup', 'internal') -ccontains [string]$value
                }
            }
            if (-not $valid) {
                throw "Unsafe installer log value for field: $field"
            }
            $entry[$field] = $value
        }
    }

    $json = $entry | ConvertTo-Json -Compress
    try { [DshMarketInstaller.InstallerCapabilities]::AppendOperationLog($OperationLog, $json) }
    catch { throw 'operation_log_write_failed' }
}

function New-InstallerOperationLog {
    [CmdletBinding()]
    param()

    try {
        Initialize-InstallerNativeFileApi
        return [DshMarketInstaller.InstallerCapabilities]::CreateOperationLog([System.IO.Path]::GetTempPath())
    }
    catch { throw 'operation_log_path_invalid' }
}

function Confirm-InstallerLicense {
    [CmdletBinding()]
    param([switch]$AcceptLicense)

    if ($AcceptLicense) { return }
    Write-Output 'Limited-use notice: personal, non-commercial, read-only research only.'
    Write-Output 'Tencent and Sina are not partners of, and have not authorized, this project.'
    Write-Output 'Their unofficial interfaces may change, fail, or become unavailable without notice.'
    if ([Console]::IsInputRedirected) { throw 'license_not_accepted' }
    $response = $null
    try { $response = Read-Host 'Type yes to accept the limited-use license' }
    catch { $response = $null }
    if (-not (Test-InstallerLicenseAffirmative -Response $response)) { throw 'license_not_accepted' }
}

function Test-InstallerLicenseAffirmative {
    [CmdletBinding()]
    param([AllowNull()][string]$Response)
    return [string]$Response -match '\A(?i:yes|y)\z'
}

function Get-InstallerFileHash {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = New-Object System.IO.FileStream($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha256.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Read-InstallerSharedText {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $stream = New-Object System.IO.FileStream($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Get-InstallerTextHash {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Text)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha256.Dispose() }
}

function Test-ReleaseUri {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [uri]$LoopbackOrigin
    )

    if ($Uri.Scheme -eq 'https') { return $true }
    if ($Uri.Scheme -ne 'http' -or -not $Uri.IsLoopback) { throw 'release_uri_invalid' }
    if ($LoopbackOrigin -ne $null -and
        (-not [string]::Equals($Uri.Scheme, $LoopbackOrigin.Scheme, [System.StringComparison]::OrdinalIgnoreCase) -or
         -not [string]::Equals($Uri.Host, $LoopbackOrigin.Host, [System.StringComparison]::OrdinalIgnoreCase) -or
         $Uri.Port -ne $LoopbackOrigin.Port)) {
        throw 'release_uri_invalid'
    }
    return $true
}

function Invoke-ReleaseTextDownload {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][uri]$Uri)

    Test-ReleaseUri -Uri $Uri | Out-Null
    $client = New-Object System.Net.WebClient
    try {
        $client.Headers[[System.Net.HttpRequestHeader]::UserAgent] = 'dsh-market-intelligence-installer'
        return [string]$client.DownloadString($Uri)
    }
    catch { throw 'release_download_failed' }
    finally { $client.Dispose() }
}

function Save-ReleaseAsset {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][uri]$ReleaseApiUri
    )

    if ($ReleaseApiUri.Scheme -eq 'http') { Test-ReleaseUri -Uri $Uri -LoopbackOrigin $ReleaseApiUri | Out-Null }
    elseif ($Uri.Scheme -ne 'https') { throw 'release_uri_invalid' }
    $client = New-Object System.Net.WebClient
    try {
        $client.Headers[[System.Net.HttpRequestHeader]::UserAgent] = 'dsh-market-intelligence-installer'
        $client.DownloadFile($Uri, $LiteralPath)
    }
    catch { throw 'release_download_failed' }
    finally { $client.Dispose() }
}

function Get-ReleasePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][uri]$ReleaseApiUri,
        [string]$RequestedVersion
    )

    Test-ReleaseUri -Uri $ReleaseApiUri | Out-Null
    try { $release = (Invoke-ReleaseTextDownload -Uri $ReleaseApiUri) | ConvertFrom-Json }
    catch { throw 'release_metadata_invalid' }
    $tagMatch = [regex]::Match([string]$release.tag_name, '\Av(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\z')
    if (-not $tagMatch.Success) { throw 'release_version_mismatch' }
    $releaseVersion = [string]$tagMatch.Groups['version'].Value
    if (-not [string]::IsNullOrWhiteSpace($RequestedVersion) -and $releaseVersion -cne $RequestedVersion) { throw 'release_version_mismatch' }
    $RequestedVersion = $releaseVersion
    $assets = @($release.assets)
    $manifestAssets = @($assets | Where-Object { [string]$_.name -ceq 'SHA256SUMS.txt' })
    $packageName = 'dsh-market-intelligence-' + $RequestedVersion + '.tgz'
    $packageAssets = @($assets | Where-Object { [string]$_.name -ceq $packageName })
    if ($manifestAssets.Count -ne 1 -or $packageAssets.Count -ne 1) { throw 'release_assets_invalid' }
    try {
        $manifestUri = [uri][string]$manifestAssets[0].browser_download_url
        $packageUri = [uri][string]$packageAssets[0].browser_download_url
    }
    catch { throw 'release_assets_invalid' }
    if ($ReleaseApiUri.Scheme -eq 'http') {
        Test-ReleaseUri -Uri $manifestUri -LoopbackOrigin $ReleaseApiUri | Out-Null
        Test-ReleaseUri -Uri $packageUri -LoopbackOrigin $ReleaseApiUri | Out-Null
    }
    elseif ($manifestUri.Scheme -ne 'https' -or $packageUri.Scheme -ne 'https') { throw 'release_assets_invalid' }

    $manifest = Invoke-ReleaseTextDownload -Uri $manifestUri
    $entries = ConvertFrom-ChecksumManifest -Manifest $manifest
    if (-not $entries.Contains($packageName)) { throw 'release_manifest_package_missing' }
    return [pscustomobject]@{
        PackageHash = [string]$entries[$packageName]
        PackageName = $packageName
        PackageUri = $packageUri
        Version = $RequestedVersion
    }
}

function Read-TarEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TarPath,
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$TarCommand
    )

    $arguments = @('-xOf', $TarPath, $ArchivePath)
    $output = @(& $TarCommand @arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'package_archive_invalid' }
    return [string]::Join([System.Environment]::NewLine, @($output | ForEach-Object { [string]$_ }))
}

function New-InstallerTemporaryDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TemporaryRoot,
        [object[]]$DriveRecords
    )
    try {
        if ($PSBoundParameters.ContainsKey('DriveRecords')) { Test-LocalFixedPath -PathValue $TemporaryRoot -DriveRecords $DriveRecords | Out-Null }
        else { Test-LocalFixedPath -PathValue $TemporaryRoot | Out-Null }
        Initialize-InstallerNativeFileApi
        return [DshMarketInstaller.InstallerCapabilities]::CreateTemporary($TemporaryRoot)
    }
    catch { throw 'temporary_path_invalid' }
}

function Initialize-InstallerNativeFileApi {
    [CmdletBinding()]
    param()
    if ('DshMarketInstaller.LockedPath' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Management.Automation;
using Microsoft.Win32.SafeHandles;

namespace DshMarketInstaller {
    [StructLayout(LayoutKind.Sequential)]
    internal struct ByHandleFileInformation {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileDispositionInformation {
        internal int DeleteFile;
    }

    internal sealed class LockedPath : IDisposable {
        private SafeFileHandle handle;
        internal string IdentityKey { get; private set; }
        internal bool IsDirectory { get; private set; }
        internal bool IsReparsePoint { get; private set; }
        internal uint Attributes { get; private set; }
        internal uint NumberOfLinks { get; private set; }
        internal bool IsValid { get { return handle != null && !handle.IsClosed && !handle.IsInvalid; } }
        internal string FinalPath { get { return NativeFile.FinalPath(handle); } }

        internal LockedPath(SafeFileHandle value, ByHandleFileInformation info) {
            handle = value;
            IdentityKey = info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + ":" + info.FileIndexLow.ToString("x8");
            IsDirectory = (info.FileAttributes & 0x10U) != 0;
            IsReparsePoint = (info.FileAttributes & 0x400U) != 0;
            Attributes = info.FileAttributes;
            NumberOfLinks = info.NumberOfLinks;
        }

        internal void SetDeleteDisposition(bool delete) {
            FileDispositionInformation disposition = new FileDispositionInformation();
            disposition.DeleteFile = delete ? 1 : 0;
            if (!NativeFile.SetFileInformationByHandle(handle, 4, ref disposition, Marshal.SizeOf(typeof(FileDispositionInformation)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public void Dispose() {
            if (handle != null) { handle.Dispose(); handle = null; }
        }
    }

    internal static class NativeFile {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, ref FileDispositionInformation information, int bufferSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint pathLength, uint flags);

        internal static ByHandleFileInformation Information(SafeFileHandle handle) {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
            return information;
        }

        internal static string FinalPath(SafeFileHandle handle) {
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0U);
            if (length == 0U || length >= (uint)buffer.Capacity) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
            string value = buffer.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) { return @"\\" + value.Substring(8); }
            if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) { return value.Substring(4); }
            return value;
        }

        internal static ByHandleFileInformation VerifyOrdinaryFile(SafeFileHandle handle, string expectedPath) {
            ByHandleFileInformation information = Information(handle);
            if ((information.FileAttributes & 0x410U) != 0U || information.NumberOfLinks != 1U ||
                !String.Equals(Path.GetFullPath(expectedPath), Path.GetFullPath(FinalPath(handle)), StringComparison.OrdinalIgnoreCase)) {
                throw new InvalidOperationException("file_identity_invalid");
            }
            return information;
        }

        internal static string Identity(ByHandleFileInformation information) {
            return information.VolumeSerialNumber.ToString("x8") + ":" + information.FileIndexHigh.ToString("x8") + ":" + information.FileIndexLow.ToString("x8");
        }

        internal static LockedPath OpenLocked(string path) {
            const uint DeleteAccess = 0x00010000U;
            const uint ReadAttributes = 0x00000080U;
            const uint ShareReadWrite = 0x00000003U;
            const uint OpenExisting = 3U;
            const uint OpenReparsePointAndBackupSemantics = 0x02200000U;
            SafeFileHandle handle = CreateFileW(path, DeleteAccess | ReadAttributes, ShareReadWrite, IntPtr.Zero, OpenExisting, OpenReparsePointAndBackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            return new LockedPath(handle, information);
        }

        internal static LockedPath OpenIdentity(string path) {
            const uint ReadAttributes = 0x00000080U;
            const uint ShareReadWriteDelete = 0x00000007U;
            const uint OpenExisting = 3U;
            const uint OpenReparsePointAndBackupSemantics = 0x02200000U;
            SafeFileHandle handle = CreateFileW(path, ReadAttributes, ShareReadWriteDelete, IntPtr.Zero, OpenExisting, OpenReparsePointAndBackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            return new LockedPath(handle, information);
        }

        internal static LockedPath CreateLockedDirectory(string parentPath, string childName) {
            if (String.IsNullOrWhiteSpace(childName) || childName.IndexOfAny(new char[] { '\\', '/' }) >= 0) { throw new ArgumentException("childName"); }
            LockedPath parent = OpenLocked(parentPath);
            try {
                if (!parent.IsDirectory || parent.IsReparsePoint || !parent.IsValid) { throw new InvalidOperationException("parent"); }
                string childPath = Path.Combine(parentPath, childName);
                if (Directory.Exists(childPath) || File.Exists(childPath)) { throw new IOException("exists"); }
                Directory.CreateDirectory(childPath);
                try { return OpenLocked(childPath); }
                catch {
                    LockedPath cleanup = null;
                    try {
                        cleanup = OpenLocked(childPath);
                        if (!cleanup.IsDirectory || cleanup.IsReparsePoint || Directory.GetFileSystemEntries(childPath).Length != 0) { throw new InvalidOperationException("unproven"); }
                        cleanup.SetDeleteDisposition(true);
                    }
                    catch { }
                    finally { if (cleanup != null) { cleanup.Dispose(); } }
                    throw;
                }
            }
            finally { parent.Dispose(); }
        }
    }

    internal enum CapabilityState {
        Building,
        Active,
        Attempted,
        Succeeded,
        Failed
    }

    internal sealed class BackupCapabilityRecord {
        internal readonly WeakReference OriginalWrapper;
        internal CapabilityState State;
        internal readonly string DshHome;
        internal readonly string BackupDirectory;
        internal readonly string OperationId;
        internal LockedPath RootHandle;
        internal string ManifestHash;
        internal string DirectoryManifestHash;
        internal string BackupTreeHash;
        internal readonly Dictionary<string, LockedPath> RetainedDirectories;
        internal readonly List<FileStream> RetainedFiles;
        internal readonly Dictionary<string, FileStream> RetainedFilesByRelativePath;
        internal readonly Dictionary<string, BackupRowRecord> Rows;
        internal FileStream ManifestStream;
        internal FileStream DirectoryManifestStream;
        internal object RestoreWrapper;

        internal BackupCapabilityRecord(object wrapper, string dshHome, string backupDirectory, string operationId, LockedPath rootHandle) {
            OriginalWrapper = new WeakReference(wrapper);
            State = CapabilityState.Building;
            DshHome = dshHome;
            BackupDirectory = backupDirectory;
            OperationId = operationId;
            RootHandle = rootHandle;
            RetainedDirectories = new Dictionary<string, LockedPath>(StringComparer.OrdinalIgnoreCase);
            RetainedFiles = new List<FileStream>();
            RetainedFilesByRelativePath = new Dictionary<string, FileStream>(StringComparer.OrdinalIgnoreCase);
            Rows = new Dictionary<string, BackupRowRecord>(StringComparer.Ordinal);
        }
    }

    internal sealed class BackupRowRecord {
        internal readonly string RelativePath; internal readonly bool Existed; internal readonly long Length; internal readonly string Hash;
        internal BackupRowRecord(string relativePath, bool existed, long length, string hash) {
            RelativePath = relativePath; Existed = existed; Length = length; Hash = hash;
        }
    }

    internal sealed class RestoreCapabilityRecord {
        internal readonly WeakReference OriginalWrapper; internal readonly BackupCapabilityRecord Backup;
        internal readonly string ProfileRoot; internal CapabilityState State;
        internal RestoreCapabilityRecord(object wrapper, BackupCapabilityRecord backup, string profileRoot) {
            OriginalWrapper = new WeakReference(wrapper); Backup = backup; ProfileRoot = profileRoot; State = CapabilityState.Active;
        }
    }

    internal sealed class TemporaryCapabilityRecord {
        internal readonly WeakReference OriginalWrapper;
        internal CapabilityState State;
        internal readonly string Root;
        internal readonly string Path;
        internal readonly string OperationId;
        internal readonly string CleanupToken;
        internal readonly string CreationIdentity;
        internal LockedPath RootHandle;
        internal List<LockedPath> RetainedHandles;

        internal TemporaryCapabilityRecord(object wrapper, string root, string path, string operationId, string cleanupToken,
            string creationIdentity, LockedPath rootHandle) {
            OriginalWrapper = new WeakReference(wrapper);
            State = CapabilityState.Active;
            Root = root;
            Path = path;
            OperationId = operationId;
            CleanupToken = cleanupToken;
            CreationIdentity = creationIdentity;
            RootHandle = rootHandle;
        }
    }

    internal sealed class OperationLogCapabilityRecord {
        internal readonly WeakReference OriginalWrapper;
        internal readonly string Directory;
        internal readonly string LogPath;
        internal LockedPath DirectoryHandle;
        internal FileStream Stream;
        internal CapabilityState State;

        internal OperationLogCapabilityRecord(object wrapper, string directory, string logPath, LockedPath directoryHandle, FileStream stream) {
            OriginalWrapper = new WeakReference(wrapper);
            Directory = directory;
            LogPath = logPath;
            DirectoryHandle = directoryHandle;
            Stream = stream;
            State = CapabilityState.Active;
        }
    }

    internal static class CapabilityRegistry {
        internal static readonly object Gate = new object();
        internal static readonly ConditionalWeakTable<object, BackupCapabilityRecord> Backups = new ConditionalWeakTable<object, BackupCapabilityRecord>();
        internal static readonly ConditionalWeakTable<object, RestoreCapabilityRecord> Restores = new ConditionalWeakTable<object, RestoreCapabilityRecord>();
        internal static readonly ConditionalWeakTable<object, TemporaryCapabilityRecord> Temporaries = new ConditionalWeakTable<object, TemporaryCapabilityRecord>();
        internal static readonly ConditionalWeakTable<object, OperationLogCapabilityRecord> OperationLogs = new ConditionalWeakTable<object, OperationLogCapabilityRecord>();
    }

    public sealed class InstallerBackupView {
        public string BackupDirectory { get; private set; }
        public string DirectoryManifestHash { get; private set; }
        public string DirectoryManifestPath { get; private set; }
        public string ManifestHash { get; private set; }
        public string ManifestPath { get; private set; }
        public string OperationId { get; private set; }
        public string State { get; private set; }
        internal InstallerBackupView(BackupCapabilityRecord record) {
            BackupDirectory = record.BackupDirectory;
            DirectoryManifestHash = record.DirectoryManifestHash;
            DirectoryManifestPath = Path.Combine(record.BackupDirectory, "backup-directories.json");
            ManifestHash = record.ManifestHash;
            ManifestPath = Path.Combine(record.BackupDirectory, "backup-manifest.json");
            OperationId = record.OperationId;
            State = record.State.ToString();
        }
        public override string ToString() { return "InstallerBackupView"; }
    }

    public sealed class InstallerFileCopyView {
        public long Length { get; private set; }
        public string Sha256 { get; private set; }
        internal InstallerFileCopyView(long length, string sha256) { Length = length; Sha256 = sha256; }
    }

    public sealed class InstallerRestoreRowView {
        public string RelativePath { get; private set; } public bool Existed { get; private set; }
        public long Length { get; private set; } public string Sha256 { get; private set; }
        internal InstallerRestoreRowView(BackupRowRecord row) { RelativePath=row.RelativePath; Existed=row.Existed; Length=row.Length; Sha256=row.Hash; }
    }

    public sealed class InstallerOperationLogView {
        public string LogPath { get; private set; }
        public string State { get; private set; }
        internal InstallerOperationLogView(OperationLogCapabilityRecord record) { LogPath = record.LogPath; State = record.State.ToString(); }
    }

    internal sealed class TreeEntry {
        internal string RelativePath;
        internal string Identity;
        internal bool IsDirectory;
        internal long Length;
        internal string Hash;
        internal uint Attributes;
        internal string FullPath;
    }

    public static class InstallerCapabilities {
        private static string FullDirectory(string path) {
            if (String.IsNullOrWhiteSpace(path)) { throw new InvalidOperationException("path_invalid"); }
            string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            if (!Path.IsPathRooted(full) || !Directory.Exists(full)) { throw new InvalidOperationException("path_invalid"); }
            DriveInfo drive = new DriveInfo(Path.GetPathRoot(full));
            if (drive.DriveType != DriveType.Fixed) { throw new InvalidOperationException("path_invalid"); }
            string rootedPrefix = Path.GetPathRoot(full);
            string current = rootedPrefix;
            string suffix = full.Substring(rootedPrefix.Length).TrimStart(Path.DirectorySeparatorChar);
            if (suffix.Length > 0) {
                foreach (string part in suffix.Split(Path.DirectorySeparatorChar)) {
                    current = Path.Combine(current, part);
                    FileAttributes attributes = File.GetAttributes(current);
                    if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) { throw new InvalidOperationException("path_invalid"); }
                }
            }
            return full;
        }

        private static string EnsureDirectory(string parent, string name) {
            string path = Path.Combine(parent, name);
            if (!Directory.Exists(path)) { Directory.CreateDirectory(path); }
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) { throw new InvalidOperationException("path_invalid"); }
            return path;
        }

        private static string HashFile(string path) {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
        }

        private static string HashPinned(FileStream stream) {
            stream.Position = 0;
            using (SHA256 sha = SHA256.Create()) {
                string value = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                stream.Position = 0; return value;
            }
        }

        private static bool IsAllowedRestoreRow(string relative) {
            const string prefix = "profiles\\desktop\\";
            if (String.IsNullOrEmpty(relative) || !relative.StartsWith(prefix, StringComparison.Ordinal)) { return false; }
            string suffix = relative.Substring(prefix.Length);
            if (suffix == "package.json" || suffix == "pnpm-lock.yaml" || suffix == "cordis.patch.yml" ||
                suffix == "dsh.profile.yaml" || suffix == ".dsh-market-intelligence-receipt.json") { return true; }
            const string cachePrefix = ".dsh-market-cache\\dsh-market-intelligence-";
            const string cacheSuffix = ".tgz";
            if (!suffix.StartsWith(cachePrefix, StringComparison.Ordinal) || !suffix.EndsWith(cacheSuffix, StringComparison.Ordinal)) { return false; }
            Version version; string versionText = suffix.Substring(cachePrefix.Length, suffix.Length-cachePrefix.Length-cacheSuffix.Length);
            return Version.TryParse(versionText, out version) && version.ToString() == versionText && version.Build >= 0 && version.Revision < 0;
        }

        public static InstallerFileCopyView CopyFileIntoBackup(object capability, string sourceRoot, string sourceRelative, string backupRelative) {
            BackupCapabilityRecord record = RequireBackup(capability);
            if (record.State != CapabilityState.Building || record.RootHandle == null || !record.RootHandle.IsValid ||
                !record.RootHandle.IsDirectory || record.RootHandle.IsReparsePoint) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string source = ContainedFile(sourceRoot, sourceRelative, "backup_source_invalid");
            string destinationRelative = "files\\" + backupRelative;
            string destination = ContainedFile(record.BackupDirectory, destinationRelative, "backup_integrity_invalid");
            EnsureLockedBackupDirectory(record, Path.GetDirectoryName(destinationRelative));
            FileStream output = null;
            FileStream retained = null;
            LockedPath identityLock = null;
            bool created = false;
            try {
                using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan))
                using (SHA256 sha = SHA256.Create()) {
                    try { NativeFile.VerifyOrdinaryFile(input.SafeFileHandle, source); }
                    catch { throw new InvalidOperationException("backup_source_invalid"); }
                    output = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read | FileShare.Delete, 65536, FileOptions.WriteThrough);
                    created = true;
                    ByHandleFileInformation outputInformation;
                    try {
                        outputInformation = NativeFile.VerifyOrdinaryFile(output.SafeFileHandle, destination);
                        identityLock = NativeFile.OpenLocked(destination);
                        if (!identityLock.IsValid || identityLock.IsDirectory || identityLock.IsReparsePoint ||
                            identityLock.IdentityKey != NativeFile.Identity(outputInformation)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    }
                    catch { throw new InvalidOperationException("backup_integrity_invalid"); }
                    byte[] buffer = new byte[65536];
                    long length = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
                        output.Write(buffer, 0, read);
                        sha.TransformBlock(buffer, 0, read, null, 0);
                        length += read;
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    output.Flush(true);
                    string hash = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                    output.Dispose();
                    output = null;
                    string expectedIdentity = identityLock.IdentityKey;
                    identityLock.Dispose();
                    identityLock = null;
                    retained = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                    ByHandleFileInformation retainedInformation = NativeFile.VerifyOrdinaryFile(retained.SafeFileHandle, destination);
                    if (NativeFile.Identity(retainedInformation) != expectedIdentity) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    record.RetainedFiles.Add(retained);
                    record.RetainedFilesByRelativePath.Add(destinationRelative, retained);
                    if (!IsAllowedRestoreRow(backupRelative) || record.Rows.ContainsKey(backupRelative)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    record.Rows.Add(backupRelative, new BackupRowRecord(backupRelative, true, length, hash));
                    retained = null;
                    return new InstallerFileCopyView(length, hash);
                }
            }
            catch {
                if (output != null) { output.Dispose(); output = null; }
                if (retained != null) { retained.Dispose(); retained = null; }
                if (identityLock != null) { identityLock.Dispose(); identityLock = null; }
                if (created) { try { File.Delete(destination); } catch { } }
                throw;
            }
        }

        public static void DeclareAbsentBackupRow(object capability, string relativePath) {
            BackupCapabilityRecord record = RequireBackup(capability);
            if (record.State != CapabilityState.Building || !IsAllowedRestoreRow(relativePath) || record.Rows.ContainsKey(relativePath)) {
                throw new InvalidOperationException("backup_integrity_invalid");
            }
            record.Rows.Add(relativePath, new BackupRowRecord(relativePath, false, 0L, null));
        }

        public static void EnsureBackupFilesDirectory(object capability) {
            BackupCapabilityRecord record = RequireBackup(capability);
            if (record.State != CapabilityState.Building || record.RootHandle == null || !record.RootHandle.IsValid) {
                throw new InvalidOperationException("backup_integrity_invalid");
            }
            EnsureLockedBackupDirectory(record, "files");
        }

        private static List<LockedPath> LockTargetParents(string targetRoot, string relativeDirectory) {
            string root = FullDirectory(targetRoot);
            List<LockedPath> handles = new List<LockedPath>();
            LockedPath rootHandle = NativeFile.OpenLocked(root);
            if (!rootHandle.IsValid || !rootHandle.IsDirectory || rootHandle.IsReparsePoint) { rootHandle.Dispose(); throw new InvalidOperationException("backup_restore_target_invalid"); }
            handles.Add(rootHandle);
            string current = root;
            if (!String.IsNullOrEmpty(relativeDirectory)) {
                foreach (string part in relativeDirectory.Split('\\')) {
                    if (String.IsNullOrWhiteSpace(part) || part == "." || part == "..") { throw new InvalidOperationException("backup_restore_target_invalid"); }
                    current = Path.Combine(current, part);
                    if (!Directory.Exists(current) && !File.Exists(current)) { Directory.CreateDirectory(current); }
                    LockedPath child = NativeFile.OpenLocked(current);
                    if (!child.IsValid || !child.IsDirectory || child.IsReparsePoint) { child.Dispose(); throw new InvalidOperationException("backup_restore_target_invalid"); }
                    handles.Add(child);
                }
            }
            return handles;
        }

        public static InstallerFileCopyView RestoreBoundRow(object capability, string rowKey) {
            RestoreCapabilityRecord restore = RequireRestore(capability);
            BackupCapabilityRecord record = restore.Backup;
            if (restore.State != CapabilityState.Active || (record.State != CapabilityState.Active && record.State != CapabilityState.Attempted)) { throw new InvalidOperationException("backup_integrity_invalid"); }
            BackupRowRecord row;
            if (!record.Rows.TryGetValue(rowKey, out row) || !row.Existed) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string sourceRelative = "files\\" + row.RelativePath;
            FileStream source;
            if (!record.RetainedFilesByRelativePath.TryGetValue(sourceRelative, out source)) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string sourcePath = ContainedFile(record.BackupDirectory, sourceRelative, "backup_integrity_invalid");
            try { NativeFile.VerifyOrdinaryFile(source.SafeFileHandle, sourcePath); }
            catch { throw new InvalidOperationException("backup_integrity_invalid"); }
            string targetRelative = row.RelativePath.Substring("profiles\\desktop\\".Length);
            string target = ContainedFile(restore.ProfileRoot, targetRelative, "backup_restore_target_invalid");
            List<LockedPath> parents = null;
            try {
                parents = LockTargetParents(restore.ProfileRoot, Path.GetDirectoryName(targetRelative));
                using (FileStream output = new FileStream(target, File.Exists(target) ? FileMode.Open : FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, FileOptions.WriteThrough))
                using (SHA256 sha = SHA256.Create()) {
                    try { NativeFile.VerifyOrdinaryFile(output.SafeFileHandle, target); }
                    catch { throw new InvalidOperationException("backup_restore_target_invalid"); }
                    source.Position = 0;
                    output.SetLength(0);
                    byte[] buffer = new byte[65536];
                    long length = 0;
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0) {
                        output.Write(buffer, 0, read);
                        sha.TransformBlock(buffer, 0, read, null, 0);
                        length += read;
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    output.Flush(true);
                    return new InstallerFileCopyView(length, BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant());
                }
            }
            finally {
                if (parents != null) { foreach (LockedPath parent in parents) { parent.Dispose(); } }
            }
        }

        public static void RemoveRestoreTarget(object capability, string rowKey) {
            RestoreCapabilityRecord restore = RequireRestore(capability);
            BackupRowRecord row;
            if (restore.State != CapabilityState.Active || !restore.Backup.Rows.TryGetValue(rowKey, out row) || row.Existed) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string targetRelative = row.RelativePath.Substring("profiles\\desktop\\".Length);
            string target = ContainedFile(restore.ProfileRoot, targetRelative, "backup_restore_target_invalid");
            List<LockedPath> parents = null;
            LockedPath targetHandle = null;
            try {
                parents = LockTargetParents(restore.ProfileRoot, Path.GetDirectoryName(targetRelative));
                if (!File.Exists(target) && !Directory.Exists(target)) { return; }
                targetHandle = NativeFile.OpenLocked(target);
                if (!targetHandle.IsValid || targetHandle.IsDirectory || targetHandle.IsReparsePoint ||
                    targetHandle.NumberOfLinks != 1U ||
                    !String.Equals(Path.GetFullPath(target), Path.GetFullPath(targetHandle.FinalPath), StringComparison.OrdinalIgnoreCase)) {
                    throw new InvalidOperationException("backup_restore_target_invalid");
                }
                targetHandle.SetDeleteDisposition(true);
            }
            catch (InvalidOperationException) { throw; }
            catch { throw new InvalidOperationException("backup_restore_target_invalid"); }
            finally {
                if (targetHandle != null) { targetHandle.Dispose(); }
                if (parents != null) { foreach (LockedPath parent in parents) { parent.Dispose(); } }
            }
        }

        private static void ValidateBackupRoot(string root) {
            string[] entries = Directory.GetFileSystemEntries(root);
            if (entries.Length != 3) { throw new InvalidOperationException("backup_integrity_invalid"); }
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string entry in entries) {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) { throw new InvalidOperationException("backup_integrity_invalid"); }
                names.Add(Path.GetFileName(entry));
            }
            if (names.Count != 3 || !names.Contains("backup-manifest.json") || !names.Contains("backup-directories.json") || !names.Contains("files")) {
                throw new InvalidOperationException("backup_integrity_invalid");
            }
        }

        private static string ContainedFile(string root, string relative, string error) {
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf('/') >= 0) { throw new InvalidOperationException(error); }
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            string full = Path.GetFullPath(Path.Combine(fullRoot, relative));
            if (!full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) { throw new InvalidOperationException(error); }
            return full;
        }

        private static string EnsureLockedBackupDirectory(BackupCapabilityRecord record, string relativeDirectory) {
            string currentPath = record.BackupDirectory;
            string currentRelative = "";
            foreach (string part in relativeDirectory.Split('\\')) {
                if (String.IsNullOrWhiteSpace(part) || part == "." || part == "..") { throw new InvalidOperationException("backup_integrity_invalid"); }
                currentRelative = currentRelative.Length == 0 ? part : currentRelative + "\\" + part;
                currentPath = Path.Combine(currentPath, part);
                LockedPath retained;
                if (record.RetainedDirectories.TryGetValue(currentRelative, out retained)) {
                    if (!retained.IsValid || !retained.IsDirectory || retained.IsReparsePoint) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    continue;
                }
                LockedPath opened = null;
                try {
                    if (!Directory.Exists(currentPath) && !File.Exists(currentPath)) { Directory.CreateDirectory(currentPath); }
                    opened = NativeFile.OpenLocked(currentPath);
                    if (!opened.IsValid || !opened.IsDirectory || opened.IsReparsePoint) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    record.RetainedDirectories.Add(currentRelative, opened);
                    opened = null;
                }
                finally { if (opened != null) { opened.Dispose(); } }
            }
            return currentPath;
        }

        private static List<TreeEntry> Snapshot(string root, string prefix, bool includePrefixDirectories) {
            string fullRoot = FullDirectory(root);
            List<TreeEntry> entries = new List<TreeEntry>();
            if (includePrefixDirectories && !String.IsNullOrEmpty(prefix)) {
                string current = "";
                foreach (string part in prefix.Split('\\')) {
                    current = current.Length == 0 ? part : current + "\\" + part;
                    entries.Add(new TreeEntry { RelativePath = current, IsDirectory = true });
                }
            }
            Stack<string> pending = new Stack<string>();
            pending.Push(fullRoot);
            while (pending.Count > 0) {
                string directory = pending.Pop();
                foreach (string child in Directory.GetFileSystemEntries(directory)) {
                    FileAttributes attributes = File.GetAttributes(child);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) { throw new InvalidOperationException("tree_invalid"); }
                    string relative = child.Substring(fullRoot.Length + 1).Replace('/', '\\');
                    if (!String.IsNullOrEmpty(prefix)) { relative = prefix.TrimEnd('\\') + "\\" + relative; }
                    using (LockedPath identity = NativeFile.OpenIdentity(child)) {
                        if ((attributes & FileAttributes.Directory) != 0) {
                            entries.Add(new TreeEntry { RelativePath = relative, FullPath = child, Identity = identity.IdentityKey, IsDirectory = true, Attributes = identity.Attributes });
                            pending.Push(child);
                        }
                        else {
                            FileInfo file = new FileInfo(child);
                            entries.Add(new TreeEntry { RelativePath = relative, FullPath = child, Identity = identity.IdentityKey, IsDirectory = false, Length = file.Length, Hash = HashFile(child), Attributes = identity.Attributes });
                        }
                    }
                }
            }
            entries.Sort(delegate(TreeEntry left, TreeEntry right) { return StringComparer.Ordinal.Compare(left.RelativePath, right.RelativePath); });
            return entries;
        }

        private static string SnapshotDigest(List<TreeEntry> entries) {
            StringBuilder builder = new StringBuilder();
            foreach (TreeEntry entry in entries) {
                builder.Append(entry.IsDirectory ? "D" : "F").Append('\0').Append(entry.RelativePath);
                if (!entry.IsDirectory) { builder.Append('\0').Append(entry.Length).Append('\0').Append(entry.Hash); }
                builder.Append('\n');
            }
            using (SHA256 sha = SHA256.Create()) {
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(builder.ToString()))).Replace("-", "").ToLowerInvariant();
            }
        }

        private static TemporaryCapabilityRecord RequireTemporary(object capability) {
            lock (CapabilityRegistry.Gate) {
                TemporaryCapabilityRecord record;
                if (capability == null || !CapabilityRegistry.Temporaries.TryGetValue(capability, out record) ||
                    !Object.ReferenceEquals(record.OriginalWrapper.Target, capability)) { throw new InvalidOperationException("temporary_ownership_invalid"); }
                return record;
            }
        }

        private static BackupCapabilityRecord RequireBackup(object capability) {
            lock (CapabilityRegistry.Gate) {
                BackupCapabilityRecord record;
                if (capability == null || !CapabilityRegistry.Backups.TryGetValue(capability, out record) ||
                    !Object.ReferenceEquals(record.OriginalWrapper.Target, capability)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                return record;
            }
        }

        private static RestoreCapabilityRecord RequireRestore(object capability) {
            lock (CapabilityRegistry.Gate) {
                RestoreCapabilityRecord record;
                if (capability == null || !CapabilityRegistry.Restores.TryGetValue(capability, out record) ||
                    !Object.ReferenceEquals(record.OriginalWrapper.Target, capability)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                return record;
            }
        }

        private static OperationLogCapabilityRecord RequireOperationLog(object capability) {
            lock (CapabilityRegistry.Gate) {
                OperationLogCapabilityRecord record;
                if (capability == null || !CapabilityRegistry.OperationLogs.TryGetValue(capability, out record) ||
                    !Object.ReferenceEquals(record.OriginalWrapper.Target, capability)) { throw new InvalidOperationException("operation_log_invalid"); }
                return record;
            }
        }

        public static object CreateOperationLog(string temporaryRoot) {
            string root = FullDirectory(temporaryRoot);
            string operationId = "dsh-market-operation-" + Guid.NewGuid().ToString("D");
            LockedPath directoryHandle = null;
            FileStream stream = null;
            try {
                directoryHandle = NativeFile.CreateLockedDirectory(root, operationId);
                string directory = Path.Combine(root, operationId);
                string logPath = Path.Combine(directory, "installer.log");
                stream = new FileStream(logPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
                NativeFile.VerifyOrdinaryFile(stream.SafeFileHandle, logPath);
                PSObject capability = new PSObject();
                OperationLogCapabilityRecord record = new OperationLogCapabilityRecord(capability, directory, logPath, directoryHandle, stream);
                lock (CapabilityRegistry.Gate) { CapabilityRegistry.OperationLogs.Add(capability, record); }
                directoryHandle = null;
                stream = null;
                return capability;
            }
            catch {
                if (stream != null) { stream.Dispose(); }
                if (directoryHandle != null) { directoryHandle.Dispose(); }
                throw;
            }
        }

        public static InstallerOperationLogView GetOperationLogView(object capability) {
            return new InstallerOperationLogView(RequireOperationLog(capability));
        }

        public static void AppendOperationLog(object capability, string json) {
            OperationLogCapabilityRecord record = RequireOperationLog(capability);
            if (record.State != CapabilityState.Active || record.Stream == null || record.DirectoryHandle == null ||
                !record.DirectoryHandle.IsValid || !record.DirectoryHandle.IsDirectory || record.DirectoryHandle.IsReparsePoint) {
                throw new InvalidOperationException("operation_log_invalid");
            }
            NativeFile.VerifyOrdinaryFile(record.Stream.SafeFileHandle, record.LogPath);
            byte[] bytes = new UTF8Encoding(false).GetBytes(json + Environment.NewLine);
            record.Stream.Write(bytes, 0, bytes.Length);
            record.Stream.Flush(false);
        }

        public static InstallerOperationLogView CompleteOperationLog(object capability) {
            OperationLogCapabilityRecord record = RequireOperationLog(capability);
            Exception failure = null;
            try {
                if (record.State != CapabilityState.Active || record.Stream == null || record.DirectoryHandle == null ||
                    !record.DirectoryHandle.IsValid || !record.DirectoryHandle.IsDirectory || record.DirectoryHandle.IsReparsePoint) {
                    throw new InvalidOperationException("operation_log_invalid");
                }
                NativeFile.VerifyOrdinaryFile(record.Stream.SafeFileHandle, record.LogPath);
                record.Stream.Flush(true);
                record.State = CapabilityState.Succeeded;
            }
            catch (Exception error) { record.State = CapabilityState.Failed; failure = error; }
            finally {
                if (record.Stream != null) { record.Stream.Dispose(); record.Stream = null; }
                if (record.DirectoryHandle != null) { record.DirectoryHandle.Dispose(); record.DirectoryHandle = null; }
            }
            if (failure != null) { throw failure; }
            return new InstallerOperationLogView(record);
        }

        public static object CreateTemporary(string parentPath) {
            string parent = FullDirectory(parentPath);
            string operationId = Guid.NewGuid().ToString("D");
            string token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            string path = null;
            string creationIdentity = null;
            LockedPath rootHandle = null;
            try {
                rootHandle = NativeFile.CreateLockedDirectory(parent, operationId);
                path = Path.Combine(parent, operationId);
                creationIdentity = rootHandle.IdentityKey;
                File.WriteAllText(Path.Combine(path, ".dsh-market-installer-owned"), operationId + "\n" + token, new UTF8Encoding(false));
                PSObject capability = new PSObject();
                TemporaryCapabilityRecord record = new TemporaryCapabilityRecord(capability, parent, path, operationId, token, rootHandle.IdentityKey, rootHandle);
                lock (CapabilityRegistry.Gate) { CapabilityRegistry.Temporaries.Add(capability, record); }
                return capability;
            }
            catch {
                if (rootHandle != null) {
                    try {
                        if (!rootHandle.IsValid || !rootHandle.IsDirectory || rootHandle.IsReparsePoint ||
                            String.IsNullOrEmpty(path) || String.IsNullOrEmpty(creationIdentity) ||
                            rootHandle.IdentityKey != creationIdentity) { throw new InvalidOperationException("unproven"); }
                        using (LockedPath current = NativeFile.OpenIdentity(path)) {
                            if (!current.IsValid || !current.IsDirectory || current.IsReparsePoint ||
                                current.IdentityKey != creationIdentity) { throw new InvalidOperationException("unproven"); }
                        }
                        if (Directory.GetFileSystemEntries(path).Length != 0) { throw new InvalidOperationException("unproven"); }
                        rootHandle.SetDeleteDisposition(true);
                    }
                    catch { }
                    finally { rootHandle.Dispose(); rootHandle = null; }
                }
                throw;
            }
        }

        public static string GetTemporaryPath(object capability) { return RequireTemporary(capability).Path; }
        public static string GetTemporaryState(object capability) { return RequireTemporary(capability).State.ToString(); }

        public static bool CleanupTemporary(object capability, Action afterEnumeration, int failDispositionAt) {
            TemporaryCapabilityRecord record = RequireTemporary(capability);
            lock (CapabilityRegistry.Gate) {
                if (record.State == CapabilityState.Succeeded) { return true; }
                if (record.State == CapabilityState.Failed) { throw new InvalidOperationException("temporary_cleanup_failed"); }
                if (record.State != CapabilityState.Active) { throw new InvalidOperationException("temporary_ownership_invalid"); }
                record.State = CapabilityState.Attempted;
            }
            List<LockedPath> directories = new List<LockedPath>();
            List<LockedPath> files = new List<LockedPath>();
            List<LockedPath> armed = new List<LockedPath>();
            Dictionary<string, LockedPath> handlesByPath = new Dictionary<string, LockedPath>(StringComparer.Ordinal);
            bool committed = false;
            string beforeDigest = null;
            try {
                if (record.RootHandle == null || !record.RootHandle.IsValid || !record.RootHandle.IsDirectory || record.RootHandle.IsReparsePoint || record.RootHandle.IdentityKey != record.CreationIdentity) {
                    throw new InvalidOperationException("temporary_ownership_invalid");
                }
                using (LockedPath currentRoot = NativeFile.OpenIdentity(record.Path)) {
                    if (!currentRoot.IsDirectory || currentRoot.IsReparsePoint || currentRoot.IdentityKey != record.CreationIdentity) { throw new InvalidOperationException("temporary_identity_changed"); }
                }
                string markerPath = Path.Combine(record.Path, ".dsh-market-installer-owned");
                if (!File.Exists(markerPath) || File.ReadAllText(markerPath) != record.OperationId + "\n" + record.CleanupToken) { throw new InvalidOperationException("temporary_ownership_invalid"); }
                List<TreeEntry> snapshot = Snapshot(record.Path, "", false);
                beforeDigest = SnapshotDigest(snapshot);
                if (afterEnumeration != null) { afterEnumeration(); }
                foreach (TreeEntry entry in snapshot) {
                    LockedPath handle = NativeFile.OpenLocked(entry.FullPath);
                    if (!handle.IsValid || handle.IsReparsePoint || handle.IsDirectory != entry.IsDirectory || handle.IdentityKey != entry.Identity) { handle.Dispose(); throw new InvalidOperationException("temporary_identity_changed"); }
                    uint forbidden = (uint)FileAttributes.ReparsePoint | (uint)FileAttributes.ReadOnly | (uint)FileAttributes.System;
                    if ((handle.Attributes & forbidden) != 0) { handle.Dispose(); throw new InvalidOperationException("temporary_cleanup_failed"); }
                    handlesByPath.Add(entry.FullPath, handle);
                    if (entry.IsDirectory) { directories.Add(handle); }
                    else { files.Add(handle); }
                }
                if (SnapshotDigest(Snapshot(record.Path, "", false)) != beforeDigest) { throw new InvalidOperationException("temporary_identity_changed"); }
                files.Sort(delegate(LockedPath left, LockedPath right) {
                    bool leftMarker = left.IdentityKey == snapshot.Find(delegate(TreeEntry e) { return e.FullPath == markerPath; }).Identity;
                    bool rightMarker = right.IdentityKey == snapshot.Find(delegate(TreeEntry e) { return e.FullPath == markerPath; }).Identity;
                    if (leftMarker != rightMarker) { return leftMarker ? 1 : -1; }
                    return StringComparer.Ordinal.Compare(left.IdentityKey, right.IdentityKey);
                });
                int armIndex = 0;
                foreach (LockedPath file in files) {
                    armIndex++;
                    if (failDispositionAt > 0 && armIndex == failDispositionAt) { throw new InvalidOperationException("temporary_cleanup_failed"); }
                    file.SetDeleteDisposition(true);
                    armed.Add(file);
                }
                foreach (LockedPath file in files) { file.Dispose(); }
                files.Clear();
                armed.Clear();
                List<TreeEntry> directoryEntries = snapshot.FindAll(delegate(TreeEntry entry) { return entry.IsDirectory; });
                directoryEntries.Sort(delegate(TreeEntry left, TreeEntry right) {
                    int depth = right.FullPath.Length.CompareTo(left.FullPath.Length);
                    return depth != 0 ? depth : StringComparer.Ordinal.Compare(right.FullPath, left.FullPath);
                });
                foreach (TreeEntry entry in directoryEntries) {
                    LockedPath directory = handlesByPath[entry.FullPath];
                    directory.SetDeleteDisposition(true);
                    directory.Dispose();
                    directories.Remove(directory);
                }
                directories.Clear();
                record.RootHandle.SetDeleteDisposition(true);
                record.RootHandle.Dispose();
                record.RootHandle = null;
                committed = true;
                if (Directory.Exists(record.Path) || File.Exists(record.Path)) { throw new InvalidOperationException("temporary_cleanup_failed"); }
                lock (CapabilityRegistry.Gate) { record.State = CapabilityState.Succeeded; }
                return true;
            }
            catch {
                bool cancelFailed = false;
                foreach (LockedPath handle in armed) {
                    try { handle.SetDeleteDisposition(false); }
                    catch { cancelFailed = true; }
                }
                if (!committed && !cancelFailed && beforeDigest != null) {
                    foreach (LockedPath handle in files) { handle.Dispose(); }
                    foreach (LockedPath handle in directories) { handle.Dispose(); }
                    files.Clear(); directories.Clear(); armed.Clear();
                    try { if (SnapshotDigest(Snapshot(record.Path, "", false)) != beforeDigest) { cancelFailed = true; } }
                    catch { cancelFailed = true; }
                }
                if (cancelFailed) {
                    record.RetainedHandles = new List<LockedPath>();
                    record.RetainedHandles.AddRange(files);
                    record.RetainedHandles.AddRange(directories);
                    if (record.RootHandle != null) { record.RetainedHandles.Add(record.RootHandle); record.RootHandle = null; }
                    files.Clear(); directories.Clear(); armed.Clear();
                }
                lock (CapabilityRegistry.Gate) { record.State = CapabilityState.Failed; }
                throw;
            }
            finally {
                foreach (LockedPath handle in files) { handle.Dispose(); }
                foreach (LockedPath handle in directories) { handle.Dispose(); }
                if (!committed && record.RootHandle != null) { record.RootHandle.Dispose(); record.RootHandle = null; }
            }
        }

        public static object CreateBackup(string dshHome) {
            string home = FullDirectory(dshHome);
            string backups = EnsureDirectory(home, "backups");
            string managed = EnsureDirectory(backups, "dsh-market-intelligence");
            string operationId = Guid.NewGuid().ToString("D");
            LockedPath rootHandle = NativeFile.CreateLockedDirectory(managed, operationId);
            string backupDirectory = Path.Combine(managed, operationId);
            PSObject capability = new PSObject();
            BackupCapabilityRecord record = new BackupCapabilityRecord(capability, home, backupDirectory, operationId, rootHandle);
            lock (CapabilityRegistry.Gate) { CapabilityRegistry.Backups.Add(capability, record); }
            return capability;
        }

        public static InstallerBackupView GetBackupView(object capability) { return new InstallerBackupView(RequireBackup(capability)); }

        public static InstallerBackupView FinalizeBackup(object capability) {
            BackupCapabilityRecord record = RequireBackup(capability);
            if (record.State != CapabilityState.Building) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string manifest = Path.Combine(record.BackupDirectory, "backup-manifest.json");
            string directoryManifest = Path.Combine(record.BackupDirectory, "backup-directories.json");
            string filesRoot = Path.Combine(record.BackupDirectory, "files");
            if (!File.Exists(manifest) || !File.Exists(directoryManifest) || !Directory.Exists(filesRoot)) { throw new InvalidOperationException("backup_integrity_invalid"); }
            ValidateBackupRoot(record.BackupDirectory);
            try {
                record.ManifestStream = new FileStream(manifest, FileMode.Open, FileAccess.Read, FileShare.Read);
                NativeFile.VerifyOrdinaryFile(record.ManifestStream.SafeFileHandle, manifest);
                record.ManifestHash = HashPinned(record.ManifestStream);
                record.DirectoryManifestStream = new FileStream(directoryManifest, FileMode.Open, FileAccess.Read, FileShare.Read);
                NativeFile.VerifyOrdinaryFile(record.DirectoryManifestStream.SafeFileHandle, directoryManifest);
                record.DirectoryManifestHash = HashPinned(record.DirectoryManifestStream);
            }
            catch {
                if (record.ManifestStream != null) { record.ManifestStream.Dispose(); record.ManifestStream = null; }
                if (record.DirectoryManifestStream != null) { record.DirectoryManifestStream.Dispose(); record.DirectoryManifestStream = null; }
                throw new InvalidOperationException("backup_integrity_invalid");
            }
            List<TreeEntry> backupTree = Snapshot(filesRoot, "", false);
            string backupDigest = SnapshotDigest(backupTree);
            record.BackupTreeHash = backupDigest;
            record.State = CapabilityState.Active;
            return new InstallerBackupView(record);
        }

        public static InstallerBackupView ValidateBackup(object capability, string dshHome) {
            BackupCapabilityRecord record = RequireBackup(capability);
            if (record.State != CapabilityState.Active && record.State != CapabilityState.Attempted) { throw new InvalidOperationException("backup_integrity_invalid"); }
            if (!String.Equals(FullDirectory(dshHome), record.DshHome, StringComparison.Ordinal)) { throw new InvalidOperationException("backup_integrity_invalid"); }
            string manifest = Path.Combine(record.BackupDirectory, "backup-manifest.json");
            string directoryManifest = Path.Combine(record.BackupDirectory, "backup-directories.json");
            string filesRoot = Path.Combine(record.BackupDirectory, "files");
            ValidateBackupRoot(record.BackupDirectory);
            try { NativeFile.VerifyOrdinaryFile(record.ManifestStream.SafeFileHandle, manifest); NativeFile.VerifyOrdinaryFile(record.DirectoryManifestStream.SafeFileHandle, directoryManifest); }
            catch { throw new InvalidOperationException("backup_integrity_invalid"); }
            if (HashPinned(record.ManifestStream) != record.ManifestHash || HashPinned(record.DirectoryManifestStream) != record.DirectoryManifestHash ||
                SnapshotDigest(Snapshot(filesRoot, "", false)) != record.BackupTreeHash) { throw new InvalidOperationException("backup_integrity_invalid"); }
            return new InstallerBackupView(record);
        }

        public static object CreateRestoreCapability(object backupCapability) {
            BackupCapabilityRecord backup = RequireBackup(backupCapability);
            lock (CapabilityRegistry.Gate) {
                if (backup.State != CapabilityState.Active || backup.ManifestStream == null || backup.DirectoryManifestStream == null) {
                    throw new InvalidOperationException("backup_integrity_invalid");
                }
                if (backup.RestoreWrapper != null) {
                    RestoreCapabilityRecord existing = RequireRestore(backup.RestoreWrapper);
                    if (existing.State != CapabilityState.Active) { throw new InvalidOperationException("backup_integrity_invalid"); }
                    return backup.RestoreWrapper;
                }
                string manifest = Path.Combine(backup.BackupDirectory, "backup-manifest.json");
                string directoryManifest = Path.Combine(backup.BackupDirectory, "backup-directories.json");
                try {
                    ByHandleFileInformation manifestInfo = NativeFile.VerifyOrdinaryFile(backup.ManifestStream.SafeFileHandle, manifest);
                    ByHandleFileInformation directoryInfo = NativeFile.VerifyOrdinaryFile(backup.DirectoryManifestStream.SafeFileHandle, directoryManifest);
                    if (manifestInfo.NumberOfLinks != 1U || directoryInfo.NumberOfLinks != 1U ||
                        HashPinned(backup.ManifestStream) != backup.ManifestHash || HashPinned(backup.DirectoryManifestStream) != backup.DirectoryManifestHash) {
                        throw new InvalidOperationException("backup_integrity_invalid");
                    }
                    foreach (BackupRowRecord row in backup.Rows.Values) {
                        if (!IsAllowedRestoreRow(row.RelativePath)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                        if (row.Existed) {
                            FileStream payload; string key = "files\\" + row.RelativePath;
                            if (!backup.RetainedFilesByRelativePath.TryGetValue(key, out payload)) { throw new InvalidOperationException("backup_integrity_invalid"); }
                            string expected = ContainedFile(backup.BackupDirectory, key, "backup_integrity_invalid");
                            ByHandleFileInformation info = NativeFile.VerifyOrdinaryFile(payload.SafeFileHandle, expected);
                            if (info.NumberOfLinks != 1U || payload.Length != row.Length || HashPinned(payload) != row.Hash) { throw new InvalidOperationException("backup_integrity_invalid"); }
                        }
                    }
                    string profileRoot = FullDirectory(Path.Combine(backup.DshHome, "profiles", "desktop"));
                    PSObject wrapper = new PSObject(); RestoreCapabilityRecord record = new RestoreCapabilityRecord(wrapper, backup, profileRoot);
                    CapabilityRegistry.Restores.Add(wrapper, record); backup.RestoreWrapper = wrapper; return wrapper;
                }
                catch (InvalidOperationException) { throw; }
                catch { throw new InvalidOperationException("backup_integrity_invalid"); }
            }
        }

        public static InstallerRestoreRowView[] GetRestoreRows(object capability) {
            RestoreCapabilityRecord restore = RequireRestore(capability);
            if (restore.State != CapabilityState.Active) { throw new InvalidOperationException("backup_integrity_invalid"); }
            List<InstallerRestoreRowView> rows = new List<InstallerRestoreRowView>();
            foreach (BackupRowRecord row in restore.Backup.Rows.Values) { rows.Add(new InstallerRestoreRowView(row)); }
            rows.Sort(delegate(InstallerRestoreRowView left, InstallerRestoreRowView right) { return StringComparer.Ordinal.Compare(left.RelativePath, right.RelativePath); });
            return rows.ToArray();
        }

        public static void CompleteRestore(object capability, bool succeeded) {
            RestoreCapabilityRecord restore = RequireRestore(capability);
            lock (CapabilityRegistry.Gate) {
                if (restore.State == CapabilityState.Active) { restore.State = succeeded ? CapabilityState.Succeeded : CapabilityState.Failed; }
            }
        }

        public static void CompleteBackup(object capability, bool succeeded) {
            BackupCapabilityRecord record = RequireBackup(capability);
            lock (CapabilityRegistry.Gate) {
                if (record.RestoreWrapper != null) {
                    RestoreCapabilityRecord restore;
                    if (CapabilityRegistry.Restores.TryGetValue(record.RestoreWrapper, out restore) && restore.State == CapabilityState.Active) {
                        restore.State = succeeded ? CapabilityState.Succeeded : CapabilityState.Failed;
                    }
                }
                if (record.State == CapabilityState.Active || record.State == CapabilityState.Attempted) { record.State = succeeded ? CapabilityState.Succeeded : CapabilityState.Failed; }
                foreach (FileStream stream in record.RetainedFiles) { stream.Dispose(); }
                record.RetainedFiles.Clear();
                record.RetainedFilesByRelativePath.Clear();
                if (record.ManifestStream != null) { record.ManifestStream.Dispose(); record.ManifestStream = null; }
                if (record.DirectoryManifestStream != null) { record.DirectoryManifestStream.Dispose(); record.DirectoryManifestStream = null; }
                foreach (LockedPath directory in record.RetainedDirectories.Values) { directory.Dispose(); }
                record.RetainedDirectories.Clear();
                if (record.RootHandle != null) { record.RootHandle.Dispose(); record.RootHandle = null; }
            }
        }
    }
}
'@
}

function Get-InstallerTemporaryPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$OwnedDirectory)
    try { return [DshMarketInstaller.InstallerCapabilities]::GetTemporaryPath($OwnedDirectory) }
    catch { throw 'temporary_ownership_invalid' }
}

function Test-InstallerTemporaryDirectoryActive {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$OwnedDirectory)
    try { return [string][DshMarketInstaller.InstallerCapabilities]::GetTemporaryState($OwnedDirectory) -ceq 'Active' }
    catch { return $false }
}

function Remove-InstallerTemporaryDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$OwnedDirectory,
        [scriptblock]$AfterEnumeration,
        [int]$FailDispositionAt = 0
    )
    $callback = $null
    if ($PSBoundParameters.ContainsKey('AfterEnumeration') -and $AfterEnumeration -ne $null) { $callback = [System.Action]$AfterEnumeration }
    try {
        return [DshMarketInstaller.InstallerCapabilities]::CleanupTemporary($OwnedDirectory, $callback, $FailDispositionAt)
    }
    catch {
        $message = if ($_.Exception.InnerException -ne $null) { [string]$_.Exception.InnerException.Message } else { [string]$_.Exception.Message }
        if ($message -ceq 'tree_invalid') { throw 'temporary_reparse_rejected' }
        if ($message -ceq 'temporary_ownership_invalid' -or $message -ceq 'temporary_identity_changed' -or $message -ceq 'temporary_reparse_rejected') { throw $message }
        throw 'temporary_cleanup_failed'
    }
}

function Test-ReleasePackage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TarPath,
        [Parameter(Mandatory = $true)][string]$RequestedVersion
    )

    $tarCommandPath = Resolve-SystemTarCommand
    $listArguments = @('-tf', $TarPath)
    $entries = @(& $tarCommandPath @listArguments 2>$null | ForEach-Object { ([string]$_).Replace('\', '/') })
    if ($LASTEXITCODE -ne 0) { throw 'package_archive_invalid' }
    $verboseArguments = @('-tvf', $TarPath)
    $verboseEntries = @(& $tarCommandPath @verboseArguments 2>$null | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0 -or $entries.Count -ne $verboseEntries.Count -or $entries.Count -eq 0) { throw 'package_archive_invalid' }
    $seen = @{}
    for ($index = 0; $index -lt $entries.Count; $index++) {
        $entry = [string]$entries[$index]
        if ([string]::IsNullOrWhiteSpace($entry) -or $entry.StartsWith('/') -or $entry -match '\A[A-Za-z]:' -or $entry.IndexOf(':') -ge 0 -or $entry -match '[\x00-\x1f]') { throw 'package_archive_invalid' }
        $trimmedEntry = $entry.TrimEnd('/')
        if ($trimmedEntry -cne 'package' -and -not $trimmedEntry.StartsWith('package/', [System.StringComparison]::Ordinal)) { throw 'package_archive_invalid' }
        foreach ($part in @($trimmedEntry.Split('/'))) {
            if (-not (Test-WindowsSafePathComponent -Component $part)) { throw 'package_archive_invalid' }
        }
        if ($seen.ContainsKey($trimmedEntry)) { throw 'package_archive_invalid' }
        $seen[$trimmedEntry] = $true
        $type = if ([string]::IsNullOrEmpty([string]$verboseEntries[$index])) { '' } else { [string]$verboseEntries[$index].Substring(0, 1) }
        if (@('-', 'd') -cnotcontains $type -or [string]$verboseEntries[$index] -match '(?:\s->\s|\slink to\s)') { throw 'package_archive_invalid' }
        if ($entry.EndsWith('/') -and $type -cne 'd') { throw 'package_archive_invalid' }
        if (-not $entry.EndsWith('/') -and $type -cne '-') { throw 'package_archive_invalid' }
    }
    foreach ($required in @('package/package.json', 'package/lib/index.js', 'package/cordis.patch.yml', 'package/LICENSE')) {
        if (@($entries | Where-Object { $_ -ceq $required }).Count -ne 1) { throw 'package_metadata_invalid' }
    }
    try { $metadata = (Read-TarEntry -TarPath $TarPath -ArchivePath 'package/package.json' -TarCommand $tarCommandPath) | ConvertFrom-Json }
    catch { throw 'package_metadata_invalid' }
    if ([string]$metadata.name -cne 'dsh-market-intelligence' -or
        [string]$metadata.version -cne $RequestedVersion -or
        [string]$metadata.main -cne './lib/index.js' -or
        [string]$metadata.dsh.bundle.patch -cne './cordis.patch.yml' -or
        [string]$metadata.license -cne 'SEE LICENSE IN LICENSE') {
        throw 'package_metadata_invalid'
    }
    $inspectionRoot = Join-Path ([System.IO.Path]::GetDirectoryName($TarPath)) 'package-inspection'
    if (Test-Path -LiteralPath $inspectionRoot) { throw 'package_archive_invalid' }
    [System.IO.Directory]::CreateDirectory($inspectionRoot) | Out-Null
    $extractArguments = @('-xf', $TarPath, '-C', $inspectionRoot)
    & $tarCommandPath @extractArguments 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'package_archive_invalid' }
    $packageRoot = Join-Path $inspectionRoot 'package'
    try { $packageSnapshot = Get-OrdinaryTreeSnapshot -Root $packageRoot -ReparseErrorCategory 'package_archive_invalid' }
    catch { throw 'package_archive_invalid' }
    $mainPath = Join-Path $packageRoot 'lib\index.js'
    if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf) -or (Get-Item -LiteralPath $mainPath).Length -le 0) { throw 'package_main_invalid' }
    $licensePath = Join-Path $packageRoot 'LICENSE'
    if ([string](Get-InstallerFileHash -LiteralPath $licensePath) -cne 'a769e020054c88d9817f03dffa617d03e5ff27a67ab1281299a133a9773d1b78') { throw 'package_license_invalid' }
    $patchPath = Join-Path $packageRoot 'cordis.patch.yml'
    if ([string](Get-InstallerFileHash -LiteralPath $patchPath) -cne 'd63c41b29867b90a808e09830b045604073a77eead3d75c2321626cec6418962') { throw 'package_patch_invalid' }
    return [pscustomobject]@{ PackageDirectories = @($packageSnapshot.Directories); PackageManifest = @($packageSnapshot.Files) }
}

function Invoke-ManagedDsh {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshCommand,
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Rollback
    )

    $hadDshHome = Test-Path Env:DSH_HOME
    $previousDshHome = [string]$env:DSH_HOME
    $hadRollback = Test-Path Env:DSH_INSTALLER_ROLLBACK
    $previousRollback = [string]$env:DSH_INSTALLER_ROLLBACK
    $previousLastExitCode = $global:LASTEXITCODE
    try {
        $env:DSH_HOME = $DshHome
        if ($Rollback) { $env:DSH_INSTALLER_ROLLBACK = '1' } else { Remove-Item Env:DSH_INSTALLER_ROLLBACK -ErrorAction SilentlyContinue }
        $global:LASTEXITCODE = 0
        try { $output = @(& $DshCommand @Arguments 2>&1) }
        catch { throw 'managed_cli_failed' }
        if ($LASTEXITCODE -ne 0) { throw 'managed_cli_failed' }
        return @($output | ForEach-Object { [string]$_ })
    }
    finally {
        if ($hadDshHome) { $env:DSH_HOME = $previousDshHome } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
        if ($hadRollback) { $env:DSH_INSTALLER_ROLLBACK = $previousRollback } else { Remove-Item Env:DSH_INSTALLER_ROLLBACK -ErrorAction SilentlyContinue }
        $global:LASTEXITCODE = $previousLastExitCode
    }
}

function Resolve-ContainedLiteralPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$ErrorCategory
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.IndexOf('/') -ge 0 -or $RelativePath.IndexOf(':') -ge 0) { throw $ErrorCategory }
    $parts = @($RelativePath.Split('\'))
    if ($parts.Count -eq 0) { throw $ErrorCategory }
    foreach ($part in $parts) {
        if (-not (Test-WindowsSafePathComponent -Component $part)) {
            throw $ErrorCategory
        }
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidate = $rootFull
    if (Test-Path -LiteralPath $candidate) {
        $rootItem = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ErrorCategory }
    }
    foreach ($part in $parts) {
        $candidate = [System.IO.Path]::Combine($candidate, $part)
        $full = [System.IO.Path]::GetFullPath($candidate)
        if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw $ErrorCategory }
        if (Test-Path -LiteralPath $full) {
            $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ErrorCategory }
        }
        $candidate = $full
    }
    return $candidate
}

function Test-WindowsSafePathComponent {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Component)
    if ([string]::IsNullOrWhiteSpace($Component) -or $Component -eq '.' -or $Component -eq '..' -or
        $Component.EndsWith('.') -or $Component.EndsWith(' ') -or $Component -match '[\x00-\x1f]') { return $false }
    $deviceBase = [string]$Component.Split('.')[0]
    $deviceBase = $deviceBase.TrimEnd([char[]]@(' ', '.'))
    if ($deviceBase -match '\A(?i:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])\z') { return $false }
    return $true
}

function Get-ValidatedDshDerivedPaths {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [object[]]$DriveRecords
    )
    $relativePaths = [ordered]@{
        ProfilesRoot = 'profiles'
        ProfileRoot = 'profiles\desktop'
        StoragesRoot = 'storages'
        StorageRoot = 'storages\dsh-market-intelligence'
        BackupsRoot = 'backups'
        BackupRoot = 'backups\dsh-market-intelligence'
    }
    $validated = [ordered]@{}
    foreach ($name in $relativePaths.Keys) {
        $candidate = Resolve-ContainedLiteralPath -Root $DshHome -RelativePath ([string]$relativePaths[$name]) -ErrorCategory 'derived_path_invalid'
        if ($PSBoundParameters.ContainsKey('DriveRecords')) { Test-LocalFixedPath -PathValue $candidate -DriveRecords $DriveRecords | Out-Null }
        else { Test-LocalFixedPath -PathValue $candidate | Out-Null }
        $validated[$name] = $candidate
    }
    return [pscustomobject]$validated
}

function Get-OrdinaryTreeManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$RelativePrefix = '',
        [Parameter(Mandatory = $true)][string]$ReparseErrorCategory
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($rootFull)
    $files = @()
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ReparseErrorCategory }
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ReparseErrorCategory }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
            elseif ($child -is [System.IO.FileInfo]) { $files += $child.FullName }
            else { throw $ReparseErrorCategory }
        }
    }
    $rows = @()
    foreach ($filePath in @($files | Sort-Object)) {
        $file = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        $relative = $file.FullName.Substring($rootFull.Length + 1)
        if (-not [string]::IsNullOrEmpty($RelativePrefix)) { $relative = $RelativePrefix.TrimEnd('\') + '\' + $relative }
        $rows += [ordered]@{
            relativePath = $relative
            existed = $true
            length = [int64]$file.Length
            sha256 = Get-InstallerFileHash -LiteralPath $file.FullName
        }
    }
    return @($rows)
}

function Get-OrdinaryTreeSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$RelativePrefix = '',
        [Parameter(Mandatory = $true)][string]$ReparseErrorCategory
    )
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return [pscustomobject]@{ Directories = @(); Files = @() }
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($rootFull)
    $directoryPaths = @()
    $filePaths = @()
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ReparseErrorCategory }
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ReparseErrorCategory }
            if ($child.PSIsContainer) {
                $directoryPaths += $child.FullName
                $pending.Push($child.FullName)
            }
            elseif ($child -is [System.IO.FileInfo]) { $filePaths += $child.FullName }
            else { throw $ReparseErrorCategory }
        }
    }
    $directories = @()
    foreach ($directoryPath in @($directoryPaths | Sort-Object)) {
        $relative = $directoryPath.Substring($rootFull.Length + 1)
        if (-not [string]::IsNullOrEmpty($RelativePrefix)) { $relative = $RelativePrefix.TrimEnd('\') + '\' + $relative }
        $directories += $relative
    }
    $files = @()
    foreach ($filePath in @($filePaths | Sort-Object)) {
        $file = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        $relative = $file.FullName.Substring($rootFull.Length + 1)
        if (-not [string]::IsNullOrEmpty($RelativePrefix)) { $relative = $RelativePrefix.TrimEnd('\') + '\' + $relative }
        $files += [ordered]@{ relativePath = $relative; existed = $true; length = [int64]$file.Length; sha256 = Get-InstallerFileHash -LiteralPath $file.FullName }
    }
    return [pscustomobject]@{ Directories = @($directories); Files = @($files) }
}

function Test-StringSetsEqual {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Left,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Right
    )
    $leftRows = @($Left | Sort-Object)
    $rightRows = @($Right | Sort-Object)
    if ($leftRows.Count -ne $rightRows.Count) { return $false }
    for ($index = 0; $index -lt $leftRows.Count; $index++) {
        if ([string]$leftRows[$index] -cne [string]$rightRows[$index]) { return $false }
    }
    return $true
}

function Test-ManifestRowsEqual {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Left,
        [Parameter(Mandatory = $true)][object[]]$Right
    )
    $leftRows = @($Left | Sort-Object { [string]$_.relativePath })
    $rightRows = @($Right | Sort-Object { [string]$_.relativePath })
    if ($leftRows.Count -ne $rightRows.Count) { return $false }
    for ($index = 0; $index -lt $leftRows.Count; $index++) {
        if ([string]$leftRows[$index].relativePath -cne [string]$rightRows[$index].relativePath -or
            [bool]$leftRows[$index].existed -ne [bool]$rightRows[$index].existed -or
            [int64]$leftRows[$index].length -ne [int64]$rightRows[$index].length -or
            [string]$leftRows[$index].sha256 -cne [string]$rightRows[$index].sha256) { return $false }
    }
    return $true
}

function Test-IsManagedProfileChange {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    if (@(
        'profiles\desktop\package.json',
        'profiles\desktop\pnpm-lock.yaml',
        'profiles\desktop\cordis.patch.yml',
        'profiles\desktop\.dsh-market-intelligence-receipt.json'
    ) -ccontains $RelativePath) { return $true }
    if ($RelativePath.StartsWith('profiles\desktop\node_modules\dsh-market-intelligence\', [System.StringComparison]::Ordinal)) { return $true }
    if ($RelativePath -cmatch '\Aprofiles\\desktop\\\.dsh-market-cache\\dsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z') { return $true }
    return $false
}

function Test-UnrelatedProfileManifestStable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Before,
        [Parameter(Mandatory = $true)][object[]]$After
    )
    $beforeRows = @{}
    foreach ($row in $Before) { $beforeRows[[string]$row.relativePath] = $row }
    $afterRows = @{}
    foreach ($row in $After) { $afterRows[[string]$row.relativePath] = $row }
    foreach ($relativePath in @($beforeRows.Keys + $afterRows.Keys | Sort-Object -Unique)) {
        if (Test-IsManagedProfileChange -RelativePath $relativePath) { continue }
        if (-not $beforeRows.ContainsKey($relativePath) -or -not $afterRows.ContainsKey($relativePath)) { return $false }
        $left = $beforeRows[$relativePath]
        $right = $afterRows[$relativePath]
        if ([int64]$left.length -ne [int64]$right.length -or [string]$left.sha256 -cne [string]$right.sha256) { return $false }
    }
    return $true
}

function Test-IsManagedProfileDirectoryChange {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    if (@('profiles\desktop\.dsh-market-cache', 'profiles\desktop\node_modules') -ccontains $RelativePath) { return $true }
    if ($RelativePath -ceq 'profiles\desktop\node_modules\dsh-market-intelligence' -or
        $RelativePath.StartsWith('profiles\desktop\node_modules\dsh-market-intelligence\', [System.StringComparison]::Ordinal)) { return $true }
    return $false
}

function Test-UnrelatedProfileDirectoriesStable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Before,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$After
    )
    $beforeRows = @{}
    foreach ($row in $Before) { $beforeRows[[string]$row] = $true }
    $afterRows = @{}
    foreach ($row in $After) { $afterRows[[string]$row] = $true }
    foreach ($relativePath in @($beforeRows.Keys + $afterRows.Keys | Sort-Object -Unique)) {
        if (Test-IsManagedProfileDirectoryChange -RelativePath ([string]$relativePath)) { continue }
        if (-not $beforeRows.ContainsKey($relativePath) -or -not $afterRows.ContainsKey($relativePath)) { return $false }
    }
    return $true
}

function Test-ProfilePackageInvariant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BeforePath,
        [Parameter(Mandatory = $true)][string]$AfterPath,
        [Parameter(Mandatory = $true)][bool]$ExpectedInstalled,
        [string]$ExpectedVersion
    )
    try {
        $before = Read-InstallerSharedText -LiteralPath $BeforePath | ConvertFrom-Json
        $after = Read-InstallerSharedText -LiteralPath $AfterPath | ConvertFrom-Json
    }
    catch { return $false }
    $beforeNames = @($before.PSObject.Properties.Name)
    $afterNames = @($after.PSObject.Properties.Name)
    $beforeNameText = @($beforeNames | Sort-Object) -join "`0"
    $afterNameText = @($afterNames | Sort-Object) -join "`0"
    if ($beforeNameText -cne $afterNameText) { return $false }
    foreach ($name in $beforeNames) {
        if (@('dependencies', 'bundles') -ccontains [string]$name) { continue }
        if (($before.$name | ConvertTo-Json -Depth 50 -Compress) -cne ($after.$name | ConvertTo-Json -Depth 50 -Compress)) { return $false }
    }
    $beforeDependencies = @{}
    foreach ($property in @($before.dependencies.PSObject.Properties)) {
        if ([string]$property.Name -cne 'dsh-market-intelligence') { $beforeDependencies[[string]$property.Name] = ($property.Value | ConvertTo-Json -Depth 20 -Compress) }
    }
    $afterDependencies = @{}
    foreach ($property in @($after.dependencies.PSObject.Properties)) {
        if ([string]$property.Name -cne 'dsh-market-intelligence') { $afterDependencies[[string]$property.Name] = ($property.Value | ConvertTo-Json -Depth 20 -Compress) }
    }
    if ($beforeDependencies.Count -ne $afterDependencies.Count) { return $false }
    foreach ($name in $beforeDependencies.Keys) {
        if (-not $afterDependencies.ContainsKey($name) -or [string]$beforeDependencies[$name] -cne [string]$afterDependencies[$name]) { return $false }
    }
    $managedDependency = $after.dependencies.PSObject.Properties['dsh-market-intelligence']
    if ($ExpectedInstalled) {
        if ($managedDependency -eq $null -or [string]$managedDependency.Value -cne $ExpectedVersion) { return $false }
    }
    elseif ($managedDependency -ne $null) { return $false }
    $beforeBundles = @($before.bundles | Where-Object { [string]$_ -cne 'dsh-market-intelligence' })
    $afterBundles = @($after.bundles | Where-Object { [string]$_ -cne 'dsh-market-intelligence' })
    if (($beforeBundles | ConvertTo-Json -Compress) -cne ($afterBundles | ConvertTo-Json -Compress)) { return $false }
    $managedBundleCount = @($after.bundles | Where-Object { [string]$_ -ceq 'dsh-market-intelligence' }).Count
    if (($ExpectedInstalled -and $managedBundleCount -ne 1) -or (-not $ExpectedInstalled -and $managedBundleCount -ne 0)) { return $false }
    return $true
}

function Get-InstalledPluginState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$DshHome)

    $semanticVersionPattern = '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
    $profileRoot = Join-Path $DshHome 'profiles\desktop'
    $profilePackagePath = Join-Path $profileRoot 'package.json'
    try { $profile = Get-Content -LiteralPath $profilePackagePath -Raw | ConvertFrom-Json }
    catch { throw 'profile_invalid' }
    $dependency = $profile.dependencies.PSObject.Properties['dsh-market-intelligence']
    $version = if ($dependency -eq $null) { $null } else { [string]$dependency.Value }
    if ($version -ne $null -and $version -notmatch $semanticVersionPattern) { throw 'profile_invalid' }
    $installed = $version -ne $null
    $bundleCount = @($profile.bundles | Where-Object { [string]$_ -ceq 'dsh-market-intelligence' }).Count
    $receiptPath = Join-Path $profileRoot '.dsh-market-intelligence-receipt.json'
    $receiptPresent = Test-Path -LiteralPath $receiptPath -PathType Leaf
    $cacheRelativePath = $null
    $cachePresent = $false
    if ($receiptPresent) {
        try { $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json }
        catch { throw 'profile_invalid' }
        if (@($receipt.PSObject.Properties.Name).Count -ne 2 -or $receipt.PSObject.Properties['version'] -eq $null -or $receipt.PSObject.Properties['cacheRelativePath'] -eq $null) { throw 'profile_invalid' }
        $receiptVersion = [string]$receipt.version
        $cacheRelativePath = [string]$receipt.cacheRelativePath
        if (-not $installed -or $receiptVersion -cne $version) { throw 'profile_invalid' }
        $expectedCacheRelativePath = '.dsh-market-cache\dsh-market-intelligence-' + $version + '.tgz'
        if ($cacheRelativePath -cne $expectedCacheRelativePath) { throw 'profile_invalid' }
        try { $cachePath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath $cacheRelativePath -ErrorCategory 'profile_reparse_rejected' }
        catch {
            if ($_.Exception.Message -ceq 'profile_reparse_rejected') { throw }
            throw 'profile_invalid'
        }
        $cachePresent = Test-Path -LiteralPath $cachePath -PathType Leaf
        if (-not $cachePresent) { throw 'profile_invalid' }
    }
    elseif ($installed) { throw 'profile_invalid' }
    $packageRoot = Join-Path $profileRoot 'node_modules\dsh-market-intelligence'
    $packagePresent = Test-Path -LiteralPath $packageRoot
    return [pscustomobject]@{
        BundleCount = $bundleCount
        CachePresent = $cachePresent
        CacheRelativePath = $cacheRelativePath
        Installed = $installed
        PackagePresent = $packagePresent
        ReceiptPresent = $receiptPresent
        Version = $version
    }
}

function Get-StorageFingerprint {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$StorageRoot)

    if (-not (Test-Path -LiteralPath $StorageRoot -PathType Container)) { return ('0' * 64) }
    $builder = New-Object System.Text.StringBuilder
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($StorageRoot)
    $directoryPaths = New-Object 'System.Collections.Generic.List[string]'
    $filePaths = New-Object 'System.Collections.Generic.List[string]'
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'storage_reparse_rejected' }
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'storage_reparse_rejected' }
            if ($child.PSIsContainer) { $directoryPaths.Add($child.FullName); $pending.Push($child.FullName) }
            elseif ($child -is [System.IO.FileInfo]) { $filePaths.Add($child.FullName) }
        }
    }
    foreach ($directoryPath in @($directoryPaths | Sort-Object)) {
        $relative = $directoryPath.Substring($StorageRoot.TrimEnd('\').Length + 1)
        [void]$builder.Append('D').Append("`0").Append($relative).Append("`n")
    }
    foreach ($filePath in @($filePaths | Sort-Object)) {
        $file = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        $relative = $file.FullName.Substring($StorageRoot.TrimEnd('\').Length + 1)
        [void]$builder.Append('F').Append("`0").Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-InstallerFileHash -LiteralPath $file.FullName)).Append("`n")
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
}

function New-ProfileBackup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][string]$RequestedVersion,
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$CliVersion,
        [object]$InstalledState,
        [object[]]$DriveRecords
    )

    try { Initialize-InstallerNativeFileApi }
    catch { throw 'backup_integrity_invalid' }
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $DshHome -DriveRecords $DriveRecords }
    else { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $DshHome }
    try {
        $capability = [DshMarketInstaller.InstallerCapabilities]::CreateBackup($DshHome)
        $view = [DshMarketInstaller.InstallerCapabilities]::GetBackupView($capability)
    }
    catch { throw 'backup_integrity_invalid' }
    $operationId = [string]$view.OperationId
    $backupDirectory = [string]$view.BackupDirectory
    $backupCompleted = $false
    try {
    $filesDirectory = Join-Path $backupDirectory 'files'
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { Test-LocalFixedPath -PathValue $filesDirectory -DriveRecords $DriveRecords | Out-Null }
    else { Test-LocalFixedPath -PathValue $filesDirectory | Out-Null }
    try { [DshMarketInstaller.InstallerCapabilities]::EnsureBackupFilesDirectory($capability) }
    catch { throw 'backup_integrity_invalid' }
    $profileRoot = $derivedPaths.ProfileRoot
    $allowlist = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($relativePath in @(
        'profiles\desktop\package.json',
        'profiles\desktop\pnpm-lock.yaml',
        'profiles\desktop\cordis.patch.yml',
        'profiles\desktop\dsh.profile.yaml',
        'profiles\desktop\.dsh-market-intelligence-receipt.json',
        ('profiles\desktop\.dsh-market-cache\dsh-market-intelligence-' + $RequestedVersion + '.tgz')
    )) { [void]$allowlist.Add($relativePath) }
    if ($InstalledState -ne $null -and [bool]$InstalledState.Installed -and
        -not [string]::IsNullOrWhiteSpace([string]$InstalledState.CacheRelativePath)) {
        $previousCache = 'profiles\desktop\' + [string]$InstalledState.CacheRelativePath
        if (-not (Test-BackupRelativePathValue -RelativePath $previousCache)) { throw 'backup_integrity_invalid' }
        [void]$allowlist.Add($previousCache)
    }
    $rows = @()
    foreach ($relativePath in @($allowlist | Sort-Object)) {
        $suffix = $relativePath.Substring('profiles\desktop\'.Length)
        $sourcePath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath $suffix -ErrorCategory 'profile_reparse_rejected'
        if (Test-Path -LiteralPath $sourcePath) {
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'profile_reparse_rejected' }
            try { $copy = [DshMarketInstaller.InstallerCapabilities]::CopyFileIntoBackup($capability, $profileRoot, $suffix, $relativePath) }
            catch {
                if ([string]$_.Exception.InnerException.Message -match 'backup_source_invalid') { throw 'backup_source_invalid' }
                throw 'backup_integrity_invalid'
            }
            $length = [int64]$copy.Length
            $hash = [string]$copy.Sha256
            $rows += [ordered]@{ relativePath = $relativePath; existed = $true; length = $length; sha256 = $hash }
        }
        else {
            try { [DshMarketInstaller.InstallerCapabilities]::DeclareAbsentBackupRow($capability, $relativePath) }
            catch { throw 'backup_integrity_invalid' }
            $rows += [ordered]@{ relativePath = $relativePath; existed = $false; length = [int64]0; sha256 = $null }
        }
    }
    $manifest = [ordered]@{
        operationId = $operationId
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        installerVersion = '0.1.0'
        requestedVersion = $RequestedVersion
        cliPath = $CliPath
        cliVersion = $CliVersion
        files = @($rows)
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $temporaryManifest = Join-Path $backupDirectory ('.backup-manifest-' + [guid]::NewGuid().ToString('D') + '.tmp')
    $manifestPath = Join-Path $backupDirectory 'backup-manifest.json'
    $manifestJson = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($temporaryManifest, $manifestJson, $encoding)
    [System.IO.File]::Move($temporaryManifest, $manifestPath)
    $backupSnapshot = Get-OrdinaryTreeSnapshot -Root $filesDirectory -ReparseErrorCategory 'backup_integrity_invalid'
    $backupDirectories = @($backupSnapshot.Directories | Where-Object { $_ -cnotin @('profiles', 'profiles\desktop') } | Sort-Object)
    $directoryManifest = [ordered]@{ operationId = $operationId; directories = $backupDirectories }
    $temporaryDirectoryManifest = Join-Path $backupDirectory ('.backup-directories-' + [guid]::NewGuid().ToString('D') + '.tmp')
    $directoryManifestPath = Join-Path $backupDirectory 'backup-directories.json'
    [System.IO.File]::WriteAllText($temporaryDirectoryManifest, ($directoryManifest | ConvertTo-Json -Depth 5), $encoding)
    [System.IO.File]::Move($temporaryDirectoryManifest, $directoryManifestPath)
    try { [DshMarketInstaller.InstallerCapabilities]::FinalizeBackup($capability) | Out-Null }
    catch {
        throw 'backup_integrity_invalid'
    }
    $backupCompleted = $true
    return $capability
    }
    finally {
        if (-not $backupCompleted) {
            try { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($capability, $false) }
            catch { }
        }
    }
}

function Get-ProfileBackupView {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][object]$BackupCapability
    )
    try { return [DshMarketInstaller.InstallerCapabilities]::ValidateBackup($BackupCapability, $DshHome) }
    catch { throw 'backup_integrity_invalid' }
}

function Test-BackupRelativePathValue {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $prefix = 'profiles\desktop\'
    if (-not $RelativePath.StartsWith($prefix, [System.StringComparison]::Ordinal) -or $RelativePath.IndexOf('/') -ge 0 -or $RelativePath.IndexOf(':') -ge 0) { return $false }
    $suffix = $RelativePath.Substring($prefix.Length)
    if (@('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'dsh.profile.yaml', '.dsh-market-intelligence-receipt.json') -ccontains $suffix) { return $true }
    return $suffix -cmatch '\A\.dsh-market-cache\\dsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z'
}

function Test-BackupDirectoryRelativePathValue {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    return $RelativePath -ceq 'profiles\desktop\.dsh-market-cache'
}

function Read-ProfileBackupManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$BackupDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedManifestHash
    )
    if ($ExpectedManifestHash -cnotmatch '\A[a-f0-9]{64}\z') { throw 'backup_integrity_invalid' }
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf) -or
        [string](Get-InstallerFileHash -LiteralPath $ManifestPath) -cne $ExpectedManifestHash) { throw 'backup_integrity_invalid' }
    try {
        $manifestJson = Read-InstallerSharedText -LiteralPath $ManifestPath
        $manifest = $manifestJson | ConvertFrom-Json
    }
    catch { throw 'backup_manifest_invalid' }
    $createdAtMatch = [regex]::Match($manifestJson, '"createdAt"\s*:\s*"(?<value>[^"\\]*)"')
    if (-not $createdAtMatch.Success -or @([regex]::Matches($manifestJson, '"createdAt"\s*:')).Count -ne 1) { throw 'backup_manifest_invalid' }
    $createdAtText = [string]$createdAtMatch.Groups['value'].Value
    $topNames = @($manifest.PSObject.Properties.Name)
    $expectedTopNames = @('operationId', 'createdAt', 'installerVersion', 'requestedVersion', 'cliPath', 'cliVersion', 'files')
    if ($topNames.Count -ne $expectedTopNames.Count) { throw 'backup_manifest_invalid' }
    for ($index = 0; $index -lt $expectedTopNames.Count; $index++) {
        if ([string]$topNames[$index] -cne $expectedTopNames[$index]) { throw 'backup_manifest_invalid' }
    }
    $operationId = [guid]::Empty
    $createdAt = [DateTimeOffset]::MinValue
    $semanticVersionPattern = '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
    $cliPath = [string]$manifest.cliPath
    try { $canonicalCliPath = [System.IO.Path]::GetFullPath($cliPath) }
    catch { throw 'backup_manifest_invalid' }
    if (-not [guid]::TryParseExact([string]$manifest.operationId, 'D', [ref]$operationId) -or
        [string]$manifest.operationId -cne [System.IO.Path]::GetFileName($BackupDirectory.TrimEnd('\')) -or
        -not [DateTimeOffset]::TryParseExact($createdAtText, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$createdAt) -or
        $createdAt.ToString('o') -cne $createdAtText -or
        [string]$manifest.installerVersion -cne '0.1.0' -or
        [string]$manifest.requestedVersion -notmatch $semanticVersionPattern -or
        $cliPath -notmatch '^[A-Za-z]:\\' -or $cliPath.Contains('/') -or $cliPath.StartsWith('\\') -or
        $canonicalCliPath -cne $cliPath -or [System.IO.Path]::GetExtension($cliPath) -notin @('.cmd', '.exe', '.ps1') -or
        [string]$manifest.cliVersion -notmatch $semanticVersionPattern) { throw 'backup_manifest_invalid' }
    $seen = @{}
    foreach ($row in @($manifest.files)) {
        if ($row -eq $null) { throw 'backup_manifest_invalid' }
        $rowNames = @($row.PSObject.Properties.Name)
        $expectedRowNames = @('relativePath', 'existed', 'length', 'sha256')
        if ($rowNames.Count -ne $expectedRowNames.Count) { throw 'backup_manifest_invalid' }
        for ($index = 0; $index -lt $expectedRowNames.Count; $index++) {
            if ([string]$rowNames[$index] -cne $expectedRowNames[$index]) { throw 'backup_manifest_invalid' }
        }
        $relativePath = [string]$row.relativePath
        if (-not (Test-BackupRelativePathValue -RelativePath $relativePath) -or $seen.ContainsKey($relativePath)) { throw 'backup_manifest_invalid' }
        $seen[$relativePath] = $true
        if ($row.existed -isnot [bool] -or
            -not ($row.length -is [int] -or $row.length -is [long]) -or [int64]$row.length -lt 0) { throw 'backup_manifest_invalid' }
        if ([bool]$row.existed) {
            if ([string]$row.sha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'backup_manifest_invalid' }
        }
        elseif ([int64]$row.length -ne 0 -or $row.sha256 -ne $null) { throw 'backup_manifest_invalid' }
    }
    return [pscustomobject]@{ CreatedAtText = $createdAtText; Manifest = $manifest }
}

function Read-ProfileBackupDirectoryManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHash,
        [Parameter(Mandatory = $true)][string]$ExpectedOperationId
    )
    if ($ExpectedHash -cnotmatch '\A[a-f0-9]{64}\z' -or -not (Test-Path -LiteralPath $LiteralPath -PathType Leaf) -or
        [string](Get-InstallerFileHash -LiteralPath $LiteralPath) -cne $ExpectedHash) { throw 'backup_integrity_invalid' }
    try { $artifact = (Read-InstallerSharedText -LiteralPath $LiteralPath) | ConvertFrom-Json }
    catch { throw 'backup_manifest_invalid' }
    $names = @($artifact.PSObject.Properties.Name)
    if ($names.Count -ne 2 -or [string]$names[0] -cne 'operationId' -or [string]$names[1] -cne 'directories' -or
        [string]$artifact.operationId -cne $ExpectedOperationId) { throw 'backup_manifest_invalid' }
    $seen = @{}
    $directories = @()
    $previous = $null
    foreach ($directory in @($artifact.directories)) {
        if ($directory -isnot [string]) { throw 'backup_manifest_invalid' }
        $relativePath = [string]$directory
        if (-not (Test-BackupDirectoryRelativePathValue -RelativePath $relativePath) -or $seen.ContainsKey($relativePath)) { throw 'backup_manifest_invalid' }
        if ($previous -ne $null -and [string]::CompareOrdinal([string]$previous, $relativePath) -ge 0) { throw 'backup_manifest_invalid' }
        $seen[$relativePath] = $true
        $directories += $relativePath
        $previous = $relativePath
    }
    return [pscustomobject]@{ Directories = @($directories) }
}

function Test-ProfileBackupPreflight {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [string]$BackupDirectory,
        [string]$ExpectedManifestHash,
        [string]$ExpectedDirectoryManifestHash,
        [string]$ExpectedOperationToken,
        [Parameter(Mandatory = $true)][object]$BackupCapability
    )

    try { $view = [DshMarketInstaller.InstallerCapabilities]::ValidateBackup($BackupCapability, $DshHome) }
    catch { throw 'backup_integrity_invalid' }
    $trustedHome = [System.IO.Path]::GetFullPath($DshHome)
    $trustedBackupDirectory = [string]$view.BackupDirectory
    $backupRoot = Resolve-ContainedLiteralPath -Root $trustedHome -RelativePath 'backups\dsh-market-intelligence' -ErrorCategory 'backup_integrity_invalid'
    $operationId = [string]$view.OperationId
    $parsedOperationId = [guid]::Empty
    if (-not [guid]::TryParseExact($operationId, 'D', [ref]$parsedOperationId)) { throw 'backup_integrity_invalid' }
    $expectedBackupDirectory = Resolve-ContainedLiteralPath -Root $backupRoot -RelativePath $operationId -ErrorCategory 'backup_integrity_invalid'
    if ($trustedBackupDirectory -cne $expectedBackupDirectory) { throw 'backup_integrity_invalid' }
    $manifestPath = Resolve-ContainedLiteralPath -Root $trustedBackupDirectory -RelativePath 'backup-manifest.json' -ErrorCategory 'backup_integrity_invalid'
    if ([string]$view.ManifestPath -cne $manifestPath) { throw 'backup_integrity_invalid' }
    $manifestRead = Read-ProfileBackupManifest -ManifestPath $manifestPath -BackupDirectory $trustedBackupDirectory -ExpectedManifestHash ([string]$view.ManifestHash)
    $manifest = $manifestRead.Manifest
    if ([string]$manifest.operationId -cne $operationId) { throw 'backup_integrity_invalid' }
    $directoryManifestPath = Resolve-ContainedLiteralPath -Root $trustedBackupDirectory -RelativePath 'backup-directories.json' -ErrorCategory 'backup_integrity_invalid'
    if ([string]$view.DirectoryManifestPath -cne $directoryManifestPath) { throw 'backup_integrity_invalid' }
    $directoryManifest = Read-ProfileBackupDirectoryManifest -LiteralPath $directoryManifestPath -ExpectedHash ([string]$view.DirectoryManifestHash) -ExpectedOperationId $operationId
    $profileRoot = Resolve-ContainedLiteralPath -Root $trustedHome -RelativePath 'profiles\desktop' -ErrorCategory 'profile_reparse_rejected'
    $filesRoot = Resolve-ContainedLiteralPath -Root $trustedBackupDirectory -RelativePath 'files' -ErrorCategory 'backup_integrity_invalid'
    try { $backupSnapshot = Get-OrdinaryTreeSnapshot -Root $filesRoot -ReparseErrorCategory 'backup_integrity_invalid' }
    catch { throw 'backup_integrity_invalid' }
    $expectedBackupDirectories = @('profiles', 'profiles\desktop') + @($directoryManifest.Directories)
    $existingManifestRows = @($manifest.files | Where-Object { [bool]$_.existed })
    if (-not (Test-ManifestRowsEqual -Left $existingManifestRows -Right @($backupSnapshot.Files)) -or
        -not (Test-StringSetsEqual -Left $expectedBackupDirectories -Right @($backupSnapshot.Directories))) { throw 'backup_integrity_invalid' }
    try {
        $restoreCapability = [DshMarketInstaller.InstallerCapabilities]::CreateRestoreCapability($BackupCapability)
        $boundRows = @([DshMarketInstaller.InstallerCapabilities]::GetRestoreRows($restoreCapability))
    }
    catch { throw 'backup_integrity_invalid' }
    if (-not (Test-ManifestRowsEqual -Left @($manifest.files) -Right $boundRows)) {
        try { [DshMarketInstaller.InstallerCapabilities]::CompleteRestore($restoreCapability, $false) } catch {}
        throw 'backup_integrity_invalid'
    }
    return [pscustomobject]@{
        DirectoryManifest = $directoryManifest
        FilesRoot = $filesRoot
        Manifest = $manifest
        ProfileRoot = $profileRoot
        RestoreCapability = $restoreCapability
    }
}

function Restore-ProfileBackup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$RestoreCapability,
        [switch]$DeferCapabilityCompletion
    )

    $restoreSucceeded = $false
    try {
        try { $rows = @([DshMarketInstaller.InstallerCapabilities]::GetRestoreRows($RestoreCapability)) }
        catch { throw 'backup_integrity_invalid' }
        $restoreFailed = $false
        $restoreTargetInvalid = $false
        foreach ($row in $rows) {
            $relativePath = [string]$row.relativePath
            try {
                if (-not [bool]$row.existed) {
                    try { [DshMarketInstaller.InstallerCapabilities]::RemoveRestoreTarget($RestoreCapability, $relativePath) }
                    catch {
                        if ([string]$_.Exception.InnerException.Message -match 'backup_restore_target_invalid') { throw 'backup_restore_target_invalid' }
                        throw
                    }
                    continue
                }
                try {
                    $copy = [DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow($RestoreCapability, $relativePath)
                    if ([int64]$copy.Length -ne [int64]$row.length -or [string]$copy.Sha256 -cne [string]$row.sha256) { throw 'backup_restore_verification_failed' }
                }
                catch {
                    if ([string]$_.Exception.InnerException.Message -match 'backup_restore_target_invalid') { throw 'backup_restore_target_invalid' }
                    throw
                }
            }
            catch {
                if ([string]$_.Exception.Message -eq 'backup_restore_target_invalid') { $restoreTargetInvalid = $true }
                $restoreFailed = $true
            }
        }
        if ($restoreTargetInvalid) { throw 'backup_restore_target_invalid' }
        if ($restoreFailed) { throw 'backup_restore_verification_failed' }
        $restoreSucceeded = $true
        return $true
    }
    finally {
        if (-not $DeferCapabilityCompletion) {
            [DshMarketInstaller.InstallerCapabilities]::CompleteRestore($RestoreCapability, $restoreSucceeded)
        }
    }
}

function Test-InstallPostconditions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][string]$DshCommand,
        [Parameter(Mandatory = $true)][string]$RequestedVersion,
        [Parameter(Mandatory = $true)][string]$StorageFingerprint,
        [Parameter(Mandatory = $true)][object[]]$BeforeProfileManifest,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$BeforeProfileDirectories,
        [Parameter(Mandatory = $true)][string]$BackupDirectory,
        [Parameter(Mandatory = $true)][object[]]$ExpectedPackageManifest,
        [Parameter(Mandatory = $true)][string[]]$ExpectedPackageDirectories,
        [Parameter(Mandatory = $true)][string]$ExpectedPackageHash
    )

    $state = Get-InstalledPluginState -DshHome $DshHome
    if (-not $state.Installed -or [string]$state.Version -cne $RequestedVersion -or $state.BundleCount -ne 1) { throw 'postcondition_profile_failed' }
    $packageRoot = Join-Path $DshHome 'profiles\desktop\node_modules\dsh-market-intelligence'
    foreach ($relative in @('package.json', 'lib\index.js', 'cordis.patch.yml', 'LICENSE')) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relative) -PathType Leaf)) { throw 'postcondition_package_failed' }
    }
    try { $metadata = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json }
    catch { throw 'postcondition_package_failed' }
    if ([string]$metadata.name -cne 'dsh-market-intelligence' -or [string]$metadata.version -cne $RequestedVersion -or
        [string]$metadata.main -cne './lib/index.js' -or [string]$metadata.dsh.bundle.patch -cne './cordis.patch.yml' -or
        [string]$metadata.license -cne 'SEE LICENSE IN LICENSE') { throw 'postcondition_package_failed' }
    try { $installedPackageSnapshot = Get-OrdinaryTreeSnapshot -Root $packageRoot -ReparseErrorCategory 'postcondition_package_failed' }
    catch { throw 'postcondition_package_failed' }
    if (-not (Test-ManifestRowsEqual -Left $ExpectedPackageManifest -Right @($installedPackageSnapshot.Files)) -or
        -not (Test-StringSetsEqual -Left $ExpectedPackageDirectories -Right @($installedPackageSnapshot.Directories))) { throw 'postcondition_package_failed' }
    $profileRoot = Join-Path $DshHome 'profiles\desktop'
    $cachePath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath ([string]$state.CacheRelativePath) -ErrorCategory 'postcondition_profile_failed'
    if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf) -or [string](Get-InstallerFileHash -LiteralPath $cachePath) -cne $ExpectedPackageHash) { throw 'postcondition_cache_failed' }
    $beforeProfilePackage = Join-Path (Join-Path $BackupDirectory 'files') 'profiles\desktop\package.json'
    $afterProfilePackage = Join-Path $profileRoot 'package.json'
    if (-not (Test-ProfilePackageInvariant -BeforePath $beforeProfilePackage -AfterPath $afterProfilePackage -ExpectedInstalled $true -ExpectedVersion $RequestedVersion)) {
        throw 'postcondition_profile_failed'
    }
    Invoke-ManagedDsh -DshCommand $DshCommand -DshHome $DshHome -Arguments @('plugin', '--profile', 'desktop', 'validate') | Out-Null
    $storageRoot = Join-Path $DshHome 'storages\dsh-market-intelligence'
    if (-not [string]::Equals((Get-StorageFingerprint -StorageRoot $storageRoot), $StorageFingerprint, [System.StringComparison]::Ordinal)) {
        throw 'postcondition_storage_failed'
    }
    return $true
}

function Test-SameVersionInstallIntegrity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][string]$RequestedVersion,
        [Parameter(Mandatory = $true)][object]$InstalledState,
        [Parameter(Mandatory = $true)][object[]]$ExpectedPackageManifest,
        [Parameter(Mandatory = $true)][string[]]$ExpectedPackageDirectories,
        [Parameter(Mandatory = $true)][string]$ExpectedPackageHash
    )
    try {
        if (-not $InstalledState.Installed -or [string]$InstalledState.Version -cne $RequestedVersion -or
            -not $InstalledState.ReceiptPresent -or -not $InstalledState.CachePresent -or -not $InstalledState.PackagePresent -or
            [int]$InstalledState.BundleCount -ne 1) { throw 'same_version_integrity_invalid' }
        $profileRoot = Resolve-ContainedLiteralPath -Root $DshHome -RelativePath 'profiles\desktop' -ErrorCategory 'same_version_integrity_invalid'
        $receiptPath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath '.dsh-market-intelligence-receipt.json' -ErrorCategory 'same_version_integrity_invalid'
        $expectedReceipt = [ordered]@{
            version = $RequestedVersion
            cacheRelativePath = '.dsh-market-cache\dsh-market-intelligence-' + $RequestedVersion + '.tgz'
        } | ConvertTo-Json -Compress
        if ([string](Get-InstallerFileHash -LiteralPath $receiptPath) -cne [string](Get-InstallerTextHash -Text $expectedReceipt)) { throw 'same_version_integrity_invalid' }
        $cachePath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath ([string]$InstalledState.CacheRelativePath) -ErrorCategory 'same_version_integrity_invalid'
        if ([string](Get-InstallerFileHash -LiteralPath $cachePath) -cne $ExpectedPackageHash) { throw 'same_version_integrity_invalid' }
        $packageRoot = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath 'node_modules\dsh-market-intelligence' -ErrorCategory 'same_version_integrity_invalid'
        $installedPackageSnapshot = Get-OrdinaryTreeSnapshot -Root $packageRoot -ReparseErrorCategory 'same_version_integrity_invalid'
        if (-not (Test-ManifestRowsEqual -Left $ExpectedPackageManifest -Right @($installedPackageSnapshot.Files)) -or
            -not (Test-StringSetsEqual -Left $ExpectedPackageDirectories -Right @($installedPackageSnapshot.Directories))) { throw 'same_version_integrity_invalid' }
    }
    catch { throw 'same_version_integrity_invalid' }
    return $true
}

function Invoke-InstallRollback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DshHome,
        [Parameter(Mandatory = $true)][string]$DshCommand,
        [Parameter(Mandatory = $true)][object]$Backup,
        [string]$ExpectedOperationToken,
        [Parameter(Mandatory = $true)][object]$PreviousState,
        [Parameter(Mandatory = $true)][string]$StorageFingerprint
    )

    $rollbackSucceeded = $false
    try {
        try {
            $view = [DshMarketInstaller.InstallerCapabilities]::ValidateBackup($Backup, $DshHome)
            $initialPreflight = Test-ProfileBackupPreflight -DshHome $DshHome -BackupCapability $Backup
        }
        catch { return $false }

        $cliRestored = $true
        try {
            if ([bool]$PreviousState.Installed) {
                if ([string]::IsNullOrWhiteSpace([string]$PreviousState.CacheRelativePath)) { throw 'rollback_source_missing' }
                $rollbackRelativePath = 'profiles\desktop\' + [string]$PreviousState.CacheRelativePath
                $rollbackPackage = Resolve-ContainedLiteralPath -Root (Join-Path ([string]$view.BackupDirectory) 'files') -RelativePath $rollbackRelativePath -ErrorCategory 'rollback_source_missing'
                if (-not (Test-Path -LiteralPath $rollbackPackage -PathType Leaf)) { throw 'rollback_source_missing' }
                Invoke-ManagedDsh -DshCommand $DshCommand -DshHome $DshHome -Arguments @('plugin', '--profile', 'desktop', 'add', $rollbackPackage) -Rollback | Out-Null
            }
            else {
                Invoke-ManagedDsh -DshCommand $DshCommand -DshHome $DshHome -Arguments @('plugin', '--profile', 'desktop', 'remove', 'dsh-market-intelligence') -Rollback | Out-Null
            }
        }
        catch { $cliRestored = $false }

        $filesRestored = $true
        try {
            Restore-ProfileBackup -RestoreCapability $initialPreflight.RestoreCapability -DeferCapabilityCompletion | Out-Null
        }
        catch { $filesRestored = $false }

        $verified = $true
        try {
            $state = Get-InstalledPluginState -DshHome $DshHome
            if ([bool]$PreviousState.Installed) {
                if (-not $state.Installed -or [string]$state.Version -cne [string]$PreviousState.Version -or $state.BundleCount -ne 1) {
                    throw 'rollback_profile_invalid'
                }
                Invoke-ManagedDsh -DshCommand $DshCommand -DshHome $DshHome -Arguments @('plugin', '--profile', 'desktop', 'validate') | Out-Null
            }
            else {
                $packageRoot = Join-Path $DshHome 'profiles\desktop\node_modules\dsh-market-intelligence'
                if ($state.Installed -or $state.BundleCount -ne 0 -or $state.ReceiptPresent -or $state.CachePresent -or (Test-Path -LiteralPath $packageRoot)) { throw 'rollback_profile_invalid' }
            }
            $storageRoot = Join-Path $DshHome 'storages\dsh-market-intelligence'
            if (-not [string]::Equals((Get-StorageFingerprint -StorageRoot $storageRoot), $StorageFingerprint, [System.StringComparison]::Ordinal)) {
                throw 'rollback_storage_invalid'
            }
        }
        catch { $verified = $false }
        $rollbackSucceeded = ($cliRestored -and $filesRestored -and $verified)
        return $rollbackSucceeded
    }
    finally {
        if ($initialPreflight -ne $null -and $initialPreflight.RestoreCapability -ne $null) {
            try { [DshMarketInstaller.InstallerCapabilities]::CompleteRestore($initialPreflight.RestoreCapability, $rollbackSucceeded) }
            catch {}
        }
        try { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($Backup, $rollbackSucceeded) }
        catch {}
    }
}

function Invoke-DshMarketUninstall {
    [CmdletBinding()]
    param(
        [string]$DshHome,
        [string]$DshCommand,
        [string]$Version,
        [switch]$AcceptLicense,
        [switch]$WhatIf,
        [object[]]$DriveRecords,
        [object[]]$ProcessRecords
    )

    if (-not $AcceptLicense) { throw 'license_not_accepted' }
    if ($PSBoundParameters.ContainsKey('DriveRecords')) {
        $resolvedHome = Resolve-DshHome -DshHome $DshHome -DriveRecords $DriveRecords
        $resolvedCommand = Resolve-DshCommand -DshCommand $DshCommand -DriveRecords $DriveRecords
    }
    else {
        $resolvedHome = Resolve-DshHome -DshHome $DshHome
        $resolvedCommand = Resolve-DshCommand -DshCommand $DshCommand
    }
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $resolvedHome -DriveRecords $DriveRecords }
    else { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $resolvedHome }
    $identity = @(Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('--version'))
    if ($identity.Count -ne 1 -or [string]$identity[0] -notmatch '\Adsh (?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\z') {
        throw 'managed_cli_identity_invalid'
    }
    $cliVersion = [string]$Matches['version']
    $capability = [string]::Join(' ', @(Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('plugin', '--help')))
    if ($capability -notmatch '(?:^|\s)add(?:\s|$)' -or $capability -notmatch '(?:^|\s)remove(?:\s|$)') { throw 'managed_cli_capability_invalid' }

    $installedState = Get-InstalledPluginState -DshHome $resolvedHome
    $storageRoot = $derivedPaths.StorageRoot
    $driveRoot = $resolvedHome.Substring(0, 3)
    if (-not $installedState.Installed) {
        $profileRoot = $derivedPaths.ProfileRoot
        $receiptPath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath '.dsh-market-intelligence-receipt.json' -ErrorCategory 'profile_reparse_rejected'
        $packageRoot = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath 'node_modules\dsh-market-intelligence' -ErrorCategory 'profile_reparse_rejected'
        $cacheRoot = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath '.dsh-market-cache' -ErrorCategory 'profile_reparse_rejected'
        $cacheResidual = @()
        if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
            $cacheResidual = @(Get-ChildItem -LiteralPath $cacheRoot -File -Force -ErrorAction Stop | Where-Object {
                $_.Name -cmatch '\Adsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z'
            })
        }
        if ($installedState.BundleCount -ne 0 -or $installedState.PackagePresent -or (Test-Path -LiteralPath $receiptPath) -or
            (Test-Path -LiteralPath $packageRoot) -or $cacheResidual.Count -ne 0) { throw 'uninstall_residual_detected' }
        Write-Output ('installer_event=already_uninstalled driveRoot=' + $driveRoot)
        return
    }
    if (-not [string]::IsNullOrWhiteSpace($Version) -and [string]$installedState.Version -cne $Version) { throw 'installed_version_mismatch' }
    if ($WhatIf) {
        Write-Output ('installer_event=plan_uninstall driveRoot=' + $driveRoot)
        return
    }
    if (-not $PSBoundParameters.ContainsKey('ProcessRecords')) { $ProcessRecords = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
    $ownedRoots = @($resolvedHome, [System.IO.Path]::GetDirectoryName($resolvedCommand))
    if (@($ProcessRecords).Count -gt 0 -and @(Select-OwnedDshProcess -ProcessRecords $ProcessRecords -OwnedRoots $ownedRoots).Count -gt 0) { throw 'process_running' }

    $storageFingerprint = Get-StorageFingerprint -StorageRoot $storageRoot
    $backupArguments = @{ DshHome = $resolvedHome; RequestedVersion = [string]$installedState.Version; CliPath = $resolvedCommand; CliVersion = $cliVersion; InstalledState = $installedState }
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { $backupArguments.DriveRecords = $DriveRecords }
    $backup = New-ProfileBackup @backupArguments
    $backupView = Get-ProfileBackupView -DshHome $resolvedHome -BackupCapability $backup
    Write-Output ('installer_backup=' + [string]$backupView.BackupDirectory)
    try { $backupPreflight = Test-ProfileBackupPreflight -DshHome $resolvedHome -BackupCapability $backup }
    catch {
        try { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $false) } catch {}
        throw
    }
    try {
        Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('plugin', '--profile', 'desktop', 'remove', 'dsh-market-intelligence') | Out-Null
        $state = Get-InstalledPluginState -DshHome $resolvedHome
        $profileRoot = $derivedPaths.ProfileRoot
        $packageRoot = Join-Path $resolvedHome 'profiles\desktop\node_modules\dsh-market-intelligence'
        $previousCachePath = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath ([string]$installedState.CacheRelativePath) -ErrorCategory 'uninstall_postcondition_failed'
        $cacheRoot = Resolve-ContainedLiteralPath -Root $profileRoot -RelativePath '.dsh-market-cache' -ErrorCategory 'uninstall_postcondition_failed'
        $cacheResidual = @()
        if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
            $cacheResidual = @(Get-ChildItem -LiteralPath $cacheRoot -File -Force -ErrorAction Stop | Where-Object {
                $_.Name -cmatch '\Adsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z'
            })
        }
        if ($state.Installed -or $state.BundleCount -ne 0 -or $state.ReceiptPresent -or $state.PackagePresent -or
            (Test-Path -LiteralPath $previousCachePath) -or $cacheResidual.Count -ne 0 -or (Test-Path -LiteralPath $packageRoot)) { throw 'uninstall_postcondition_failed' }
        $beforeProfilePackage = Join-Path (Join-Path $backupView.BackupDirectory 'files') 'profiles\desktop\package.json'
        if (-not (Test-ProfilePackageInvariant -BeforePath $beforeProfilePackage -AfterPath (Join-Path $profileRoot 'package.json') -ExpectedInstalled $false)) { throw 'uninstall_postcondition_failed' }
        if (-not [string]::Equals((Get-StorageFingerprint -StorageRoot $storageRoot), $storageFingerprint, [System.StringComparison]::Ordinal)) {
            throw 'postcondition_storage_failed'
        }
    }
    catch {
        $rollbackSucceeded = Invoke-InstallRollback -DshHome $resolvedHome -DshCommand $resolvedCommand -Backup $backup -PreviousState $installedState -StorageFingerprint $storageFingerprint
        if ($rollbackSucceeded) {
            throw 'uninstall_failed_rolled_back'
        }
        throw 'rollback_incomplete'
    }
    try { [DshMarketInstaller.InstallerCapabilities]::CompleteRestore($backupPreflight.RestoreCapability, $true) }
    finally { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $true) }
    Write-Output ('installer_event=storage_retained driveRoot=' + $driveRoot)
}

function Invoke-DshMarketInstallCore {
    [CmdletBinding()]
    param(
        [string]$DshHome,
        [string]$DshCommand,
        [string]$Version,
        [switch]$AllowDowngrade,
        [switch]$AcceptLicense,
        [switch]$WhatIf,
        [uri]$ReleaseApiUri,
        [string]$Operation = 'Install',
        [object[]]$DriveRecords,
        [object[]]$ProcessRecords
    )

    $semanticVersionPattern = '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
    if ($PSBoundParameters.ContainsKey('Version') -and $Version -notmatch $semanticVersionPattern) {
        throw 'Version must be a canonical three-component semantic version.'
    }
    if (@('Install', 'Uninstall') -cnotcontains $Operation) {
        throw 'Operation must be Install or Uninstall.'
    }

    if ($Operation -eq 'Uninstall') {
        $uninstallArguments = @{
            DshHome = $DshHome
            DshCommand = $DshCommand
            Version = $Version
            AcceptLicense = $AcceptLicense
            WhatIf = $WhatIf
        }
        if ($PSBoundParameters.ContainsKey('DriveRecords')) { $uninstallArguments.DriveRecords = $DriveRecords }
        if ($PSBoundParameters.ContainsKey('ProcessRecords')) { $uninstallArguments.ProcessRecords = $ProcessRecords }
        return Invoke-DshMarketUninstall @uninstallArguments
    }

    if ($PSBoundParameters.ContainsKey('DriveRecords')) {
        $resolvedHome = Resolve-DshHome -DshHome $DshHome -DriveRecords $DriveRecords
        $resolvedCommand = Resolve-DshCommand -DshCommand $DshCommand -DriveRecords $DriveRecords
    }
    else {
        $resolvedHome = Resolve-DshHome -DshHome $DshHome
        $resolvedCommand = Resolve-DshCommand -DshCommand $DshCommand
    }
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $resolvedHome -DriveRecords $DriveRecords }
    else { $derivedPaths = Get-ValidatedDshDerivedPaths -DshHome $resolvedHome }
    $identity = @(Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('--version'))
    if ($identity.Count -ne 1 -or [string]$identity[0] -notmatch '\Adsh (?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\z') {
        throw 'managed_cli_identity_invalid'
    }
    $cliVersion = [string]$Matches['version']
    $capability = [string]::Join(' ', @(Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('plugin', '--help')))
    if ($capability -notmatch '(?:^|\s)add(?:\s|$)' -or $capability -notmatch '(?:^|\s)remove(?:\s|$)') { throw 'managed_cli_capability_invalid' }
    $apiUri = if ($ReleaseApiUri -ne $null) { $ReleaseApiUri } else { [uri]'https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/latest' }
    $releasePlan = Get-ReleasePlan -ReleaseApiUri $apiUri -RequestedVersion $Version
    $Version = [string]$releasePlan.Version
    $installedState = Get-InstalledPluginState -DshHome $resolvedHome
    $versionComparison = $null
    if ($installedState.Installed) {
        $versionComparison = Compare-SemanticVersion -Left $Version -Right ([string]$installedState.Version)
        if ($versionComparison -lt 0 -and -not $AllowDowngrade) { throw 'downgrade_not_allowed' }
    }
    if ($WhatIf) {
        if (-not $installedState.Installed) { Write-Output 'plan_install' }
        elseif ($versionComparison -eq 0) { Write-Output 'plan_reinstall' }
        elseif ($versionComparison -lt 0) { Write-Output 'plan_downgrade' }
        else { Write-Output 'plan_upgrade' }
        return
    }
    if ($installedState.Installed) {
        if ($versionComparison -eq 0) {
            $sameVersionTemporaryRoot = [System.IO.Path]::GetTempPath()
            if ($PSBoundParameters.ContainsKey('DriveRecords')) { $sameVersionTemporaryDirectory = New-InstallerTemporaryDirectory -TemporaryRoot $sameVersionTemporaryRoot -DriveRecords $DriveRecords }
            else { $sameVersionTemporaryDirectory = New-InstallerTemporaryDirectory -TemporaryRoot $sameVersionTemporaryRoot }
            $sameVersionTemporaryPath = Get-InstallerTemporaryPath -OwnedDirectory $sameVersionTemporaryDirectory
            $sameVersionCleaned = $false
            try {
                $sameVersionPackagePath = Join-Path $sameVersionTemporaryPath $releasePlan.PackageName
                Save-ReleaseAsset -Uri $releasePlan.PackageUri -LiteralPath $sameVersionPackagePath -ReleaseApiUri $apiUri
                $sameVersionPackageHash = Get-InstallerFileHash -LiteralPath $sameVersionPackagePath
                if ([string]$sameVersionPackageHash -cne [string]$releasePlan.PackageHash) { throw 'package_hash_mismatch' }
                $sameVersionReleasePackage = Test-ReleasePackage -TarPath $sameVersionPackagePath -RequestedVersion $Version
                Test-SameVersionInstallIntegrity -DshHome $resolvedHome -RequestedVersion $Version -InstalledState $installedState -ExpectedPackageManifest @($sameVersionReleasePackage.PackageManifest) -ExpectedPackageDirectories @($sameVersionReleasePackage.PackageDirectories) -ExpectedPackageHash $sameVersionPackageHash | Out-Null
                Remove-InstallerTemporaryDirectory -OwnedDirectory $sameVersionTemporaryDirectory | Out-Null
                $sameVersionCleaned = $true
            }
            finally {
                if (-not $sameVersionCleaned -and (Test-InstallerTemporaryDirectoryActive -OwnedDirectory $sameVersionTemporaryDirectory) -and
                    (Test-Path -LiteralPath $sameVersionTemporaryPath)) {
                    Remove-InstallerTemporaryDirectory -OwnedDirectory $sameVersionTemporaryDirectory | Out-Null
                }
            }
            Write-Output 'already_installed'
            return
        }
    }

    if (-not $PSBoundParameters.ContainsKey('ProcessRecords')) { $ProcessRecords = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
    $ownedRoots = @($resolvedHome, [System.IO.Path]::GetDirectoryName($resolvedCommand))
    if (@($ProcessRecords).Count -gt 0 -and @(Select-OwnedDshProcess -ProcessRecords $ProcessRecords -OwnedRoots $ownedRoots).Count -gt 0) { throw 'process_running' }

    $temporaryRoot = [System.IO.Path]::GetTempPath()
    if ($PSBoundParameters.ContainsKey('DriveRecords')) { $ownedTemporaryDirectory = New-InstallerTemporaryDirectory -TemporaryRoot $temporaryRoot -DriveRecords $DriveRecords }
    else { $ownedTemporaryDirectory = New-InstallerTemporaryDirectory -TemporaryRoot $temporaryRoot }
    $temporaryDirectory = Get-InstallerTemporaryPath -OwnedDirectory $ownedTemporaryDirectory
    $temporaryCleaned = $false
    $failureLogged = $false
    try {
        $packagePath = Join-Path $temporaryDirectory $releasePlan.PackageName
        Save-ReleaseAsset -Uri $releasePlan.PackageUri -LiteralPath $packagePath -ReleaseApiUri $apiUri
        $actualHash = Get-InstallerFileHash -LiteralPath $packagePath
        if (-not [string]::Equals($actualHash, [string]$releasePlan.PackageHash, [System.StringComparison]::Ordinal)) { throw 'package_hash_mismatch' }
        $releasePackage = Test-ReleasePackage -TarPath $packagePath -RequestedVersion $Version
        $storageRoot = $derivedPaths.StorageRoot
        $storageFingerprint = Get-StorageFingerprint -StorageRoot $storageRoot
        $backupArguments = @{ DshHome = $resolvedHome; RequestedVersion = $Version; CliPath = $resolvedCommand; CliVersion = $cliVersion; InstalledState = $installedState }
        if ($PSBoundParameters.ContainsKey('DriveRecords')) { $backupArguments.DriveRecords = $DriveRecords }
        $backup = New-ProfileBackup @backupArguments
        $backupView = Get-ProfileBackupView -DshHome $resolvedHome -BackupCapability $backup
        Write-Output ('installer_backup=' + [string]$backupView.BackupDirectory)
        try { $backupPreflight = Test-ProfileBackupPreflight -DshHome $resolvedHome -BackupCapability $backup }
        catch {
            try { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $false) } catch {}
            throw
        }
        $mutationStarted = $false
        try {
            $mutationStarted = $true
            Invoke-ManagedDsh -DshCommand $resolvedCommand -DshHome $resolvedHome -Arguments @('plugin', '--profile', 'desktop', 'add', $packagePath) | Out-Null
            Test-InstallPostconditions -DshHome $resolvedHome -DshCommand $resolvedCommand -RequestedVersion $Version -StorageFingerprint $storageFingerprint -BeforeProfileManifest @($backupPreflight.Manifest.files) -BeforeProfileDirectories @($backupPreflight.DirectoryManifest.Directories) -BackupDirectory $backupView.BackupDirectory -ExpectedPackageManifest @($releasePackage.PackageManifest) -ExpectedPackageDirectories @($releasePackage.PackageDirectories) -ExpectedPackageHash $actualHash | Out-Null
            Remove-InstallerTemporaryDirectory -OwnedDirectory $ownedTemporaryDirectory | Out-Null
            $temporaryCleaned = $true
        }
        catch {
            if (-not $mutationStarted) { throw }
            $mutationFailure = [string]$_.Exception.Message
            $rollbackSucceeded = Invoke-InstallRollback -DshHome $resolvedHome -DshCommand $resolvedCommand -Backup $backup -PreviousState $installedState -StorageFingerprint $storageFingerprint
            if ($rollbackSucceeded) {
                $failureLogged = $true
                if ($mutationFailure -ceq 'temporary_cleanup_failed') { throw 'temporary_cleanup_failed_rolled_back' }
                throw 'installation_failed_rolled_back'
            }
            $failureLogged = $true
            throw 'rollback_incomplete'
        }
        try { [DshMarketInstaller.InstallerCapabilities]::CompleteRestore($backupPreflight.RestoreCapability, $true) }
        finally { [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $true) }
        Write-Output 'restart_required'
    }
    finally {
        if (-not $temporaryCleaned -and (Test-InstallerTemporaryDirectoryActive -OwnedDirectory $ownedTemporaryDirectory) -and
            (Test-Path -LiteralPath $temporaryDirectory)) {
            try {
                Remove-InstallerTemporaryDirectory -OwnedDirectory $ownedTemporaryDirectory | Out-Null
                $temporaryCleaned = $true
            }
            catch {
                if (-not $failureLogged) { throw 'temporary_cleanup_failed' }
            }
        }
    }
}

function Invoke-DshMarketInstall {
    [CmdletBinding()]
    param(
        [string]$DshHome,
        [string]$DshCommand,
        [string]$Version,
        [switch]$AllowDowngrade,
        [switch]$AcceptLicense,
        [switch]$WhatIf,
        [uri]$ReleaseApiUri,
        [string]$Operation = 'Install',
        [object[]]$DriveRecords,
        [object[]]$ProcessRecords
    )

    $operationLog = New-InstallerOperationLog
    $operationLogPath = [string][DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($operationLog).LogPath
    $resultCode = 1
    $resultCategory = 'internal'
    $rollbackResult = 'not-required'
    try {
        $semanticVersionPattern = '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z'
        if ($PSBoundParameters.ContainsKey('Version') -and $Version -notmatch $semanticVersionPattern) {
            throw 'Version must be a canonical three-component semantic version.'
        }
        if (@('Install', 'Uninstall') -cnotcontains $Operation) { throw 'Operation must be Install or Uninstall.' }
        Confirm-InstallerLicense -AcceptLicense:$AcceptLicense
        Write-InstallerLog -OperationLog $operationLog -EventName InstallerPhase -Data ([ordered]@{
            operation = $Operation; phase = 'discovery'; resultCode = 0; errorCategory = 'none'
        })
        $coreArguments = @{}
        foreach ($name in @('DshHome', 'DshCommand', 'Version', 'AllowDowngrade', 'WhatIf', 'ReleaseApiUri', 'Operation', 'DriveRecords', 'ProcessRecords')) {
            if ($PSBoundParameters.ContainsKey($name)) { $coreArguments[$name] = $PSBoundParameters[$name] }
        }
        $coreArguments['AcceptLicense'] = $true
        Invoke-DshMarketInstallCore @coreArguments
        $resultCode = 0
        $resultCategory = 'none'
    }
    catch {
        $message = [string]$_.Exception.Message
        $resultCategory = Get-PublicInstallerErrorCategory -Message $message
        if ($message -match 'rollback_incomplete') { $rollbackResult = 'incomplete' }
        elseif ($message -match 'rolled_back') { $rollbackResult = 'succeeded' }
        throw
    }
    finally {
        $logFailure = $null
        $resultData = [ordered]@{ phase = 'complete'; resultCode = $resultCode; rollbackResult = $rollbackResult; errorCategory = $resultCategory }
        if (@('Install', 'Uninstall') -ccontains $Operation) { $resultData['operation'] = $Operation }
        try { Write-InstallerLog -OperationLog $operationLog -EventName InstallerResult -Data $resultData }
        catch { $logFailure = $_ }
        try { [DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null }
        catch { if ($logFailure -eq $null) { $logFailure = $_ } }
        Write-Output ('installer_log=' + $operationLogPath)
        if ($logFailure -ne $null) { throw 'operation_log_write_failed' }
    }
}

function Get-PublicInstallerErrorCategory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    if ($Message -match '\A(?:Version must|Operation must|license_not_accepted|version_required|downgrade_not_allowed|installed_version_mismatch)') { return 'input' }
    if ($Message -match '(?:path|home|command|reparse|temporary_path|temporary_ownership)' -and $Message -notmatch '(?:package|backup)') { return 'path' }
    if ($Message -match '(?:managed_cli|cli_)') { return 'cli' }
    if ($Message -ceq 'process_running') { return 'process-running' }
    if ($Message -match '(?:release|manifest|hash|package_|tar_required|checksum|integrity)') { return 'integrity' }
    if ($Message -match '(?:profile|postcondition|uninstall_residual)') { return 'profile' }
    if ($Message -match 'temporary_cleanup') { return 'temporary-cleanup' }
    if ($Message -match '(?:rollback|rolled_back)') { return 'rollback' }
    return 'internal'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-DshMarketInstall @PSBoundParameters
    }
    catch {
        $publicCategory = Get-PublicInstallerErrorCategory -Message ([string]$_.Exception.Message)
        [Console]::Error.WriteLine('installer_failed errorCategory=' + $publicCategory)
        exit 1
    }
}
