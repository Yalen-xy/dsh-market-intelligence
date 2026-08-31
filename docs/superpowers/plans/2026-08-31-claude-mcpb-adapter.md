# Claude MCPB Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Windows Claude Desktop MCPB that exposes the existing seven market tools while preserving the DSH plugin and sharing one platform-neutral market core.

**Architecture:** Extract the tool contract and market runtime from the DSH host adapter, then add a stdio MCP adapter that consumes those shared interfaces. Build the Claude server as a self-contained Node bundle, package it with the official MCPB tooling, and publish it beside the DSH ZIP in the same versioned GitHub Release; each host keeps independent local state.

**Tech Stack:** TypeScript 6, Node.js 24 with `node:sqlite`, `@modelcontextprotocol/sdk` 1.30.0, `@anthropic-ai/mcpb` 2.1.2, esbuild 0.28.2, MCP stdio, MCPB manifest 0.4, `node:test`, Windows GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-claude-mcpb-adapter-design.md`

## Global Constraints

- Support Claude Desktop on Windows only in this phase.
- Support Node.js `^22.19.0 || >=24.0.0` with `node:sqlite`.
- Preserve all existing DSH tool names, input semantics, output shapes, lifecycle behavior, installer behavior, and Release assets.
- Expose exactly seven Claude tools: `market_auction`, `market_data_health`, `market_quotes`, `market_sectors`, `market_series`, `market_status`, and `market_watchlist`.
- Keep the shared core free of imports from Cordis, DSH Tools, SchemActery, and the MCP SDK.
- Keep Claude and DSH databases, watchlists, logs, closure configuration, and recovery state independent.
- Permit custom storage only on a normalized absolute Windows path on a local fixed disk; reject network, removable, relative, device, alternate-data-stream, and unsafe reparse paths.
- Reserve stdout exclusively for MCP protocol frames; diagnostics go to stderr and must not leak local paths, upstream bodies, secrets, or stacks.
- Do not access Tencent or Sina from CI. Use deterministic provider fixtures.
- Do not connect to brokerage accounts, positions, trading APIs, real orders, or simulated orders.
- Ship the existing personal, non-commercial, read-only research license and provider-risk disclaimer without claiming Tencent or Sina authorization.
- Do not install the MCPB locally during ordinary development. A temporary Claude installation is allowed only if final protocol/package tests cannot establish host compatibility, and it must be removed before delivery.
- Publish DSH, Claude, and future Codex assets from one repository, one semantic version, and one tag-only GitHub Release.
- Implement this feature as version `0.2.0`; retain historical tags and releases for rollback and audit.

---

### Task 1: Extract a platform-neutral seven-tool contract

**Files:**
- Create: `src/tool-contracts.ts`
- Modify: `src/tools.ts`
- Create: `test/tool-contracts.test.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/type-surface.test.ts`

**Interfaces:**
- Produces: `MarketToolsService`, the host-neutral seven-method service subset currently declared in `src/tools.ts`.
- Produces: `MarketToolName`, the exact seven-name union.
- Produces: `JsonSchemaObject`, a host-neutral closed-object JSON Schema type.
- Produces: `MarketToolCallContext = { signal: AbortSignal }`.
- Produces: `MarketToolContract = { name, description, inputSchema, outputSchema, execute }`.
- Produces: `createMarketToolContracts(service: MarketToolsService, paths: Pick<RuntimePaths, 'config'>): readonly MarketToolContract[]`.
- Produces: `MarketToolArgsError` and `MarketToolOutputError`, each containing only bounded public messages.
- `src/tools.ts` consumes the contracts and maps platform-neutral errors to DSH `ToolArgsError` and `ToolOutputError`.
- Task 4 consumes the same contracts from the MCP adapter.

- [ ] **Step 1: Write the failing contract-parity tests**

Create service doubles for all seven methods and assert the exact contract surface:

```ts
test('canonical contracts expose exactly the seven DSH market tools', () => {
  const contracts = createMarketToolContracts(service, { config: 'D:\\fixture\\config.json' });
  assert.deepEqual(contracts.map(({ name }) => name).sort(), [
    'market_auction',
    'market_data_health',
    'market_quotes',
    'market_sectors',
    'market_series',
    'market_status',
    'market_watchlist',
  ]);
  for (const contract of contracts) {
    assert.equal(contract.inputSchema.type, 'object');
    assert.equal(contract.inputSchema.additionalProperties, false);
    assert.equal(contract.outputSchema.type, 'object');
    assert.equal(contract.outputSchema.additionalProperties, false);
  }
});
```

Add focused tests showing that default `refresh`, symbol canonicalization, 100-symbol bounds, series range validation, watchlist conditional arguments, output projection, and lossless-JSON rejection are identical when invoked through `createMarketToolContracts` and `registerMarketTools`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --import tsx --test test/tool-contracts.test.ts test/tools.test.ts test/type-surface.test.ts`

