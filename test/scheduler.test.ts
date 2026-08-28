import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketScheduler } from '../src/scheduler.ts';
import { atShanghai, FakeClock, flush } from './helpers.ts';

test('collects active markets immediately, quotes every ten seconds, and fetches sectors every minute with one persisted bucket per five minutes', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const quotes: string[][] = [];
  const sectorPersistence: boolean[] = [];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      quotes.push([...markets]);
      return { marketTimes: Object.fromEntries(markets.map((market) => [market, clock.now().toISOString()])) };
    },
    collectSectors: async (_signal, persist) => {
      sectorPersistence.push(persist);
    },
    runMaintenance: async () => {},
  });

  await flush();
  assert.deepEqual(quotes, [['CN', 'HK']]);
  await clock.advance(9_999);
  assert.equal(quotes.length, 1);
  await clock.advance(1);
  assert.equal(quotes.length, 2);
  await clock.advance(50_000);
  assert.equal(sectorPersistence.length, 1);
  assert.equal(sectorPersistence[0], true);
  await clock.advance(240_000);
  assert.deepEqual(sectorPersistence, [true, false, false, false, true]);

  await dispose();
});

test('does not collect during a shared lunch break and runs maintenance when a market closes', async () => {
  const lunchClock = new FakeClock(atShanghai('2026-08-27 12:15'));
  const lunchQuotes: string[][] = [];
  const lunchScheduler = new MarketScheduler({ clock: lunchClock, jitterMs: () => 0 });
  const stopLunch = lunchScheduler.start({
    collectQuotes: async (markets) => {
      lunchQuotes.push([...markets]);
      return { marketTimes: {} };
    },
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });
  await lunchClock.advance(45 * 60 * 1_000 - 1);
  assert.deepEqual(lunchQuotes, []);
  await lunchClock.advance(1);
  assert.deepEqual(lunchQuotes, [['CN', 'HK']]);
  await stopLunch();

  const closeClock = new FakeClock(atShanghai('2026-08-27 14:59:55'));
  const maintenance: Array<{ market: string; date: string }> = [];
  const closeScheduler = new MarketScheduler({ clock: closeClock, jitterMs: () => 0 });
  const stopClose = closeScheduler.start({
    collectQuotes: async (markets) => ({ marketTimes: Object.fromEntries(markets.map((market) => [market, closeClock.now().toISOString()])) }),
    collectSectors: async () => {},
    runMaintenance: async (market, tradingDate) => {
      maintenance.push({ market, date: tradingDate });
    },
  });
  await flush();
  await closeClock.advance(5_000);
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-26' },
    { market: 'HK', date: '2026-08-26' },
    { market: 'CN', date: '2026-08-27' },
  ]);
  await stopClose();
});

test('backs off unchanged timestamps and resets the failure delay when a market timestamp advances', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const calls: number[] = [];
  const times = ['2026-08-27T09:20:00+08:00', '2026-08-27T09:20:00+08:00', '2026-08-27T09:21:00+08:00'];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 7_000 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      calls.push(clock.now().getTime());
      const marketTime = times.shift() ?? '2026-08-27T09:22:00+08:00';
      return { marketTimes: Object.fromEntries(markets.map((market) => [market, marketTime])) };
    },
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  await clock.advance(10_000);
  await clock.advance(16_999);
  assert.equal(calls.length, 2);
  await clock.advance(1);
  assert.equal(calls.length, 3);
  await clock.advance(9_999);
  assert.equal(calls.length, 3);
  await clock.advance(1);
  assert.equal(calls.length, 4);

  await dispose();
});

test('stages persistence so unchanged or invalid markets never commit while advancing markets commit independently', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const collections: string[][] = [];
  const commits: string[][] = [];
  let attempt = 0;
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 7_000 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      collections.push([...markets]);
      attempt++;
      const marketTimes = attempt === 1
        ? { CN: '2026-08-27T09:20:00+08:00', HK: '2026-08-27T09:20:00+08:00' }
        : attempt === 2
          ? { CN: '2026-08-27T09:20:00+08:00', HK: '2026-08-27T09:20:10+08:00' }
          : attempt === 3
            ? { HK: '2026-08-27T09:20:20+08:00' }
            : { CN: 'not-a-market-timestamp' };
      return {
        marketTimes,
        commit: async (advancedMarkets: string[]) => {
          commits.push([...advancedMarkets]);
        },
      };
    },
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  await clock.advance(10_000);
  await clock.advance(10_000);
  await clock.advance(7_000);
  assert.deepEqual(commits, [['CN', 'HK'], ['HK'], ['HK']]);
  assert.deepEqual(collections, [['CN', 'HK'], ['CN', 'HK'], ['HK'], ['CN']]);
  await dispose();
});

