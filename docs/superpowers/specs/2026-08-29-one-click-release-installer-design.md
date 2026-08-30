# One-Click GitHub Release Installer Design

## Status

Approved in conversation on 2026-08-29. This document defines the release and installation subsystem; implementation requires a separately approved implementation plan.

## Goal

Provide a one-command, integrity-checked installation and upgrade path for `dsh-market-intelligence` on Windows DSH Desktop systems, without assuming a fixed drive or modifying unrelated plugins, user market data, or persistent environment variables.

## Distribution and licensing decision

The GitHub repository remains public and publishes versioned GitHub Release assets. The project is source-visible but is not open source.

The root `LICENSE` will grant a limited, non-transferable right to download and use an unmodified release on a personal computer for non-commercial research. It will prohibit modification, redistribution, sublicensing, sale, bundling into another product, hosted-service use, and public or commercial redistribution of market data obtained through the plugin. All rights not expressly granted remain reserved.

The license, README, installer prompt, and Release notes will state that:

- Tencent and Sina are not partners of, and have not authorized, this project.
- Upstream endpoints may change or become unavailable without notice.
- Each user is responsible for complying with applicable law and upstream terms.
- The plugin is for personal, non-commercial, read-only research and is not investment advice.
- These notices do not create upstream authorization or eliminate legal risk.

This project documentation is not legal advice. Publication does not claim that third-party data use is free of legal risk.

## Non-goals

- No DSH marketplace integration, receipt format, or marketplace-managed rollback.
- No macOS or Linux installer.
- No automatic process termination.
- No automatic DSH Desktop launch after installation.
- No direct editing of the desktop profile `package.json`, lockfile, or bundle list.
- No deletion, migration, upload, or backup of the plugin's market database.
- No telemetry and no live Tencent or Sina calls from CI or installer tests.
- No code signing or native executable installer in the first release.

## Release artifacts

Each stable tag named `v<semver>` creates a GitHub Release containing exactly these end-user artifacts:

- `dsh-market-intelligence-<version>.tgz`: the compiled npm package.
- `install.ps1`: Windows installation and upgrade entry point.
- `uninstall.ps1`: safe package removal entry point.
- `SHA256SUMS.txt`: SHA-256 for every downloadable executable or package asset.
- `LICENSE.txt`: the exact limited-use license shipped with the release.

Release notes state supported Node and DSH requirements, material changes, known provider limitations, and the same third-party data disclaimer.

## Supported environment

- Windows DSH Desktop with a valid managed `desktop` profile.
- Windows PowerShell 5.1 or PowerShell 7.
- Node.js satisfying `^22.19.0 || >=24.0.0`, including `node:sqlite`.
- A DSH-managed plugin CLI that supports `plugin --profile desktop add` and `remove`.
- `DSH_HOME` and plugin storage on any normalized absolute path on a local fixed disk. No drive letter is privileged.

Unsupported or ambiguous environments fail closed with a diagnostic message and no profile mutation.

## Command surface

The installer supports:

```powershell
.\install.ps1
.\install.ps1 -DshHome 'D:\AI\dsh'
.\install.ps1 -DshCommand 'C:\path\to\dsh.cmd'
.\install.ps1 -Version '0.1.0'
.\install.ps1 -AllowDowngrade
.\install.ps1 -AcceptLicense
.\install.ps1 -WhatIf
```

The uninstaller supports equivalent discovery overrides plus an explicit package version where required for recovery. It removes the package and bundle registration but never deletes storage data. Data deletion is outside both scripts.

`-AcceptLicense` is required for non-interactive operation. Interactive operation displays a concise license and data-source warning and requires an explicit affirmative response. Silence, EOF, or any other response rejects installation.

`-WhatIf` performs discovery, compatibility checks, release metadata resolution, manifest download, and integrity planning without changing the profile or downloading/executing the package payload.

## DSH home discovery

The installer selects `DSH_HOME` in this order:

