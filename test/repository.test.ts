import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Bar, CanonicalQuote, Market, SectorObservation } from '../src/model.ts';
import { MarketRepository, type CollectionGap, type RecoveryCursorSeed, type RecoverySegmentCommit } from '../src/repository.ts';

type CrashConsistentRepository = MarketRepository & {
  initializeRecoveryCursors(provider: string, interval: 'quote', seeds: RecoveryCursorSeed[], updatedAt: string): void;
  recoveryCursor(provider: string, market: Market, interval: 'quote'): string | null;
  commitRecoverySegment(segment: RecoverySegmentCommit): void;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openRepository(): { repo: MarketRepository; database: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-market-repository-'));
  temporaryDirectories.push(directory);
  const database = join(directory, 'market.sqlite');
  return { repo: MarketRepository.open(database), database };
}

function crashConsistentRepository(repo: MarketRepository): CrashConsistentRepository {
  const candidate = repo as Partial<CrashConsistentRepository>;
  assert.equal(typeof candidate.initializeRecoveryCursors, 'function', 'repository must atomically bootstrap recovery cursors');
  assert.equal(typeof candidate.recoveryCursor, 'function', 'repository must expose a durable recovery cursor');
  assert.equal(typeof candidate.commitRecoverySegment, 'function', 'repository must atomically commit recovery segments');
  return repo as CrashConsistentRepository;
}

function quote(overrides: Partial<CanonicalQuote> = {}): CanonicalQuote {
  return {
    symbol: 'sh600000',
    name: '浦发银行',
    market: 'CN',
    currency: 'CNY',
    price: 10.15,
    open: 10,
    high: 10.2,
    low: 9.9,
    previousClose: 9.95,
    volume: 1_000,
    amount: 10_150,
    change: 0.2,
    changePercent: 2.01,
    marketTime: '2026-08-27T10:00:00+08:00',
    fetchedAt: '2026-08-27T02:00:05Z',
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
    timestamp: '2026-08-27T10:00:00+08:00',
    open: 10,
    high: 10.2,
    low: 9.9,
    close: 10.15,
    volume: null,
    turnover: null,
    ...overrides,
  };
}

function sector(overrides: Partial<SectorObservation> = {}): SectorObservation {
  return {
    id: 'new_jrhy',
    name: '金融行业',
    category: 'industry',
    changePercent: 2.1,
    turnover: 200_000_000,
    netFlow: null,
    leaderSymbol: 'sh600000',
    leaderName: '浦发银行',
    leaderChangePercent: 3.2,
    marketTime: null,
    fetchedAt: '2026-08-27T02:01:00Z',
    source: 'sina',
    isDelayed: false,
    isStale: false,
    ...overrides,
  };
}

test('opens schema v3 with the recovery checkpoint table and durable SQLite pragmas', () => {
  const { repo, database } = openRepository();
  repo.close();

  const db = new DatabaseSync(database);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'bars',
    'collection_gaps',
    'maintenance_runs',
    'provider_health',
    'quote_observations',
    'recovery_progress',
    'sector_observations',
  ]);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  db.close();
});

test('writes quote batches atomically, rolls back invalid rows, and makes retries idempotent', () => {
  const { repo } = openRepository();
  const first = quote();
  repo.writeBatch([first]);
  repo.writeBatch([first]);
  assert.deepEqual(repo.latestQuotes(['sh600000']), [first]);

  assert.throws(
    () => repo.writeBatch([
      quote({ symbol: 'sh600001', marketTime: '2026-08-27T10:00:10+08:00' }),
      quote({ symbol: '', marketTime: '2026-08-27T10:00:20+08:00' }),
    ]),
    /symbol/i,
  );
  assert.deepEqual(repo.latestQuotes(['sh600001']), []);
  repo.close();
});

