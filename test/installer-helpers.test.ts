import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  invokeInstallerPowerShell,
  parseJsonOutput,
  runInteractiveInstallerPowerShell,
  runInstallerPowerShell,
} from './helpers/installer.ts';

const DOT_SOURCE_AND_READ_INPUT = [
  "$ErrorActionPreference = 'Stop'",
  '. ([string]$env:DSH_INSTALLER_SCRIPT)',
  '$inputData = Get-Content -LiteralPath $env:DSH_INSTALLER_TEST_INPUT -Raw | ConvertFrom-Json',
].join('\n');

test('PowerShell fixture invocations have an explicit bounded timeout', async (t) => {
  const started = Date.now();
  const result = await runInstallerPowerShell(t, 'Start-Sleep -Seconds 5', { timeoutMs: 250 });
  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - started < 3_000);
});

test('dot-sourcing defines installer helpers without starting an installation', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    "[ordered]@{ functionCount = @('ConvertFrom-ChecksumManifest', 'Compare-SemanticVersion', 'Resolve-DshHome', 'Test-LocalFixedPath', 'Resolve-DshCommand', 'Select-OwnedDshProcess', 'Write-InstallerLog') | Where-Object { Get-Command $_ -CommandType Function -ErrorAction SilentlyContinue } | Measure-Object | Select-Object -ExpandProperty Count; reached = $true } | ConvertTo-Json -Compress",
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { functionCount: 7, reached: true });
});

test('checksum parser accepts canonical entries and normalizes hashes to lowercase', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$result = ConvertFrom-ChecksumManifest -Manifest ([string]$inputData.manifest)',
    '$result | ConvertTo-Json -Compress',
  ].join('\n'), {
    manifest: [
      `${'A'.repeat(64)}  install.ps1`,
      `${'b'.repeat(64)}  uninstall.ps1`,
      `${'c'.repeat(64)}  LICENSE.txt`,
      `${'d'.repeat(64)}  dsh-market-intelligence-0.1.0.tgz`,
      '',
    ].join('\r\n'),
  });

  assert.deepEqual(parseJsonOutput(output), {
    'install.ps1': 'a'.repeat(64),
    'uninstall.ps1': 'b'.repeat(64),
    'LICENSE.txt': 'c'.repeat(64),
    'dsh-market-intelligence-0.1.0.tgz': 'd'.repeat(64),
  });
});

test('checksum parser rejects case-insensitive duplicates, traversal, separators, invalid names, and malformed lines', async (t) => {
  const invalidManifests = [
    `${'a'.repeat(64)}  install.ps1\n${'b'.repeat(64)}  INSTALL.PS1`,
    `${'a'.repeat(64)}  ..`,
    `${'a'.repeat(64)}  ../install.ps1`,
    `${'a'.repeat(64)}  nested\\install.ps1`,
    `${'a'.repeat(64)}  CON`,
    `${'a'.repeat(64)}  trailing.`,
    `${'a'.repeat(64)}  .leading`,
    `${'a'.repeat(64)}  -leading.tgz`,
    `${'a'.repeat(64)}  trailing-`,
    `${'a'.repeat(64)}  has space.tgz`,
    `${'a'.repeat(64)}   install.ps1`,
    `${'a'.repeat(64)} install.ps1`,
    `${'a'.repeat(63)}  install.ps1`,
    `${'a'.repeat(64)}  install.ps1\n\n${'b'.repeat(64)}  uninstall.ps1`,
    `${'a'.repeat(64)}  extra.tgz\u2028`,
    `${'a'.repeat(64)}  extra.tgz\u2029`,
    `${'a'.repeat(64)}  extra.tgz\u00a0`,
    `${'a'.repeat(64)}  extra.tgz\u200b`,
    `${'a'.repeat(64)}  extra.tgz\u202e`,
    `${'a'.repeat(64)}  extra.tgz\rX`,
    `${'a'.repeat(64)}  extra.tgz\nX`,
    `${'a'.repeat(64)}  extra.tgz\r\nX`,
  ];

  for (const [caseIndex, manifest] of invalidManifests.entries()) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        '$manifestBytes = [Convert]::FromBase64String([string]$inputData.manifestBase64)',
        '$manifest = [Text.Encoding]::UTF8.GetString($manifestBytes)',
        'ConvertFrom-ChecksumManifest -Manifest $manifest | Out-Null',
      ].join('\n'), { manifestBase64: Buffer.from(manifest, 'utf8').toString('base64') }),
      /checksum manifest|duplicate|file name/i,
      `checksum manifest attack case ${caseIndex} must be rejected`,
    );
  }
});

test('semantic comparison is numeric and accepts only canonical three-component versions', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$results = foreach ($row in $inputData.rows) { Compare-SemanticVersion -Left ([string]$row.left) -Right ([string]$row.right) }',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'), {
    rows: [
      { left: '0.10.0', right: '0.9.0' },
      { left: '1.0.0', right: '1.0.0' },
      { left: '2.0.0', right: '10.0.0' },
      { left: '100000000000000000000.0.0', right: '99999999999999999999.999.999' },
    ],
  });
  assert.deepEqual(parseJsonOutput(output), [1, 0, -1, 1]);

  for (const version of [
    'latest',
    'v1.0.0',
    '1.0',
    '1.0.0-beta.1',
    '1.0.0+build',
    '01.0.0',
    '-1.0.0',
    '1.0.0\n',
    '1.0.0\r',
    '1.0.0\r\n',
  ]) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        'Compare-SemanticVersion -Left ([string]$inputData.version) -Right 1.0.0 | Out-Null',
      ].join('\n'), { version }),
      /semantic version/i,
    );
  }
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      DOT_SOURCE_AND_READ_INPUT,
      '$lineSeparatedVersion = "1.0.0" + [string][char]0x2028',
      'Compare-SemanticVersion -Left $lineSeparatedVersion -Right 1.0.0 | Out-Null',
    ].join('\n')),
    /semantic version/i,
  );
});

test('local path policy matches the runtime lexical and fixed-drive policy', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$results = foreach ($candidate in $inputData.accepted) { Test-LocalFixedPath -PathValue ([string]$candidate) -DriveRecords $inputData.drives }',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'), {
    accepted: ['C:\\Users\\张三\\.dsh', 'D:\\AI\\dsh', 'Z:\\Research Data\\dsh-market-intelligence'],
    drives: [
      { DeviceID: 'C:', DriveType: 3 },
      { DeviceID: 'D:', DriveType: 3 },
      { DeviceID: 'Z:', DriveType: 3 },
    ],
  });
  assert.deepEqual(parseJsonOutput(output), [true, true, true]);

  for (const candidate of [
    '.\\dsh',
    '\\\\server\\share\\dsh',
    '\\\\?\\C:\\dsh',
    'C:\\safe\\..\\escape',
    'C:/mixed/separators',
  ]) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        'Test-LocalFixedPath -PathValue ([string]$inputData.candidate) -DriveRecords $inputData.drives | Out-Null',
      ].join('\n'), { candidate, drives: [{ DeviceID: 'C:', DriveType: 3 }] }),
      /normalized absolute local Windows path/i,
    );
  }
});

test('local path policy rejects non-fixed drives and existing reparse-point ancestors', async (t) => {
  for (const driveType of [2, 4, 5]) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        'Test-LocalFixedPath -PathValue C:\\runtime\\dsh -DriveRecords $inputData.drives | Out-Null',
      ].join('\n'), { drives: [{ DeviceID: 'C:', DriveType: driveType }] }),
      /local fixed Windows drive/i,
    );
  }

  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$target = Join-Path $env:DSH_INSTALLER_TEST_ROOT target',
      '$link = Join-Path $env:DSH_INSTALLER_TEST_ROOT link',
      '[System.IO.Directory]::CreateDirectory($target) | Out-Null',
      'New-Item -ItemType Junction -Path $link -Target $target | Out-Null',
      '$driveId = [System.IO.Path]::GetPathRoot($link).TrimEnd("\\")',
      '$candidate = Join-Path $link child',
      'Test-LocalFixedPath -PathValue $candidate -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 }) | Out-Null',
    ].join('\n')),
    /reparse point/i,
  );
});

test('system tar resolver ignores multiple PATH matches and returns one trusted Windows tar path', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$first = Join-Path $env:DSH_INSTALLER_TEST_ROOT first',
    '$second = Join-Path $env:DSH_INSTALLER_TEST_ROOT second',
    '[System.IO.Directory]::CreateDirectory($first) | Out-Null',
    '[System.IO.Directory]::CreateDirectory($second) | Out-Null',
    '$nativeDirectory = if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) { "Sysnative" } else { "System32" }',
    '$expected = Join-Path (Join-Path ([string]$env:SystemRoot) $nativeDirectory) tar.exe',
    'Copy-Item -LiteralPath $expected -Destination (Join-Path $first tar.exe)',
    'Copy-Item -LiteralPath $expected -Destination (Join-Path $second tar.exe)',
    '$env:PATH = $first + [IO.Path]::PathSeparator + $second + [IO.Path]::PathSeparator + $env:PATH',
    '$pathMatches = @(Get-Command tar.exe -All -CommandType Application -ErrorAction Stop)',
    '$resolved = Resolve-SystemTarCommand',
    '[ordered]@{ matchCount = $pathMatches.Count; resolved = [string]$resolved; expected = [string]$expected; scalar = $resolved -is [string] } | ConvertTo-Json -Compress',
  ].join('\n'));

  const result = parseJsonOutput<{ matchCount: number; resolved: string; expected: string; scalar: boolean }>(output);
  assert.ok(result.matchCount >= 3, `expected at least three tar.exe PATH matches, got ${result.matchCount}`);
  assert.equal(result.resolved.toLowerCase(), result.expected.toLowerCase());
  assert.equal(result.scalar, true);
});

test('system tar resolver fails closed when the fixed Windows tar is missing', async (t) => {
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$fakeWindows = Join-Path $env:DSH_INSTALLER_TEST_ROOT Windows',
      '[System.IO.Directory]::CreateDirectory((Join-Path $fakeWindows System32)) | Out-Null',
      '$env:SystemRoot = $fakeWindows',
      'Resolve-SystemTarCommand | Out-Null',
    ].join('\n')),
    /tar_required/,
  );
});

test('system tar resolver fails closed for an unsafe Windows root', async (t) => {
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$env:SystemRoot = "\\\\server\\share\\Windows"',
      'Resolve-SystemTarCommand | Out-Null',
    ].join('\n')),
    /tar_required/,
  );
});

test('system tar resolver rejects an ordinary executable under a caller-substituted fixed Windows root', async (t) => {
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$fakeWindows = Join-Path $env:DSH_INSTALLER_TEST_ROOT fake-Windows',
      '$system32 = Join-Path $fakeWindows System32',
      '[System.IO.Directory]::CreateDirectory($system32) | Out-Null',
      '[System.IO.File]::WriteAllBytes((Join-Path $system32 tar.exe), [byte[]](77, 90))',
      '$env:SystemRoot = $fakeWindows',
      'Resolve-SystemTarCommand | Out-Null',
    ].join('\n')),
    /tar_required/,
  );
});

test('system tar resolver fails closed when the Windows tar path traverses a reparse point', async (t) => {
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$targetWindows = Join-Path $env:DSH_INSTALLER_TEST_ROOT target-Windows',
      '$linkedWindows = Join-Path $env:DSH_INSTALLER_TEST_ROOT linked-Windows',
      '$system32 = Join-Path $targetWindows System32',
      '[System.IO.Directory]::CreateDirectory($system32) | Out-Null',
      '[System.IO.File]::WriteAllBytes((Join-Path $system32 tar.exe), [byte[]](77, 90))',
      'New-Item -ItemType Junction -Path $linkedWindows -Target $targetWindows | Out-Null',
      '$env:SystemRoot = $linkedWindows',
      'Resolve-SystemTarCommand | Out-Null',
    ].join('\n')),
    /tar_required/,
  );
});

test('storage fingerprint rejects a reparse-point descendant without traversing its target', async (t) => {
  await assert.rejects(
    invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$storage = Join-Path $env:DSH_INSTALLER_TEST_ROOT storage',
      '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
      '$link = Join-Path $storage linked',
      '[System.IO.Directory]::CreateDirectory($storage) | Out-Null',
      '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
      '[System.IO.File]::WriteAllText((Join-Path $outside "credential-secret-123.txt"), "must-not-read")',
      'New-Item -ItemType Junction -Path $link -Target $outside | Out-Null',
      'Get-StorageFingerprint -StorageRoot $storage | Out-Null',
    ].join('\n')),
    /storage_reparse_rejected/,
  );
});

test('storage fingerprint includes the complete ordinary directory set', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$storage = Join-Path $env:DSH_INSTALLER_TEST_ROOT storage',
    '[System.IO.Directory]::CreateDirectory($storage) | Out-Null',
    '$before = Get-StorageFingerprint -StorageRoot $storage',
    '[System.IO.Directory]::CreateDirectory((Join-Path $storage "empty\\nested")) | Out-Null',
    '$after = Get-StorageFingerprint -StorageRoot $storage',
    '[ordered]@{ changed = $before -cne $after } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { changed: true });
});

test('managed CLI invocation restores parent DSH_HOME and LASTEXITCODE state', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$command = Join-Path $env:DSH_INSTALLER_TEST_ROOT fake-command.ps1',
    '[System.IO.File]::WriteAllText($command, "param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Arguments) Write-Output ok")',
    '$env:DSH_HOME = "parent-sentinel"',
    '$global:LASTEXITCODE = 77',
    'Invoke-ManagedDsh -DshCommand $command -DshHome "child-sentinel" -Arguments @("--version") | Out-Null',
    '[ordered]@{ home = [string]$env:DSH_HOME; lastExitCode = $global:LASTEXITCODE } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { home: 'parent-sentinel', lastExitCode: 77 });
});

