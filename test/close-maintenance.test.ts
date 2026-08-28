import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { UserState } from '../src/config.ts';
import type { CanonicalQuote, Market, MarketPhase } from '../src/model.ts';
import { MarketRepository } from '../src/repository.ts';
import type { SchedulerCallbacks } from '../src/scheduler.ts';
import { maintainRepository } from '../src/retention.ts';
import { MarketService, type MaintenanceRunner } from '../src/service.ts';
import { canonicalizeSymbol } from '../src/symbols.ts';
import { atShanghai, flush } from './helpers.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('service rejects current-date maintenance before each market close and accepts the exact CN and HK boundaries', async () => {
  for (const [market, beforeClose, atClose] of [
    ['CN', '2026-08-27 14:59:59', '2026-08-27 15:00:00'],
    ['HK', '2026-08-27 15:59:59', '2026-08-27 16:00:00'],
  ] as const) {
    const early = serviceFixture(atShanghai(beforeClose));
    await assert.rejects(early.service.maintain(market, '2026-08-27', signal()), /not closed/i, market);
    await early.service.dispose();

    const closed = serviceFixture(atShanghai(atClose));
    await assert.doesNotReject(closed.service.maintain(market, '2026-08-27', signal()), market);
    await closed.service.dispose();
  }
});

test('same-day maintenance compacts pre-close data while an after-close direct refresh returns live without reinserting raw data', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const gate = deferred<void>();
  const started = deferred<void>();
  let providerCalls = 0;
  const fixture = serviceFixture(clock.now(), {
    clock,
    quoteScript: async (symbols) => {
      providerCalls++;
      started.resolve();
      await gate.promise;
      return { items: symbols.map((symbol) => quoteFor(symbol, clock.now())) };
    },
  });

  const refresh = fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  await started.promise;
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();
  assert.equal(maintenanceSettled, false);

  gate.resolve();
  await refresh;
  await maintenance;
  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  assert.equal(fixture.repository.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 1);
  assert.equal(fixture.repository.querySeries({ symbol: 'sh600000', interval: 'day', limit: 10 }).length, 1);

  const closing = await fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  assert.equal(providerCalls, 2);
  assert.equal(closing.availability, 'live');
  assert.equal(closing.items[0]?.marketTime, '2026-08-27T07:00:00.000Z');
  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  await fixture.service.dispose();
});

test('same-day maintenance waits through staged collection commit before deleting the closed-date raw rows', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const gate = deferred<void>();
  const started = deferred<void>();
  const fixture = serviceFixture(clock.now(), {
    clock,
    watchlist: ['sh600000'],
    quoteScript: async (symbols) => {
      started.resolve();
      await gate.promise;
      return { items: symbols.map((symbol) => quoteFor(symbol, clock.now())) };
    },
  });

  const collection = fixture.service.collectQuotes(['CN'], signal());
  await started.promise;
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();
  assert.equal(maintenanceSettled, false);

  gate.resolve();
  const staged = await collection;
  await flush();
  assert.equal(maintenanceSettled, false, 'provider completion alone must not release a staged write');
  await staged.commit(['CN'], signal());
  await maintenance;
  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  assert.equal(fixture.repository.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 1);
  await fixture.service.dispose();
});

test('staged commit validation failures release every owned lease without an explicit stage release', async (context) => {
  const cases: Array<{ name: string; approved: () => Market[]; error: RegExp }> = [
    { name: 'unrelated market', approved: () => ['HK'], error: /unrequested market/i },
    { name: 'sparse array', approved: () => Array(1) as Market[], error: /dense array/i },
    { name: 'unsupported market', approved: () => ['US'] as unknown as Market[], error: /market/i },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
      const fixture = serviceFixture(clock.now(), { clock, watchlist: ['sh600000'] });
      const staged = await fixture.service.collectQuotes(['CN'], signal());
      clock.set(atShanghai('2026-08-27 15:00:00'));
      let maintenanceStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending';
      const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).then(
        () => { maintenanceStatus = 'fulfilled'; },
        () => { maintenanceStatus = 'rejected'; },
      );
      await flush();
      assert.equal(maintenanceStatus, 'pending');

      let commitError: unknown;
      try {
        await staged.commit(item.approved(), signal());
      } catch (error) {
        commitError = error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const statusBeforeDisposal = maintenanceStatus;
      await fixture.service.dispose();
      await maintenance;

      assert.match(String(commitError), item.error);
      assert.equal(statusBeforeDisposal, 'fulfilled');
    });
  }
});