test('commits recovery rows and cursor atomically and makes a restarted segment replay a no-op', () => {
  const { repo: opened, database } = openRepository();
  const repo = crashConsistentRepository(opened);
  const segment: RecoverySegmentCommit = {
    provider: 'tencent',
    market: 'CN',
    interval: 'quote',
    start: '2026-08-27T01:15:00.000Z',
    end: '2026-08-27T01:30:00.000Z',
    completedAt: '2026-08-27T01:40:00.000Z',
    items: [quote({ marketTime: '2026-08-27T09:20:00+08:00', fetchedAt: '2026-08-27T01:40:00.000Z' })],
    gap: null,
  };

  const failingConnection = new DatabaseSync(database);
  failingConnection.exec(`
    CREATE TRIGGER fail_recovery_cursor
    BEFORE INSERT ON recovery_progress
    BEGIN
      SELECT RAISE(ABORT, 'checkpoint failure');
    END;
  `);
  failingConnection.close();

  assert.throws(() => repo.commitRecoverySegment(segment), /checkpoint failure/);
  assert.deepEqual(repo.latestQuotes(['sh600000']), []);
  assert.equal(repo.recoveryCursor('tencent', 'CN', 'quote'), null);

  const recoveryConnection = new DatabaseSync(database);
  recoveryConnection.exec('DROP TRIGGER fail_recovery_cursor');
  recoveryConnection.close();
  repo.commitRecoverySegment(segment);
  repo.commitRecoverySegment({
    ...segment,
    completedAt: '2026-08-27T01:45:00.000Z',
    items: [quote({ marketTime: '2026-08-27T09:20:00+08:00', fetchedAt: '2026-08-27T01:45:00.000Z' })],
  });

  assert.equal(repo.recoveryCursor('tencent', 'CN', 'quote'), segment.end);
  assert.equal(repo.health().counts.quoteObservations, 1);
  assert.equal(repo.latestQuotes(['sh600000'])[0]?.fetchedAt, '2026-08-27T01:40:00.000Z');
  repo.close();

  const restarted = crashConsistentRepository(MarketRepository.open(database));
  assert.equal(restarted.recoveryCursor('tencent', 'CN', 'quote'), segment.end);
  assert.equal(restarted.health().counts.quoteObservations, 1);
  restarted.close();
});

test('bootstraps both market cursors atomically and never overwrites an existing cursor', () => {
  const { repo: opened, database } = openRepository();
  const repo = crashConsistentRepository(opened);
  const anchor = '2026-08-27T01:15:00.000Z';
  const seeds: RecoveryCursorSeed[] = [{ market: 'CN', cursor: anchor }, { market: 'HK', cursor: anchor }];
  const failingConnection = new DatabaseSync(database);
  failingConnection.exec(`
    CREATE TRIGGER fail_hk_recovery_seed
    BEFORE INSERT ON recovery_progress
    WHEN NEW.market = 'HK'
    BEGIN
      SELECT RAISE(ABORT, 'HK seed failure');
    END;
  `);
  failingConnection.close();

  assert.throws(
    () => repo.initializeRecoveryCursors('tencent', 'quote', seeds, '2026-08-27T01:40:00.000Z'),
    /HK seed failure/,
  );
  assert.equal(repo.recoveryCursor('tencent', 'CN', 'quote'), null);
  assert.equal(repo.recoveryCursor('tencent', 'HK', 'quote'), null);

  const recoveryConnection = new DatabaseSync(database);
  recoveryConnection.exec('DROP TRIGGER fail_hk_recovery_seed');
  recoveryConnection.close();
  repo.initializeRecoveryCursors('tencent', 'quote', seeds, '2026-08-27T01:40:00.000Z');
  repo.initializeRecoveryCursors('tencent', 'quote', [
    { market: 'CN', cursor: '2026-08-27T01:50:00.000Z' },
    { market: 'HK', cursor: '2026-08-27T01:50:00.000Z' },
  ], '2026-08-27T01:50:00.000Z');

  assert.equal(repo.recoveryCursor('tencent', 'CN', 'quote'), anchor);
  assert.equal(repo.recoveryCursor('tencent', 'HK', 'quote'), anchor);
  repo.close();
});

