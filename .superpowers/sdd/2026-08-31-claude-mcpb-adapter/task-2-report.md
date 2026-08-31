# Task 2 report: host-neutral market runtime lifecycle

## Implementation

Created `src/runtime.ts` as the host-neutral owner of market runtime setup and cleanup. It exports:

- `MarketRuntimeConfig` (re-exported from `src/config.ts`)
- `MarketRuntime`
- `MarketRuntimeOptions`
- `startMarketRuntime()`
- `createSharedRequestLimiter()` for the DSH adapter's default dependency wiring

The runtime derives paths from `baseDirectory`, checks both the base and effective storage root before `mkdir`, loads user state, opens the repository, creates the shared limiter/providers/scheduler/service, and returns an idempotent disposer. Startup rollback closes only acquired resources and preserves the startup error, aggregating cleanup errors where needed. The runtime imports neither Cordis nor DSH/MCP SDKs and does not register host tools.

`src/index.ts` retains the DSH configuration schema, `DSH_HOME` validation, Cordis `ctx.effect`, and DSH tool registration. It now delegates runtime ownership to `startMarketRuntime`, unregisters tools before disposing the runtime, and disposes the runtime if registration fails.

## Files

- Added: `src/runtime.ts`
- Modified: `src/config.ts`
- Modified: `src/index.ts`
- Added: `test/runtime.test.ts`

The existing plugin and load tests required no behavioral test edits: their existing coverage continued to exercise the unchanged DSH lifecycle contract through the rewired adapter.

## TDD evidence

Before production code, added `test/runtime.test.ts` for construction, safety checks, idempotent service/limiter teardown, startup rollback after repository open, limiter construction, and service creation, plus startup/rollback error aggregation.

RED command:

```text
node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts
```

RED result: exit 1 as expected. `test/runtime.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/runtime.ts`; the pre-existing plugin/load tests passed (10 passed, 1 failed test file).

After the minimal runtime extraction, a test assertion shape was corrected without changing production code, then the focused runtime GREEN command completed:

```text
node --import tsx --test test/runtime.test.ts
```

GREEN result: exit 0; 3 passed, 0 failed.

Required focused regression command:

```text
node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts test/tools.test.ts
```

Result: exit 0; 40 passed, 0 failed.

## Full verification

```text
npm run build
```

Result: exit 0.

```text
npm test
```

Result: exit 0; 436 passed, 0 failed, 0 cancelled, 0 skipped.

```text
npm run test:load-profile
```

Result: exit 0 (after the sandbox denied the real Windows `Get-CimInstance` probe and the same command was run with scoped host approval). Output: `{"profileSmoke":"ok","tools":7,"networkCalls":0,"pendingTimers":0}`.

## Self-review

- `git diff --check` completed without whitespace errors.
- Shared runtime is host-neutral: no Cordis, DSH, or MCP SDK imports.
- DSH configuration validation and `DSH_HOME` validation remain in the adapter.
- Tool registration stays in the adapter; registration failures dispose the started runtime.
- Runtime disposal is deterministic and idempotent; DSH unregisters tools first.
- The new tests cover the lifecycle mutations that would otherwise escape regression coverage: omitted safety validation, incorrect storage root, non-idempotent cleanup, missing partial-start rollback, and lost startup error.

## Concerns

`npm run build` updates tracked generated `lib/` artifacts (including prior Task 1 output). The Task 2 brief's prescribed commit command deliberately stages only `src/runtime.ts`, `src/index.ts`, `src/config.ts`, and `test/runtime.test.ts`; generated artifacts are therefore intentionally not included in this Task 2 commit.

## Fix round 1

### Finding and implementation

Restored the original deadlock-safe runtime disposal semantics in `src/runtime.ts`. Runtime disposal now starts and retains `requestLimiter.dispose()` before awaiting service or repository cleanup, so active provider work is aborted immediately. It then completes service/repository cleanup and awaits the retained limiter drain promise. Synchronous limiter disposal exceptions, service/repository failures, and asynchronous limiter-drain failures are collected deterministically; the existing idempotent retained disposal promise remains the single cleanup result.

