import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, JSONRPCMessageSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createClaudeMcpServer } from '../claude/mcp-server.ts';
import { runClaudeServer } from '../claude/main.ts';
import { createMarketToolContracts } from '../src/tool-contracts.ts';
import { createRuntimeFixture, EXPECTED_RESULTS, VALID_CALLS } from './fixtures/claude-server-fixture.ts';

const TOOL_NAMES = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
] as const;

test('initializes MCP and lists the exact canonical seven-tool contract', async () => {
  const fixture = createRuntimeFixture();
  const logger = memoryLogger();
  const managed = createClaudeMcpServer(() => fixture.runtime, logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-client', version: '1.0.0' }, { capabilities: {} });
  await managed.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'dsh-market-intelligence', version: '0.2.0' });
    assert.deepEqual(client.getServerCapabilities(), { tools: {} });
    const listed = await client.listTools();
    const canonical = createMarketToolContracts(fixture.service, fixture.runtime.paths);
    assert.deepEqual(listed.tools, canonical.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })));
    assert.deepEqual(listed.tools.map(({ name }) => name).toSorted(), [...TOOL_NAMES]);
  } finally {
    await managed.close();
    await client.close().catch(() => undefined);
  }
});

test('returns matching JSON text and structured content for every market tool', async () => {
  const fixture = createRuntimeFixture();
  const { client, managed } = await connectedFixture(fixture);
  try {
    for (const name of TOOL_NAMES) {
      const expected = EXPECTED_RESULTS[name];
      const result = await client.callTool({ name, arguments: VALID_CALLS[name] });
      assert.deepEqual(result, {
        content: [{ type: 'text', text: JSON.stringify(expected) }],
        structuredContent: expected,
      }, name);
    }
    assert.equal(fixture.calls.length, 7);
  } finally {
    await managed.close();
    await client.close().catch(() => undefined);
  }
});

test('rejects unknown tools and caller argument errors as invalid params', async () => {
  const fixture = createRuntimeFixture();
  const { client, managed } = await connectedFixture(fixture);
  try {
    await assert.rejects(client.callTool({ name: 'market_unknown', arguments: {} }), invalidParams);
    await assert.rejects(client.callTool({ name: 'market_series', arguments: { interval: 'day' } }), invalidParams);
  } finally {
    await managed.close();
    await client.close().catch(() => undefined);
  }
});

test('maps every malformed tools/call envelope that reaches the server to bounded invalid params', async () => {
  const fixture = createRuntimeFixture();
  const managed = createClaudeMcpServer(() => fixture.runtime, memoryLogger());
  const [rawClient, serverTransport] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, unknown>();
  rawClient.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') responses.set(message.id, message);
  };
  await rawClient.start();
  await managed.server.connect(serverTransport);
  const hostile = 'secret-token at D:\\Users\\fixture and <upstream-body>';
  const malformed = [
    {},
    { params: {} },
    { params: { name: null } },
    { params: { name: 7 } },
    { params: { name: ['market_quotes'] } },
    { params: { name: 'market_quotes', arguments: [] } },
    { params: { name: 'market_quotes', arguments: null } },
    { params: { name: 'market_quotes', arguments: hostile } },
    { params: { name: 'market_quotes', arguments: 7 } },
    { params: { name: 'market_quotes', arguments: true } },
  ] as const;
  try {
    for (const [index, envelope] of malformed.entries()) {
      await rawClient.send({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        ...envelope,
      } as never);
    }
    await waitFor(() => responses.size === malformed.length);
    for (const id of malformed.keys().map((index) => index + 1)) {
      assert.deepEqual(responses.get(id), {
        jsonrpc: '2.0',
        id,
        error: { code: ErrorCode.InvalidParams, message: 'MCP error -32602: Invalid tools/call request' },
      });
    }
    assert.equal(fixture.calls.length, 0);
    assert.doesNotMatch(JSON.stringify([...responses.values()]), /secret-token|Users|upstream-body|expected|received|path/i);
  } finally {
    await managed.close();
    await rawClient.close().catch(() => undefined);
  }
});

