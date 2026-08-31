# Task 1 report: platform-neutral seven-tool contract

## Implementation

- Added `src/tool-contracts.ts`, which owns the seven tool names, host-neutral service subset, closed JSON Schema contract, semantic normalization and validation, output projection, cancellation forwarding, and bounded public argument/output errors.
- Reduced `src/tools.ts` to the DSH adapter. It registers the shared contracts, retains DSH input/output JSON Schema validation, rendering, presenters, lifecycle cleanup, and maps the shared errors to DSH errors at the host edge.
- Added canonical-contract parity coverage and TypeScript surface coverage. The parity test exercises refresh defaults, canonical symbols, 100-symbol bounds, series range checks, conditional watchlist arguments, and lossless-output rejection through the shared surface as well as the DSH registry.

## Files

- `src/tool-contracts.ts` (new)
- `src/tools.ts`
- `test/tool-contracts.test.ts` (new)
- `test/tools.test.ts`
- `test/type-surface.test.ts`

## TDD evidence

- RED: `node --import tsx --test test/tool-contracts.test.ts test/tools.test.ts test/type-surface.test.ts` failed as expected with `ERR_MODULE_NOT_FOUND` for `src/tool-contracts.js` before production implementation existed.
- GREEN: the same focused command passed all 21 tests after implementation.

## Tests and results

- `npm run build` passed.
- Focused contract suite passed: 21/21.
- `npm test` was run once; all observed suite output was passing and the spawned run completed without remaining Node test processes.

## Self-review

- `src/tool-contracts.ts` does not import DSH packages.
- DSH-specific schema assertion/validation, tool rendering, presenters, and registration stay in `src/tools.ts`.
- Existing DSH-visible schemas, validation messages, projections, cancellation forwarding, and disposer behavior remain covered by the existing registry tests.
- `git diff --check` passed.

## Concerns

- None.