test('rollback backup tampering is rejected before any CLI call or current-profile mutation', async (t) => {
  const attacks = ['raw-manifest-hash', 'manifest-row', 'backup-file', 'directory-artifact', 'operation-token'] as const;
  for (const attack of attacks) {
    await t.test(attack, async (child) => {
      const output = await invokeInstallerPowerShell(child, [
        DOT_SOURCE_AND_READ_INPUT,
        '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
        '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
        '$profile = Join-Path $dshHome "profiles\\desktop"',
        '$storage = Join-Path $dshHome "storages\\dsh-market-intelligence"',
        '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
        '[System.IO.Directory]::CreateDirectory($storage) | Out-Null',
        '$package = Join-Path $profile package.json',
        "$original = '{\"bundles\":[],\"dependencies\":{}}'",
        "$current = '{\"bundles\":[],\"dependencies\":{},\"marker\":\"current\"}'",
        '[System.IO.File]::WriteAllText($package, $original)',
        "[System.IO.File]::WriteAllText((Join-Path $storage state.json), '{\"stable\":true}')",
        '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
        '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
        '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
        '[System.IO.File]::WriteAllText($package, $current)',
        '$utf8 = New-Object System.Text.UTF8Encoding($false)',
        '$tamperBlocked = $false',
        'switch ([string]$inputData.attack) {',
        '  "raw-manifest-hash" { try { [System.IO.File]::AppendAllText($backupView.ManifestPath, " `n", $utf8) } catch { $tamperBlocked = $true } }',
        '  "manifest-row" { $manifest = [System.IO.File]::ReadAllText($backupView.ManifestPath) | ConvertFrom-Json; $manifest.files[0].sha256 = "0" * 64; try { [System.IO.File]::WriteAllText($backupView.ManifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8) } catch { $tamperBlocked = $true } }',
        '  "backup-file" { try { [System.IO.File]::WriteAllText((Join-Path $backupView.BackupDirectory "files\\profiles\\desktop\\package.json"), "corrupt", $utf8) } catch { $tamperBlocked = $true } }',
        '  "directory-artifact" { try { [System.IO.File]::WriteAllText($backupView.DirectoryManifestPath, "{}", $utf8) } catch { $tamperBlocked = $true } }',
        '  "operation-token" { [System.IO.File]::WriteAllText((Join-Path $backupView.BackupDirectory ".operation-token"), ("f" * 64), $utf8) }',
        '}',
        '$cli = Join-Path $env:DSH_INSTALLER_TEST_ROOT fake-rollback.ps1',
        '$callLog = Join-Path $env:DSH_INSTALLER_TEST_ROOT rollback-calls.log',
        '$env:DSH_ROLLBACK_CALL_LOG = $callLog',
        "[System.IO.File]::WriteAllText($cli, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments) [System.IO.File]::AppendAllText($env:DSH_ROLLBACK_CALL_LOG, \"call`n\")')",
        '$storageFingerprint = Get-StorageFingerprint -StorageRoot $storage',
        '$result = if ($tamperBlocked) { $false } else { Invoke-InstallRollback -DshHome $dshHome -DshCommand $cli -Backup $backup -PreviousState $state -StorageFingerprint $storageFingerprint }',
        '$calls = if (Test-Path -LiteralPath $callLog) { @([System.IO.File]::ReadAllLines($callLog)).Count } else { 0 }',
        '[ordered]@{ result = [bool]$result; calls = $calls; current = [System.IO.File]::ReadAllText($package) } | ConvertTo-Json -Compress',
      ].join('\n'), { attack });

      assert.deepEqual(parseJsonOutput(output), { result: false, calls: 0, current: '{"bundles":[],"dependencies":{},"marker":"current"}' });
    });
  }
});

test('rollback rejects copied and reconstructed backup capabilities before CLI', async (t) => {
  const attacks = ['shallow-copy', 'rebuilt-wrapper', 'property-bearing-rebuild'] as const;
  for (const attack of attacks) {
    await t.test(attack, async (child) => {
      const output = await invokeInstallerPowerShell(child, [
        DOT_SOURCE_AND_READ_INPUT,
        '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
        '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
        '$profile = Join-Path $dshHome "profiles\\desktop"',
        '$storage = Join-Path $dshHome "storages\\dsh-market-intelligence"',
        '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
        '[System.IO.Directory]::CreateDirectory($storage) | Out-Null',
        '$package = Join-Path $profile package.json',
        '[System.IO.File]::WriteAllText($package, "original")',
        '[System.IO.File]::WriteAllText((Join-Path $storage state.json), "stable")',
        '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
        '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
        '$candidate = $backup',
        'switch ([string]$inputData.attack) {',
        '  "shallow-copy" { $candidate = $backup.PSObject.Copy() }',
        '  "rebuilt-wrapper" { $candidate = [psobject]::new() }',
        '  "property-bearing-rebuild" { $candidate = [pscustomobject]@{ Capability = $backup; BackupDirectory = "C:\\forged" } }',
        '}',
        '[System.IO.File]::WriteAllText($package, "current-must-remain")',
        '$cli = Join-Path $env:DSH_INSTALLER_TEST_ROOT fake-rollback.ps1',
        '$callLog = Join-Path $env:DSH_INSTALLER_TEST_ROOT rollback-calls.log',
        '$env:DSH_ROLLBACK_CALL_LOG = $callLog',
        "[System.IO.File]::WriteAllText($cli, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments) [System.IO.File]::AppendAllText($env:DSH_ROLLBACK_CALL_LOG, \"call`n\")')",
        '$storageFingerprint = Get-StorageFingerprint -StorageRoot $storage',
        '$result = Invoke-InstallRollback -DshHome $dshHome -DshCommand $cli -Backup $candidate -PreviousState $state -StorageFingerprint $storageFingerprint',
        '$calls = if (Test-Path -LiteralPath $callLog) { @([System.IO.File]::ReadAllLines($callLog)).Count } else { 0 }',
        '$originalUsable = $false',
        'try { Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup | Out-Null; $originalUsable = $true } catch {}',
        '[ordered]@{ result = [bool]$result; calls = $calls; current = [System.IO.File]::ReadAllText($package); originalUsable = $originalUsable } | ConvertTo-Json -Compress',
      ].join('\n'), { attack });

      assert.deepEqual(parseJsonOutput(output), { result: false, calls: 0, current: 'current-must-remain', originalUsable: true });
    });
  }
});

test('profile backup capability token remains memory-only and is absent from every backup byte', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$backupPreflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '$operationLog = New-InstallerOperationLog',
    'Write-InstallerLog -OperationLog $operationLog -EventName InstallerResult -Data ([ordered]@{ operation = "Install"; phase = "complete"; resultCode = 0; driveRoot = [System.IO.Path]::GetPathRoot($dshHome); version = "1.2.3"; rollbackResult = "not-required"; errorCategory = "none" })',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "mutated")',
    '$restoreOutput = @(Restore-ProfileBackup -RestoreCapability $backupPreflight.RestoreCapability)',
    '$files = @(Get-ChildItem -LiteralPath $backupView.BackupDirectory -File -Recurse -Force)',
    '$tokenFilePresent = @($files | Where-Object { $_.Name -ceq ".operation-token" }).Count -ne 0',
    '$tokenLabelPresent = @($files | Where-Object { [System.IO.File]::ReadAllText($_.FullName) -match "(?i)operation.?token|cleanup.?token|capability.?id" }).Count -ne 0',
    '$capabilityRendered = @($backup | ConvertTo-Json -Compress; $backup | Format-List * | Out-String; $backup.ToString()) -join "`n"',
    '$capabilitySecretSurface = @($backup.PSObject.Properties).Count -ne 0 -or $capabilityRendered -match "(?i)token|capability.?id|handle|hash|path"',
    '$outputSecretSurface = [string]::Join("`n", @($restoreOutput)) -match "(?i)token|capability.?id|handle|hash|path"',
    '[ordered]@{ tokenFilePresent = $tokenFilePresent; tokenLabelPresent = $tokenLabelPresent; capabilitySecretSurface = $capabilitySecretSurface; outputSecretSurface = $outputSecretSurface; restored = [System.IO.File]::ReadAllText((Join-Path $profile "package.json")) } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    tokenFilePresent: false,
    tokenLabelPresent: false,
    capabilitySecretSurface: false,
    outputSecretSurface: false,
    restored: 'original',
  });
});

test('active backup handle blocks corrupting a backup file before restoring any row', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '$packagePath = Join-Path $profile package.json',
    '$lockPath = Join-Path $profile pnpm-lock.yaml',
    '$patchPath = Join-Path $profile cordis.patch.yml',
    '[System.IO.File]::WriteAllText($packagePath, "package-original")',
    '[System.IO.File]::WriteAllText($lockPath, "lock-original")',
    '[System.IO.File]::WriteAllText($patchPath, "patch-original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 0.1.0 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '[System.IO.File]::WriteAllText($packagePath, "package-mutated")',
    '[System.IO.File]::WriteAllText($lockPath, "lock-mutated")',
    '[System.IO.File]::WriteAllText($patchPath, "patch-mutated")',
    '$corruptBackup = Join-Path $backupView.BackupDirectory "files\\profiles\\desktop\\package.json"',
    '$tamperBlocked = $false',
    'try { [System.IO.File]::WriteAllText($corruptBackup, "corrupt") } catch { $tamperBlocked = $true }',
    '[ordered]@{ tamperBlocked = $tamperBlocked; package = [System.IO.File]::ReadAllText($packagePath); lock = [System.IO.File]::ReadAllText($lockPath); patch = [System.IO.File]::ReadAllText($patchPath) } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    tamperBlocked: true,
    package: 'package-mutated',
    lock: 'lock-mutated',
    patch: 'patch-mutated',
  });
});

test('installed state rejects receipt traversal, ADS, version mismatch, and a cache reparse ancestor', async (t) => {
  for (const [name, cacheRelativePath, receiptVersion] of [
    ['traversal', '..\\outside.tgz', '1.2.3'],
    ['ADS', '.dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz:payload', '1.2.3'],
    ['version mismatch', '.dsh-market-cache\\dsh-market-intelligence-9.9.9.tgz', '9.9.9'],
  ] as const) {
    await t.test(name, async (child) => {
      await assert.rejects(
        invokeInstallerPowerShell(child, [
          "$ErrorActionPreference = 'Stop'",
          '. ([string]$env:DSH_INSTALLER_SCRIPT)',
          '$profile = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh-home\\profiles\\desktop"',
          '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
          '$utf8 = New-Object System.Text.UTF8Encoding($false)',
          '$profileData = [ordered]@{ dependencies = [ordered]@{ "dsh-market-intelligence" = "1.2.3" }; bundles = @("dsh-market-intelligence") }',
          '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), ($profileData | ConvertTo-Json -Depth 5 -Compress), $utf8)',
          `[System.IO.File]::WriteAllText((Join-Path $profile ".dsh-market-intelligence-receipt.json"), '${JSON.stringify({ version: receiptVersion, cacheRelativePath })}', $utf8)`,
          '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh-home"',
          'Get-InstalledPluginState -DshHome $dshHome | Out-Null',
        ].join('\n')),
        /profile_invalid/,
      );
    });
  }

  await t.test('cache junction', async (child) => {
    await assert.rejects(
      invokeInstallerPowerShell(child, [
        "$ErrorActionPreference = 'Stop'",
        '. ([string]$env:DSH_INSTALLER_SCRIPT)',
        '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh-home"',
        '$profile = Join-Path $dshHome "profiles\\desktop"',
        '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
        '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
        '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
        'New-Item -ItemType Junction -Path (Join-Path $profile ".dsh-market-cache") -Target $outside | Out-Null',
        '$utf8 = New-Object System.Text.UTF8Encoding($false)',
        '$profileData = [ordered]@{ dependencies = [ordered]@{ "dsh-market-intelligence" = "1.2.3" }; bundles = @("dsh-market-intelligence") }',
        '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), ($profileData | ConvertTo-Json -Depth 5 -Compress), $utf8)',
        '$receiptData = [ordered]@{ version = "1.2.3"; cacheRelativePath = ".dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz" }',
        '[System.IO.File]::WriteAllText((Join-Path $profile ".dsh-market-intelligence-receipt.json"), ($receiptData | ConvertTo-Json -Compress), $utf8)',
        'Get-InstalledPluginState -DshHome $dshHome | Out-Null',
      ].join('\n')),
      /profile_reparse_rejected/,
    );
  });
});

test('profile backup uses only documented recovery inputs and never copies or hashes credential and unrelated sentinels', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '$credential = Join-Path $profile "credentials.yaml"',
    '$session = Join-Path $profile "sessions\\private.json"',
    '$unrelated = Join-Path $profile "node_modules\\unrelated-package\\index.js"',
    '[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($session)) | Out-Null',
    '[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($unrelated)) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "package-original")',
    '[System.IO.File]::WriteAllText($credential, "credential-secret-123")',
    '[System.IO.File]::WriteAllText($session, "session-secret-456")',
    '[System.IO.File]::WriteAllText($unrelated, "unrelated-original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$backupPreflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$rows = @($backupPreflight.Manifest.files | ForEach-Object { [string]$_.relativePath } | Sort-Object)',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '$backupBytes = @(Get-ChildItem -LiteralPath $backupView.BackupDirectory -File -Recurse -Force | ForEach-Object { Read-InstallerSharedText -LiteralPath $_.FullName }) -join "`n"',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "package-mutated")',
    '[System.IO.File]::WriteAllText($credential, "credential-mutated")',
    '[System.IO.File]::WriteAllText($session, "session-mutated")',
    '[System.IO.File]::WriteAllText($unrelated, "unrelated-mutated")',
    '$receipt = Join-Path $profile ".dsh-market-intelligence-receipt.json"',
    '$managedCache = Join-Path $profile ".dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz"',
    '[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($managedCache)) | Out-Null',
    '[System.IO.File]::WriteAllText($receipt, "created-receipt")',
    '[System.IO.File]::WriteAllText($managedCache, "created-cache")',
    'Restore-ProfileBackup -RestoreCapability $backupPreflight.RestoreCapability | Out-Null',
    '[ordered]@{ rows = $rows; package = [System.IO.File]::ReadAllText((Join-Path $profile "package.json")); credential = [System.IO.File]::ReadAllText($credential); session = [System.IO.File]::ReadAllText($session); unrelated = [System.IO.File]::ReadAllText($unrelated); receiptExists = Test-Path -LiteralPath $receipt; cacheExists = Test-Path -LiteralPath $managedCache; leaked = $backupBytes -match "credential-secret|session-secret|unrelated-original" } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    rows: [
      'profiles\\desktop\\.dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz',
      'profiles\\desktop\\.dsh-market-intelligence-receipt.json',
      'profiles\\desktop\\cordis.patch.yml',
      'profiles\\desktop\\dsh.profile.yaml',
      'profiles\\desktop\\package.json',
      'profiles\\desktop\\pnpm-lock.yaml',
    ],
    package: 'package-original',
    credential: 'credential-mutated',
    session: 'session-mutated',
    unrelated: 'unrelated-mutated',
    receiptExists: false,
    cacheExists: false,
    leaked: false,
  });
});

