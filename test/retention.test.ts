import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Bar, CanonicalQuote, SectorObservation } from '../src/model.ts';
import { MarketRepository } from '../src/repository.ts';
import { maintainRepository, MEBIBYTE } from '../src/retention.ts';

const temporaryDirectories: string[] = [];
const TRADING_DATES = [
  '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27',
  '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
  '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18',
  '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openRepository(): MarketRepository {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-market-retention-'));
  temporaryDirectories.push(directory);
  return MarketRepository.open(join(directory, 'market.sqlite'));
}

function quote(overrides: Partial<CanonicalQuote> = {}): CanonicalQuote {
  return {
    symbol: 'sh600000', name: '浦发银行', market: 'CN', currency: 'CNY', price: 10, open: 10, high: 10, low: 10,
    previousClose: 9.9, volume: 100, amount: 1_000, change: 0.1, changePercent: 1.01,
    marketTime: '2026-08-26T10:00:05+08:00', fetchedAt: '2026-08-26T02:00:06Z', source: 'tencent', isDelayed: false, isStale: false,
    ...overrides,
  };
}

function bar(date: string, interval: string = 'minute'): Bar {
  return { symbol: 'sh600000', market: 'CN', interval, timestamp: `${date}T${interval === 'day' ? '00:00:00' : '10:00:00'}+08:00`, open: 10, high: 11, low: 9, close: 10.5, volume: 10, turnover: 100 };
}

function sector(date: string): SectorObservation {
  return { id: `sector-${date}`, name: `Sector ${date}`, category: 'industry', changePercent: 1, turnover: 10, netFlow: null, leaderSymbol: null, leaderName: null, leaderChangePercent: null, marketTime: null, fetchedAt: `${date}T02:00:00Z`, source: 'sina', isDelayed: false, isStale: false };
}

test('compacts a closed date into minute and daily OHLC, deletes raw in the same maintenance transaction, and preserves current raw', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote(),
    quote({ price: 10.2, volume: 110, amount: 1_102, marketTime: '2026-08-26T10:00:15+08:00', fetchedAt: '2026-08-26T02:00:16Z' }),
    quote({ price: 9.9, volume: 125, amount: 1_250, marketTime: '2026-08-26T10:00:25+08:00', fetchedAt: '2026-08-26T02:00:26Z' }),
    quote({ price: 10.1, volume: 140, amount: 1_400, marketTime: '2026-08-26T10:01:05+08:00', fetchedAt: '2026-08-26T02:01:06Z' }),
    quote({ marketTime: '2026-08-27T10:00:05+08:00', fetchedAt: '2026-08-27T02:00:06Z' }),
  ]);

  const result = maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T08:00:00Z'));
  const minute = repo.querySeries({ symbol: 'sh600000', interval: 'minute', start: '2026-08-26T00:00:00+08:00', end: '2026-08-27T00:00:00+08:00', limit: 10 });
  assert.deepEqual(minute, [
    { symbol: 'sh600000', market: 'CN', interval: 'minute', timestamp: '2026-08-26T10:00:00+08:00', open: 10, high: 10.2, low: 9.9, close: 9.9, volume: 25, turnover: 250 },
    { symbol: 'sh600000', market: 'CN', interval: 'minute', timestamp: '2026-08-26T10:01:00+08:00', open: 10.1, high: 10.1, low: 10.1, close: 10.1, volume: 15, turnover: 150 },
  ]);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'day', limit: 10 }), [
    { symbol: 'sh600000', market: 'CN', interval: 'day', timestamp: '2026-08-26T00:00:00+08:00', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 40, turnover: 400 },
  ]);
  assert.deepEqual(repo.latestQuotes(['sh600000']).map(({ marketTime }) => marketTime), ['2026-08-27T10:00:05+08:00']);
  assert.equal(result.compactedRawRows, 4);
  assert.equal(result.deletedRawRows, 4);
  assert.deepEqual(result.compactedTradingDates, ['CN:2026-08-26']);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
  repo.close();
});

test('uses cumulative deltas only for known provider semantics and otherwise stores null volume and turnover', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote({ symbol: 'sh600001', source: 'unknown-feed', volume: 10, amount: 100 }),
    quote({ symbol: 'sh600001', source: 'unknown-feed', volume: 20, amount: 200, price: 10.1, marketTime: '2026-08-26T10:00:15+08:00' }),
  ]);
  maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T08:00:00Z'));
  const [minute] = repo.querySeries({ symbol: 'sh600001', interval: 'minute', limit: 10 });
  assert.equal(minute?.volume, null);
  assert.equal(minute?.turnover, null);
  repo.close();
});

