# Architecture

DSH Market Intelligence is a local, read-only market-data product with a shared market core and thin host adapters. The DSH adapter runs in the DeepSeek Harness Cordis runtime; the Claude adapter runs as a Windows MCPB extension. Both preserve the same tool contract while keeping host lifecycle and persistence separate.

## Shared core and adapters

One repository, semantic version, tag-based GitHub Release, license, changelog, and CI serve every adapter. Each Release provides the latest DSH ZIP and Claude MCPB assets; historical tags remain available for audit and rollback. The platform-neutral shared core owns providers, HTTP policy, calendar, scheduler, models, symbol normalization, SQLite semantics, retention, service behavior, and canonical tools. Adapters only translate that contract into their host registry and lifecycle.

The SDK-free shared modules include `src/runtime.ts`, `src/tool-contracts.ts`, and the market/data core they compose. `src/index.ts` and `src/tools.ts` are explicitly DSH adapters: they import Cordis, DSH tools, and SchemActery to connect the shared contract to DeepSeek Harness.

The DSH and Claude adapters never share a live SQLite database, watchlist, configuration, logs, or scheduler. A future Codex adapter is planned and reserved at this boundary; no Codex adapter is currently available.

## Data flow

```text
Tencent Finance ─┐
                 ├─ fixed-host HTTP policy ─ provider adapters ─ normalization
Sina Finance ────┘                                      │
                                                        ▼
                                               shared MarketService
                                              /          |          \
                                             /           |           \
                                    MarketScheduler      |     canonical seven tools
                                             │           |           │
                                             ▼           ▼           ▼
                                  host-specific SQLite state   DSH / Claude adapters
                                             │
                                             ▼
                                  close maintenance / retention
```

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Shared core | `src/runtime.ts`, `src/tool-contracts.ts`, and market/data modules | Holds host-neutral provider, storage, schedule, service, model, and canonical tool behavior without host SDK imports. |
| DSH adapter | `src/index.ts`, `src/tools.ts` | Imports Cordis, DSH tools, and SchemActery to map the canonical tools and lifecycle to DeepSeek Harness. |
| Claude adapter | `claude/` | Maps the canonical tools and lifecycle to Windows MCP stdio and MCPB metadata. |
| Cordis lifecycle | `src/index.ts` | Validates configuration, creates dependencies, registers the plugin, and disposes resources in order. |
| Tool boundary | `src/tools.ts` | Defines seven closed JSON input/output schemas and rejects lossy or invalid results. |
| Service layer | `src/service.ts` | Orchestrates providers, cache fallback, source conflicts, persistence, watchlist changes, health, and recovery. |
| Scheduler | `src/scheduler.ts` | Runs market-phase-aware collection, timestamp backoff, close maintenance, and cancellation. |
| Repository | `src/repository.ts` | Provides transactional SQLite persistence, prepared queries, schema migration, health records, gaps, and recovery cursors. |
| Retention | `src/retention.ts` | Compacts raw observations into minute/daily bars and enforces retention and the storage soft cap. |
| Calendar | `src/calendar.ts` | Computes CN/HK phases in `Asia/Shanghai` and applies configured market closures. |
| Symbols | `src/symbols.ts` | Canonicalizes supported A/H securities and fixed market indices. |
| HTTP policy | `src/http.ts` | Allows only reviewed hosts/routes, rejects redirects and credentials, and limits concurrency, time, and response size. |
| Providers | `src/providers/` | Parses Tencent and Sina data into shared canonical records without inventing missing values. |

## Persistence model

The repository stores raw quote observations, compacted minute and daily bars, sector observations and summaries, provider health, maintenance results, collection gaps, and crash-consistent recovery cursors. Writes that advance recovery state and persist the represented market data share one transaction.

SQLite runtime files and `config.json` live under each adapter's configured storage root. DSH and Claude roots are independent runtime state; neither adapter imports, migrates, or synchronizes the other's data. They are intentionally excluded from Git, npm packages, and the MCPB package.

## Safety boundaries

- Read-only external HTTP requests; no broker, account, position, or order APIs.
- Fixed reviewed hosts and routes; no arbitrary user-provided URLs, headers, cookies, or credentials.
- Redirects are rejected.
- Request duration, response size, symbol batch size, and global provider concurrency are bounded.
- Missing market values remain `null`; they are never converted to zero.
- Tool outputs must be plain, finite, lossless JSON and must satisfy closed schemas.
- Upstream failures remain visible through availability, freshness, sanitized error categories, and collection gaps.

## Recovery behavior

On restart, durable per-market cursors determine which closed session segments have already been processed. A segment commit atomically stores observations or an explicit gap and advances its cursor. Built-in providers do not claim historical quote-snapshot capability, so downtime is recorded as `provider_history_unavailable` rather than filled with fabricated current observations.

## Test strategy

The test suite covers calendar boundaries, provider parsing, fixed-request security, shared concurrency, tool schemas, JSON safety, SQLite transactions and migrations, scheduler cancellation, recovery idempotency, retention, package metadata, DSH and Claude lifecycle, adapter contract parity, MCP stdio framing, and a synthetic full trading day with 100 A/H watchlist symbols plus fixed indices.