test('restore authority is an opaque capability with fixed rows and no caller-selected target root', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($env:DSH_INSTALLER_TEST_ROOT).TrimEnd("\\"); DriveType = 3 })',
    '$homeA = Join-Path $env:DSH_INSTALLER_TEST_ROOT home-a',
    '$homeB = Join-Path $env:DSH_INSTALLER_TEST_ROOT home-b',
    '$profileA = Join-Path $homeA "profiles\\desktop"',
    '$profileB = Join-Path $homeB "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profileA) | Out-Null',
    '[System.IO.Directory]::CreateDirectory($profileB) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profileA package.json), "a-original")',
    '[System.IO.File]::WriteAllText((Join-Path $profileB package.json), "b-original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backupA = New-ProfileBackup -DshHome $homeA -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$backupB = New-ProfileBackup -DshHome $homeB -RequestedVersion 9.8.7 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$preflightA = Test-ProfileBackupPreflight -DshHome $homeA -BackupCapability $backupA',
    '$preflightB = Test-ProfileBackupPreflight -DshHome $homeB -BackupCapability $backupB',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside.txt',
    '[System.IO.File]::WriteAllText($outside, "outside-original")',
    '[System.IO.File]::WriteAllText((Join-Path $profileA package.json), "a-mutated")',
    '$unknownRejected = $false; try { [DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow($preflightA.RestoreCapability, "profiles\\desktop\\unknown.txt") | Out-Null } catch { $unknownRejected = $true }',
    '$crossRejected = $false; try { [DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow($preflightA.RestoreCapability, "profiles\\desktop\\.dsh-market-cache\\dsh-market-intelligence-9.8.7.tgz") | Out-Null } catch { $crossRejected = $true }',
    '$forgedRejected = $false; try { [DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow(([pscustomobject]@{}), "profiles\\desktop\\package.json") | Out-Null } catch { $forgedRejected = $true }',
    '$publicMethods = @([DshMarketInstaller.InstallerCapabilities].GetMethods([System.Reflection.BindingFlags] "Public,Static") | ForEach-Object Name)',
    '[DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow($preflightA.RestoreCapability, "profiles\\desktop\\package.json") | Out-Null',
    '[ordered]@{ unknownRejected=$unknownRejected; crossRejected=$crossRejected; forgedRejected=$forgedRejected; oldRestoreApi=($publicMethods -contains "RestoreFileFromBackup"); oldRemoveApi=($publicMethods -contains "RemoveRestoreTarget" -and ([DshMarketInstaller.InstallerCapabilities].GetMethod("RemoveRestoreTarget").GetParameters().Count -ne 2)); package=[System.IO.File]::ReadAllText((Join-Path $profileA package.json)); outside=[System.IO.File]::ReadAllText($outside) } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    unknownRejected: true,
    crossRejected: true,
    forgedRejected: true,
    oldRestoreApi: false,
    oldRemoveApi: false,
    package: 'a-original',
    outside: 'outside-original',
  });
});

test('restore preflight pins manifest and payload identities until restore completes', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($env:DSH_INSTALLER_TEST_ROOT).TrimEnd("\\"); DriveType = 3 })',
    '$results = @()',
    'foreach ($attack in @("manifest-hardlink", "manifest-write-after-preflight")) {',
    '  $caseRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT ([guid]::NewGuid().ToString("D"))',
    '  $dshHome = Join-Path $caseRoot dsh',
    '  $profile = Join-Path $dshHome "profiles\\desktop"',
    '  [System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '  $package = Join-Path $profile package.json',
    '  [System.IO.File]::WriteAllText($package, "original")',
    '  $state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '  $backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '  $view = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '  $category = ""; $blocked = $false',
    '  if ($attack -ceq "manifest-hardlink") {',
    '    $outside = Join-Path $caseRoot manifest-link.json',
    '    New-Item -ItemType HardLink -Path $outside -Target $view.ManifestPath -ErrorAction Stop | Out-Null',
    '    try { Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup | Out-Null } catch { $category = $_.Exception.Message }',
    '  } else {',
    '    $preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '    try { [System.IO.File]::WriteAllText($view.ManifestPath, "{}") } catch { $blocked = $true }',
    '    [System.IO.File]::WriteAllText($package, "mutated")',
    '    Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null',
    '  }',
    '  $results += [ordered]@{ attack=$attack; category=$category; blocked=$blocked; package=[System.IO.File]::ReadAllText($package) }',
    '}',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), [
    { attack: 'manifest-hardlink', category: 'backup_integrity_invalid', blocked: false, package: 'original' },
    { attack: 'manifest-write-after-preflight', category: '', blocked: true, package: 'original' },
  ]);
});

test('backup completion closes every restore handle and invalidates the capability on success and failure', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($env:DSH_INSTALLER_TEST_ROOT).TrimEnd("\\"); DriveType = 3 })',
    '$results = @()',
    'foreach ($succeeded in @($true, $false)) {',
    '  $dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT ([guid]::NewGuid().ToString("D"))',
    '  $profile = Join-Path $dshHome "profiles\\desktop"',
    '  [System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '  [System.IO.File]::WriteAllText((Join-Path $profile package.json), "original")',
    '  $state = [pscustomobject]@{ CacheRelativePath=$null; Installed=$false; Version=$null; BundleCount=0 }',
    '  $backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '  $view = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '  $preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '  [DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, [bool]$succeeded)',
    '  $invalidated = $false; try { [DshMarketInstaller.InstallerCapabilities]::RestoreBoundRow($preflight.RestoreCapability, "profiles\\desktop\\package.json") | Out-Null } catch { $invalidated = $true }',
    '  $released = $false; try { [System.IO.Directory]::Delete($view.BackupDirectory, $true); $released = $true } catch {}',
    '  $results += [ordered]@{ succeeded=[bool]$succeeded; invalidated=$invalidated; released=$released }',
    '}',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), [
    { succeeded: true, invalidated: true, released: true },
    { succeeded: false, invalidated: true, released: true },
  ]);
});

test('profile backup rejects hardlinked lock, receipt, and managed cache sources without copying their bytes', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($env:DSH_INSTALLER_TEST_ROOT).TrimEnd("\\"); DriveType = 3 })',
    '$results = @()',
    'foreach ($kind in @("pnpm-lock.yaml", ".dsh-market-intelligence-receipt.json", ".dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz")) {',
    '  $caseRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT ([guid]::NewGuid().ToString("D"))',
    '  $dshHome = Join-Path $caseRoot "dsh"',
    '  $profile = Join-Path $dshHome "profiles\\desktop"',
    '  [System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '  [System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "package-original", $utf8)',
    '  $outside = Join-Path $caseRoot "outside-secret.bin"',
    '  $secret = "hardlink-secret-" + ($kind -replace "[^A-Za-z]", "-")',
    '  [System.IO.File]::WriteAllText($outside, $secret, $utf8)',
    '  $source = Join-Path $profile $kind',
    '  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($source)) | Out-Null',
    '  New-Item -ItemType HardLink -Path $source -Target $outside -ErrorAction Stop | Out-Null',
    '  $state = [pscustomobject]@{ Installed = $false; CacheRelativePath = $null }',
    '  $category = ""',
    '  try { New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords | Out-Null } catch { $category = $_.Exception.Message }',
    '  $leaked = $false',
    '  $backupRoot = Join-Path $dshHome "backups\\dsh-market-intelligence"',
    '  if (Test-Path -LiteralPath $backupRoot) {',
    '    foreach ($file in @(Get-ChildItem -LiteralPath $backupRoot -File -Recurse -Force -ErrorAction Stop)) {',
    '      if ((Read-InstallerSharedText -LiteralPath $file.FullName) -match [regex]::Escape($secret)) { $leaked = $true }',
    '    }',
    '  }',
    '  $results += [ordered]@{ kind = $kind; category = $category; leaked = $leaked; outside = [System.IO.File]::ReadAllText($outside) }',
    '}',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'));

  const results = parseJsonOutput<Array<{ category: string; kind: string; leaked: boolean; outside: string }>>(output);
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.category, 'backup_source_invalid', result.kind);
    assert.equal(result.leaked, false, result.kind);
    assert.match(result.outside, /^hardlink-secret-/);
  }
});

test('opaque backup copy rejects a preplaced files junction before any external destination write', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh"',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT "outside"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '$source = Join-Path $profile "package.json"',
    '[System.IO.File]::WriteAllText($source, "source-secret-must-not-escape", $utf8)',
    'Initialize-InstallerNativeFileApi',
    '$backup = [DshMarketInstaller.InstallerCapabilities]::CreateBackup($dshHome)',
    '$view = [DshMarketInstaller.InstallerCapabilities]::GetBackupView($backup)',
    '$files = Join-Path $view.BackupDirectory "files"',
    'New-Item -ItemType Junction -Path $files -Target $outside -ErrorAction Stop | Out-Null',
    '$category = ""',
    'try { [DshMarketInstaller.InstallerCapabilities]::CopyFileIntoBackup($backup, $profile, "package.json", "profiles\\desktop\\package.json") | Out-Null } catch { $category = $_.Exception.InnerException.Message }',
    '$outsideEntries = @(Get-ChildItem -LiteralPath $outside -Force -ErrorAction Stop).Count',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $false)',
    '[ordered]@{ category = $category; outsideEntries = $outsideEntries; source = [System.IO.File]::ReadAllText($source) } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'backup_integrity_invalid',
    outsideEntries: 0,
    source: 'source-secret-must-not-escape',
  });
});

test('retained backup directory handles block live rename and junction replacement', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh"',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT "outside"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "bound-backup-bytes", $utf8)',
    'Initialize-InstallerNativeFileApi',
    '$backup = [DshMarketInstaller.InstallerCapabilities]::CreateBackup($dshHome)',
    '$view = [DshMarketInstaller.InstallerCapabilities]::GetBackupView($backup)',
    '[DshMarketInstaller.InstallerCapabilities]::CopyFileIntoBackup($backup, $profile, "package.json", "profiles\\desktop\\package.json") | Out-Null',
    '$files = Join-Path $view.BackupDirectory "files"',
    '$moved = Join-Path $view.BackupDirectory "files-moved"',
    '$renameBlocked = $false',
    'try { Move-Item -LiteralPath $files -Destination $moved -ErrorAction Stop } catch { $renameBlocked = $true }',
    '$junctionBlocked = $false',
    'try { New-Item -ItemType Junction -Path $files -Target $outside -ErrorAction Stop | Out-Null } catch { $junctionBlocked = $true }',
    '$outsideEntries = @(Get-ChildItem -LiteralPath $outside -Force -ErrorAction Stop).Count',
    '$boundValue = Read-InstallerSharedText -LiteralPath (Join-Path $files "profiles\\desktop\\package.json")',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $false)',
    '[ordered]@{ renameBlocked = $renameBlocked; junctionBlocked = $junctionBlocked; outsideEntries = $outsideEntries; boundValue = $boundValue } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    renameBlocked: true,
    junctionBlocked: true,
    outsideEntries: 0,
    boundValue: 'bound-backup-bytes',
  });
});

test('backup copy holds the verified source handle against live path replacement', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh"',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '$source = Join-Path $profile "package.json"',
    '$sourceStream = New-Object System.IO.FileStream($source, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
    'try { $sourceStream.SetLength(268435456); $sourceStream.Flush($true) } finally { $sourceStream.Dispose() }',
    'Initialize-InstallerNativeFileApi',
    '$backup = [DshMarketInstaller.InstallerCapabilities]::CreateBackup($dshHome)',
    '$view = [DshMarketInstaller.InstallerCapabilities]::GetBackupView($backup)',
    '$destination = Join-Path $view.BackupDirectory "files\\profiles\\desktop\\package.json"',
    '$moved = Join-Path $profile "package-moved.json"',
    '$attacker = Start-Job -ScriptBlock { param($Source,$Destination,$Moved) while (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) { Start-Sleep -Milliseconds 1 }; try { Move-Item -LiteralPath $Source -Destination $Moved -ErrorAction Stop; "moved" } catch { "blocked" } } -ArgumentList $source,$destination,$moved',
    '$copy = [DshMarketInstaller.InstallerCapabilities]::CopyFileIntoBackup($backup, $profile, "package.json", "profiles\\desktop\\package.json")',
    'if ((Wait-Job -Job $attacker -Timeout 10).State -ne "Completed") { Stop-Job $attacker; throw "attacker_timeout" }',
    '$attackerResult = [string](Receive-Job -Job $attacker)',
    'Remove-Job -Job $attacker -Force',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteBackup($backup, $false)',
    '[ordered]@{ attacker = $attackerResult; sourceExists = Test-Path -LiteralPath $source -PathType Leaf; movedExists = Test-Path -LiteralPath $moved; copiedLength = [int64]$copy.Length } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    attacker: 'blocked',
    sourceExists: true,
    movedExists: false,
    copiedLength: 268435456,
  });
});

test('profile restore rejects a hardlinked managed target without modifying the outside link', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh"',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '$package = Join-Path $profile "package.json"',
    '[System.IO.File]::WriteAllText($package, "package-original", $utf8)',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$state = [pscustomobject]@{ Installed = $false; CacheRelativePath = $null }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT "outside-target.json"',
    '[System.IO.File]::WriteAllText($outside, "outside-must-remain", $utf8)',
    '[System.IO.File]::Delete($package)',
    'New-Item -ItemType HardLink -Path $package -Target $outside -ErrorAction Stop | Out-Null',
    '$category = ""',
    'try { Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null } catch { $category = $_.Exception.Message }',
    '[ordered]@{ category = $category; outside = [System.IO.File]::ReadAllText($outside); package = [System.IO.File]::ReadAllText($package) } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'backup_restore_target_invalid',
    outside: 'outside-must-remain',
    package: 'outside-must-remain',
  });
});

test('profile restore refuses to delete a hardlinked target that was absent from the backup', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "dsh"',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "package-original", $utf8)',
    '$drives = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState ([pscustomobject]@{ Installed = $false; CacheRelativePath = $null }) -DriveRecords $drives',
    '$preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT "outside-absent.json"',
    '$receipt = Join-Path $profile ".dsh-market-intelligence-receipt.json"',
    '[System.IO.File]::WriteAllText($outside, "outside-absent-must-remain", $utf8)',
    'New-Item -ItemType HardLink -Path $receipt -Target $outside -ErrorAction Stop | Out-Null',
    '$category = ""',
    'try { Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null } catch { $category = $_.Exception.Message }',
    '$receiptValue = if (Test-Path -LiteralPath $receipt -PathType Leaf) { [System.IO.File]::ReadAllText($receipt) } else { "<deleted>" }',
    '[ordered]@{ category = $category; outside = [System.IO.File]::ReadAllText($outside); receipt = $receiptValue } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    category: 'backup_restore_target_invalid',
    outside: 'outside-absent-must-remain',
    receipt: 'outside-absent-must-remain',
  });
});

test('profile backup ignores unrelated descendant reparse points without reading their targets', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Stop'",
      '. ([string]$env:DSH_INSTALLER_SCRIPT)',
      '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
      '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
      '$profile = Join-Path $dshHome "profiles\\desktop"',
      '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
      '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
      '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
      '[System.IO.File]::WriteAllText((Join-Path $outside "secret.txt"), "must-not-read")',
      'New-Item -ItemType Junction -Path (Join-Path $profile linked) -Target $outside | Out-Null',
      '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
      '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
      '$view = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
      '$bytes = @(Get-ChildItem -LiteralPath $view.BackupDirectory -File -Recurse -Force | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join "`n"',
      '[ordered]@{ created = Test-Path -LiteralPath $view.ManifestPath; leaked = $bytes -match "must-not-read" } | ConvertTo-Json -Compress',
    ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { created: true, leaked: false });
});