1. A valid absolute path supplied through `-DshHome`.
2. A valid absolute path in the current process's `DSH_HOME` environment variable.
3. `%USERPROFILE%\.dsh` when it contains a valid `profiles\desktop` profile.
4. A bounded set of DSH Desktop-owned configuration hints documented by the installed Desktop version.

A valid candidate must be a normalized absolute path on a local fixed disk, contain a recognizable desktop profile, and resolve without an unresolved reparse-point traversal. Discovery never performs an unbounded drive scan. If zero or multiple candidates remain, installation stops and asks for `-DshHome`; it never guesses.

The installer sets `DSH_HOME` only in its child CLI process environment. It does not create or change user- or machine-level environment variables.

## Managed CLI discovery and trust

The installer selects the CLI in this order:

1. `-DshCommand`, after validation.
2. A `dsh` command resolved from `PATH`, after validation.
3. The DSH Desktop-managed command under the current user's DSH Desktop application data, after validation.

The selected command must identify as a DSH CLI, expose the required plugin command, and be associated with the detected DSH Desktop channel. A repository workspace CLI or an unverifiable command is rejected. The generic installer cannot pin one universal executable hash because Desktop versions differ; it records the resolved path and CLI version in the local install log and requires the command to reside in an approved Desktop-managed location unless the user explicitly supplied `-DshCommand`.

The installer delegates dependency, lockfile, bundle, and patch coordination exclusively to the selected managed CLI.

## Process safety gate

Before any profile mutation, the installer checks processes whose executable path or command line identifies the detected DSH Desktop installation, profile, or managed host. Generic unrelated `node` or Electron processes are not sufficient by name alone.

If an owned DSH process is running, the installer exits before backup or mutation and tells the user to exit DSH Desktop normally. It never kills, suspends, or restarts a process.

## Download and integrity model

README provides two commands:

- A convenient command resolving the latest stable GitHub Release.
- A reproducible command pinned to an explicit semantic version.

The bootstrap downloads `install.ps1` and `SHA256SUMS.txt` over HTTPS from the same GitHub Release, verifies the script hash listed in the manifest, and only then invokes the script. The installer downloads the selected `.tgz` into a unique temporary directory and verifies its SHA-256 against the same manifest before passing it to the CLI.

The manifest parser accepts only the expected SHA-256 format, rejects duplicate names, path traversal, missing assets, unexpected version/package name combinations, and hashes other than 64 hexadecimal characters. Temporary paths are literal paths, not shell-expanded strings. Temporary files are removed on normal success and handled best-effort on failure.

Integrity verification protects against accidental corruption and mismatched assets. Because the manifest and assets share the same GitHub trust domain, it is not represented as protection against compromise of the repository or GitHub account.

## Transaction boundary and backup

Immediately before invoking a mutating CLI command, the installer creates a timestamped backup directory outside the profile but under the detected `DSH_HOME` backup area. It copies only installer-owned recovery inputs:

- `profiles\desktop\package.json`
- `profiles\desktop\pnpm-lock.yaml`, when present
- `profiles\desktop\cordis.patch.yml`, when present
- the managed CLI's plugin receipt or equivalent registration metadata, when discoverable and documented

The backup manifest records source path, byte length, SHA-256, original existence, installer version, package version, CLI path, and CLI version. Credentials, sessions, logs, and `storages\dsh-market-intelligence` are excluded.

Backups use a unique operation identifier. The installer refuses to overwrite an existing operation directory.

## Installation and upgrade flow

1. Parse arguments without executing user-controlled strings.
2. Display and obtain the required license acceptance.
3. Discover and validate `DSH_HOME`, desktop profile, Node, and managed CLI.
4. Enforce the DSH process safety gate.
5. Resolve the requested or latest stable release.
6. Download and validate the manifest and package asset.
7. Inspect the package metadata and require the expected package name, semantic version, entry point, bundle patch, and license file.
8. Read the currently installed version through profile/CLI state without modifying it.
9. Reject an implicit downgrade; require `-AllowDowngrade` for a lower version.
10. In `-WhatIf`, report the exact planned operation and stop here successfully.
11. Create and verify the backup manifest.
12. Invoke the managed CLI to add the local verified `.tgz` to the `desktop` profile with a child-process-only `DSH_HOME`.
13. Validate postconditions.
14. On success, retain the backup for explicit recovery, remove temporary downloads, and tell the user to restart DSH Desktop.
15. On failure, execute rollback and return a nonzero exit code even if rollback succeeds.

