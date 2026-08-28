import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool, ToolOutputError, type JsonSchemaNode, type JsonValue } from '@deepseek-ai/dsh-tools';
import type { RuntimePaths } from '../src/config.js';
import type {
  AuctionServiceResult,
  HealthResult,
  QuotesResult,
  SectorsResult,
  SeriesResult,
  StatusResult,
  WatchlistResult,
} from '../src/service.js';
import { registerMarketTools, type MarketToolsService } from '../src/tools.js';

const TOOL_NAMES = [
  'market_status',
  'market_quotes',
  'market_series',
  'market_sectors',
  'market_auction',
  'market_watchlist',
  'market_data_health',
] as const;

const paths: RuntimePaths = {
  root: 'D:\\runtime',
  database: 'D:\\runtime\\market.sqlite',
  config: 'D:\\runtime\\config.json',
};

const quote = {
  symbol: 'sh600000',
  name: '浦发银行',
  market: 'CN' as const,
  currency: 'CNY' as const,
  price: 10.25,
  open: 10.1,
  high: 10.3,
  low: 10.05,
  previousClose: 10,
  volume: 123_400,
  amount: 1_260_000,
  change: 0.25,
  changePercent: 2.5,
  marketTime: '2026-08-27T10:00:00+08:00',
  fetchedAt: '2026-08-27T02:00:01.000Z',
  source: 'tencent',
  isDelayed: false,
  isStale: false,
};

const statusResult: StatusResult = {
  asOf: '2026-08-27T02:00:01.000Z',
  collectionActive: true,
  lastSuccessfulUpdate: null,
  markets: [
    {
      market: 'CN',
      phase: 'continuous',
      tradingDate: '2026-08-27',
      sessionStart: '09:30',
      sessionEnd: '11:30',
      collectionActive: true,
      calendarConfidence: 'configured',
    },
    {
      market: 'HK',
      phase: 'continuous',
      tradingDate: '2026-08-27',
      sessionStart: '09:30',
      sessionEnd: '12:00',
      collectionActive: true,
      calendarConfidence: 'degraded',
    },
  ],
};

const quotesResult: QuotesResult = {
  availability: 'live',
  items: [quote, { ...quote, symbol: 'hk00700', name: null, market: 'HK', currency: 'HKD', price: null }],
  conflicts: [{
    symbol: 'sh600000',
    field: 'price',
    observations: [
      { source: 'tencent', marketTime: quote.marketTime, value: quote.price },
      { source: 'sina', marketTime: quote.marketTime, value: '10.20' },
    ],
    detectedAt: '2026-08-27T02:00:01.000Z',
  }],
};

const seriesResult: SeriesResult = {
  availability: 'cached',
  source: 'storage',
  items: [{
    symbol: 'sh600000',
    market: 'CN',
    interval: 'minute',
    timestamp: '2026-08-27T10:00:00+08:00',
    open: 10.1,
    high: 10.3,
    low: 10.05,
    close: 10.25,
    volume: null,
    turnover: 1_260_000,
  }],
};

const sectorsResult: SectorsResult = {
  availability: 'cached',
  items: [{
    id: 'industry-bank',
    name: '银行',
    category: 'industry',
    changePercent: 1.2,
    turnover: null,
    netFlow: 123_000_000,
    leaderSymbol: 'sh600000',
    leaderName: null,
    leaderChangePercent: 2.5,
    marketTime: null,
    fetchedAt: '2026-08-27T02:00:01.000Z',
    source: 'sina',
    isDelayed: true,
    isStale: false,
  }],
};

const auctionResult: AuctionServiceResult = {
  availability: 'unavailable',
  phase: 'closed',
  reason: 'CN auction is inactive',
  items: [],
};

const maintenanceResult = {
  runAt: '2026-08-27T02:00:00.000Z',
  completedAt: '2026-08-27T02:00:01.000Z',
  compactedTradingDates: ['CN:2026-08-26', 'HK:2026-08-26'],
  compactedRawRows: 10,
  createdMinuteBars: 1,
  createdDailyBars: 1,
  createdDailySectorSummaries: 1,
  deletedRawRows: 10,
  expiredMinuteTradingDates: ['CN:2026-07-01', 'HK:2026-07-01'],
  expiredMinuteRows: 4,
  prunedMinuteTradingDates: ['2026-06-30'],
  prunedMinuteRows: 2,
  prunedSectorBuckets: ['2026-06-30T01:30:00.000Z'],
  prunedSectorRows: 3,
  bytesBefore: 10_000,
  bytesAfter: 9_000,
  maxBytes: 536_870_912,
  capSatisfied: true,
};