test('profile restore pins the manifest before duplicate-row tampering can mutate it', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT second-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '$package = Join-Path $profile package.json',
    '[System.IO.File]::WriteAllText($package, "original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '$manifest = Get-Content -LiteralPath $backupView.ManifestPath -Raw | ConvertFrom-Json',
    '$manifest.files = @($manifest.files + $manifest.files[0])',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$blocked = $false; try { [System.IO.File]::WriteAllText($backupView.ManifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8) } catch { $blocked = $true }',
    '[System.IO.File]::WriteAllText($package, "mutated")',
    '$category = ""',
    'if ($blocked) { $category = "backup_tamper_blocked" } else { try { Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null } catch { $category = $_.Exception.Message } }',
    '[ordered]@{ category = $category; package = [System.IO.File]::ReadAllText($package) } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { category: 'backup_tamper_blocked', package: 'mutated' });
});

test('profile restore rejects a tampered manifest row schema before mutation', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '$package = Join-Path $profile package.json',
    '[System.IO.File]::WriteAllText($package, "original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '$manifest = Get-Content -LiteralPath $backupView.ManifestPath -Raw | ConvertFrom-Json',
    '$manifest.files[0].sha256 = "g" * 64',
    '$manifest.files[0] | Add-Member -MemberType NoteProperty -Name unexpected -Value "attacker"',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$blocked = $false; try { [System.IO.File]::WriteAllText($backupView.ManifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8) } catch { $blocked = $true }',
    '[System.IO.File]::WriteAllText($package, "mutated")',
    '$category = ""',
    'if ($blocked) { $category = "backup_tamper_blocked" } else { try { Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null } catch { $category = $_.Exception.Message } }',
    '[ordered]@{ category = $category; package = [System.IO.File]::ReadAllText($package) } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { category: 'backup_tamper_blocked', package: 'mutated' });
});

test('profile restore binds the complete manifest and exact backup file tree before any deletion', async (t) => {
  const attacks = [
    'delete-row',
    'delete-backup-file',
    'add-backup-file',
    'modify-backup-file',
    'tamper-created-at',
    'tamper-requested-version',
    'tamper-cli-path',
    'tamper-cli-version',
  ] as const;

  for (const attack of attacks) {
    await t.test(attack, async (child) => {
      const output = await invokeInstallerPowerShell(child, [
        DOT_SOURCE_AND_READ_INPUT,
        '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
        '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
        '$profile = Join-Path $dshHome "profiles\\desktop"',
        '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
        '$package = Join-Path $profile package.json',
        '$lock = Join-Path $profile pnpm-lock.yaml',
        '[System.IO.File]::WriteAllText($package, "package-original")',
        '[System.IO.File]::WriteAllText($lock, "lock-original")',
        '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
        '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
        '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
        '[System.IO.File]::WriteAllText($package, "package-current-mutated")',
        '$created = Join-Path $profile transaction-created.txt',
        '[System.IO.File]::WriteAllText($created, "must-remain-on-rejection")',
        '$manifest = Get-Content -LiteralPath $backupView.ManifestPath -Raw | ConvertFrom-Json',
        '$backupPackage = Join-Path $backupView.BackupDirectory "files\\profiles\\desktop\\package.json"',
        '$tamperBlocked = $false',
        'switch ([string]$inputData.attack) {',
        '  "delete-row" { $manifest.files = @($manifest.files | Where-Object { [string]$_.relativePath -cne "profiles\\desktop\\package.json" }) }',
        '  "delete-backup-file" { try { Remove-Item -LiteralPath $backupPackage -Force -ErrorAction Stop } catch { $tamperBlocked = $true } }',
        '  "add-backup-file" { [System.IO.File]::WriteAllText((Join-Path $backupView.BackupDirectory "files\\profiles\\desktop\\orphan.txt"), "orphan") }',
        '  "modify-backup-file" { try { [System.IO.File]::WriteAllText($backupPackage, "corrupt") } catch { $tamperBlocked = $true } }',
        '  "tamper-created-at" { $manifest.createdAt = "not-a-canonical-timestamp" }',
        '  "tamper-requested-version" { $manifest.requestedVersion = "01.2.3" }',
        '  "tamper-cli-path" { $manifest.cliPath = "relative\\dsh.cmd" }',
        '  "tamper-cli-version" { $manifest.cliVersion = "01.2.3" }',
        '}',
        'if ([string]$inputData.attack -match "delete-row|tamper-") {',
        '  $utf8 = New-Object System.Text.UTF8Encoding($false)',
        '  try { [System.IO.File]::WriteAllText($backupView.ManifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8) } catch { $tamperBlocked = $true }',
        '}',
        '$category = ""',
        '$preflight = $null; if (-not $tamperBlocked) { try { $preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup } catch { $category = $_.Exception.Message } }',
        '$restoreArguments = @{ RestoreCapability = if($preflight -ne $null){$preflight.RestoreCapability}else{$null} }',
        'if ($tamperBlocked) { $category = "backup_tamper_blocked" } elseif ($preflight -ne $null) { try { Restore-ProfileBackup @restoreArguments | Out-Null } catch { $category = $_.Exception.Message } }',
        '$packageValue = if (Test-Path -LiteralPath $package -PathType Leaf) { [System.IO.File]::ReadAllText($package) } else { "<missing>" }',
        '[ordered]@{ category = $category; package = $packageValue; createdExists = Test-Path -LiteralPath $created } | ConvertTo-Json -Compress',
      ].join('\n'), { attack });

      const result = parseJsonOutput(output) as { category: string; createdExists: boolean; package: string };
      assert.match(result.category, /^backup_(?:(?:manifest|integrity)_invalid|tamper_blocked)$/);
      assert.equal(result.package, 'package-current-mutated');
      assert.equal(result.createdExists, true);
    });
  }
});

test('profile restore leaves unrelated empty directories outside its recovery authority', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '$originalEmpty = Join-Path $profile "unrelated-empty\\nested-empty"',
    '[System.IO.Directory]::CreateDirectory($originalEmpty) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $profile "package.json"), "package-original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$preflight = Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup',
    '[System.IO.Directory]::Delete((Join-Path $profile "unrelated-empty"), $true)',
    '$createdEmpty = Join-Path $profile "transaction-created\\nested-empty"',
    '[System.IO.Directory]::CreateDirectory($createdEmpty) | Out-Null',
    '$restoreArguments = @{ RestoreCapability = $preflight.RestoreCapability }',
    '$category = ""',
    'try { Restore-ProfileBackup @restoreArguments | Out-Null } catch { $category = $_.Exception.Message }',
    '[ordered]@{ category = $category; originalEmpty = Test-Path -LiteralPath $originalEmpty -PathType Container; createdEmpty = Test-Path -LiteralPath $createdEmpty } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { category: '', originalEmpty: false, createdEmpty: true });
});

test('profile restore binds the protected directory artifact before current-tree deletion', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$driveRecords = @([pscustomobject]@{ DeviceID = [System.IO.Path]::GetPathRoot($dshHome).TrimEnd("\\"); DriveType = 3 })',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[System.IO.Directory]::CreateDirectory((Join-Path $profile "original-empty")) | Out-Null',
    '$package = Join-Path $profile package.json',
    '[System.IO.File]::WriteAllText($package, "package-original")',
    '$state = [pscustomobject]@{ CacheRelativePath = $null; Installed = $false; Version = $null; BundleCount = 0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $driveRecords',
    '$backupView = Get-ProfileBackupView -DshHome $dshHome -BackupCapability $backup',
    '$artifact = $backupView.DirectoryManifestPath',
    '$blocked = $false; try { [System.IO.File]::WriteAllText($artifact, "{}`n") } catch { $blocked = $true }',
    '[System.IO.File]::WriteAllText($package, "package-current-mutated")',
    '$created = Join-Path $profile transaction-created.txt',
    '[System.IO.File]::WriteAllText($created, "must-remain")',
    '$category = ""',
    'if ($blocked) { $category = "backup_tamper_blocked" } else { try { Restore-ProfileBackup -RestoreCapability $preflight.RestoreCapability | Out-Null } catch { $category = $_.Exception.Message } }',
    '[ordered]@{ supported = $true; category = $category; package = [System.IO.File]::ReadAllText($package); created = Test-Path -LiteralPath $created } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    supported: true,
    category: 'backup_tamper_blocked',
    package: 'package-current-mutated',
    created: true,
  });
});

test('all installer relative-path validators reject Windows reserved device components', async (t) => {
  const reserved = ['CON', 'prn.txt', 'Aux.yml', 'NUL.log', 'clock$', 'COM1.js', 'com9.any', 'LPT1', 'lpt9.txt'];
  for (const component of reserved) {
    await t.test(component, async (child) => {
      const output = await invokeInstallerPowerShell(child, [
        DOT_SOURCE_AND_READ_INPUT,
        '$root = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-root',
        '[System.IO.Directory]::CreateDirectory($root) | Out-Null',
        '$containedRejected = $false',
        'try { Resolve-ContainedLiteralPath -Root $root -RelativePath ("nested\\" + [string]$inputData.component) -ErrorCategory "reserved_rejected" | Out-Null } catch { $containedRejected = $_.Exception.Message -ceq "reserved_rejected" }',
        '$backupAccepted = Test-BackupRelativePathValue -RelativePath ("profiles\\desktop\\nested\\" + [string]$inputData.component)',
        '[ordered]@{ containedRejected = $containedRejected; backupAccepted = $backupAccepted } | ConvertTo-Json -Compress',
      ].join('\n'), { component });
      assert.deepEqual(parseJsonOutput(output), { containedRejected: true, backupAccepted: false });
    });
  }
});

test('installer temp creation rejects a reparse-point temporary root', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$functionPresent = (Get-Command New-InstallerTemporaryDirectory -CommandType Function -ErrorAction SilentlyContinue) -ne $null',
    'if (-not $functionPresent) { [ordered]@{ functionPresent = $false } | ConvertTo-Json -Compress; return }',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
    '$link = Join-Path $env:DSH_INSTALLER_TEST_ROOT linked-temp',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    'New-Item -ItemType Junction -Path $link -Target $outside | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($link).TrimEnd("\\")',
    '$category = ""',
    'try { New-InstallerTemporaryDirectory -TemporaryRoot $link -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 }) | Out-Null } catch { $category = $_.Exception.Message }',
    '[ordered]@{ functionPresent = $true; category = $category; outsideChildren = @(Get-ChildItem -LiteralPath $outside -Force).Count } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { functionPresent: true, category: 'temporary_path_invalid', outsideChildren: 0 });
});

test('installer temp native initialization failure creates no owned GUID child', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$before = @(Get-ChildItem -LiteralPath $tempRoot -Force).Count',
    'function Initialize-InstallerNativeFileApi { throw "forced_native_init_failure" }',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$category = ""',
    'try { New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 }) | Out-Null } catch { $category = $_.Exception.Message }',
    '$after = @(Get-ChildItem -LiteralPath $tempRoot -Force).Count',
    '[ordered]@{ category = $category; before = $before; after = $after } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { category: 'temporary_path_invalid', before: 0, after: 0 });
});

test('installer temp marker write failure cleans the newly created empty GUID through its creation handle', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$directoryInfo = [System.IO.DirectoryInfo]::new($tempRoot)',
    '$security = if ($PSVersionTable.PSVersion.Major -lt 6) { $directoryInfo.GetAccessControl() } else { [System.IO.FileSystemAclExtensions]::GetAccessControl($directoryInfo) }',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::CreateFiles, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit, [System.Security.AccessControl.PropagationFlags]::InheritOnly, [System.Security.AccessControl.AccessControlType]::Deny)',
    '$security.AddAccessRule($rule) | Out-Null',
    'if ($PSVersionTable.PSVersion.Major -lt 6) { $directoryInfo.SetAccessControl($security) } else { [System.IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $security) }',
    '$category = ""',
    'try { New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 }) | Out-Null } catch { $category = $_.Exception.Message } finally {',
    '  $restore = if ($PSVersionTable.PSVersion.Major -lt 6) { $directoryInfo.GetAccessControl() } else { [System.IO.FileSystemAclExtensions]::GetAccessControl($directoryInfo) }',
    '  $restore.RemoveAccessRuleSpecific($rule)',
    '  if ($PSVersionTable.PSVersion.Major -lt 6) { $directoryInfo.SetAccessControl($restore) } else { [System.IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $restore) }',
    '}',
    '$guidChildren = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Force | Where-Object { $parsed = [guid]::Empty; [guid]::TryParseExact($_.Name, "D", [ref]$parsed) }).Count',
    '$markerCount = @(Get-ChildItem -LiteralPath $tempRoot -File -Filter ".dsh-market-installer-owned" -Recurse -Force).Count',
    '[ordered]@{ category = $category; guidChildren = $guidChildren; markerCount = $markerCount } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { category: 'temporary_path_invalid', guidChildren: 0, markerCount: 0 });
});

test('installer temp ownership requires fixed canonical containment and cleanup rejects reparse descendants', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$functionsPresent = (Get-Command New-InstallerTemporaryDirectory -CommandType Function -ErrorAction SilentlyContinue) -ne $null -and (Get-Command Remove-InstallerTemporaryDirectory -CommandType Function -ErrorAction SilentlyContinue) -ne $null',
    'if (-not $functionsPresent) { [ordered]@{ functionsPresent = $false } | ConvertTo-Json -Compress; return }',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $outside "sentinel.txt"), "outside")',
    'New-Item -ItemType Junction -Path (Join-Path $ownedPath linked) -Target $outside | Out-Null',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned } catch { $category = $_.Exception.Message }',
    '[ordered]@{ functionsPresent = $true; category = $category; outside = [System.IO.File]::ReadAllText((Join-Path $outside "sentinel.txt")); tempExists = Test-Path -LiteralPath $ownedPath } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { functionsPresent: true, category: 'temporary_reparse_rejected', outside: 'outside', tempExists: true });
});

test('installer temp cleanup reports locked-file failure and rejects a forged marker outside an owned instance', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$functionsPresent = (Get-Command New-InstallerTemporaryDirectory -CommandType Function -ErrorAction SilentlyContinue) -ne $null -and (Get-Command Remove-InstallerTemporaryDirectory -CommandType Function -ErrorAction SilentlyContinue) -ne $null',
    'if (-not $functionsPresent) { [ordered]@{ functionsPresent = $false } | ConvertTo-Json -Compress; return }',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords $drives',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$locked = Join-Path $ownedPath locked.bin',
    '[System.IO.File]::WriteAllText($locked, "locked")',
    '$stream = [System.IO.File]::Open($locked, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    '$cleanupCategory = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned } catch { $cleanupCategory = $_.Exception.Message } finally { $stream.Dispose() }',
    '$forgedPath = Join-Path $tempRoot ([guid]::NewGuid().ToString("D"))',
    '[System.IO.Directory]::CreateDirectory($forgedPath) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $forgedPath ".dsh-market-installer-owned"), "forged")',
    '$forgedCategory = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory ([pscustomobject]@{ Path = $forgedPath; Root = $tempRoot; OperationId = [System.IO.Path]::GetFileName($forgedPath); CleanupToken = "wrong"; DriveRecords = $drives }) } catch { $forgedCategory = $_.Exception.Message }',
    '[ordered]@{ functionsPresent = $true; cleanupCategory = $cleanupCategory; publicCategory = Get-PublicInstallerErrorCategory -Message "temporary_cleanup_failed_rolled_back"; lockedRootExists = Test-Path -LiteralPath $ownedPath; forgedCategory = $forgedCategory; forgedRootExists = Test-Path -LiteralPath $forgedPath } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    functionsPresent: true,
    cleanupCategory: 'temporary_cleanup_failed',
    publicCategory: 'temporary-cleanup',
    lockedRootExists: true,
    forgedCategory: 'temporary_ownership_invalid',
    forgedRootExists: true,
  });
});

