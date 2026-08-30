# One-Click GitHub Release Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested, integrity-checked, rollback-capable one-command Windows installer and GitHub Release for `dsh-market-intelligence` while preserving existing DSH profiles and market storage.

**Architecture:** The plugin runtime gains a reusable Windows local-path policy that removes the D-drive-only restriction while rejecting non-local path forms. A self-contained PowerShell installer delegates every profile mutation to the managed DSH CLI, surrounds that mutation with verified backups and postconditions, and exposes pure helper functions for fixture-driven tests. A tag-only Windows Release workflow builds the npm tarball, runs all runtime and installer gates, stages immutable assets, hashes them, and publishes with GitHub CLI.

**Tech Stack:** TypeScript 6, Node.js 24 and `node:test`, Windows PowerShell 5.1, PowerShell 7, managed DSH CLI, npm tarballs, GitHub Actions and GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-29-one-click-release-installer-design.md`

## Global Constraints

- Support Windows PowerShell 5.1 and PowerShell 7; do not use PS7-only syntax in release scripts.
- Support Node.js `^22.19.0 || >=24.0.0` with `node:sqlite`.
- Support normalized absolute paths on any local fixed disk; reject relative, UNC/network, device, traversal, removable, and reparse-point escape paths.
- Preserve the existing `D:\AI\dsh\storages\dsh-market-intelligence` installation without migration or rewriting.
- Never mutate the live `D:\AI\dsh\profiles\desktop` or live market storage in tests.
- Use the managed DSH CLI for dependency, lockfile, bundle, patch, install, upgrade, rollback, and removal coordination; never directly edit a real profile.
- Never kill, suspend, or automatically start DSH Desktop.
- Never delete plugin storage during install, rollback, or uninstall.
- Do not access Tencent or Sina from CI or installer tests.
- Ship the approved personal non-commercial limited-use license; do not claim upstream authorization or legal certainty.
- A failed required gate must prevent GitHub Release creation.

---

### Task 1: Generalize runtime path policy without moving existing data

**Files:**
- Create: `src/paths.ts`
- Create: `test/paths.test.ts`
- Modify: `src/index.ts:80-125,234-274`
- Modify: `src/config.ts:27-33`
- Modify: `test/model-config.test.ts:55-75`
- Modify: `test/plugin-load.test.ts:170-205,323-330`

**Interfaces:**
- Produces: `requireLocalWindowsPath(value: unknown, label: string, requiredBasename?: string): string`.
- Produces: `getWindowsDriveType(driveRoot: string, execFileImpl?: typeof execFile): Promise<number>` using a fixed PowerShell command and a previously validated drive root.
- Produces: `assertSafeLocalWindowsPath(pathValue: string, dependencies?: { lstatImpl?: typeof lstat; getDriveTypeImpl?: typeof getWindowsDriveType }): Promise<void>`.
- `src/index.ts` consumes both functions before directory creation and repository startup.
- Later installer tests use the same literal acceptance/rejection table, reimplemented in PowerShell and compared by fixtures.

- [ ] **Step 1: Write failing lexical path-policy tests**

Add table-driven tests with hand-derived expected values:

```ts
test('accepts normalized absolute paths on any Windows drive', () => {
  for (const value of [
    'C:\\Users\\张三\\.dsh',
    'D:\\AI\\dsh',
    'Z:\\Research Data\\dsh-market-intelligence',
  ]) assert.equal(requireLocalWindowsPath(value, 'path'), value);
});

test('rejects non-local, non-normalized, and relative path forms', () => {
  for (const value of [
    '.\\dsh',
    '\\\\server\\share\\dsh',
    '\\\\?\\C:\\dsh',
    'C:\\safe\\..\\escape',
    'C:/mixed/separators',
  ]) assert.throws(() => requireLocalWindowsPath(value, 'path'), /local Windows path/i);
});