const healthResult: HealthResult = {
  providers: [{
    provider: 'tencent',
    available: true,
    latencyMs: 35,
    lastAttemptAt: '2026-08-27T02:00:00.000Z',
    lastSuccessAt: '2026-08-27T02:00:00.035Z',
    lastFailureAt: null,
    consecutiveFailures: 0,
    errorCategory: null,
  }],
  scheduler: { state: 'running', pendingTimers: 2, inFlight: 0 },
  database: {
    databaseBytes: 10_000,
    liveDatabaseBytes: 9_000,
    counts: {
      quoteObservations: 2,
      minuteBars: 1,
      dailyBars: 1,
      sectorObservations: 1,
      sectorDailySummaries: 1,
    },
  },
  gaps: [{
    market: 'HK',
    symbol: null,
    interval: 'minute',
    start: '2026-08-26T01:30:00.000Z',
    end: '2026-08-26T02:00:00.000Z',
    reason: 'provider does not expose backfill',
    recordedAt: '2026-08-27T02:00:00.000Z',
  }],
  retention: { status: 'ok', lastResult: maintenanceResult },
};

type ResultOverrides = Partial<{
  status: unknown;
  quotes: unknown;
  series: unknown;
  sectors: unknown;
  auction: unknown;
  watchlist: unknown;
  health: unknown;
}>;

function serviceFixture(overrides: ResultOverrides = {}) {
  const signals: Array<{ method: string; signal: AbortSignal }> = [];
  const calls: string[] = [];
  const requests: Array<{ method: string; request: unknown }> = [];
  let watchlist = ['sh600000'];
  const service = {
    status() {
      calls.push('status');
      return overrides.status ?? structuredClone(statusResult);
    },
    async quotes(request: unknown, signal: AbortSignal) {
      calls.push('quotes');
      requests.push({ method: 'quotes', request });
      signals.push({ method: 'quotes', signal });
      return overrides.quotes ?? structuredClone(quotesResult);
    },
    async series(request: unknown, signal: AbortSignal) {
      calls.push('series');
      requests.push({ method: 'series', request });
      signals.push({ method: 'series', signal });
      return overrides.series ?? structuredClone(seriesResult);
    },
    async sectors(request: unknown, signal: AbortSignal) {
      calls.push('sectors');
      requests.push({ method: 'sectors', request });
      signals.push({ method: 'sectors', signal });
      return overrides.sectors ?? structuredClone(sectorsResult);
    },
    async auction(request: unknown, signal: AbortSignal) {
      calls.push('auction');
      requests.push({ method: 'auction', request });
      signals.push({ method: 'auction', signal });
      return overrides.auction ?? structuredClone(auctionResult);
    },
    async watchlist(request: { action: 'get' | 'add' | 'remove'; symbol?: string }, signal: AbortSignal) {
      calls.push('watchlist');
      requests.push({ method: 'watchlist', request });
      signals.push({ method: 'watchlist', signal });
      if (overrides.watchlist !== undefined) return overrides.watchlist;
      if (request.action === 'add') watchlist = [...watchlist, request.symbol!];
      if (request.action === 'remove') watchlist = watchlist.filter((symbol) => symbol !== request.symbol);
      return { watchlist: [...watchlist] } satisfies WatchlistResult;
    },
    health() {
      calls.push('health');
      return overrides.health ?? structuredClone(healthResult);
    },
  } as unknown as MarketToolsService;
  return { service, calls, requests, signals };
}

async function toolHarness(fixture = serviceFixture()) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const disposeTools = registerMarketTools(ctx, fixture.service, paths);
  return { ctx, disposeTools, ...fixture };
}

async function execute(ctx: Context, name: string, args: unknown, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: `test-${name}`, name, arguments: args, signal });
}

function textOf(result: Awaited<ReturnType<typeof execute>>): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

function assertCompactLosslessResult(result: Awaited<ReturnType<typeof execute>>): void {
  assert.equal(result.isError, false, textOf(result));
  if (result.isError) return;
  assertLossless(result.value);
  assert.doesNotThrow(() => structuredClone(result.value));
  const serialized = JSON.stringify(result.value);
  assert.equal(textOf(result), serialized);
  assert.deepEqual(JSON.parse(serialized), result.value);
}

