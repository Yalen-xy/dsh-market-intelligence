import { isProxy } from 'node:util/types';
import type { RuntimePaths } from './config.js';
import type { Bar, CanonicalQuote, SectorObservation, SourceConflict } from './model.js';
import type { MaintenanceResult } from './retention.js';
import type {
  AuctionServiceResult,
  HealthResult,
  MarketService,
  QuotesResult,
  SectorsResult,
  SeriesResult,
  StatusResult,
  WatchlistResult,
} from './service.js';
import { canonicalizeSymbol, type CanonicalSymbol } from './symbols.js';

export type MarketToolsService = Pick<
  MarketService,
  'status' | 'quotes' | 'series' | 'sectors' | 'auction' | 'watchlist' | 'health'
>;

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

export type MarketToolCallContext = { signal: AbortSignal };

export type MarketToolContract = {
  readonly name: MarketToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject;
  execute(args: unknown, context: MarketToolCallContext): Promise<unknown>;
};

export class MarketToolArgsError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'MarketToolArgsError';
  }
}

export class MarketToolOutputError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'MarketToolOutputError';
  }
}

type ToolPaths = Pick<RuntimePaths, 'config'>;

const MARKET = ['CN', 'HK'] as const;
const PHASE = ['auction', 'preopen', 'continuous', 'lunch', 'closed'] as const;
const AVAILABILITY = ['live', 'cached', 'stale', 'unavailable'] as const;
const SERIES_INTERVAL = ['minute', 'day', 'week', 'month'] as const;
const ERROR_CATEGORY = ['timeout', 'abort', 'http', 'decode', 'parse', 'storage', 'network', 'validation', 'partial', 'unknown'] as const;

const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] } as const;

const quoteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true },
    name: { ...nullableString, required: true },
    market: { type: 'string', enum: MARKET, required: true },
    currency: { type: 'string', enum: ['CNY', 'HKD'], required: true },
    price: { ...nullableNumber, required: true },
    open: { ...nullableNumber, required: true },
    high: { ...nullableNumber, required: true },
    low: { ...nullableNumber, required: true },
    previousClose: { ...nullableNumber, required: true },
    volume: { ...nullableNumber, required: true },
    amount: { ...nullableNumber, required: true },
    change: { ...nullableNumber, required: true },
    changePercent: { ...nullableNumber, required: true },
    marketTime: { ...nullableString, required: true },
    fetchedAt: { type: 'string', required: true },
    source: { type: 'string', required: true },
    isDelayed: { type: 'boolean', required: true },
    isStale: { type: 'boolean', required: true },
  },
} as const;

const barSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true },
    market: { type: 'string', enum: MARKET, required: true },
    interval: { type: 'string', enum: SERIES_INTERVAL, required: true },
    timestamp: { type: 'string', required: true },
    open: { type: 'number', required: true },
    high: { type: 'number', required: true },
    low: { type: 'number', required: true },
    close: { type: 'number', required: true },
    volume: { ...nullableNumber, required: true },
    turnover: { ...nullableNumber, required: true },
  },
} as const;

const sectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    category: { type: 'string', enum: ['industry', 'concept'], required: true },
    changePercent: { ...nullableNumber, required: true },
    turnover: { ...nullableNumber, required: true },
    netFlow: { ...nullableNumber, required: true },
    leaderSymbol: { ...nullableString, required: true },
    leaderName: { ...nullableString, required: true },
    leaderChangePercent: { ...nullableNumber, required: true },
    marketTime: { ...nullableString, required: true },
    fetchedAt: { type: 'string', required: true },
    source: { type: 'string', required: true },
    isDelayed: { type: 'boolean', required: true },
    isStale: { type: 'boolean', required: true },
  },
} as const;

const conflictObservationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    marketTime: { ...nullableString, required: true },
    value: {
      oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
      required: true,
    },
  },
} as const;

const conflictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true },
    field: { type: 'string', required: true },
    observations: { type: 'array', items: conflictObservationSchema, required: true },
    detectedAt: { type: 'string', required: true },
  },
} as const;

const statusOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asOf: { type: 'string', required: true },
    collectionActive: { type: 'boolean', required: true },
    lastSuccessfulUpdate: { ...nullableString, required: true },
    markets: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: { type: 'string', enum: MARKET, required: true },
          phase: { type: 'string', enum: PHASE, required: true },
          tradingDate: { type: 'string', required: true },
          sessionStart: { ...nullableString, required: true },
          sessionEnd: { ...nullableString, required: true },
          collectionActive: { type: 'boolean', required: true },
          calendarConfidence: { type: 'string', enum: ['configured', 'degraded'], required: true },
        },
      },
    },
  },
} as const;

const quotesOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    availability: { type: 'string', enum: AVAILABILITY, required: true },
    items: { type: 'array', items: quoteSchema, required: true },
    conflicts: { type: 'array', items: conflictSchema, required: true },
  },
} as const;

const seriesOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    availability: { type: 'string', enum: AVAILABILITY, required: true },
    source: {
      oneOf: [{ type: 'string', enum: ['storage', 'provider', 'both'] }, { type: 'null' }],
      required: true,
    },
    items: { type: 'array', items: barSchema, required: true },
  },
} as const;

const sectorsOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    availability: { type: 'string', enum: AVAILABILITY, required: true },
    items: { type: 'array', items: sectorSchema, required: true },
  },
} as const;

const auctionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    availability: { type: 'string', enum: AVAILABILITY, required: true },
    phase: { type: 'string', enum: PHASE, required: true },
    reason: { ...nullableString, required: true },
    items: { type: 'array', items: quoteSchema, required: true },
  },
} as const;

const watchlistOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    watchlist: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const;

const maintenanceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runAt: { type: 'string', required: true },
    completedAt: { type: 'string', required: true },
    compactedTradingDates: { type: 'array', items: { type: 'string' }, required: true },
    compactedRawRows: { type: 'integer', required: true },
    createdMinuteBars: { type: 'integer', required: true },
    createdDailyBars: { type: 'integer', required: true },
    createdDailySectorSummaries: { type: 'integer', required: true },
    deletedRawRows: { type: 'integer', required: true },
    expiredMinuteTradingDates: { type: 'array', items: { type: 'string' }, required: true },
    expiredMinuteRows: { type: 'integer', required: true },
    prunedMinuteTradingDates: { type: 'array', items: { type: 'string' }, required: true },
    prunedMinuteRows: { type: 'integer', required: true },
    prunedSectorBuckets: { type: 'array', items: { type: 'string' }, required: true },
    prunedSectorRows: { type: 'integer', required: true },
    bytesBefore: { type: 'integer', required: true },
    bytesAfter: { type: 'integer', required: true },
    maxBytes: { type: 'integer', required: true },
    capSatisfied: { type: 'boolean', required: true },
  },
} as const;

const healthOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providers: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          latencyMs: { ...nullableNumber, required: true },
          lastAttemptAt: { ...nullableString, required: true },
          lastSuccessAt: { ...nullableString, required: true },
          lastFailureAt: { ...nullableString, required: true },
          consecutiveFailures: { type: 'integer', required: true },
          errorCategory: {
            oneOf: [{ type: 'string', enum: ERROR_CATEGORY }, { type: 'null' }],
            required: true,
          },
        },
      },
    },
    scheduler: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        state: { type: 'string', enum: ['running', 'stopping', 'stopped'], required: true },
        pendingTimers: { ...nullableNumber, required: true },
        inFlight: { ...nullableNumber, required: true },
      },
    },
    database: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        databaseBytes: { type: 'integer', required: true },
        liveDatabaseBytes: { type: 'integer', required: true },
        counts: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            quoteObservations: { type: 'integer', required: true },
            minuteBars: { type: 'integer', required: true },
            dailyBars: { type: 'integer', required: true },
            sectorObservations: { type: 'integer', required: true },
            sectorDailySummaries: { type: 'integer', required: true },
          },
        },
      },
    },
    gaps: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          market: { type: 'string', enum: MARKET, required: true },
          symbol: { ...nullableString, required: true },
          interval: { type: 'string', required: true },
          start: { type: 'string', required: true },
          end: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          recordedAt: { type: 'string', required: true },
        },
      },
    },
    retention: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        status: { type: 'string', enum: ['ok', 'over-cap', 'unknown'], required: true },
        lastResult: { oneOf: [maintenanceSchema, { type: 'null' }], required: true },
      },
    },
  },
} as const;