test('installer temp root identity is locked from creation through cleanup', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '[System.IO.File]::WriteAllText((Join-Path $ownedPath "original.txt"), "original")',
    '$moved = $ownedPath + "-moved"',
    '$moveBlocked = $false',
    'try {',
    '  Move-Item -LiteralPath $ownedPath -Destination $moved -ErrorAction Stop',
    '} catch { $moveBlocked = $true }',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned | Out-Null } catch { $category = $_.Exception.Message }',
    '[ordered]@{ moveBlocked = $moveBlocked; category = $category; pathExists = Test-Path -LiteralPath $ownedPath; movedExists = Test-Path -LiteralPath $moved } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { moveBlocked: true, category: '', pathExists: false, movedExists: false });
});

test('installer temp cleanup rejects a copied capability without the creation handle', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords $drives',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '[System.IO.File]::WriteAllText((Join-Path $ownedPath "sentinel.txt"), "must-remain")',
    '$copied = $owned.PSObject.Copy()',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $copied | Out-Null } catch { $category = $_.Exception.Message }',
    '$preserved = Test-Path -LiteralPath $ownedPath',
    '$sentinel = if (Test-Path -LiteralPath (Join-Path $ownedPath "sentinel.txt")) { [System.IO.File]::ReadAllText((Join-Path $ownedPath "sentinel.txt")) } else { "<missing>" }',
    '$cleaned = Remove-InstallerTemporaryDirectory -OwnedDirectory $owned',
    '[ordered]@{ category = $category; preserved = $preserved; sentinel = $sentinel; cleaned = [bool]$cleaned; existsAfter = Test-Path -LiteralPath $ownedPath } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { category: 'temporary_ownership_invalid', preserved: true, sentinel: 'must-remain', cleaned: true, existsAfter: false });
});

test('installer temp cleanup rejects copied and reconstructed opaque capabilities', async (t) => {
  const attacks = ['shallow-copy', 'rebuilt-wrapper', 'property-bearing-rebuild'] as const;
  for (const attack of attacks) {
    await t.test(attack, async (child) => {
      const output = await invokeInstallerPowerShell(child, [
        DOT_SOURCE_AND_READ_INPUT,
        '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
        '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
        '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
        '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
        '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords $drives',
        '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
        '[System.IO.File]::WriteAllText((Join-Path $ownedPath "sentinel-a.txt"), "sentinel-a")',
        '$candidate = $owned',
        'switch ([string]$inputData.attack) {',
        '  "shallow-copy" { $candidate = $owned.PSObject.Copy() }',
        '  "rebuilt-wrapper" { $candidate = [psobject]::new() }',
        '  "property-bearing-rebuild" { $candidate = [pscustomobject]@{ Capability = $owned; Path = $ownedPath } }',
        '}',
        '$category = ""',
        'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $candidate | Out-Null } catch { $category = $_.Exception.Message }',
        '$aSentinel = @(Get-ChildItem -LiteralPath $tempRoot -Filter sentinel-a.txt -File -Recurse -Force).Count',
        '[ordered]@{ category = $category; aSentinel = $aSentinel; childCount = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Force).Count } | ConvertTo-Json -Compress',
      ].join('\n'), { attack });

      assert.deepEqual(parseJsonOutput(output), { category: 'temporary_ownership_invalid', aSentinel: 1, childCount: 1 });
    });
  }
});

test('failed installer temp cleanup cannot be retried after the blocking condition clears', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$locked = Join-Path $ownedPath locked.bin',
    '[System.IO.File]::WriteAllText($locked, "diagnostic")',
    '$stream = [System.IO.File]::Open($locked, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    '$first = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned | Out-Null } catch { $first = $_.Exception.Message } finally { $stream.Dispose() }',
    '$second = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned | Out-Null } catch { $second = $_.Exception.Message }',
    '$sentinel = if (Test-Path -LiteralPath $locked -PathType Leaf) { [System.IO.File]::ReadAllText($locked) } else { "<missing>" }',
    '[ordered]@{ first = $first; second = $second; exists = Test-Path -LiteralPath $ownedPath; sentinel = $sentinel } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    first: 'temporary_cleanup_failed',
    second: 'temporary_cleanup_failed',
    exists: true,
    sentinel: 'diagnostic',
  });
});

test('successful installer temp cleanup is idempotent without reopening the old path', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '[System.IO.File]::WriteAllText((Join-Path $ownedPath "payload.bin"), "payload")',
    '$first = Remove-InstallerTemporaryDirectory -OwnedDirectory $owned',
    '$secondCategory = ""',
    '$second = $false',
    'try { $second = Remove-InstallerTemporaryDirectory -OwnedDirectory $owned } catch { $secondCategory = $_.Exception.Message }',
    '[ordered]@{ first = [bool]$first; second = [bool]$second; secondCategory = $secondCategory; exists = Test-Path -LiteralPath $ownedPath } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), { first: true, second: true, secondCategory: '', exists: false });
});

test('installer temp cleanup holds root identity and fails closed when a child is replaced after enumeration', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords $drives',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$child = Join-Path $ownedPath child',
    '[System.IO.Directory]::CreateDirectory($child) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $child "payload.txt"), "payload")',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '[System.IO.File]::WriteAllText((Join-Path $outside "sentinel.txt"), "outside-sentinel")',
    '$status = Join-Path $env:DSH_INSTALLER_TEST_ROOT hook-status.txt',
    '$hook = {',
    '  $events = @()',
    '  try { Move-Item -LiteralPath $ownedPath -Destination ($ownedPath + "-moved") -ErrorAction Stop; New-Item -ItemType Junction -Path $ownedPath -Target $outside -ErrorAction Stop | Out-Null; $events += "root-replaced" } catch { $events += "root-blocked" }',
    '  if (Test-Path -LiteralPath $ownedPath -PathType Container) {',
    '    try { Move-Item -LiteralPath $child -Destination ($child + "-original") -ErrorAction Stop; New-Item -ItemType Junction -Path $child -Target $outside -ErrorAction Stop | Out-Null; $events += "child-replaced" } catch { $events += "child-blocked" }',
    '  }',
    '  [System.IO.File]::WriteAllLines($status, $events)',
    '  throw "temporary_identity_changed"',
    '}',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned -AfterEnumeration $hook | Out-Null } catch { $category = $_.Exception.Message }',
    '$events = if (Test-Path -LiteralPath $status) { @([System.IO.File]::ReadAllLines($status)) } else { @() }',
    '[ordered]@{ category = $category; events = $events; outside = [System.IO.File]::ReadAllText((Join-Path $outside "sentinel.txt")); ownedExists = Test-Path -LiteralPath $ownedPath } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'temporary_identity_changed',
    events: ['root-blocked', 'child-replaced'],
    outside: 'outside-sentinel',
    ownedExists: true,
  });
});

test('installer temp cleanup performs zero deletion when a descendant locks after enumeration', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$marker = Join-Path $ownedPath ".dsh-market-installer-owned"',
    '$diagnostic = Join-Path $ownedPath "a-diagnostic.txt"',
    '$locked = Join-Path $ownedPath "z-locked.txt"',
    '[System.IO.File]::WriteAllText($diagnostic, "diagnostic-bytes")',
    '[System.IO.File]::WriteAllText($locked, "locked-bytes")',
    '$markerBefore = [System.IO.File]::ReadAllText($marker)',
    '$script:lockedStream = $null',
    '$hook = { $script:lockedStream = [System.IO.File]::Open($locked, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned -AfterEnumeration $hook | Out-Null } catch { $category = $_.Exception.Message } finally { if ($script:lockedStream -ne $null) { $script:lockedStream.Dispose() } }',
    '$markerAfter = if (Test-Path -LiteralPath $marker -PathType Leaf) { [System.IO.File]::ReadAllText($marker) } else { "<missing>" }',
    '$diagnosticAfter = if (Test-Path -LiteralPath $diagnostic -PathType Leaf) { [System.IO.File]::ReadAllText($diagnostic) } else { "<missing>" }',
    '$lockedAfter = if (Test-Path -LiteralPath $locked -PathType Leaf) { [System.IO.File]::ReadAllText($locked) } else { "<missing>" }',
    '[ordered]@{ category = $category; rootExists = Test-Path -LiteralPath $ownedPath; markerStable = $markerAfter -ceq $markerBefore; diagnostic = $diagnosticAfter; locked = $lockedAfter } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'temporary_cleanup_failed',
    rootExists: true,
    markerStable: true,
    diagnostic: 'diagnostic-bytes',
    locked: 'locked-bytes',
  });
});

test('installer temp cleanup preserves the exact diagnostic tree when a later file is readonly', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$marker = Join-Path $ownedPath ".dsh-market-installer-owned"',
    '$diagnostic = Join-Path $ownedPath "a-diagnostic.txt"',
    '$readonly = Join-Path $ownedPath "z-readonly.txt"',
    '[System.IO.File]::WriteAllText($diagnostic, "diagnostic-before")',
    '[System.IO.File]::WriteAllText($readonly, "readonly-before")',
    '[System.IO.File]::SetAttributes($readonly, [System.IO.FileAttributes]::ReadOnly)',
    '$markerBefore = [System.IO.File]::ReadAllText($marker)',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned | Out-Null } catch { $category = $_.Exception.Message }',
    '$markerAfter = if (Test-Path -LiteralPath $marker -PathType Leaf) { [System.IO.File]::ReadAllText($marker) } else { "<missing>" }',
    '$diagnosticAfter = if (Test-Path -LiteralPath $diagnostic -PathType Leaf) { [System.IO.File]::ReadAllText($diagnostic) } else { "<missing>" }',
    '$readonlyAfter = if (Test-Path -LiteralPath $readonly -PathType Leaf) { [System.IO.File]::ReadAllText($readonly) } else { "<missing>" }',
    '[ordered]@{ category = $category; root = Test-Path -LiteralPath $ownedPath; marker = $markerAfter -ceq $markerBefore; diagnostic = $diagnosticAfter; readonly = $readonlyAfter } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'temporary_cleanup_failed',
    root: true,
    marker: true,
    diagnostic: 'diagnostic-before',
    readonly: 'readonly-before',
  });
});

test('installer temp cleanup cancels every armed disposition when the nth arm fails', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$marker = Join-Path $ownedPath ".dsh-market-installer-owned"',
    '$first = Join-Path $ownedPath "a-first.txt"',
    '$second = Join-Path $ownedPath "b-second.txt"',
    '[System.IO.File]::WriteAllText($first, "first-before")',
    '[System.IO.File]::WriteAllText($second, "second-before")',
    '$markerBefore = [System.IO.File]::ReadAllText($marker)',
    '$category = ""',
    'try { Remove-InstallerTemporaryDirectory -OwnedDirectory $owned -FailDispositionAt 2 | Out-Null } catch { $category = $_.Exception.Message }',
    '$markerAfter = if (Test-Path -LiteralPath $marker -PathType Leaf) { [System.IO.File]::ReadAllText($marker) } else { "<missing>" }',
    '$firstAfter = if (Test-Path -LiteralPath $first -PathType Leaf) { [System.IO.File]::ReadAllText($first) } else { "<missing>" }',
    '$secondAfter = if (Test-Path -LiteralPath $second -PathType Leaf) { [System.IO.File]::ReadAllText($second) } else { "<missing>" }',
    '[ordered]@{ category = $category; root = Test-Path -LiteralPath $ownedPath; marker = $markerAfter -ceq $markerBefore; first = $firstAfter; second = $secondAfter } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    category: 'temporary_cleanup_failed',
    root: true,
    marker: true,
    first: 'first-before',
    second: 'second-before',
  });
});

