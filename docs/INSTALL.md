# Install, upgrade, recover, and uninstall

This guide describes the Windows GitHub Release installer as it is implemented. It is for a valid DSH Desktop `desktop` profile and a DSH-managed CLI that identifies itself and exposes `plugin add` and `plugin remove`.

> Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

The software is not investment advice. Read the [limited-use license](../LICENSE) before installation. Passing `-AcceptLicense` confirms acceptance for automation. Without that switch, an interactive terminal prints the concise limited-use and unofficial Tencent/Sina warning and proceeds only after an explicit `yes` or `y`; blank input, EOF, and every other response reject. Non-interactive use therefore requires `-AcceptLicense`.

## Requirements and safety gate

- Windows PowerShell 5.1 or PowerShell 7.
- Node.js `^22.19.0 || >=24.0.0`, including `node:sqlite`.
- A local-fixed-disk `DSH_HOME` containing `profiles\desktop`.
- A verifiable DSH Desktop managed CLI with `plugin add/remove` support.
- DSH Desktop must be closed before mutation. If DSH Desktop is running from the detected home or managed-command roots, the installer refuses to mutate the profile. It does not stop or restart processes.

Relative, UNC/network, device, removable-drive, non-normalized, traversal, and unresolved reparse-point paths are rejected. The installer does not create a persistent `DSH_HOME` environment variable; it sets the value only for its child CLI process.

## Verified bootstrap

