# Changelog

All notable changes to this project are documented here. The project follows semantic versioning for repository releases.

## [Unreleased]

- Prepared the project for private GitHub publication with standard documentation, CI, security guidance, and repository hygiene.

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