test('rejects malformed recovery checkpoint identity, bounds, rows, and gap metadata', () => {
  const { repo: opened } = openRepository();
  const repo = crashConsistentRepository(opened);
  const valid: RecoverySegmentCommit = {
    provider: 'tencent',
    market: 'CN',
    interval: 'quote',
    start: '2026-08-27T01:15:00.000Z',
    end: '2026-08-27T01:30:00.000Z',
    completedAt: '2026-08-27T01:40:00.000Z',
    items: [quote({ marketTime: '2026-08-27T09:20:00+08:00', fetchedAt: '2026-08-27T01:40:00.000Z' })],
    gap: null,
  };

  const seeds: RecoveryCursorSeed[] = [
    { market: 'CN', cursor: valid.start },
    { market: 'HK', cursor: valid.start },
  ];
  assert.throws(() => repo.initializeRecoveryCursors('', 'quote', seeds, valid.completedAt), /provider/i);
  assert.throws(() => repo.initializeRecoveryCursors('tencent', 'minute' as 'quote', seeds, valid.completedAt), /interval/i);
  assert.throws(() => repo.initializeRecoveryCursors('tencent', 'quote', [seeds[0]!, seeds[0]!], valid.completedAt), /CN and HK/i);
  assert.throws(() => repo.initializeRecoveryCursors('tencent', 'quote', [{ market: 'CN', cursor: 'bad' }, seeds[1]!], valid.completedAt), /cursor/i);
  assert.throws(() => repo.initializeRecoveryCursors('tencent', 'quote', seeds, 'bad'), /updatedAt/i);
  assert.throws(() => repo.recoveryCursor('', 'CN', 'quote'), /provider/i);
  assert.throws(() => repo.recoveryCursor('tencent', 'US' as Market, 'quote'), /market/i);
  assert.throws(() => repo.recoveryCursor('tencent', 'CN', 'minute' as 'quote'), /interval/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, provider: '' }), /provider/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, market: 'US' as Market }), /market/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, interval: 'minute' as 'quote' }), /interval/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, start: 'not-a-time' }), /start/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, end: valid.start }), /start.*end/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, completedAt: 'not-a-time' }), /completedAt/i);
  assert.throws(() => repo.commitRecoverySegment({ ...valid, items: [quote({ source: 'sina' })] }), /source.*provider/i);
  assert.throws(() => repo.commitRecoverySegment({
    ...valid,
    gap: {
      market: 'HK',
      symbol: null,
      interval: 'quote',
      start: valid.start,
      end: valid.end,
      reason: 'provider_history_unavailable',
      recordedAt: valid.completedAt,
    },
  }), /gap.*market/i);
  assert.equal(repo.recoveryCursor('tencent', 'CN', 'quote'), null);
  repo.close();
});

test('rejects unsupported or noncanonical symbols at every quote, bar, query, and maintenance boundary', () => {
  const { repo } = openRepository();
  for (const symbol of ['AAPL', 'SH600000']) {
    assert.throws(() => repo.writeBatch([quote({ symbol })]), /symbol/i);
    assert.throws(() => repo.writeBars([bar({ symbol })]), /symbol/i);
    assert.throws(() => repo.latestQuotes([symbol]), /symbol/i);
    assert.throws(() => repo.querySeries({ symbol, interval: 'minute' }), /symbol/i);
    assert.throws(() => repo.runMaintenance((access) => access.deleteRawSymbols('CN', '2026-08-27', [symbol])), /symbol/i);
    assert.throws(() => repo.runMaintenance((access) => access.upsertBars([bar({ symbol })])), /symbol/i);
  }
  assert.deepEqual(repo.health().counts, {
    quoteObservations: 0,
    minuteBars: 0,
    dailyBars: 0,
    sectorObservations: 0,
    sectorDailySummaries: 0,
  });
  repo.close();
});

