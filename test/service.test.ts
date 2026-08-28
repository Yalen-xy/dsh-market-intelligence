import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserState, WatchlistMutation } from '../src/config.ts';
import type { Bar, CanonicalQuote, Market, SectorObservation } from '../src/model.ts';
import type { CollectionGap, ProviderHealthUpdate, RecoveryCursorSeed, RecoverySegmentCommit, RepositoryHealth, SectorQuery, SeriesQuery } from '../src/repository.ts';
import type { SchedulerCallbacks } from '../src/scheduler.ts';
import { MarketService, type MarketServiceOptions, type ServiceRepository } from '../src/service.ts';

const ACTIVE_NOW = new Date('2026-08-27T01:20:05.000Z');

test('canonicalizes, deduplicates, groups, and batches symbols while falling back through Sina only for failed A shares', async () => {
  const fixture = serviceFixture({
    config: { providerBatchSize: 2 },
    tencentQuotes: async (symbols) => ({
      items: symbols.filter((symbol) => symbol !== 'sz000001').map((symbol) => quoteFor(symbol, { source: 'tencent' })),
    }),
    sinaQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, { source: 'sina' })) }),
  });

  const result = await fixture.service.quotes(
    { symbols: ['600000', 'SH600000', 'hk700', '000001'], refresh: true },
    signal(),
  );

  assert.deepEqual(fixture.tencent.quoteCalls, [['sh600000', 'sz000001'], ['hk00700']]);
  assert.deepEqual(fixture.sina.quoteCalls, [['sz000001']]);
  assert.deepEqual(result.items.map(({ symbol, source }) => ({ symbol, source })), [
    { symbol: 'sh600000', source: 'tencent' },
    { symbol: 'hk00700', source: 'tencent' },
    { symbol: 'sz000001', source: 'sina' },
  ]);
  assert.equal(result.availability, 'live');
  assert.deepEqual(result.conflicts, []);
  assert.equal(fixture.repository.quoteWrites.length, 1);
  assert.deepEqual(fixture.repository.quoteWrites[0]?.map(({ symbol }) => symbol), ['sh600000', 'hk00700', 'sz000001']);
});

test('never sends Hong Kong failures to Sina and reports an empty unavailable result with stable arrays', async () => {
  const fixture = serviceFixture({
    tencentQuotes: async () => { throw new Error('network offline'); },
    sinaQuotes: async () => { throw new Error('must not be called'); },
  });

  const result = await fixture.service.quotes({ symbols: ['700.HK'], refresh: true }, signal());

  assert.equal(fixture.sina.quoteCalls.length, 0);
  assert.deepEqual(result, { availability: 'unavailable', items: [], conflicts: [] });
});

test('returns stale cache explicitly after failed refresh and keeps cached records out of live persistence', async () => {
  const cached = quoteFor('sh600000', { fetchedAt: '2026-08-27T01:00:00.000Z' });
  const fixture = serviceFixture({
    cachedQuotes: [cached],
    tencentQuotes: async () => { throw new Error('timeout'); },
    sinaQuotes: async () => { throw new Error('network offline'); },
  });

  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());

  assert.equal(result.availability, 'stale');
  assert.equal(result.items[0]?.isStale, true);
  assert.deepEqual(result.conflicts, []);
  assert.equal(fixture.repository.quoteWrites.length, 0);
});

test('keeps Tencent preferred and reports comparable cached Sina price conflicts without merging fields', async () => {
  const fixture = serviceFixture({
    cachedQuotes: [quoteFor('sh600000', { source: 'sina', price: 10, name: 'cached Sina' })],
    tencentQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, { source: 'tencent', price: 10.02, name: 'live Tencent' })) }),
  });

  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());

  assert.equal(fixture.sina.quoteCalls.length, 0, 'successful Tencent quotes must not trigger Sina comparison traffic');
  assert.equal(result.items[0]?.source, 'tencent');
  assert.equal(result.items[0]?.name, 'live Tencent');
  assert.deepEqual(result.conflicts, [{
    symbol: 'sh600000',
    field: 'price',
    observations: [
      { source: 'tencent', marketTime: '2026-08-27T09:20:00+08:00', value: 10.02 },
      { source: 'sina', marketTime: '2026-08-27T09:20:00+08:00', value: 10 },
    ],
    detectedAt: ACTIVE_NOW.toISOString(),
  }]);
});

test('uses the exact conflict threshold and ignores observations whose market times are not comparable', async () => {
  for (const [cachedPrice, cachedTime, expectedConflicts] of [
    [10.01, '2026-08-27T09:20:00+08:00', 0],
    [10.011, '2026-08-27T09:20:00+08:00', 1],
    [9, '2026-08-27T09:22:00+08:00', 0],
  ] as const) {
    const fixture = serviceFixture({
      cachedQuotes: [quoteFor('sh600000', { source: 'sina', price: cachedPrice, marketTime: cachedTime })],
      tencentQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, { price: 10, source: 'tencent' })) }),
    });
    const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
    assert.equal(result.conflicts.length, expectedConflicts, `${cachedPrice} at ${cachedTime}`);
  }
});

test('rejects invalid provider records before cache or persistence and records a sanitized validation category', async () => {
  const fixture = serviceFixture({
    tencentQuotes: async () => ({ items: [quoteFor('sh600000', { symbol: 'SH600000' })] }),
    sinaQuotes: async () => { throw new Error('timeout'); },
  });

  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  const health = fixture.service.health();

  assert.deepEqual(result, { availability: 'unavailable', items: [], conflicts: [] });
  assert.equal(fixture.repository.quoteWrites.length, 0);
  assert.equal(health.providers.find(({ provider }) => provider === 'tencent')?.errorCategory, 'validation');
  assert.equal(JSON.stringify(health).includes('SH600000'), false);
});

test('an explicit refresh can obtain the closing snapshot after the market closes', async () => {
  const fixture = serviceFixture({
    now: new Date('2026-08-27T10:30:00.000Z'),
    cachedQuotes: [quoteFor('sh600000', { fetchedAt: '2026-08-26T07:00:00.000Z' })],
    tencentQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, {
      fetchedAt: '2026-08-27T10:30:00.000Z',
      marketTime: '2026-08-27T15:00:00+08:00',
    })) }),
  });

  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());

  assert.equal(result.availability, 'live');
  assert.equal(result.items[0]?.isStale, false);
  assert.deepEqual(fixture.tencent.quoteCalls, [['sh600000']]);
  assert.equal(fixture.repository.quoteWrites.length, 1);
});

test('an empty watchlist defaults quote reads to the five supported market indices', async () => {
  const fixture = serviceFixture({ initialWatchlist: [] });
  const result = await fixture.service.quotes({ refresh: true }, signal());

  assert.deepEqual(fixture.tencent.quoteCalls, [
    ['sh000001', 'sz399001', 'sh000300'],
    ['hkHSI', 'hkHSTECH'],
  ]);
  assert.equal(result.items.length, 5);
});

test('marks over-age active-market cache stale even when no refresh is requested', async () => {
  const fixture = serviceFixture({
    cachedQuotes: [quoteFor('sh600000', { fetchedAt: '2026-08-27T01:18:00.000Z' })],
    config: { quoteFreshnessMs: 30_000 },
  });

  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: false }, signal());

  assert.equal(result.availability, 'stale');
  assert.equal(result.items[0]?.isStale, true);
  assert.equal(fixture.tencent.quoteCalls.length, 0);
});

test('stages scheduled quote persistence and commits only scheduler-approved advancing markets', async () => {
  const fixture = serviceFixture({
    initialWatchlist: ['sh600000', 'hk00700'],
    tencentQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol)) }),
  });

  const staged = await fixture.service.collectQuotes(['CN', 'HK'], signal());
  assert.equal(fixture.repository.quoteWrites.length, 0, 'collection must not write before scheduler timestamp validation');
  assert.equal(typeof staged.commit, 'function');
  assert.equal(staged.marketTimes.CN, '2026-08-27T09:20:00+08:00');
  assert.equal(staged.marketTimes.HK, '2026-08-27T09:20:00+08:00');

  await staged.commit(['HK'], signal());
  assert.equal(fixture.repository.quoteWrites.flat().length > 0, true);
  assert.equal(fixture.repository.quoteWrites.flat().every(({ market }) => market === 'HK'), true);
  await staged.commit(['CN'], signal());
  assert.deepEqual(new Set(fixture.repository.quoteWrites.flat().map(({ market }) => market)), new Set(['CN', 'HK']));
});

