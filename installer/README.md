# Windows Release installer

This directory contains the PowerShell entry points published with each GitHub Release:

> Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

- `install.ps1` performs discovery, integrity checks, process refusal, verified backup, managed-CLI install/upgrade/downgrade, postconditions, and rollback.
- `uninstall.ps1` validates its sibling `install.ps1` through `SHA256SUMS.txt` and delegates safe package removal to the same core.

End users should follow the [verified bootstrap and full operating guide](../docs/INSTALL.md), not copy scripts from an arbitrary branch. Release assets are `install.ps1`, `uninstall.ps1`, `dsh-market-intelligence-<version>.tgz`, `SHA256SUMS.txt`, and `LICENSE.txt`.

The public parameters are `-DshHome`, `-DshCommand`, optional `-Version`, `-AllowDowngrade`, `-AcceptLicense`, `-WhatIf`, and the advanced `-ReleaseApiUri`. Omitting `-Version` resolves the latest stable Release. Interactive use requires an explicit `yes`/`y` after the limited-use and unofficial-data-source warning; blank input, EOF, and other responses reject. Non-interactive use requires `-AcceptLicense`. There is no `-StorageRoot` parameter. Default data stays at `%DSH_HOME%\storages\dsh-market-intelligence`; uninstall and rollback retain that directory and any explicit storage root.

`-WhatIf` resolves compatibility, Release metadata, manifest integrity, and the install/reinstall/upgrade/downgrade plan without downloading or extracting the tgz payload. Mutating operations back up only the documented coordination allowlist (`package.json`, optional lock/patch/profile metadata, and this plugin's receipt/cache recovery inputs); credentials, sessions, logs, storage, and unrelated profile files are never copied or hashed. Backup source, destination, restore, and deletion decisions are bound to verified Windows handles and reject reparse points or hard links. Every operation retains an exclusive, handle-bound UTF-8 log under the current user's temporary directory through its final flush, then prints its exact `installer_log=` path. Once created, the separate recovery location is printed as `installer_backup=`.

Close DSH Desktop before a mutating operation. A running owned DSH process causes refusal; the scripts do not terminate or restart it. Successful pre-restart package/profile validation does not prove runtime tool registration—restart DSH Desktop and perform the seven-tool check in the installation guide.

Never add credentials, cookies, private profile data, workstation-specific paths, live-provider tests, or arbitrary command evaluation to these scripts or their tests.
