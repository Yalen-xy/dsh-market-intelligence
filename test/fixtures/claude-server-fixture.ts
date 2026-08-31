import type { MarketRuntime } from '../../src/runtime.ts';
import type { MarketToolsService } from '../../src/tool-contracts.ts';

export const EXPECTED_RESULTS = {
  market_status: {
    asOf: '2026-08-31T01:00:00.000Z',
    collectionActive: false,
    lastSuccessfulUpdate: null,
    markets: [
      { market: 'CN', phase: 'closed', tradingDate: '2026-08-31', sessionStart: null, sessionEnd: null, collectionActive: false, calendarConfidence: 'configured' },
      { market: 'HK', phase: 'closed', tradingDate: '2026-08-31', sessionStart: null, sessionEnd: null, collectionActive: false, calendarConfidence: 'configured' },
    ],
  },
  market_quotes: { availability: 'unavailable', items: [], conflicts: [] },
  market_series: { availability: 'unavailable', source: null, items: [] },
  market_sectors: { availability: 'unavailable', items: [] },
  market_auction: { availability: 'unavailable', phase: 'closed', reason: 'outside auction', items: [] },
  market_watchlist: { watchlist: [] },
  market_data_health: {
    providers: [],
    scheduler: { state: 'running', pendingTimers: 0, inFlight: 0 },
    database: {
      databaseBytes: 0,
      liveDatabaseBytes: 0,
      counts: { quoteObservations: 0, minuteBars: 0, dailyBars: 0, sectorObservations: 0, sectorDailySummaries: 0 },
    },
    gaps: [],
    retention: { status: 'ok', lastResult: null },
  },
} as const;

export const VALID_CALLS = {
  market_auction: { market: 'CN' },
  market_data_health: {},
  market_quotes: { symbols: ['sh000001'], refresh: false },
  market_sectors: { category: 'industry', refresh: false },
  market_series: { symbol: 'sh000001', interval: 'day', refresh: false },
  market_status: { market: 'CN' },
  market_watchlist: { action: 'get' },
} as const;

export type FixtureCall = { name: keyof typeof EXPECTED_RESULTS; args: unknown; signal?: AbortSignal };

export function createRuntimeFixture(): {
  runtime: MarketRuntime;
  service: MarketToolsService;
  calls: FixtureCall[];
  disposeCalls(): number;
} {
  const calls: FixtureCall[] = [];
  let disposals = 0;
  const service: MarketToolsService = {
    status(args) {
      calls.push({ name: 'market_status', args });
      return structuredClone(EXPECTED_RESULTS.market_status);
    },
    async quotes(args, signal) {
      calls.push({ name: 'market_quotes', args, signal });
      return structuredClone(EXPECTED_RESULTS.market_quotes);
    },
    async series(args, signal) {
      calls.push({ name: 'market_series', args, signal });
      return structuredClone(EXPECTED_RESULTS.market_series);
    },
    async sectors(args, signal) {
      calls.push({ name: 'market_sectors', args, signal });
      return structuredClone(EXPECTED_RESULTS.market_sectors);
    },
    async auction(args, signal) {
      calls.push({ name: 'market_auction', args, signal });
      return structuredClone(EXPECTED_RESULTS.market_auction);
    },
    async watchlist(args, signal) {
      calls.push({ name: 'market_watchlist', args, signal });
      return structuredClone(EXPECTED_RESULTS.market_watchlist);
    },
    health() {
      calls.push({ name: 'market_data_health', args: {} });
      return structuredClone(EXPECTED_RESULTS.market_data_health);
    },
  };
  return {
    service,
    calls,
    disposeCalls: () => disposals,
    runtime: {
      service,
      paths: { root: 'D:\\fixture', database: 'D:\\fixture\\market.sqlite', config: 'D:\\fixture\\config.json' },
      async dispose() { disposals += 1; },
    },
  };
}

async function runFixture(): Promise<void> {
  const [{ StdioServerTransport }, { createClaudeLogger }, { createClaudeMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('../../claude/logging.ts'),
    import('../../claude/mcp-server.ts'),
  ]);
  const fixture = createRuntimeFixture();
  const logger = createClaudeLogger(process.stderr);
  const managed = createClaudeMcpServer(() => fixture.runtime, logger);
  process.stdin.once('end', () => { void managed.close(); });
  await managed.server.connect(new StdioServerTransport(process.stdin, process.stdout));
  logger.info('ready');
}

if (process.argv[1]?.endsWith('claude-server-fixture.ts')) {
  await runFixture();
}