const OUTPUT_SCHEMAS = {
  market_status: toJsonSchema(statusOutputSchema),
  market_quotes: toJsonSchema(quotesOutputSchema),
  market_series: toJsonSchema(seriesOutputSchema),
  market_sectors: toJsonSchema(sectorsOutputSchema),
  market_auction: toJsonSchema(auctionOutputSchema),
  market_watchlist: toJsonSchema(watchlistOutputSchema),
  market_data_health: toJsonSchema(healthOutputSchema),
} as const;

const statusParameters = closedObject({
  market: { type: 'string', enum: [...MARKET] },
});
const quotesParameters = closedObject({
  symbols: { type: 'array', items: { type: 'string' } },
  refresh: { type: 'boolean' },
});
const seriesParameters = closedObject({
  symbol: { type: 'string' },
  interval: { type: 'string', enum: [...SERIES_INTERVAL] },
  refresh: { type: 'boolean' },
  start: { type: 'string' },
  end: { type: 'string' },
  adjustment: { type: 'string', enum: ['qfq'] },
  limit: { type: 'integer' },
}, ['symbol', 'interval']);
const sectorsParameters = closedObject({
  category: { type: 'string', enum: ['industry', 'concept'] },
  sort: { type: 'string', enum: ['changePercent', 'turnover', 'netFlow'] },
  direction: { type: 'string', enum: ['asc', 'desc'] },
  limit: { type: 'integer' },
  refresh: { type: 'boolean' },
});
const auctionParameters = closedObject({
  market: { type: 'string', enum: [...MARKET] },
  symbols: { type: 'array', items: { type: 'string' } },
}, ['market']);
const watchlistParameters = closedObject({
  action: { type: 'string', enum: ['get', 'add', 'remove'] },
  symbol: { type: 'string' },
}, ['action']);
const healthParameters = closedObject({});

export function createMarketToolContracts(service: MarketToolsService, _paths: ToolPaths): readonly MarketToolContract[] {
  return [
    contract('market_status', 'Use this tool before answering questions about whether today/current A-share or Hong Kong markets are open, closed, in auction, or being collected. Returns exchange session state, not prices.', statusParameters, OUTPUT_SCHEMAS.market_status, async (args) => projectToolOutput('market_status', () => projectStatus(service.status(args as { market?: 'CN' | 'HK' })))),
    contract('market_quotes', 'Use this tool whenever the user asks about today/current/latest A-share or Hong Kong prices, indices, or market performance. For a broad market overview pass symbols ["sh000001","sz399001","sh000300","hkHSI","hkHSTECH"] and refresh true; it works both during trading and after close. Never claim market data is unavailable before calling this tool.', quotesParameters, OUTPUT_SCHEMAS.market_quotes, async (args, context) => {
      const input = args as { symbols?: string[]; refresh?: boolean };
      requireAtMost100(input.symbols, 'symbols');
      const request = input.symbols === undefined ? { ...input, refresh: input.refresh ?? true } : { ...input, refresh: input.refresh ?? true, symbols: canonicalInputSymbols(input.symbols, 'symbols').map(({ symbol }) => symbol) };
      const result = await service.quotes(request, context.signal);
      return projectToolOutput('market_quotes', () => projectQuotes(result));
    }),
    contract('market_series', 'Read minute, daily, weekly, or monthly bars for one supported symbol.', seriesParameters, OUTPUT_SCHEMAS.market_series, async (args, context) => {
      const input = args as { symbol: string; interval: 'minute' | 'day' | 'week' | 'month'; refresh?: boolean; start?: string; end?: string; adjustment?: 'qfq'; limit?: number };
      requireLimit(input.limit);
      const request = { ...input, symbol: canonicalInputSymbol(input.symbol, 'symbol').symbol };
      validateSeriesRange(request.start, request.end);
      const result = await service.series(request, context.signal);
      return projectToolOutput('market_series', () => projectSeries(result, input.limit ?? 500));
    }),
    contract('market_sectors', 'Use this tool for today/current A-share industry or concept sector rankings, leaders, turnover, and breadth analysis. Read both categories when the user asks for a broad盘面/板块 overview.', sectorsParameters, OUTPUT_SCHEMAS.market_sectors, async (args, context) => {
      const input = args as { category?: string; sort?: 'changePercent' | 'turnover' | 'netFlow'; direction?: 'asc' | 'desc'; limit?: number; refresh?: boolean };
      requireLimit(input.limit);
      const result = await service.sectors({ ...input, refresh: input.refresh ?? true }, context.signal);
      return projectToolOutput('market_sectors', () => projectSectors(result, input.limit ?? 500));
    }),
    contract('market_auction', 'Read A-share call-auction or Hong Kong pre-open observations.', auctionParameters, OUTPUT_SCHEMAS.market_auction, async (args, context) => {
      const input = args as { market: 'CN' | 'HK'; symbols?: string[] };
      requireAtMost100(input.symbols, 'symbols');
      const request = input.symbols === undefined ? input : { ...input, symbols: canonicalInputSymbols(input.symbols, 'symbols').map((canonical) => {
        if (canonical.market !== input.market) throw new MarketToolArgsError([`"symbols" contains ${canonical.symbol}, which does not belong to market ${input.market}`]);
        return canonical.symbol;
      }) };
      const result = await service.auction(request, context.signal);
      return projectToolOutput('market_auction', () => projectAuction(result));
    }),
    contract('market_watchlist', 'Get, add, or remove one A-share or Hong Kong symbol in the local watchlist.', watchlistParameters, OUTPUT_SCHEMAS.market_watchlist, async (args, context) => {
      const input = args as { action: 'get' | 'add' | 'remove'; symbol?: string };
      if (input.action === 'get' && input.symbol !== undefined) throw new MarketToolArgsError(['"symbol" is not a declared property when action is "get"']);
      if (input.action !== 'get' && input.symbol === undefined) throw new MarketToolArgsError(['"symbol" is required when action is "add" or "remove"']);
      const request = input.action === 'get' ? { action: 'get' as const } : { action: input.action, symbol: canonicalInputSymbol(input.symbol!, 'symbol').symbol };
      const result = await service.watchlist(request, context.signal);
      return projectToolOutput('market_watchlist', () => projectWatchlist(result));
    }),
    contract('market_data_health', 'Use this tool to diagnose market data availability or provider failures. Do not infer that行情 is unavailable from shell/network limitations before checking this tool.', healthParameters, OUTPUT_SCHEMAS.market_data_health, async () => projectToolOutput('market_data_health', () => projectHealth(service.health()))),
  ];
}