Expected: FAIL because `src/tool-contracts.ts` and `createMarketToolContracts` do not exist.

- [ ] **Step 3: Move schemas, semantic validation, projection, and execution into the shared contract module**

Define the host-neutral interface exactly:

```ts
export type MarketToolName =
  | 'market_auction'
  | 'market_data_health'
  | 'market_quotes'
  | 'market_sectors'
  | 'market_series'
  | 'market_status'
  | 'market_watchlist';

export type JsonSchemaObject = Readonly<Record<string, unknown>> & {
  readonly type: 'object';
  readonly additionalProperties: false;
};

export type MarketToolContract = {
  readonly name: MarketToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject;
  execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown>;
};
```

Move the existing input normalization, conditional checks, output projections, collection bounds, and JSON-safe validation without changing messages or limits. Replace DSH error construction inside the shared module with `MarketToolArgsError` and `MarketToolOutputError`.

- [ ] **Step 4: Reduce `src/tools.ts` to the DSH registry adapter**

For each shared contract, create one DSH definition. Map errors at the host edge:

```ts
async execute(args, exec) {
  try {
    return await contract.execute(args, { signal: exec.signal });
  } catch (error) {
    if (error instanceof MarketToolArgsError) throw new ToolArgsError(error.issues);
    if (error instanceof MarketToolOutputError) throw new ToolOutputError(error.message);
    throw error;
  }
}
```

Continue to call DSH's `assertSupportedJsonSchema` and `validateJsonSchemaValue` in the DSH adapter. Do not import DSH packages from `src/tool-contracts.ts`.

- [ ] **Step 5: Run focused and complete regression tests**

Run: `node --import tsx --test test/tool-contracts.test.ts test/tools.test.ts test/type-surface.test.ts`

Run: `npm test`

Expected: all tests PASS; the DSH registry still exposes seven tools and every existing tool assertion remains green.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/tool-contracts.ts src/tools.ts test/tool-contracts.test.ts test/tools.test.ts test/type-surface.test.ts
git commit -m "refactor: share canonical market tool contracts"
```

---

### Task 2: Extract a host-neutral market runtime lifecycle

**Files:**
- Create: `src/runtime.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Create: `test/runtime.test.ts`
- Modify: `test/plugin-load.test.ts`
- Modify: `test/load.test.ts`

**Interfaces:**
- Produces: `MarketRuntimeConfig`, containing the current validated runtime limits and optional `storageDir`.
- Produces: `MarketRuntime = { service: MarketToolsService; paths: RuntimePaths; dispose(): Promise<void> }`.
- Produces: `startMarketRuntime(config: MarketRuntimeConfig, options: MarketRuntimeOptions): Promise<MarketRuntime>`.
- `MarketRuntimeOptions` supplies `baseDirectory`, safe-path validation, state I/O, repository/provider/scheduler factories, and clock.
- `src/index.ts` retains `createApply`, DSH `Config`, and Cordis `ctx.effect`, but delegates provider, repository, scheduler, service, and disposal ownership to `startMarketRuntime`.
- Task 3 supplies Claude-specific configuration and a different `baseDirectory`.

- [ ] **Step 1: Write failing runtime lifecycle tests**

Test successful construction and reverse-order cleanup with injected doubles:

```ts
test('shared runtime starts once and disposes requests, service, and repository exactly once', async () => {
  const runtime = await startMarketRuntime(config, dependencies.fixtureOptions());
  assert.equal(runtime.paths.database.endsWith('market.sqlite'), true);
  await runtime.dispose();
  await runtime.dispose();
  assert.deepEqual(events, ['mkdir', 'load-state', 'open-db', 'providers', 'scheduler', 'service', 'dispose-service', 'drain-limiter']);
});
```