test('rejects every timestamp without an explicit Z or numeric offset before staged commit', async () => {
  for (const timestamp of [
    '2026-08-27T09:20:00',
    '2026-08-27T09:20:00.123',
    '2026-08-27T09:20:00.123456',
  ]) {
    const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
    const commits: string[][] = [];
    const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
    const dispose = scheduler.start({
      collectQuotes: async (markets) => ({
        marketTimes: Object.fromEntries(markets.map((market) => [market, timestamp])),
        commit: async (advancedMarkets) => {
          commits.push([...advancedMarkets]);
        },
      }),
      collectSectors: async () => {},
      runMaintenance: async () => {},
    });
    await flush();
    assert.deepEqual(commits, [], timestamp);
    await dispose();
  }
});

test('releases staged collection work when no market has an advancing timestamp', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  let releases = 0;
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => ({
      marketTimes: Object.fromEntries(markets.map((market) => [market, null])),
      commit: async () => assert.fail('non-advancing markets must not commit'),
      release: async () => { releases++; },
    }),
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  assert.equal(releases, 1);
  await dispose();
});

test('rejects impossible calendar, clock, and offset values before staged commit', async () => {
  for (const timestamp of [
    '2026-02-30T09:20:00+08:00',
    '2026-08-27T24:00:00Z',
    '2026-08-27T09:60:00Z',
    '2026-08-27T09:20:00+24:00',
  ]) {
    const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
    const commits: string[][] = [];
    const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
    const dispose = scheduler.start({
      collectQuotes: async (markets) => ({
        marketTimes: Object.fromEntries(markets.map((market) => [market, timestamp])),
        commit: async (advancedMarkets) => {
          commits.push([...advancedMarkets]);
        },
      }),
      collectSectors: async () => {},
      runMaintenance: async () => {},
    });
    await flush();
    assert.deepEqual(commits, [], timestamp);
    await dispose();
  }
});

test('accepts canonical Z and explicit-offset timestamps for staged commits', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const commits: string[][] = [];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => ({
      marketTimes: {
        CN: '2026-08-27T01:20:00Z',
        HK: '2026-08-27T09:20:00+08:00',
      },
      commit: async (advancedMarkets) => {
        commits.push([...advancedMarkets]);
      },
    }),
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });
  await flush();
  assert.deepEqual(commits, [['CN', 'HK']]);
  await dispose();
});

test('uses the full 10, 30, 60, and 300 second backoff independently per market', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const cnAttemptTimes: number[] = [];
  const hkAttemptTimes: number[] = [];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      if (markets.includes('CN')) cnAttemptTimes.push(clock.now().getTime());
      if (markets.includes('HK')) hkAttemptTimes.push(clock.now().getTime());
      return {
        marketTimes: Object.fromEntries(markets.map((market) => [market, market === 'CN' ? null : clock.now().toISOString()])),
      };
    },
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  await clock.advance(400_000);
  const startedAt = atShanghai('2026-08-27 09:20').getTime();
  assert.deepEqual(cnAttemptTimes.map((time) => time - startedAt), [0, 10_000, 40_000, 100_000, 400_000]);
  assert.equal(hkAttemptTimes.length, 41);
  await dispose();
});

test('runs outstanding closed-market maintenance on startup, retries rejected work, and completes each market date once', async () => {
  const clock = new FakeClock(atShanghai('2026-08-28 08:30'));
  const maintenance: Array<{ market: string; date: string }> = [];
  let cnFailures = 0;
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async () => ({ marketTimes: {} }),
    collectSectors: async () => {},
    runMaintenance: async (market, tradingDate) => {
      maintenance.push({ market, date: tradingDate });
      if (market === 'CN' && cnFailures++ === 0) throw new Error('temporary repository failure');
    },
  });

  await flush();
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-27' },
    { market: 'HK', date: '2026-08-27' },
  ]);
  await clock.advance(10_000);
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-27' },
    { market: 'HK', date: '2026-08-27' },
    { market: 'CN', date: '2026-08-27' },
  ]);
  await clock.advance(60_000);
  assert.equal(maintenance.length, 3);
  await dispose();
});

test('resumes pre-open maintenance from the previous trading date across a weekend', async () => {
  const clock = new FakeClock(atShanghai('2026-08-31 08:30'));
  const maintenance: Array<{ market: string; date: string }> = [];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async () => ({ marketTimes: {} }),
    collectSectors: async () => {},
    runMaintenance: async (market, tradingDate) => {
      maintenance.push({ market, date: tradingDate });
    },
  });

  await flush();
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-28' },
    { market: 'HK', date: '2026-08-28' },
  ]);
  await dispose();
});

