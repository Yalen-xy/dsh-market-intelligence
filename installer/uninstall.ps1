[CmdletBinding()]
param(
    [string]$DshHome,
    [string]$DshCommand,
    [string]$Version,
    [switch]$AllowDowngrade,
    [switch]$AcceptLicense,
    [switch]$WhatIf,
    [uri]$ReleaseApiUri = 'https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/latest'
)

$ErrorActionPreference = 'Stop'
$delegatedToVerifiedInstaller = $false

function Initialize-UninstallerBootstrapLogApi {
    if ('DshMarketUninstallerLog.Capabilities' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Management.Automation;
using Microsoft.Win32.SafeHandles;

namespace DshMarketUninstallerLog {
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
        internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Access; internal System.Runtime.InteropServices.ComTypes.FILETIME Write;
        internal uint Volume; internal uint SizeHigh; internal uint SizeLow; internal uint Links; internal uint IndexHigh; internal uint IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Disposition { internal int DeleteFile; }
    internal sealed class Record {
        internal readonly WeakReference Wrapper; internal readonly string Directory; internal readonly string Path;
        internal SafeFileHandle DirectoryHandle; internal FileStream Stream; internal bool Active;
        internal Record(object wrapper, string directory, string path, SafeFileHandle directoryHandle, FileStream stream) {
            Wrapper = new WeakReference(wrapper); Directory = directory; Path = path; DirectoryHandle = directoryHandle; Stream = stream; Active = true;
        }
    }
    public sealed class View { public string LogPath { get; private set; } internal View(Record record) { LogPath = record.Path; } }
    public static class Capabilities {
        private static readonly object Gate = new object();
        private static readonly ConditionalWeakTable<object, Record> Records = new ConditionalWeakTable<object, Record>();
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, int size);
        private static string Final(SafeFileHandle handle) {
            StringBuilder value = new StringBuilder(32768); uint length = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, 0);
            if (length == 0 || length >= value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
            string path = value.ToString(); if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path.Substring(8);
            return path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? path.Substring(4) : path;
        }
        private static Info Verify(SafeFileHandle handle, string expected, bool directory) {
            Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            bool isDirectory = (info.Attributes & 0x10U) != 0; bool reparse = (info.Attributes & 0x400U) != 0;
            if (isDirectory != directory || reparse || (!directory && info.Links != 1U) ||
                !String.Equals(Path.GetFullPath(expected), Path.GetFullPath(Final(handle)), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("operation_log_invalid");
            return info;
        }
        private static SafeFileHandle OpenDirectory(string path) {
            SafeFileHandle handle = CreateFileW(path, 0x00010080U, 0x00000003U, IntPtr.Zero, 3U, 0x02200000U, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            Verify(handle, path, true); return handle;
        }
        private static FileStream CreateLogFile(string path) {
            SafeFileHandle handle = CreateFileW(path, 0x40010000U, 0x00000001U, IntPtr.Zero, 1U, 0x00000080U, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            return new FileStream(handle, FileAccess.Write, 4096, false);
        }
        private static Record Require(object capability) {
            lock (Gate) { Record record; if (capability == null || !Records.TryGetValue(capability, out record) ||
                !Object.ReferenceEquals(record.Wrapper.Target, capability)) throw new InvalidOperationException("operation_log_invalid"); return record; }
        }
        public static object Create(string temporaryRoot) {
            string root = Path.GetFullPath(temporaryRoot).TrimEnd(Path.DirectorySeparatorChar); SafeFileHandle rootHandle = OpenDirectory(root);
            SafeFileHandle directoryHandle = null; FileStream stream = null; string directory = null;
            try {
                string name = "dsh-market-operation-" + Guid.NewGuid().ToString("D"); directory = Path.Combine(root, name);
                Directory.CreateDirectory(directory); directoryHandle = OpenDirectory(directory);
                string path = Path.Combine(directory, "installer.log"); stream = CreateLogFile(path);
                Verify(stream.SafeFileHandle, path, false); PSObject wrapper = new PSObject(); Record record = new Record(wrapper, directory, path, directoryHandle, stream);
                lock (Gate) { Records.Add(wrapper, record); } directoryHandle = null; stream = null; return wrapper;
            } finally { rootHandle.Dispose(); if (stream != null) stream.Dispose(); if (directoryHandle != null) directoryHandle.Dispose(); }
        }
        public static View GetView(object capability) { return new View(Require(capability)); }
        public static View Complete(object capability, string json, bool keep) {
            Record record = Require(capability); if (!record.Active) throw new InvalidOperationException("operation_log_invalid"); record.Active = false;
            try {
                Verify(record.DirectoryHandle, record.Directory, true); Verify(record.Stream.SafeFileHandle, record.Path, false);
                if (keep) { byte[] bytes = new UTF8Encoding(false).GetBytes(json + Environment.NewLine); record.Stream.Write(bytes, 0, bytes.Length); record.Stream.Flush(true); }
                else {
                    Disposition fileDelete = new Disposition { DeleteFile = 1 };
                    if (!SetFileInformationByHandle(record.Stream.SafeFileHandle, 4, ref fileDelete, Marshal.SizeOf(typeof(Disposition)))) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return new View(record);
            } finally {
                record.Stream.Dispose(); record.Stream = null;
                if (!keep) { Disposition directoryDelete = new Disposition { DeleteFile = 1 }; if (!SetFileInformationByHandle(record.DirectoryHandle, 4, ref directoryDelete, Marshal.SizeOf(typeof(Disposition)))) { record.DirectoryHandle.Dispose(); record.DirectoryHandle = null; throw new Win32Exception(Marshal.GetLastWin32Error()); } }
                record.DirectoryHandle.Dispose(); record.DirectoryHandle = null;
            }
        }
    }
}
'@ | Out-Null
}

function New-UninstallerBootstrapLog {
    Initialize-UninstallerBootstrapLogApi
    return [DshMarketUninstallerLog.Capabilities]::Create([System.IO.Path]::GetTempPath())
}

function Complete-UninstallerBootstrapLog {
    param([Parameter(Mandatory=$true)][object]$Capability, [Parameter(Mandatory=$true)][string]$ErrorCategory, [switch]$Keep)
    if (@('input', 'integrity', 'internal') -cnotcontains $ErrorCategory) { $ErrorCategory = 'internal' }
    $entry = [ordered]@{ event='InstallerResult'; operation='Uninstall'; phase='complete'; resultCode=1; rollbackResult='not-required'; errorCategory=$ErrorCategory }
    return [DshMarketUninstallerLog.Capabilities]::Complete($Capability, ($entry | ConvertTo-Json -Compress), [bool]$Keep)
}

if ($MyInvocation.InvocationName -ne '.') {
$bootstrapLog = $null
$bootstrapLogPath = $null
try {
    $bootstrapLog = New-UninstallerBootstrapLog
    $bootstrapLogPath = [string][DshMarketUninstallerLog.Capabilities]::GetView($bootstrapLog).LogPath
}
catch {
    [Console]::Error.WriteLine('installer_failed errorCategory=internal operation_log_unavailable')
    exit 1
}

try {
$installerPath = Join-Path $PSScriptRoot 'install.ps1'
$manifestPath = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
$licensePath = Join-Path $PSScriptRoot 'LICENSE.txt'

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw 'The sibling install.ps1 could not be found.'
}

$releaseDirectory = Test-Path -LiteralPath $manifestPath -PathType Leaf
if (-not $releaseDirectory) {
    $releaseDirectory = Test-Path -LiteralPath $licensePath -PathType Leaf
}
if (-not $releaseDirectory) {
    $releaseDirectory = @(
        Get-ChildItem -LiteralPath $PSScriptRoot -File -ErrorAction Stop |
            Where-Object { $_.Name.EndsWith('.tgz', [System.StringComparison]::OrdinalIgnoreCase) }
    ).Count -gt 0
}

if ($releaseDirectory) {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Release integrity check failed because SHA256SUMS.txt is missing.'
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath)
    $lines = @([regex]::Split($manifest, '\r?\n'))
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        if ($lines.Count -eq 1) { $lines = @() } else { $lines = @($lines[0..($lines.Count - 2)]) }
    }
    $entries = @{}
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $safeReleaseFileNamePattern = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
    $manifestLinePattern = '\A(?<hash>[0-9A-Fa-f]{64})  (?<name>' + $safeReleaseFileNamePattern + ')\z'
    $reservedNamePattern = '\A(?i:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|\z)'
    foreach ($line in $lines) {
        $match = [regex]::Match([string]$line, $manifestLinePattern)
        if (-not $match.Success) { throw 'Release integrity check failed because the checksum manifest is malformed.' }
        $name = $match.Groups['name'].Value
        if ($name -eq '.' -or $name -eq '..' -or $name.StartsWith(' ') -or $name.EndsWith('.') -or $name.EndsWith(' ') -or
            $name -match '[\x00-\x1F]' -or $name -match $reservedNamePattern) {
            throw 'Release integrity check failed because the checksum manifest has an invalid file name.'
        }
        if (-not $names.Add($name)) { throw 'Release integrity check failed because the checksum manifest has duplicate names.' }
        $entries[$name] = $match.Groups['hash'].Value.ToLowerInvariant()
    }
    if (-not $entries.ContainsKey('install.ps1')) {
        throw 'Release integrity check failed because install.ps1 is absent from the checksum manifest.'
    }
    $stream = [System.IO.File]::OpenRead($installerPath)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $actualHash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    if (-not [string]::Equals($actualHash, [string]$entries['install.ps1'], [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release integrity check failed because the install.ps1 hash does not match.'
    }
}

$forwardArguments = @{ Operation = 'Uninstall' }
if ($PSBoundParameters.ContainsKey('DshHome')) { $forwardArguments['DshHome'] = $DshHome }
if ($PSBoundParameters.ContainsKey('DshCommand')) { $forwardArguments['DshCommand'] = $DshCommand }
if ($PSBoundParameters.ContainsKey('Version')) { $forwardArguments['Version'] = $Version }
if ($AllowDowngrade) { $forwardArguments['AllowDowngrade'] = $true }
if ($AcceptLicense) { $forwardArguments['AcceptLicense'] = $true }
if ($WhatIf) { $forwardArguments['WhatIf'] = $true }
if ($PSBoundParameters.ContainsKey('ReleaseApiUri')) { $forwardArguments['ReleaseApiUri'] = $ReleaseApiUri.AbsoluteUri }

[DshMarketUninstallerLog.Capabilities]::Complete($bootstrapLog, '', $false) | Out-Null
$bootstrapLog = $null
$delegatedToVerifiedInstaller = $true
& $installerPath @forwardArguments
if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
catch {
    $category = if ([string]$_.Exception.Message -match '\A(?:Version must|Operation must|license_not_accepted)') { 'input' } elseif ([string]$_.Exception.Message -match '(?:integrity|checksum|manifest|hash)') { 'integrity' } else { 'internal' }
    if (-not $delegatedToVerifiedInstaller -and $bootstrapLog -ne $null) {
        try { Complete-UninstallerBootstrapLog -Capability $bootstrapLog -ErrorCategory $category -Keep | Out-Null }
        catch { $category = 'internal' }
        [Console]::Out.WriteLine('installer_log=' + $bootstrapLogPath)
    }
    [Console]::Error.WriteLine('installer_failed errorCategory=' + $category)
    exit 1
}
}
