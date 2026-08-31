# Task 3 report: Claude configuration and isolated Windows storage

## Implementation

Added `claude/config.ts` with Claude-only environment resolution:

- `resolveClaudeBaseDirectory(environment)` requires a non-empty, normalized absolute local `LOCALAPPDATA` path and returns `%LOCALAPPDATA%\\dsh-market-intelligence\\claude`.
- `readClaudeConfig(environment)` reads only `CLAUDE_MARKET_STORAGE_DIR`, `CLAUDE_MARKET_REQUEST_TIMEOUT_MS`, `CLAUDE_MARKET_QUOTE_INTERVAL_MS`, and `CLAUDE_MARKET_SECTOR_INTERVAL_MS`.
- Omitted or blank custom storage is absent; malformed storage never falls back to the Claude default.
- Numeric values must be canonical decimal integers and remain within the existing runtime bounds.

Extracted the shared runtime defaults and Claude-exposed interval bounds to `src/config.ts`, without changing the DSH adapter's configuration parser or default storage root. Hardened `requireLocalWindowsPath` in `src/paths.ts` to reject alternate data streams, so both adapters reject that unsafe path form. The existing asynchronous `assertSafeLocalWindowsPath` remains the fixed-drive and reparse-point gate used by `startMarketRuntime` before it creates storage.

## Files

- Added: `claude/config.ts`
- Added: `test/claude-config.test.ts`
- Modified: `src/config.ts`
- Modified: `src/paths.ts`
- Modified: `test/paths.test.ts`
- Regenerated tracked output: `lib/config.js`, `lib/config.d.ts`, `lib/paths.js`

## TDD evidence

RED:

```text
node --import tsx --test test/claude-config.test.ts test/paths.test.ts
```

Result: exit 1. `test/claude-config.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `claude/config.ts`; the new ADS assertion in `test/paths.test.ts` also failed because the prior lexical validator accepted an alternate data stream.

GREEN:

```text
node --import tsx --test test/claude-config.test.ts test/paths.test.ts test/model-config.test.ts
```

Result: exit 0; 24 passed, 0 failed.

## Build and regression verification

```text
npm run build
```

Result: exit 0.

```text
npm test
```

Result: exit 0; 446 passed, 0 failed, 0 cancelled, 0 skipped. The Node test workers and their temporary directories had exited and cleaned up before commit preparation.

## Self-review

- Claude resolution does not inspect `DSH_HOME`; DSH path resolution does not inspect any `CLAUDE_MARKET_*` name.
- Claude's default is a separate LocalAppData tree and an explicit D-drive path stays exactly as selected.
- Blank optional storage is deliberately distinct from blank `LOCALAPPDATA` or blank numeric values, which fail closed.
- UNC, device, relative, traversal, mixed-separator, and ADS path forms are rejected lexically; removable/network drives and reparse traversal remain rejected by the runtime's existing asynchronous safe-path check.
- `git diff --check` passed.

## Concerns

None. Task 4 must pass both `readClaudeConfig()` and `resolveClaudeBaseDirectory()` into the existing `startMarketRuntime` safety boundary so the asynchronous fixed-drive and reparse checks execute before storage creation.

## Fix round 1

### Implementation

Extended the shared `requireLocalWindowsPath` component validator to reject every non-root component that ends in a dot or space, contains an alternate data stream separator, or has a Windows reserved device stem. Reserved stems are checked case-insensitively and include `CON`, `PRN`, `AUX`, `NUL`, `CLOCK$`, `COM1` through `COM9`, and `LPT1` through `LPT9`, including ordinary extensions such as `NUL.txt`. Drive roots and ordinary dotted names remain accepted. The logic mirrors the repository's release-staging component policy without importing build-script code.

Added the production `resolveDshBaseDirectory(environment)` seam and routed the production DSH dependency through it. The updated independence test passes hostile invalid Claude values to that DSH resolver and a hostile invalid `DSH_HOME` to both Claude resolvers, proving neither adapter consumes the other adapter's environment variables without starting a runtime.

### TDD evidence

RED:

```text
node --import tsx --test test/claude-config.test.ts test/paths.test.ts
```

Result: exit 1. The Claude test module failed because `src/index.ts` did not yet export `resolveDshBaseDirectory`; the direct path test failed because the old validator accepted trailing-dot/space and reserved-device components.

GREEN:

```text
node --import tsx --test test/claude-config.test.ts test/paths.test.ts test/model-config.test.ts test/plugin-load.test.ts
```

Result: exit 0; 34 passed, 0 failed, 0 cancelled, 0 skipped. An initial unsandboxed run reached the expected test-created temporary-directory permission denial in `plugin-load.test.ts`; the scoped rerun above is the recorded GREEN evidence.

### Verification

```text
npm run build
```

Result: exit 0.

```text
npm test
```

Result: exit 0; 447 passed, 0 failed, 0 cancelled, 0 skipped. The worker processes and temporary test directories had exited and cleaned up before staging.

### Files

- Modified: `src/paths.ts`, `src/index.ts`, `test/paths.test.ts`, `test/claude-config.test.ts`
- Regenerated tracked output: `lib/paths.js`, `lib/index.js`, `lib/index.d.ts`

### Self-review and concerns

- Checked the component behavior against `scripts/stage-release.mjs`: trailing dot/space and the same reserved device stems are rejected, ordinary dotted names are accepted.
- The production default DSH dependency calls the exported resolver; test-only configuration or runtime startup is unnecessary for the independence proof.
- `git diff --check` passes.
- No concerns.