Add startup-failure cases after repository open, limiter construction, and service creation. Assert acquired resources are disposed and the original error is preserved or combined with cleanup errors.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts`

Expected: FAIL because `startMarketRuntime` is undefined.

- [ ] **Step 3: Implement `startMarketRuntime` by extracting the existing lifecycle**

Use this stable public shape:

```ts
export type MarketRuntime = {
  service: MarketToolsService;
  paths: RuntimePaths;
  dispose(): Promise<void>;
};

export async function startMarketRuntime(
  config: MarketRuntimeConfig,
  options: MarketRuntimeOptions,
): Promise<MarketRuntime>;
```

Resolve paths from `options.baseDirectory`, validate both base and effective storage roots before `mkdir`, and preserve the current limiter, provider, scheduler, service, and cleanup ordering. Do not register host tools in this module.

- [ ] **Step 4: Rewire the DSH adapter without changing its public API**

`src/index.ts` must:

1. validate DSH configuration exactly as before;
2. require `DSH_HOME` exactly as before;
3. call `startMarketRuntime`;
4. register DSH tools from shared contracts;
5. return a disposer that unregisters tools before disposing the runtime.

If DSH registration fails, dispose the runtime before rethrowing.

- [ ] **Step 5: Run runtime, DSH, profile, and full tests**

Run: `node --import tsx --test test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts test/tools.test.ts`

Run: `npm run build`

Run: `npm test`

Run: `npm run test:load-profile`

Expected: all commands exit 0; profile smoke still reports seven tools, zero network calls, and zero pending timers.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/runtime.ts src/index.ts src/config.ts test/runtime.test.ts test/plugin-load.test.ts test/load.test.ts
git commit -m "refactor: share market runtime lifecycle"
```

---

### Task 3: Add Claude configuration and isolated Windows storage

**Files:**
- Create: `claude/config.ts`
- Create: `test/claude-config.test.ts`
- Modify: `src/config.ts`
- Modify: `src/paths.ts`
- Modify: `test/paths.test.ts`

**Interfaces:**
- Produces: `ClaudeRuntimeConfig` with `storageDir?`, `requestTimeoutMs`, `quoteIntervalMs`, and `sectorIntervalMs`.
- Produces: `readClaudeConfig(environment: NodeJS.ProcessEnv): ClaudeRuntimeConfig`.
- Produces: `resolveClaudeBaseDirectory(environment: NodeJS.ProcessEnv): string`.
- Default base: `%LOCALAPPDATA%\dsh-market-intelligence\claude`.
- Optional environment variables: `CLAUDE_MARKET_STORAGE_DIR`, `CLAUDE_MARKET_REQUEST_TIMEOUT_MS`, `CLAUDE_MARKET_QUOTE_INTERVAL_MS`, and `CLAUDE_MARKET_SECTOR_INTERVAL_MS`.
- Task 4 passes the validated result to `startMarketRuntime`.

- [ ] **Step 1: Write failing configuration tests**

Cover omitted values, exact integer bounds, empty strings, non-integers, unknown environment independence, and D-drive selection:

```ts
test('Claude defaults to an isolated LocalAppData root', () => {
  assert.equal(
    resolveClaudeBaseDirectory({ LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }),
    'C:\\Users\\fixture\\AppData\\Local\\dsh-market-intelligence\\claude',
  );
});

test('Claude accepts an explicit D-drive storage directory', () => {
  assert.equal(readClaudeConfig({
    LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
    CLAUDE_MARKET_STORAGE_DIR: 'D:\\AI\\claude-market-intelligence',
  }).storageDir, 'D:\\AI\\claude-market-intelligence');
});
```

