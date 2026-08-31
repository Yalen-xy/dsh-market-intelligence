# Claude MCPB Adapter Design

**Date:** 2026-08-31  
**Status:** Approved for implementation planning

## Objective

Add a Windows-only Claude Desktop extension to `dsh-market-intelligence` without forking the market-data implementation. DeepSeek Harness, Claude, and a future Codex adapter must share one market core, one tool contract, one version, and one release process while keeping their runtime databases independent.

The Claude deliverable is a one-click installable MCP Bundle named `claude-market-intelligence-latest.mcpb`. It exposes the same seven market tools as the DSH adapter and does not require DSH to be installed or running.

## Product Boundaries

- The first Claude release supports Windows only.
- The extension is read-only with respect to brokerage and trading systems. It does not connect to securities accounts, read positions, or place real or simulated orders.
- The extension may modify only its own watchlist, configuration, database, logs, and bounded recovery state.
- Claude and DSH do not share a live SQLite database.
- No new market-data capability is added in this project phase. The goal is platform parity for the existing seven tools.
- The repository, semantic version, license, changelog, CI, and GitHub Release are shared by all adapters.
- Local Claude installation is permitted only when necessary for final compatibility validation. The machine must be returned to an uninstalled state before delivery.

## Selected Architecture

Use one platform-neutral market core with thin host adapters.

```text
market core
├── providers and HTTP policy
├── market calendar and phases
├── scheduler and request limiter
├── models and symbol normalization
├── SQLite repository and retention
├── service and health semantics
└── canonical tool contracts

host adapters
├── DSH: Cordis lifecycle and DSH tool registry
├── Claude: MCP stdio lifecycle and MCP tool registry
└── Codex: reserved future adapter
```

The alternative designs are rejected:

- Wrapping the existing DSH plugin would ship Cordis, SchemActery, and DSH host dependencies into Claude and couple Claude reliability to DSH APIs.
- Connecting Claude to a running DSH instance would require DSH availability, an additional local transport, port and authentication policy, and shared lifecycle management.

## Core and Adapter Boundaries

The existing provider, calendar, scheduler, repository, retention, model, symbol, HTTP, and service modules become the shared core. They must not import DSH or MCP packages.

Tool behavior is defined once using platform-neutral TypeScript types, semantic validators, canonical JSON-safe results, and stable tool metadata. Each adapter converts the canonical contract to its host's schema representation:

- The DSH adapter converts it to the existing DSH registry and SchemActery schemas.
- The Claude adapter converts it to MCP tool declarations and JSON Schema.
- A future Codex adapter can reuse the MCP server or map the same contract to Codex-native plugin metadata without changing market behavior.

The DSH public API and current tool names remain compatible. Refactoring must not change the behavior or result shape of the existing DSH tools.

## Claude Runtime

The Claude adapter is a Node.js MCP server using stdio transport. Standard output is reserved exclusively for MCP frames. Diagnostics use standard error and must not contain secrets, absolute local paths, upstream response bodies, or internal stack traces.

Startup sequence:

1. Read and validate the extension configuration.
2. Require Windows and a supported Node.js runtime with `node:sqlite`.
3. Resolve and validate the Claude-specific storage directory.
4. Create the storage root if needed.
5. Load the Claude watchlist and closure configuration.
6. Open the Claude SQLite database.
7. Construct shared providers, limiter, scheduler, and market service.
8. Register exactly seven MCP tools.
9. Start the scheduler after initialization succeeds.

Shutdown sequence:

1. Stop accepting new scheduled work.
2. Abort or drain bounded provider requests.
3. Wait for owned database writes to settle.
4. Stop the scheduler and close SQLite.
5. Exit without emitting non-protocol output on stdout.

Partial startup must roll back every resource already acquired.

## Tools

Claude exposes the same tool names and business behavior as DSH:

- `market_auction`
- `market_data_health`
- `market_quotes`
- `market_sectors`
- `market_series`
- `market_status`
- `market_watchlist`

Input objects remain closed and reject unknown properties. Output values must be lossless JSON: no `undefined`, non-finite numbers, negative zero, class instances, sparse arrays, or cycles. Caller errors, unavailable data, stale cache, provider failures, storage failures, and invalid tool output retain their current structured classifications.

## Configuration and Storage

The MCPB configuration surface remains intentionally small:

- `storageDir`: optional Claude-specific data directory.
- `requestTimeoutMs`: provider timeout within the existing safe range.
- `quoteIntervalMs`: bounded watchlist polling interval.
- `sectorIntervalMs`: bounded sector polling interval.

Other limits use the tested defaults unless a later requirement justifies exposing them.

