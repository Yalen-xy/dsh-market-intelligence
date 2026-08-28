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