function contract(name: MarketToolName, description: string, inputSchema: JsonSchemaObject, outputSchema: JsonSchemaObject, execute: (args: unknown, context: MarketToolCallContext) => Promise<unknown>): MarketToolContract {
  return { name, description, inputSchema, outputSchema, execute };
}

function closedObject(properties: Record<string, unknown>, required?: string[]): JsonSchemaObject {
  return {
    type: 'object',
    properties,
    ...(required === undefined ? {} : { required }),
    additionalProperties: false,
  };
}

function requireAtMost100(value: string[] | undefined, label: string): void {
  if (value !== undefined && value.length > 100) {
    throw new MarketToolArgsError([`"${label}" must contain at most 100 items`]);
  }
}

function requireLimit(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 10_000)) {
    throw new MarketToolArgsError(['"limit" must be an integer from 1 to 10000']);
  }
}

function canonicalInputSymbol(value: string, label: string): CanonicalSymbol {
  try {
    return canonicalizeSymbol(value);
  } catch {
    throw new MarketToolArgsError([`"${label}" contains an unsupported market symbol`]);
  }
}

function canonicalInputSymbols(values: string[], label: string): CanonicalSymbol[] {
  return values.map((value) => canonicalInputSymbol(value, label));
}

function validateSeriesRange(start: string | undefined, end: string | undefined): void {
  const startTime = start === undefined ? undefined : strictInputTimestamp(start, 'start');
  const endTime = end === undefined ? undefined : strictInputTimestamp(end, 'end');
  if (startTime !== undefined && endTime !== undefined && startTime >= endTime) {
    throw new MarketToolArgsError(['"start" must represent an instant before "end"']);
  }
}