function assertLossless(value: unknown, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true);
    assert.equal(Object.is(value, -0), false);
    return;
  }
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(ancestors.has(value as object), false);
  ancestors.add(value as object);
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    assert.equal(Object.keys(value).length, value.length);
    for (const item of value) assertLossless(item, ancestors);
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const item of Object.values(value as Record<string, unknown>)) assertLossless(item, ancestors);
  }
  ancestors.delete(value as object);
}

function assertAllObjectSchemasClosed(schema: JsonSchemaNode): void {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    for (const property of Object.values(schema.properties ?? {})) assertAllObjectSchemasClosed(property);
  }
  if (schema.items) assertAllObjectSchemasClosed(schema.items);
  for (const branch of schema.oneOf ?? []) assertAllObjectSchemasClosed(branch);
}

test('all seven tools execute through the real registry as compact lossless JSON', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['market_status', {}],
    ['market_quotes', { symbols: ['sh600000', 'hk00700'] }],
    ['market_series', { symbol: 'sh600000', interval: 'minute', limit: 10 }],
    ['market_sectors', { category: 'industry', limit: 10 }],
    ['market_auction', { market: 'CN', symbols: ['sh600000'] }],
    ['market_watchlist', { action: 'get' }],
    ['market_data_health', {}],
  ];

  assert.deepEqual(ctxToolNames(harness.ctx), [...TOOL_NAMES].sort());
  for (const [name, args] of calls) {
    const result = await execute(harness.ctx, name, args, AbortSignal.timeout(2_000));
    assert.equal(result.isError, false, `${name}: ${textOf(result)}`);
    if (result.isError) continue;
    assertLossless(result.value);
    assert.doesNotThrow(() => structuredClone(result.value));
    const serialized = JSON.stringify(result.value);
    assert.equal(textOf(result), serialized);
    assert.deepEqual(JSON.parse(serialized), result.value);
    assert.equal(serialized.includes('undefined'), false);
  }
});

test('current quote and sector tools default omitted refresh to live provider reads', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });

  await execute(harness.ctx, 'market_quotes', {});
  await execute(harness.ctx, 'market_sectors', {});

  assert.deepEqual(harness.requests, [
    { method: 'quotes', request: { refresh: true } },
    { method: 'sectors', request: { refresh: true } },
  ]);
});

test('published input and output schemas close every object and enumerate supported values', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  for (const name of TOOL_NAMES) {
    const definition = harness.ctx.tools.get(name);
    assert.ok(definition, name);
    assert.equal(definition.parameters.type, 'object', `${name} parameters must have an object root`);
    assertAllObjectSchemasClosed(definition.parameters);
    assertAllObjectSchemasClosed(definition.output.schema);
  }

  const series = harness.ctx.tools.get('market_series')!.parameters;
  assert.deepEqual(series.properties?.interval?.enum, ['minute', 'day', 'week', 'month']);
  assert.deepEqual(series.properties?.adjustment?.enum, ['qfq']);
  const sectors = harness.ctx.tools.get('market_sectors')!.parameters;
  assert.deepEqual(sectors.properties?.category?.enum, ['industry', 'concept']);
  assert.equal(sectors.properties?.refresh?.type, 'boolean');

  const seriesOutput = harness.ctx.tools.get('market_series')!.output.schema;
  assert.deepEqual(seriesOutput.properties?.items?.items?.properties?.interval?.enum, ['minute', 'day', 'week', 'month']);
  const sectorsOutput = harness.ctx.tools.get('market_sectors')!.output.schema;
  assert.deepEqual(sectorsOutput.properties?.items?.items?.properties?.category?.enum, ['industry', 'concept']);
});

test('closed input schemas reject extra properties on every tool before service execution', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const valid: Record<string, Record<string, unknown>> = {
    market_status: {},
    market_quotes: { symbols: ['sh600000'] },
    market_series: { symbol: 'sh600000', interval: 'minute' },
    market_sectors: { category: 'industry' },
    market_auction: { market: 'CN' },
    market_watchlist: { action: 'get' },
    market_data_health: {},
  };
  for (const name of TOOL_NAMES) {
    const result = await execute(harness.ctx, name, { ...valid[name], unexpected: true });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /not a declared property|oneOf/i);
  }
  assert.deepEqual(harness.calls, []);
});

