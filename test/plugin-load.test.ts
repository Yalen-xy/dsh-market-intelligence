import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { MarketRepository } from '../src/repository.ts';
import { MarketScheduler } from '../src/scheduler.ts';
import { MarketService } from '../src/service.ts';
import { assertSafeLocalWindowsPath } from '../src/paths.ts';
import { FakeClock, atShanghai } from './helpers.ts';
import * as plugin from '../src/index.ts';

const TOOL_NAMES = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
] as const;

const quietTencent = {
  async quotes() { return { items: [] }; },
  async series() { return { items: [] }; },
  async auction(_symbols: string[], phase: 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed') {
    return { phase, items: [] };
  },
};

const quietSina = {
  async quotes() { return { items: [] }; },
  async sectors() { return { items: [] }; },
};

test('exports exact plugin metadata and a Schemastery Standard Schema config', () => {
  assert.equal(plugin.name, 'market-intelligence');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(plugin.Config['~standard'].version, 1);
  assert.equal(plugin.Config['~standard'].vendor, 'schemastery');
  assert.equal(plugin.apply.constructor.name, 'AsyncFunction');
  assert.deepEqual(plugin.Config({}), {
    requestTimeoutMs: 10_000,
    providerBatchSize: 100,
    providerConcurrency: 4,
    quoteIntervalMs: 10_000,
    sectorIntervalMs: 60_000,
    sectorPersistIntervalMs: 300_000,
    minuteRetentionTradingDays: 30,
    storageSoftLimitBytes: 536_870_912,
    watchlistLimit: 100,
  });
});

test('package metadata and bundle patch expose exactly one host-plane row', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
  assert.equal(packageJson.main, './lib/index.js');
  assert.equal(packageJson.types, './lib/index.d.ts');
  assert.deepEqual(packageJson.exports, {
    '.': { types: './lib/index.d.ts', default: './lib/index.js' },
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  });
  assert.equal(packageJson.license, 'SEE LICENSE IN LICENSE');
  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'docs/INSTALL.md', 'scripts']);
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(packageJson.devDependencies?.['@deepseek-ai/dsh-system-prompt'], '^0.1.0-rc.8');

  const patch = (await readFile(path.join(process.cwd(), 'cordis.patch.yml'), 'utf8')).replace(/\r\n/g, '\n').trim();
  assert.equal((patch.match(/^\s+- id:/gm) ?? []).length, 1);
  assert.equal(patch, [
    '- insert:',
    '    - id: market-intelligence',
    '      name: dsh-market-intelligence',
    '      config:',
    '        quoteIntervalMs: 10000',
    '        sectorIntervalMs: 60000',
    '        sectorPersistIntervalMs: 300000',
    '        minuteRetentionTradingDays: 30',
    '        storageSoftLimitBytes: 536870912',
  ].join('\n'));
});