test('public capability APIs cannot register an existing root and capabilities serialize as opaque markers', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    'Initialize-InstallerNativeFileApi',
    '$tempRoot = Join-Path $env:DSH_INSTALLER_TEST_ROOT safe-temp',
    '[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null',
    '$driveId = [System.IO.Path]::GetPathRoot($tempRoot).TrimEnd("\\")',
    '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$forgedPath = Join-Path $tempRoot ([guid]::NewGuid().ToString("D"))',
    '[System.IO.Directory]::CreateDirectory($forgedPath) | Out-Null',
    '$sentinel = Join-Path $forgedPath "sentinel.txt"',
    '[System.IO.File]::WriteAllText($sentinel, "must-remain")',
    '$registryType = "DshMarketInstaller.CapabilityRegistry" -as [type]',
    '$capabilityType = [DshMarketInstaller.InstallerCapabilities]',
    '$publicMethods = @($capabilityType.GetMethods([Reflection.BindingFlags] "Public,Static,DeclaredOnly"))',
    '$unsafePublicMethod = @($publicMethods | Where-Object { $_.Name -match "(?i)register|authorize|adopt|existing" -or @($_.GetParameters().ParameterType.Name) -match "(?i)LockedPath|SafeHandle|CapabilityRecord" }).Count -ne 0',
    '$registerVisible = $false',
    '$forgedAuthorized = $false',
    '$forgedBackupAuthorized = $false',
    'if ($registryType -ne $null) {',
    '  $register = @($registryType.GetMethods([Reflection.BindingFlags] "Public,Static") | Where-Object { $_.Name -match "Register" })',
    '  $registerVisible = $register.Count -ne 0',
    '  if ($registerVisible) {',
    '    $token = "a" * 64',
    '    $handle = [DshMarketInstaller.NativeFile]::OpenLocked($forgedPath)',
    '    $wrapper = [pscustomobject]@{ CapabilityId=""; CleanupToken=$token; CreationIdentity=$handle.IdentityKey; DriveRecords=$drives; OperationId=[IO.Path]::GetFileName($forgedPath); Path=$forgedPath; Root=$tempRoot; RootHandle=$handle }',
    '    [IO.File]::WriteAllText((Join-Path $forgedPath ".dsh-market-installer-owned"), ($wrapper.OperationId + "`n" + $token))',
    '    $record = [DshMarketInstaller.CapabilityRegistry]::RegisterTemporary($wrapper, $tempRoot, $forgedPath, $wrapper.OperationId, $token, $handle.IdentityKey, $handle, [string[]]@($driveId), [int[]]@(3))',
    '    $wrapper.CapabilityId = $record.CapabilityId',
    '    try { Remove-InstallerTemporaryDirectory -OwnedDirectory $wrapper | Out-Null; $forgedAuthorized = $true } catch {}',
    '  }',
    '}',
    '$forgedBackup = [psobject]::new()',
    'try { [DshMarketInstaller.InstallerCapabilities]::FinalizeBackup($forgedBackup) | Out-Null; $forgedBackupAuthorized=$true } catch {}',
    '$owned = New-InstallerTemporaryDirectory -TemporaryRoot $tempRoot -DriveRecords $drives',
    '$ownedPath = Get-InstallerTemporaryPath -OwnedDirectory $owned',
    '$dshHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT dsh-home',
    '$profile = Join-Path $dshHome "profiles\\desktop"',
    '[IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[IO.File]::WriteAllText((Join-Path $profile "package.json"), "original")',
    '$state = [pscustomobject]@{ CacheRelativePath=$null; Installed=$false; Version=$null; BundleCount=0 }',
    '$backup = New-ProfileBackup -DshHome $dshHome -RequestedVersion 1.2.3 -CliPath "C:\\Fixture\\dsh.cmd" -CliVersion 1.2.3 -InstalledState $state -DriveRecords $drives',
    '$rendered = @($owned | ConvertTo-Json -Depth 10 -Compress; $owned | Format-List * | Out-String; $owned | Out-String; $owned.ToString(); $backup | ConvertTo-Json -Depth 10 -Compress; $backup | Format-List * | Out-String; $backup | Out-String; $backup.ToString()) -join "`n"',
    '$propertyNames = @($owned.PSObject.Properties.Name) + @($backup.PSObject.Properties.Name) -join ","',
    '$secretRendered = $rendered -match "(?i)cleanup.?token|operation.?token|capability.?id|safehandle|identitykey"',
    '$sensitiveProperty = $propertyNames -match "(?i)token|capabilityid|handle|path|hash|identity"',
    '$backupValid = $false; try { Test-ProfileBackupPreflight -DshHome $dshHome -BackupCapability $backup | Out-Null; $backupValid=$true } catch {}',
    '$tempCleaned = Remove-InstallerTemporaryDirectory -OwnedDirectory $owned',
    '[ordered]@{ registerVisible=$registerVisible; unsafePublicMethod=$unsafePublicMethod; forgedAuthorized=$forgedAuthorized; forgedBackupAuthorized=$forgedBackupAuthorized; forgedRoot=Test-Path -LiteralPath $forgedPath; sentinel=if(Test-Path -LiteralPath $sentinel){[IO.File]::ReadAllText($sentinel)}else{"<missing>"}; secretRendered=$secretRendered; sensitiveProperty=$sensitiveProperty; backupValid=$backupValid; tempCleaned=[bool]$tempCleaned; tempExists=Test-Path -LiteralPath $ownedPath } | ConvertTo-Json -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), {
    registerVisible: false,
    unsafePublicMethod: false,
    forgedAuthorized: false,
    forgedBackupAuthorized: false,
    forgedRoot: true,
    sentinel: 'must-remain',
    secretRendered: false,
    sensitiveProperty: false,
    backupValid: true,
    tempCleaned: true,
    tempExists: false,
  });
});

test('profile package invariant permits only the one managed dependency and bundle change', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$beforePath = Join-Path $env:DSH_INSTALLER_TEST_ROOT before.json',
    '$afterPath = Join-Path $env:DSH_INSTALLER_TEST_ROOT after.json',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '$before = [ordered]@{ bundles = @("unrelated-bundle"); credentials = [ordered]@{ token = "credential-secret-123" }; dependencies = [ordered]@{ unrelated = "9.9.9" } }',
    '$after = [ordered]@{ bundles = @("unrelated-bundle", "dsh-market-intelligence"); credentials = [ordered]@{ token = "credential-secret-123" }; dependencies = [ordered]@{ unrelated = "9.9.9"; "dsh-market-intelligence" = "0.1.0" } }',
    '[System.IO.File]::WriteAllText($beforePath, ($before | ConvertTo-Json -Depth 10), $utf8)',
    '[System.IO.File]::WriteAllText($afterPath, ($after | ConvertTo-Json -Depth 10), $utf8)',
    '[ordered]@{ accepted = Test-ProfilePackageInvariant -BeforePath $beforePath -AfterPath $afterPath -ExpectedInstalled $true -ExpectedVersion 0.1.0 } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), { accepted: true });
});

test('DSH home discovery is precedence-ordered and fails closed on zero or ambiguous known candidates', async (t) => {
  const input = {
    explicit: 'D:\\Explicit\\dsh',
    environment: 'C:\\Environment\\dsh',
    userProfile: 'C:\\Users\\Tester',
    known: ['Z:\\DesktopA\\dsh', 'Z:\\DesktopB\\dsh'],
    profiles: ['D:\\Explicit\\dsh', 'C:\\Environment\\dsh', 'C:\\Users\\Tester\\.dsh', 'Z:\\DesktopA\\dsh', 'Z:\\DesktopB\\dsh'],
    drives: [
      { DeviceID: 'C:', DriveType: 3 },
      { DeviceID: 'D:', DriveType: 3 },
      { DeviceID: 'Z:', DriveType: 3 },
    ],
  };
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    'Resolve-DshHome -DshHome ([string]$inputData.explicit) -EnvironmentHome ([string]$inputData.environment) -UserProfilePath ([string]$inputData.userProfile) -KnownCandidates @($inputData.known) -ExistingDesktopProfiles @($inputData.profiles) -DriveRecords @($inputData.drives) | ConvertTo-Json -Compress',
  ].join('\n'), input);
  assert.equal(parseJsonOutput(output), 'D:\\Explicit\\dsh');

  for (const known of [[], ['Z:\\DesktopA\\dsh', 'Z:\\DesktopB\\dsh']]) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        'Resolve-DshHome -EnvironmentHome "" -UserProfilePath "" -KnownCandidates @($inputData.known) -ExistingDesktopProfiles @($inputData.known) -DriveRecords @($inputData.drives) | Out-Null',
      ].join('\n'), { known, drives: [{ DeviceID: 'Z:', DriveType: 3 }] }),
      /unable to resolve|multiple DSH homes/i,
    );
  }
});

test('DSH home discovery covers environment, default-home, and one known candidate in order', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$common = @{ DriveRecords = @($inputData.drives) }',
    '$fromEnvironment = Resolve-DshHome -DshHome "" -EnvironmentHome "C:\\Environment\\dsh" -UserProfilePath "C:\\Users\\Tester" -KnownCandidates @("Z:\\Known\\dsh") -ExistingDesktopProfiles @("C:\\Environment\\dsh", "C:\\Users\\Tester\\.dsh", "Z:\\Known\\dsh") @common',
    '$fromDefault = Resolve-DshHome -DshHome "" -EnvironmentHome "" -UserProfilePath "C:\\Users\\Tester" -KnownCandidates @("Z:\\Known\\dsh") -ExistingDesktopProfiles @("C:\\Users\\Tester\\.dsh", "Z:\\Known\\dsh") @common',
    '$fromKnown = Resolve-DshHome -DshHome "" -EnvironmentHome "" -UserProfilePath "C:\\Users\\Tester" -KnownCandidates @("Z:\\Known\\dsh") -ExistingDesktopProfiles @("Z:\\Known\\dsh") @common',
    '[ordered]@{ environment = $fromEnvironment; defaultHome = $fromDefault; known = $fromKnown } | ConvertTo-Json -Compress',
  ].join('\n'), { drives: [{ DeviceID: 'C:', DriveType: 3 }, { DeviceID: 'Z:', DriveType: 3 }] });

  assert.deepEqual(parseJsonOutput(output), {
    environment: 'C:\\Environment\\dsh',
    defaultHome: 'C:\\Users\\Tester\\.dsh',
    known: 'Z:\\Known\\dsh',
  });
});

test('DSH command discovery uses explicit, PATH, then managed candidates without scanning', async (t) => {
  const input = {
    explicit: 'D:\\Tools\\dsh.cmd',
    pathCommands: ['C:\\Path\\dsh.cmd'],
    managed: ['C:\\Users\\Tester\\AppData\\Local\\DSH Desktop\\dsh.cmd'],
    existing: ['D:\\Tools\\dsh.cmd', 'C:\\Path\\dsh.cmd', 'C:\\Users\\Tester\\AppData\\Local\\DSH Desktop\\dsh.cmd'],
    drives: [{ DeviceID: 'C:', DriveType: 3 }, { DeviceID: 'D:', DriveType: 3 }],
  };
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    'Resolve-DshCommand -DshCommand ([string]$inputData.explicit) -PathCommands @($inputData.pathCommands) -ManagedCommands @($inputData.managed) -ExistingCommands @($inputData.existing) -DriveRecords @($inputData.drives) | ConvertTo-Json -Compress',
  ].join('\n'), input);
  assert.equal(parseJsonOutput(output), 'D:\\Tools\\dsh.cmd');

  await assert.rejects(
    invokeInstallerPowerShell(t, [
      DOT_SOURCE_AND_READ_INPUT,
      'Resolve-DshCommand -PathCommands @($inputData.pathCommands) -ManagedCommands @() -ExistingCommands @($inputData.pathCommands) -DriveRecords @($inputData.drives) | Out-Null',
    ].join('\n'), {
      pathCommands: ['C:\\One\\dsh.cmd', 'D:\\Two\\dsh.exe'],
      drives: [{ DeviceID: 'C:', DriveType: 3 }, { DeviceID: 'D:', DriveType: 3 }],
    }),
    /multiple DSH commands/i,
  );
});

test('DSH command discovery prefers one PATH command and falls back to one managed command', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$common = @{ ExistingCommands = @($inputData.existing); DriveRecords = @($inputData.drives) }',
    '$fromPath = Resolve-DshCommand -DshCommand "" -PathCommands @("D:\\Path\\dsh.cmd") -ManagedCommands @("C:\\Managed\\dsh.cmd") @common',
    '$fromManaged = Resolve-DshCommand -DshCommand "" -PathCommands @() -ManagedCommands @("C:\\Managed\\dsh.cmd") @common',
    '[ordered]@{ path = $fromPath; managed = $fromManaged } | ConvertTo-Json -Compress',
  ].join('\n'), {
    existing: ['D:\\Path\\dsh.cmd', 'C:\\Managed\\dsh.cmd'],
    drives: [{ DeviceID: 'C:', DriveType: 3 }, { DeviceID: 'D:', DriveType: 3 }],
  });

  assert.deepEqual(parseJsonOutput(output), {
    path: 'D:\\Path\\dsh.cmd',
    managed: 'C:\\Managed\\dsh.cmd',
  });
});

test('home and command discovery treat bracket paths literally', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$fixtureHome = Join-Path $env:DSH_INSTALLER_TEST_ROOT "home[2026]"',
    '$profile = Join-Path $fixtureHome "profiles\\desktop"',
    '$command = Join-Path $env:DSH_INSTALLER_TEST_ROOT "managed[preview]\\dsh.cmd"',
    '[System.IO.Directory]::CreateDirectory($profile) | Out-Null',
    '[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($command)) | Out-Null',
    '[System.IO.File]::WriteAllText($command, "exit 0")',
    '$driveId = [System.IO.Path]::GetPathRoot($fixtureHome).TrimEnd("\\")',
    '$drives = @([pscustomobject]@{ DeviceID = $driveId; DriveType = 3 })',
    '$resolvedHome = Resolve-DshHome -DshHome $fixtureHome -EnvironmentHome "" -UserProfilePath "" -DriveRecords $drives',
    '$resolvedCommand = Resolve-DshCommand -DshCommand $command -DriveRecords $drives',
    '[ordered]@{ home = $resolvedHome; command = $resolvedCommand } | ConvertTo-Json -Compress',
  ].join('\n'));
  const values = parseJsonOutput<{ command: string; home: string }>(output);
  assert.match(values.home, /home\[2026\]$/);
  assert.match(values.command, /managed\[preview\]\\dsh\.cmd$/);
});

test('process gate selects only records owned by DSH Desktop or its managed host roots', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$owned = Select-OwnedDshProcess -ProcessRecords @($inputData.processes) -OwnedRoots @($inputData.roots)',
    '@($owned | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress',
  ].join('\n'), {
    roots: ['C:\\Program Files\\DSH Desktop', 'D:\\AI\\dsh\\managed-host', 'D:\\AI\\dsh\\managed host'],
    processes: [
      { ProcessId: 101, ExecutablePath: 'C:\\Program Files\\DSH Desktop\\DSH.exe', CommandLine: '"C:\\Program Files\\DSH Desktop\\DSH.exe"' },
      { ProcessId: 102, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node server.js' },
      { ProcessId: 103, ExecutablePath: 'C:\\Apps\\electron.exe', CommandLine: 'electron unrelated-app' },
      { ProcessId: 104, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host\\server.js"' },
      { ProcessId: 105, ExecutablePath: 'C:\\Program Files\\DSH Desktop Evil\\DSH.exe', CommandLine: 'unrelated' },
      { ProcessId: 106, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host\\..\\unrelated\\server.js"' },
      { ProcessId: 107, ExecutablePath: 'C:\\Apps\\electron.exe', CommandLine: 'electron --label="D:\\AI\\dsh\\managed-host" unrelated-app' },
      { ProcessId: 108, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-hosted\\server.js"' },
      { ProcessId: 109, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node prefix"D:\\AI\\dsh\\managed-host\\server.js"' },
      { ProcessId: 110, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host\\child\\..\\server.js"' },
      { ProcessId: 111, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: "node 'D:\\AI\\dsh\\managed-host\\server.js'" },
      { ProcessId: 112, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host\\server.js\\" trailing' },
      { ProcessId: 113, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed host\\server.js"' },
      { ProcessId: 114, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host\\server.js' },
      { ProcessId: 115, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: String.raw`node "D:\AI\dsh\managed-host\folder\\"` },
      { ProcessId: 116, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node "D:\\AI\\dsh\\managed-host-neighbor\\server.js"' },
    ],
  });
  assert.deepEqual(parseJsonOutput(output), [101, 104, 113, 115]);
});

test('missing and blank command lines provide no native argv ownership evidence', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_INSTALLER_SCRIPT)',
    '$checkerPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName',
    '$checkerRoot = [System.IO.Path]::GetDirectoryName($checkerPath)',
    '$records = @(',
    '  [pscustomobject]@{ ProcessId = 201; ExecutablePath = "C:\\Unrelated\\node.exe" },',
    '  [pscustomobject]@{ ProcessId = 202; ExecutablePath = "C:\\Unrelated\\node.exe"; CommandLine = $null },',
    '  [pscustomobject]@{ ProcessId = 203; ExecutablePath = "C:\\Unrelated\\node.exe"; CommandLine = "" },',
    '  [pscustomobject]@{ ProcessId = 204; ExecutablePath = "C:\\Unrelated\\node.exe"; CommandLine = "   `t" },',
    '  [pscustomobject]@{ ProcessId = 205; ExecutablePath = (Join-Path $checkerRoot "owned-host.exe"); CommandLine = "" }',
    ')',
    '$owned = Select-OwnedDshProcess -ProcessRecords $records -OwnedRoots @($checkerRoot)',
    '$ownedIds = @($owned | ForEach-Object { [int]$_.ProcessId })',
    'ConvertTo-Json -InputObject $ownedIds -Compress',
  ].join('\n'));

  assert.deepEqual(parseJsonOutput(output), [205]);
});

test('opaque operation log blocks live directory rename and junction replacement', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    'Initialize-InstallerNativeFileApi',
    '$log = [DshMarketInstaller.InstallerCapabilities]::CreateOperationLog([System.IO.Path]::GetTempPath())',
    '$view = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($log)',
    '[DshMarketInstaller.InstallerCapabilities]::AppendOperationLog($log, "{`"event`":`"InstallerPhase`"}")',
    '$directory = [System.IO.Path]::GetDirectoryName($view.LogPath)',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT "outside-log"',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '$renameBlocked = $false',
    'try { Move-Item -LiteralPath $directory -Destination ($directory + "-moved") -ErrorAction Stop } catch { $renameBlocked = $true }',
    '$junctionBlocked = $false',
    'try { New-Item -ItemType Junction -Path $directory -Target $outside -ErrorAction Stop | Out-Null } catch { $junctionBlocked = $true }',
    '$closed = [DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($log)',
    '$content = [System.IO.File]::ReadAllText($closed.LogPath, [System.Text.Encoding]::UTF8)',
    '[ordered]@{ renameBlocked = $renameBlocked; junctionBlocked = $junctionBlocked; outsideEntries = @(Get-ChildItem -LiteralPath $outside -Force).Count; content = $content; samePath = $closed.LogPath -ceq $view.LogPath } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    renameBlocked: true,
    junctionBlocked: true,
    outsideEntries: 0,
    content: '{"event":"InstallerPhase"}\r\n',
    samePath: true,
  });
});