function strictInputTimestamp(value: string, label: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new MarketToolArgsError([`"${label}" must be a valid ISO timestamp with an explicit offset`]);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new MarketToolArgsError([`"${label}" must be a valid ISO timestamp with an explicit offset`]);
  }
  const offset = offsetMinutes(zone);
  const timestamp = Date.parse(value);
  if (offset === null || !Number.isFinite(timestamp)) {
    throw new MarketToolArgsError([`"${label}" must be a valid ISO timestamp with an explicit offset`]);
  }
  const represented = new Date(timestamp + offset * 60_000);
  if (represented.getUTCFullYear() !== year || represented.getUTCMonth() + 1 !== month || represented.getUTCDate() !== day
    || represented.getUTCHours() !== hour || represented.getUTCMinutes() !== minute || represented.getUTCSeconds() !== second) {
    throw new MarketToolArgsError([`"${label}" must be a valid ISO timestamp with an explicit offset`]);
  }
  return timestamp;
}

function offsetMinutes(zone: string): number | null {
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

async function projectToolOutput<T>(tool: MarketToolName, project: () => T | Promise<T>): Promise<T> {
  try {
    const value = await project();
    assertLosslessJson(value);
    return value;
  } catch (error) {
    if (error instanceof MarketToolOutputError) throw error;
    throw new MarketToolOutputError(['value could not be projected safely']);
  }
}

function assertLosslessJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return;
    throw new Error('invalid JSON number');
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('invalid JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Object.keys(value).length !== value.length) throw new Error('invalid JSON array');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid JSON object');
  }
  ancestors.add(value);
  try {
    for (const item of Array.isArray(value) ? value : Object.values(value)) assertLosslessJson(item, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function toJsonSchema(spec: Record<string, unknown>): JsonSchemaObject {
  return convertSchema(spec) as JsonSchemaObject;
}

function convertSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertSchema);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key !== 'required') converted[key] = convertSchema(child);
  }
  if (source.type === 'object' && source.properties !== undefined) {
    const properties = source.properties as Record<string, Record<string, unknown>>;
    const required = Object.entries(properties).filter(([, property]) => property.required === true).map(([name]) => name);
    if (required.length > 0) converted.required = required;
  }
  return converted;
}

type SeriesInterval = typeof SERIES_INTERVAL[number];
type ToolBar = Omit<Bar, 'interval'> & { interval: SeriesInterval };
type ToolSeriesResult = Omit<SeriesResult, 'items'> & { items: ToolBar[] };
type SectorCategory = 'industry' | 'concept';
type ToolSector = Omit<SectorObservation, 'category'> & { category: SectorCategory };
type ToolSectorsResult = Omit<SectorsResult, 'items'> & { items: ToolSector[] };

function projectStatus(value: StatusResult): StatusResult {
  requireOutputCollection('market_status', 'markets', value.markets, 2);
  return {
    asOf: value.asOf,
    collectionActive: value.collectionActive,
    lastSuccessfulUpdate: value.lastSuccessfulUpdate,
    markets: value.markets.map((market) => ({
      market: market.market,
      phase: market.phase,
      tradingDate: market.tradingDate,
      sessionStart: market.sessionStart,
      sessionEnd: market.sessionEnd,
      collectionActive: market.collectionActive,
      calendarConfidence: market.calendarConfidence,
    })),
  };
}

function projectQuotes(value: QuotesResult): QuotesResult {
  requireOutputCollection('market_quotes', 'items', value.items, 100);
  requireOutputCollection('market_quotes', 'conflicts', value.conflicts, 100);
  return {
    availability: value.availability,
    items: value.items.map(projectQuote),
    conflicts: value.conflicts.map(projectConflict),
  };
}

function projectSeries(value: SeriesResult, limit: number): ToolSeriesResult {
  requireOutputCollection('market_series', 'items', value.items, limit);
  return {
    availability: value.availability,
    source: value.source,
    items: value.items.map(projectBar),
  };
}

function projectSectors(value: SectorsResult, limit: number): ToolSectorsResult {
  requireOutputCollection('market_sectors', 'items', value.items, limit);
  return {
    availability: value.availability,
    items: value.items.map(projectSector),
  };
}

function projectAuction(value: AuctionServiceResult): AuctionServiceResult {
  requireOutputCollection('market_auction', 'items', value.items, 100);
  return {
    availability: value.availability,
    phase: value.phase,
    reason: value.reason,
    items: value.items.map(projectQuote),
  };
}