test('stdio returns one bounded invalid-params frame for every non-object tools/call params container', async () => {
  const fixture = createRuntimeFixture();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals = new EventEmitter();
  let output = '';
  stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await runClaudeServer({ LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, {
    stdin,
    stdout,
    stderr,
    signals,
    runtimeFactory: async () => fixture.runtime,
  });
  const hostile = 'secret-token at D:\\Users\\fixture and <upstream-body>';
  const invalidParams = [null, [], hostile, 7, true] as const;
  try {
    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-fixture', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => output.split(/\r?\n/).filter(Boolean).length === 1);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    for (const [index, params] of invalidParams.entries()) {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 10, method: 'tools/call', params })}\n`);
    }
    await waitFor(() => output.split(/\r?\n/).filter(Boolean).length >= invalidParams.length + 1);
    const frames = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    for (const frame of frames) assert.doesNotThrow(() => JSONRPCMessageSchema.parse(frame));
    const callFrames = frames.filter((frame) => typeof frame.id === 'number' && frame.id >= 10);
    assert.deepEqual(callFrames, invalidParams.map((_params, index) => ({
      jsonrpc: '2.0',
      id: index + 10,
      error: { code: ErrorCode.InvalidParams, message: 'Invalid tools/call request' },
    })));
    assert.equal(new Set(callFrames.map(({ id }) => id)).size, invalidParams.length);
    assert.equal(fixture.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(callFrames), /secret-token|Users|upstream-body|expected|received|path/i);
  } finally {
    signals.emit('SIGTERM');
    await waitFor(() => fixture.disposeCalls() === 1);
  }
});

test('maps service failures to a bounded tool error without serializing thrown values', async () => {
  const fixture = createRuntimeFixture();
  fixture.service.quotes = async () => { throw new Error('secret-token at D:\\Users\\fixture and <upstream-body>'); };
  const logger = memoryLogger();
  const { client, managed } = await connectedFixture(fixture, logger);
  try {
    const result = await client.callTool({ name: 'market_quotes', arguments: {} });
    assert.deepEqual(result, {
      isError: true,
      content: [{ type: 'text', text: 'Market data request failed' }],
    });
    assert.deepEqual(logger.errors, ['runtime']);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|Users|upstream-body/);
  } finally {
    await managed.close();
    await client.close().catch(() => undefined);
  }
});

test('forwards MCP cancellation to cancellable market service operations', async () => {
  const fixture = createRuntimeFixture();
  let observedSignal: AbortSignal | undefined;
  fixture.service.quotes = async (_args, signal) => {
    observedSignal = signal;
    await once(signal, 'abort');
    throw signal.reason;
  };
  const { client, managed } = await connectedFixture(fixture);
  const cancellation = new AbortController();
  try {
    const call = client.callTool({ name: 'market_quotes', arguments: {} }, undefined, { signal: cancellation.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    cancellation.abort();
    await assert.rejects(call);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observedSignal?.aborted, true);
  } finally {
    await managed.close();
    await client.close().catch(() => undefined);
  }
});

test('closes the MCP transport and runtime exactly once', async () => {
  const fixture = createRuntimeFixture();
  const { client, managed } = await connectedFixture(fixture);
  await Promise.all([managed.close(), managed.close(), managed.close()]);
  assert.equal(fixture.disposeCalls(), 1);
  await client.close().catch(() => undefined);
});

test('stdio emits only decodable MCP JSON-RPC frames and diagnostics stay on stderr', async (t) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/claude-server-fixture.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { if (!child.killed) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-fixture', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'market_data_health', arguments: {} } },
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  await waitFor(() => stdout.split(/\r?\n/).filter(Boolean).length >= 3);
  child.stdin.end();
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);
  const frames = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(frames.length, 3);
  for (const frame of frames) assert.doesNotThrow(() => JSONRPCMessageSchema.parse(frame));
  assert.match(stderr, /claude_mcp info ready/);
  assert.doesNotMatch(stderr, /D:\\|Users|secret|upstream-body|\bat .+\.ts:\d+/i);
});

