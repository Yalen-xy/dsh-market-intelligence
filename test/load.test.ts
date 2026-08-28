import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Bar, CanonicalQuote, Market, MarketPhase, SectorObservation } from '../src/model.ts';
import type { MarketProvider } from '../src/providers/provider.ts';
import { TencentProvider } from '../src/providers/tencent.ts';
import { MarketRepository } from '../src/repository.ts';
import { maintainRepository, type MaintenanceResult, type RetentionPolicy } from '../src/retention.ts';
import { MarketScheduler } from '../src/scheduler.ts';
import { MarketService } from '../src/service.ts';
import { canonicalizeSymbol, SUPPORTED_INDICES } from '../src/symbols.ts';
import { atShanghai, FakeClock, flush } from './helpers.ts';

const TRADING_DATE = '2026-08-27';
const PROVIDER_BATCH_SIZE = 12;
const PROVIDER_CONCURRENCY = 3;

test('simulates a 100-symbol mixed A/H trading day with bounded collection, exact phases, close maintenance, and clean shutdown', async (t) => {
  const startedAt = performance.now();
  await verifyConfiguredTencentConcurrency();

  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-market-load-'));
  const repository = MarketRepository.open(path.join(directory, 'market.sqlite'));
  const clock = new FakeClock(atShanghai(`${TRADING_DATE} 08:59:50`));
  const watchlist = mixedWatchlist();
  const tencent = new ScriptedTencent(clock);
  const sina = new ScriptedSina(clock);
  const scheduler = new MarketScheduler({
    clock,
    quoteIntervalMs: 10_000,
    sectorIntervalMs: 60_000,
    sectorPersistIntervalMs: 300_000,
    jitterMs: () => 0,
  });
  const maintenance: Array<{ policy: RetentionPolicy; result: MaintenanceResult }> = [];
  const service = new MarketService({
    clock,
    tencent,
    sina,
    repository,
    scheduler,
    stateStore: {
      async mutateWatchlist(mutation) {
        const next = [...watchlist];
        return { watchlist: mutation(next) ?? next, closures: configuredClosures() };
      },
    },
    initialState: { watchlist, closures: configuredClosures() },
    config: {
      providerBatchSize: PROVIDER_BATCH_SIZE,
      minuteRetentionTradingDays: 30,
      storageSoftLimitBytes: 536_870_912,
    },
    maintenance: (target, policy, now) => {
      const result = maintainRepository(target as MarketRepository, policy, now);
      maintenance.push({ policy: { ...policy }, result: structuredClone(result) });
      return result;
    },
  });
  let disposed = false;
  let removed = false;
  let peakDatabaseBytes = databaseFootprint(repository.path);
  t.after(async () => {
    if (!disposed) await service.dispose().catch(() => undefined);
    if (!removed) rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(watchlist.length, 100);
  assert.equal(watchlist.filter((symbol) => canonicalizeSymbol(symbol).market === 'CN').length, 50);
  assert.equal(watchlist.filter((symbol) => canonicalizeSymbol(symbol).market === 'HK').length, 50);

  await settleScheduler(clock);
  await advanceInTenSecondSteps(clock, atShanghai(`${TRADING_DATE} 16:00:10`), () => {
    if (clock.now().getTime() % 60_000 === 0) {
      peakDatabaseBytes = Math.max(peakDatabaseBytes, databaseFootprint(repository.path));
    }
  });

  const quoteTicks = quoteTicksByMarket(tencent.quoteBatches);
  assert.equal(quoteTicks.CN.length, 1_530);
  assert.equal(quoteTicks.HK.length, 2_160);
  assert.equal(quoteTicks.CN[0], atShanghai(`${TRADING_DATE} 09:15:00`).getTime());
  assert.equal(quoteTicks.CN.at(-1), atShanghai(`${TRADING_DATE} 14:59:50`).getTime());
  assert.equal(quoteTicks.HK[0], atShanghai(`${TRADING_DATE} 09:00:00`).getTime());
  assert.equal(quoteTicks.HK.at(-1), atShanghai(`${TRADING_DATE} 15:59:50`).getTime());
  assertNoTimesBetween(quoteTicks.CN, atShanghai(`${TRADING_DATE} 11:30:00`), atShanghai(`${TRADING_DATE} 13:00:00`));
  assertNoTimesBetween(quoteTicks.HK, atShanghai(`${TRADING_DATE} 12:00:00`), atShanghai(`${TRADING_DATE} 13:00:00`));
  assertQuoteCadence(quoteTicks.CN, atShanghai(`${TRADING_DATE} 11:30:00`), atShanghai(`${TRADING_DATE} 13:00:00`));
  assertQuoteCadence(quoteTicks.HK, atShanghai(`${TRADING_DATE} 12:00:00`), atShanghai(`${TRADING_DATE} 13:00:00`));

  assert.equal(Math.max(...tencent.quoteBatches.map(({ symbols }) => symbols.length)), PROVIDER_BATCH_SIZE);
  assert.equal(tencent.quoteBatches.every(({ symbols }) => symbols.length <= PROVIDER_BATCH_SIZE), true);
  assert.equal(new Set(tencent.quoteBatches.flatMap(({ symbols }) => symbols)).size, 105);
  assert.equal(tencent.quoteBatches.some(({ symbols }) => symbols.includes(SUPPORTED_INDICES.HSI)), true);
  assert.equal(tencent.quoteBatches.some(({ symbols }) => symbols.includes(SUPPORTED_INDICES.HSTECH)), true);

  assert.equal(sina.sectorTimes.length, 253);
  assert.equal(sina.sectorTimes[0], atShanghai(`${TRADING_DATE} 09:16:00`).getTime());
  assert.equal(sina.sectorTimes.at(-1), atShanghai(`${TRADING_DATE} 14:59:00`).getTime());
  assertMinuteCadence(sina.sectorTimes, atShanghai(`${TRADING_DATE} 11:30:00`), atShanghai(`${TRADING_DATE} 13:00:00`));
  const expectedSectorPersists = firstTimePerFiveMinuteBucket(sina.sectorTimes);
  const persistedSectors = repository.readSectors({ resolution: 'intraday', limit: 10_000 });
  assert.equal(expectedSectorPersists.length, 51);
  assert.deepEqual(
    persistedSectors.map(({ fetchedAt }) => Date.parse(fetchedAt)).sort((left, right) => left - right),
    expectedSectorPersists,
  );

  const closeMaintenance = maintenance.filter(({ policy }) => policy.closedTradingDate === TRADING_DATE);
  assert.deepEqual(closeMaintenance.map(({ policy }) => policy.market), ['CN', 'HK']);
  assert.deepEqual(closeMaintenance.flatMap(({ result }) => result.compactedTradingDates), [
    `CN:${TRADING_DATE}`,
    `HK:${TRADING_DATE}`,
  ]);
  assert.equal(closeMaintenance.reduce((sum, { result }) => sum + result.createdMinuteBars, 0), 32_235);
  assert.equal(closeMaintenance.reduce((sum, { result }) => sum + result.createdDailyBars, 0), 105);
  assert.equal(repository.rawTradingDates('CN').includes(TRADING_DATE), false);
  assert.equal(repository.rawTradingDates('HK').includes(TRADING_DATE), false);

  const health = service.health();
  assert.deepEqual(health.database.counts, {
    quoteObservations: 0,
    minuteBars: 32_235,
    dailyBars: 105,
    sectorObservations: 52,
    sectorDailySummaries: 1,
  });
  assert.deepEqual(health.scheduler, { state: 'running', pendingTimers: 2, inFlight: 0 });
  assert.equal(health.providers.find(({ provider }) => provider === 'tencent')?.errorCategory, null);
  assert.equal(health.providers.find(({ provider }) => provider === 'sina')?.errorCategory, null);
  const allScheduledSymbols = [...watchlist, ...Object.values(SUPPORTED_INDICES)];
  assert.equal(new Set(allScheduledSymbols).size, 105);
  assert.equal(allScheduledSymbols.filter((symbol) => canonicalizeSymbol(symbol).market === 'CN').length, 53);
  assert.equal(allScheduledSymbols.filter((symbol) => canonicalizeSymbol(symbol).market === 'HK').length, 52);
  for (const symbol of allScheduledSymbols) {
    const expectedMinutes = canonicalizeSymbol(symbol).market === 'CN' ? 255 : 360;
    const minutes = repository.querySeries({ symbol, interval: 'minute', limit: 10_000 });
    assert.equal(minutes.length, expectedMinutes, `${symbol} minute count`);
    assert.deepEqual(new Set(minutes.map(({ interval }) => interval)), new Set(['minute']), `${symbol} interval`);
    assert.equal(repository.querySeries({ symbol, interval: 'day', limit: 10 }).length, 1, `${symbol} daily count`);
  }

  const finalDatabaseBytes = health.database.databaseBytes;
  const finalLiveDatabaseBytes = health.database.liveDatabaseBytes;
  peakDatabaseBytes = Math.max(peakDatabaseBytes, finalDatabaseBytes);

  await service.dispose();
  disposed = true;
  assert.equal(clock.pendingTimers(), 0);
  assert.throws(() => repository.health(), /closed/i);
  rmSync(directory, { recursive: true, force: true });
  removed = true;
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({
    loadRuntimeMs: Number((performance.now() - startedAt).toFixed(3)),
    peakDatabaseBytes,
    finalDatabaseBytes,
    finalLiveDatabaseBytes,
    rawObservations: 193_410,
    minuteBars: 32_235,
    dailyBars: 105,
  }));
});

class ScriptedTencent implements MarketProvider {
  readonly quoteBatches: Array<{ at: number; symbols: string[] }> = [];

  constructor(private readonly clock: FakeClock) {}

  async quotes(symbols: string[], signal: AbortSignal) {
    assert.equal(signal.aborted, false);
    this.quoteBatches.push({ at: this.clock.now().getTime(), symbols: [...symbols] });
    return { items: symbols.map((symbol) => quoteFor(symbol, this.clock.now())) };
  }

  async series(request: { symbol: string; interval: 'minute' | 'day' | 'week' | 'month' }) {
    return { items: [barFor(request.symbol, request.interval, this.clock.now())] };
  }

  async auction(symbols: string[], phase: MarketPhase) {
    return { phase, items: symbols.map((symbol) => quoteFor(symbol, this.clock.now())) };
  }
}

class ScriptedSina {
  readonly sectorTimes: number[] = [];

  constructor(private readonly clock: FakeClock) {}

  async quotes(): Promise<{ items: CanonicalQuote[] }> {
    throw new Error('scripted network offline');
  }

  async sectors(signal: AbortSignal) {
    assert.equal(signal.aborted, false);
    const now = this.clock.now();
    this.sectorTimes.push(now.getTime());
    return { items: [sectorFor(now)] };
  }
}

async function verifyConfiguredTencentConcurrency(): Promise<void> {
  let inFlight = 0;
  let maximum = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    await Promise.resolve();
    const symbol = new URL(String(input)).searchParams.get('code')!;
    const body = tencentPayload(symbol, `${TRADING_DATE}T09:20:00+08:00`);
    inFlight--;
    return new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } });
  };
  const provider = new TencentProvider({
    fetch: fetchImpl,
    quoteConcurrency: PROVIDER_CONCURRENCY,
    now: () => atShanghai(`${TRADING_DATE} 09:20:05`).getTime(),
    timeoutSignal: () => new AbortController().signal,
  });
  const symbols = Array.from({ length: 24 }, (_, index) => `sh${String(600000 + index)}`);
  assert.equal((await provider.quotes(symbols, new AbortController().signal)).items.length, 24);
  assert.equal(maximum, PROVIDER_CONCURRENCY);
  assert.equal(inFlight, 0);
}