function projectWatchlist(value: WatchlistResult): WatchlistResult {
  requireOutputCollection('market_watchlist', 'watchlist', value.watchlist, 100);
  return { watchlist: value.watchlist.map((symbol) => symbol) };
}

function projectQuote(value: CanonicalQuote): CanonicalQuote {
  return {
    symbol: value.symbol,
    name: value.name,
    market: value.market,
    currency: value.currency,
    price: value.price,
    open: value.open,
    high: value.high,
    low: value.low,
    previousClose: value.previousClose,
    volume: value.volume,
    amount: value.amount,
    change: value.change,
    changePercent: value.changePercent,
    marketTime: value.marketTime,
    fetchedAt: value.fetchedAt,
    source: value.source,
    isDelayed: value.isDelayed,
    isStale: value.isStale,
  };
}

function projectConflict(value: SourceConflict): SourceConflict {
  const observations = value.observations.map((observation, index) => {
    const observed = observation.value;
    if (typeof observed !== 'number' && typeof observed !== 'string' && observed !== null) {
      throw new MarketToolOutputError([`"conflicts[0].observations[${index}].value" must match exactly one oneOf branch (matched 0)`]);
    }
    return {
      source: observation.source,
      marketTime: observation.marketTime,
      value: observed,
    };
  });
  return {
    symbol: value.symbol,
    field: value.field,
    observations,
    detectedAt: value.detectedAt,
  };
}

function projectBar(value: Bar): ToolBar {
  const interval: unknown = value.interval;
  if (!isSeriesInterval(interval)) {
    throw new MarketToolOutputError(['items[].interval must be minute, day, week, or month']);
  }
  return {
    symbol: value.symbol,
    market: value.market,
    interval,
    timestamp: value.timestamp,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: value.volume,
    turnover: value.turnover,
  };
}

function projectSector(value: SectorObservation): ToolSector {
  const category: unknown = value.category;
  if (!isSectorCategory(category)) {
    throw new MarketToolOutputError(['items[].category must be industry or concept']);
  }
  return {
    id: value.id,
    name: value.name,
    category,
    changePercent: value.changePercent,
    turnover: value.turnover,
    netFlow: value.netFlow,
    leaderSymbol: value.leaderSymbol,
    leaderName: value.leaderName,
    leaderChangePercent: value.leaderChangePercent,
    marketTime: value.marketTime,
    fetchedAt: value.fetchedAt,
    source: value.source,
    isDelayed: value.isDelayed,
    isStale: value.isStale,
  };
}

function isSeriesInterval(value: unknown): value is SeriesInterval {
  return typeof value === 'string' && (SERIES_INTERVAL as readonly string[]).includes(value);
}

function isSectorCategory(value: unknown): value is SectorCategory {
  return value === 'industry' || value === 'concept';
}

function requireOutputCollection(tool: string, label: string, value: unknown[], maximum: number): void {
  if (value.length > maximum) {
    throw new MarketToolOutputError([`${label} contains ${value.length} items; maximum is ${maximum}`]);
  }
}

function projectHealth(value: HealthResult) {
  return {
    providers: value.providers.map((provider) => ({
      provider: provider.provider,
      available: provider.available,
      latencyMs: provider.latencyMs,
      lastAttemptAt: provider.lastAttemptAt,
      lastSuccessAt: provider.lastSuccessAt,
      lastFailureAt: provider.lastFailureAt,
      consecutiveFailures: provider.consecutiveFailures,
      errorCategory: provider.errorCategory,
    })),
    scheduler: {
      state: value.scheduler.state,
      pendingTimers: value.scheduler.pendingTimers,
      inFlight: value.scheduler.inFlight,
    },
    database: {
      databaseBytes: value.database.databaseBytes,
      liveDatabaseBytes: value.database.liveDatabaseBytes,
      counts: {
        quoteObservations: value.database.counts.quoteObservations,
        minuteBars: value.database.counts.minuteBars,
        dailyBars: value.database.counts.dailyBars,
        sectorObservations: value.database.counts.sectorObservations,
        sectorDailySummaries: value.database.counts.sectorDailySummaries,
      },
    },
    gaps: value.gaps.map((gap) => ({
      market: gap.market,
      symbol: gap.symbol,
      interval: gap.interval,
      start: gap.start,
      end: gap.end,
      reason: gap.reason,
      recordedAt: gap.recordedAt,
    })),
    retention: {
      status: value.retention.status,
      lastResult: isCurrentMaintenanceResult(value.retention.lastResult)
        ? projectMaintenance(value.retention.lastResult)
        : null,
    },
  };
}