Repeated installation of the same version is idempotent from the user's perspective: it must not duplicate bundle entries, patches, or dependencies. The managed CLI may reconcile the package, after which the same postconditions apply.

## Post-install validation

Without starting DSH Desktop, the installer verifies:

- The desktop profile dependency resolves to `dsh-market-intelligence` at the requested version.
- The desktop bundle list contains exactly one `dsh-market-intelligence` entry.
- The installed package includes the compiled entry point, package metadata, bundle patch, and license.
- The profile patch remains parseable by the managed CLI.
- With no explicit `storageDir`, the effective storage root is the detected `DSH_HOME\storages\dsh-market-intelligence`.
- An explicit `storageDir` may be any normalized absolute local-fixed-disk path whose final directory name is `dsh-market-intelligence`; it need not share a drive or parent with `DSH_HOME`.
- Pre-existing files under the storage root retain their pre-install identity and are not removed by the installer.

The installer cannot truthfully prove runtime tool registration while DSH remains stopped. It therefore prints a post-restart verification prompt that asks DSH to list or invoke the seven expected tools:

- `market_auction`
- `market_data_health`
- `market_quotes`
- `market_sectors`
- `market_series`
- `market_status`
- `market_watchlist`

Runtime registration is a user-observed post-restart check, not a pre-restart success claim.

## Rollback

Rollback is attempted only after a mutation begins:

1. Ask the managed CLI to restore the previously installed package version, or remove the newly added package when no prior version existed.
2. Restore backed-up profile coordination files atomically from the verified backup.
3. Re-run non-runtime postconditions for the prior state.
4. Preserve the backup and diagnostic log regardless of rollback outcome.

Rollback never restores or removes `storages\dsh-market-intelligence`. If rollback is incomplete, the installer reports each failed recovery action and exits nonzero; it never claims the previous state is healthy without verification.

## Uninstall behavior

`uninstall.ps1` uses the same discovery, license notice, process gate, backup, logging, and managed CLI trust rules. It calls the managed CLI remove command and verifies that the dependency and bundle entry are absent.

It does not delete:

- `storages\dsh-market-intelligence`
- any other plugin
- shared dependencies still required by the profile
- installer backups

The script prints the retained storage path and states that deleting it is a separate manual decision.

## Logging and privacy

Each operation writes a UTF-8 log to a unique directory under the current user's temporary directory and prints that path at exit. Logs include phases, result codes, normalized non-secret paths, versions, asset hashes, and rollback results.

Logs must not include environment dumps, credentials, cookies, HTTP response bodies, profile credential files, sessions, watchlists, market observations, database content, or arbitrary CLI output that has not been sanitized. Errors are reduced to stable categories and safe messages where external content could be present.

## Release automation

`.github/workflows/release.yml` triggers only for stable `v*` tags and uses Windows runners. It grants `contents: write` only to the release job. The job:

1. Checks out the tagged commit.
2. Installs Node 24 dependencies with `npm ci`.
3. Runs the TypeScript build.
4. Runs the full keyless test suite.
5. Runs profile smoke against a temporary `DSH_HOME`.
6. Runs installer tests in Windows PowerShell 5.1 and PowerShell 7.
7. Runs `npm pack --ignore-scripts` after all gates pass.
8. Inspects the tarball and validates required files and prohibited omissions.
9. Generates `SHA256SUMS.txt` from the final immutable artifacts.
10. Creates the GitHub Release and uploads the exact artifacts.

The workflow uses the GitHub-provided token and GitHub CLI or first-party GitHub actions. It does not introduce an unpinned third-party release action. Any failed gate prevents Release creation.

## Cross-drive compatibility and existing installations