test('schema and executor validation reject unsupported enums, bounds, and conditional watchlist args', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const tooMany = Array.from({ length: 101 }, (_, index) => `sh${String(index).padStart(6, '0')}`);
  const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ['market_status', { market: 'US' }, /market|enum/i],
    ['market_quotes', { symbols: tooMany }, /100/],
    ['market_series', { symbol: 'sh600000', interval: 'hour' }, /interval|enum/i],
    ['market_series', { symbol: 'sh600000', interval: 'minute', adjustment: 'hfq' }, /adjustment|enum/i],
    ['market_series', { symbol: 'sh600000', interval: 'minute', limit: 0 }, /limit.*1.*10000/i],
    ['market_series', { symbol: 'sh600000', interval: 'minute', limit: 10_001 }, /limit.*1.*10000/i],
    ['market_sectors', { category: 'region' }, /category|enum/i],
    ['market_sectors', { category: 'industry', sort: 'price' }, /sort|enum/i],
    ['market_sectors', { category: 'industry', direction: 'sideways' }, /direction|enum/i],
    ['market_sectors', { category: 'industry', limit: 0 }, /limit.*1.*10000/i],
    ['market_auction', { market: 'US' }, /market|enum/i],
    ['market_auction', { market: 'CN', symbols: tooMany }, /100/],
    ['market_watchlist', { action: 'add' }, /oneOf|symbol/i],
    ['market_watchlist', { action: 'remove' }, /oneOf|symbol/i],
    ['market_watchlist', { action: 'get', symbol: 'sh600000' }, /oneOf|declared property/i],
  ];
  for (const [name, args, message] of invalid) {
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.match(textOf(result), message);
  }
  assert.deepEqual(harness.calls, []);
});

test('semantic argument validation rejects invalid symbols, timestamps, ranges, and market mismatches before service calls', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['market_quotes', { symbols: ['usAAPL'] }],
    ['market_series', { symbol: 'usAAPL', interval: 'minute' }],
    ['market_series', { symbol: 'sh600000', interval: 'minute', start: '2026-08-27T10:00:00' }],
    ['market_series', { symbol: 'sh600000', interval: 'minute', start: '2026-02-30T10:00:00+08:00' }],
    ['market_series', {
      symbol: 'sh600000',
      interval: 'minute',
      start: '2026-08-27T10:00:00+08:00',
      end: '2026-08-27T10:00:00+08:00',
    }],
    ['market_series', {
      symbol: 'sh600000',
      interval: 'minute',
      start: '2026-08-27T11:00:00+08:00',
      end: '2026-08-27T10:00:00+08:00',
    }],
    ['market_auction', { market: 'CN', symbols: ['hk00700'] }],
    ['market_auction', { market: 'HK', symbols: ['invalid'] }],
    ['market_watchlist', { action: 'add', symbol: 'invalid' }],
    ['market_watchlist', { action: 'remove', symbol: 'usAAPL' }],
  ];

  for (const [name, args] of invalid) {
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.equal(result.error.info?.code, 'INVALID_ARGS');
  }
  assert.deepEqual(harness.calls, []);
});

test('canonicalizable caller symbols are normalized before reaching the service', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['market_quotes', { symbols: ['600000', '700.HK'] }],
    ['market_series', { symbol: 'HK700', interval: 'minute' }],
    ['market_auction', { market: 'HK', symbols: ['700.HK'] }],
    ['market_watchlist', { action: 'add', symbol: '700.HK' }],
  ];
  for (const [name, args] of calls) {
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, false, `${name}: ${textOf(result)}`);
  }
  assert.deepEqual(harness.requests, [
    { method: 'quotes', request: { symbols: ['sh600000', 'hk00700'], refresh: true } },
    { method: 'series', request: { symbol: 'hk00700', interval: 'minute' } },
    { method: 'auction', request: { market: 'HK', symbols: ['hk00700'] } },
    { method: 'watchlist', request: { action: 'add', symbol: 'hk00700' } },
  ]);
});

