import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as builtPlugin from '../lib/index.js';
import { MarketRepository } from '../lib/repository.js';

const TOOL_NAMES = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
];

export async function runProfileSmoke({
  cwd = process.cwd(),
  mkdtempImpl = mkdtemp,
  mkdirImpl = mkdir,
  rmImpl = rm,
  createContext = () => new Context(),
  write = (line) => process.stdout.write(line),
} = {}) {
  const previousDshHome = process.env.DSH_HOME;
  const previousFetch = globalThis.fetch;
  const clock = new SmokeClock(new Date('2026-08-27T01:20:00.000Z'));
  let root;
  let ctx;
  let fiber;
  let repository;
  let networkCalls = 0;
  try {
    root = await mkdtempImpl(path.join(cwd, '.tmp-profile-smoke-'));
    const dshHome = path.join(root, 'dsh');
    const storageDir = path.join(dshHome, 'storages', 'dsh-market-intelligence');
    await mkdirImpl(dshHome, { recursive: true });
    process.env.DSH_HOME = dshHome;
    globalThis.fetch = async () => {
      networkCalls++;
      throw new Error('profile smoke forbids network access');
    };
    ctx = createContext();

    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const apply = builtPlugin.createApply({
      clock,
      openRepository(databasePath) {
        assert.equal(databasePath, path.join(storageDir, 'market.sqlite'));
        repository = MarketRepository.open(databasePath);
        return repository;
      },
      createTencent: () => scriptedTencent(clock),
      createSina: () => scriptedSina(clock),
    });
    const plugin = {
      name: builtPlugin.name,
      inject: builtPlugin.inject,
      Config: builtPlugin.Config,
      apply,
    };
    fiber = ctx.plugin(plugin, {
      storageDir,
      requestTimeoutMs: 1_000,
      providerBatchSize: 10,
      providerConcurrency: 2,
      quoteIntervalMs: 10_000,
      sectorIntervalMs: 60_000,
      sectorPersistIntervalMs: 300_000,
      minuteRetentionTradingDays: 30,
      storageSoftLimitBytes: 536_870_912,
      watchlistLimit: 100,
    });
    await fiber;
    await settle(clock);

    assert.deepEqual(marketToolNames(ctx), TOOL_NAMES);
    const calls = [
      ['market_status', {}],
      ['market_quotes', { symbols: ['sh600000', 'hk00700'], refresh: true }],
      ['market_series', { symbol: 'sh600000', interval: 'minute', refresh: true, limit: 10 }],
      ['market_sectors', { category: 'industry', limit: 10 }],
      ['market_auction', { market: 'CN', symbols: ['sh600000'] }],
      ['market_watchlist', { action: 'get' }],
      ['market_data_health', {}],
    ];
    for (const [name, argumentsValue] of calls) {
      const result = await ctx.tools.execute({
        callId: `profile-smoke-${name}`,
        name,
        arguments: argumentsValue,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false, `${name}: ${resultText(result)}`);
      assertLosslessJson(result.value);
      const serialized = JSON.stringify(result.value);
      assert.equal(resultText(result), serialized);
      assert.deepEqual(JSON.parse(serialized), result.value);
      if (name === 'market_data_health') {
        assert.deepEqual(result.value.scheduler, { state: 'running', pendingTimers: 2, inFlight: 0 });
      }
    }

    await fiber.dispose();
    fiber = undefined;
    assert.deepEqual(marketToolNames(ctx), []);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(networkCalls, 0);
    assert.ok(repository);
    assert.throws(() => repository.health(), /closed/i);
    await ctx.fiber.dispose();
    write(JSON.stringify({ profileSmoke: 'ok', tools: TOOL_NAMES.length, networkCalls, pendingTimers: 0 }) + '\n');
  } finally {
    if (fiber) await fiber.dispose().catch(() => undefined);
    if (ctx) await ctx.fiber.dispose().catch(() => undefined);
    globalThis.fetch = previousFetch;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    if (root) await rmImpl(root, { recursive: true, force: true });
  }
}

class SmokeClock {
  #nextTimer = 1;
  #timers = new Map();

  constructor(now) {
    this.value = now.getTime();
  }

  now = () => new Date(this.value);

  setTimeout = (callback, delayMs) => {
    const id = this.#nextTimer++;
    this.#timers.set(id, { callback, delayMs });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  pendingTimers() {
    return this.#timers.size;
  }
}

function scriptedTencent(clock) {
  return {
    async quotes(symbols, signal) {
      assert.equal(signal.aborted, false);
      return { items: symbols.map((symbol) => quote(symbol, clock.now())) };
    },
    async series(request, signal) {
      assert.equal(signal.aborted, false);
      return { items: [bar(request.symbol, request.interval, clock.now())] };
    },
    async auction(symbols, phase, signal) {
      assert.equal(signal.aborted, false);
      return { phase, items: symbols.map((symbol) => quote(symbol, clock.now())) };
    },
  };
}

function scriptedSina(clock) {
  return {
    async quotes() {
      return { items: [] };
    },
    async sectors(signal) {
      assert.equal(signal.aborted, false);
      const timestamp = clock.now().toISOString();
      return {
        items: [{
          id: 'bank',
          name: 'Banking',
          category: 'industry',
          changePercent: 1,
          turnover: 1_000,
          netFlow: null,
          leaderSymbol: 'sh600000',
          leaderName: 'Example',
          leaderChangePercent: 2,
          marketTime: timestamp,
          fetchedAt: timestamp,
          source: 'sina',
          isDelayed: false,
          isStale: false,
        }],
      };
    },
  };
}

function quote(symbol, now) {
  const market = symbol.toLowerCase().startsWith('hk') ? 'HK' : 'CN';
  return {
    symbol,
    name: symbol,
    market,
    currency: market === 'CN' ? 'CNY' : 'HKD',
    price: 10,
    open: 9.9,
    high: 10.1,
    low: 9.8,
    previousClose: 9.9,
    volume: 1_000,
    amount: 10_000,
    change: 0.1,
    changePercent: 1.01,
    marketTime: now.toISOString(),
    fetchedAt: now.toISOString(),
    source: 'tencent',
    isDelayed: false,
    isStale: false,
  };
}

function bar(symbol, interval, now) {
  return {
    symbol,
    market: symbol.toLowerCase().startsWith('hk') ? 'HK' : 'CN',
    interval,
    timestamp: now.toISOString(),
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 100,
    turnover: 1_000,
  };
}

async function settle(clock) {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
    if (clock.pendingTimers() === 2) return;
  }
  throw new Error(`lifecycle did not settle; pending timers: ${clock.pendingTimers()}`);
}

function marketToolNames(ctx) {
  return ctx.tools.schemas().map(({ name }) => name).filter((name) => name.startsWith('market_')).sort();
}

function resultText(result) {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

function assertLosslessJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true);
    assert.equal(Object.is(value, -0), false);
    return;
  }
  assert.equal(typeof value, 'object');
  assert.equal(ancestors.has(value), false);
  ancestors.add(value);
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    assert.equal(Object.keys(value).length, value.length);
    for (const item of value) assertLosslessJson(item, ancestors);
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const item of Object.values(value)) assertLosslessJson(item, ancestors);
  }
  ancestors.delete(value);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
  await runProfileSmoke().catch((error) => {
    process.stderr.write(`profile-smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