test('real Cordis lifecycle registers seven tools, wires bounded policy, uses the exact storage root, and releases timers and SQLite', async (t) => {
  const layout = await tempLayout(t);
  const clock = new FakeClock(atShanghai('2026-08-27 17:00'));
  let repository: MarketRepository | undefined;
  let databasePath: string | undefined;
  let tencentOptions: Record<string, unknown> | undefined;
  let sinaOptions: Record<string, unknown> | undefined;
  let schedulerOptions: Record<string, unknown> | undefined;
  let serviceOptions: Record<string, unknown> | undefined;
  const custom = pluginWith(plugin.createApply({
    getDshHome: () => layout.dshHome,
    assertSafePath: async () => {},
    clock,
    openRepository(file: string) {
      databasePath = file;
      return repository = MarketRepository.open(file);
    },
    createTencent(options: Record<string, unknown>) {
      tencentOptions = options;
      return quietTencent as never;
    },
    createSina(options: Record<string, unknown>) {
      sinaOptions = options;
      return quietSina as never;
    },
    createScheduler(options: Record<string, unknown>) {
      schedulerOptions = options;
      return new MarketScheduler(options as never);
    },
    createService(options: Record<string, unknown>) {
      serviceOptions = options;
      return new MarketService(options as never);
    },
  }));
  const ctx = await runtimeContext(t);
  const config = validConfig(layout.storageDir, {
    requestTimeoutMs: 12_345,
    providerBatchSize: 17,
    providerConcurrency: 3,
    quoteIntervalMs: 11_000,
    sectorIntervalMs: 70_000,
    sectorPersistIntervalMs: 360_000,
    minuteRetentionTradingDays: 45,
    storageSoftLimitBytes: 400_000_000,
  });

  const fiber = ctx.plugin(custom, config);
  await fiber;

  assert.deepEqual(marketToolNames(ctx), [...TOOL_NAMES]);
  assert.equal(databasePath, `${layout.storageDir}\\market.sqlite`);
  assert.equal(tencentOptions?.requestTimeoutMs, 12_345);
  assert.equal(tencentOptions?.quoteConcurrency, 3);
  assert.equal(sinaOptions?.requestTimeoutMs, 12_345);
  const requestLimiter = tencentOptions?.requestLimiter as { run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> } | undefined;
  assert.notEqual(requestLimiter, undefined);
  assert.equal(sinaOptions?.requestLimiter, requestLimiter);
  assert.equal(schedulerOptions?.quoteIntervalMs, 11_000);
  assert.equal(schedulerOptions?.sectorIntervalMs, 70_000);
  assert.equal(schedulerOptions?.sectorPersistIntervalMs, 360_000);
  assert.equal((serviceOptions?.config as Record<string, unknown>)?.providerBatchSize, 17);
  assert.equal((serviceOptions?.config as Record<string, unknown>)?.minuteRetentionTradingDays, 45);
  assert.equal((serviceOptions?.config as Record<string, unknown>)?.storageSoftLimitBytes, 400_000_000);
  assert.equal(fiber.ctx.fiber.getEffects().filter(({ label }) => label === 'market-intelligence lifecycle').length, 1);

  await fiber.dispose();
  await assert.rejects(
    requestLimiter!.run(new AbortController().signal, async () => undefined),
    { name: 'AbortError' },
  );
  assert.deepEqual(marketToolNames(ctx), []);
  assert.equal(clock.pendingTimers(), 0);
  assert.throws(() => repository?.health(), /closed/i);
});

test('plugin load rejects a missing DSH_HOME before creating storage or network providers', async (t) => {
  const ctx = await runtimeContext(t);
  const previous = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });

  const fiber = ctx.plugin(plugin, validConfig('D:\\AI\\dsh\\storages\\dsh-market-intelligence'));
  await assert.rejects(async () => { await fiber; }, /DSH_HOME/i);
  await fiber.dispose();
});

test('plugin load rejects non-local DSH_HOME forms before any startup side effect', async () => {
  const invalidHomes = [
    '.\\dsh',
    '\\\\server\\share\\dsh',
    '\\\\?\\C:\\dsh',
    'C:\\safe\\..\\dsh',
  ];

  for (const dshHome of invalidHomes) {
    const sideEffects: string[] = [];
    const customApply = plugin.createApply({
      getDshHome: () => dshHome,
      assertSafePath: async () => { sideEffects.push('safe-path'); },
      mkdir: async () => { sideEffects.push('mkdir'); },
      openRepository: () => { sideEffects.push('repository'); throw new Error('repository must not open'); },
      createTencent: () => { sideEffects.push('provider'); throw new Error('provider must not start'); },
    });
    const ctx = { effect: async (callback: () => Promise<unknown>) => callback() } as never;

    await assert.rejects(
      customApply(ctx, validConfig('D:\\AI\\dsh\\storages\\dsh-market-intelligence')),
      /local Windows path/i,
    );
    assert.deepEqual(sideEffects, []);
  }
});