test('service failures remain service failures and are not reclassified as caller argument errors', async (t) => {
  const fixture = serviceFixture();
  fixture.service.quotes = async () => {
    fixture.calls.push('quotes');
    throw new Error('repository unavailable');
  };
  const harness = await toolHarness(fixture);
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const definition = harness.ctx.tools.get('market_quotes')!;
  await assert.rejects(
    () => definition.execute({ symbols: ['sh600000'] }, { signal: new AbortController().signal } as never),
    (error: unknown) => {
      assert.equal(error instanceof ToolOutputError, false);
      assert.match(error instanceof Error ? error.message : '', /repository unavailable/);
      return true;
    },
  );
  const result = await execute(harness.ctx, 'market_quotes', { symbols: ['sh600000'] });
  assert.equal(result.isError, true);
  assert.notEqual(result.error.info?.code, 'INVALID_ARGS');
  assert.notEqual(result.error.info?.code, 'INVALID_TOOL_OUTPUT');
  assert.match(textOf(result), /repository unavailable/);
  assert.deepEqual(harness.calls, ['quotes', 'quotes']);
});

test('health recognizes complete maintenance results and normalizes null or legacy records to null', async () => {
  const holeMaskedByCustomKey = new Array<string>(2);
  holeMaskedByCustomKey[1] = 'CN:2026-08-26';
  Object.defineProperty(holeMaskedByCustomKey, 'custom', {
    value: 'HK:2026-08-26',
    enumerable: true,
  });
  const hostileDates = new Proxy(['CN:2026-08-26'], {
    get() { throw new Error('hostile maintenance array trap'); },
    ownKeys() { throw new Error('hostile maintenance array trap'); },
  });
  const malformed = [
    { ...maintenanceResult, compactedTradingDates: ['2026-08-26'] },
    { ...maintenanceResult, expiredMinuteTradingDates: ['2026-07-01'] },
    { ...maintenanceResult, prunedMinuteTradingDates: ['CN:2026-06-30'] },
    { ...maintenanceResult, prunedSectorBuckets: ['2026-06-30'] },
    { ...maintenanceResult, compactedTradingDates: holeMaskedByCustomKey },
    { ...maintenanceResult, compactedTradingDates: hostileDates },
  ];
  const cases: Array<[unknown, unknown]> = [
    [null, null],
    [{ capSatisfied: true }, null],
    [maintenanceResult, maintenanceResult],
    ...malformed.map((lastResult) => [lastResult, null] as const),
  ];
  for (const [lastResult, expected] of cases) {
    const harness = await toolHarness(serviceFixture({
      health: {
        ...healthResult,
        retention: { status: 'ok', lastResult },
      },
    }));
    const result = await execute(harness.ctx, 'market_data_health', {});
    assert.equal(result.isError, false, textOf(result));
    if (!result.isError) {
      const value = result.value as { retention: { lastResult: unknown } };
      assert.deepEqual(value.retention.lastResult, expected);
      assertCompactLosslessResult(result);
    }
    await harness.ctx.fiber.dispose();
  }
});

test('hostile output discriminators become deterministic ToolOutputError values without inspection', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const hostileProxy = new Proxy({}, {
    get() { throw new Error('hostile discriminator was inspected'); },
    ownKeys() { throw new Error('hostile discriminator was inspected'); },
  });
  const discriminators: unknown[] = [
    1n,
    Symbol('hostile'),
    () => 'hostile',
    cyclic,
    hostileProxy,
  ];
  const cases = [
    {
      name: 'market_series',
      args: { symbol: 'sh600000', interval: 'minute' },
      expected: 'items[].interval must be minute, day, week, or month',
      override(discriminator: unknown): ResultOverrides {
        return { series: { ...seriesResult, items: [{ ...seriesResult.items[0]!, interval: discriminator }] } };
      },
    },
    {
      name: 'market_sectors',
      args: { category: 'industry' },
      expected: 'items[].category must be industry or concept',
      override(discriminator: unknown): ResultOverrides {
        return { sectors: { ...sectorsResult, items: [{ ...sectorsResult.items[0]!, category: discriminator }] } };
      },
    },
  ] as const;

  for (const { name, args, expected, override } of cases) {
    for (const discriminator of discriminators) {
      const harness = await toolHarness(serviceFixture(override(discriminator)));
      const definition = harness.ctx.tools.get(name)!;
      await assert.rejects(
        () => definition.execute(args, { signal: new AbortController().signal } as never),
        (error: unknown) => {
          assert.equal(error instanceof ToolOutputError, true);
          if (error instanceof ToolOutputError) assert.deepEqual(error.violations, [expected]);
          return true;
        },
      );

      const result = await execute(harness.ctx, name, args);
      assert.equal(result.isError, true, name);
      assert.equal(result.error.info?.code, 'INVALID_TOOL_OUTPUT');
      assert.match(textOf(result), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await harness.ctx.fiber.dispose();
    }
  }
});

