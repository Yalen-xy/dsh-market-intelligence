import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { shanghaiDate } from './calendar.js';
import type { Bar, CanonicalQuote, Market, SectorObservation } from './model.js';
import { canonicalizeSymbol } from './symbols.js';

export type SeriesQuery = {
  symbol: string;
  interval: string;
  start?: string;
  end?: string;
  limit?: number;
};

export type SectorQuery = {
  category?: string;
  resolution?: SectorResolution;
  limit?: number;
};

export type SectorResolution = 'intraday' | 'daily';

export type CollectionGap = {
  market: Market;
  symbol: string | null;
  interval: string;
  start: string;
  end: string;
  reason: string;
  recordedAt: string;
};

export type RecoverySegmentCommit = {
  provider: string;
  market: Market;
  interval: 'quote';
  start: string;
  end: string;
  completedAt: string;
  items: CanonicalQuote[];
  gap: CollectionGap | null;
};

export type RecoveryCursorSeed = {
  market: Market;
  cursor: string;
};

export type ProviderHealthUpdate = {
  provider: string;
  available: boolean;
  latencyMs: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  error: string | null;
};

export type MaintenanceRecord = {
  runAt: string;
  completedAt: string;
  result: Record<string, unknown>;
};

export type RepositoryCounts = {
  quoteObservations: number;
  minuteBars: number;
  dailyBars: number;
  sectorObservations: number;
  sectorDailySummaries: number;
};

export type RepositoryHealth = {
  databaseBytes: number;
  liveDatabaseBytes: number;
  providers: ProviderHealthUpdate[];
  gaps: CollectionGap[];
  lastMaintenance: Record<string, unknown> | null;
  counts: RepositoryCounts;
};