test('duplicate staged approval releases its lease once and lets close maintenance settle', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const fixture = serviceFixture(clock.now(), { clock, watchlist: ['sh600000'] });
  const staged = await fixture.service.collectQuotes(['CN'], signal());
  clock.set(atShanghai('2026-08-27 15:00:00'));
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal());
  await flush();

  await staged.commit(['CN', 'CN'], signal());
  await staged.release();
  await maintenance;

  assert.deepEqual(fixture.repository.rawTradingDates('CN'), []);
  assert.equal(fixture.repository.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 1);
  await fixture.service.dispose();
});

test('staged persistence failure releases every owned lease and lets close maintenance settle', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const fixture = serviceFixture(clock.now(), { clock, watchlist: ['sh600000'] });
  const staged = await fixture.service.collectQuotes(['CN'], signal());
  fixture.repository.writeBatch = () => { throw new Error('staged storage failed'); };
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();
  assert.equal(maintenanceSettled, false);

  await assert.rejects(staged.commit(['CN'], signal()), /staged storage failed/i);
  await maintenance;

  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  await fixture.service.dispose();
});

test('successful partial staged commit retains the uncommitted market lease for a later commit', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const fixture = serviceFixture(clock.now(), { clock, watchlist: ['sh600000', 'hk00700'] });
  const staged = await fixture.service.collectQuotes(['CN', 'HK'], signal());
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();

  await staged.commit(['HK'], signal());
  await flush();
  assert.equal(maintenanceSettled, false, 'committing HK must retain the uncommitted CN lease');
  await staged.commit(['CN'], signal());
  await maintenance;

  assert.deepEqual(fixture.repository.rawTradingDates('CN'), []);
  assert.deepEqual(fixture.repository.rawTradingDates('HK'), ['2026-08-27']);
  await fixture.service.dispose();
});

test('failed pre-close refresh releases the maintenance wait without leaking a writer lease', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const gate = deferred<void>();
  const started = deferred<void>();
  let maintenanceStarted = false;
  const fixture = serviceFixture(clock.now(), {
    clock,
    maintenance: (repository, policy, now) => {
      maintenanceStarted = true;
      return maintainRepository(repository as MarketRepository, policy, now);
    },
    quoteScript: async () => {
      started.resolve();
      await gate.promise;
      throw new Error('provider failed at close');
    },
  });

  const refresh = fixture.service.quotes({ symbols: ['sh600000'], refresh: true }, signal());
  await started.promise;
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();
  assert.equal(maintenanceStarted, false);
  assert.equal(maintenanceSettled, false);

  gate.resolve();
  assert.equal((await refresh).availability, 'unavailable');
  await maintenance;
  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  await fixture.service.dispose();
});

test('aborted staged commit releases the maintenance wait without writing or deadlocking', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  let maintenanceStarted = false;
  const fixture = serviceFixture(clock.now(), {
    clock,
    watchlist: ['sh600000'],
    maintenance: (repository, policy, now) => {
      maintenanceStarted = true;
      return maintainRepository(repository as MarketRepository, policy, now);
    },
  });
  const staged = await fixture.service.collectQuotes(['CN'], signal());
  clock.set(atShanghai('2026-08-27 15:00:00'));
  let maintenanceSettled = false;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal()).finally(() => { maintenanceSettled = true; });
  await flush();
  assert.equal(maintenanceStarted, false);
  assert.equal(maintenanceSettled, false);

  const controller = new AbortController();
  controller.abort(new DOMException('commit cancelled', 'AbortError'));
  await assert.rejects(staged.commit(['CN'], controller.signal), /cancel|abort/i);
  await maintenance;
  assert.equal(fixture.repository.rawTradingDates('CN').includes('2026-08-27'), false);
  await fixture.service.dispose();
});