test('refuses a staged quote commit when the approved market has no canonical advancing timestamp', async () => {
  const fixture = serviceFixture({
    initialWatchlist: ['sh600000'],
    tencentQuotes: async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, { marketTime: null })) }),
  });

  const staged = await fixture.service.collectQuotes(['CN'], signal());
  assert.equal(staged.marketTimes.CN, null);
  await assert.rejects(staged.commit(['CN'], signal()), /timestamp/i);
  assert.equal(fixture.repository.quoteWrites.length, 0);
});

test('serializes atomic watchlist mutations, updates the next scheduler collection snapshot, and never starts a second scheduler', async () => {
  const fixture = serviceFixture({ initialWatchlist: [] });

  const [first, second] = await Promise.all([
    fixture.service.watchlist({ action: 'add', symbol: '600000' }, signal()),
    fixture.service.watchlist({ action: 'add', symbol: '700.HK' }, signal()),
  ]);

  assert.deepEqual(first.watchlist, ['sh600000']);
  assert.deepEqual(second.watchlist, ['sh600000', 'hk00700']);
  assert.deepEqual(fixture.stateStore.state.watchlist, ['sh600000', 'hk00700']);
  assert.equal(fixture.scheduler.starts, 1);

  fixture.tencent.quoteCalls.length = 0;
  await fixture.scheduler.callbacks!.collectQuotes(['CN', 'HK'], signal());
  const scheduledSymbols = fixture.tencent.quoteCalls.flat();
  assert.equal(scheduledSymbols.includes('sh600000'), true);
  assert.equal(scheduledSymbols.includes('hk00700'), true);
  assert.equal(fixture.scheduler.starts, 1);
});

test('keeps the in-memory watchlist unchanged after persistence failure and enforces duplicates and the total limit', async () => {
  const failing = serviceFixture({ initialWatchlist: ['sh600000'], stateMutationError: new Error('disk full') });
  await assert.rejects(failing.service.watchlist({ action: 'add', symbol: '700.HK' }, signal()), /disk full/);
  assert.deepEqual((await failing.service.watchlist({ action: 'get' }, signal())).watchlist, ['sh600000']);
  await assert.rejects(failing.service.watchlist({ action: 'add', symbol: '600000' }, signal()), /already/i);

  const full = serviceFixture({
    initialWatchlist: Array.from({ length: 100 }, (_, index) => `hk${String(index + 1).padStart(5, '0')}`),
  });
  await assert.rejects(full.service.watchlist({ action: 'add', symbol: 'sh600000' }, signal()), /100/);
});

test('keeps current sectors in memory, persists only on the scheduler seam, and applies deterministic tool sorting', async () => {
  const fixture = serviceFixture({
    sinaSectors: async () => ({ items: [
      sector({ id: 'bank', category: 'industry', changePercent: 1.2 }),
      sector({ id: 'chip', category: 'concept', changePercent: 3.5 }),
      sector({ id: 'broker', category: 'industry', changePercent: 2.1 }),
    ] }),
  });

  await fixture.service.collectSectors(signal(), false);
  assert.equal(fixture.repository.sectorWrites.length, 0);
  assert.deepEqual((await fixture.service.sectors({ category: 'industry', sort: 'changePercent', direction: 'desc', limit: 2 }, signal())).items.map(({ id }) => id), ['broker', 'bank']);

  await fixture.service.collectSectors(signal(), true);
  assert.equal(fixture.repository.sectorWrites.length, 1);
  assert.equal(fixture.repository.sectorWrites[0]?.resolution, 'intraday');
});

test('an explicit sector refresh replaces malformed cache with validated provider rows and persists them', async () => {
  const malformed = sector({ id: 'new_blhy', name: 'new_blhy', changePercent: null, leaderSymbol: '-0.1', leaderName: '-0.2' });
  const corrected = sector({ id: 'new_blhy', name: '玻璃行业', changePercent: -0.024, leaderSymbol: 'sh600293', leaderName: '三峡新材' });
  const fixture = serviceFixture({
    cachedSectors: [malformed],
    sinaSectors: async () => ({ items: [corrected] }),
  });

  const result = await fixture.service.sectors({ refresh: true }, signal());

  assert.equal(result.availability, 'live');
  assert.equal(result.items[0]?.name, '玻璃行业');
  assert.equal(result.items[0]?.leaderName, '三峡新材');
  assert.equal(fixture.repository.sectorWrites.length, 1);
});

test('combines validated provider and repository series without losing chronological JSON data', async () => {
  const cached = bar({ timestamp: '2026-08-27T09:19:00+08:00', close: 10 });
  const live = bar({ timestamp: '2026-08-27T09:20:00+08:00', close: 10.1 });
  const fixture = serviceFixture({
    cachedBars: [cached],
    tencentSeries: async () => ({ items: [live] }),
  });

  const result = await fixture.service.series({ symbol: '600000', interval: 'minute', limit: 10 }, signal());

  assert.equal(result.availability, 'live');
  assert.equal(result.source, 'both');
  assert.deepEqual(result.items, [cached, live]);
  assert.deepEqual(fixture.repository.barWrites, [[live]]);
  assert.equal(fixture.tencent.seriesCalls[0]?.symbol, 'sh600000');
  assert.equal(fixture.tencent.seriesCalls[0]?.count, 10);
});

test('marks cached series stale after a failed live refresh but keeps explicit cache-only reads cached', async () => {
  const cached = bar();
  const fixture = serviceFixture({
    cachedBars: [cached],
    tencentSeries: async () => { throw new Error('network offline'); },
  });

  const refreshed = await fixture.service.series({ symbol: 'sh600000', interval: 'minute', limit: 10 }, signal());
  const cacheOnly = await fixture.service.series({ symbol: 'sh600000', interval: 'minute', limit: 10, refresh: false }, signal());

  assert.equal(refreshed.availability, 'stale');
  assert.equal(cacheOnly.availability, 'cached');
  assert.equal(fixture.tencent.seriesCalls.length, 1);
});

test('throws a series storage failure instead of publishing unpersisted provider data as live', async () => {
  const fixture = serviceFixture({
    tencentSeries: async () => ({ items: [bar()] }),
    barWriteError: new Error('database is read-only'),
  });

  await assert.rejects(
    fixture.service.series({ symbol: 'sh600000', interval: 'minute', limit: 10 }, signal()),
    /read-only/,
  );
});

test('returns inactive auction as a successful unavailable domain result and filters active requests by market', async () => {
  const inactive = serviceFixture({ now: new Date('2026-08-27T04:15:00.000Z') });
  assert.deepEqual(await inactive.service.auction({ market: 'CN', symbols: ['sh600000'] }, signal()), {
    availability: 'unavailable',
    phase: 'lunch',
    reason: 'CN auction is inactive',
    items: [],
  });

  const active = serviceFixture({
    tencentAuction: async (symbols, phase) => ({ phase, items: symbols.map((symbol) => quoteFor(symbol)) }),
  });
  const result = await active.service.auction({ market: 'CN', symbols: ['sh600000', 'hk00700'] }, signal());
  assert.equal(result.availability, 'live');
  assert.deepEqual(result.items.map(({ symbol }) => symbol), ['sh600000']);
  assert.deepEqual(active.tencent.auctionCalls[0]?.symbols, ['sh600000']);
});