async function advanceInTenSecondSteps(clock: FakeClock, target: Date, onStep?: () => void): Promise<void> {
  while (clock.now().getTime() < target.getTime()) {
    await clock.advance(Math.min(10_000, target.getTime() - clock.now().getTime()));
    await settleScheduler(clock);
    onStep?.();
  }
}

async function settleScheduler(clock: FakeClock): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await flush();
    if (clock.pendingTimers() === 2) return;
  }
  throw new Error(`scheduler did not settle; pending timers: ${clock.pendingTimers()}`);
}

function mixedWatchlist(): string[] {
  return [
    ...Array.from({ length: 50 }, (_, index) => `sh${String(600000 + index)}`),
    ...Array.from({ length: 50 }, (_, index) => `hk${String(index + 1).padStart(5, '0')}`),
  ];
}

function configuredClosures() {
  return { '2026': { CN: [], HK: [] } };
}

function quoteFor(symbol: string, now: Date): CanonicalQuote {
  const canonical = canonicalizeSymbol(symbol);
  const seconds = Math.floor(now.getTime() / 1_000);
  return {
    symbol: canonical.symbol,
    name: canonical.symbol,
    market: canonical.market,
    currency: canonical.currency,
    price: 10 + (seconds % 100) / 100,
    open: 10,
    high: 11,
    low: 9,
    previousClose: 9.9,
    volume: seconds,
    amount: seconds * 10,
    change: 0.1,
    changePercent: 1.01,
    marketTime: now.toISOString(),
    fetchedAt: now.toISOString(),
    source: 'tencent',
    isDelayed: false,
    isStale: false,
  };
}