test('an aborted staged commit cannot reuse its released lease after close maintenance', async () => {
  const clock = new MutableClock(atShanghai('2026-08-27 14:59:59'));
  const fixture = serviceFixture(clock.now(), { clock, watchlist: ['sh600000'] });
  const staged = await fixture.service.collectQuotes(['CN'], signal());
  clock.set(atShanghai('2026-08-27 15:00:00'));
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal());
  await flush();

  const aborted = new AbortController();
  aborted.abort(new DOMException('first commit cancelled', 'AbortError'));
  await assert.rejects(staged.commit(['CN'], aborted.signal), /cancel|abort/i);
  await maintenance;
  await staged.commit(['CN'], signal());

  assert.deepEqual(fixture.repository.rawTradingDates('CN'), []);
  await fixture.service.dispose();
});

test('active-day direct refresh cannot restore prior-day represented rows while that date is under maintenance', async () => {
  const clock = new MutableClock(atShanghai('2026-08-28 10:00:00'));
  const providerStarted = deferred<void>();
  const releaseProvider = deferred<void>();
  const maintenanceStarted = deferred<void>();
  const releaseMaintenance = deferred<void>();
  const fixture = serviceFixture(clock.now(), {
    clock,
    maintenance: async (repository, policy, now) => {
      maintenanceStarted.resolve();
      await releaseMaintenance.promise;
      return maintainRepository(repository as MarketRepository, policy, now);
    },
    quoteScript: async (symbols) => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return {
        items: symbols.map((symbol, index) => quoteFor(symbol, clock.now(), index === 0
          ? { marketTime: '2026-08-27T14:59:50+08:00' }
          : { marketTime: null, fetchedAt: '2026-08-27T06:59:50.000Z' })),
      };
    },
  });

  const refresh = fixture.service.quotes({ symbols: ['sh600000', 'sh600001'], refresh: true }, signal());
  await providerStarted.promise;
  const maintenance = fixture.service.maintain('CN', '2026-08-27', signal());
  await maintenanceStarted.promise;
  releaseProvider.resolve();

  const result = await refresh;
  const rawDatesDuringMaintenance = fixture.repository.rawTradingDates('CN');
  releaseMaintenance.resolve();
  await maintenance;
  assert.deepEqual(rawDatesDuringMaintenance, []);
  assert.equal(result.availability, 'stale');
  assert.equal(result.items.length, 2);
  assert.equal(result.items.every(({ isStale }) => isStale), true);
  assert.deepEqual(fixture.repository.rawTradingDates('CN'), []);
  await fixture.service.dispose();
});

test('staged mixed-market commit persists admitted represented dates but skips a maintained prior date', async () => {
  const clock = new MutableClock(atShanghai('2026-08-28 10:00:00'));
  const fixture = serviceFixture(clock.now(), {
    clock,
    watchlist: ['sh600000', 'sh600001', 'hk00700'],
    quoteScript: async (symbols) => ({
      items: symbols.map((symbol) => quoteFor(symbol, clock.now(), symbol === 'sh600000'
        ? { marketTime: '2026-08-27T14:59:50+08:00' }
        : { marketTime: '2026-08-28T10:00:00+08:00' })),
    }),
  });

  const staged = await fixture.service.collectQuotes(['CN', 'HK'], signal());
  await fixture.service.maintain('CN', '2026-08-27', signal());
  await staged.commit(['CN', 'HK'], signal());

  assert.deepEqual(fixture.repository.rawTradingDates('CN'), ['2026-08-28']);
  assert.deepEqual(fixture.repository.rawTradingDates('HK'), ['2026-08-28']);
  assert.equal(fixture.repository.rawQuotes('CN', '2026-08-28').some(({ symbol }) => symbol === 'sh600000'), false);
  assert.equal(fixture.repository.rawQuotes('CN', '2026-08-28').some(({ symbol }) => symbol === 'sh600001'), true);
  assert.equal(fixture.repository.rawQuotes('HK', '2026-08-28').some(({ symbol }) => symbol === 'hk00700'), true);
  await fixture.service.dispose();
});