test('caps auction before the provider and falls back to stale cache for mismatched or wholly invalid live responses', async () => {
  const tooMany = serviceFixture();
  const symbols = Array.from({ length: 101 }, (_, index) => `sh${600000 + index}`);
  await assert.rejects(tooMany.service.auction({ market: 'CN', symbols }, signal()), /100/);
  assert.equal(tooMany.tencent.auctionCalls.length, 0);

  for (const response of [
    { phase: 'continuous' as const, items: [quoteFor('sh600000')] },
    { phase: 'auction' as const, items: [quoteFor('sh600000', { price: Number.NaN })] },
  ]) {
    const fixture = serviceFixture({
      cachedQuotes: [quoteFor('sh600000', { fetchedAt: '2026-08-27T01:00:00.000Z' })],
      tencentAuction: async () => response,
    });
    const result = await fixture.service.auction({ market: 'CN', symbols: ['sh600000'] }, signal());
    assert.equal(result.availability, 'stale');
    assert.equal(result.items[0]?.isStale, true);
    assert.equal(result.items[0]?.symbol, 'sh600000');
  }
});

test('reports provider attempts, sanitized failure categories, scheduler state, database state, and maintenance state', async () => {
  const fixture = serviceFixture({
    tencentQuotes: async () => { throw new Error('request timeout for https://secret.example/watchlist'); },
    sinaQuotes: async () => { throw new Error('network socket exposed payload'); },
    repositoryHealth: {
      databaseBytes: 4096,
      liveDatabaseBytes: 2048,
      providers: [],
      gaps: [],
      lastMaintenance: { capSatisfied: true },
      counts: { quoteObservations: 1, minuteBars: 2, dailyBars: 3, sectorObservations: 4, sectorDailySummaries: 1 },
    },
  });
  await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());

  const result = fixture.service.health();
  assert.deepEqual(result.database, {
    databaseBytes: 4096,
    liveDatabaseBytes: 2048,
    counts: { quoteObservations: 1, minuteBars: 2, dailyBars: 3, sectorObservations: 4, sectorDailySummaries: 1 },
  });
  assert.deepEqual(result.scheduler, { state: 'running', pendingTimers: 2, inFlight: 0 });
  assert.equal(result.retention.status, 'ok');
  assert.equal(result.providers.find(({ provider }) => provider === 'tencent')?.errorCategory, 'timeout');
  assert.equal(result.providers.find(({ provider }) => provider === 'sina')?.errorCategory, 'network');
  assert.equal(result.providers.every(({ lastAttemptAt }) => lastAttemptAt === ACTIVE_NOW.toISOString()), true);
  assert.equal(JSON.stringify(result).includes('secret.example'), false);
  assert.equal(JSON.stringify(result).includes('payload'), false);
});

test('continues persisted provider failure history instead of resetting it after restart', async () => {
  const lastSuccessAt = '2026-08-26T07:00:00.000Z';
  const fixture = serviceFixture({
    repositoryHealth: {
      databaseBytes: 0,
      liveDatabaseBytes: 0,
      providers: [{
        provider: 'tencent',
        available: false,
        latencyMs: 50,
        lastAttemptAt: '2026-08-26T07:01:00.000Z',
        lastSuccessAt,
        lastFailureAt: '2026-08-26T07:01:00.000Z',
        consecutiveFailures: 4,
        error: 'timeout',
      }],
      gaps: [],
      lastMaintenance: null,
      counts: { quoteObservations: 0, minuteBars: 0, dailyBars: 0, sectorObservations: 0, sectorDailySummaries: 0 },
    },
    tencentQuotes: async () => { throw new Error('network offline'); },
  });

  await fixture.service.quotes({ symbols: ['hk00700'], refresh: true }, signal());
  const tencent = fixture.service.health().providers.find(({ provider }) => provider === 'tencent');
  assert.equal(tencent?.consecutiveFailures, 5);
  assert.equal(tencent?.lastSuccessAt, lastSuccessAt);
});

test('delegates maintenance to Task 5 recovery with configured policy and exposes its latest result', async () => {
  const calls: unknown[][] = [];
  const fixture = serviceFixture({
    config: { minuteRetentionTradingDays: 30, storageSoftLimitBytes: 536_870_912 },
    maintenance: (repository, policy, now) => {
      calls.push([repository, policy, now.toISOString()]);
      return maintenanceResult();
    },
  });

  const result = await fixture.service.maintain('CN', '2026-08-26', signal());

  assert.equal(result.capSatisfied, true);
  assert.deepEqual(calls, [[fixture.repository, {
    market: 'CN',
    closedTradingDate: '2026-08-26',
    closures: {},
    minuteTradingDays: 30,
    maxBytes: 536_870_912,
  }, ACTIVE_NOW.toISOString()]]);
  assert.deepEqual(fixture.service.health().retention.lastResult, result);
});

test('startup recovery records only active-session downtime gaps when provider history is unavailable', async () => {
  const now = new Date('2026-08-31T02:00:00.000Z');
  const fixture = serviceFixture({
    now,
    initialClosures: { '2026': { CN: ['2026-08-28'], HK: [] } },
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T06:59:00.000Z',
        lastSuccessAt: '2026-08-27T06:59:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    maintenance: () => maintenanceResult(),
  });

  await fixture.service.maintain('CN', '2026-08-27', signal());
  await fixture.service.maintain('CN', '2026-08-27', signal());

  assert.deepEqual(fixture.repository.gaps, [
    {
      market: 'CN',
      symbol: null,
      interval: 'quote',
      start: '2026-08-27T06:59:00.000Z',
      end: '2026-08-27T07:00:00.000Z',
      reason: 'provider_history_unavailable',
      recordedAt: now.toISOString(),
    },
    {
      market: 'CN',
      symbol: null,
      interval: 'quote',
      start: '2026-08-31T01:15:00.000Z',
      end: '2026-08-31T01:30:00.000Z',
      reason: 'provider_history_unavailable',
      recordedAt: now.toISOString(),
    },
    {
      market: 'CN',
      symbol: null,
      interval: 'quote',
      start: '2026-08-31T01:30:00.000Z',
      end: '2026-08-31T02:00:00.000Z',
      reason: 'provider_history_unavailable',
      recordedAt: now.toISOString(),
    },
  ]);
  assert.equal(fixture.tencent.seriesCalls.length, 0);
});

test('startup recovery never invents a pre-install gap and bounds an ancient downtime anchor', async () => {
  const fresh = serviceFixture({ maintenance: () => maintenanceResult() });
  await fresh.service.maintain('CN', '2026-08-26', signal());
  assert.deepEqual(fresh.repository.gaps, []);

  const ancient = serviceFixture({
    now: new Date('2026-08-31T02:00:00.000Z'),
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2020-01-02T01:15:00.000Z',
        lastSuccessAt: '2020-01-02T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    maintenance: () => maintenanceResult(),
  });
  await ancient.service.maintain('CN', '2026-08-28', signal());

  assert.ok(ancient.repository.gaps.length > 0);
  assert.ok(ancient.repository.gaps.length <= 128);
});

test('startup recovery invokes only an explicitly advertised provider history capability', async () => {
  const historical = quoteFor('sh600000', {
    marketTime: '2026-08-27T09:17:00+08:00',
    fetchedAt: '2026-08-27T01:20:00.000Z',
  });
  const fixture = serviceFixture({
    now: new Date('2026-08-27T01:20:00.000Z'),
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => ({ items: [historical], complete: true }),
    maintenance: () => maintenanceResult(),
  });

  await fixture.service.maintain('CN', '2026-08-26', signal());

  assert.deepEqual(fixture.tencent.historyCalls.map(({ market, interval, start, end }) => ({ market, interval, start, end })), [{
    market: 'CN',
    interval: 'quote',
    start: '2026-08-27T01:15:00.000Z',
    end: '2026-08-27T01:20:00.000Z',
  }]);
  assert.ok(fixture.tencent.historyCalls[0]?.symbols.includes('sh600000'));
  assert.deepEqual(fixture.repository.quoteWrites, [[historical]]);
  assert.deepEqual(fixture.repository.gaps, []);
});