test('does not combine cumulative counters from competing providers during compaction', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote(),
    quote({ volume: 110, amount: 1_100, price: 10.1, marketTime: '2026-08-26T10:00:15+08:00' }),
    quote({ source: 'sina', volume: 1_000, amount: 10_000, price: 99, marketTime: '2026-08-26T10:00:05+08:00' }),
    quote({ source: 'sina', volume: 1_100, amount: 11_000, price: 100, marketTime: '2026-08-26T10:00:15+08:00' }),
  ]);
  maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T08:00:00Z'));
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }), [
    { symbol: 'sh600000', market: 'CN', interval: 'minute', timestamp: '2026-08-26T10:00:00+08:00', open: 10, high: 10.1, low: 10, close: 10.1, volume: 10, turnover: 100 },
  ]);
  repo.close();
});

test('retains the newest 30 explicit stored trading dates and never removes daily bars', () => {
  const repo = openRepository();
  repo.writeBars(TRADING_DATES.flatMap((date) => [bar(date), bar(date, 'day')]));
  maintainRepository(repo, { market: 'CN', minuteTradingDays: 30, databaseBytes: () => 1 }, new Date('2026-08-27T08:00:00Z'));

  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 100 }).map(({ timestamp }) => timestamp.slice(0, 10)), TRADING_DATES.slice(1));
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'day', limit: 100 }).length, 31);
  repo.close();
});

test('soft-cap pruning removes oldest security intraday before sector intraday and preserves protected state', () => {
  const repo = openRepository();
  repo.writeBars([bar('2026-08-20'), bar('2026-08-20', 'day')]);
  repo.writeSectors([sector('2026-08-20')]);
  repo.updateProviderHealth({ provider: 'tencent', available: true, latencyMs: 10, lastAttemptAt: '2026-08-27T08:00:00Z', lastSuccessAt: '2026-08-27T08:00:00Z', lastFailureAt: null, consecutiveFailures: 0, error: null });
  const bytes = () => repo.health().counts.minuteBars > 0 ? 513 * MEBIBYTE : 511 * MEBIBYTE;

  const result = maintainRepository(repo, { market: 'CN', maxBytes: 512 * MEBIBYTE, databaseBytes: bytes }, new Date('2026-08-27T08:00:00Z'));
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 0);
  assert.equal(repo.readSectors({ resolution: 'intraday', limit: 10 }).length, 1);
  assert.equal(repo.readSectors({ resolution: 'daily', limit: 10 }).length, 1);
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'day', limit: 10 }).length, 1);
  assert.equal(repo.health().providers.length, 1);
  assert.equal(result.prunedMinuteRows, 1);
  assert.equal(result.prunedSectorRows, 0);
  assert.equal(result.capSatisfied, true);
  repo.close();
});

test('soft-cap pruning reaches sector intraday only after all eligible security intraday is gone', () => {
  const repo = openRepository();
  repo.writeBars([bar('2026-08-20')]);
  repo.writeSectors([sector('2026-08-19'), sector('2026-08-20')]);
  const bytes = () => {
    const minuteRows = repo.health().counts.minuteBars;
    const intradaySectorRows = repo.readSectors({ resolution: 'intraday', limit: 10 }).length;
    return 511 * MEBIBYTE + minuteRows * 3 * MEBIBYTE + intradaySectorRows * 2 * MEBIBYTE;
  };

  const result = maintainRepository(repo, { maxBytes: 512 * MEBIBYTE, databaseBytes: bytes }, new Date('2026-08-27T08:00:00Z'));
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 0);
  assert.equal(repo.readSectors({ resolution: 'intraday', limit: 10 }).length, 0);
  assert.equal(repo.readSectors({ resolution: 'daily', limit: 10 }).length, 2);
  assert.equal(result.prunedMinuteRows, 1);
  assert.equal(result.prunedSectorRows, 2);
  repo.close();
});

test('maintenance failure rolls back compaction, raw deletion, retention, and its maintenance record', () => {
  const repo = openRepository();
  repo.writeBatch([quote(), quote({ price: 10.2, marketTime: '2026-08-26T10:00:15+08:00' })]);
  assert.throws(
    () => maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => { throw new Error('size unavailable'); } }, new Date('2026-08-27T08:00:00Z')),
    /size unavailable/,
  );
  assert.equal(repo.latestQuotes(['sh600000']).length, 1);
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 0);
  assert.equal(repo.health().lastMaintenance, null);
  repo.close();
});