Normal users should use the fixed-name latest ZIP linked from the [root README](../README.md#下载最新版), extract it, and double-click `INSTALL.cmd`. The advanced commands in this guide:

1. creates a new GUID-named directory under the current user's temporary root;
2. downloads `install.ps1` and `SHA256SUMS.txt` from the same Release;
3. parses every non-empty manifest line and requires exactly the four current-version payloads (`install.ps1`, `uninstall.ps1`, the versioned tgz, and `LICENSE.txt`), with lowercase 64-hex hashes, canonical names, no extra/missing rows, no case-insensitive duplicate names, and no duplicate hashes;
4. computes `install.ps1` SHA-256 through the PowerShell 5.1-compatible .NET cryptography API and compares it with the parsed row;
5. invokes the verified file with `&`, never with dynamic expression evaluation;
6. supplies a matching Release API URL and `-Version`;
7. cleans its unique bootstrap directory in `finally` on a best-effort basis.

This first hash protects against accidental corruption and mismatched assets within the GitHub trust domain. It is not a defense against compromise of the repository or GitHub account. The verified installer independently downloads and checks `dsh-market-intelligence-<version>.tgz` against the same Release manifest before handing it to the managed CLI; the bootstrap does not bypass that payload check.

## Discovery and parameters

`install.ps1` resolves the DSH home in this order: explicit `-DshHome`, the current process's `DSH_HOME`, then `%USERPROFILE%\.dsh` when it contains `profiles\desktop`. If it cannot resolve one valid home, it stops and asks for `-DshHome` rather than scanning drives.

The CLI is resolved from explicit `-DshCommand`, one valid `dsh` application on `PATH`, or one recognized DSH Desktop application-data location. Ambiguous or unverifiable candidates fail closed.

| Parameter | Actual behavior |
| --- | --- |
| `-DshHome <path>` | Overrides home discovery. Must be a normalized absolute path on a local fixed disk and contain `profiles\desktop`. |
| `-DshCommand <path>` | Overrides CLI discovery. Accepts a validated `.cmd`, `.exe`, or `.ps1` path; identity and plugin capability are still checked. |
| `-Version <x.y.z>` | Optional pin. When omitted, the script resolves the latest stable Release tag. When supplied, it must be canonical and match the selected Release tag. |
| `-AllowDowngrade` | Permits installing a lower version. Without it, a downgrade is rejected. |
| `-AcceptLicense` | Required by the current non-interactive installer and uninstaller. |
| `-WhatIf` | Resolves home/CLI, validates CLI identity/capability, resolves Release metadata and manifest, and inspects only registration/version state. It prints `plan_install`, `plan_reinstall`, `plan_upgrade`, or `plan_downgrade` without downloading/extracting the tgz, creating a backup, or calling a mutating CLI command. |
| `-ReleaseApiUri <uri>` | Advanced/recovery override. A pinned version must use the matching `releases/tags/v<version>` API URL. Normal users should keep the bootstrap-provided value. |

The installer does not expose a `-StorageRoot` parameter. With no bundle-level `storageDir`, runtime storage is `%DSH_HOME%\storages\dsh-market-intelligence`. A pre-existing explicit storage root remains configuration-owned and is not migrated or deleted; it must be a normalized absolute local-fixed-disk path ending in `dsh-market-intelligence`.

Examples after separately downloading and verifying the script:

```powershell
& .\install.ps1 -Version '0.1.1' -ReleaseApiUri 'https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/tags/v0.1.1' -AcceptLicense -DshHome 'E:\DSH\data'
& .\install.ps1 -Version '0.1.1' -ReleaseApiUri 'https://api.github.com/repos/Yalen-xy/dsh-market-intelligence/releases/tags/v0.1.1' -AcceptLicense -DshHome 'E:\DSH\data' -WhatIf
```

## Manual download and offline hash verification

If you do not want an online bootstrap, open the chosen GitHub Release in a browser and manually download these five files into a new empty directory:

- `dsh-market-intelligence-<version>.tgz`
- `install.ps1`
- `uninstall.ps1`
- `SHA256SUMS.txt`
- `LICENSE.txt`

Inspect `LICENSE.txt`, then verify each of the other four files against its exact `SHA256SUMS.txt` row. For example:

```powershell
$manifest = [IO.File]::ReadAllLines((Join-Path $PWD 'SHA256SUMS.txt'))
$names = @('install.ps1', 'uninstall.ps1', 'LICENSE.txt', 'dsh-market-intelligence-0.1.1.tgz')
foreach ($name in $names) {
  $escaped = [regex]::Escape($name)
  $rows = @($manifest | Where-Object { $_ -cmatch ("\A[0-9A-Fa-f]{64}  " + $escaped + "\z") })
  if ($rows.Count -ne 1) { throw "Expected exactly one checksum row for $name." }
  $expected = $rows[0].Substring(0, 64)
  $stream = [IO.File]::OpenRead((Join-Path $PWD $name))
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
  }
  finally { $stream.Dispose() }
  if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw "SHA-256 mismatch for $name." }
}
```

Hash verification is fully offline once the files exist locally. The current installer is not a fully offline installer: even when launched from this directory, it resolves the matching GitHub Release and downloads the tgz into its own unique temporary directory before rechecking that payload. Do not claim an air-gapped install path that the script does not implement.

After successful verification, install with the matching version and tag API as shown above. Do not execute a script whose row is absent, duplicated, malformed, or mismatched.

## Install, reinstall, upgrade, and downgrade

- First install: run the verified bootstrap or verified `install.ps1` with the target version.
- Same-version reinstall: the script verifies the installed package and downloaded Release bytes; it does not add a second bundle entry.
- Upgrade: run the bootstrap for the higher Release. Existing unrelated plugins and storage are fingerprinted and must remain stable.
- Downgrade: use a pinned older Release, its matching tag API, and add `-AllowDowngrade`. An implicit downgrade fails before mutation.

Immediately before a managed CLI mutation, the installer creates an operation directory under `%DSH_HOME%\backups\dsh-market-intelligence\<operation-id>`. Its allowlist contains `package.json`; optional `pnpm-lock.yaml`, `cordis.patch.yml`, and `dsh.profile.yaml`; this plugin's receipt; and the current/target `dsh-market-intelligence-<version>.tgz` cache entries. The manifest records whether every allowlisted input originally existed and records length/hash only for existing files. Credentials, sessions, logs, unrelated packages/cache, watchlists, market observations, and the market database are not copied or hashed. Each allowed source, both manifest files, and every retained payload are read and hashed through the same verified file handles; hard links and reparse points are rejected, and those handles stay open until transaction completion. Preflight creates an opaque restore capability that internally binds the one verified backup, the fixed desktop profile root, every allowlisted row, and whether that row originally existed. Restore callers can request only a row already bound to that capability; they cannot supply another root, arbitrary relative path, or a row from another backup. Restore/delete operations validate and mutate the exact opened target handle.

Every attempted install or uninstall also creates a separate unique UTF-8 `installer.log` under the current user's temporary directory. Creation uses an exclusive new file and the operation retains both the log file handle and its directory identity until the final event is flushed; replacement, junction, reparse-point, hard-link, and concurrent-write attempts fail closed. The standalone uninstaller applies the same handle-bound rule to its pre-delegation log before it trusts or invokes the sibling installer. The script closes that verified handle and prints `installer_log=<absolute path>` on success, failure, `-WhatIf`, and license rejection. Once a backup exists it also prints `installer_backup=<absolute path>`. Logs contain only fixed event schemas and allowlisted categories; they do not contain arbitrary CLI/HTTP output or profile data.

On success, the verified backup and separately printed temporary `installer.log` remain available for audit and recovery. Temporary package downloads are removed. A `restart_required` result means static profile/package postconditions passed; it does not mean DSH has already loaded the bundle.

## Failure and rollback

Failures before mutation leave the profile untouched and report a stable error category. Once mutation begins, failure triggers rollback: the managed CLI is asked to restore the prior package state, verified coordination files are restored atomically, and prior-state postconditions are checked. The command still exits nonzero even when rollback succeeds.

The backup directory and separately printed temporary operation log are retained whether rollback succeeds or is incomplete. If the result category is `rollback` or `rollback_incomplete`, keep DSH Desktop stopped and preserve both printed locations before any new install attempt. Rollback restores only the allowlisted managed coordination state and never restores, migrates, or deletes `%DSH_HOME%\storages\dsh-market-intelligence` or an explicit storage root.

## Uninstall

Place the Release's verified `uninstall.ps1`, verified `install.ps1`, and `SHA256SUMS.txt` together, close DSH Desktop, then run:

```powershell
& .\uninstall.ps1 -DshHome 'E:\DSH\data'
```

The command above prompts interactively for the same explicit license acceptance; add `-AcceptLicense` only for non-interactive automation. `-Version '0.1.0'` is optional but, when supplied, must match the installed version. `-WhatIf` plans removal without mutation. The uninstaller delegates to the verified installer core, creates the same allowlisted backup and separate temp log, removes only `dsh-market-intelligence`, and verifies the dependency, bundle entry, receipt, cache, and installed package are absent.

Uninstall preserves `%DSH_HOME%\storages\dsh-market-intelligence` or the user's explicit storage root. It also preserves installer backups and all unrelated plugins. Deleting data is a separate manual decision outside these scripts.

## Restart and verify exactly seven tools

Pre-restart validation does not prove runtime registration. Start DSH Desktop normally, open the installed `desktop` profile, and ask it to list the tools registered by `dsh-market-intelligence`. Verify that these exact seven names are present once each:

1. `market_auction`
2. `market_data_health`
3. `market_quotes`
4. `market_sectors`
5. `market_series`
6. `market_status`
7. `market_watchlist`

Then call `market_data_health` and `market_status` before relying on other results. Missing tools, stale data, provider errors, or degraded calendar confidence are operational/data-quality states; they are not permission to invent values or assume Tencent/Sina endpoints are authorized or stable.