test('restart resumes at the last atomically committed segment after a later segment and gap crash', async () => {
  const firstRunEnd = new Date('2026-08-27T01:40:00.000Z');
  let firstCall = 0;
  const first = serviceFixture({
    now: firstRunEnd,
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => {
      firstCall++;
      return firstCall === 1
        ? {
            items: [quoteFor('sh600000', {
              marketTime: '2026-08-27T09:20:00+08:00',
              fetchedAt: firstRunEnd.toISOString(),
            })],
            complete: true,
          }
        : { items: [], complete: false };
    },
    recoveryCommitFailureAt: 2,
    gapWriteError: new Error('simulated gap crash'),
    maintenance: () => maintenanceResult(),
  });

  await assert.rejects(first.service.maintain('CN', '2026-08-26', signal()));
  assert.equal(first.repository.quoteWrites.flat().length, 1);

  first.repository.recoveryCommitFailureAt = null;
  first.repository.gapWriteError = undefined;
  const restarted = serviceFixture({
    now: new Date('2026-08-27T01:40:05.000Z'),
    initialWatchlist: ['sh600000'],
    repository: first.repository,
    tencentHistory: async () => ({ items: [], complete: false }),
    maintenance: () => maintenanceResult(),
  });

  await restarted.service.maintain('CN', '2026-08-26', signal());

  assert.deepEqual(restarted.tencent.historyCalls.map(({ start, end }) => ({ start, end })), [{
    start: '2026-08-27T01:30:00.000Z',
    end: '2026-08-27T01:40:05.000Z',
  }]);
  assert.equal(first.repository.quoteWrites.flat().length, 1);
  assert.equal(first.repository.gaps[0]?.start, '2026-08-27T01:30:00.000Z');
  assert.equal(first.repository.recoveryCursor('tencent', 'CN', 'quote'), '2026-08-27T01:40:05.000Z');
});

test('restart does not replay a durable recovery batch when provider health did not advance', async () => {
  const firstRunEnd = new Date('2026-08-27T01:20:00.000Z');
  const historical = quoteFor('sh600000', {
    marketTime: '2026-08-27T09:17:00+08:00',
    fetchedAt: firstRunEnd.toISOString(),
  });
  const first = serviceFixture({
    now: firstRunEnd,
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => ({ items: [historical], complete: true }),
    providerHealthWriteError: new Error('simulated health crash'),
    maintenance: () => maintenanceResult(),
  });

  await assert.rejects(first.service.maintain('CN', '2026-08-26', signal()));
  assert.equal(first.repository.quoteWrites.flat().length, 1);

  first.repository.providerHealthWriteError = undefined;
  const restarted = serviceFixture({
    now: new Date('2026-08-27T01:20:05.000Z'),
    initialWatchlist: ['sh600000'],
    repository: first.repository,
    tencentHistory: async () => ({
      items: [{ ...historical, fetchedAt: '2026-08-27T01:20:05.000Z' }],
      complete: true,
    }),
    maintenance: () => maintenanceResult(),
  });

  await restarted.service.maintain('CN', '2026-08-26', signal());

  assert.deepEqual(restarted.tencent.historyCalls.map(({ start, end }) => ({ start, end })), [{
    start: '2026-08-27T01:20:00.000Z',
    end: '2026-08-27T01:20:05.000Z',
  }]);
  assert.equal(first.repository.quoteWrites.flat().length, 1);
  assert.equal(first.repository.recoveryCursor('tencent', 'CN', 'quote'), '2026-08-27T01:20:05.000Z');
});

test('a completed CN recovery cannot move the bootstrap anchor past HK before HK has recovered', async () => {
  const first = serviceFixture({
    now: new Date('2026-08-27T01:40:00.000Z'),
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => ({ items: [], complete: true }),
    maintenance: () => maintenanceResult(),
  });
  await first.service.maintain('CN', '2026-08-26', signal());

  const restarted = serviceFixture({
    now: new Date('2026-08-27T01:40:05.000Z'),
    repository: first.repository,
    tencentHistory: async () => ({ items: [], complete: false }),
    maintenance: () => maintenanceResult(),
  });
  await restarted.service.maintain('HK', '2026-08-26', signal());

  assert.deepEqual(restarted.tencent.historyCalls.map(({ start, end }) => ({ start, end })), [
    { start: '2026-08-27T01:15:00.000Z', end: '2026-08-27T01:30:00.000Z' },
    { start: '2026-08-27T01:30:00.000Z', end: '2026-08-27T01:40:05.000Z' },
  ]);
  assert.equal(first.repository.recoveryCursor('tencent', 'HK', 'quote'), '2026-08-27T01:40:05.000Z');
});

test('startup recovery never presents represented-old history as a fresh current quote', async () => {
  const now = new Date('2026-08-27T01:20:05.000Z');
  const historical = quoteFor('sh600000', {
    marketTime: '2026-08-27T09:17:00+08:00',
    fetchedAt: now.toISOString(),
    isStale: false,
  });
  const fixture = serviceFixture({
    now,
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => ({ items: [historical], complete: true }),
    config: { quoteFreshnessMs: 30_000 },
    maintenance: () => maintenanceResult(),
  });

  await fixture.service.maintain('CN', '2026-08-26', signal());
  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: false }, signal());

  assert.equal(result.availability, 'stale');
  assert.equal(result.items[0]?.isStale, true);
});

test('startup recovery preserves a provider stale flag on represented-current history', async () => {
  const now = new Date('2026-08-27T01:17:05.000Z');
  const historical = quoteFor('sh600000', {
    marketTime: '2026-08-27T09:17:00+08:00',
    fetchedAt: now.toISOString(),
    isStale: true,
  });
  const fixture = serviceFixture({
    now,
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async () => ({ items: [historical], complete: true }),
    config: { quoteFreshnessMs: 30_000 },
    maintenance: () => maintenanceResult(),
  });

  await fixture.service.maintain('CN', '2026-08-26', signal());
  const result = await fixture.service.quotes({ symbols: ['sh600000'], refresh: false }, signal());

  assert.equal(result.availability, 'stale');
  assert.equal(result.items[0]?.isStale, true);
});

test('startup recovery rejects provider history responses that exceed the requested bound', async () => {
  const historical = quoteFor('sh600000', {
    marketTime: '2026-08-27T09:17:00+08:00',
    fetchedAt: '2026-08-27T01:20:00.000Z',
  });
  const fixture = serviceFixture({
    now: new Date('2026-08-27T01:20:00.000Z'),
    initialWatchlist: ['sh600000'],
    repositoryHealth: repositoryHealth({
      providers: [{
        provider: 'tencent',
        available: true,
        latencyMs: 25,
        lastAttemptAt: '2026-08-27T01:15:00.000Z',
        lastSuccessAt: '2026-08-27T01:15:00.000Z',
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      }],
    }),
    tencentHistory: async (request) => ({
      items: Array.from({ length: request.limit + 1 }, () => historical),
      complete: true,
    }),
    maintenance: () => maintenanceResult(),
  });

  await fixture.service.maintain('CN', '2026-08-26', signal());

  assert.equal(fixture.repository.quoteWrites.length, 0);
  assert.equal(fixture.repository.gaps.length, 1);
  assert.equal(fixture.repository.gaps[0]?.reason, 'provider_history_unavailable');
});

test('honors abort without falling back or persisting and surfaces the abort to the caller', async () => {
  const controller = new AbortController();
  const fixture = serviceFixture({
    tencentQuotes: async (_symbols, requestSignal) => new Promise((_resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    }),
  });
  const request = fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, controller.signal);
  controller.abort(new DOMException('cancelled', 'AbortError'));

  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(fixture.sina.quoteCalls.length, 0);
  assert.equal(fixture.repository.quoteWrites.length, 0);
});

test('removes caller abort listeners after each direct request settles', async () => {
  const controller = new AbortController();
  const requestSignal = controller.signal;
  const originalAdd = requestSignal.addEventListener.bind(requestSignal);
  const originalRemove = requestSignal.removeEventListener.bind(requestSignal);
  let additions = 0;
  let removals = 0;
  requestSignal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
    additions++;
    return originalAdd(...args);
  }) as AbortSignal['addEventListener'];
  requestSignal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    removals++;
    return originalRemove(...args);
  }) as AbortSignal['removeEventListener'];
  const fixture = serviceFixture();

  await fixture.service.quotes({ symbols: ['sh600000'], refresh: false }, requestSignal);

  assert.equal(additions, 1);
  assert.equal(removals, 1);
});