test('hostile projection access and nested output values become safe output errors after service resolution', async () => {
  const getterBar = { ...seriesResult.items[0]! };
  Object.defineProperty(getterBar, 'interval', {
    enumerable: true,
    get() { throw new Error('hostile interval getter'); },
  });
  const getterSector = { ...sectorsResult.items[0]! };
  Object.defineProperty(getterSector, 'category', {
    enumerable: true,
    get() { throw new Error('hostile category getter'); },
  });
  const proxyBar = new Proxy({ ...seriesResult.items[0]! }, {
    get() { throw new Error('hostile item trap'); },
    ownKeys() { throw new Error('hostile item trap'); },
  });
  const proxyItems = new Proxy([{ ...seriesResult.items[0]! }], {
    get() { throw new Error('hostile array trap'); },
    ownKeys() { throw new Error('hostile array trap'); },
  });
  const nestedValue: Record<string, unknown> = {};
  Object.defineProperty(nestedValue, 'secret', {
    enumerable: true,
    get() { throw new Error('hostile nested getter'); },
  });
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    overrides: ResultOverrides;
    directViolation?: string;
  }> = [
    {
      name: 'market_series',
      args: { symbol: 'sh600000', interval: 'minute' },
      overrides: { series: { ...seriesResult, items: [getterBar] } },
      directViolation: 'value could not be projected safely',
    },
    {
      name: 'market_sectors',
      args: { category: 'industry' },
      overrides: { sectors: { ...sectorsResult, items: [getterSector] } },
      directViolation: 'value could not be projected safely',
    },
    {
      name: 'market_series',
      args: { symbol: 'sh600000', interval: 'minute' },
      overrides: { series: { ...seriesResult, items: [proxyBar] } },
      directViolation: 'value could not be projected safely',
    },
    {
      name: 'market_series',
      args: { symbol: 'sh600000', interval: 'minute' },
      overrides: { series: { ...seriesResult, items: proxyItems } },
      directViolation: 'value could not be projected safely',
    },
    {
      name: 'market_quotes',
      args: { symbols: ['sh600000'] },
      overrides: {
        quotes: {
          ...quotesResult,
          conflicts: [{
            ...quotesResult.conflicts[0]!,
            observations: [{ source: 'tencent', marketTime: quote.marketTime, value: nestedValue }],
          }],
        },
      },
      directViolation: '"conflicts[0].observations[0].value" must match exactly one oneOf branch (matched 0)',
    },
  ];

  for (const { name, args, overrides, directViolation } of cases) {
    const harness = await toolHarness(serviceFixture(overrides));
    const definition = harness.ctx.tools.get(name)!;
    await assert.rejects(
      () => definition.execute(args, { signal: new AbortController().signal } as never),
      (error: unknown) => {
        assert.equal(error instanceof ToolOutputError, true, name);
        if (error instanceof ToolOutputError) {
          if (directViolation !== undefined) assert.deepEqual(error.violations, [directViolation]);
          assert.equal(error.violations.some((violation) => /hostile|trap|getter/i.test(violation)), false);
        }
        return true;
      },
    );
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.error.info?.code, 'INVALID_TOOL_OUTPUT');
    assert.equal(/hostile|trap|getter/i.test(textOf(result)), false);
    await harness.ctx.fiber.dispose();
  }
});