test('plugin load rejects every out-of-bounds or security-expanding config before startup', async (t) => {
  const ctx = await runtimeContext(t);
  let startupCalls = 0;
  const custom = pluginWith(plugin.createApply({
    getDshHome: () => 'D:\\AI\\dsh',
    mkdir: async () => { startupCalls++; },
  }));
  const root = 'D:\\AI\\dsh\\storages\\dsh-market-intelligence';
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['relative storage directory', { storageDir: '.\\dsh-market-intelligence' }],
    ['UNC storage directory', { storageDir: '\\\\server\\share\\dsh-market-intelligence' }],
    ['device storage directory', { storageDir: '\\\\?\\C:\\runtime\\dsh-market-intelligence' }],
    ['traversing storage directory', { storageDir: 'C:\\runtime\\..\\dsh-market-intelligence' }],
    ['timeout low', { requestTimeoutMs: 99 }],
    ['timeout high', { requestTimeoutMs: 120_001 }],
    ['batch zero', { providerBatchSize: 0 }],
    ['batch fractional', { providerBatchSize: 1.5 }],
    ['batch high', { providerBatchSize: 101 }],
    ['concurrency zero', { providerConcurrency: 0 }],
    ['concurrency high', { providerConcurrency: 17 }],
    ['quote interval low', { quoteIntervalMs: 999 }],
    ['quote interval high', { quoteIntervalMs: 300_001 }],
    ['sector interval low', { sectorIntervalMs: 9_999 }],
    ['sector interval high', { sectorIntervalMs: 900_001 }],
    ['persist interval low', { sectorPersistIntervalMs: 59_999 }],
    ['persist interval non-minute', { sectorPersistIntervalMs: 90_000 }],
    ['persist interval high', { sectorPersistIntervalMs: 3_600_001 }],
    ['retention zero', { minuteRetentionTradingDays: 0 }],
    ['retention high', { minuteRetentionTradingDays: 3_651 }],
    ['soft cap zero', { storageSoftLimitBytes: 0 }],
    ['soft cap over 512 MiB', { storageSoftLimitBytes: 536_870_913 }],
    ['watchlist limit is fixed', { watchlistLimit: 99 }],
    ['arbitrary URL is not config', { providerUrl: 'https://example.com/' }],
    ['arbitrary headers are not config', { headers: { authorization: 'secret' } }],
  ];

  for (const [label, override] of invalid) {
    const fiber = ctx.plugin(custom, { ...validConfig(root), ...override } as never);
    await assert.rejects(async () => { await fiber; }, undefined, label);
    await fiber.dispose();
  }
  assert.equal(startupCalls, 0);
});

test('plugin starts and releases cleanly after C, D, and other fixed-drive roots pass safety checks', async () => {
  const cases = [
    ['C:\\Users\\张三\\.dsh', undefined, 'C:\\Users\\张三\\.dsh\\storages\\dsh-market-intelligence'],
    ['D:\\AI\\dsh', undefined, 'D:\\AI\\dsh\\storages\\dsh-market-intelligence'],
    ['Z:\\Research Data\\dsh', 'E:\\Storage\\dsh-market-intelligence', 'E:\\Storage\\dsh-market-intelligence'],
  ] as const;

  for (const [dshHome, storageDir, expectedRoot] of cases) {
    const checked: string[] = [];
    const events: string[] = [];
    const customApply = plugin.createApply({
      getDshHome: () => dshHome,
      assertSafePath: async (current: string) => {
        await assertSafeLocalWindowsPath(current, {
          getDriveTypeImpl: async () => 3,
          lstatImpl: async () => {
            const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
            throw error;
          },
        });
        checked.push(current);
      },
      mkdir: async () => { events.push('mkdir'); },
      loadUserState: async () => { events.push('load state'); return { watchlist: [], closures: {} }; },
      openRepository: () => { events.push('open repository'); return { close() { events.push('close repository'); } } as never; },
      createTencent: () => { events.push('create Tencent'); return quietTencent as never; },
      createSina: () => { events.push('create Sina'); return quietSina as never; },
      createScheduler: () => { events.push('create scheduler'); return {} as never; },
      createService: () => ({ async dispose() { events.push('dispose service'); } }) as never,
      registerTools: () => {
        events.push('register tools');
        return () => events.push('unregister tools');
      },
    });
    const ctx = { effect: async (callback: () => Promise<unknown>) => callback() } as never;
    const config = validConfig(storageDir ?? expectedRoot);
    if (storageDir === undefined) delete config.storageDir;

    const dispose = await customApply(ctx, config);
    assert.deepEqual(checked, [dshHome, expectedRoot]);
    assert.deepEqual(events, [
      'mkdir',
      'load state',
      'open repository',
      'create Tencent',
      'create Sina',
      'create scheduler',
      'register tools',
    ]);

    await dispose();
    assert.deepEqual(events, [
      'mkdir',
      'load state',
      'open repository',
      'create Tencent',
      'create Sina',
      'create scheduler',
      'register tools',
      'unregister tools',
      'dispose service',
    ]);
  }
});