function barFor(symbol: string, interval: 'minute' | 'day' | 'week' | 'month', now: Date): Bar {
  const canonical = canonicalizeSymbol(symbol);
  return {
    symbol: canonical.symbol,
    market: canonical.market,
    interval,
    timestamp: now.toISOString(),
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
    turnover: 1_000,
  };
}

function sectorFor(now: Date): SectorObservation {
  return {
    id: 'bank',
    name: 'Banking',
    category: 'industry',
    changePercent: 1,
    turnover: 1_000,
    netFlow: null,
    leaderSymbol: 'sh600000',
    leaderName: 'Example',
    leaderChangePercent: 2,
    marketTime: now.toISOString(),
    fetchedAt: now.toISOString(),
    source: 'sina',
    isDelayed: false,
    isStale: false,
  };
}

function tencentPayload(symbol: string, marketTime: string): Uint8Array {
  const date = marketTime.slice(0, 10);
  const time = marketTime.slice(11, 16).replace(':', '');
  return new TextEncoder().encode(JSON.stringify({
    data: {
      [symbol]: {
        qt: { [symbol]: ['51', symbol, symbol, '10.15', '10.10', '10.00', '125000', '', '10.20', '9.95'] },
        data: { date, data: [`${time} 10.15 3200`] },
      },
    },
  }));
}