test('invalid service output domains and contract collection bounds fail as INVALID_TOOL_OUTPUT', async () => {
  const repeatedQuotes = Array.from({ length: 101 }, () => ({ ...quote }));
  const repeatedBars = Array.from({ length: 11 }, () => ({ ...seriesResult.items[0]! }));
  const repeatedSectors = Array.from({ length: 11 }, () => ({ ...sectorsResult.items[0]! }));
  const invalid: Array<[string, Record<string, unknown>, ResultOverrides]> = [
    ['market_status', {}, {
      status: { ...statusResult, markets: [...statusResult.markets, statusResult.markets[0]!] },
    }],
    ['market_series', { symbol: 'sh600000', interval: 'minute' }, {
      series: { ...seriesResult, items: [{ ...seriesResult.items[0]!, interval: 'hour' }] },
    }],
    ['market_sectors', { category: 'industry' }, {
      sectors: { ...sectorsResult, items: [{ ...sectorsResult.items[0]!, category: 'region' }] },
    }],
    ['market_quotes', { symbols: ['sh600000'] }, {
      quotes: { ...quotesResult, items: repeatedQuotes },
    }],
    ['market_series', { symbol: 'sh600000', interval: 'minute', limit: 10 }, {
      series: { ...seriesResult, items: repeatedBars },
    }],
    ['market_sectors', { category: 'industry', limit: 10 }, {
      sectors: { ...sectorsResult, items: repeatedSectors },
    }],
    ['market_auction', { market: 'CN', symbols: ['sh600000'] }, {
      auction: { ...auctionResult, items: repeatedQuotes },
    }],
    ['market_watchlist', { action: 'get' }, {
      watchlist: { watchlist: Array.from({ length: 101 }, (_, index) => `sh${String(index).padStart(6, '0')}`) },
    }],
  ];
  for (const [name, args, overrides] of invalid) {
    const harness = await toolHarness(serviceFixture(overrides));
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.error.info?.code, 'INVALID_TOOL_OUTPUT');
    await harness.ctx.fiber.dispose();
  }
});

test('real registry accepts the materially different valid result branches as compact lossless JSON', async () => {
  const quoteVariants: QuotesResult[] = [
    quotesResult,
    { availability: 'cached', items: [{ ...quote }], conflicts: [] },
    { availability: 'stale', items: [{ ...quote, isStale: true }], conflicts: [] },
    { availability: 'unavailable', items: [], conflicts: [] },
  ];
  const seriesVariants: SeriesResult[] = [
    { ...seriesResult, availability: 'live', source: 'provider' },
    seriesResult,
    { ...seriesResult, availability: 'stale', source: 'both' },
    { availability: 'unavailable', source: null, items: [] },
  ];
  const sectorVariants: SectorsResult[] = [
    { ...sectorsResult, availability: 'live' },
    sectorsResult,
    { availability: 'stale', items: [{ ...sectorsResult.items[0]!, isStale: true }] },
    { availability: 'unavailable', items: [] },
  ];
  const auctionVariants: AuctionServiceResult[] = [
    { availability: 'live', phase: 'auction', reason: null, items: [{ ...quote }] },
    { availability: 'stale', phase: 'auction', reason: 'Live auction refresh failed', items: [{ ...quote, isStale: true }] },
    auctionResult,
  ];
  const cases: Array<[string, Record<string, unknown>, ResultOverrides]> = [
    ...quoteVariants.map((quotes) => ['market_quotes', { symbols: ['sh600000'] }, { quotes }] as const),
    ...seriesVariants.map((series) => ['market_series', { symbol: 'sh600000', interval: 'minute' }, { series }] as const),
    ...sectorVariants.map((sectors) => ['market_sectors', { category: 'industry' }, { sectors }] as const),
    ...auctionVariants.map((auction) => ['market_auction', { market: 'CN', symbols: ['sh600000'] }, { auction }] as const),
    ['market_status', {}, { status: { ...statusResult, collectionActive: false, markets: [] } }],
  ];
  for (const [name, args, overrides] of cases) {
    const harness = await toolHarness(serviceFixture(overrides));
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, false, `${name}: ${textOf(result)}`);
    if (!result.isError) assertCompactLosslessResult(result);
    await harness.ctx.fiber.dispose();
  }

  const watchlistHarness = await toolHarness();
  for (const args of [
    { action: 'get' },
    { action: 'add', symbol: 'hk00700' },
    { action: 'remove', symbol: 'hk00700' },
  ] as const) {
    const result = await execute(watchlistHarness.ctx, 'market_watchlist', args);
    assert.equal(result.isError, false, textOf(result));
    if (!result.isError) assertCompactLosslessResult(result);
  }
  await watchlistHarness.ctx.fiber.dispose();
});

test('inactive auction is a successful domain result', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const result = await execute(harness.ctx, 'market_auction', { market: 'CN', symbols: ['sh600000'] });
  assert.equal(result.isError, false, textOf(result));
  if (result.isError) return;
  assert.deepEqual(result.value, {
    availability: 'unavailable',
    phase: 'closed',
    reason: 'CN auction is inactive',
    items: [],
  });
});

