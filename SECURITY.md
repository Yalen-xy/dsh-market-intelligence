# Security policy

## Supported versions

The current `0.1.x` line is under active private development. Security fixes are applied to the latest repository version; older commits are retained for audit and rollback but are not independently maintained.

## Reporting a vulnerability

Do not open a public issue containing credentials, private paths, exploit payloads, or sensitive market data. Use the repository's private GitHub security-advisory channel when available, and include:

- affected commit or version;
- reproduction steps using synthetic data;
- expected and observed behavior;
- whether the issue can expose local files, bypass fixed HTTP routes, leak secrets, corrupt storage, or invoke trading/account capabilities.

Do not include real brokerage credentials, cookies, account identifiers, positions, or orders. This plugin does not require them.

## Security boundary

The plugin is intended to read public market observations through reviewed fixed endpoints. It must not accept arbitrary URLs, credentials, cookies, broker sessions, account data, order placement, executable downloads, or redirect-based host changes. Any proposal that expands this boundary requires a separate threat review and explicit user approval.

Upstream availability, correctness, licensing, and format stability are data-quality risks rather than security guarantees. Provider parsing failures should fail visibly and must never be replaced with invented values.

## License and upstream-source boundary

Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

The repository being publicly visible, a Release hash matching, or an endpoint being reachable does not establish permission to use or redistribute third-party data. The plugin is not investment advice. Security reports should distinguish code vulnerabilities from provider availability, parsing, entitlement, and legal-compliance questions.

## Installer integrity and recovery

Use only a GitHub Release bootstrap that verifies `install.ps1` against `SHA256SUMS.txt` before execution. The installer then verifies the versioned tgz independently. Both files share the GitHub trust domain, so these checks detect corruption or mismatched assets but do not protect against compromise of the repository or GitHub account.

The installer refuses profile mutation while an owned DSH Desktop process is running, delegates changes to a verified managed CLI, preserves unrelated plugins and market storage, and retains verified backup/log material for rollback diagnosis. Do not publish backup manifests, logs, profiles, or diagnostic archives without inspecting them for private paths and local metadata.