test('preattaches direct rejection drains before disposal aborts lifecycle work', async () => {
  let releaseScheduler!: () => void;
  let providerStarted!: () => void;
  const schedulerGate = new Promise<void>((resolve) => { releaseScheduler = resolve; });
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const fixture = serviceFixture({
    schedulerCancel: async () => schedulerGate,
    tencentQuotes: async (_symbols, requestSignal) => new Promise((_resolve, reject) => {
      providerStarted();
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    }),
  });
  const unhandled: unknown[] = [];
  const handled: Promise<unknown>[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const onHandled = (promise: Promise<unknown>) => { handled.push(promise); };
  process.on('unhandledRejection', onUnhandled);
  process.on('rejectionHandled', onHandled);
  let request: Promise<unknown> | undefined;
  let disposal: Promise<void> | undefined;
  try {
    request = fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
    await started;
    disposal = fixture.service.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(handled, []);
    releaseScheduler();
    await disposal;
    await assert.rejects(request, { name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(handled, []);
  } finally {
    releaseScheduler();
    void request?.catch(() => undefined);
    await disposal?.catch(() => undefined);
    process.off('unhandledRejection', onUnhandled);
    process.off('rejectionHandled', onHandled);
  }
});

test('disposal aborts and drains direct provider work before closing the repository', async () => {
  let release!: () => void;
  const fixture = serviceFixture({
    tencentQuotes: async (_symbols, requestSignal) => new Promise((resolve, reject) => {
      release = () => resolve({ items: [] });
      requestSignal.addEventListener('abort', () => {
        fixture.events.push('provider-abort');
        reject(requestSignal.reason);
      }, { once: true });
    }),
  });
  const request = fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  await Promise.resolve();

  const disposal = fixture.service.dispose();
  await disposal;
  if (!fixture.events.includes('provider-abort')) release();
  let requestError: unknown;
  try {
    await request;
  } catch (error) {
    requestError = error;
  }

  assert.equal(requestError instanceof DOMException && requestError.name, 'AbortError');
  assert.deepEqual(fixture.events, ['scheduler-cancel', 'provider-abort', 'repository-close']);
});

test('disposal waits for pending direct maintenance before closing the repository', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture({ maintenance: async () => {
    await gate;
    return maintenanceResult();
  } });
  const maintenance = fixture.service.maintain('CN', '2026-08-26', signal());
  await Promise.resolve();

  const disposal = fixture.service.dispose();
  await Promise.resolve();
  assert.equal(fixture.repository.closeCalls, 0);
  release();
  await assert.rejects(maintenance, { name: 'AbortError' });
  await disposal;
  assert.equal(fixture.repository.closeCalls, 1);
});

test('an aborted queued watchlist mutation rechecks cancellation at queue head and never persists', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture({ stateMutationGate: gate });
  const first = fixture.service.watchlist({ action: 'add', symbol: 'sh600000' }, signal());
  for (let index = 0; index < 5 && fixture.stateStore.calls === 0; index++) await Promise.resolve();
  assert.equal(fixture.stateStore.calls, 1);
  const controller = new AbortController();
  const queued = fixture.service.watchlist({ action: 'add', symbol: 'hk00700' }, controller.signal);
  controller.abort(new DOMException('cancelled while queued', 'AbortError'));
  release();

  await first;
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(fixture.stateStore.calls, 1);
  assert.deepEqual(fixture.stateStore.state.watchlist, ['sh600000']);
});

test('reconciles successful atomic watchlist persistence before surfacing a mid-write abort', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture({ stateMutationGate: gate });
  fixture.stateStore.state.closures = { '2026': { CN: ['2026-08-27'], HK: [] } };
  const controller = new AbortController();
  const mutation = fixture.service.watchlist({ action: 'add', symbol: 'sh600000' }, controller.signal);
  for (let index = 0; index < 5 && fixture.stateStore.calls === 0; index++) await Promise.resolve();
  assert.equal(fixture.stateStore.calls, 1);
  const outcome = assert.rejects(mutation, { name: 'AbortError' });

  controller.abort(new DOMException('cancelled during persistence', 'AbortError'));
  release();
  await outcome;

  const current = await fixture.service.watchlist({ action: 'get' }, signal());
  assert.deepEqual(current.watchlist, ['sh600000']);
  assert.deepEqual(current.watchlist, fixture.stateStore.state.watchlist);
  assert.equal(fixture.service.status({ market: 'CN' }).markets[0]?.phase, 'closed');
});

test('disposal drains a pending watchlist persistence and cancels queued mutations before repository close', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture({ stateMutationGate: gate });
  const first = fixture.service.watchlist({ action: 'add', symbol: 'sh600000' }, signal());
  for (let index = 0; index < 5 && fixture.stateStore.calls === 0; index++) await Promise.resolve();
  assert.equal(fixture.stateStore.calls, 1);
  const queued = fixture.service.watchlist({ action: 'add', symbol: 'hk00700' }, signal());
  const firstOutcome = assert.rejects(first, { name: 'AbortError' });
  const queuedOutcome = assert.rejects(queued, { name: 'AbortError' });

  const disposal = fixture.service.dispose();
  await Promise.resolve();
  assert.equal(fixture.repository.closeCalls, 0);
  release();
  await Promise.all([firstOutcome, queuedOutcome, disposal]);

  assert.equal(fixture.stateStore.calls, 1);
  assert.deepEqual(fixture.events, ['scheduler-cancel', 'repository-close']);
});

test('disposes idempotently, waits for scheduler cancellation before closing, and still closes after cancellation failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = serviceFixture({ schedulerCancel: async () => gate });

  const first = fixture.service.dispose();
  const second = fixture.service.dispose();
  await Promise.resolve();
  assert.deepEqual(fixture.events, ['scheduler-cancel']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(fixture.events, ['scheduler-cancel', 'repository-close']);
  assert.equal(fixture.scheduler.cancelCalls, 1);
  assert.equal(fixture.repository.closeCalls, 1);

  const failing = serviceFixture({ schedulerCancel: async () => { throw new Error('cancel failed'); } });
  await assert.rejects(failing.service.dispose(), /cancel failed/);
  assert.deepEqual(failing.events, ['scheduler-cancel', 'repository-close']);
  assert.equal(failing.repository.closeCalls, 1);
});

test('all service result branches are plain lossless JSON with required arrays present', async () => {
  const fixture = serviceFixture({
    tencentQuotes: async () => ({ items: [] }),
    sinaQuotes: async () => ({ items: [] }),
    tencentSeries: async () => ({ items: [] }),
  });
  const values = [
    fixture.service.status({}),
    await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal()),
    await fixture.service.series({ symbol: 'sh600000', interval: 'minute', limit: 10 }, signal()),
    await fixture.service.sectors({ category: 'industry', limit: 10 }, signal()),
    await fixture.service.auction({ market: 'HK', symbols: ['hk00700'] }, signal()),
    await fixture.service.watchlist({ action: 'get' }, signal()),
    fixture.service.health(),
  ];

  for (const value of values) assertLosslessJson(value);
  assert.equal(Array.isArray((values[1] as { items: unknown[] }).items), true);
  assert.equal(Array.isArray((values[1] as { conflicts: unknown[] }).conflicts), true);
  assert.equal(Array.isArray((values[2] as { items: unknown[] }).items), true);
  assert.equal(Array.isArray((values[3] as { items: unknown[] }).items), true);
  assert.equal(Array.isArray((values[4] as { items: unknown[] }).items), true);
});

