# Architecture

DSH Market Intelligence is a local, read-only market-data plugin hosted by the DSH Desktop Cordis runtime. It separates external data acquisition, normalization, persistence, scheduling, and model-visible tool projection so that a failure in one boundary remains observable and does not silently corrupt another.

## Data flow

```text
Tencent Finance ─┐
                 ├─ fixed-host HTTP policy ─ provider adapters ─ normalization
Sina Finance ────┘                                      │
                                                        ▼
                                               MarketService
                                              /      |       \
                                             /       |        \
                                    MarketScheduler  |   DSH tool registry
                                             │       |        │
                                             ▼       ▼        ▼
                                      SQLite repository   seven JSON tools
                                             │
                                             ▼
                                  close maintenance / retention
```

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
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

SQLite runtime files and `config.json` live under the configured plugin storage root. They are runtime state and are intentionally excluded from Git and npm packages.

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

The test suite covers calendar boundaries, provider parsing, fixed-request security, shared concurrency, tool schemas, JSON safety, SQLite transactions and migrations, scheduler cancellation, recovery idempotency, retention, package metadata, Cordis lifecycle, smoke scripts, and a synthetic full trading day with 100 A/H watchlist symbols plus fixed indices.
