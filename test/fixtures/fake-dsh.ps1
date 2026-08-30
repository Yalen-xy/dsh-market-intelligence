$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace([string]$env:DSH_FAKE_CONTROL) -or
    -not (Test-Path -LiteralPath $env:DSH_FAKE_CONTROL -PathType Leaf)) {
    throw 'fake_cli_control_missing'
}
$control = Get-Content -LiteralPath $env:DSH_FAKE_CONTROL -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$env:DSH_HOME) -or
    -not [string]::Equals([string]$env:DSH_HOME, [string]$control.dshHome, [System.StringComparison]::Ordinal)) {
    throw 'fake_cli_home_invalid'
}

function Write-FakeCall {
    param([Parameter(Mandatory = $true)][string]$Operation)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText([string]$control.callLog, $Operation + [System.Environment]::NewLine, $encoding)
}

if ($args.Count -eq 1 -and [string]$args[0] -eq '--version') {
    Write-FakeCall -Operation 'identity'
    if ([bool]$control.invalidIdentity) { Write-Output 'not-dsh seeded-cli-output'; return }
    Write-Output 'dsh 1.2.3'
    return
}
if ($args.Count -eq 2 -and [string]$args[0] -eq 'plugin' -and [string]$args[1] -eq '--help') {
    Write-FakeCall -Operation 'capability'
    if ([bool]$control.missingCapability) { Write-Output 'plugin list'; return }
    Write-Output 'plugin --profile desktop add remove validate'
    return
}

if ($args.Count -lt 4 -or [string]$args[0] -ne 'plugin' -or [string]$args[1] -ne '--profile' -or
    [string]$args[2] -ne 'desktop') {
    throw 'fake_cli_arguments_invalid'
}
$verb = [string]$args[3]
$profileRoot = Join-Path ([string]$env:DSH_HOME) 'profiles\desktop'
$profilePackagePath = Join-Path $profileRoot 'package.json'

if ($verb -eq 'validate' -and $args.Count -eq 4) {
    Write-FakeCall -Operation 'validate'
    $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
    if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) { throw 'fake_cli_patch_invalid' }
    $patch = [System.IO.File]::ReadAllText($patchPath)
    if ($patch -notmatch '(?m)^fixturePatch:') { throw 'fake_cli_patch_invalid' }
    return
}