Assert no Claude resolver reads `DSH_HOME` and no DSH resolver reads the Claude variables.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import tsx --test test/claude-config.test.ts test/paths.test.ts`

Expected: FAIL because the Claude configuration module does not exist.

- [ ] **Step 3: Implement strict environment parsing and isolated defaults**

Treat an omitted or empty custom storage value as absent. Parse decimal integers with an exact canonical regex before applying the existing limits. Require `LOCALAPPDATA` to be a non-empty normalized absolute local Windows path. Reuse `requireLocalWindowsPath` and `assertSafeLocalWindowsPath`; do not weaken either for Claude.

- [ ] **Step 4: Verify configuration and path tests**

Run: `node --import tsx --test test/claude-config.test.ts test/paths.test.ts test/model-config.test.ts`

Expected: PASS; Claude and DSH storage roots remain independent.

- [ ] **Step 5: Commit Task 3**

```powershell
git add claude/config.ts src/config.ts src/paths.ts test/claude-config.test.ts test/paths.test.ts
git commit -m "feat: add isolated Claude runtime configuration"
```

---

### Task 4: Implement the Claude MCP stdio adapter

**Files:**
- Create: `claude/mcp-server.ts`
- Create: `claude/main.ts`
- Create: `claude/logging.ts`
- Create: `test/claude-mcp.test.ts`
- Create: `test/fixtures/claude-server-fixture.ts`
- Create: `tsconfig.claude.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Uses: `@modelcontextprotocol/sdk` `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, and `CallToolRequestSchema`.
- Produces: `createClaudeMcpServer(runtimeFactory, logger): { server; close(): Promise<void> }`.
- Produces: `runClaudeServer(environment, streams): Promise<void>` for the production entry point and injected tests.
- `claude/main.ts` contains only process wiring, signal handling, bounded public stderr logging, and a top-level nonzero exit on startup failure.
- Each successful tool call returns both JSON text content and `structuredContent` containing the same JSON-safe object.

- [ ] **Step 1: Add pinned build dependencies**

Add exact dev dependencies:

```json
"@anthropic-ai/mcpb": "2.1.2",
"@modelcontextprotocol/sdk": "1.30.0",
"esbuild": "0.28.2"
```

Run: `npm install --save-dev --save-exact @anthropic-ai/mcpb@2.1.2 @modelcontextprotocol/sdk@1.30.0 esbuild@0.28.2`

Expected: `package.json` and `package-lock.json` record exact versions.

Create `tsconfig.claude.json` extending the main compiler options, setting `noEmit: true`, and including `claude/**/*.ts` plus the shared `src/**/*.ts`. Add `"typecheck:claude": "tsc -p tsconfig.claude.json"` so esbuild transpilation never substitutes for type checking.

- [ ] **Step 2: Write failing MCP protocol tests**

Use an injected runtime with deterministic service results. Verify MCP initialization, exact tool listing, one call per tool, unknown tool rejection, caller-argument errors, service failure mapping, cancellation forwarding, and close idempotency.

The success assertion is exact:

```ts
assert.deepEqual(result, {
  content: [{ type: 'text', text: JSON.stringify(expected) }],
  structuredContent: expected,
});
```

Capture stdout separately and assert every emitted frame decodes as MCP JSON-RPC; logger messages must appear only on stderr.

- [ ] **Step 3: Run protocol tests and verify RED**

Run: `node --import tsx --test test/claude-mcp.test.ts`

Expected: FAIL because the Claude MCP server modules do not exist.

- [ ] **Step 4: Implement the low-level MCP tool registry**

Create the server with tool capability and register handlers:

```ts
const server = new Server(
  { name: 'dsh-market-intelligence', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: contracts.map(({ name, description, inputSchema, outputSchema }) => ({
    name,
    description,
    inputSchema,
    outputSchema,
  })),
}));
```

For calls, look up one exact contract and invoke it with the request signal. Convert `MarketToolArgsError` to MCP invalid-params behavior. Convert bounded operational errors to `{ isError: true, content: [{ type: 'text', text: safeMessage }] }`. Never serialize raw thrown values.

- [ ] **Step 5: Implement production lifecycle and signal handling**

`runClaudeServer` must start the shared runtime, connect one `StdioServerTransport`, and register `SIGINT`/`SIGTERM` handlers that call one idempotent close path. If MCP connection fails, close the runtime. If runtime startup fails, do not construct the transport.

Use a fixed logger API:

```ts
export type ClaudeLogger = {
  info(event: string): void;
  error(category: 'config' | 'runtime' | 'protocol' | 'internal'): void;
};
```

The logger prints fixed event/category tokens to stderr and never accepts arbitrary error text.

- [ ] **Step 6: Run protocol, contract, and full regression tests**

Run: `node --import tsx --test test/claude-mcp.test.ts test/tool-contracts.test.ts test/runtime.test.ts`

Run: `npm run build`

Run: `npm run typecheck:claude`

Run: `npm test`

Expected: all tests PASS; no test performs a live provider request.

- [ ] **Step 7: Commit Task 4**

```powershell
git add claude/mcp-server.ts claude/main.ts claude/logging.ts test/claude-mcp.test.ts test/fixtures/claude-server-fixture.ts tsconfig.claude.json package.json package-lock.json
git commit -m "feat: expose market tools over Claude MCP"
```

---

### Task 5: Build and validate the Windows MCPB

**Files:**
- Create: `claude/manifest.ts`
- Create: `scripts/build-claude-mcpb.ts`
- Create: `test/claude-manifest.test.ts`
- Create: `test/claude-package.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createClaudeManifest(version: string): McpbManifest`.
- CLI: `node --import tsx scripts/build-claude-mcpb.ts --output <absolute-or-relative-output-file>`.
- Output filename for publication: `claude-market-intelligence-latest.mcpb`.
- Staging uses a fresh temporary directory, bundles `claude/main.ts` to `server/index.js`, copies `LICENSE`, writes `manifest.json`, validates it, packs it, verifies archive contents, then atomically moves the final file.

- [ ] **Step 1: Write failing manifest tests**

Assert these fixed fields:

```ts
assert.equal(manifest.manifest_version, '0.4');
assert.equal(manifest.name, 'dsh-market-intelligence');
assert.equal(manifest.version, '0.2.0');
assert.deepEqual(manifest.compatibility.platforms, ['win32']);
assert.equal(manifest.server.type, 'node');
assert.equal(manifest.server.entry_point, 'server/index.js');
assert.deepEqual(manifest.privacy_policies, [
  'https://www.tencent.com/privacy-policy/',
  'https://corp.sina.com.cn/eng/sina_priv_eng.htm',
]);
assert.deepEqual(manifest.tools.map(({ name }) => name).sort(), expectedSevenNames);
```

Assert the manifest exposes four configuration fields and maps them only to the four `CLAUDE_MARKET_*` environment variables. Assert it contains the limited-use description and does not claim provider authorization.

- [ ] **Step 2: Run manifest tests and verify RED**

Run: `node --import tsx --test test/claude-manifest.test.ts`

Expected: FAIL because the manifest factory does not exist.

- [ ] **Step 3: Implement the manifest factory**

Use MCPB manifest 0.4, repository/support/documentation URLs under `Yalen-xy/dsh-market-intelligence`, Node runtime `>=22.19.0`, Windows-only compatibility, exact tool declarations, and `tools_generated: false`. Mark no configuration as sensitive because the extension has no credentials.

Define optional `storage_dir` as type `directory`; define numeric interval fields with the same min/max values as runtime validation. Map user configuration through `server.mcp_config.env` to the four fixed environment names.

- [ ] **Step 4: Write failing package-builder tests**

Build into a test temporary directory and assert:

- official MCPB validation succeeds;
- the archive contains exactly three ordinary files: `manifest.json`, `server/index.js`, and `LICENSE`;
- the bundle does not contain source maps, TypeScript, tests, fixtures, databases, logs, secrets, user paths, `@deepseek-ai`, Cordis, SchemActery, or DSH patches;
- the server bundle contains no absolute repository path;
- corrupt, existing, directory, symlink, and overlapping output targets fail closed.

- [ ] **Step 5: Run package tests and verify RED**

Run: `node --import tsx --test test/claude-package.test.ts`

Expected: FAIL because the builder does not exist.

- [ ] **Step 6: Implement deterministic build, validation, and atomic output**

Use esbuild with:

```js
await build({
  entryPoints: ['claude/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: serverEntry,
  sourcemap: false,
  legalComments: 'none',
});
```

Invoke the repository-local MCPB CLI, never `npx` network resolution. Validate before and after packing. Inspect the MCPB as a ZIP, reject noncanonical names or extra files, calculate SHA-256, and rename into place only after all checks pass. Preserve a diagnostic temporary directory only on failure and print only its generated basename.

- [ ] **Step 7: Add scripts and verify the real artifact**

Add:

```json
"build:claude": "node --import tsx scripts/build-claude-mcpb.ts --output .artifacts/claude-market-intelligence-latest.mcpb",
"test:claude": "node --import tsx --test test/claude-*.test.ts"
```

Run: `npm run build:claude`

Run: `npm run test:claude`

Expected: both commands exit 0 and `.artifacts/claude-market-intelligence-latest.mcpb` passes official validation and the explicit file allowlist.

- [ ] **Step 8: Commit Task 5**

```powershell
git add claude/manifest.ts scripts/build-claude-mcpb.ts test/claude-manifest.test.ts test/claude-package.test.ts package.json .gitignore
git commit -m "build: package the Claude Windows extension"
```

---

### Task 6: Add real stdio smoke and shutdown verification

**Files:**
- Create: `scripts/claude-smoke.mjs`
- Create: `test/claude-stdio.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI: `node scripts/claude-smoke.mjs --bundle <mcpb-path>`.
- The smoke extracts to a fresh test directory, launches the staged `server/index.js`, connects with SDK `Client` and `StdioClientTransport`, lists seven tools, calls every tool with network-free arguments, closes the client, and verifies process exit and zero remaining files outside the test root.
- The smoke sets `CLAUDE_MARKET_STORAGE_DIR` to its generated fixed-disk test root and does not add a production fixture mode or hidden provider override.

- [ ] **Step 1: Write the failing child-process smoke test**

Assert the real bundled server:

```ts
test('staged MCPB serves seven tools over a real stdio child process and shuts down cleanly', async (t) => {
  const result = await runClaudeSmoke(t, stagedBundle);
  assert.deepEqual(result.toolNames.sort(), expectedSevenNames);
  assert.equal(result.calls, 7);
  assert.equal(result.protocolNoise, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.pendingChildren, 0);
});
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run: `node --import tsx --test test/claude-stdio.test.ts`

Expected: FAIL because `scripts/claude-smoke.mjs` does not exist.

- [ ] **Step 3: Implement the network-free real MCP client smoke**

Call the real staged tools with arguments that cannot request providers:

```ts
await client.callTool({ name: 'market_status', arguments: {} });
await client.callTool({ name: 'market_quotes', arguments: { symbols: [], refresh: false } });
await client.callTool({ name: 'market_series', arguments: { symbol: 'sh000001', interval: 'day', refresh: false } });
await client.callTool({ name: 'market_sectors', arguments: { refresh: false } });
await client.callTool({ name: 'market_auction', arguments: { market: 'CN', symbols: [] } });
await client.callTool({ name: 'market_watchlist', arguments: { action: 'get' } });
await client.callTool({ name: 'market_data_health', arguments: {} });
```

Instrument the smoke process to fail if any HTTP request occurs. Use a 30-second overall timeout, terminate only its owned child process on timeout, and retain logs without absolute paths.

- [ ] **Step 4: Run smoke and complete Claude tests**

Add `"test:claude:smoke": "node scripts/claude-smoke.mjs --bundle .artifacts/claude-market-intelligence-latest.mcpb"`.

Run: `npm run build:claude`

Run: `npm run test:claude`

Run: `npm run test:claude:smoke`

Expected: all commands exit 0; smoke reports seven tools, seven successful network-free calls, no protocol noise, and clean child shutdown.

- [ ] **Step 5: Commit Task 6**

```powershell
git add scripts/claude-smoke.mjs test/claude-stdio.test.ts package.json
git commit -m "test: verify Claude MCPB over real stdio"
```

---

### Task 7: Integrate Claude into CI and the shared Release

**Files:**
- Modify: `scripts/stage-release.mjs`
- Modify: `test/release-artifacts.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `test/workflow-policy.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Extend staging CLI with required `--claude <mcpb>`.
- Release output becomes exactly seven files: the existing six DSH assets plus `claude-market-intelligence-latest.mcpb`.
- `SHA256SUMS.txt` includes the MCPB hash while retaining every existing DSH hash.
- CI and Release both run `build:claude`, `test:claude`, and `test:claude:smoke` before publication.

- [ ] **Step 1: Write failing release-staging tests**

Update fixture staging to require a valid MCPB with version matching the tag. Assert exact seven-file output, canonical SHA-256 row, unchanged six-entry DSH customer ZIP, and rejection of missing, mismatched, corrupt, symlinked, or overlapping MCPB input.

- [ ] **Step 2: Run staging tests and verify RED**

Run: `node --import tsx --test test/release-artifacts.test.ts`

Expected: FAIL because staging does not accept or publish the Claude artifact.

- [ ] **Step 3: Extend atomic release staging**

Parse and validate the MCPB manifest version and package semantic version before copying. Snapshot the MCPB bytes with the other source assets, include its hash in the canonical manifest, preserve deterministic ZIP construction, verify the complete seven-file output, then atomically rename the release directory.

- [ ] **Step 4: Write failing workflow-policy tests**

Require the CI/Release order:

```text
npm ci
npm run build
npm run build:claude
npm test
npm run test:claude
npm run test:claude:smoke
existing DSH installer/profile/package gates
stage-release --claude
gh release create
```

Require Windows runners, Node 24, timeouts of at least 45 minutes, tag-only publication, exact seven-asset publication, and `GH_TOKEN` only on the publication step.

- [ ] **Step 5: Run workflow tests and verify RED**

Run: `node --import tsx --test test/workflow-policy.test.ts`

Expected: FAIL because workflows do not build or publish Claude.

- [ ] **Step 6: Update CI, Release, version, and fixed notes**

Bump `package.json` and `package-lock.json` to `0.2.0`. Set both workflow timeouts to 45 minutes. Build and smoke the MCPB before DSH release staging. Pass `--claude .artifacts\claude-market-intelligence-latest.mcpb`. Publish the exact seven explicit paths without wildcards.

Replace obsolete “DSH Desktop” Release-note wording with DeepSeek Harness and explain that the Release contains separate DSH and Claude installation assets under the same license and disclaimer.

- [ ] **Step 7: Run release, workflow, build, and full tests**

Run: `node --import tsx --test test/release-artifacts.test.ts test/workflow-policy.test.ts`

Run: `npm run build`

Run: `npm run build:claude`

Run: `npm test`

Run: `npm run test:claude:smoke`

Expected: all commands exit 0; staged fixtures contain exactly seven release files and the DSH ZIP remains structurally unchanged.

- [ ] **Step 8: Commit Task 7**

```powershell
git add scripts/stage-release.mjs test/release-artifacts.test.ts .github/workflows/ci.yml .github/workflows/release.yml test/workflow-policy.test.ts package.json package-lock.json
git commit -m "ci: publish DSH and Claude from one release"
```

---

### Task 8: Document Claude installation and shared-version policy

**Files:**
- Create: `docs/CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TOOLS.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `test/package-release.test.ts`

**Interfaces:**
- README displays two latest customer downloads: DSH ZIP and Claude MCPB.
- `docs/CLAUDE.md` documents Windows installation, configuration, storage isolation, seven tools, uninstall, diagnostics, and legal boundaries without command-heavy source code.
- Architecture documents the shared-core/adapter boundary and reserved Codex adapter.

- [ ] **Step 1: Write failing documentation-policy tests**

Assert:

- README contains the fixed latest DSH ZIP URL and fixed latest Claude MCPB URL;
- README contains no version-specific customer URL or large command block;
- Claude instructions say Settings → Extensions → Advanced settings → Install Extension and select the `.mcpb`;
- docs list all seven exact tools and state Claude/DSH databases are independent;
- docs do not claim Anthropic, Tencent, Sina, or DeepSeek endorsement;
- the canonical English license/provider-risk paragraph remains present;
- no developer-specific path, credential, source map, or local Claude configuration path is published.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test test/package-release.test.ts`

Expected: FAIL because Claude documentation and download entry do not exist.

- [ ] **Step 3: Write concise customer and architecture documentation**

README installation choices:

```markdown
### DeepSeek Harness
[下载最新版 Windows 插件安装包](.../dsh-market-intelligence-latest.zip)

### Claude Desktop
[下载最新版 Claude Windows 扩展](.../claude-market-intelligence-latest.mcpb)
```

Keep the existing expert, restrained voice and CI badge. Put detailed Claude steps in `docs/CLAUDE.md`. State that the MCPB is Windows-only, requires no manual npm or JSON setup, stores data separately from DSH, and remains subject to the same read-only research license and disclaimer.

- [ ] **Step 4: Run docs, package, and diff checks**

Run: `node --import tsx --test test/package-release.test.ts`

Run: `npm pack --dry-run --ignore-scripts --json`

Run: `git diff --check`

Expected: all commands exit 0 and public/package documentation contains no user-specific path.

- [ ] **Step 5: Commit Task 8**

```powershell
git add README.md docs/CLAUDE.md docs/ARCHITECTURE.md docs/TOOLS.md SECURITY.md CHANGELOG.md test/package-release.test.ts
git commit -m "docs: add Claude extension installation"
```

---

### Task 9: Fresh verification, optional Claude host check, cleanup, and publication

**Files:**
- Modify only if verification exposes a scoped defect.
- Do not create persistent files in Claude configuration or data directories.

**Interfaces:**
- Final evidence includes local command exit codes, test counts, DSH profile smoke, MCP tool smoke, MCPB validation, exact archive entries, SHA-256 values, clean local Claude state, green main CI, green tag Release workflow, and public asset list.

- [ ] **Step 1: Record pre-validation local state without mutation**

Check for owned test processes and the exact extension identifier `dsh-market-intelligence` in Claude Desktop's currently recognized extension list using the least-invasive available method. Record whether the target extension is absent. Do not enumerate unrelated extension contents, credentials, browser state, or user conversations.

Run: `git status --short`

Expected: only intentional implementation changes are present; no Claude market extension is installed.

- [ ] **Step 2: Run the complete clean verification sequence**

Run in order:

```powershell
npm ci
npm run build
npm run build:claude
npm test
npm run test:claude
npm run test:claude:smoke
npm run test:load-profile
npm run test:installer:windows-powershell
npm run test:installer:pwsh
npm pack --dry-run --ignore-scripts --json
git diff --check
```

Expected: every command exits 0; DSH smoke reports seven tools with zero network calls and pending timers; Claude smoke reports seven tools, seven network-free calls, no protocol noise, and clean shutdown.

- [ ] **Step 3: Stage and independently inspect the real `0.2.0` release**

Create the npm tarball, build the MCPB, and run:

```powershell
node scripts/stage-release.mjs --tag v0.2.0 --package .\dsh-market-intelligence-0.2.0.tgz --claude .\.artifacts\claude-market-intelligence-latest.mcpb --output .\.release-candidate-0.2.0
```

Verify exactly seven files, recompute every SHA-256 independently, inspect the DSH ZIP's six entries, inspect the MCPB allowlist, and run the official MCPB validator against the candidate.

- [ ] **Step 4: Decide whether temporary Claude installation is necessary**

Treat direct stdio initialization, official MCPB validation, archive inspection, and Windows smoke as sufficient unless Claude-specific host discovery or manifest substitution remains unverified. Record the decision and evidence.

If a host gap remains, snapshot only the target extension's pre-state, install the candidate through Claude Desktop's supported “Install Extension” flow, verify the extension is recognized and one fixture-bounded tool call succeeds, then disable and uninstall it before continuing. Do not run continuous collection or broad live queries.

- [ ] **Step 5: Verify final local cleanup**

Stop every owned test server. Remove only generated test roots and the known `.release-candidate-0.2.0` directory after hashes are recorded. If temporary host installation occurred, verify the exact extension identifier, its test database, logs, cache, and test configuration are absent and the pre-state is restored. Verify `D:\AI\dsh` and its profile/storage modification times and fingerprints were not changed by Claude validation.

- [ ] **Step 6: Review every acceptance criterion and request code review**

Map each design acceptance criterion to a test or command result. Use `superpowers:requesting-code-review`, address only evidence-backed findings, rerun affected focused tests, then rerun the complete sequence if runtime, release, or security files changed.

- [ ] **Step 7: Push reviewed commits and wait for green main CI**

Push the reviewed commit chain to `main`. Wait for the exact head SHA's CI run to finish successfully. If it fails, read the exact job log, reproduce the leaf failure locally, and follow systematic debugging; do not rerun blindly.

- [ ] **Step 8: Create and push `v0.2.0` only after green main CI**

Verify the tag and Release do not already exist. Create `v0.2.0` at the green main commit and push the tag. Wait for the tag-only Release workflow; do not manually upload partial assets.

- [ ] **Step 9: Verify the public Release and customer downloads**

Verify the Release is public, points to the intended commit, and contains exactly seven assets including:

- `dsh-market-intelligence-latest.zip`
- `claude-market-intelligence-latest.mcpb`

Download both fixed latest URLs, match their hashes to the published manifest, inspect their allowlists again, and verify the README links resolve to those bytes. Report commit, tag, CI run, Release run, test counts, exact asset names, hashes, and confirmation that no Claude extension remains installed locally.