test('operation log refuses further writes after a hardlink appears', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    'Initialize-InstallerNativeFileApi',
    '$log = [DshMarketInstaller.InstallerCapabilities]::CreateOperationLog([System.IO.Path]::GetTempPath())',
    '$view = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($log)',
    '[DshMarketInstaller.InstallerCapabilities]::AppendOperationLog($log, "{`"event`":`"InstallerPhase`"}")',
    '$outsideDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-market-log-outside-" + [guid]::NewGuid().ToString("D"))',
    '[System.IO.Directory]::CreateDirectory($outsideDirectory) | Out-Null',
    '$outside = Join-Path $outsideDirectory "outside-log-link.log"',
    'New-Item -ItemType HardLink -Path $outside -Target $view.LogPath -ErrorAction Stop | Out-Null',
    '$appendCategory = ""',
    'try { [DshMarketInstaller.InstallerCapabilities]::AppendOperationLog($log, "{`"event`":`"InstallerResult`"}") } catch { $appendCategory = $_.Exception.InnerException.Message }',
    '$completeCategory = ""',
    'try { [DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($log) | Out-Null } catch { $completeCategory = $_.Exception.InnerException.Message }',
    '$outsideValue = [System.IO.File]::ReadAllText($outside, [System.Text.Encoding]::UTF8)',
    'Remove-Item -LiteralPath $outside -Force',
    'Remove-Item -LiteralPath $outsideDirectory -Force',
    '[ordered]@{ appendCategory = $appendCategory; completeCategory = $completeCategory; outsideValue = $outsideValue } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    appendCategory: 'file_identity_invalid',
    completeCategory: 'file_identity_invalid',
    outsideValue: '{"event":"InstallerPhase"}\r\n',
  });
});

test('operation log write failure still closes the handle and discloses its verified path', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$script:coreCalled = $false',
    'function Invoke-DshMarketInstallCore { $script:coreCalled = $true }',
    'function Write-InstallerLog { throw "simulated_log_write_failure" }',
    '$lines = New-Object System.Collections.Generic.List[string]',
    '$category = ""',
    'try { Invoke-DshMarketInstall -AcceptLicense -WhatIf | ForEach-Object { $lines.Add([string]$_) } } catch { $category = $_.Exception.Message }',
    '$paths = @($lines | Where-Object { $_ -match "\\Ainstaller_log=" } | ForEach-Object { $_.Substring("installer_log=".Length) })',
    '$exists = $paths.Count -eq 1 -and (Test-Path -LiteralPath $paths[0] -PathType Leaf)',
    '[ordered]@{ category = $category; coreCalled = $script:coreCalled; pathCount = $paths.Count; exists = $exists } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    category: 'operation_log_write_failed',
    coreCalled: false,
    pathCount: 1,
    exists: true,
  });
});

test('operation log creation failure stops before installer discovery or mutation', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$script:coreCalled = $false',
    'function New-InstallerOperationLog { throw "simulated_log_create_failure" }',
    'function Invoke-DshMarketInstallCore { $script:coreCalled = $true }',
    '$category = ""',
    'try { Invoke-DshMarketInstall -AcceptLicense -WhatIf } catch { $category = $_.Exception.Message }',
    '[ordered]@{ category = $category; coreCalled = $script:coreCalled } | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), {
    category: 'simulated_log_create_failure',
    coreCalled: false,
  });
});

test('installer logs contain a fixed event and ordered allowlisted fields only', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$operationLog = New-InstallerOperationLog',
    '$logPath = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($operationLog).LogPath',
    '$data = [ordered]@{ version = "0.1.0"; phase = "discovery"; resultCode = 0 }',
    'Write-InstallerLog -OperationLog $operationLog -EventName InstallerPhase -Data $data',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null',
    'Get-Content -LiteralPath $logPath -Raw',
  ].join('\n'));
  assert.deepEqual(JSON.parse(output.replace(/^\uFEFF/, '').trim()), {
    event: 'InstallerPhase',
    phase: 'discovery',
    resultCode: 0,
    version: '0.1.0',
  });

  await assert.rejects(
    invokeInstallerPowerShell(t, [
      DOT_SOURCE_AND_READ_INPUT,
      '$operationLog = New-InstallerOperationLog',
      '$data = [ordered]@{ phase = "discovery"; credential = "seeded-secret" }',
      'Write-InstallerLog -OperationLog $operationLog -EventName InstallerPhase -Data $data',
    ].join('\n')),
    /log field/i,
  );
});

test('installer log schemas reject secrets, HTTP bodies, and CLI output inside allowed fields without echoing values', async (t) => {
  const unsafeRows = [
    { event: 'InstallerPhase seeded-secret', field: 'phase', value: 'discovery' },
    { event: 'InstallerPhase', field: 'phase', value: 'discovery seeded-secret' },
    { event: 'InstallerPhase', field: 'path', value: 'Authorization: Bearer seeded-secret' },
    { event: 'InstallerResult', field: 'rollbackResult', value: '{"token":"seeded-secret"}' },
    { event: 'InstallerPhase', field: 'version', value: 'dsh --version: seeded-secret' },
    { event: 'InstallerIntegrity', field: 'assetHash', value: 'HTTP/1.1 500 seeded-secret' },
    { event: 'InstallerResult', field: 'errorCategory', value: 'CLI said seeded-secret' },
  ];

  for (const row of unsafeRows) {
    await assert.rejects(
      invokeInstallerPowerShell(t, [
        DOT_SOURCE_AND_READ_INPUT,
        '$operationLog = New-InstallerOperationLog',
        '$data = [ordered]@{}',
        '$data[[string]$inputData.field] = [string]$inputData.value',
        'Write-InstallerLog -OperationLog $operationLog -EventName ([string]$inputData.event) -Data $data',
      ].join('\n'), row),
      (error) => {
        assert.doesNotMatch(String(error), /seeded-secret/i);
        assert.match(String(error), /log field|log value|installer log/i);
        return true;
      },
    );
  }
});

test('installer log schemas accept only canonical event-specific values', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$operationLog = New-InstallerOperationLog',
    '$logPath = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($operationLog).LogPath',
    '$data = [ordered]@{ operation = "Install"; phase = "integrity"; resultCode = 0; driveRoot = "D:\\"; version = "0.1.0"; assetHash = ("a" * 64); errorCategory = "none" }',
    'Write-InstallerLog -OperationLog $operationLog -EventName InstallerIntegrity -Data $data',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null',
    'Get-Content -LiteralPath $logPath -Raw',
  ].join('\n'));
  assert.deepEqual(JSON.parse(output.replace(/^\uFEFF/, '').trim()), {
    event: 'InstallerIntegrity',
    operation: 'Install',
    phase: 'integrity',
    resultCode: 0,
    driveRoot: 'D:\\',
    version: '0.1.0',
    assetHash: 'a'.repeat(64),
    errorCategory: 'none',
  });
});

test('installer logs never persist or echo path-shaped external content', async (t) => {
  const seededPath = 'D:\\seeded-secret\\HTTP-body\\CLI-output.txt';
  const result = await runInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$operationLog = New-InstallerOperationLog',
    '$logPath = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($operationLog).LogPath',
    '$errorMessage = ""',
    'try { Write-InstallerLog -OperationLog $operationLog -EventName InstallerPhase -Data ([ordered]@{ path = [string]$inputData.path }) } catch { $errorMessage = $_.Exception.Message }',
    '[DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null',
    '$logContent = ""',
    'if (Test-Path -LiteralPath $logPath) { $logContent = [string](Get-Content -LiteralPath $logPath -Raw) }',
    '[ordered]@{ error = $errorMessage; log = $logContent } | ConvertTo-Json -Compress',
  ].join('\n'), { input: { path: seededPath } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /seeded-secret|HTTP-body|CLI-output/i);
  assert.deepEqual(parseJsonOutput(result.stdout.trim()), {
    error: 'Unsafe installer log field: path',
    log: null,
  });
});

test('canonical log fields reject every trailing line terminator without echoing or persistence', async (t) => {
  const rows = [
    ...['LF', 'CR', 'CRLF', 'LINE_SEPARATOR'].map((suffix) => ({ event: 'InstallerPhase', field: 'driveRoot', suffix })),
    ...['LF', 'CR', 'CRLF', 'LINE_SEPARATOR'].map((suffix) => ({ event: 'InstallerPhase', field: 'version', suffix })),
    ...['LF', 'CR', 'CRLF', 'LINE_SEPARATOR'].map((suffix) => ({ event: 'InstallerIntegrity', field: 'assetHash', suffix })),
  ];
  const result = await runInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$suffixes = @{ LF = "`n"; CR = "`r"; CRLF = "`r`n"; LINE_SEPARATOR = [string][char]0x2028 }',
    '$bases = @{ driveRoot = "D:\\"; version = "0.1.0"; assetHash = ("a" * 64) }',
    '$results = @()',
    '$index = 0',
    'foreach ($row in @($inputData)) {',
    '  $operationLog = New-InstallerOperationLog',
    '  $logPath = [DshMarketInstaller.InstallerCapabilities]::GetOperationLogView($operationLog).LogPath',
    '  $data = [ordered]@{}',
    '  $data[[string]$row.field] = [string]$bases[[string]$row.field] + [string]$suffixes[[string]$row.suffix]',
    '  $errorMessage = ""',
    '  try { Write-InstallerLog -OperationLog $operationLog -EventName ([string]$row.event) -Data $data } catch { $errorMessage = $_.Exception.Message }',
    '  [DshMarketInstaller.InstallerCapabilities]::CompleteOperationLog($operationLog) | Out-Null',
    '  $logged = (Test-Path -LiteralPath $logPath) -and ([System.IO.File]::ReadAllText($logPath).Length -gt 0)',
    '  $results += [ordered]@{ field = [string]$row.field; suffix = [string]$row.suffix; error = $errorMessage; logged = [bool]$logged }',
    '  $index++',
    '}',
    '@($results) | ConvertTo-Json -Compress',
  ].join('\n'), { input: rows });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const outcomes = parseJsonOutput<Array<{ error: string; field: string; logged: boolean; suffix: string }>>(result.stdout.trim());
  assert.equal(outcomes.length, 12);
  for (const outcome of outcomes) {
    assert.equal(outcome.logged, false, `${outcome.field}/${outcome.suffix} must not be persisted`);
    assert.equal(outcome.error, `Unsafe installer log value for field: ${outcome.field}`);
  }
});

test('license prompt decision accepts only an explicit affirmative response', async (t) => {
  const output = await invokeInstallerPowerShell(t, [
    DOT_SOURCE_AND_READ_INPUT,
    '$values = @("yes", "YES", "y", "Y", "no", "", " yes", "yes ", $null)',
    '@($values | ForEach-Object { [bool](Test-InstallerLicenseAffirmative -Response $_) }) | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.deepEqual(parseJsonOutput(output), [true, true, true, true, false, false, false, false, false]);
});

test('redirected stdin cannot grant install or uninstall license acceptance', async (t) => {
  const marker = path.join(process.cwd(), `.tmp-direct-installer-marker-${process.pid}-${Date.now()}`);
  t.after(async () => { await rm(marker, { force: true }); });
  for (const operation of ['Install', 'Uninstall']) {
    for (const row of [
      { name: 'piped yes', stdin: 'yes\n' },
      { name: 'piped no', stdin: 'no\n' },
      { name: 'piped blank', stdin: '\n' },
      { name: 'redirected EOF', stdin: null },
    ]) {
      await t.test(`${operation} ${row.name}`, async () => {
      const result = await runInteractiveInstallerPowerShell(t, ['-Operation', operation, '-DshHome', 'relative-fixture-home', '-WhatIf'], { stdin: row.stdin });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stdout, /personal, non-commercial, read-only research/i);
      assert.match(result.stdout, /Tencent and Sina.*not.*authorized/i);
      assert.match(result.stdout, /unofficial.*change.*fail.*unavailable/i);
      assert.match(`${result.stdout}\n${result.stderr}`, /installer_log=.*installer\.log/i);
      assert.equal(result.stderr.trim(), 'installer_failed errorCategory=input');
      assert.doesNotMatch(result.stderr, /version_required/i);
      });
    }
  }
  await assert.rejects(readFile(marker));
});

test('non-interactive installer requires AcceptLicense and still discloses its operation log', async (t) => {
  const result = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_INSTALLER_SCRIPT) -WhatIf',
    'exit $LASTEXITCODE',
  ].join('\n'));
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /installer_log=.*installer\.log/i);
  assert.equal(result.stderr.trim(), 'installer_failed errorCategory=input');
});