When no directory is selected, the server resolves a Claude-specific application-data directory on Windows. A custom directory may be selected during extension configuration. It must be an absolute path on a local fixed disk and must pass the existing lexical, reparse-point, and ancestor checks. Network shares, relative paths, removable drives, alternate data streams, ambiguous paths, and unsafe reparse traversal fail closed.

The Claude database, watchlist, logs, closure configuration, and recovery state are independent of DSH. No automatic import, migration, or synchronization is included.

## MCPB Package

The package follows the current MCPB manifest specification and uses `manifest_version: 0.4`.

It contains only:

- `manifest.json`
- the bundled MCP server entry point and required runtime modules
- localized display metadata if needed
- icon assets if supplied
- `LICENSE`
- concise package documentation required by the extension

The manifest declares a Node server, Windows compatibility, repository and support URLs, the fixed seven-tool surface, user configuration, and the required third-party data-source privacy-policy links. The package must not contain source maps, tests, fixtures, development dependencies, secrets, user paths, build caches, DSH-only packages, or an existing database.

The bundle is validated and packed with the official MCPB tooling. The staged artifact name is stable and versionless:

`claude-market-intelligence-latest.mcpb`

The manifest and internal package metadata retain the semantic project version for updates and auditability.

## Failure and Safety Semantics

- Invalid configuration fails before network or database access.
- An unsafe storage path prevents startup.
- Provider failures degrade the affected capability and update health state; they do not terminate the MCP server.
- Missing or stale data is reported explicitly and is never fabricated.
- The Tencent-to-Sina fallback remains limited to the reviewed capability and endpoint policy.
- Tool exceptions are mapped to bounded public errors without leaking raw upstream or filesystem details.
- Unexpected stdout writes fail tests because they can corrupt MCP framing.
- Cancellation is forwarded to every cancellable service operation.
- The extension makes no account, trading, browser automation, or arbitrary filesystem capability available to Claude.

## Build and Release

The existing GitHub Release remains the single customer release for every adapter. A release publishes at least:

- `dsh-market-intelligence-latest.zip`
- `claude-market-intelligence-latest.mcpb`

Historical tags and releases remain available for audit and rollback. The README displays only the latest stable download links and separates DSH and Claude installation instructions. A future Codex asset will join the same release without changing the shared-core model.

The release job must build from a clean checkout, validate both adapters, stage an explicit artifact allowlist, calculate hashes, and publish only staged assets. Publishing remains tag-only and retains least-privilege GitHub permissions.

## Verification

Verification is layered:

1. **Core regression:** all existing DSH and market-core tests continue to pass.
2. **Contract parity:** both adapters expose exactly the same seven names, accepted arguments, semantic validation, and canonical result shapes.
3. **MCP protocol:** a simulated MCP client verifies initialization, tool listing, calls, errors, cancellation, and orderly shutdown over stdio.
4. **Deterministic provider tests:** fixtures replace live Tencent and Sina requests in CI.
5. **Lifecycle tests:** startup rollback and shutdown leave no timers, requests, or database handles.
6. **Package validation:** official MCPB validation succeeds and archive contents match an explicit allowlist.
7. **Security inspection:** the bundle contains no secrets, personal paths, databases, logs, source maps, test fixtures, or DSH-only runtime dependencies.
8. **Windows smoke:** start the staged server on Windows and execute all seven tools through a real MCP transport without making live requests.
9. **Bounded live smoke:** optional final validation may make a minimal number of read-only provider requests; it must not start continuous high-frequency collection.
10. **Claude compatibility:** if protocol and package tests cannot prove host loading, temporarily install and start the extension in Claude Desktop, verify recognition and one bounded call, then uninstall it.

## Local Validation and Cleanup

Temporary validation may start the MCP server and, only when necessary, install the MCPB in Claude Desktop. Before any host-level validation, record the exact pre-existing Claude extension and configuration state. Do not overwrite unrelated user configuration.

Before delivery:

- stop every test MCP process;
- uninstall the temporary Claude extension if installed;
- remove only test-created Claude configuration entries;
- remove test-created databases, logs, caches, and temporary directories;
- verify the pre-existing Claude state is restored;
- verify DSH configuration and data were not changed.

The final machine state contains no installed Claude market extension. Repository files, intentional build outputs, and published GitHub Release assets remain.

## Acceptance Criteria

- Existing DSH behavior and package remain functional.
- Claude receives the same seven tools through a valid Windows MCPB.
- The Claude package installs without npm or manual JSON configuration.
- Claude and DSH can run concurrently without sharing a database or lifecycle.
- CI performs protocol, parity, package, security, and Windows smoke validation without live network dependency.
- GitHub Release contains stable latest assets for DSH and Claude under one version.
- No Claude extension or test data remains installed locally after final verification.
- The shared-core boundary allows a future Codex adapter without duplicating the market implementation.