test('canonicalizes negative zero recursively across every public health numeric source', () => {
  const fixture = serviceFixture({
    repositoryHealth: {
      databaseBytes: -0,
      liveDatabaseBytes: -0,
      providers: [{
        provider: 'storage',
        available: false,
        latencyMs: -0,
        lastAttemptAt: ACTIVE_NOW.toISOString(),
        lastSuccessAt: null,
        lastFailureAt: ACTIVE_NOW.toISOString(),
        consecutiveFailures: -0,
        error: 'storage',
      }],
      gaps: [],
      lastMaintenance: { capSatisfied: true, nested: { bytesRemoved: -0 } },
      counts: { quoteObservations: -0, minuteBars: -0, dailyBars: -0, sectorObservations: -0, sectorDailySummaries: -0 },
    },
  });
  fixture.scheduler.health = () => ({ pendingTimers: -0, inFlight: -0 });

  const health = fixture.service.health();

  assertNoNegativeZero(health);
  assertLosslessJson(health);
});

test('classifies transient constructor and public repository health read failures without leaking constructor errors', () => {
  const healthy = repositoryHealth();
  let constructorReads = 0;
  let constructorFixture: ReturnType<typeof serviceFixture> | undefined;
  assert.doesNotThrow(() => {
    constructorFixture = serviceFixture({ repositoryHealthScript: () => {
      constructorReads++;
      if (constructorReads === 1) throw 'constructor database secret';
      return healthy;
    } });
  });
  const afterConstructorFailure = constructorFixture!.service.health();
  assert.equal(afterConstructorFailure.providers.find(({ provider }) => provider === 'storage')?.errorCategory, 'storage');
  assert.equal(JSON.stringify(afterConstructorFailure).includes('secret'), false);

  let publicReads = 0;
  const publicFixture = serviceFixture({ repositoryHealthScript: () => {
    publicReads++;
    if (publicReads === 2) throw 'public database secret';
    return healthy;
  } });
  let publicFailure: unknown;
  try {
    publicFixture.service.health();
  } catch (error) {
    publicFailure = error;
  }
  assert.equal(publicFailure, 'public database secret');
  const recovered = publicFixture.service.health();
  assert.equal(recovered.providers.find(({ provider }) => provider === 'storage')?.errorCategory, 'storage');
  assert.equal(JSON.stringify(recovered).includes('secret'), false);
});

test('canonicalizes negative zero in every nested numeric provider field before output and persistence', async () => {
  const fixture = serviceFixture({
    tencentQuotes: async () => ({ items: [quoteFor('sh600000', {
      price: -0, open: -0, high: -0, low: -0, previousClose: -0,
      volume: -0, amount: -0, change: -0, changePercent: -0,
    })] }),
    tencentSeries: async () => ({ items: [bar({
      open: -0, high: -0, low: -0, close: -0, volume: -0, turnover: -0,
    })] }),
    sinaSectors: async () => ({ items: [sector({
      changePercent: -0, turnover: -0, netFlow: -0, leaderChangePercent: -0,
    })] }),
  });

  const quotes = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  const series = await fixture.service.series({ symbol: 'sh600000', interval: 'minute', limit: 10 }, signal());
  await fixture.service.collectSectors(signal(), true);
  const sectors = await fixture.service.sectors({}, signal());

  for (const value of [quotes, series, sectors, fixture.repository.quoteWrites, fixture.repository.barWrites, fixture.repository.sectorWrites]) {
    assertNoNegativeZero(value);
  }
});

test('treats an empty sector endpoint response as a retryable soft failure', async () => {
  const fixture = serviceFixture({ sinaSectors: async () => ({ items: [] }) });

  await assert.rejects(fixture.service.collectSectors(signal(), true), /sector/i);
  await assert.rejects(fixture.service.collectSectors(signal(), true), /sector/i);

  assert.equal(fixture.sina.sectorCalls.length, 2);
  assert.equal(fixture.repository.sectorWrites.length, 0);
  assert.equal(fixture.service.health().providers.find(({ provider }) => provider === 'sina')?.errorCategory, 'parse');
});

test('sanitizes storage failures across service repository paths without erasing provider success facts', async () => {
  const cases: Array<{ name: string; arrange(fixture: ReturnType<typeof serviceFixture>): void; run(fixture: ReturnType<typeof serviceFixture>): Promise<unknown> }> = [
    { name: 'quotes read', arrange: ({ repository }) => { repository.latestQuotes = () => { throw new Error('database secret quotes read'); }; }, run: ({ service }) => service.quotes({ symbols: ['sh600000'], refresh: false }, signal()) },
    { name: 'quotes write', arrange: ({ repository }) => { repository.writeBatch = () => { throw new Error('disk secret quotes write'); }; }, run: ({ service }) => service.quotes({ symbols: ['sh600000'], refresh: true }, signal()) },
    { name: 'series read', arrange: ({ repository }) => { repository.querySeries = () => { throw new Error('database secret series read'); }; }, run: ({ service }) => service.series({ symbol: 'sh600000', interval: 'minute' }, signal()) },
    { name: 'series write', arrange: ({ repository }) => { repository.writeBars = () => { throw new Error('storage secret series write'); }; }, run: ({ service }) => service.series({ symbol: 'sh600000', interval: 'minute' }, signal()) },
    { name: 'health persistence', arrange: ({ repository }) => { repository.updateProviderHealth = () => { throw new Error('database secret health write'); }; }, run: ({ service }) => service.quotes({ symbols: ['sh600000'], refresh: true }, signal()) },
    { name: 'staged commit', arrange: ({ repository }) => { repository.writeBatch = () => { throw new Error('database secret staged write'); }; }, run: async ({ service }) => { const staged = await service.collectQuotes(['CN'], signal()); return staged.commit(['CN'], signal()); } },
    { name: 'sectors read', arrange: ({ repository }) => { repository.readSectors = () => { throw new Error('database secret sector read'); }; }, run: ({ service }) => service.sectors({}, signal()) },
    { name: 'sectors write', arrange: ({ repository }) => { repository.writeSectors = () => { throw new Error('disk secret sector write'); }; }, run: ({ service }) => service.collectSectors(signal(), true) },
  ];

  for (const item of cases) {
    const fixture = serviceFixture({
      initialWatchlist: ['sh600000'],
      tencentSeries: async () => ({ items: [bar()] }),
      sinaSectors: async () => ({ items: [sector()] }),
    });
    item.arrange(fixture);
    await assert.rejects(item.run(fixture), /secret/, item.name);
    const health = fixture.service.health();
    assert.equal(health.providers.find(({ provider }) => provider === 'storage')?.errorCategory, 'storage', item.name);
    assert.equal(JSON.stringify(health).includes('secret'), false, item.name);
    if (item.name === 'quotes write' || item.name === 'health persistence') {
      assert.notEqual(health.providers.find(({ provider }) => provider === 'tencent')?.lastSuccessAt, null);
    }
  }

  const maintenance = serviceFixture({ maintenance: async () => { throw new Error('database secret maintenance'); } });
  await assert.rejects(maintenance.service.maintain('CN', '2026-08-26', signal()), /secret/);
  const maintenanceHealth = maintenance.service.health();
  assert.equal(maintenanceHealth.providers.find(({ provider }) => provider === 'storage')?.errorCategory, 'storage');
  assert.equal(JSON.stringify(maintenanceHealth).includes('secret'), false);
});

test('recognizes primitive storage throws exactly once without overwriting provider success', async () => {
  const fixture = serviceFixture({ tencentSeries: async () => ({ items: [bar()] }) });
  fixture.repository.updateProviderHealth = () => { throw 'primitive database failure'; };

  let failure: unknown;
  try {
    await fixture.service.series({ symbol: 'sh600000', interval: 'minute' }, signal());
  } catch (error) {
    failure = error;
  }

  assert.equal(failure, 'primitive database failure');
  const health = fixture.service.health();
  const storage = health.providers.find(({ provider }) => provider === 'storage');
  const tencent = health.providers.find(({ provider }) => provider === 'tencent');
  assert.equal(storage?.consecutiveFailures, 1);
  assert.equal(storage?.errorCategory, 'storage');
  assert.equal(tencent?.available, true);
  assert.equal(tencent?.errorCategory, null);
});