if ($verb -eq 'add' -and $args.Count -eq 5) {
    Write-FakeCall -Operation 'add'
    $isRollback = [string]$env:DSH_INSTALLER_ROLLBACK -eq '1'
    if ($isRollback -and [bool]$control.rollbackFailure) { throw 'fake_cli_rollback_failed' }
    $tgzPath = [string]$args[4]
    if (-not (Test-Path -LiteralPath $tgzPath -PathType Leaf)) { throw 'fake_cli_package_missing' }
    $tarCommand = Get-Command tar.exe -CommandType Application -ErrorAction Stop
    $stageRoot = Join-Path $profileRoot ('.fake-dsh-stage-' + [guid]::NewGuid().ToString('D'))
    [System.IO.Directory]::CreateDirectory($stageRoot) | Out-Null
    try {
        & $tarCommand.Path @('-xf', $tgzPath, '-C', $stageRoot) 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'fake_cli_extract_failed' }
        $sourcePackage = Join-Path $stageRoot 'package'
        $packageMetadataPath = Join-Path $sourcePackage 'package.json'
        $packageMetadata = Get-Content -LiteralPath $packageMetadataPath -Raw | ConvertFrom-Json
        $targetParent = Join-Path $profileRoot 'node_modules'
        $targetPackage = Join-Path $targetParent 'dsh-market-intelligence'
        [System.IO.Directory]::CreateDirectory($targetParent) | Out-Null
        if (Test-Path -LiteralPath $targetPackage) { Remove-Item -LiteralPath $targetPackage -Recurse -Force }
        Move-Item -LiteralPath $sourcePackage -Destination $targetPackage

        $cacheRoot = Join-Path $profileRoot '.dsh-market-cache'
        [System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
        Get-ChildItem -LiteralPath $cacheRoot -File -ErrorAction Stop |
            Where-Object { $_.Name -match '\Adsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z' } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
        $cacheName = 'dsh-market-intelligence-' + [string]$packageMetadata.version + '.tgz'
        $cachePath = Join-Path $cacheRoot $cacheName
        Copy-Item -LiteralPath $tgzPath -Destination $cachePath
        if (-not $isRollback -and [string]$control.failStage -eq 'after-package') { throw 'fake_cli_mutation_failed' }

        $profile = Get-Content -LiteralPath $profilePackagePath -Raw | ConvertFrom-Json
        if ($profile.PSObject.Properties['dependencies'] -eq $null) {
            $profile | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
        }
        $profile.dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-market-intelligence' -Value ([string]$packageMetadata.version) -Force
        $bundles = @($profile.bundles | Where-Object { [string]$_ -ne 'dsh-market-intelligence' })
        $profile.bundles = @($bundles + 'dsh-market-intelligence')
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($profilePackagePath, ($profile | ConvertTo-Json -Depth 20), $utf8)
        if (-not $isRollback -and [string]$control.failStage -eq 'after-profile') { throw 'fake_cli_mutation_failed' }

        $lockPath = Join-Path $profileRoot 'pnpm-lock.yaml'
        [System.IO.File]::WriteAllText($lockPath, "fixtureLock: true`nmarketVersion: $($packageMetadata.version)`n")
        $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
        [System.IO.File]::WriteAllText($patchPath, "fixturePatch: true`nmarketBundle: dsh-market-intelligence`n")
        $receiptPath = Join-Path $profileRoot '.dsh-market-intelligence-receipt.json'
        $receiptJson = [ordered]@{ version = [string]$packageMetadata.version; cacheRelativePath = '.dsh-market-cache\' + $cacheName } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($receiptPath, $receiptJson, $utf8)
        if (-not $isRollback) {
            switch ([string]$control.postInstallMutation) {
                'missing-receipt' { Remove-Item -LiteralPath $receiptPath -Force }
                'missing-cache' { Remove-Item -LiteralPath $cachePath -Force }
                'mutate-unrelated' { [System.IO.File]::WriteAllText((Join-Path $profileRoot 'coordination-extra.json'), 'mutated-unrelated', $utf8) }
                'tamper-package' { [System.IO.File]::WriteAllText((Join-Path $targetPackage 'lib\index.js'), 'tampered-package', $utf8) }
                'mutate-directories' {
                    [System.IO.Directory]::Delete((Join-Path $profileRoot 'unrelated-empty'), $true)
                    [System.IO.Directory]::CreateDirectory((Join-Path $profileRoot 'transaction-empty\nested')) | Out-Null
                }
            }
            if ([bool]$control.mutateUnrelatedBeforeFailure) {
                $unrelatedCache = Join-Path $cacheRoot 'unrelated-cache.tgz'
                if (Test-Path -LiteralPath $unrelatedCache) { Remove-Item -LiteralPath $unrelatedCache -Force }
                $unrelatedModule = Join-Path $profileRoot 'node_modules\unrelated-package\index.js'
                if (Test-Path -LiteralPath $unrelatedModule) { Remove-Item -LiteralPath $unrelatedModule -Force }
                [System.IO.File]::WriteAllText((Join-Path $profileRoot 'coordination-extra.json'), 'mutated-unrelated', $utf8)
                [System.IO.File]::WriteAllText((Join-Path $profileRoot 'transaction-created.tmp'), 'created', $utf8)
            }
        }
        if (-not $isRollback -and [string]$control.failStage -eq 'after-coordination') { throw 'fake_cli_mutation_failed' }
        if (-not $isRollback -and [bool]$control.lockInstallerTemp) {
            $global:DshInstallerFixtureLockedStream = [System.IO.File]::Open($tgzPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        }
    }
    finally {
        if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
    }
    return
}

if ($verb -eq 'remove' -and $args.Count -eq 5 -and [string]$args[4] -eq 'dsh-market-intelligence') {
    Write-FakeCall -Operation 'remove'
    $isRollback = [string]$env:DSH_INSTALLER_ROLLBACK -eq '1'
    if ($isRollback -and [bool]$control.rollbackFailure) { throw 'fake_cli_rollback_failed' }
    $receiptPath = Join-Path $profileRoot '.dsh-market-intelligence-receipt.json'
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        try {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            $cachePath = Join-Path $profileRoot ([string]$receipt.cacheRelativePath)
            if (Test-Path -LiteralPath $cachePath -PathType Leaf) { Remove-Item -LiteralPath $cachePath -Force }
        }
        catch { throw 'fake_cli_receipt_invalid' }
    }
    $cacheRoot = Join-Path $profileRoot '.dsh-market-cache'
    if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
        Get-ChildItem -LiteralPath $cacheRoot -File -ErrorAction Stop |
            Where-Object { $_.Name -match '\Adsh-market-intelligence-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz\z' } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    }
    $targetPackage = Join-Path $profileRoot 'node_modules\dsh-market-intelligence'
    if (Test-Path -LiteralPath $targetPackage) { Remove-Item -LiteralPath $targetPackage -Recurse -Force }
    $profile = Get-Content -LiteralPath $profilePackagePath -Raw | ConvertFrom-Json
    if ($profile.PSObject.Properties['dependencies'] -ne $null) {
        $profile.dependencies.PSObject.Properties.Remove('dsh-market-intelligence')
    }
    $profile.bundles = @($profile.bundles | Where-Object { [string]$_ -ne 'dsh-market-intelligence' })
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($profilePackagePath, ($profile | ConvertTo-Json -Depth 20), $utf8)
    [System.IO.File]::WriteAllText((Join-Path $profileRoot 'pnpm-lock.yaml'), "fixtureLock: true`nmarketRemoved: true`n", $utf8)
    [System.IO.File]::WriteAllText((Join-Path $profileRoot 'cordis.patch.yml'), "fixturePatch: true`nmarketRemoved: true`n", $utf8)
    if (Test-Path -LiteralPath $receiptPath) { Remove-Item -LiteralPath $receiptPath -Force }
    if (-not $isRollback) {
        if ([string]$control.uninstallResidual -eq 'receipt') {
            [System.IO.File]::WriteAllText($receiptPath, '{"version":"1.2.3","cacheRelativePath":".dsh-market-cache\\dsh-market-intelligence-1.2.3.tgz"}', $utf8)
        }
        elseif ([string]$control.uninstallResidual -eq 'cache') {
            [System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $cacheRoot 'dsh-market-intelligence-1.2.3.tgz'), 'residual-cache', $utf8)
        }
    }
    if (-not $isRollback -and [string]$control.failStage -eq 'remove-postcondition') {
        $invalidProfile = Get-Content -LiteralPath $profilePackagePath -Raw | ConvertFrom-Json
        $invalidProfile.bundles = @($invalidProfile.bundles + 'dsh-market-intelligence')
        [System.IO.File]::WriteAllText($profilePackagePath, ($invalidProfile | ConvertTo-Json -Depth 20), $utf8)
    }
    return
}

throw 'fake_cli_arguments_invalid'