test('partial startup failures unwind only resources already acquired at every stage', async (t) => {
  const stages = ['mkdir', 'loadUserState', 'openRepository', 'createTencent', 'createSina', 'createScheduler', 'createService', 'registerTools'] as const;
  const expectedCleanup: Record<typeof stages[number], string[]> = {
    mkdir: [],
    loadUserState: [],
    openRepository: [],
    createTencent: ['repository-close'],
    createSina: ['repository-close'],
    createScheduler: ['repository-close'],
    createService: ['repository-close'],
    registerTools: ['service-dispose'],
  };

  for (const stage of stages) {
    const ctx = await runtimeContext(t, false);
    const cleanup: string[] = [];
    const fail = (current: typeof stage) => {
      if (stage === current) throw new Error(`failed at ${stage}`);
    };
    const repository = { close() { cleanup.push('repository-close'); } };
    const service = { async dispose() { cleanup.push('service-dispose'); } };
    const custom = pluginWith(plugin.createApply({
      getDshHome: () => 'D:\\AI\\dsh',
      assertSafePath: async () => {},
      mkdir: async () => { fail('mkdir'); },
      loadUserState: async () => { fail('loadUserState'); return { watchlist: [], closures: {} }; },
      openRepository: () => { fail('openRepository'); return repository as never; },
      createTencent: () => { fail('createTencent'); return quietTencent as never; },
      createSina: () => { fail('createSina'); return quietSina as never; },
      createScheduler: () => { fail('createScheduler'); return {} as never; },
      createService: () => { fail('createService'); return service as never; },
      registerTools: () => { fail('registerTools'); return () => cleanup.push('tools-unregister'); },
    }));
    const fiber = ctx.plugin(custom, validConfig('D:\\AI\\dsh\\storages\\dsh-market-intelligence'));
    await assert.rejects(async () => { await fiber; }, new RegExp(`failed at ${stage}`));
    await fiber.dispose();
    await ctx.fiber.dispose();
    assert.deepEqual(cleanup, expectedCleanup[stage], stage);
  }
});

test('the single Cordis lifecycle disposer is idempotent and aggregates tool and service shutdown errors', async (t) => {
  const ctx = await runtimeContext(t);
  const events: string[] = [];
  const customApply = plugin.createApply({
    getDshHome: () => 'D:\\AI\\dsh',
    assertSafePath: async () => {},
    mkdir: async () => {},
    loadUserState: async () => ({ watchlist: [], closures: {} }),
    openRepository: () => ({ close() { events.push('repository-close'); } }) as never,
    createTencent: () => quietTencent as never,
    createSina: () => quietSina as never,
    createScheduler: () => ({} as never),
    createService: () => ({
      async dispose() {
        events.push('service-dispose');
        throw new Error('service cleanup failed');
      },
    }) as never,
    registerTools: () => () => {
      events.push('tools-unregister');
      throw new Error('tool cleanup failed');
    },
  });

  const dispose = await customApply(ctx, validConfig('D:\\AI\\dsh\\storages\\dsh-market-intelligence'));
  await assert.rejects(dispose, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors.map((item) => (item as Error).message), [
      'tool cleanup failed',
      'service cleanup failed',
    ]);
    return true;
  });
  await dispose();
  assert.deepEqual(events, ['tools-unregister', 'service-dispose']);
});

function validConfig(storageDir: string, override: Record<string, unknown> = {}) {
  return {
    storageDir,
    requestTimeoutMs: 10_000,
    providerBatchSize: 100,
    providerConcurrency: 4,
    quoteIntervalMs: 10_000,
    sectorIntervalMs: 60_000,
    sectorPersistIntervalMs: 300_000,
    minuteRetentionTradingDays: 30,
    storageSoftLimitBytes: 536_870_912,
    watchlistLimit: 100,
    ...override,
  };
}

function pluginWith(apply: ReturnType<typeof plugin.createApply>) {
  return { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply };
}

async function runtimeContext(t: TestContext, autoDispose = true): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  if (autoDispose) t.after(async () => { await ctx.fiber.dispose(); });
  return ctx;
}

function marketToolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(({ name }) => name).filter((name) => name.startsWith('market_')).sort();
}

async function tempLayout(t: TestContext): Promise<{ dshHome: string; storageDir: string }> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-plugin-'));
  const dshHome = path.join(root, 'dsh');
  const storageDir = path.join(dshHome, 'storages', 'dsh-market-intelligence');
  await mkdir(dshHome, { recursive: true });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { dshHome, storageDir };
}
