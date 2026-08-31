import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMarketRuntime, type MarketRuntimeConfig, type MarketRuntimeOptions } from '../src/runtime.ts';

const config: MarketRuntimeConfig = {
  requestTimeoutMs: 10_000,
  providerBatchSize: 100,
  providerConcurrency: 4,
  quoteIntervalMs: 10_000,
  sectorIntervalMs: 60_000,
  sectorPersistIntervalMs: 300_000,
  minuteRetentionTradingDays: 30,
  storageSoftLimitBytes: 536_870_912,
  watchlistLimit: 100,
};

test('starts shared runtime once and cancels the limiter before waiting for service shutdown', async () => {
  const events: string[] = [];
  let cancelLimiter: (() => void) | undefined;
  const limiterCancelled = new Promise<void>((resolve) => { cancelLimiter = resolve; });
  const options = fixtureOptions(events);
  options.createRequestLimiter = () => ({
    run: async () => undefined,
    dispose: async () => {
      events.push('cancel-limiter');
      cancelLimiter?.();
      events.push('drain-limiter');
    },
  }) as never;
  options.createService = () => ({
    async dispose() {
      events.push('dispose-service-start');
      await limiterCancelled;
      events.push('dispose-service-end');
    },
  }) as never;
  const runtime = await startMarketRuntime(config, options);

  assert.equal(runtime.paths.database, 'D:\\market\\storages\\dsh-market-intelligence\\market.sqlite');
  assert.deepEqual(events, ['safe:D:\\market', 'safe:D:\\market\\storages\\dsh-market-intelligence', 'mkdir', 'load-state', 'open-db', 'providers', 'scheduler']);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runtime.dispose().then(() => 'settled'),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 25); }),
    ]);
    assert.equal(result, 'settled');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cancelLimiter?.();
    await runtime.dispose();
  }
  await runtime.dispose();
  assert.deepEqual(events, [
    'safe:D:\\market',
    'safe:D:\\market\\storages\\dsh-market-intelligence',
    'mkdir',
    'load-state',
    'open-db',
    'providers',
    'scheduler',
    'cancel-limiter',
    'drain-limiter',
    'dispose-service-start',
    'dispose-service-end',
  ]);
});

test('rolls back acquired resources when runtime startup fails', async () => {
  for (const stage of ['openRepository', 'createRequestLimiter', 'createService'] as const) {
    const events: string[] = [];
    const options = fixtureOptions(events, stage);

    await assert.rejects(startMarketRuntime(config, options), new RegExp(`failed at ${stage}`));

    const expected: Record<typeof stage, string[]> = {
      openRepository: [],
      createRequestLimiter: ['close-db'],
      createService: ['drain-limiter', 'close-db'],
    };
    assert.deepEqual(events.filter((event) => ['close-db', 'dispose-service', 'drain-limiter'].includes(event)), expected[stage], stage);
  }
});

test('aggregates service and limiter disposal rejections after attempting both cleanups', async () => {
  const events: string[] = [];
  const options = fixtureOptions(events);
  options.createRequestLimiter = () => ({
    run: async () => undefined,
    async dispose() {
      events.push('drain-limiter');
      throw new Error('limiter cleanup failed');
    },
  }) as never;
  options.createService = () => ({
    async dispose() {
      events.push('dispose-service');
      throw new Error('service cleanup failed');
    },
  }) as never;
  const runtime = await startMarketRuntime(config, options);

  await assert.rejects(runtime.dispose(), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors.map((item) => (item as Error).message), [
      'service cleanup failed',
      'limiter cleanup failed',
    ]);
    return true;
  });
  await assert.rejects(runtime.dispose(), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors.map((item) => (item as Error).message), [
      'service cleanup failed',
      'limiter cleanup failed',
    ]);
    return true;
  });
  assert.deepEqual(events.slice(-2), ['drain-limiter', 'dispose-service']);
});

test('observes an immediately rejecting limiter while deferred service cleanup is pending', async () => {
  const events: string[] = [];
  let releaseService: (() => void) | undefined;
  try {
    const options = fixtureOptions(events);
    options.createRequestLimiter = () => ({
      run: async () => undefined,
      dispose: () => {
        events.push('reject-limiter');
        return Promise.reject(new Error('limiter cleanup failed'));
      },
    }) as never;
    options.createService = () => ({
      async dispose() {
        events.push('dispose-service-start');
        await new Promise<void>((resolve) => { releaseService = resolve; });
        events.push('dispose-service-end');
        throw new Error('service cleanup failed');
      },
    }) as never;
    const runtime = await startMarketRuntime(config, options);
    const disposal = runtime.dispose();

    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseService?.();
    await assert.rejects(disposal, (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual((error as AggregateError).errors.map((item) => (item as Error).message), [
        'service cleanup failed',
        'limiter cleanup failed',
      ]);
      return true;
    });
  } finally {
    releaseService?.();
  }
});

test('combines startup and rollback failures without losing the startup error', async () => {
  const events: string[] = [];
  const options = fixtureOptions(events, 'createService');
  options.openRepository = () => ({
    close() {
      events.push('close-db');
      throw new Error('repository close failed');
    },
  }) as never;

  await assert.rejects(startMarketRuntime(config, options), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors.map((item) => (item as Error).message), [
      'failed at createService',
      'repository close failed',
    ]);
    return true;
  });
});

function fixtureOptions(events: string[], failingStage?: 'openRepository' | 'createRequestLimiter' | 'createService'): MarketRuntimeOptions {
  const fail = (stage: typeof failingStage) => {
    if (stage === failingStage) throw new Error(`failed at ${stage}`);
  };
  return {
    baseDirectory: 'D:\\market',
    assertSafePath: async (value) => { events.push(`safe:${value}`); },
    mkdir: async () => { events.push('mkdir'); },
    loadUserState: async () => { events.push('load-state'); return { watchlist: [], closures: {} }; },
    mutateWatchlist: async () => ({ watchlist: [], closures: {} }),
    openRepository: () => {
      fail('openRepository');
      events.push('open-db');
      return { close() { events.push('close-db'); } } as never;
    },
    createRequestLimiter: () => {
      fail('createRequestLimiter');
      return { run: async () => undefined, dispose: async () => { events.push('drain-limiter'); } } as never;
    },
    createTencent: () => {
      events.push('providers');
      return { async quotes() { return { items: [] }; }, async series() { return { items: [] }; }, async auction() { return { phase: 'closed', items: [] }; } } as never;
    },
    createSina: () => ({ async quotes() { return { items: [] }; }, async sectors() { return { items: [] }; } }) as never,
    createScheduler: () => { events.push('scheduler'); return {} as never; },
    createService: () => {
      fail('createService');
      events.push('service');
      return { async dispose() { events.push('dispose-service'); } } as never;
    },
    clock: { now: () => new Date('2026-08-31T00:00:00.000Z'), setTimeout, clearTimeout },
  };
}
