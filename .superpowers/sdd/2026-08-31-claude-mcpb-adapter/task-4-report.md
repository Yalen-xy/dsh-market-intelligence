# Task 4 report: Claude MCP stdio adapter

## Implementation

- Added an MCP `Server` registry backed only by `createMarketToolContracts()`. It publishes the canonical seven names, descriptions, input schemas, and output schemas without redefining tool behavior.
- Successful calls return the canonical JSON-safe object as both compact JSON text and `structuredContent`. Unknown names and `MarketToolArgsError` become bounded MCP `InvalidParams` errors; operational failures become a fixed `isError` tool result and a fixed stderr category.
- Added a fixed-token Claude logger that writes only to the injected stderr stream. The stdio fixture proves every stdout line parses as an MCP JSON-RPC frame and that diagnostics do not contain paths, secrets, upstream bodies, or source positions.
- Added `runClaudeServer(environment, streams)`. It resolves the Claude-only config and base directory, passes the expanded config plus base directory into `startMarketRuntime`, and constructs `StdioServerTransport` only after runtime startup succeeds.
- Added one idempotent shutdown path for `SIGINT`, `SIGTERM`, transport close, connection rollback, and explicit close. It unregisters signal listeners, closes the MCP server/transport, and disposes the shared runtime. Promise guards are published before side effects so transport-close callbacks cannot deadlock through re-entry.
- Added exact pinned dev dependencies `@anthropic-ai/mcpb@2.1.2`, `@modelcontextprotocol/sdk@1.30.0`, and `esbuild@0.28.2`, plus `tsconfig.claude.json` and `typecheck:claude`.
- No Claude Desktop extension was installed and no provider request was made.

## TDD evidence

Initial RED:

```text
node --import tsx --test test/claude-mcp.test.ts
```

Exit 1: `ERR_MODULE_NOT_FOUND` for `claude/mcp-server.ts`, proving the protocol tests preceded implementation.

Lifecycle RED found during mutation review:

```text
node --import tsx --test test/claude-mcp.test.ts
```

Exit 1: the synchronous transport-construction rollback assertion observed `disposeCalls` 0 instead of 1. Moving transport construction inside the connection rollback boundary made this case green.

Focused GREEN:

```text
node --import tsx --test test/claude-mcp.test.ts test/tool-contracts.test.ts test/runtime.test.ts
```

Exit 0: 15 passed, 0 failed, 0 cancelled, 0 skipped.

## Final verification

```text
npm run build
```

Exit 0. The main TypeScript build produced no tracked output differences because Task 4 changes are under the no-emit Claude compiler boundary.

```text
npm run typecheck:claude
```

Exit 0.

```text
npm test
```

Exit 0: 456 passed, 0 failed, 0 cancelled, 0 skipped; duration 121463 ms. No test performed a live provider request.

```text
git diff --check
```

Exit 0.

## Files

- Added: `claude/mcp-server.ts`, `claude/main.ts`, `claude/logging.ts`
- Added: `test/claude-mcp.test.ts`, `test/fixtures/claude-server-fixture.ts`
- Added: `tsconfig.claude.json`
- Modified: `package.json`, `package-lock.json`
- Added: this report

## Concerns

The exact required dependency installation completed successfully, but `npm install` reported five transitive audit findings (four low, one high) and a pending allow-scripts notice for esbuild's install script. No dependency version was changed beyond the task's exact pins.

## Fix round 1

### Root cause and implementation

SDK 1.30.0 applies the schema passed to `Protocol.setRequestHandler()` before invoking the registered callback. Registering `CallToolRequestSchema` therefore let a Zod parse exception escape before the Claude adapter could classify it; the protocol converted that ordinary exception to `-32603 Internal Error` and exposed the SDK validation diagnostic in the response message.

The adapter now leaves `tools/call` on the SDK's documented raw fallback request boundary, checks the method exactly, and explicitly calls `CallToolRequestSchema.safeParse()` before looking up or executing any canonical contract. Failed parsing produces one fixed `McpError(ErrorCode.InvalidParams, 'Invalid tools/call request')`. Other unregistered methods retain standard `MethodNotFound` behavior. Valid calls, unknown market tools, canonical argument validation, cancellation, result projection, and runtime lifecycle are unchanged.

The raw linked in-memory protocol test covers missing params, an empty params object, missing/non-string names, and array/null/string/number/boolean `arguments`. It asserts exact numeric code `-32602`, the bounded SDK-prefixed public message, absence of error data, absence of hostile path/body/secret text, and zero market-service calls. The existing real MCP client tests continue to prove valid calls and unknown tool behavior.

### TDD evidence

RED:

```text
node --import tsx --test test/claude-mcp.test.ts
```

Exit 1: 9 passed and 1 failed. The first missing-params raw request returned code `-32603` with the SDK Zod message (`expected object ... received undefined`) instead of the required bounded `-32602` response.

Focused GREEN:

```text
node --import tsx --test test/claude-mcp.test.ts test/tool-contracts.test.ts test/runtime.test.ts
```

Exit 0: 16 passed, 0 failed, 0 cancelled, 0 skipped.

### Final verification

```text
npm run typecheck:claude
```

Exit 0.

```text
npm run build
```

Exit 0; no tracked generated output changed.

```text
npm test
```

Exit 0: 457 passed, 0 failed, 0 cancelled, 0 skipped; duration 124252 ms. No live provider request or Claude installation was performed.