type QuoteScript = (symbols: string[], signal: AbortSignal) => Promise<{ items: CanonicalQuote[] }>;
type SeriesScript = (request: { symbol: string; interval: 'minute' | 'day' | 'week' | 'month'; count?: number }, signal: AbortSignal) => Promise<{ items: Bar[] }>;
type AuctionScript = (symbols: string[], phase: 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed', signal: AbortSignal) => Promise<{ phase: 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed'; items: CanonicalQuote[] }>;
type SectorScript = (signal: AbortSignal) => Promise<{ items: SectorObservation[] }>;
type HistoryScript = (
  request: { market: Market; interval: 'quote'; start: string; end: string; symbols: string[]; limit: number },
  signal: AbortSignal,
) => Promise<{ items: CanonicalQuote[]; complete: boolean }>;

type FixtureOverrides = {
  now?: Date;
  cachedQuotes?: CanonicalQuote[];
  cachedBars?: Bar[];
  cachedSectors?: SectorObservation[];
  initialWatchlist?: string[];
  initialClosures?: UserState['closures'];
  tencentQuotes?: QuoteScript;
  sinaQuotes?: QuoteScript;
  tencentSeries?: SeriesScript;
  tencentAuction?: AuctionScript;
  tencentHistory?: HistoryScript;
  sinaSectors?: SectorScript;
  config?: MarketServiceOptions['config'];
  repositoryHealth?: RepositoryHealth;
  repositoryHealthScript?: () => RepositoryHealth;
  stateMutationError?: Error;
  stateMutationGate?: Promise<void>;
  schedulerCancel?: () => Promise<void>;
  maintenance?: NonNullable<MarketServiceOptions['maintenance']>;
  barWriteError?: Error;
  repository?: RepositoryDouble;
  recoveryCommitFailureAt?: number | null;
  gapWriteError?: Error;
  providerHealthWriteError?: Error;
};

function serviceFixture(overrides: FixtureOverrides = {}) {
  const events: string[] = [];
  const repository = overrides.repository ?? new RepositoryDouble(
    overrides.cachedQuotes ?? [],
    overrides.cachedBars ?? [],
    overrides.cachedSectors ?? [],
    overrides.repositoryHealth,
    overrides.repositoryHealthScript,
    events,
    overrides.barWriteError,
  );
  repository.recoveryCommitFailureAt = overrides.recoveryCommitFailureAt ?? repository.recoveryCommitFailureAt;
  repository.gapWriteError = overrides.gapWriteError ?? repository.gapWriteError;
  repository.providerHealthWriteError = overrides.providerHealthWriteError ?? repository.providerHealthWriteError;
  const stateStore = new StateStoreDouble(overrides.initialWatchlist ?? [], overrides.initialClosures ?? {}, overrides.stateMutationError, overrides.stateMutationGate);
  const scheduler = new SchedulerDouble(events, overrides.schedulerCancel);
  const tencent = new TencentDouble(overrides.tencentQuotes, overrides.tencentSeries, overrides.tencentAuction, overrides.tencentHistory);
  const sina = new SinaDouble(overrides.sinaQuotes, overrides.sinaSectors);
  const now = overrides.now ?? ACTIVE_NOW;
  const service = new MarketService({
    clock: { now: () => new Date(now) },
    tencent,
    sina,
    repository,
    scheduler,
    stateStore,
    initialState: { watchlist: [...(overrides.initialWatchlist ?? [])], closures: structuredClone(overrides.initialClosures ?? {}) },
    config: overrides.config,
    maintenance: overrides.maintenance,
  });
  return { service, repository, stateStore, scheduler, tencent, sina, events };
}

class TencentDouble {
  readonly historyCapabilities: ReadonlyArray<{ interval: 'quote'; markets: readonly Market[]; maxItems: number }>;
  readonly quoteCalls: string[][] = [];
  readonly seriesCalls: Array<{ symbol: string; interval: 'minute' | 'day' | 'week' | 'month'; count?: number }> = [];
  readonly auctionCalls: Array<{ symbols: string[]; phase: 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed' }> = [];
  readonly historyCalls: Array<{ market: Market; interval: 'quote'; start: string; end: string; symbols: string[]; limit: number }> = [];

  constructor(
    private readonly quoteScript: QuoteScript = async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol)) }),
    private readonly seriesScript: SeriesScript = async () => ({ items: [] }),
    private readonly auctionScript: AuctionScript = async (symbols, phase) => ({ phase, items: symbols.map((symbol) => quoteFor(symbol)) }),
    private readonly historyScript?: HistoryScript,
  ) {
    this.historyCapabilities = historyScript === undefined
      ? []
      : [{ interval: 'quote', markets: ['CN', 'HK'], maxItems: 10_000 }];
  }

  async quotes(symbols: string[], requestSignal: AbortSignal) {
    this.quoteCalls.push([...symbols]);
    return this.quoteScript(symbols, requestSignal);
  }

  async series(request: { symbol: string; interval: 'minute' | 'day' | 'week' | 'month'; count?: number }, requestSignal: AbortSignal) {
    this.seriesCalls.push({ ...request });
    return this.seriesScript(request, requestSignal);
  }

  async auction(symbols: string[], phase: 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed', requestSignal: AbortSignal) {
    this.auctionCalls.push({ symbols: [...symbols], phase });
    return this.auctionScript(symbols, phase, requestSignal);
  }

  async backfill(request: { market: Market; interval: 'quote'; start: string; end: string; symbols: string[]; limit: number }, requestSignal: AbortSignal) {
    this.historyCalls.push({ ...request, symbols: [...request.symbols] });
    if (!this.historyScript) throw new Error('history is unavailable');
    return this.historyScript(request, requestSignal);
  }
}

class SinaDouble {
  readonly quoteCalls: string[][] = [];
  readonly sectorCalls: number[] = [];

  constructor(
    private readonly quoteScript: QuoteScript = async (symbols) => ({ items: symbols.map((symbol) => quoteFor(symbol, { source: 'sina' })) }),
    private readonly sectorScript: SectorScript = async () => ({ items: [] }),
  ) {}

  async quotes(symbols: string[], requestSignal: AbortSignal) {
    this.quoteCalls.push([...symbols]);
    return this.quoteScript(symbols, requestSignal);
  }

  async sectors(requestSignal: AbortSignal) {
    this.sectorCalls.push(this.sectorCalls.length + 1);
    return this.sectorScript(requestSignal);
  }
}

class StateStoreDouble {
  state: UserState;
  calls = 0;

  constructor(watchlist: string[], closures: UserState['closures'], private readonly mutationError?: Error, private readonly mutationGate?: Promise<void>) {
    this.state = { watchlist: [...watchlist], closures: structuredClone(closures) };
  }

  async mutateWatchlist(mutation: WatchlistMutation): Promise<UserState> {
    this.calls++;
    if (this.mutationGate) await this.mutationGate;
    await Promise.resolve();
    if (this.mutationError) throw this.mutationError;
    const next = [...this.state.watchlist];
    const result = mutation(next);
    this.state = { ...this.state, watchlist: [...(result ?? next)] };
    return { watchlist: [...this.state.watchlist], closures: { ...this.state.closures } };
  }
}

class SchedulerDouble {
  callbacks: SchedulerCallbacks | null = null;
  starts = 0;
  cancelCalls = 0;

  constructor(private readonly events: string[], private readonly cancelScript: () => Promise<void> = async () => {}) {}

  start(callbacks: SchedulerCallbacks): () => Promise<void> {
    this.starts++;
    this.callbacks = callbacks;
    return async () => {
      this.cancelCalls++;
      this.events.push('scheduler-cancel');
      await this.cancelScript();
    };
  }

  health() {
    return { pendingTimers: 2, inFlight: 0 };
  }
}

class RepositoryDouble implements ServiceRepository {
  readonly quoteWrites: CanonicalQuote[][] = [];
  readonly barWrites: Bar[][] = [];
  readonly sectorWrites: Array<{ items: SectorObservation[]; resolution: 'intraday' | 'daily' }> = [];
  readonly healthUpdates: ProviderHealthUpdate[] = [];
  readonly gaps: CollectionGap[];
  readonly recoveryCommits: RecoverySegmentCommit[] = [];
  recoveryCommitFailureAt: number | null = null;
  gapWriteError: Error | undefined;
  providerHealthWriteError: Error | undefined;
  closeCalls = 0;
  private readonly quotes = new Map<string, CanonicalQuote>();
  private bars: Bar[];
  private sectors: SectorObservation[];
  private readonly repositoryHealth: RepositoryHealth;
  private readonly recoveryCursors = new Map<string, string>();