test('rejects an impossible closed trading date without recording maintenance', () => {
  const repo = openRepository();
  assert.throws(
    () => maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-02-30', databaseBytes: () => 1 }, new Date('2026-08-27T08:00:00Z')),
    /closedTradingDate/i,
  );
  assert.equal(repo.health().lastMaintenance, null);
  repo.close();
});

test('rejects same-day compaction before the actual market close and accepts exact CN and HK close boundaries', () => {
  const closures = { '2026': { CN: [], HK: [] } };
  for (const [market, beforeClose, atClose] of [
    ['CN', '2026-08-27T06:59:59.000Z', '2026-08-27T07:00:00.000Z'],
    ['HK', '2026-08-27T07:59:59.000Z', '2026-08-27T08:00:00.000Z'],
  ] as const) {
    const early = openRepository();
    assert.throws(
      () => maintainRepository(early, { market, closedTradingDate: '2026-08-27', closures, databaseBytes: () => 1 }, new Date(beforeClose)),
      /not closed/i,
      market,
    );
    assert.equal(early.health().lastMaintenance, null);
    early.close();

    const closed = openRepository();
    assert.doesNotThrow(() => maintainRepository(
      closed,
      { market, closedTradingDate: '2026-08-27', closures, databaseBytes: () => 1 },
      new Date(atClose),
    ));
    closed.close();
  }
});

test('configured full-day closure does not make that untraded calendar date compactable', () => {
  const repo = openRepository();
  const closures = { '2026': { CN: ['2026-08-27'], HK: [] } };
  assert.throws(
    () => maintainRepository(
      repo,
      { market: 'CN', closedTradingDate: '2026-08-27', closures, databaseBytes: () => 1 },
      new Date('2026-08-27T09:00:00.000Z'),
    ),
    /not a trading date/i,
  );
  repo.close();
});

test('explicit maintenance rejects older weekend and market-closure dates but accepts a valid prior weekday', () => {
  const now = new Date('2026-09-01T02:00:00.000Z');
  const closures = { '2026': { CN: ['2026-08-27'], HK: ['2026-08-26'] } };
  for (const [market, tradingDate] of [
    ['CN', '2026-08-29'],
    ['HK', '2026-08-30'],
    ['CN', '2026-08-27'],
    ['HK', '2026-08-26'],
  ] as const) {
    const repo = openRepository();
    assert.throws(
      () => maintainRepository(repo, { market, closedTradingDate: tradingDate, closures, databaseBytes: () => 1 }, now),
      /not a trading date/i,
    );
    assert.equal(repo.health().lastMaintenance, null);
    repo.close();
  }

  for (const market of ['CN', 'HK'] as const) {
    const repo = openRepository();
    assert.doesNotThrow(() => maintainRepository(
      repo,
      { market, closedTradingDate: '2026-08-28', closures, databaseBytes: () => 1 },
      now,
    ));
    repo.close();
  }
});

test('uses a valid fallback source per minute and builds the daily bar from compacted intervals', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote({ price: null, volume: 100, amount: 1_000, marketTime: '2026-08-26T10:00:05+08:00' }),
    quote({ source: 'sina', price: 9.8, volume: 500, amount: 4_900, marketTime: '2026-08-26T10:00:10+08:00' }),
    quote({ price: 10.2, volume: 120, amount: 1_220, marketTime: '2026-08-26T10:01:05+08:00' }),
  ]);
  maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T02:00:00Z'));
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).map(({ timestamp, open, close }) => ({ timestamp, open, close })), [
    { timestamp: '2026-08-26T10:00:00+08:00', open: 9.8, close: 9.8 },
    { timestamp: '2026-08-26T10:01:00+08:00', open: 10.2, close: 10.2 },
  ]);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'day', limit: 10 }).map(({ open, high, low, close }) => ({ open, high, low, close })), [
    { open: 9.8, high: 10.2, low: 9.8, close: 10.2 },
  ]);
  repo.close();
});

test('keeps raw observations and records a gap when no valid compaction bar can be persisted', () => {
  const repo = openRepository();
  repo.writeBatch([quote({ price: null })]);
  maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T02:00:00Z'));
  assert.equal(repo.latestQuotes(['sh600000']).length, 1);
  assert.equal(repo.health().gaps.some(({ symbol, reason }) => symbol === 'sh600000' && reason === 'compaction_unavailable'), true);
  repo.close();
});