The plugin's current D-drive-only validation is replaced with local-fixed-disk validation shared by `DSH_HOME` and explicit `storageDir` handling. The validator accepts normalized absolute paths on any local fixed disk and rejects relative paths, path traversal, UNC/network locations, removable media, device paths, and unresolved reparse-point escapes. SQLite storage on network or removable media remains unsupported because its durability and locking behavior cannot be guaranteed by this project.

This compatibility change does not move data. Existing valid configuration remains authoritative. In particular, the existing installation at `D:\AI\dsh` continues to use `D:\AI\dsh\storages\dsh-market-intelligence`; neither the installer nor the plugin rewrites it to another drive or directory.

The packaged default bundle patch no longer embeds `D:\AI`. It omits `storageDir` so each installation derives the default from its own `DSH_HOME`. A user who already has an explicit valid `storageDir` keeps that value through install and upgrade.

## Installer test strategy

Tests run entirely in temporary directories with a fake managed CLI that implements the observable CLI contract and records sanitized invocations. They never read or write the developer's real DSH profile.

Required scenarios:

- First installation into a unique valid profile.
- Same-version reinstallation without duplicate entries.
- Upgrade preserving storage and unrelated plugins.
- Downgrade rejected by default and accepted only with `-AllowDowngrade`.
- Interactive and non-interactive license acceptance behavior.
- Explicit, environment, default-home, zero-candidate, and multiple-candidate discovery.
- Paths containing spaces, Chinese characters, brackets, and literal wildcard characters.
- `DSH_HOME` and explicit storage roots on C, D, and another available fixed drive, with no migration of an existing D-drive installation.
- Relative, UNC/network, removable, device, traversal, and reparse-point escape paths reject before storage mutation.
- Owned DSH process detection rejects before mutation; unrelated Node/Electron processes do not.
- Invalid CLI identity or missing plugin capability rejects before mutation.
- Invalid, missing, duplicate, traversal, or mismatched manifest entries reject before mutation.
- Package hash mismatch and package metadata mismatch reject before mutation.
- Managed CLI failure at each mutation boundary triggers verified rollback.
- Interrupted or incomplete rollback returns nonzero and preserves diagnostics.
- Uninstall removes only this package and retains storage.
- Logs contain required audit facts and exclude seeded secrets and market records.
- `-WhatIf` performs no profile mutation.

PowerShell tests exercise the scripts as subprocesses rather than checking source text. Node tests may construct release fixtures, but acceptance is based on script exit codes, filesystem effects, fake CLI invocations, and sanitized logs.

## Repository changes

Implementation will add or modify:

- `LICENSE`
- `package.json`
- `cordis.patch.yml`
- `README.md`
- `SECURITY.md`
- `src/index.ts`
- `installer/install.ps1`
- `installer/uninstall.ps1`
- `installer/README.md`
- `installer/tests/`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- package/release validation tests under `test/`

The package changes from `private: true` only if required for deterministic npm packing; it is not published to the npm registry. The custom license identifier is represented as `SEE LICENSE IN LICENSE` where package tooling permits it.

## Acceptance criteria

The subsystem is complete only when:

- A clean Windows user can run one documented command and install a pinned or latest stable Release into one unambiguous DSH Desktop profile.
- No user-specific drive or path is embedded in the installer or Release package.
- Any normalized absolute local-fixed-disk `DSH_HOME` and plugin storage root is supported, while unsafe filesystem classes reject before mutation.
- The existing `D:\AI\dsh\storages\dsh-market-intelligence` installation remains in place and is not migrated.
- Every downloaded executable/package asset is checked against the Release manifest before use.
- DSH running, ambiguous home discovery, unverifiable CLI, integrity failure, or incompatible versions fail before profile mutation.
- Install, reinstall, upgrade, rollback, and uninstall tests pass under PowerShell 5.1 and 7.
- Failure after mutation restores the verified prior profile state or explicitly reports an incomplete rollback.
- Unrelated plugins and all market storage remain unchanged.
- CI, profile smoke, package inspection, installer tests, and Release artifact validation pass before publication.
- Documentation accurately describes the limited-use license and unresolved third-party data-source risk without claiming authorization or legal certainty.