test('requires the explicit storage root basename', () => {
  assert.equal(
    requireLocalWindowsPath('E:\\Market\\dsh-market-intelligence', 'storageDir', 'dsh-market-intelligence'),
    'E:\\Market\\dsh-market-intelligence',
  );
  assert.throws(
    () => requireLocalWindowsPath('E:\\Market\\other', 'storageDir', 'dsh-market-intelligence'),
    /final directory/i,
  );
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --import tsx --test test/paths.test.ts`

Expected: FAIL because `../src/paths.ts` does not exist.

- [ ] **Step 3: Implement the minimal lexical policy**

Implement `requireLocalWindowsPath` using `path.win32.isAbsolute`, `path.win32.parse`, `path.win32.normalize`, a drive-root pattern `^[A-Za-z]:\\$`, and exact normalized-string equality. Reject UNC and device roots because their parsed roots do not match. Enforce `requiredBasename` case-insensitively when provided.

- [ ] **Step 4: Run lexical tests and verify GREEN**

Run: `node --import tsx --test test/paths.test.ts`

Expected: all lexical path tests PASS.

- [ ] **Step 5: Write failing fixed-drive, reparse-point, and plugin-startup tests**

Use an injected `getDriveTypeImpl` returning Win32 drive type `3` for fixed-disk acceptance and types `2`, `4`, and `5` for removable, network, and optical rejection. Use an injected `lstatImpl` returning a symbolic-link `Stats` double for one existing ancestor and `ENOENT` for a not-yet-created suffix. Assert that a non-fixed drive or reparse ancestor rejects before `mkdir`, provider construction, or repository open. Add acceptance tests for C-, D-, and another fixed drive-letter `DSH_HOME`; preserve the literal D-drive assertion showing `D:\AI\dsh` resolves to `D:\AI\dsh\storages\dsh-market-intelligence`.

- [ ] **Step 6: Run focused tests and verify RED**

Run: `node --import tsx --test test/paths.test.ts test/model-config.test.ts test/plugin-load.test.ts`

Expected: FAIL because plugin startup still calls the D-drive-only validator and does not inspect existing ancestors.

- [ ] **Step 7: Wire the new policy into runtime startup**

Replace `requireAbsoluteDPath` and D-drive wording in `src/index.ts`. Resolve `DSH_HOME` and optional `storageDir` lexically, call `assertSafeLocalWindowsPath` on each effective root before `mkdir`, and preserve dependency injection by adding an `assertSafePath` dependency defaulting to the new async function. Implement `getWindowsDriveType` with `execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', <fixed script>], { env: { ...process.env, DSH_MARKET_DRIVE_ROOT: driveRoot } })`; the fixed script reads only the validated environment drive root, queries `Win32_LogicalDisk`, and prints the integer `DriveType`. Reject missing, non-integer, or non-`3` results. Keep `resolveRuntimePaths` unchanged so an omitted `storageDir` remains relative to the detected `DSH_HOME`.

- [ ] **Step 8: Run focused tests and the complete runtime suite**

Run: `node --import tsx --test test/paths.test.ts test/model-config.test.ts test/plugin-load.test.ts`

Run: `npm test`

Expected: focused tests PASS; complete suite reports 0 failures.

- [ ] **Step 9: Commit Task 1**

```powershell
git add src/paths.ts src/index.ts src/config.ts test/paths.test.ts test/model-config.test.ts test/plugin-load.test.ts
git commit -m "feat: support safe local paths on any Windows drive"
```

---

### Task 2: Add the limited-use license and remove machine-specific package configuration

**Files:**
- Create: `LICENSE`
- Modify: `package.json:2-36`
- Modify: `cordis.patch.yml:1-10`
- Modify: `test/plugin-load.test.ts:37-83`
- Create: `test/package-release.test.ts`

**Interfaces:**
- Produces: package metadata with `license: "SEE LICENSE IN LICENSE"` and an explicit `LICENSE` package file.
- Produces: a bundle patch with no `storageDir`; runtime derives it from each user's `DSH_HOME`.
- Release staging in Task 6 consumes `LICENSE` verbatim as `LICENSE.txt`.

- [ ] **Step 1: Write failing package-policy tests**

Assert literal behavior:

```ts
test('package ships the limited-use license and no user-specific storage path', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.license, 'SEE LICENSE IN LICENSE');
  assert.equal(packageJson.private, true);
  assert.ok(packageJson.files.includes('LICENSE'));
  const patch = await readFile('cordis.patch.yml', 'utf8');
  assert.doesNotMatch(patch, /D:\\AI|storageDir:/i);
  const license = await readFile('LICENSE', 'utf8');
  assert.match(license, /Personal Non-Commercial Limited Use License/);
  assert.match(license, /No Redistribution/);
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --import tsx --test test/package-release.test.ts test/plugin-load.test.ts`

Expected: FAIL because `LICENSE` and the new metadata do not exist and the bundle patch embeds `D:\AI`.

- [ ] **Step 3: Add the approved license and neutral package metadata**

Write `LICENSE` with copyright `Copyright (c) 2026 Yalen-xy. All rights reserved.` and explicit sections: Limited License Grant, Personal Non-Commercial Use Only, No Modification, No Redistribution, No Commercial or Hosted Use, No Market Data Redistribution, Third-Party Services, Termination, No Warranty, Limitation of Liability, and Reservation of Rights. Grant only installation and use of an unmodified official Release on the licensee's personal computers for non-commercial research.

Set `package.json` fields:

```json
"private": true,
"license": "SEE LICENSE IN LICENSE",
"files": ["lib", "cordis.patch.yml", "README.md", "LICENSE", "scripts"]
```

Remove only the `storageDir` row from `cordis.patch.yml`; keep polling and retention defaults.

- [ ] **Step 4: Update exact metadata tests and verify GREEN**

Run: `node --import tsx --test test/package-release.test.ts test/plugin-load.test.ts`

Expected: PASS with the new exact package file list and path-neutral patch.

- [ ] **Step 5: Verify npm package contents**

Run: `npm run build`

Run: `npm pack --dry-run --ignore-scripts --json`

Expected: exit 0; output includes `package/LICENSE`, compiled `lib/index.js`, `cordis.patch.yml`, and no test fixtures or installer fixture secrets.

- [ ] **Step 6: Commit Task 2**

```powershell
git add LICENSE package.json cordis.patch.yml test/plugin-load.test.ts test/package-release.test.ts
git commit -m "docs: add limited-use distribution license"
```

---

### Task 3: Implement and test installer discovery, integrity, and safety helpers

**Files:**
- Create: `installer/install.ps1`
- Create: `installer/uninstall.ps1`
- Create: `test/installer-helpers.test.ts`
- Create: `test/helpers/installer.ts`
- Modify: `package.json`

**Interfaces:**
- `installer/install.ps1` supports `-DshHome`, `-DshCommand`, `-Version`, `-AllowDowngrade`, `-AcceptLicense`, `-WhatIf`, and internal testable `-ReleaseApiUri` defaulting to the fixed GitHub API URL.
- Pure PowerShell functions: `ConvertFrom-ChecksumManifest`, `Compare-SemanticVersion`, `Resolve-DshHome`, `Test-LocalFixedPath`, `Resolve-DshCommand`, `Select-OwnedDshProcess`, and `Write-InstallerLog`.
- Dot-sourcing `install.ps1` defines functions but does not run installation; direct invocation calls `Invoke-DshMarketInstall`.
- `uninstall.ps1` forwards validated parameters to `install.ps1 -Operation Uninstall` so release behavior has one implementation.

- [ ] **Step 1: Create the Node subprocess harness and failing helper tests**

`test/helpers/installer.ts` must invoke a selected shell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, pass scripts through temporary `.ps1` files rather than string interpolation, capture stdout/stderr separately, and delete its temporary directory in `t.after`.

Tests cover:

```ts
test('checksum parser accepts one canonical entry and rejects duplicates and traversal', async (t) => {
  assert.deepEqual(await invokeFunction(t, 'ConvertFrom-ChecksumManifest', canonicalManifest), {
    'install.ps1': 'a'.repeat(64),
  });
  await assert.rejects(invokeFunction(t, 'ConvertFrom-ChecksumManifest', duplicateManifest), /duplicate/i);
  await assert.rejects(invokeFunction(t, 'ConvertFrom-ChecksumManifest', traversalManifest), /file name/i);
});

test('semantic comparison is numeric and rejects noncanonical versions', async (t) => {
  assert.equal(await compare(t, '0.10.0', '0.9.0'), 1);
  assert.equal(await compare(t, '1.0.0', '1.0.0'), 0);
  await assert.rejects(compare(t, 'latest', '1.0.0'), /semantic version/i);
});
```

Add path tables matching Task 1 plus PowerShell fixed-drive fixtures represented as injected drive records. Add process selection fixtures where an owned DSH executable under the detected Desktop root blocks and unrelated `node.exe`/Electron records do not.

- [ ] **Step 2: Run helper tests and verify RED**

Run: `node --import tsx --test test/installer-helpers.test.ts`

Expected: FAIL because `installer/install.ps1` and helper functions do not exist.

- [ ] **Step 3: Implement pure helpers in Windows PowerShell 5.1 syntax**

Use `[System.IO.Path]::GetFullPath`, `Get-CimInstance Win32_LogicalDisk` or injected drive records to require `DriveType = 3`, literal-path cmdlets, strict manifest regex `^(?<hash>[0-9A-Fa-f]{64})\s{2}(?<name>[^\\/:*?"<>|]+)$`, three-integer semantic versions, and object-property access compatible with PowerShell 5.1. Reject duplicate manifest names case-insensitively.

Process selection accepts normalized process records with `ExecutablePath`, `CommandLine`, and `ProcessId`; it blocks only records whose executable/command line resolves under the selected DSH Desktop or managed-host roots.

Every safe log entry is a fixed event name plus an allowlisted ordered object. Never log an environment dump, raw profile, response body, or unsanitized arbitrary CLI output.

- [ ] **Step 4: Run helper tests under both shells**

Run: `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`

Run: `node --import tsx --test test/installer-helpers.test.ts`

Run: `$env:DSH_INSTALLER_TEST_SHELL='pwsh'; node --import tsx --test test/installer-helpers.test.ts; Remove-Item Env:DSH_INSTALLER_TEST_SHELL`

Expected: all helper tests PASS under Windows PowerShell 5.1 and PowerShell 7.

- [ ] **Step 5: Add npm scripts and the uninstall forwarding entry point**

Add:

```json
"test:installer:windows-powershell": "node --import tsx --test test/installer-*.test.ts",
"test:installer:pwsh": "set DSH_INSTALLER_TEST_SHELL=pwsh&& node --import tsx --test test/installer-*.test.ts"
```

`uninstall.ps1` must locate the sibling `install.ps1`, fail if its SHA cannot be checked against the sibling manifest when invoked from a Release directory, and forward `-Operation Uninstall` without evaluating a constructed command string.

- [ ] **Step 6: Commit Task 3**

```powershell
git add installer/install.ps1 installer/uninstall.ps1 test/helpers/installer.ts test/installer-helpers.test.ts package.json
git commit -m "feat: add installer safety and integrity core"
```

---

### Task 4: Implement transactional install, upgrade, rollback, and uninstall

**Files:**
- Modify: `installer/install.ps1`
- Modify: `installer/uninstall.ps1`
- Create: `test/installer-lifecycle.test.ts`
- Create: `test/fixtures/fake-dsh.ps1`
- Create: `test/fixtures/release-server.ts`

**Interfaces:**
- PowerShell functions: `New-ProfileBackup`, `Restore-ProfileBackup`, `Get-InstalledPluginState`, `Invoke-ManagedDsh`, `Test-InstallPostconditions`, `Invoke-InstallRollback`, `Invoke-DshMarketInstall`, and `Invoke-DshMarketUninstall`.
- Backup manifest schema: `{ operationId, createdAt, installerVersion, requestedVersion, cliPath, cliVersion, files[] }`, where each file row is `{ relativePath, existed, length, sha256 }`.
- Fake CLI contract: `--version`, `plugin --help`, `plugin --profile desktop add <tgz>`, and `plugin --profile desktop remove dsh-market-intelligence`; it mutates only its fixture profile and can fail at named stages through a fixture control JSON file.

- [ ] **Step 1: Write failing first-install and WhatIf lifecycle tests**

Create a temporary fake `DSH_HOME` containing `profiles\desktop`, unrelated dependencies/bundles, and seeded storage files. Start a loopback-only HTTP fixture server returning a GitHub-shaped release response, assets, and manifest. Invoke with explicit `-DshHome`, fake `-DshCommand`, `-Version 0.1.0`, and `-AcceptLicense`.

Assert first install adds exactly one dependency/bundle through the fake CLI, leaves unrelated entries byte-for-byte stable, leaves seeded storage hashes stable, writes a backup manifest, and emits a restart-required success event. Assert `-WhatIf` makes zero writes and zero mutating CLI calls.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `node --import tsx --test test/installer-lifecycle.test.ts`

Expected: FAIL because orchestration and backup functions are absent.

- [ ] **Step 3: Implement download, package inspection, backup, CLI mutation, and postconditions**

Download to a GUID-named temporary directory. Validate the manifest, tarball hash, package name, version, main entry, bundle patch, and license before backup. Use `tar.exe -xOf <tgz> package/package.json` and reject if `tar.exe` is unavailable. Create backup files with `Copy-Item -LiteralPath`; hash the copied bytes and write the backup manifest through a temporary file followed by atomic rename.

Set `DSH_HOME` only in the child process environment for `Invoke-ManagedDsh`, restore the parent process value in `finally`, and call the CLI as an argument array. Validate one dependency, one bundle entry, installed package metadata, parseable patch via CLI validation, and stable pre-existing storage hashes.

- [ ] **Step 4: Run first-install tests and verify GREEN**

Run: `node --import tsx --test test/installer-lifecycle.test.ts --test-name-pattern "first install|WhatIf"`

Expected: selected tests PASS.

- [ ] **Step 5: Write failing reinstall, upgrade, downgrade, process, and rollback tests**

Add scenarios for same-version idempotency, `0.1.0` to `0.2.0` upgrade, default downgrade rejection, explicit `-AllowDowngrade`, license rejection, ambiguous/absent home, invalid CLI, owned running process, unrelated processes, checksum mismatch, package metadata mismatch, and fake CLI failures after each mutation boundary. For each post-mutation failure, compare the full fixture profile tree hash to its pre-install hash and require nonzero installer exit even when rollback succeeds.

- [ ] **Step 6: Implement downgrade gates, process gate, and verified rollback**

Compare canonical semantic versions numerically. Run the process gate before backup. On mutation failure, ask the CLI to restore the prior version or remove a first install, atomically restore every backup row, re-hash the restored files, record each rollback result, preserve backup/logs, and exit nonzero. If any rollback check fails, emit `rollback_incomplete` with only safe paths and stable categories.

- [ ] **Step 7: Write failing uninstall tests**

Assert uninstall removes only this dependency/bundle through the fake CLI, retains all storage bytes and unrelated plugin state, creates a backup, prints the retained storage path, and rolls back on a post-remove validation failure.

- [ ] **Step 8: Implement uninstall and verify all lifecycle tests**

Run: `node --import tsx --test test/installer-lifecycle.test.ts`

Run: `$env:DSH_INSTALLER_TEST_SHELL='pwsh'; node --import tsx --test test/installer-lifecycle.test.ts; Remove-Item Env:DSH_INSTALLER_TEST_SHELL`

Expected: all install/upgrade/downgrade/rollback/uninstall tests PASS under both shells.

- [ ] **Step 9: Mutation-check log privacy and storage preservation**

Seed fixtures with `credential-secret-123`, `cookie-secret-456`, a watchlist symbol, and a market-row payload. Search all generated logs and require none of those values. Deliberately remove the storage-preservation assertion and confirm the test fails when the fake CLI deletes a seeded storage file; restore the assertion and fixture behavior afterward.

- [ ] **Step 10: Commit Task 4**

```powershell
git add installer/install.ps1 installer/uninstall.ps1 test/installer-lifecycle.test.ts test/fixtures/fake-dsh.ps1 test/fixtures/release-server.ts
git commit -m "feat: add transactional DSH plugin installation"
```

---

### Task 5: Stage deterministic Release assets and checksums

**Files:**
- Create: `scripts/stage-release.mjs`
- Create: `test/release-artifacts.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI: `node scripts/stage-release.mjs --tag v0.1.0 --package <tgz> --output <dir>`.
- Output exactly: versioned `.tgz`, `install.ps1`, `uninstall.ps1`, `SHA256SUMS.txt`, and `LICENSE.txt`.
- Manifest rows use lowercase SHA-256, two spaces, filename, LF newline, sorted by filename.

- [ ] **Step 1: Write failing artifact-staging tests**

Build a temporary fake tarball and assert tag/package version equality, exact five-file output, sorted canonical manifest, and rejection of prerelease/malformed tags, mismatched package versions, missing license, and unexpected output collisions.

- [ ] **Step 2: Run test and verify RED**

Run: `node --import tsx --test test/release-artifacts.test.ts`

Expected: FAIL because `scripts/stage-release.mjs` does not exist.

- [ ] **Step 3: Implement deterministic staging**

Use Node `crypto.createHash('sha256')`, `fs.copyFile` with exclusive destination checks, and exact semantic tag parsing. Read package metadata from `npm pack --json` input metadata or `tar.exe -xOf`; never infer version from an unchecked filename. Copy `LICENSE` bytes unchanged to `LICENSE.txt`.

- [ ] **Step 4: Verify staging tests and real package staging**

Run: `node --import tsx --test test/release-artifacts.test.ts`

Run: `npm run build`

Run: `npm pack --ignore-scripts --json`

Run: `node scripts/stage-release.mjs --tag v0.1.0 --package .\dsh-market-intelligence-0.1.0.tgz --output .\.tmp-release-v0.1.0`

Expected: tests PASS; staging outputs exactly five files with a valid manifest. Remove only the known `.tmp-release-v0.1.0` test directory after inspection.

- [ ] **Step 5: Add package scripts and commit Task 5**

Add `release:stage` with documented required CLI arguments rather than a machine-specific path.

```powershell
git add scripts/stage-release.mjs test/release-artifacts.test.ts package.json
git commit -m "build: stage verified GitHub Release assets"
```

---

### Task 6: Add tag-only Release workflow and installer CI matrix

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `test/workflow-policy.test.ts`

**Interfaces:**
- CI retains existing build/test/package gates and adds PowerShell 5.1 and 7 installer tests.
- Release triggers only on `refs/tags/v*`, grants `contents: write` only at the release job, stages assets, then runs `gh release create` once.

- [ ] **Step 1: Write failing workflow-policy tests**

Parse workflow YAML as text with behavior-focused invariants: release trigger contains tags `v*`; release job runs on Windows; permissions are not repository-global write; both `powershell.exe` and `pwsh` installer gates precede staging; `npm test`, build, profile smoke, and package inspection precede `gh release create`; no third-party release action and no Tencent/Sina smoke environment variable appears.

- [ ] **Step 2: Run test and verify RED**

Run: `node --import tsx --test test/workflow-policy.test.ts`

Expected: FAIL because `release.yml` is absent.

- [ ] **Step 3: Implement CI and Release workflows**

Use `actions/checkout@v4` and `actions/setup-node@v4`, Node 24, npm cache, and Windows shell steps. Release workflow commands:

```powershell
npm ci
npm run build
npm test
npm run test:load-profile
npm run test:installer:windows-powershell
npm run test:installer:pwsh
$pack = npm pack --ignore-scripts --json | ConvertFrom-Json
node scripts/stage-release.mjs --tag $env:GITHUB_REF_NAME --package $pack[0].filename --output .release
gh release create $env:GITHUB_REF_NAME .release\* --verify-tag --title $env:GITHUB_REF_NAME --notes-file .release-notes.md
```

Generate `.release-notes.md` from a fixed template plus the tag and approved disclaimer; do not embed fetched market content. Set `GH_TOKEN: ${{ github.token }}` only on the publish step. Ensure all validation occurs before `gh release create`.

- [ ] **Step 4: Verify workflow tests**

Run: `node --import tsx --test test/workflow-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add .github/workflows/ci.yml .github/workflows/release.yml test/workflow-policy.test.ts
git commit -m "ci: publish verified Windows installer releases"
```

---

### Task 7: Document one-command install, risk, recovery, and verification

**Files:**
- Create: `docs/INSTALL.md`
- Create: `installer/README.md`
- Modify: `README.md:1-185`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `test/package-release.test.ts`

**Interfaces:**
- README exposes latest and pinned bootstrap commands.
- `docs/INSTALL.md` documents discovery, parameters, offline/manual hash verification, upgrade, downgrade, uninstall, rollback logs, retained storage, and seven-tool post-restart verification.
- Security and license sections carry identical core third-party-source wording.

- [ ] **Step 1: Write failing documentation/package tests**

Assert shipped README/INSTALL/LICENSE contain the package name, one-command latest and pinned version flows, SHA-256 verification before execution, `-DshHome`, `-WhatIf`, process refusal, retained storage, seven exact tool names, limited-use terms, and unresolved Tencent/Sina authorization warning. Assert shipped files do not contain `D:\AI`, the developer wrapper path, credential values, or a claim of legal authorization.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --import tsx --test test/package-release.test.ts`

Expected: FAIL because current README embeds machine-specific installation instructions and new documentation is absent.

- [ ] **Step 3: Write installation and security documentation**

The latest bootstrap downloads `install.ps1` and `SHA256SUMS.txt` into a new temporary directory, verifies the `install.ps1` row, and invokes only on equality. The pinned example replaces `latest` with `download/v0.1.0`. Include a manual sequence for users who do not want an online bootstrap.

State explicitly that successful pre-restart validation does not prove runtime registration. Give the post-restart prompt listing all seven tools. State that uninstall preserves `%DSH_HOME%\storages\dsh-market-intelligence` or the user's explicit storage root.

- [ ] **Step 4: Run documentation/package tests and package inspection**

Run: `node --import tsx --test test/package-release.test.ts`

Run: `npm pack --dry-run --ignore-scripts --json`

Expected: PASS; shipped package contains generic docs and no `D:\AI` string.

- [ ] **Step 5: Commit Task 7**

```powershell
git add README.md docs/INSTALL.md installer/README.md SECURITY.md CHANGELOG.md test/package-release.test.ts
git commit -m "docs: add verified one-command installation guide"
```

---

### Task 8: Fresh verification, code review, publication, and Release observation

**Files:**
- Modify only if verification or review identifies a scoped defect.
- Update: `.planning/2026-08-29-one-click-installer/task_plan.md`
- Update: `.planning/2026-08-29-one-click-installer/progress.md`

**Interfaces:**
- Final evidence consists of local exit codes, exact test counts, package contents, staged artifact hashes, GitHub CI conclusion, and GitHub Release asset list.

- [ ] **Step 1: Run formatting/diff safety checks**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only planned files are changed.

- [ ] **Step 2: Run the complete fresh verification sequence**

Run in order:

```powershell
npm ci
npm run build
npm test
npm run test:load-profile
npm run test:installer:windows-powershell
npm run test:installer:pwsh
npm pack --dry-run --ignore-scripts --json
```

Expected: every command exits 0; full test output reports zero failures; profile smoke reports seven tools and zero network calls.

- [ ] **Step 3: Stage and inspect the exact v0.1.0 assets**

Create the real tarball with `npm pack --ignore-scripts --json`, stage to a unique temporary directory, independently recompute each SHA-256, inspect the tarball file list, and verify exactly five Release assets. Do not create a tag yet.

- [ ] **Step 4: Review against every spec acceptance criterion**

For each criterion in the design spec, record the proving test/command in `progress.md`. If any criterion lacks evidence, add the missing test before publication. Review installer paths for command injection, destructive file operations, unsafe recursive targets, secret logging, and live-profile references.

- [ ] **Step 5: Commit any final scoped corrections and the plan record**

Use a specific commit message describing the correction. Do not squash away the design or test-first history.

- [ ] **Step 6: Publish commits to GitHub main and wait for CI**

Push the reviewed commit chain to `main` through the authenticated GitHub connection. Verify remote file contents and wait for the main CI run to complete successfully. If CI fails, fetch the exact failing job log, add a reproducing test, fix, and repeat.

- [ ] **Step 7: Create and push the `v0.1.0` tag only after green main CI**

Verify no existing `v0.1.0` tag or Release exists. Create the tag at the green main commit and push it. Wait for the tag Release workflow to finish; do not manually upload partial assets while it runs.

- [ ] **Step 8: Verify the public Release**

Check that the Release is public, associated with the intended commit, contains exactly the five named assets, and that downloaded asset hashes match `SHA256SUMS.txt`. Report the Release URL, commit, CI run, Release workflow run, test count, and asset hashes.