  constructor(
    quotes: CanonicalQuote[],
    bars: Bar[],
    sectors: SectorObservation[],
    health: RepositoryHealth | undefined,
    private readonly healthScript: (() => RepositoryHealth) | undefined,
    private readonly events: string[],
    private readonly barWriteError?: Error,
  ) {
    for (const item of quotes) this.quotes.set(item.symbol, { ...item });
    this.bars = bars.map((item) => ({ ...item }));
    this.sectors = sectors.map((item) => ({ ...item }));
    this.repositoryHealth = health ?? {
      databaseBytes: 0,
      liveDatabaseBytes: 0,
      providers: [],
      gaps: [],
      lastMaintenance: null,
      counts: { quoteObservations: quotes.length, minuteBars: bars.length, dailyBars: 0, sectorObservations: sectors.length, sectorDailySummaries: 0 },
    };
    this.gaps = this.repositoryHealth.gaps;
  }

  writeBatch(items: CanonicalQuote[]): void {
    const copy = items.map((item) => ({ ...item }));
    this.quoteWrites.push(copy);
    for (const item of copy) this.quotes.set(item.symbol, item);
  }

  latestQuotes(symbols: string[]): CanonicalQuote[] {
    return symbols.flatMap((symbol) => {
      const item = this.quotes.get(symbol);
      return item ? [{ ...item }] : [];
    });
  }

  writeBars(items: Bar[]): void {
    if (this.barWriteError) throw this.barWriteError;
    const copy = items.map((item) => ({ ...item }));
    this.barWrites.push(copy);
    const keys = new Set(copy.map((item) => `${item.symbol}\0${item.interval}\0${item.timestamp}`));
    this.bars = [...this.bars.filter((item) => !keys.has(`${item.symbol}\0${item.interval}\0${item.timestamp}`)), ...copy];
  }

  querySeries(query: SeriesQuery): Bar[] {
    return this.bars.filter((item) => item.symbol === query.symbol && item.interval === query.interval).map((item) => ({ ...item }));
  }

  writeSectors(items: SectorObservation[], resolution: 'intraday' | 'daily' = 'intraday'): void {
    const copy = items.map((item) => ({ ...item }));
    this.sectorWrites.push({ items: copy, resolution });
    this.sectors = copy;
  }

  readSectors(query: SectorQuery = {}): SectorObservation[] {
    return this.sectors.filter((item) => query.category === undefined || item.category === query.category).map((item) => ({ ...item }));
  }

  updateProviderHealth(update: ProviderHealthUpdate): void {
    if (this.providerHealthWriteError) throw this.providerHealthWriteError;
    this.healthUpdates.push({ ...update });
    const index = this.repositoryHealth.providers.findIndex(({ provider }) => provider === update.provider);
    if (index < 0) this.repositoryHealth.providers.push({ ...update });
    else this.repositoryHealth.providers[index] = { ...update };
  }

  recordGap(gap: CollectionGap): void {
    if (this.gapWriteError) throw this.gapWriteError;
    const key = (item: CollectionGap) => [item.market, item.symbol, item.interval, item.start, item.end, item.reason].join('\0');
    const index = this.gaps.findIndex((item) => key(item) === key(gap));
    if (index < 0) this.gaps.push(structuredClone(gap));
    else this.gaps[index] = structuredClone(gap);
  }

  recoveryCursor(provider: string, market: Market, interval: 'quote'): string | null {
    return this.recoveryCursors.get([provider, market, interval].join('\0')) ?? null;
  }

  initializeRecoveryCursors(provider: string, interval: 'quote', seeds: RecoveryCursorSeed[], _updatedAt: string): void {
    for (const seed of seeds) {
      const key = [provider, seed.market, interval].join('\0');
      if (!this.recoveryCursors.has(key)) this.recoveryCursors.set(key, seed.cursor);
    }
  }

  commitRecoverySegment(segment: RecoverySegmentCommit): void {
    const call = this.recoveryCommits.length + 1;
    if (this.recoveryCommitFailureAt === call) throw new Error('simulated recovery commit crash');
    const key = [segment.provider, segment.market, segment.interval].join('\0');
    const current = this.recoveryCursors.get(key);
    if (current !== undefined && Date.parse(segment.end) <= Date.parse(current)) return;
    this.recoveryCommits.push(structuredClone(segment));
    if (segment.items.length > 0) this.writeBatch(segment.items);
    if (segment.gap) this.recordGap(segment.gap);
    this.recoveryCursors.set(key, segment.end);
  }

  health(): RepositoryHealth {
    if (this.healthScript) return structuredClone(this.healthScript());
    return structuredClone(this.repositoryHealth);
  }

  close(): void {
    this.closeCalls++;
    this.events.push('repository-close');
  }
}

function quoteFor(symbol: string, overrides: Partial<CanonicalQuote> = {}): CanonicalQuote {
  const market: Market = symbol.toLowerCase().startsWith('hk') ? 'HK' : 'CN';
  return {
    symbol,
    name: 'Example',
    market,
    currency: market === 'CN' ? 'CNY' : 'HKD',
    price: 10,
    open: 9.8,
    high: 10.2,
    low: 9.7,
    previousClose: 9.9,
    volume: 1000,
    amount: 10_000,
    change: 0.1,
    changePercent: 1.01,
    marketTime: '2026-08-27T09:20:00+08:00',
    fetchedAt: ACTIVE_NOW.toISOString(),
    source: 'tencent',
    isDelayed: false,
    isStale: false,
    ...overrides,
  };
}

function bar(overrides: Partial<Bar> = {}): Bar {
  return {
    symbol: 'sh600000',
    market: 'CN',
    interval: 'minute',
    timestamp: '2026-08-27T09:20:00+08:00',
    open: 10,
    high: 10.2,
    low: 9.9,
    close: 10.1,
    volume: 100,
    turnover: 1000,
    ...overrides,
  };
}

function sector(overrides: Partial<SectorObservation> = {}): SectorObservation {
  return {
    id: 'bank',
    name: 'Banking',
    category: 'industry',
    changePercent: 1,
    turnover: 1000,
    netFlow: null,
    leaderSymbol: 'sh600000',
    leaderName: 'Example',
    leaderChangePercent: 2,
    marketTime: '2026-08-27T09:20:00+08:00',
    fetchedAt: ACTIVE_NOW.toISOString(),
    source: 'sina',
    isDelayed: false,
    isStale: false,
    ...overrides,
  };
}

function maintenanceResult() {
  return {
    runAt: ACTIVE_NOW.toISOString(),
    completedAt: ACTIVE_NOW.toISOString(),
    compactedTradingDates: [],
    compactedRawRows: 0,
    createdMinuteBars: 0,
    createdDailyBars: 0,
    createdDailySectorSummaries: 0,
    deletedRawRows: 0,
    expiredMinuteTradingDates: [],
    expiredMinuteRows: 0,
    prunedMinuteTradingDates: [],
    prunedMinuteRows: 0,
    prunedSectorBuckets: [],
    prunedSectorRows: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    maxBytes: 536_870_912,
    capSatisfied: true,
  };
}

function repositoryHealth(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return {
    databaseBytes: 0,
    liveDatabaseBytes: 0,
    providers: [],
    gaps: [],
    lastMaintenance: null,
    counts: { quoteObservations: 0, minuteBars: 0, dailyBars: 0, sectorObservations: 0, sectorDailySummaries: 0 },
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function assertLosslessJson(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.notEqual(serialized, undefined);
  assert.deepEqual(JSON.parse(serialized), value);
  assert.doesNotThrow(() => structuredClone(value));
}

function assertNoNegativeZero(value: unknown): void {
  if (typeof value === 'number') {
    assert.equal(Object.is(value, -0), false);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoNegativeZero(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoNegativeZero(item);
  }
}
