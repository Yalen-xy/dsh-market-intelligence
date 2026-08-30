# Changelog

All notable changes to this project are documented here. The project follows semantic versioning for repository releases.

## [Unreleased]

### Added

- Integrity-checked Windows PowerShell installation, reinstall, upgrade, explicit downgrade, rollback, and uninstall flows for GitHub Releases.
- Latest and pinned one-command bootstraps that verify `install.ps1` before execution and preserve the installer's independent tgz verification.
- Tag-only Windows Release automation with PowerShell 5.1/7 gates and deterministic five-asset staging.
- Installation and recovery documentation covering discovery overrides, `-WhatIf`, retained storage, audit logs, and post-restart seven-tool verification.

### Changed

- Generalized `DSH_HOME` and explicit storage validation to normalized absolute paths on any local fixed disk without migrating existing data.
- Removed workstation-specific storage configuration from the packaged bundle.
- Replaced private-development wording with the Personal Non-Commercial Limited Use License and explicit unresolved Tencent/Sina authorization and stability warnings.

## [0.1.0] - 2026-08-28

### Added

- Seven native DSH tools for market status, quotes, series, sectors, auction observations, watchlist management, and data health.
- Tencent primary market-data provider and Sina fallback/sector provider behind fixed reviewed HTTP routes.
- CN/HK market-phase-aware scheduler with call-auction/pre-open collection and close maintenance.
- SQLite persistence, minute/daily compaction, bounded retention, health records, collection gaps, and crash-consistent recovery cursors.
- Support for A shares, Hong Kong shares, Shanghai/Shenzhen/CSI indices, Hang Seng Index, and Hang Seng TECH Index.
- Closed JSON schemas and lossless-output validation for every model-visible tool.
- Keyless test, load, profile-smoke, and opt-in live-smoke workflows.

### Safety

- No broker login, account access, position access, trading, simulated trading, or order execution.
- No arbitrary URLs, request headers, cookies, or credential configuration.
- Explicit stale/unavailable states and `null` for unpublished values instead of fabricated data.