export type RepositoryMaintenanceAccess = {
  rawTradingDates(market: Market): string[];
  rawQuotes(market: Market, tradingDate: string): CanonicalQuote[];
  upsertBars(bars: Bar[]): void;
  deleteRawSymbols(market: Market, tradingDate: string, symbols: string[]): number;
  recordGap(gap: CollectionGap): void;
  sectorIntradayDates(): string[];
  sectorIntraday(tradingDate: string): SectorObservation[];
  upsertSectors(sectors: SectorObservation[], resolution: SectorResolution): number;
  minuteTradingDates(market?: Market): string[];
  deleteMinuteDate(tradingDate: string, market?: Market): number;
  oldestMinuteTradingDate(): string | null;
  oldestSectorBucket(): string | null;
  deleteSectorBucket(bucket: string): number;
  liveDatabaseBytes(): number;
  attemptMutation<T>(operation: () => T, accept: (value: T) => boolean): { committed: boolean; value: T };
  recordMaintenance(record: MaintenanceRecord): void;
};

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_INTERVALS = new Set(['minute', 'day', 'week', 'month']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quote_observations (
  symbol TEXT NOT NULL,
  name TEXT,
  market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
  currency TEXT NOT NULL CHECK (currency IN ('CNY', 'HKD')),
  price REAL,
  open REAL,
  high REAL,
  low REAL,
  previous_close REAL,
  volume REAL,
  amount REAL,
  change_value REAL,
  change_percent REAL,
  market_time TEXT,
  observation_time TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  is_delayed INTEGER NOT NULL CHECK (is_delayed IN (0, 1)),
  is_stale INTEGER NOT NULL CHECK (is_stale IN (0, 1)),
  PRIMARY KEY (symbol, source, observation_time, fetched_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS quote_observations_latest
  ON quote_observations (symbol, observation_time DESC, fetched_at DESC, source);
CREATE INDEX IF NOT EXISTS quote_observations_retention
  ON quote_observations (market, trading_date, observation_time, symbol, source);

CREATE TABLE IF NOT EXISTS bars (
  symbol TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
  interval TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  turnover REAL,
  PRIMARY KEY (symbol, interval, timestamp)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sector_observations (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  change_percent REAL,
  turnover REAL,
  net_flow REAL,
  leader_symbol TEXT,
  leader_name TEXT,
  leader_change_percent REAL,
  market_time TEXT,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  is_delayed INTEGER NOT NULL CHECK (is_delayed IN (0, 1)),
  is_stale INTEGER NOT NULL CHECK (is_stale IN (0, 1)),
  bucket_time TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('intraday', 'daily')),
  represented_time TEXT NOT NULL,
  tie_breaker TEXT NOT NULL,
  PRIMARY KEY (category, id, source, bucket_time)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS collection_gaps (
  market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, interval, start_time, end_time, reason)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  latency_ms REAL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL,
  error TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS maintenance_runs (
  run_at TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
) WITHOUT ROWID;
`;

const RECOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS recovery_progress (
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
  interval TEXT NOT NULL CHECK (interval = 'quote'),
  cursor_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, market, interval)
) WITHOUT ROWID;
`;

const SECTOR_RETENTION_INDEX = `
CREATE INDEX IF NOT EXISTS sector_observations_retention
  ON sector_observations (resolution, bucket_time, category, id, source);
`;

const BAR_RETENTION_INDEX = `
CREATE INDEX IF NOT EXISTS bars_retention
  ON bars (interval, market, trading_date, timestamp, symbol);
`;

export class MarketRepository {
  readonly path: string;
  private readonly database: DatabaseSync;
  private closed = false;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.database = database;
  }

  static open(path: string): MarketRepository {
    if (typeof path !== 'string' || path.trim() === '') throw new Error('database path must be a non-empty string');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA journal_mode=WAL');
      database.exec('PRAGMA foreign_keys=ON');
      database.exec('PRAGMA busy_timeout=5000');
      const version = numberColumn(database.prepare('PRAGMA user_version').get(), 'user_version');
      if (version > 3) throw new Error(`unsupported database schema version ${version}`);
      if (version === 0) {
        database.exec(SCHEMA);
        database.exec(RECOVERY_SCHEMA);
        database.exec(BAR_RETENTION_INDEX);
        database.exec(SECTOR_RETENTION_INDEX);
        database.exec('PRAGMA user_version=3');
      } else if (version === 1) {
        migrateSchemaV1ToV2(database);
        migrateSchemaV2ToV3(database);
      } else if (version === 2) {
        migrateSchemaV2ToV3(database);
      } else {
        database.exec(SCHEMA);
        database.exec(RECOVERY_SCHEMA);
        database.exec(BAR_RETENTION_INDEX);
        database.exec(SECTOR_RETENTION_INDEX);
        assertSectorSchemaV2(database);
        assertBarSchemaV2(database);
        assertRecoverySchemaV3(database);
      }
      return new MarketRepository(path, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  writeBatch(quotes: CanonicalQuote[]): void {
    this.assertOpen();
    assertDenseArray(quotes, 'quotes');
    for (const quote of quotes) validateQuote(quote);
    if (quotes.length === 0) return;
    this.transaction(() => this.insertQuotes(quotes));
  }

  initializeRecoveryCursors(provider: string, interval: 'quote', seeds: RecoveryCursorSeed[], updatedAt: string): void {
    this.assertOpen();
    validateRecoveryIdentity(provider, 'CN', interval);
    assertDenseArray(seeds, 'recovery cursor seeds');
    if (seeds.length !== 2) throw new Error('recovery cursor seeds must contain CN and HK exactly once');
    requireTimestamp(updatedAt, 'recovery cursor updatedAt');
    for (const seed of seeds) {
      if (!seed || typeof seed !== 'object') throw new Error('recovery cursor seed must be an object');
      validateMarket(seed.market);
      requireTimestamp(seed.cursor, 'recovery seed cursor');
      if (Date.parse(seed.cursor) > Date.parse(updatedAt)) throw new Error('recovery seed cursor must not follow updatedAt');
    }
    if (new Set(seeds.map(({ market }) => market)).size !== 2) {
      throw new Error('recovery cursor seeds must contain CN and HK exactly once');
    }
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO recovery_progress (provider, market, interval, cursor_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (provider, market, interval) DO NOTHING
      `);
      for (const seed of seeds) insert.run(provider, seed.market, interval, seed.cursor, updatedAt);
    });
  }

  recoveryCursor(provider: string, market: Market, interval: 'quote'): string | null {
    this.assertOpen();
    validateRecoveryIdentity(provider, market, interval);
    const row = this.database.prepare(`
      SELECT cursor_at FROM recovery_progress
      WHERE provider = ? AND market = ? AND interval = ?
    `).get(provider, market, interval);
    if (row === undefined) return null;
    const cursor = stringColumn(row, 'cursor_at');
    requireTimestamp(cursor, 'recovery cursor');
    return cursor;
  }

  commitRecoverySegment(segment: RecoverySegmentCommit): void {
    this.assertOpen();
    validateRecoverySegment(segment);
    this.transaction(() => {
      const row = this.database.prepare(`
        SELECT cursor_at FROM recovery_progress
        WHERE provider = ? AND market = ? AND interval = ?
      `).get(segment.provider, segment.market, segment.interval);
      if (row !== undefined) {
        const cursor = stringColumn(row, 'cursor_at');
        requireTimestamp(cursor, 'recovery cursor');
        if (Date.parse(segment.end) <= Date.parse(cursor)) return;
        if (Date.parse(segment.start) < Date.parse(cursor)) {
          throw new Error('recovery segment start must not precede the durable cursor');
        }
      }
      if (segment.items.length > 0) this.insertQuotes(segment.items);
      if (segment.gap !== null) this.recordGap(segment.gap);
      this.database.prepare(`
        INSERT INTO recovery_progress (provider, market, interval, cursor_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (provider, market, interval) DO UPDATE SET
          cursor_at = excluded.cursor_at,
          updated_at = excluded.updated_at
      `).run(segment.provider, segment.market, segment.interval, segment.end, segment.completedAt);
    });
  }

  latestQuotes(symbols: string[]): CanonicalQuote[] {
    this.assertOpen();
    assertDenseArray(symbols, 'symbols');
    const unique = [...new Set(symbols.map((symbol) => validatedCanonicalSymbol(symbol, 'quote symbol')))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY julianday(observation_time) DESC, julianday(fetched_at) DESC, source ASC) AS rank
        FROM quote_observations WHERE symbol IN (${placeholders})
      ) WHERE rank = 1 ORDER BY symbol ASC
    `).all(...unique);
    return rows.map(rowToQuote);
  }

  writeBars(bars: Bar[]): void {
    this.assertOpen();
    assertDenseArray(bars, 'bars');
    for (const item of bars) validateBar(item);
    if (bars.length === 0) return;
    this.transaction(() => this.insertBars(bars));
  }

  querySeries(query: SeriesQuery): Bar[] {
    this.assertOpen();
    const symbol = validatedCanonicalSymbol(query?.symbol, 'symbol');
    requireString(query?.interval, 'interval');
    if (!ALLOWED_INTERVALS.has(query.interval)) throw new Error('interval is unsupported');
    if (query.start !== undefined) requireTimestamp(query.start, 'start');
    if (query.end !== undefined) requireTimestamp(query.end, 'end');
    if (query.start !== undefined && query.end !== undefined && Date.parse(query.start) >= Date.parse(query.end)) throw new Error('series start must be before end');
    const limit = validateLimit(query.limit ?? 500);
    const clauses = ['symbol = ?', 'interval = ?'];
    const values: Array<string | number> = [symbol, query.interval];
    if (query.start !== undefined) {
      clauses.push('julianday(timestamp) >= julianday(?)');
      values.push(query.start);
    }
    if (query.end !== undefined) {
      clauses.push('julianday(timestamp) < julianday(?)');
      values.push(query.end);
    }
    values.push(limit);
    return this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM bars WHERE ${clauses.join(' AND ')}
        ORDER BY julianday(timestamp) DESC, timestamp DESC, symbol ASC LIMIT ?
      ) ORDER BY julianday(timestamp) ASC, timestamp ASC, symbol ASC
    `)
      .all(...values).map(rowToBar);
  }

  writeSectors(sectors: SectorObservation[], resolution: SectorResolution = 'intraday'): void {
    this.assertOpen();
    validateSectorResolution(resolution);
    assertDenseArray(sectors, 'sectors');
    for (const sector of sectors) validateSector(sector);
    if (sectors.length === 0) return;
    this.transaction(() => this.insertSectors(sectors, resolution));
  }

  readSectors(query: SectorQuery = {}): SectorObservation[] {
    this.assertOpen();
    if (query.category !== undefined) requireString(query.category, 'category');
    if (query.resolution !== undefined) validateSectorResolution(query.resolution);
    const limit = validateLimit(query.limit ?? 500);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.category !== undefined) {
      clauses.push('category = ?');
      values.push(query.category);
    }
    if (query.resolution !== undefined) {
      clauses.push('resolution = ?');
      values.push(query.resolution);
    }
    values.push(limit);
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    return this.database.prepare(`SELECT * FROM sector_observations ${where} ORDER BY julianday(represented_time) DESC, represented_time DESC, category ASC, id ASC, source ASC LIMIT ?`)
      .all(...values).map(rowToSector);
  }

  rawTradingDates(market: Market): string[] {
    this.assertOpen();
    return this.listRawTradingDates(market);
  }

  recordGap(gap: CollectionGap): void {
    this.assertOpen();
    validateGap(gap);
    this.database.prepare(`
      INSERT INTO collection_gaps (market, symbol, interval, start_time, end_time, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (market, symbol, interval, start_time, end_time, reason)
      DO UPDATE SET recorded_at = excluded.recorded_at
    `).run(gap.market, gap.symbol ?? '', gap.interval, gap.start, gap.end, gap.reason, gap.recordedAt);
  }

  updateProviderHealth(update: ProviderHealthUpdate): void {
    this.assertOpen();
    validateProviderHealth(update);
    this.database.prepare(`
      INSERT INTO provider_health (
        provider, available, latency_ms, last_attempt_at, last_success_at, last_failure_at, consecutive_failures, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider) DO UPDATE SET
        available = excluded.available,
        latency_ms = excluded.latency_ms,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        consecutive_failures = excluded.consecutive_failures,
        error = excluded.error
    `).run(
      update.provider,
      update.available ? 1 : 0,
      update.latencyMs,
      update.lastAttemptAt,
      update.lastSuccessAt,
      update.lastFailureAt,
      update.consecutiveFailures,
      update.error === null ? null : sanitizeError(update.error),
    );
  }

  health(): RepositoryHealth {
    this.assertOpen();
    const providers = this.database.prepare('SELECT * FROM provider_health ORDER BY provider ASC').all().map(rowToProviderHealth);
    const gaps = this.database.prepare('SELECT * FROM collection_gaps ORDER BY julianday(recorded_at) DESC, recorded_at DESC, market ASC, symbol ASC, interval ASC, reason ASC').all().map(rowToGap);
    const maintenance = this.database.prepare('SELECT result_json FROM maintenance_runs ORDER BY julianday(run_at) DESC, run_at DESC LIMIT 1').get();
    return {
      databaseBytes: this.databaseBytes(),
      liveDatabaseBytes: this.liveDatabaseBytes(),
      providers,
      gaps,
      lastMaintenance: maintenance ? parseJsonObject(stringColumn(maintenance, 'result_json')) : null,
      counts: this.counts(),
    };
  }

  runMaintenance<T>(operation: (access: RepositoryMaintenanceAccess) => T): T {
    this.assertOpen();
    if (typeof operation !== 'function') throw new Error('maintenance operation must be a function');
    return this.transaction(() => operation({
      rawTradingDates: (market) => this.listRawTradingDates(market),
      rawQuotes: (market, tradingDate) => this.rawQuotes(market, tradingDate),
      upsertBars: (bars) => {
        assertDenseArray(bars, 'bars');
        for (const item of bars) validateBar(item);
        this.insertBars(bars);
      },
      deleteRawSymbols: (market, tradingDate, symbols) => this.deleteRawSymbols(market, tradingDate, symbols),
      recordGap: (gap) => this.recordGap(gap),
      sectorIntradayDates: () => this.sectorIntradayDates(),
      sectorIntraday: (tradingDate) => this.sectorIntraday(tradingDate),
      upsertSectors: (sectors, resolution) => {
        validateSectorResolution(resolution);
        assertDenseArray(sectors, 'sectors');
        for (const sector of sectors) validateSector(sector);
        return this.insertSectors(sectors, resolution);
      },
      minuteTradingDates: (market) => this.minuteTradingDates(market),
      deleteMinuteDate: (tradingDate, market) => this.deleteMinuteDate(tradingDate, market),
      oldestMinuteTradingDate: () => this.oldestMinuteTradingDate(),
      oldestSectorBucket: () => this.oldestSectorBucket(),
      deleteSectorBucket: (bucket) => this.deleteSectorBucket(bucket),
      liveDatabaseBytes: () => this.liveDatabaseBytes(),
      attemptMutation: (mutation, accept) => this.attemptMutation(mutation, accept),
      recordMaintenance: (record) => this.recordMaintenance(record),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private insertQuotes(quotes: CanonicalQuote[]): void {
    const statement = this.database.prepare(`
      INSERT INTO quote_observations (
        symbol, name, market, currency, price, open, high, low, previous_close, volume, amount,
        change_value, change_percent, market_time, observation_time, trading_date, fetched_at, source, is_delayed, is_stale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (symbol, source, observation_time, fetched_at) DO UPDATE SET
        name = excluded.name, market = excluded.market, currency = excluded.currency, price = excluded.price,
        open = excluded.open, high = excluded.high, low = excluded.low, previous_close = excluded.previous_close,
        volume = excluded.volume, amount = excluded.amount, change_value = excluded.change_value,
        change_percent = excluded.change_percent, is_delayed = excluded.is_delayed, is_stale = excluded.is_stale
    `);
    for (const quote of quotes) {
      statement.run(
        quote.symbol, quote.name, quote.market, quote.currency, quote.price, quote.open, quote.high, quote.low,
        quote.previousClose, quote.volume, quote.amount, quote.change, quote.changePercent, quote.marketTime,
        quote.marketTime ?? quote.fetchedAt, shanghaiDate(quote.marketTime ?? quote.fetchedAt), quote.fetchedAt,
        quote.source, quote.isDelayed ? 1 : 0, quote.isStale ? 1 : 0,
      );
    }
  }

  private insertBars(bars: Bar[]): void {
    const statement = this.database.prepare(`
      INSERT INTO bars (symbol, market, interval, timestamp, trading_date, open, high, low, close, volume, turnover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (symbol, interval, timestamp) DO UPDATE SET
        market = excluded.market, trading_date = excluded.trading_date, open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume, turnover = excluded.turnover
    `);
    for (const bar of bars) statement.run(bar.symbol, bar.market, bar.interval, bar.timestamp, shanghaiDate(bar.timestamp), bar.open, bar.high, bar.low, bar.close, bar.volume, bar.turnover);
  }

  private insertSectors(sectors: SectorObservation[], resolution: SectorResolution): number {
    const statement = this.database.prepare(`
      INSERT INTO sector_observations (
        id, name, category, change_percent, turnover, net_flow, leader_symbol, leader_name,
        leader_change_percent, market_time, fetched_at, source, is_delayed, is_stale, bucket_time,
        resolution, represented_time, tie_breaker
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (category, id, source, bucket_time) DO UPDATE SET
        name = excluded.name, change_percent = excluded.change_percent, turnover = excluded.turnover,
        net_flow = excluded.net_flow, leader_symbol = excluded.leader_symbol, leader_name = excluded.leader_name,
        leader_change_percent = excluded.leader_change_percent, market_time = excluded.market_time,
        fetched_at = excluded.fetched_at, is_delayed = excluded.is_delayed, is_stale = excluded.is_stale,
        resolution = excluded.resolution, represented_time = excluded.represented_time, tie_breaker = excluded.tie_breaker
      WHERE julianday(excluded.represented_time) > julianday(sector_observations.represented_time)
        OR (
          julianday(excluded.represented_time) = julianday(sector_observations.represented_time)
          AND excluded.tie_breaker > sector_observations.tie_breaker
        )
    `);
    let changed = 0;
    for (const sector of sectors) {
      const representedTime = sector.marketTime ?? sector.fetchedAt;
      changed += changeCount(statement.run(
        sector.id, sector.name, sector.category, sector.changePercent, sector.turnover, sector.netFlow,
        sector.leaderSymbol, sector.leaderName, sector.leaderChangePercent, sector.marketTime, sector.fetchedAt,
        sector.source, sector.isDelayed ? 1 : 0, sector.isStale ? 1 : 0, sectorBucket(representedTime, resolution),
        resolution, representedTime, sectorTieBreaker(sector),
      ));
    }
    return changed;
  }

  private listRawTradingDates(market: Market): string[] {
    validateMarket(market);
    return this.database.prepare('SELECT DISTINCT trading_date FROM quote_observations WHERE market = ? ORDER BY trading_date ASC')
      .all(market).map((row) => stringColumn(row, 'trading_date'));
  }

  private rawQuotes(market: Market, tradingDate: string): CanonicalQuote[] {
    validateMarket(market);
    requireTradingDate(tradingDate);
    return this.database.prepare(`
      SELECT * FROM quote_observations
      WHERE market = ? AND trading_date = ?
      ORDER BY symbol ASC, julianday(observation_time) ASC, julianday(fetched_at) ASC, source ASC
    `).all(market, tradingDate).map(rowToQuote);
  }

  private deleteRawSymbols(market: Market, tradingDate: string, symbols: string[]): number {
    validateMarket(market);
    requireTradingDate(tradingDate);
    assertDenseArray(symbols, 'raw symbols');
    const unique = [...new Set(symbols.map((symbol) => validatedCanonicalSymbol(symbol, 'raw symbol', market)))];
    if (unique.length === 0) return 0;
    const placeholders = unique.map(() => '?').join(', ');
    return changeCount(this.database.prepare(`DELETE FROM quote_observations WHERE market = ? AND trading_date = ? AND symbol IN (${placeholders})`)
      .run(market, tradingDate, ...unique));
  }

  private sectorIntradayDates(): string[] {
    const dates = this.database.prepare("SELECT represented_time FROM sector_observations WHERE resolution = 'intraday' ORDER BY julianday(represented_time) ASC, represented_time ASC")
      .all().map((row) => shanghaiDate(stringColumn(row, 'represented_time')));
    return [...new Set(dates)].sort();
  }

  private sectorIntraday(tradingDate: string): SectorObservation[] {
    requireTradingDate(tradingDate);
    return this.database.prepare(`
      SELECT * FROM sector_observations
      WHERE resolution = 'intraday'
      ORDER BY category ASC, id ASC, source ASC, julianday(represented_time) ASC, represented_time ASC, tie_breaker ASC
    `).all().filter((row) => shanghaiDate(stringColumn(row, 'represented_time')) === tradingDate).map(rowToSector);
  }

  private minuteTradingDates(market?: Market): string[] {
    if (market !== undefined) validateMarket(market);
    const rows = market === undefined
      ? this.database.prepare("SELECT DISTINCT trading_date FROM bars WHERE interval = 'minute' ORDER BY trading_date ASC").all()
      : this.database.prepare("SELECT DISTINCT trading_date FROM bars WHERE interval = 'minute' AND market = ? ORDER BY trading_date ASC").all(market);
    return rows.map((row) => stringColumn(row, 'trading_date'));
  }

  private deleteMinuteDate(tradingDate: string, market?: Market): number {
    requireTradingDate(tradingDate);
    if (market !== undefined) validateMarket(market);
    const result = market === undefined
      ? this.database.prepare("DELETE FROM bars WHERE interval = 'minute' AND trading_date = ?").run(tradingDate)
      : this.database.prepare("DELETE FROM bars WHERE interval = 'minute' AND market = ? AND trading_date = ?").run(market, tradingDate);
    return changeCount(result);
  }

  private oldestMinuteTradingDate(): string | null {
    const row = this.database.prepare("SELECT min(trading_date) AS trading_date FROM bars WHERE interval = 'minute'").get();
    return nullableStringColumn(row, 'trading_date');
  }

  private oldestSectorBucket(): string | null {
    const row = this.database.prepare("SELECT min(bucket_time) AS bucket_time FROM sector_observations WHERE resolution = 'intraday'").get();
    return nullableStringColumn(row, 'bucket_time');
  }

  private deleteSectorBucket(bucket: string): number {
    requireTimestamp(bucket, 'sector bucket');
    return changeCount(this.database.prepare("DELETE FROM sector_observations WHERE resolution = 'intraday' AND bucket_time = ?").run(bucket));
  }

  private recordMaintenance(record: MaintenanceRecord): void {
    requireTimestamp(record.runAt, 'maintenance runAt');
    requireTimestamp(record.completedAt, 'maintenance completedAt');
    if (record.result === null || Array.isArray(record.result) || typeof record.result !== 'object' || Object.getPrototypeOf(record.result) !== Object.prototype) {
      throw new Error('maintenance result must be a plain JSON object');
    }
    assertJsonSafe(record.result, 'maintenance result');
    const result = JSON.stringify(record.result);
    if (result === undefined) throw new Error('maintenance result must be lossless JSON');
    this.database.prepare(`
      INSERT INTO maintenance_runs (run_at, completed_at, result_json) VALUES (?, ?, ?)
      ON CONFLICT (run_at) DO UPDATE SET completed_at = excluded.completed_at, result_json = excluded.result_json
    `).run(record.runAt, record.completedAt, result);
  }

  private counts(): RepositoryCounts {
    return {
      quoteObservations: scalarCount(this.database, 'SELECT count(*) AS count FROM quote_observations'),
      minuteBars: scalarCount(this.database, "SELECT count(*) AS count FROM bars WHERE interval = 'minute'"),
      dailyBars: scalarCount(this.database, "SELECT count(*) AS count FROM bars WHERE interval = 'day'"),
      sectorObservations: scalarCount(this.database, 'SELECT count(*) AS count FROM sector_observations'),
      sectorDailySummaries: scalarCount(this.database, "SELECT count(*) AS count FROM sector_observations WHERE resolution = 'daily'"),
    };
  }

  private liveDatabaseBytes(): number {
    const pageCount = numberColumn(this.database.prepare('PRAGMA page_count').get(), 'page_count');
    const freePages = numberColumn(this.database.prepare('PRAGMA freelist_count').get(), 'freelist_count');
    const pageSize = numberColumn(this.database.prepare('PRAGMA page_size').get(), 'page_size');
    const livePages = Math.max(0, pageCount - freePages);
    const bytes = livePages * pageSize;
    if (!Number.isSafeInteger(bytes)) throw new Error('live database size exceeds JSON-safe range');
    return bytes;
  }

  private databaseBytes(): number {
    if (this.path === ':memory:') return 0;
    let bytes = fileBytes(this.path);
    bytes += fileBytes(`${this.path}-wal`);
    bytes += fileBytes(`${this.path}-shm`);
    return bytes;
  }

  private attemptMutation<T>(operation: () => T, accept: (value: T) => boolean): { committed: boolean; value: T } {
    if (typeof operation !== 'function' || typeof accept !== 'function') throw new Error('maintenance mutation requires operation and accept functions');
    this.database.exec('SAVEPOINT maintenance_candidate');
    try {
      const value = operation();
      if (!accept(value)) {
        this.database.exec('ROLLBACK TO maintenance_candidate');
        this.database.exec('RELEASE maintenance_candidate');
        return { committed: false, value };
      }
      this.database.exec('RELEASE maintenance_candidate');
      return { committed: true, value };
    } catch (error) {
      try {
        this.database.exec('ROLLBACK TO maintenance_candidate');
        this.database.exec('RELEASE maintenance_candidate');
      } catch {
        // Preserve the mutation error; the outer transaction will roll back if needed.
      }
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error; SQLite may already have rolled back a fatal transaction.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('market repository is closed');
  }
}

function migrateSchemaV1ToV2(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(SCHEMA);
    const columns = sectorColumnNames(database);
    if (!columns.has('resolution')) database.exec("ALTER TABLE sector_observations ADD COLUMN resolution TEXT NOT NULL DEFAULT 'intraday' CHECK (resolution IN ('intraday', 'daily'))");
    if (!columns.has('represented_time')) database.exec("ALTER TABLE sector_observations ADD COLUMN represented_time TEXT NOT NULL DEFAULT ''");
    if (!columns.has('tie_breaker')) database.exec("ALTER TABLE sector_observations ADD COLUMN tie_breaker TEXT NOT NULL DEFAULT ''");
    database.exec("UPDATE sector_observations SET represented_time = coalesce(market_time, fetched_at) WHERE represented_time = ''");
    const barColumns = barColumnNames(database);
    if (!barColumns.has('trading_date')) database.exec("ALTER TABLE bars ADD COLUMN trading_date TEXT NOT NULL DEFAULT ''");
    const rows = database.prepare("SELECT symbol, interval, timestamp FROM bars WHERE trading_date = ''").all();
    const updateBarDate = database.prepare('UPDATE bars SET trading_date = ? WHERE symbol = ? AND interval = ? AND timestamp = ?');
    for (const row of rows) {
      const timestamp = stringColumn(row, 'timestamp');
      updateBarDate.run(shanghaiDate(timestamp), stringColumn(row, 'symbol'), stringColumn(row, 'interval'), timestamp);
    }
    database.exec('DROP INDEX IF EXISTS bars_retention');
    database.exec(BAR_RETENTION_INDEX);
    database.exec('DROP INDEX IF EXISTS sector_observations_retention');
    database.exec(SECTOR_RETENTION_INDEX);
    assertSectorSchemaV2(database);
    assertBarSchemaV2(database);
    database.exec('PRAGMA user_version=2');
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  }
}

function migrateSchemaV2ToV3(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(RECOVERY_SCHEMA);
    assertRecoverySchemaV3(database);
    database.exec('PRAGMA user_version=3');
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  }
}

function assertSectorSchemaV2(database: DatabaseSync): void {
  const columns = sectorColumnNames(database);
  for (const required of ['resolution', 'represented_time', 'tie_breaker']) {
    if (!columns.has(required)) throw new Error(`schema v2 sector_observations is missing ${required}`);
  }
}

function sectorColumnNames(database: DatabaseSync): Set<string> {
  return new Set(database.prepare('PRAGMA table_info(sector_observations)').all().map((row) => stringColumn(row, 'name')));
}

function assertBarSchemaV2(database: DatabaseSync): void {
  if (!barColumnNames(database).has('trading_date')) throw new Error('schema v2 bars is missing trading_date');
}

function barColumnNames(database: DatabaseSync): Set<string> {
  return new Set(database.prepare('PRAGMA table_info(bars)').all().map((row) => stringColumn(row, 'name')));
}

function assertRecoverySchemaV3(database: DatabaseSync): void {
  const columns = new Set(database.prepare('PRAGMA table_info(recovery_progress)').all().map((row) => stringColumn(row, 'name')));
  for (const required of ['provider', 'market', 'interval', 'cursor_at', 'updated_at']) {
    if (!columns.has(required)) throw new Error(`schema v3 recovery_progress is missing ${required}`);
  }
}

function validateQuote(quote: CanonicalQuote): void {
  if (!quote || typeof quote !== 'object') throw new Error('quote must be an object');
  validateMarket(quote.market);
  validatedCanonicalSymbol(quote.symbol, 'quote symbol', quote.market);
  requireNullableString(quote.name, 'quote name');
  if ((quote.market === 'CN' && quote.currency !== 'CNY') || (quote.market === 'HK' && quote.currency !== 'HKD')) throw new Error('quote currency does not match market');
  for (const field of ['price', 'open', 'high', 'low', 'previousClose', 'volume', 'amount', 'change', 'changePercent'] as const) requireNullableFinite(quote[field], `quote ${field}`);
  if (quote.marketTime !== null) requireTimestamp(quote.marketTime, 'quote marketTime');
  requireTimestamp(quote.fetchedAt, 'quote fetchedAt');
  requireString(quote.source, 'quote source');
  requireBoolean(quote.isDelayed, 'quote isDelayed');
  requireBoolean(quote.isStale, 'quote isStale');
}

function validateBar(bar: Bar): void {
  if (!bar || typeof bar !== 'object') throw new Error('bar must be an object');
  validateMarket(bar.market);
  validatedCanonicalSymbol(bar.symbol, 'bar symbol', bar.market);
  requireString(bar.interval, 'bar interval');
  if (!ALLOWED_INTERVALS.has(bar.interval)) throw new Error('bar interval is unsupported');
  requireTimestamp(bar.timestamp, 'bar timestamp');
  for (const field of ['open', 'high', 'low', 'close'] as const) requireFinite(bar[field], `bar ${field}`);
  requireNullableFinite(bar.volume, 'bar volume');
  requireNullableFinite(bar.turnover, 'bar turnover');
}

function validateSector(sector: SectorObservation): void {
  if (!sector || typeof sector !== 'object') throw new Error('sector must be an object');
  requireString(sector.id, 'sector id');
  requireString(sector.name, 'sector name');
  requireString(sector.category, 'sector category');
  for (const field of ['changePercent', 'turnover', 'netFlow', 'leaderChangePercent'] as const) requireNullableFinite(sector[field], `sector ${field}`);
  requireNullableString(sector.leaderSymbol, 'sector leaderSymbol');
  requireNullableString(sector.leaderName, 'sector leaderName');
  if (sector.marketTime !== null) requireTimestamp(sector.marketTime, 'sector marketTime');
  requireTimestamp(sector.fetchedAt, 'sector fetchedAt');
  requireString(sector.source, 'sector source');
  requireBoolean(sector.isDelayed, 'sector isDelayed');
  requireBoolean(sector.isStale, 'sector isStale');
}

function validateGap(gap: CollectionGap): void {
  if (!gap || typeof gap !== 'object') throw new Error('gap must be an object');
  validateMarket(gap.market);
  requireNullableString(gap.symbol, 'gap symbol');
  if (gap.symbol !== null) validatedCanonicalSymbol(gap.symbol, 'gap symbol', gap.market);
  requireString(gap.interval, 'gap interval');
  requireTimestamp(gap.start, 'gap start');
  requireTimestamp(gap.end, 'gap end');
  if (Date.parse(gap.start) >= Date.parse(gap.end)) throw new Error('gap start must be before end');
  requireString(gap.reason, 'gap reason');
  requireTimestamp(gap.recordedAt, 'gap recordedAt');
}

function validateRecoveryIdentity(provider: unknown, market: unknown, interval: unknown): asserts interval is 'quote' {
  requireString(provider, 'recovery provider');
  validateMarket(market);
  if (interval !== 'quote') throw new Error('recovery interval must be quote');
}

function validateRecoverySegment(segment: RecoverySegmentCommit): void {
  if (!segment || typeof segment !== 'object') throw new Error('recovery segment must be an object');
  validateRecoveryIdentity(segment.provider, segment.market, segment.interval);
  requireTimestamp(segment.start, 'recovery start');
  requireTimestamp(segment.end, 'recovery end');
  if (Date.parse(segment.start) >= Date.parse(segment.end)) throw new Error('recovery start must be before end');
  requireTimestamp(segment.completedAt, 'recovery completedAt');
  if (Date.parse(segment.completedAt) < Date.parse(segment.end)) throw new Error('recovery completedAt must not precede end');
  assertDenseArray(segment.items, 'recovery items');
  for (const item of segment.items) {
    validateQuote(item);
    if (item.market !== segment.market) throw new Error('recovery item market does not match segment market');
    if (item.source !== segment.provider) throw new Error('recovery item source does not match provider');
    const representedAt = Date.parse(item.marketTime ?? item.fetchedAt);
    if (representedAt < Date.parse(segment.start) || representedAt >= Date.parse(segment.end)) {
      throw new Error('recovery item falls outside segment bounds');
    }
  }
  if (segment.gap !== null) {
    validateGap(segment.gap);
    if (segment.gap.market !== segment.market) throw new Error('recovery gap market does not match segment market');
    if (segment.gap.symbol !== null) throw new Error('recovery gap symbol must be null');
    if (segment.gap.interval !== segment.interval) throw new Error('recovery gap interval does not match segment interval');
    if (segment.gap.start !== segment.start || segment.gap.end !== segment.end) {
      throw new Error('recovery gap bounds do not match segment bounds');
    }
  }
}

function validateProviderHealth(update: ProviderHealthUpdate): void {
  if (!update || typeof update !== 'object') throw new Error('provider health must be an object');
  requireString(update.provider, 'provider');
  requireBoolean(update.available, 'provider available');
  requireNullableFinite(update.latencyMs, 'provider latencyMs');
  if (update.latencyMs !== null && update.latencyMs < 0) throw new Error('provider latencyMs must be non-negative');
  for (const field of ['lastAttemptAt', 'lastSuccessAt', 'lastFailureAt'] as const) {
    if (update[field] !== null) requireTimestamp(update[field], `provider ${field}`);
  }
  if (!Number.isSafeInteger(update.consecutiveFailures) || update.consecutiveFailures < 0) throw new Error('provider consecutiveFailures must be a non-negative safe integer');
  requireNullableString(update.error, 'provider error');
}

function rowToQuote(row: unknown): CanonicalQuote {
  return {
    symbol: stringColumn(row, 'symbol'),
    name: nullableStringColumn(row, 'name'),
    market: marketColumn(row, 'market'),
    currency: currencyColumn(row, 'currency'),
    price: nullableNumberColumn(row, 'price'),
    open: nullableNumberColumn(row, 'open'),
    high: nullableNumberColumn(row, 'high'),
    low: nullableNumberColumn(row, 'low'),
    previousClose: nullableNumberColumn(row, 'previous_close'),
    volume: nullableNumberColumn(row, 'volume'),
    amount: nullableNumberColumn(row, 'amount'),
    change: nullableNumberColumn(row, 'change_value'),
    changePercent: nullableNumberColumn(row, 'change_percent'),
    marketTime: nullableStringColumn(row, 'market_time'),
    fetchedAt: stringColumn(row, 'fetched_at'),
    source: stringColumn(row, 'source'),
    isDelayed: booleanColumn(row, 'is_delayed'),
    isStale: booleanColumn(row, 'is_stale'),
  };
}

function rowToBar(row: unknown): Bar {
  return {
    symbol: stringColumn(row, 'symbol'),
    market: marketColumn(row, 'market'),
    interval: stringColumn(row, 'interval'),
    timestamp: stringColumn(row, 'timestamp'),
    open: numberColumn(row, 'open'),
    high: numberColumn(row, 'high'),
    low: numberColumn(row, 'low'),
    close: numberColumn(row, 'close'),
    volume: nullableNumberColumn(row, 'volume'),
    turnover: nullableNumberColumn(row, 'turnover'),
  };
}

function rowToSector(row: unknown): SectorObservation {
  return {
    id: stringColumn(row, 'id'),
    name: stringColumn(row, 'name'),
    category: stringColumn(row, 'category'),
    changePercent: nullableNumberColumn(row, 'change_percent'),
    turnover: nullableNumberColumn(row, 'turnover'),
    netFlow: nullableNumberColumn(row, 'net_flow'),
    leaderSymbol: nullableStringColumn(row, 'leader_symbol'),
    leaderName: nullableStringColumn(row, 'leader_name'),
    leaderChangePercent: nullableNumberColumn(row, 'leader_change_percent'),
    marketTime: nullableStringColumn(row, 'market_time'),
    fetchedAt: stringColumn(row, 'fetched_at'),
    source: stringColumn(row, 'source'),
    isDelayed: booleanColumn(row, 'is_delayed'),
    isStale: booleanColumn(row, 'is_stale'),
  };
}

function rowToGap(row: unknown): CollectionGap {
  return {
    market: marketColumn(row, 'market'),
    symbol: stringColumn(row, 'symbol') || null,
    interval: stringColumn(row, 'interval'),
    start: stringColumn(row, 'start_time'),
    end: stringColumn(row, 'end_time'),
    reason: stringColumn(row, 'reason'),
    recordedAt: stringColumn(row, 'recorded_at'),
  };
}

function rowToProviderHealth(row: unknown): ProviderHealthUpdate {
  return {
    provider: stringColumn(row, 'provider'),
    available: booleanColumn(row, 'available'),
    latencyMs: nullableNumberColumn(row, 'latency_ms'),
    lastAttemptAt: nullableStringColumn(row, 'last_attempt_at'),
    lastSuccessAt: nullableStringColumn(row, 'last_success_at'),
    lastFailureAt: nullableStringColumn(row, 'last_failure_at'),
    consecutiveFailures: numberColumn(row, 'consecutive_failures'),
    error: nullableStringColumn(row, 'error'),
  };
}

function sectorBucket(timestamp: string, resolution: SectorResolution): string {
  if (resolution === 'daily') return shanghaiStartOfDay(shanghaiDate(timestamp));
  const milliseconds = Date.parse(timestamp);
  return new Date(Math.floor(milliseconds / 300_000) * 300_000).toISOString();
}

function sectorTieBreaker(sector: SectorObservation): string {
  return JSON.stringify([
    sector.name, sector.changePercent, sector.turnover, sector.netFlow, sector.leaderSymbol, sector.leaderName,
    sector.leaderChangePercent, sector.marketTime, sector.fetchedAt, sector.isDelayed, sector.isStale,
  ]);
}

function shanghaiStartOfDay(tradingDate: string): string {
  requireTradingDate(tradingDate);
  const [year, month, day] = tradingDate.split('-').map(Number) as [number, number, number];
  const targetWallTime = Date.UTC(year, month - 1, day);
  let candidate = new Date(targetWallTime);
  for (let attempts = 0; attempts < 4; attempts++) {
    const parts = shanghaiDateTimeParts(candidate);
    const observedWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = targetWallTime - observedWallTime;
    if (adjustment === 0) return candidate.toISOString();
    candidate = new Date(candidate.getTime() + adjustment);
  }
  throw new Error(`could not resolve Asia/Shanghai start of ${tradingDate}`);
}

function shanghaiDateTimeParts(value: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function validateMarket(value: unknown): asserts value is Market {
  if (value !== 'CN' && value !== 'HK') throw new Error('market must be CN or HK');
}

function validateSectorResolution(value: unknown): asserts value is SectorResolution {
  if (value !== 'intraday' && value !== 'daily') throw new Error('sector resolution must be intraday or daily');
}

function validatedCanonicalSymbol(value: unknown, label: string, expectedMarket?: Market): string {
  requireString(value, label);
  let canonicalized: ReturnType<typeof canonicalizeSymbol>;
  try {
    canonicalized = canonicalizeSymbol(value);
  } catch {
    throw new Error(`${label} is unsupported`);
  }
  const canonical = canonicalized.symbol;
  if (canonical !== value) throw new Error(`${label} must be canonical`);
  if (expectedMarket !== undefined && canonicalized.market !== expectedMarket) throw new Error(`${label} does not match market`);
  return canonical;
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
}

function requireNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== 'string') throw new Error(`${label} must be a string or null`);
}

function requireFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function requireNullableFinite(value: unknown, label: string): asserts value is number | null {
  if (value !== null) requireFinite(value, label);
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a valid ISO timestamp`);
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) throw new Error(`${label} must be a valid ISO timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7]!;
  const offset = timestampOffsetMinutes(zone);
  const timestamp = Date.parse(value);
  if (offset === null || !Number.isFinite(timestamp)) throw new Error(`${label} must be a valid ISO timestamp`);
  const represented = new Date(timestamp + offset * 60_000);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || represented.getUTCFullYear() !== year || represented.getUTCMonth() + 1 !== month
    || represented.getUTCDate() !== day || represented.getUTCHours() !== hour
    || represented.getUTCMinutes() !== minute || represented.getUTCSeconds() !== second
  ) throw new Error(`${label} must be a valid ISO timestamp`);
}

function timestampOffsetMinutes(zone: string): number | null {
  if (zone === 'Z') return 0;
  const hour = Number(zone.slice(1, 3));
  const minute = Number(zone.slice(4, 6));
  if (hour > 23 || minute > 59) return null;
  return (zone[0] === '+' ? 1 : -1) * (hour * 60 + minute);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requireTradingDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TRADING_DATE.test(value) || !isCalendarDate(value)) throw new Error('trading date must be a valid YYYY-MM-DD date');
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error('limit must be an integer from 1 to 10000');
  return value;
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) throw new Error(`${label} must be a dense array`);
}

function assertJsonSafe(value: unknown, label: string, active: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} contains a class instance`);
    if (Object.keys(value).length !== value.length) throw new Error(`${label} contains a sparse array`);
    if (active.has(value)) throw new Error(`${label} contains a cyclic value`);
    active.add(value);
    for (const item of value) assertJsonSafe(item, label, active);
    active.delete(value);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (active.has(value)) throw new Error(`${label} contains a cyclic value`);
    active.add(value);
    for (const item of Object.values(value as Record<string, unknown>)) assertJsonSafe(item, label, active);
    active.delete(value);
    return;
  }
  throw new Error(`${label} is not lossless JSON`);
}

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') throw new Error('SQLite returned an invalid row');
  return row as Record<string, unknown>;
}

function stringColumn(row: unknown, column: string): string {
  const value = rowRecord(row)[column];
  if (typeof value !== 'string') throw new Error(`SQLite column ${column} is not a string`);
  return value;
}

function nullableStringColumn(row: unknown, column: string): string | null {
  if (row === undefined) return null;
  const value = rowRecord(row)[column];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`SQLite column ${column} is not a string or null`);
  return value;
}

function numberColumn(row: unknown, column: string): number {
  const value = rowRecord(row)[column];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`SQLite column ${column} is not finite`);
  return value;
}

function nullableNumberColumn(row: unknown, column: string): number | null {
  const value = rowRecord(row)[column];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`SQLite column ${column} is not finite or null`);
  return value;
}

function booleanColumn(row: unknown, column: string): boolean {
  const value = numberColumn(row, column);
  if (value !== 0 && value !== 1) throw new Error(`SQLite column ${column} is not boolean`);
  return value === 1;
}

function marketColumn(row: unknown, column: string): Market {
  const value = stringColumn(row, column);
  validateMarket(value);
  return value;
}

function currencyColumn(row: unknown, column: string): 'CNY' | 'HKD' {
  const value = stringColumn(row, column);
  if (value !== 'CNY' && value !== 'HKD') throw new Error(`SQLite column ${column} is not a currency`);
  return value;
}

function changeCount(result: ReturnType<StatementSync['run']>): number {
  const changes = result.changes;
  if (typeof changes === 'bigint') {
    if (changes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SQLite change count exceeds JSON-safe range');
    return Number(changes);
  }
  return changes;
}

function scalarCount(database: DatabaseSync, sql: string): number {
  return numberColumn(database.prepare(sql).get(), 'count');
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function sanitizeError(error: string): string {
  return error.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, 512);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  assertJsonSafe(parsed, 'stored maintenance result');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('stored maintenance result is not an object');
  return parsed as Record<string, unknown>;
}