test('rejects calendar-invalid timestamps before any row in the batch is committed', () => {
  const { repo } = openRepository();
  assert.throws(() => repo.writeBatch([
    quote({ symbol: 'sh600001' }),
    quote({ symbol: 'sh600002', marketTime: '2026-02-30T10:00:00+08:00' }),
  ]), /marketTime/i);
  assert.deepEqual(repo.latestQuotes(['sh600001', 'sh600002']), []);
  repo.close();
});

test('returns deterministic JSON-safe quote and series results through prepared queries', () => {
  const { repo } = openRepository();
  repo.writeBatch([
    quote({ symbol: 'sz000001', name: null, marketTime: '2026-08-27T10:00:10+08:00', price: null, volume: null, amount: null }),
    quote({ marketTime: '2026-08-27T10:00:20+08:00', price: 10.2 }),
  ]);
  repo.writeBars([
    bar({ timestamp: '2026-08-27T10:01:00+08:00', close: 10.2 }),
    bar(),
  ]);

  assert.deepEqual(repo.latestQuotes(['sz000001', 'sh600000']).map(({ symbol }) => symbol), ['sh600000', 'sz000001']);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }).map(({ timestamp }) => timestamp), [
    '2026-08-27T10:00:00+08:00',
    '2026-08-27T10:01:00+08:00',
  ]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({
    quotes: repo.latestQuotes(['sh600000', 'sz000001']),
    series: repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 10 }),
  })));
  repo.close();
});

test('preserves an unpublished market timestamp as null while retaining the observation by fetch date', () => {
  const { repo } = openRepository();
  repo.writeBatch([quote({ marketTime: null })]);
  assert.equal(repo.latestQuotes(['sh600000'])[0]?.marketTime, null);
  repo.close();
});

test('orders observations by their represented instant across different ISO offsets', () => {
  const { repo } = openRepository();
  repo.writeBatch([
    quote({ price: 10, marketTime: '2026-08-27T10:00:00+08:00', fetchedAt: '2026-08-27T02:00:01Z' }),
    quote({ price: 11, marketTime: '2026-08-27T03:00:00Z', fetchedAt: '2026-08-27T03:00:01Z' }),
  ]);
  assert.equal(repo.latestQuotes(['sh600000'])[0]?.price, 11);
  repo.close();
});

test('a bounded series selects newest rows and returns them in chronological order', () => {
  const { repo } = openRepository();
  repo.writeBars([
    bar({ timestamp: '2026-08-27T10:00:00+08:00' }),
    bar({ timestamp: '2026-08-27T10:01:00+08:00' }),
    bar({ timestamp: '2026-08-27T10:02:00+08:00' }),
  ]);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600000', interval: 'minute', limit: 2 }).map(({ timestamp }) => timestamp), [
    '2026-08-27T10:01:00+08:00',
    '2026-08-27T10:02:00+08:00',
  ]);
  repo.close();
});

test('rolls back invalid bar and sector batches and stores at most one sector row per five-minute bucket', () => {
  const { repo } = openRepository();
  assert.throws(() => repo.writeBars([bar({ symbol: 'sh600001' }), bar({ close: Number.NaN })]), /close/i);
  assert.deepEqual(repo.querySeries({ symbol: 'sh600001', interval: 'minute', limit: 10 }), []);

  repo.writeSectors([
    sector(),
    sector({ fetchedAt: '2026-08-27T02:04:59Z', changePercent: 2.2 }),
    sector({ fetchedAt: '2026-08-27T02:05:00Z', changePercent: 2.3 }),
  ]);
  assert.deepEqual(repo.readSectors({ category: 'industry', limit: 10 }).map(({ changePercent }) => changePercent), [2.3, 2.2]);

  assert.throws(() => repo.writeSectors([
    sector({ id: 'valid', fetchedAt: '2026-08-27T02:10:00Z' }),
    sector({ id: '', fetchedAt: '2026-08-27T02:10:00Z' }),
  ]), /id/i);
  assert.equal(repo.readSectors({ category: 'industry', limit: 10 }).some(({ id }) => id === 'valid'), false);
  repo.close();
});