function quoteTicksByMarket(batches: Array<{ at: number; symbols: string[] }>): Record<Market, number[]> {
  const result: Record<Market, Set<number>> = { CN: new Set(), HK: new Set() };
  for (const batch of batches) {
    for (const market of new Set(batch.symbols.map((symbol) => canonicalizeSymbol(symbol).market))) result[market].add(batch.at);
  }
  return {
    CN: [...result.CN].sort((left, right) => left - right),
    HK: [...result.HK].sort((left, right) => left - right),
  };
}

function assertNoTimesBetween(times: number[], start: Date, end: Date): void {
  assert.equal(times.some((time) => time >= start.getTime() && time < end.getTime()), false);
}

function assertQuoteCadence(times: number[], lunchStart: Date, lunchEnd: Date): void {
  for (let index = 1; index < times.length; index++) {
    const difference = times[index]! - times[index - 1]!;
    assert.equal(difference === 10_000 || (times[index - 1]! < lunchStart.getTime() && times[index]! >= lunchEnd.getTime()), true);
  }
}

function assertMinuteCadence(times: number[], lunchStart: Date, lunchEnd: Date): void {
  assertNoTimesBetween(times, lunchStart, lunchEnd);
  for (let index = 1; index < times.length; index++) {
    const difference = times[index]! - times[index - 1]!;
    assert.equal(difference === 60_000 || (times[index - 1]! < lunchStart.getTime() && times[index]! >= lunchEnd.getTime()), true);
  }
}

function firstTimePerFiveMinuteBucket(times: number[]): number[] {
  const buckets = new Map<number, number>();
  for (const time of times) {
    const bucket = Math.floor(time / 300_000);
    if (!buckets.has(bucket)) buckets.set(bucket, time);
  }
  return [...buckets.values()].sort((left, right) => left - right);
}

function databaseFootprint(databasePath: string): number {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].reduce((sum, file) => {
    try {
      return sum + statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sum;
      throw error;
    }
  }, 0);
}