test('explicit maintenance rejects older weekends and market closures but accepts prior weekdays', async () => {
  const now = atShanghai('2026-09-01 10:00:00');
  const closures = { '2026': { CN: ['2026-08-27'], HK: ['2026-08-26'] } };
  for (const [market, tradingDate] of [
    ['CN', '2026-08-29'],
    ['HK', '2026-08-30'],
    ['CN', '2026-08-27'],
    ['HK', '2026-08-26'],
  ] as const) {
    const fixture = serviceFixture(now, { closures });
    await assert.rejects(fixture.service.maintain(market, tradingDate, signal()), /not a trading date/i);
    assert.equal(fixture.repository.health().lastMaintenance, null);
    await fixture.service.dispose();
  }

  const valid = serviceFixture(now, { closures });
  await assert.doesNotReject(valid.service.maintain('CN', '2026-08-28', signal()));
  await assert.doesNotReject(valid.service.maintain('HK', '2026-08-28', signal()));
  await valid.service.dispose();
});

type FixtureOptions = {
  clock?: MutableClock;
  watchlist?: string[];
  closures?: UserState['closures'];
  quoteScript?: (symbols: string[], signal: AbortSignal) => Promise<{ items: CanonicalQuote[] }>;
  maintenance?: MaintenanceRunner;
};

function serviceFixture(initialNow: Date, options: FixtureOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-market-close-'));
  temporaryDirectories.push(directory);
  const repository = MarketRepository.open(path.join(directory, 'market.sqlite'));
  const clock = options.clock ?? new MutableClock(initialNow);
  const scheduler = new ManualScheduler();
  const watchlist = options.watchlist ?? [];
  const closures = options.closures ?? { '2026': { CN: [], HK: [] } };
  const tencent = {
    quotes: options.quoteScript ?? (async (symbols: string[]) => ({ items: symbols.map((symbol) => quoteFor(symbol, clock.now())) })),
    async series() { return { items: [] }; },
    async auction(_symbols: string[], phase: MarketPhase) { return { phase, items: [] }; },
  };
  const sina = {
    async quotes() { return { items: [] }; },
    async sectors() { return { items: [] }; },
  };
  const service = new MarketService({
    clock,
    tencent,
    sina,
    repository,
    scheduler,
    stateStore: { async mutateWatchlist(mutation) {
      const next = [...watchlist];
      return { watchlist: mutation(next) ?? next, closures };
    } },
    initialState: { watchlist, closures },
    maintenance: options.maintenance,
  });
  return { service, repository, scheduler, clock };
}

class MutableClock {
  constructor(private value: Date) {}
  now = () => new Date(this.value);
  set(value: Date): void { this.value = new Date(value); }
}

class ManualScheduler {
  callbacks: SchedulerCallbacks | null = null;
  start(callbacks: SchedulerCallbacks): () => Promise<void> {
    this.callbacks = callbacks;
    return async () => {};
  }
  health() { return { pendingTimers: 0, inFlight: 0 }; }
}

function quoteFor(symbol: string, now: Date, overrides: Partial<CanonicalQuote> = {}): CanonicalQuote {
  const canonical = canonicalizeSymbol(symbol);
  return {
    symbol: canonical.symbol,
    name: canonical.symbol,
    market: canonical.market,
    currency: canonical.currency,
    price: 10,
    open: 10,
    high: 10,
    low: 10,
    previousClose: 9.9,
    volume: 100,
    amount: 1_000,
    change: 0.1,
    changePercent: 1.01,
    marketTime: now.toISOString(),
    fetchedAt: now.toISOString(),
    source: 'tencent',
    isDelayed: false,
    isStale: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