test('records gaps and provider health as JSON-safe idempotent state', () => {
  const { repo } = openRepository();
  repo.recordGap({ market: 'HK', symbol: null, interval: 'minute', start: '2026-08-27T09:30:00+08:00', end: '2026-08-27T09:31:00+08:00', reason: 'provider_unavailable', recordedAt: '2026-08-27T01:32:00Z' });
  repo.recordGap({ market: 'HK', symbol: null, interval: 'minute', start: '2026-08-27T09:30:00+08:00', end: '2026-08-27T09:31:00+08:00', reason: 'provider_unavailable', recordedAt: '2026-08-27T01:32:00Z' });
  repo.updateProviderHealth({ provider: 'tencent', available: false, latencyMs: null, lastAttemptAt: '2026-08-27T01:32:00Z', lastSuccessAt: null, lastFailureAt: '2026-08-27T01:32:00Z', consecutiveFailures: 1, error: 'timeout' });

  const health = repo.health();
  assert.equal(health.gaps.length, 1);
  assert.deepEqual(health.providers[0], { provider: 'tencent', available: false, latencyMs: null, lastAttemptAt: '2026-08-27T01:32:00Z', lastSuccessAt: null, lastFailureAt: '2026-08-27T01:32:00Z', consecutiveFailures: 1, error: 'timeout' });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(health)));
  repo.close();
});

test('public recordGap rejects canonical symbols from the wrong market and accepts null or matching symbols', () => {
  const { repo } = openRepository();
  const base: CollectionGap = {
    market: 'CN',
    symbol: null,
    interval: 'minute',
    start: '2026-08-27T01:00:00Z',
    end: '2026-08-27T01:01:00Z',
    reason: 'market_boundary',
    recordedAt: '2026-08-27T01:02:00Z',
  };
  assert.throws(() => repo.recordGap({ ...base, market: 'CN', symbol: 'hk00700' }), /symbol.*market/i);
  assert.throws(() => repo.recordGap({ ...base, market: 'HK', symbol: 'sh600000' }), /symbol.*market/i);
  assert.doesNotThrow(() => repo.recordGap({ ...base, market: 'CN', symbol: null, reason: 'null_symbol' }));
  assert.doesNotThrow(() => repo.recordGap({ ...base, market: 'CN', symbol: 'sh600000', reason: 'cn_match' }));
  assert.doesNotThrow(() => repo.recordGap({ ...base, market: 'HK', symbol: 'hk00700', reason: 'hk_match' }));
  assert.deepEqual(repo.health().gaps.map(({ market, symbol }) => ({ market, symbol })), [
    { market: 'CN', symbol: null },
    { market: 'CN', symbol: 'sh600000' },
    { market: 'HK', symbol: 'hk00700' },
  ]);
  repo.close();
});

test('maintenance recordGap enforces the same symbol-market boundary', () => {
  const { repo } = openRepository();
  const base: CollectionGap = {
    market: 'CN',
    symbol: null,
    interval: 'minute',
    start: '2026-08-27T01:00:00Z',
    end: '2026-08-27T01:01:00Z',
    reason: 'maintenance_boundary',
    recordedAt: '2026-08-27T01:02:00Z',
  };
  assert.throws(() => repo.runMaintenance((access) => access.recordGap({ ...base, market: 'CN', symbol: 'hk00700' })), /symbol.*market/i);
  assert.throws(() => repo.runMaintenance((access) => access.recordGap({ ...base, market: 'HK', symbol: 'sh600000' })), /symbol.*market/i);
  assert.doesNotThrow(() => repo.runMaintenance((access) => {
    access.recordGap({ ...base, market: 'CN', symbol: null, reason: 'maintenance_null' });
    access.recordGap({ ...base, market: 'CN', symbol: 'sh600000', reason: 'maintenance_cn' });
    access.recordGap({ ...base, market: 'HK', symbol: 'hk00700', reason: 'maintenance_hk' });
  }));
  assert.equal(repo.health().gaps.length, 3);
  repo.close();
});