test('queues the last closed date on active startup, retries failures, and continues current collection', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  const maintenance: Array<{ market: string; date: string }> = [];
  const collections: string[][] = [];
  let cnFailures = 0;
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      collections.push([...markets]);
      return { marketTimes: Object.fromEntries(markets.map((market) => [market, clock.now().toISOString()])) };
    },
    collectSectors: async () => {},
    runMaintenance: async (market, tradingDate) => {
      maintenance.push({ market, date: tradingDate });
      if (market === 'CN' && cnFailures++ === 0) throw new Error('temporary startup maintenance failure');
    },
  });

  await flush();
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-26' },
    { market: 'HK', date: '2026-08-26' },
  ]);
  assert.deepEqual(collections, [['CN', 'HK']]);

  await clock.advance(10_000);
  assert.deepEqual(maintenance, [
    { market: 'CN', date: '2026-08-26' },
    { market: 'HK', date: '2026-08-26' },
    { market: 'CN', date: '2026-08-26' },
  ]);
  assert.deepEqual(collections, [['CN', 'HK'], ['CN', 'HK']]);
  await clock.advance(60_000);
  assert.equal(maintenance.length, 3);
  await dispose();
});

test('does not block active collection while startup orphan maintenance is still in flight', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const collections: string[][] = [];
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      collections.push([...markets]);
      return { marketTimes: Object.fromEntries(markets.map((market) => [market, clock.now().toISOString()])) };
    },
    collectSectors: async () => {},
    runMaintenance: async () => gate,
  });

  await flush();
  assert.deepEqual(collections, [['CN', 'HK']]);
  release();
  await flush();
  await dispose();
});

test('reports deterministic timer and in-flight health while running and after disposal', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new MarketScheduler({ clock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (markets) => {
      await gate;
      return { marketTimes: Object.fromEntries(markets.map((market) => [market, clock.now().toISOString()])) };
    },
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  assert.deepEqual(scheduler.health(), { pendingTimers: 1, inFlight: 1 });
  release();
  await flush();
  assert.deepEqual(scheduler.health(), { pendingTimers: 2, inFlight: 0 });
  await dispose();
  assert.deepEqual(scheduler.health(), { pendingTimers: 0, inFlight: 0 });
});

test('disposal aborts an in-flight collection before it resolves and clears every timer', async () => {
  const clock = new FakeClock(atShanghai('2026-08-27 09:20'));
  let abortObserved = false;
  const disposalEvents: string[] = [];
  const orderedClock = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout(timer: number) {
      disposalEvents.push('timer-clear');
      clock.clearTimeout(timer);
    },
  };
  const scheduler = new MarketScheduler({ clock: orderedClock, jitterMs: () => 0 });
  const dispose = scheduler.start({
    collectQuotes: async (_markets, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        abortObserved = signal.aborted;
        disposalEvents.push('request-abort');
        resolve({ marketTimes: {} });
      }, { once: true });
    }),
    collectSectors: async () => {},
    runMaintenance: async () => {},
  });

  await flush();
  await dispose();
  assert.equal(abortObserved, true);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(disposalEvents.indexOf('timer-clear') < disposalEvents.indexOf('request-abort'), true);
});

test('disposal also aborts in-flight sector and maintenance callbacks without scheduling more work', async () => {
  const sectorClock = new FakeClock(atShanghai('2026-08-27 09:20'));
  let sectorAbortObserved = false;
  const sectorScheduler = new MarketScheduler({ clock: sectorClock, jitterMs: () => 0 });
  const stopSector = sectorScheduler.start({
    collectQuotes: async (markets) => ({ marketTimes: Object.fromEntries(markets.map((market) => [market, sectorClock.now().toISOString()])) }),
    collectSectors: async (signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
      sectorAbortObserved = signal.aborted;
      resolve();
    }, { once: true })),
    runMaintenance: async () => {},
  });
  await flush();
  await sectorClock.advance(60_000);
  await stopSector();
  assert.equal(sectorAbortObserved, true);
  assert.equal(sectorClock.pendingTimers(), 0);

  const maintenanceClock = new FakeClock(atShanghai('2026-08-27 16:30'));
  let maintenanceAbortObserved = false;
  const maintenanceScheduler = new MarketScheduler({ clock: maintenanceClock, jitterMs: () => 0 });
  const stopMaintenance = maintenanceScheduler.start({
    collectQuotes: async () => ({ marketTimes: {} }),
    collectSectors: async () => {},
    runMaintenance: async (_market, _date, signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
      maintenanceAbortObserved = signal.aborted;
      resolve();
    }, { once: true })),
  });
  await flush();
  await stopMaintenance();
  assert.equal(maintenanceAbortObserved, true);
  assert.equal(maintenanceClock.pendingTimers(), 0);
});