Replaced the order-only lifecycle test with a deferred-cleanup test. The service waits for the limiter cancellation signal; the RED run timed out under the regressed service-first implementation, proving that cleanup could deadlock. The GREEN run proves cancellation happens first, service shutdown then settles, and the limiter drain is retained. Added coverage that service and limiter disposal rejections are both attempted and aggregate in stable order.

### TDD evidence

RED command:

```text
node --import tsx --test test/runtime.test.ts
```

RED result: exit 1; 1 passed and 3 failed. The primary new lifecycle test failed with `actual: 'timeout'` versus `expected: 'settled'`, proving the service waited forever because the limiter had not been cancelled. The rollback and aggregation tests also exposed the old service-before-limiter event order.

GREEN command:

```text
node --import tsx --test test/runtime.test.ts
```

GREEN result: exit 0; 4 passed, 0 failed.

### Verification

```text
node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts test/tools.test.ts
```

Result: exit 0; 41 passed, 0 failed.

```text
npm run build
```

Result: exit 0.

```text
npm test
```

Result: exit 0; 437 passed, 0 failed, 0 cancelled, 0 skipped.

```text
npm run test:load-profile
```

Result: exit 0 with scoped host permission for the Windows CIM fixed-drive check. Output: `{"profileSmoke":"ok","tools":7,"networkCalls":0,"pendingTimers":0}`.

### Controller ruling

Although the original task brief showed a narrow source/test `git add` list, `package.json` builds and ships tracked `lib/` output. The complete verified generated output is therefore included in this fix-round commit: `lib/index.{js,d.ts}`, `lib/config.{js,d.ts}`, `lib/tools.{js,d.ts}`, `lib/runtime.{js,d.ts}`, and `lib/tool-contracts.{js,d.ts}`. Repository policy is unchanged.

## Fix round 2

### Finding and implementation

Fixed a Node 24 unhandled-rejection window in runtime disposal. The limiter still starts disposal immediately so cancellation happens before deferred service cleanup, but its promise now immediately maps both fulfillment and rejection into a retained `CleanupOutcome`. After service or repository cleanup finishes, runtime disposal awaits that non-rejecting outcome and appends any limiter failure in the existing deterministic aggregation order. Early cancellation, later drain waiting, all-error aggregation, and idempotent disposal are preserved.

Added a deterministic regression test in `test/runtime.test.ts`: the limiter rejects immediately while service cleanup remains deferred through the next event-loop turn. Before the source fix, Node's test runner reported the unhandled limiter rejection and `PromiseRejectionHandledWarning`; after the fix, the test verifies the final aggregate retains the service error followed by the limiter error. The test installs no process-level rejection listeners, so it cannot leak listeners into other tests.

The first build exposed a TypeScript inference error because `.then<CleanupOutcome>` specifies only the fulfillment result generic and leaves the rejection result as `never`. The final source explicitly uses `.then<CleanupOutcome, CleanupOutcome>`, preserving the same runtime semantics while type-checking both outcome handlers.

### TDD evidence

RED command:

```text
node --import tsx --test test/runtime.test.ts
```

RED result after removing all test-installed process listeners: exit 1; 4 passed and 1 failed. Node reported `Error: limiter cleanup failed` for the new test and emitted `PromiseRejectionHandledWarning`, proving the limiter rejection was first handled only after deferred service cleanup resumed.

GREEN command:

```text
node --import tsx --test test/runtime.test.ts
```

GREEN result: exit 0; 5 passed, 0 failed. A subsequent focused runtime rerun after the TypeScript generic correction also passed 5/5.

### Verification

```text
node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts test/tools.test.ts
```

Result: exit 0; 42 passed, 0 failed.

```text
npm run build
```

Result: exit 0 after correcting both `Promise.then` result generics. Generated `lib/runtime.js` contains the same immediate outcome mapping and later ordered inspection as `src/runtime.ts`; the private `CleanupOutcome` type does not alter the public declaration output.

The first `npm test` run reported 437/438: an unrelated installer fixed-error-line test observed empty stdout. Its exact isolated rerun passed 1/1, exit 0. A fresh full rerun then completed successfully:

```text
npm test
```

Result: exit 0; 438 passed, 0 failed, 0 cancelled, 0 skipped; duration 118710 ms.

```text
npm run test:load-profile
```

Result: exit 0. Output: `{"profileSmoke":"ok","tools":7,"networkCalls":0,"pendingTimers":0}`.