test('all cancellable tools forward the registry AbortSignal to the service', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const requests: Array<[string, Record<string, unknown>]> = [
    ['market_quotes', { symbols: ['sh600000'] }],
    ['market_series', { symbol: 'sh600000', interval: 'minute' }],
    ['market_sectors', { category: 'industry' }],
    ['market_auction', { market: 'CN' }],
    ['market_watchlist', { action: 'get' }],
  ];
  for (const [name, args] of requests) {
    const controller = new AbortController();
    const result = await execute(harness.ctx, name, args, controller.signal);
    assert.equal(result.isError, false, textOf(result));
    const observed = harness.signals.findLast((entry) => entry.method === name.slice('market_'.length));
    assert.equal(observed?.signal, controller.signal, name);
  }
});

test('renderers and presenters are compact, generic, and state independent', async (t) => {
  const harness = await toolHarness();
  t.after(async () => { await harness.ctx.fiber.dispose(); });
  const argsByName: Record<string, Record<string, unknown>> = {
    market_status: {},
    market_quotes: { symbols: ['sh600000'] },
    market_series: { symbol: 'sh600000', interval: 'minute' },
    market_sectors: { category: 'industry' },
    market_auction: { market: 'CN' },
    market_data_health: {},
  };
  for (const name of TOOL_NAMES.filter((value) => value !== 'market_watchlist')) {
    const definition = harness.ctx.tools.get(name)!;
    const first = definition.presentCall?.(argsByName[name]);
    const second = definition.presentCall?.(argsByName[name]);
    assert.deepEqual(first, second);
    assert.equal(first?.card, 'generic');
    if (first?.card === 'generic') {
      assert.equal(first.kind, 'read');
      assert.equal(first.locations, undefined);
    }
  }
  const watchlist = harness.ctx.tools.get('market_watchlist')!;
  const view = watchlist.presentCall?.({ action: 'add', symbol: 'sh600000' });
  assert.equal(view?.card, 'generic');
  if (view?.card === 'generic') {
    assert.equal(view.kind, 'edit');
    assert.deepEqual(view.locations, [{ path: paths.config }]);
    assert.deepEqual(Object.keys(view).sort(), ['card', 'kind', 'locations', 'title']);
  }
});

test('tool disposer unregisters exactly the seven market tools and is idempotent', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  t.after(async () => { await ctx.fiber.dispose(); });
  const disposeSentinel = ctx.tools.register(defineTool({
    name: 'sentinel',
    description: 'unrelated tool',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null; },
  }));
  const dispose = registerMarketTools(ctx, serviceFixture().service, paths);
  assert.deepEqual(ctxToolNames(ctx), [...TOOL_NAMES, 'sentinel'].sort());
  dispose();
  assert.deepEqual(ctxToolNames(ctx), ['sentinel']);
  assert.doesNotThrow(dispose);
  assert.deepEqual(ctxToolNames(ctx), ['sentinel']);
  disposeSentinel();
});

test('real registry recursively rejects negative zero, non-finite numbers, class values, and cycles', async (t) => {
  class ExoticName { readonly value = 'not JSON'; }
  const cyclicDates: unknown[] = [];
  cyclicDates.push(cyclicDates);
  const invalid: Array<[string, ResultOverrides]> = [
    ['market_status', { status: { ...statusResult, collectionActive: -0 } }],
    ['market_quotes', { quotes: { ...quotesResult, items: [{ ...quote, price: Number.NaN }] } }],
    ['market_series', { series: { ...seriesResult, items: [{ ...seriesResult.items[0]!, close: Number.POSITIVE_INFINITY }] } }],
    ['market_quotes', { quotes: { ...quotesResult, items: [{ ...quote, name: new ExoticName() }] } }],
    ['market_quotes', {
      quotes: {
        ...quotesResult,
        conflicts: [{
          ...quotesResult.conflicts[0]!,
          observations: [{ source: 'tencent', marketTime: quote.marketTime, value: cyclicDates }],
        }],
      },
    }],
  ];

  for (const [name, overrides] of invalid) {
    const harness = await toolHarness(serviceFixture(overrides));
    const args = name === 'market_quotes'
      ? { symbols: ['sh600000'] }
      : name === 'market_series'
        ? { symbol: 'sh600000', interval: 'minute' }
        : {};
    const result = await execute(harness.ctx, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.error.info?.code, 'INVALID_TOOL_OUTPUT');
    assert.match(textOf(result), /lossless JSON|invalid output|expected/i);
    await harness.ctx.fiber.dispose();
  }
});

function ctxToolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(({ name }) => name).sort();
}