test('close is idempotent and all operations reject after close', () => {
  const { repo } = openRepository();
  repo.close();
  assert.doesNotThrow(() => repo.close());
  assert.throws(() => repo.latestQuotes(['sh600000']), /closed/i);
});

test('migrates a schema v1 sector table in place and adds only the v3 recovery checkpoint table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-market-repository-v1-'));
  temporaryDirectories.push(directory);
  const database = join(directory, 'market.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE sector_observations (
      id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, change_percent REAL, turnover REAL,
      net_flow REAL, leader_symbol TEXT, leader_name TEXT, leader_change_percent REAL, market_time TEXT,
      fetched_at TEXT NOT NULL, source TEXT NOT NULL, is_delayed INTEGER NOT NULL, is_stale INTEGER NOT NULL,
      bucket_time TEXT NOT NULL, PRIMARY KEY (category, id, source, bucket_time)
    ) WITHOUT ROWID;
    INSERT INTO sector_observations VALUES ('legacy', 'Legacy', 'industry', 1, 10, NULL, NULL, NULL, NULL, NULL, '2026-08-27T02:00:00Z', 'sina', 0, 0, '2026-08-27T02:00:00Z');
    PRAGMA user_version=1;
  `);
  legacy.close();

  const repo = MarketRepository.open(database);
  assert.equal(repo.readSectors({ resolution: 'intraday', limit: 10 })[0]?.id, 'legacy');
  repo.close();
  const migrated = new DatabaseSync(database);
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(migrated.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.count, 7);
  migrated.close();
});

test('migrates a schema v2 database without changing existing market observations', () => {
  const { repo, database } = openRepository();
  const existing = quote();
  repo.writeBatch([existing]);
  repo.close();
  const versionTwo = new DatabaseSync(database);
  versionTwo.exec('DROP TABLE recovery_progress; PRAGMA user_version=2;');
  versionTwo.close();

  const migrated = MarketRepository.open(database);
  assert.deepEqual(migrated.latestQuotes(['sh600000']), [existing]);
  assert.equal(migrated.recoveryCursor('tencent', 'CN', 'quote'), null);
  migrated.close();

  const verified = new DatabaseSync(database);
  assert.equal(verified.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(verified.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='recovery_progress'").get()?.count, 1);
  verified.close();
});

test('same-bucket sector writes retain the newest represented observation independent of completion order', () => {
  const olderCompletion = sector({ marketTime: '2026-08-27T10:01:00+08:00', fetchedAt: '2026-08-27T03:00:00Z', changePercent: 1 });
  const newerMarket = sector({ marketTime: '2026-08-27T10:04:00+08:00', fetchedAt: '2026-08-27T02:05:00Z', changePercent: 2 });
  const tiedLower = sector({ marketTime: null, fetchedAt: '2026-08-27T02:03:00Z', changePercent: 2 });
  const tiedHigher = sector({ marketTime: null, fetchedAt: '2026-08-27T02:03:00Z', changePercent: 3 });
  const left = openRepository().repo;
  const right = openRepository().repo;
  const tieLeft = openRepository().repo;
  const tieRight = openRepository().repo;
  left.writeSectors([newerMarket, olderCompletion, tiedLower, tiedHigher]);
  right.writeSectors([olderCompletion, newerMarket, tiedHigher, tiedLower]);
  tieLeft.writeSectors([tiedLower, tiedHigher]);
  tieRight.writeSectors([tiedHigher, tiedLower]);
  assert.deepEqual(left.readSectors({ limit: 10 }).map(({ changePercent }) => changePercent), [2]);
  assert.deepEqual(right.readSectors({ limit: 10 }).map(({ changePercent }) => changePercent), [2]);
  assert.deepEqual(tieLeft.readSectors({ limit: 10 }).map(({ changePercent }) => changePercent), [3]);
  assert.deepEqual(tieRight.readSectors({ limit: 10 }).map(({ changePercent }) => changePercent), [3]);
  left.close();
  right.close();
  tieLeft.close();
  tieRight.close();
});

test('maintenance result validation rejects lossy and non-plain JSON before serialization', () => {
  const values: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date('2026-08-27T00:00:00Z')];
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  values.push(cyclic);
  for (const value of values) {
    const { repo } = openRepository();
    assert.throws(() => repo.runMaintenance((access) => access.recordMaintenance({
      runAt: '2026-08-27T00:00:00Z',
      completedAt: '2026-08-27T00:00:00Z',
      result: { value },
    })), /JSON|cyclic|finite/i);
    assert.equal(repo.health().lastMaintenance, null);
    repo.close();
  }
});

test('maintenance result root must be a plain object and rejection preserves readable prior health', () => {
  const invalidRoots: unknown[] = [[], null, new (class MaintenancePayload { readonly value = 1; })()];
  for (const result of invalidRoots) {
    const { repo } = openRepository();
    repo.runMaintenance((access) => access.recordMaintenance({
      runAt: '2026-08-27T00:00:00Z',
      completedAt: '2026-08-27T00:00:00Z',
      result: { id: 'prior' },
    }));
    assert.throws(() => repo.runMaintenance((access) => access.recordMaintenance({
      runAt: '2026-08-27T00:01:00Z',
      completedAt: '2026-08-27T00:01:00Z',
      result: result as Record<string, unknown>,
    })), /plain JSON object/i);
    assert.equal(repo.health().lastMaintenance?.id, 'prior');
    repo.close();
  }
});

test('health orders gaps and maintenance runs by represented instant', () => {
  const { repo } = openRepository();
  repo.recordGap({ market: 'CN', symbol: 'sh600000', interval: 'minute', start: '2026-08-27T01:00:00Z', end: '2026-08-27T01:01:00Z', reason: 'lexically_later', recordedAt: '2026-08-27T10:00:00+08:00' });
  repo.recordGap({ market: 'CN', symbol: 'sh600000', interval: 'minute', start: '2026-08-27T02:00:00Z', end: '2026-08-27T02:01:00Z', reason: 'actually_later', recordedAt: '2026-08-27T03:00:00Z' });
  repo.runMaintenance((access) => access.recordMaintenance({ runAt: '2026-08-27T10:00:00+08:00', completedAt: '2026-08-27T10:00:00+08:00', result: { id: 'lexically_later' } }));
  repo.runMaintenance((access) => access.recordMaintenance({ runAt: '2026-08-27T03:00:00Z', completedAt: '2026-08-27T03:00:00Z', result: { id: 'actually_later' } }));
  assert.deepEqual(repo.health().gaps.map(({ reason }) => reason), ['actually_later', 'lexically_later']);
  assert.equal(repo.health().lastMaintenance?.id, 'actually_later');
  repo.close();
});

test('rejects malformed local symbols, ranges, and negative provider latency', () => {
  const { repo } = openRepository();
  assert.throws(() => repo.latestQuotes(["sh600000') OR 1=1 --"]), /symbol/i);
  assert.throws(() => repo.recordGap({ market: 'CN', symbol: 'AAPL', interval: 'minute', start: '2026-08-27T01:00:00Z', end: '2026-08-27T01:01:00Z', reason: 'invalid', recordedAt: '2026-08-27T01:02:00Z' }), /symbol/i);
  assert.throws(() => repo.recordGap({ market: 'CN', symbol: null, interval: 'minute', start: '2026-08-27T01:01:00Z', end: '2026-08-27T01:00:00Z', reason: 'invalid', recordedAt: '2026-08-27T01:02:00Z' }), /start.*end/i);
  assert.throws(() => repo.querySeries({ symbol: 'sh600000', interval: 'minute', start: '2026-08-27T01:01:00Z', end: '2026-08-27T01:00:00Z' }), /start.*end/i);
  assert.throws(() => repo.updateProviderHealth({ provider: 'tencent', available: true, latencyMs: -1, lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, error: null }), /latency/i);
  repo.close();
});