test('records an explicit gap for an invalid minute before deleting otherwise compacted raw', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote({ price: 10, marketTime: '2026-08-26T10:00:05+08:00' }),
    quote({ price: null, marketTime: '2026-08-26T10:01:05+08:00' }),
  ]);
  maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-26', databaseBytes: () => 1 }, new Date('2026-08-27T02:00:00Z'));
  assert.equal(repo.latestQuotes(['sh600000']).length, 0);
  assert.equal(repo.health().gaps.some(({ symbol, start, end, reason }) => (
    symbol === 'sh600000'
    && start === '2026-08-26T10:01:00+08:00'
    && end === '2026-08-26T10:02:00+08:00'
    && reason === 'compaction_unavailable'
  )), true);
  repo.close();
});

test('startup maintenance sweeps every orphan raw date through the requested closed date and preserves current raw', () => {
  const repo = openRepository();
  repo.writeBatch([
    quote({ marketTime: '2026-08-27T10:00:00+08:00', fetchedAt: '2026-08-27T02:00:01Z' }),
    quote({ marketTime: '2026-08-28T10:00:00+08:00', fetchedAt: '2026-08-28T02:00:01Z' }),
    quote({ marketTime: '2026-08-31T10:00:00+08:00', fetchedAt: '2026-08-31T02:00:01Z' }),
  ]);
  assert.deepEqual(repo.rawTradingDates('CN'), ['2026-08-27', '2026-08-28', '2026-08-31']);
  const result = maintainRepository(repo, { market: 'CN', closedTradingDate: '2026-08-28', databaseBytes: () => 1 }, new Date('2026-08-31T02:30:00Z'));
  assert.deepEqual(result.compactedTradingDates, ['CN:2026-08-27', 'CN:2026-08-28']);
  assert.deepEqual(repo.rawTradingDates('CN'), ['2026-08-31']);
  repo.close();
});

test('daily sector summaries are explicit and protected when intraday sectors are pruned for the cap', () => {
  const repo = openRepository();
  repo.writeSectors([{ ...sector('2026-08-20'), id: 'daily-protected' }], 'daily');
  repo.writeSectors([{ ...sector('2026-08-20'), id: 'intraday-prunable' }]);
  const bytes = () => repo.readSectors({ resolution: 'intraday', limit: 10 }).length > 0 ? 513 * MEBIBYTE : 511 * MEBIBYTE;
  maintainRepository(repo, { maxBytes: 512 * MEBIBYTE, databaseBytes: bytes }, new Date('2026-08-27T02:00:00Z'));
  assert.deepEqual(repo.readSectors({ resolution: 'daily', limit: 10 }).map(({ id }) => id), ['daily-protected', 'intraday-prunable']);
  assert.deepEqual(repo.readSectors({ resolution: 'intraday', limit: 10 }), []);
  repo.close();
});

test('production soft-cap accounting prunes only enough real SQLite pages and leaves newer intraday data', () => {
  const control = openRepository();
  control.writeBars([bar('2026-08-27')]);
  control.writeSectors([sector('2026-08-27')]);
  const cap = control.health().liveDatabaseBytes + 128 * 1024;
  control.close();

  const repo = openRepository();
  const oldBars = Array.from({ length: 1_200 }, (_, index) => {
    const hour = String(Math.floor(index / 60)).padStart(2, '0');
    const minute = String(index % 60).padStart(2, '0');
    return { ...bar('2026-08-20'), timestamp: `2026-08-20T${hour}:${minute}:00+08:00` };
  });
  repo.writeBars([...oldBars, bar('2026-08-27')]);
  repo.writeSectors([sector('2026-08-27')]);
  assert.equal(repo.health().liveDatabaseBytes > cap, true);
  const result = maintainRepository(repo, { maxBytes: cap }, new Date('2026-08-27T02:00:00Z'));
  assert.equal(result.capSatisfied, true);
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', start: '2026-08-27T00:00:00+08:00', limit: 10 }).length, 1);
  assert.equal(repo.readSectors({ resolution: 'intraday', limit: 10 }).length, 1);
  assert.equal(result.prunedMinuteTradingDates[0], '2026-08-20');
  assert.equal(result.prunedSectorRows, 0);
  repo.close();
});