test('runClaudeServer passes Claude config and base directory through runtime and closes on signals', async () => {
  const fixture = createRuntimeFixture();
  const signals = new EventEmitter();
  const stderr = new PassThrough();
  let received: { config: unknown; baseDirectory: string; paths: unknown } | undefined;
  await runClaudeServer({
    LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
    CLAUDE_MARKET_STORAGE_DIR: 'D:\\market-data',
  }, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr, signals,
    runtimeFactory: async (config, options) => {
      received = {
        config,
        baseDirectory: options.baseDirectory,
        paths: options.resolvePaths?.(options.baseDirectory, config.storageDir),
      };
      return fixture.runtime;
    },
  });
  assert.deepEqual(received, {
    baseDirectory: 'C:\\Users\\fixture\\AppData\\Local\\dsh-market-intelligence\\claude',
    paths: {
      root: 'D:\\market-data',
      database: 'D:\\market-data\\claude-market.sqlite',
      config: 'D:\\market-data\\claude-config.json',
    },
    config: {
      storageDir: 'D:\\market-data', requestTimeoutMs: 10_000, providerBatchSize: 100, providerConcurrency: 4,
      quoteIntervalMs: 10_000, sectorIntervalMs: 60_000, sectorPersistIntervalMs: 300_000,
      minuteRetentionTradingDays: 30, storageSoftLimitBytes: 536_870_912, watchlistLimit: 100,
    },
  });
  signals.emit('SIGTERM');
  await waitFor(() => fixture.disposeCalls() === 1);
});

test('runClaudeServer releases its runtime when the stdio input reaches EOF', async () => {
  const fixture = createRuntimeFixture();
  const stdin = new PassThrough();
  await runClaudeServer({ LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: new EventEmitter(),
    runtimeFactory: async () => fixture.runtime,
  });

  stdin.end();
  await waitFor(() => fixture.disposeCalls() === 1);
});

test('runClaudeServer does not construct transport after startup failure and rolls back connection failure', async () => {
  const environment = { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' };
  const failedStartup = createRuntimeFixture();
  let transports = 0;
  await assert.rejects(runClaudeServer(environment, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: new EventEmitter(),
    runtimeFactory: async () => { throw new Error('D:\\secret startup body'); },
    transportFactory: () => { transports += 1; return new InMemoryTransport(); },
  }));
  assert.equal(transports, 0);
  assert.equal(failedStartup.disposeCalls(), 0);

  const failedConstruction = createRuntimeFixture();
  await assert.rejects(runClaudeServer(environment, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: new EventEmitter(),
    runtimeFactory: async () => failedConstruction.runtime,
    transportFactory: () => { throw new Error('transport construction failed at D:\\secret'); },
  }));
  assert.equal(failedConstruction.disposeCalls(), 1);

  const failedConnection = createRuntimeFixture();
  await assert.rejects(runClaudeServer(environment, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: new EventEmitter(),
    runtimeFactory: async () => failedConnection.runtime,
    transportFactory: () => ({
      async start() { throw new Error('protocol setup failed at D:\\secret'); },
      async send() {},
      async close() {},
    }),
  }));
  assert.equal(failedConnection.disposeCalls(), 1);
});

async function connectedFixture(fixture: ReturnType<typeof createRuntimeFixture>, logger = memoryLogger()) {
  const managed = createClaudeMcpServer(() => fixture.runtime, logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-client', version: '1.0.0' }, { capabilities: {} });
  await managed.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, managed };
}

function memoryLogger() {
  return {
    infos: [] as string[], errors: [] as string[],
    info(event: string) { this.infos.push(event); },
    error(category: 'config' | 'runtime' | 'protocol' | 'internal') { this.errors.push(category); },
  };
}

function invalidParams(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