test('installer entry points reject seeded invalid versions without echoing or forwarding them', async (t) => {
  const seededVersion = 'seeded-secret-HTTP-body-CLI-output-v01.0.0';
  const installerResult = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_INSTALLER_SCRIPT) -Version ([string]$env:DSH_SEEDED_INVALID_VERSION)',
    'exit $LASTEXITCODE',
  ].join('\n'), { environment: { DSH_SEEDED_INVALID_VERSION: seededVersion } });

  assert.notEqual(installerResult.exitCode, 0);
  assert.match(installerResult.stdout, /^installer_log=.*installer\.log\r?\n$/i);
  assert.equal(installerResult.stderr.trim(), 'installer_failed errorCategory=input');
  assert.doesNotMatch(`${installerResult.stdout}\n${installerResult.stderr}`, new RegExp(seededVersion, 'i'));

  const seededOperation = 'seeded-secret-HTTP-body-CLI-output-operation';
  const operationResult = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_INSTALLER_SCRIPT) -Operation ([string]$env:DSH_SEEDED_INVALID_OPERATION)',
    'exit $LASTEXITCODE',
  ].join('\n'), { environment: { DSH_SEEDED_INVALID_OPERATION: seededOperation } });
  assert.notEqual(operationResult.exitCode, 0);
  assert.match(operationResult.stdout, /^installer_log=.*installer\.log\r?\n$/i);
  assert.equal(operationResult.stderr.trim(), 'installer_failed errorCategory=input');
  assert.doesNotMatch(`${operationResult.stdout}\n${operationResult.stderr}`, new RegExp(seededOperation, 'i'));

  const fixtureRoot = path.join(process.cwd(), `.tmp-uninstall-version-${process.pid}-${Date.now()}`);
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
  await mkdir(fixtureRoot, { recursive: true });
  const uninstallSource = await readFile(path.join(process.cwd(), 'installer', 'uninstall.ps1'), 'utf8');
  const marker = path.join(fixtureRoot, 'forwarded.txt');
  const realInstaller = await readFile(path.join(process.cwd(), 'installer', 'install.ps1'));
  const installerPath = path.join(fixtureRoot, 'install.ps1');
  const uninstallerPath = path.join(fixtureRoot, 'uninstall.ps1');
  await writeFile(installerPath, realInstaller);
  await writeFile(uninstallerPath, uninstallSource, 'utf8');
  await writeFile(path.join(fixtureRoot, 'SHA256SUMS.txt'), `${createHash('sha256').update(realInstaller).digest('hex')}  install.ps1\n`, 'utf8');

  const uninstallerResult = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_UNINSTALLER_FIXTURE) -Version ([string]$env:DSH_SEEDED_INVALID_VERSION)',
    'exit $LASTEXITCODE',
  ].join('\n'), {
    environment: {
      DSH_FORWARD_MARKER: marker,
      DSH_SEEDED_INVALID_VERSION: seededVersion,
      DSH_UNINSTALLER_FIXTURE: uninstallerPath,
    },
  });

  assert.notEqual(uninstallerResult.exitCode, 0);
  assert.match(uninstallerResult.stdout, /^installer_log=.*installer\.log\r?\n$/i);
  assert.equal(uninstallerResult.stderr.trim(), 'installer_failed errorCategory=input');
  assert.doesNotMatch(`${uninstallerResult.stdout}\n${uninstallerResult.stderr}`, new RegExp(seededVersion, 'i'));
  await assert.rejects(readFile(marker));
});

test('uninstaller verifies the sibling installer hash before forwarding safe arguments', async (t) => {
  const fixtureRoot = path.join(process.cwd(), `.tmp-uninstall-fixture-${process.pid}-${Date.now()}`);
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
  await mkdir(fixtureRoot, { recursive: true });

  const uninstallSource = await readFile(path.join(process.cwd(), 'installer', 'uninstall.ps1'), 'utf8');
  const fakeInstaller = [
    'param([string]$Operation, [string]$DshHome, [string]$DshCommand, [string]$Version, [switch]$AllowDowngrade, [switch]$AcceptLicense, [switch]$WhatIf)',
    '[ordered]@{ Operation = $Operation; DshHome = $DshHome; DshCommand = $DshCommand; Version = $Version; AllowDowngrade = [bool]$AllowDowngrade; AcceptLicense = [bool]$AcceptLicense; WhatIf = [bool]$WhatIf } | ConvertTo-Json -Compress',
  ].join('\n');
  const installerPath = path.join(fixtureRoot, 'install.ps1');
  const uninstallerPath = path.join(fixtureRoot, 'uninstall.ps1');
  await writeFile(installerPath, fakeInstaller, 'utf8');
  await writeFile(uninstallerPath, uninstallSource, 'utf8');
  await writeFile(path.join(fixtureRoot, 'LICENSE.txt'), 'release marker', 'utf8');
  const hash = createHash('sha256').update(Buffer.from(fakeInstaller, 'utf8')).digest('hex');
  await writeFile(path.join(fixtureRoot, 'SHA256SUMS.txt'), `${hash}  install.ps1\n`, 'utf8');

  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '& ([string]$env:DSH_UNINSTALLER_FIXTURE) -DshHome "D:\\Fixture DSH" -DshCommand "C:\\DSH\\dsh.cmd" -Version "0.1.0" -AllowDowngrade -AcceptLicense -WhatIf',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n'), undefined, { DSH_UNINSTALLER_FIXTURE: uninstallerPath });
  assert.deepEqual(parseJsonOutput(output), {
    Operation: 'Uninstall',
    DshHome: 'D:\\Fixture DSH',
    DshCommand: 'C:\\DSH\\dsh.cmd',
    Version: '0.1.0',
    AllowDowngrade: true,
    AcceptLicense: true,
    WhatIf: true,
  });

  await writeFile(path.join(fixtureRoot, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  install.ps1\n`, 'utf8');
  const rejected = await runInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Continue'",
    '& ([string]$env:DSH_UNINSTALLER_FIXTURE) -AcceptLicense',
    'exit $LASTEXITCODE',
  ].join('\n'), {
    environment: {
      DSH_UNINSTALLER_FIXTURE: uninstallerPath,
      TEMP: fixtureRoot,
      TMP: fixtureRoot,
    },
  });
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /integrity|checksum|hash/i);
  const integrityLogMatch = rejected.stdout.match(/^installer_log=(.+installer\.log)\r?$/im);
  assert.ok(integrityLogMatch, 'integrity refusal must print its unique operation log path');
  const integrityLog = await readFile(integrityLogMatch[1], 'utf8');
  assert.deepEqual(JSON.parse(integrityLog.trim()), {
    event: 'InstallerResult',
    operation: 'Uninstall',
    phase: 'complete',
    resultCode: 1,
    rollbackResult: 'not-required',
    errorCategory: 'integrity',
  });
});

test('uninstaller predelegation log is handle-bound against live rename, junction, hardlink, and write attacks', async (t) => {
  const fixtureRoot = path.join(process.cwd(), `.tmp-uninstall-log-race-${process.pid}-${Date.now()}`);
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  await mkdir(fixtureRoot, { recursive: true });
  const uninstallSource = await readFile(path.join(process.cwd(), 'installer', 'uninstall.ps1'), 'utf8');
  const uninstallerPath = path.join(fixtureRoot, 'uninstall.ps1');
  await writeFile(uninstallerPath, uninstallSource, 'utf8');

  const output = await invokeInstallerPowerShell(t, [
    "$ErrorActionPreference = 'Stop'",
    '. ([string]$env:DSH_UNINSTALLER_FIXTURE)',
    '$outside = Join-Path $env:DSH_INSTALLER_TEST_ROOT outside',
    '[System.IO.Directory]::CreateDirectory($outside) | Out-Null',
    '$sentinel = Join-Path $outside sentinel.txt',
    '[System.IO.File]::WriteAllText($sentinel, "outside-original")',
    '$renameCap = New-UninstallerBootstrapLog',
    '$renamePath = [string][DshMarketUninstallerLog.Capabilities]::GetView($renameCap).LogPath',
    '$renameDirectory = [System.IO.Path]::GetDirectoryName($renamePath)',
    '$moved = Join-Path $env:DSH_INSTALLER_TEST_ROOT moved-log',
    '$renameBlocked = $false; try { [System.IO.Directory]::Move($renameDirectory, $moved) } catch { $renameBlocked = $true }',
    '$junctionCreated = $false; if (-not $renameBlocked) { try { New-Item -ItemType Junction -Path $renameDirectory -Target $outside -ErrorAction Stop | Out-Null; $junctionCreated = $true } catch {} }',
    '$writeBlocked = $false; try { [System.IO.File]::WriteAllText($renamePath, "attacker") } catch { $writeBlocked = $true }',
    "[DshMarketUninstallerLog.Capabilities]::Complete($renameCap, '{\"event\":\"InstallerResult\"}', $true) | Out-Null",
    '$hardCap = New-UninstallerBootstrapLog',
    '$hardPath = [string][DshMarketUninstallerLog.Capabilities]::GetView($hardCap).LogPath',
    '$hardOutside = Join-Path $outside hardlink.log',
    '$hardlinkCreated = $false; try { New-Item -ItemType HardLink -Path $hardOutside -Target $hardPath -ErrorAction Stop | Out-Null; $hardlinkCreated = $true } catch {}',
    "$hardlinkRejected = $false; try { [DshMarketUninstallerLog.Capabilities]::Complete($hardCap, '{\"event\":\"InstallerResult\"}', $true) | Out-Null } catch { $hardlinkRejected = $true }",
    '$hardOutsideBytes = if (Test-Path -LiteralPath $hardOutside) { [System.IO.File]::ReadAllText($hardOutside) } else { "" }',
    "$expectedLog = '{\"event\":\"InstallerResult\"}' + [Environment]::NewLine",
    '[ordered]@{ renameBlocked=$renameBlocked; junctionCreated=$junctionCreated; writeBlocked=$writeBlocked; hardlinkSafe=(-not $hardlinkCreated -or $hardlinkRejected); hardOutsideBytes=$hardOutsideBytes; sentinel=[System.IO.File]::ReadAllText($sentinel); fixedLog=([System.IO.File]::ReadAllText($renamePath) -ceq $expectedLog) } | ConvertTo-Json -Compress',
  ].join('\n'), undefined, { DSH_UNINSTALLER_FIXTURE: uninstallerPath });

  assert.deepEqual(parseJsonOutput(output), {
    renameBlocked: true,
    junctionCreated: false,
    writeBlocked: true,
    hardlinkSafe: true,
    hardOutsideBytes: '',
    sentinel: 'outside-original',
    fixedLog: true,
  });
});

test('release uninstall entrypoint rejects every redirected license response', async (t) => {
  const fixtureRoot = path.join(process.cwd(), `.tmp-uninstall-license-${process.pid}-${Date.now()}`);
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
  await mkdir(fixtureRoot, { recursive: true });
  const installBytes = await readFile(path.join(process.cwd(), 'installer', 'install.ps1'));
  const uninstallBytes = await readFile(path.join(process.cwd(), 'installer', 'uninstall.ps1'));
  const installerPath = path.join(fixtureRoot, 'install.ps1');
  const uninstallerPath = path.join(fixtureRoot, 'uninstall.ps1');
  await writeFile(installerPath, installBytes);
  await writeFile(uninstallerPath, uninstallBytes);
  await writeFile(path.join(fixtureRoot, 'SHA256SUMS.txt'), `${createHash('sha256').update(installBytes).digest('hex')}  install.ps1\n`, 'utf8');

  for (const row of [
    { stdin: 'yes\n' },
    { stdin: 'no\n' },
    { stdin: '\n' },
    { stdin: null },
  ]) {
    const result = await runInteractiveInstallerPowerShell(t, ['-DshHome', 'relative-fixture-home', '-WhatIf'], {
      scriptPath: uninstallerPath,
      stdin: row.stdin,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /personal, non-commercial, read-only research/i);
    assert.match(result.stdout, /Tencent and Sina.*not.*authorized/i);
    assert.match(result.stdout, /installer_log=.*installer\.log/i);
    assert.equal(result.stderr.trim(), 'installer_failed errorCategory=input');
  }
});

test('release uninstaller fails closed for missing, malformed, duplicate, and traversal manifests', async (t) => {
  const fixtureRoot = path.join(process.cwd(), `.tmp-uninstall-invalid-${process.pid}-${Date.now()}`);
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
  await mkdir(fixtureRoot, { recursive: true });

  const uninstallSource = await readFile(path.join(process.cwd(), 'installer', 'uninstall.ps1'), 'utf8');
  const marker = path.join(fixtureRoot, 'forwarded.txt');
  const fakeInstaller = [
    'param([string]$Operation, [switch]$AcceptLicense)',
    '[System.IO.File]::WriteAllText([string]$env:DSH_FORWARD_MARKER, [string]$Operation)',
  ].join('\n');
  const installerPath = path.join(fixtureRoot, 'install.ps1');
  const uninstallerPath = path.join(fixtureRoot, 'uninstall.ps1');
  const manifestPath = path.join(fixtureRoot, 'SHA256SUMS.txt');
  await writeFile(installerPath, fakeInstaller, 'utf8');
  await writeFile(uninstallerPath, uninstallSource, 'utf8');
  await writeFile(path.join(fixtureRoot, 'LICENSE.txt'), 'release marker', 'utf8');
  const hash = createHash('sha256').update(Buffer.from(fakeInstaller, 'utf8')).digest('hex');
  const cases: Array<string | null> = [
    null,
    'not-a-canonical-manifest\n',
    `${hash}  install.ps1\n${hash}  INSTALL.PS1\n`,
    `${hash}  install.ps1\n${hash}  ..\\payload.ps1\n`,
    ...[
      '',
      '.leading',
      '-leading.tgz',
      'trailing.',
      'trailing-',
      'has space.tgz',
      'extra.tgz\u2028',
      'extra.tgz\u2029',
      'extra.tgz\u00a0',
      'extra.tgz\u200b',
      'extra.tgz\u202e',
      'extra.tgz\rX',
      'extra.tgz\nX',
      'extra.tgz\r\nX',
    ].map((name) => `${hash}  install.ps1\n${hash}  ${name}\n`),
  ];

  for (const [caseIndex, manifest] of cases.entries()) {
    await rm(marker, { force: true });
    if (manifest === null) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, manifest, 'utf8');
    const result = await runInstallerPowerShell(t, [
      "$ErrorActionPreference = 'Continue'",
      '& ([string]$env:DSH_UNINSTALLER_FIXTURE) -AcceptLicense',
      'exit $LASTEXITCODE',
    ].join('\n'), {
      environment: {
        DSH_FORWARD_MARKER: marker,
        DSH_UNINSTALLER_FIXTURE: uninstallerPath,
      },
    });
    assert.notEqual(result.exitCode, 0, `manifest attack case ${caseIndex} must fail closed`);
    assert.match(result.stderr, /integrity|checksum|manifest/i, `manifest attack case ${caseIndex} must report fixed integrity category`);
    await assert.rejects(readFile(marker));
  }
});