test('production soft-cap rolls back and stops when a shared-page candidate makes no live-byte progress', () => {
  const repo = openRepository();
  repo.writeBars([
    bar('2026-08-19'),
    bar('2026-08-20'),
    bar('2026-08-20', 'day'),
  ]);
  const liveBytes = repo.health().liveDatabaseBytes;

  const result = maintainRepository(repo, { maxBytes: liveBytes - 1 }, new Date('2026-08-27T02:00:00Z'));

  assert.equal(result.capSatisfied, false);
  assert.equal(result.bytesAfter, liveBytes);
  assert.deepEqual(result.prunedMinuteTradingDates, []);
  assert.equal(result.prunedMinuteRows, 0);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).map(({ timestamp }) => timestamp.slice(0, 10)), [
    '2026-08-19',
    '2026-08-20',
  ]);
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'day', limit: 10 }).length, 1);
  repo.close();
});

test('production soft-cap continues across candidates that each release real SQLite pages', () => {
  const control = openRepository();
  control.writeBars([bar('2026-08-27')]);
  const cap = control.health().liveDatabaseBytes + 32 * 1024;
  control.close();

  const repo = openRepository();
  const denseDate = (date: string): Bar[] => Array.from({ length: 1_200 }, (_, index) => {
    const hour = String(Math.floor(index / 60)).padStart(2, '0');
    const minute = String(index % 60).padStart(2, '0');
    return { ...bar(date), timestamp: `${date}T${hour}:${minute}:00+08:00` };
  });
  repo.writeBars([...denseDate('2026-08-19'), ...denseDate('2026-08-20'), bar('2026-08-27')]);
  assert.equal(repo.health().liveDatabaseBytes > cap, true);

  const result = maintainRepository(repo, { maxBytes: cap }, new Date('2026-08-27T02:00:00Z'));

  assert.equal(result.capSatisfied, true);
  assert.deepEqual(result.prunedMinuteTradingDates, ['2026-08-19', '2026-08-20']);
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 1);
  repo.close();
});

test('sector maintenance uses historical Asia/Shanghai rules and counts only changed daily summaries', () => {
  const repo = openRepository();
  const database = repo.path;
  repo.writeSectors([sector('1991-08-23')]);

  const beforeClose = maintainRepository(
    repo,
    { market: 'CN', closedTradingDate: '1991-08-22', databaseBytes: () => 1 },
    new Date('1991-08-24T02:00:00Z'),
  );
  assert.equal(beforeClose.createdDailySectorSummaries, 0);
  assert.equal(repo.readSectors({ resolution: 'daily', limit: 10 }).length, 0);

  const first = maintainRepository(
    repo,
    { market: 'CN', closedTradingDate: '1991-08-23', databaseBytes: () => 1 },
    new Date('1991-08-24T02:01:00Z'),
  );
  const repeated = maintainRepository(
    repo,
    { market: 'CN', closedTradingDate: '1991-08-23', databaseBytes: () => 1 },
    new Date('1991-08-24T02:02:00Z'),
  );
  assert.equal(first.createdDailySectorSummaries, 1);
  assert.equal(repeated.createdDailySectorSummaries, 0);
  repo.close();

  const sqlite = new DatabaseSync(database);
  assert.equal(sqlite.prepare("SELECT bucket_time FROM sector_observations WHERE resolution = 'daily'").get()?.bucket_time, '1991-08-22T15:00:00.000Z');
  sqlite.close();
});

test('minute retention derives trading dates from Asia/Shanghai instants', () => {
  const repo = openRepository();
  repo.writeBars([
    { ...bar('2026-08-26'), timestamp: '2026-08-26T15:30:00Z' },
    { ...bar('2026-08-27'), timestamp: '2026-08-26T16:30:00Z' },
  ]);
  maintainRepository(repo, { market: 'CN', minuteTradingDays: 1, databaseBytes: () => 1 }, new Date('2026-08-27T02:00:00Z'));
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).map(({ timestamp }) => timestamp), ['2026-08-26T16:30:00Z']);
  repo.close();
});

test('minute retention uses historical Asia/Shanghai DST rather than a fixed UTC offset', () => {
  const repo = openRepository();
  repo.writeBars([
    { ...bar('1991-08-23'), timestamp: '1991-08-22T15:30:00Z' },
    { ...bar('1991-08-23'), timestamp: '1991-08-23T01:00:00Z' },
  ]);
  maintainRepository(repo, { market: 'CN', minuteTradingDays: 1, databaseBytes: () => 1 }, new Date('1991-08-24T02:00:00Z'));
  assert.equal(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).length, 2);
  repo.close();
});