const MAINTENANCE_KEYS = [
  'runAt',
  'completedAt',
  'compactedTradingDates',
  'compactedRawRows',
  'createdMinuteBars',
  'createdDailyBars',
  'createdDailySectorSummaries',
  'deletedRawRows',
  'expiredMinuteTradingDates',
  'expiredMinuteRows',
  'prunedMinuteTradingDates',
  'prunedMinuteRows',
  'prunedSectorBuckets',
  'prunedSectorRows',
  'bytesBefore',
  'bytesAfter',
  'maxBytes',
  'capSatisfied',
] as const;

function isCurrentMaintenanceResult(value: unknown): value is MaintenanceResult {
  try {
    if (!isPlainRecord(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== MAINTENANCE_KEYS.length || keys.some((key) => !(MAINTENANCE_KEYS as readonly string[]).includes(key))) return false;
    return isCanonicalTimestamp(value.runAt)
      && isCanonicalTimestamp(value.completedAt)
      && isMarketTradingDates(value.compactedTradingDates)
      && isNonNegativeSafeInteger(value.compactedRawRows)
      && isNonNegativeSafeInteger(value.createdMinuteBars)
      && isNonNegativeSafeInteger(value.createdDailyBars)
      && isNonNegativeSafeInteger(value.createdDailySectorSummaries)
      && isNonNegativeSafeInteger(value.deletedRawRows)
      && isMarketTradingDates(value.expiredMinuteTradingDates)
      && isNonNegativeSafeInteger(value.expiredMinuteRows)
      && isTradingDates(value.prunedMinuteTradingDates)
      && isNonNegativeSafeInteger(value.prunedMinuteRows)
      && isTimestamps(value.prunedSectorBuckets)
      && isNonNegativeSafeInteger(value.prunedSectorRows)
      && isNonNegativeSafeInteger(value.bytesBefore)
      && isNonNegativeSafeInteger(value.bytesAfter)
      && isPositiveSafeInteger(value.maxBytes)
      && typeof value.capSatisfied === 'boolean';
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[value.length] !== 'length') return false;
  return keys.slice(0, value.length).every((key, index) => {
    if (key !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string';
  });
}

function isTradingDates(value: unknown): value is string[] {
  return isStringArray(value) && value.every(isTradingDate);
}

function isMarketTradingDates(value: unknown): value is string[] {
  return isStringArray(value) && value.every((entry) => {
    const match = /^(?:CN|HK):(\d{4}-\d{2}-\d{2})$/.exec(entry);
    return match !== null && isTradingDate(match[1]!);
  });
}

function isTimestamps(value: unknown): value is string[] {
  return isStringArray(value) && value.every(isCanonicalTimestamp);
}

function isTradingDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return month !== undefined && day !== undefined && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year!, month);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    strictInputTimestamp(value, 'timestamp');
    return true;
  } catch {
    return false;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function projectMaintenance(value: MaintenanceResult): MaintenanceResult {
  return {
    runAt: value.runAt,
    completedAt: value.completedAt,
    compactedTradingDates: value.compactedTradingDates.map((date) => date),
    compactedRawRows: value.compactedRawRows,
    createdMinuteBars: value.createdMinuteBars,
    createdDailyBars: value.createdDailyBars,
    createdDailySectorSummaries: value.createdDailySectorSummaries,
    deletedRawRows: value.deletedRawRows,
    expiredMinuteTradingDates: value.expiredMinuteTradingDates.map((date) => date),
    expiredMinuteRows: value.expiredMinuteRows,
    prunedMinuteTradingDates: value.prunedMinuteTradingDates.map((date) => date),
    prunedMinuteRows: value.prunedMinuteRows,
    prunedSectorBuckets: value.prunedSectorBuckets.map((bucket) => bucket),
    prunedSectorRows: value.prunedSectorRows,
    bytesBefore: value.bytesBefore,
    bytesAfter: value.bytesAfter,
    maxBytes: value.maxBytes,
    capSatisfied: value.capSatisfied,
  };
}
