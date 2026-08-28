import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type Schema from '@deepseek-ai/schemastery';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SharedRequestLimiter } from './http.js';
import {
  loadUserState,
  mutateWatchlist,
  resolveRuntimePaths,
  type RuntimePaths,
  type UserState,
  type WatchlistMutation,
} from './config.js';
import type { MarketProvider } from './providers/provider.js';
import { SinaProvider, type SinaProviderOptions } from './providers/sina.js';
import { TencentProvider, type TencentProviderOptions } from './providers/tencent.js';
import { MarketRepository } from './repository.js';
import { MarketScheduler, type Clock, type MarketSchedulerOptions } from './scheduler.js';
import { MarketService, type MarketServiceOptions, type ServiceRepository, type ServiceScheduler } from './service.js';
import { registerMarketTools, type MarketToolsService } from './tools.js';

export const name = 'market-intelligence';
export const inject = ['tools'];

const MEBIBYTE = 1_048_576;
const DEFAULT_STORAGE_SOFT_LIMIT_BYTES = 512 * MEBIBYTE;
const CONFIG_KEYS = new Set([
  'storageDir',
  'requestTimeoutMs',
  'providerBatchSize',
  'providerConcurrency',
  'quoteIntervalMs',
  'sectorIntervalMs',
  'sectorPersistIntervalMs',
  'minuteRetentionTradingDays',
  'storageSoftLimitBytes',
  'watchlistLimit',
]);

export type Config = {
  storageDir?: string;
  requestTimeoutMs?: number;
  providerBatchSize?: number;
  providerConcurrency?: number;
  quoteIntervalMs?: number;
  sectorIntervalMs?: number;
  sectorPersistIntervalMs?: number;
  minuteRetentionTradingDays?: number;
  storageSoftLimitBytes?: number;
  watchlistLimit?: 100;
};

type RuntimeConfig = Required<Omit<Config, 'storageDir'>> & Pick<Config, 'storageDir'>;

const ConfigShape = z.object({
  storageDir: z.string(),
  requestTimeoutMs: z.natural().min(100).max(120_000).default(10_000),
  providerBatchSize: z.natural().min(1).max(100).default(100),
  providerConcurrency: z.natural().min(1).max(16).default(4),
  quoteIntervalMs: z.natural().min(1_000).max(300_000).default(10_000),
  sectorIntervalMs: z.natural().min(10_000).max(900_000).default(60_000),
  sectorPersistIntervalMs: z.natural().min(60_000).max(3_600_000).step(60_000).default(300_000),
  minuteRetentionTradingDays: z.natural().min(1).max(3_650).default(30),
  storageSoftLimitBytes: z.natural().min(1).max(DEFAULT_STORAGE_SOFT_LIMIT_BYTES).default(DEFAULT_STORAGE_SOFT_LIMIT_BYTES),
  watchlistLimit: z.const(100).default(100),
});

export const Config: Schema<unknown, RuntimeConfig> = z.transform(
  z.intersect([z.dict(z.any()), ConfigShape]),
  (value) => validateConfig(value as Record<string, unknown>),
  true,
) as Schema<unknown, RuntimeConfig>;

type SinaMarketProvider = Pick<MarketProvider, 'quotes'> & {
  sectors(signal: AbortSignal): ReturnType<SinaProvider['sectors']>;
};

export type PluginDependencies = {
  getDshHome(): string | undefined;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  loadUserState(paths: RuntimePaths): Promise<UserState>;
  mutateWatchlist(paths: RuntimePaths, mutation: WatchlistMutation): Promise<UserState>;
  openRepository(databasePath: string): ServiceRepository;
  createTencent(options: TencentProviderOptions): MarketProvider;
  createSina(options: SinaProviderOptions): SinaMarketProvider;
  createScheduler(options: MarketSchedulerOptions): ServiceScheduler;
  createService(options: MarketServiceOptions): MarketService;
  registerTools(ctx: Context, service: MarketToolsService, paths: RuntimePaths): () => void;
  clock: Clock;
};

const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

const defaultDependencies: PluginDependencies = {
  getDshHome: () => process.env.DSH_HOME,
  mkdir,
  loadUserState,
  mutateWatchlist,
  openRepository: (databasePath) => MarketRepository.open(databasePath),
  createTencent: (options) => new TencentProvider(options),
  createSina: (options) => new SinaProvider(options),
  createScheduler: (options) => new MarketScheduler(options),
  createService: (options) => new MarketService(options),
  registerTools: registerMarketTools,
  clock: systemClock,
};

export function createApply(overrides: Partial<PluginDependencies> = {}) {
  const dependencies: PluginDependencies = { ...defaultDependencies, ...overrides };
  return async function applyWithDependencies(ctx: Context, rawConfig: Config): Promise<() => Promise<void>> {
    const config = Config(rawConfig);
    const dshHome = requireDshHome(dependencies.getDshHome());
    const paths = resolveRuntimePaths(dshHome, config.storageDir);
    return ctx.effect(
      async () => startLifecycle(ctx, config, paths, dependencies),
      'market-intelligence lifecycle',
    );
  };
}

const productionApply = createApply();

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  return productionApply(ctx, config);
}

async function startLifecycle(
  ctx: Context,
  config: RuntimeConfig,
  paths: RuntimePaths,
  dependencies: PluginDependencies,
): Promise<() => Promise<void>> {
  let repository: ServiceRepository | undefined;
  let service: MarketService | undefined;
  let unregisterTools: (() => void) | undefined;
  let requestLimiter: SharedRequestLimiter | undefined;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    if (unregisterTools) {
      try {
        unregisterTools();
      } catch (error) {
        errors.push(error);
      }
    }
    let limiterDrain: Promise<void> | undefined;
    if (requestLimiter) {
      try {
        limiterDrain = requestLimiter.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (service) {
      try {
        await service.dispose();
      } catch (error) {
        errors.push(error);
      }
    } else if (repository) {
      try {
        repository.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (limiterDrain) {
      try {
        await limiterDrain;
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors);
  };

  try {
    await dependencies.mkdir(paths.root, { recursive: true });
    const initialState = await dependencies.loadUserState(paths);
    repository = dependencies.openRepository(paths.database);
    requestLimiter = new SharedRequestLimiter(config.providerConcurrency);
    const now = () => dependencies.clock.now().getTime();
    const tencent = dependencies.createTencent({
      now,
      requestTimeoutMs: config.requestTimeoutMs,
      quoteConcurrency: config.providerConcurrency,
      requestLimiter,
    });
    const sina = dependencies.createSina({ now, requestTimeoutMs: config.requestTimeoutMs, requestLimiter });
    const scheduler = dependencies.createScheduler({
      clock: dependencies.clock,
      closures: initialState.closures,
      quoteIntervalMs: config.quoteIntervalMs,
      sectorIntervalMs: config.sectorIntervalMs,
      sectorPersistIntervalMs: config.sectorPersistIntervalMs,
    });
    service = dependencies.createService({
      clock: dependencies.clock,
      tencent,
      sina,
      repository,
      scheduler,
      stateStore: {
        mutateWatchlist: (mutation) => dependencies.mutateWatchlist(paths, mutation),
      },
      initialState,
      config: {
        providerBatchSize: config.providerBatchSize,
        minuteRetentionTradingDays: config.minuteRetentionTradingDays,
        storageSoftLimitBytes: config.storageSoftLimitBytes,
      },
    });
    unregisterTools = dependencies.registerTools(ctx, service, paths);
    return dispose;
  } catch (startupError) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([startupError, ...cleanupErrors(cleanupError)], 'market-intelligence startup and rollback failed');
    }
    throw startupError;
  }
}

function validateConfig(value: Record<string, unknown>): RuntimeConfig {
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`market-intelligence: unknown config field ${key}`);
  }
  const storageDir = value.storageDir === undefined ? undefined : requireStorageDir(value.storageDir);
  return {
    ...(storageDir === undefined ? {} : { storageDir }),
    requestTimeoutMs: requireBoundedInteger(value.requestTimeoutMs, 100, 120_000, 'requestTimeoutMs'),
    providerBatchSize: requireBoundedInteger(value.providerBatchSize, 1, 100, 'providerBatchSize'),
    providerConcurrency: requireBoundedInteger(value.providerConcurrency, 1, 16, 'providerConcurrency'),
    quoteIntervalMs: requireBoundedInteger(value.quoteIntervalMs, 1_000, 300_000, 'quoteIntervalMs'),
    sectorIntervalMs: requireBoundedInteger(value.sectorIntervalMs, 10_000, 900_000, 'sectorIntervalMs'),
    sectorPersistIntervalMs: requireWholeMinute(value.sectorPersistIntervalMs),
    minuteRetentionTradingDays: requireBoundedInteger(value.minuteRetentionTradingDays, 1, 3_650, 'minuteRetentionTradingDays'),
    storageSoftLimitBytes: requireBoundedInteger(value.storageSoftLimitBytes, 1, DEFAULT_STORAGE_SOFT_LIMIT_BYTES, 'storageSoftLimitBytes'),
    watchlistLimit: requireFixedWatchlistLimit(value.watchlistLimit),
  };
}

function requireDshHome(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('DSH_HOME must be a non-empty absolute D-drive path');
  return requireAbsoluteDPath(value, 'DSH_HOME');
}

function requireStorageDir(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('storageDir must be a non-empty absolute D-drive path');
  const normalized = requireAbsoluteDPath(value, 'storageDir');
  if (path.win32.basename(normalized).toLowerCase() !== 'dsh-market-intelligence') {
    throw new Error('storageDir must be the final dsh-market-intelligence plugin root');
  }
  return normalized;
}

function requireAbsoluteDPath(value: string, label: string): string {
  if (!path.win32.isAbsolute(value) || path.win32.parse(value).root.toUpperCase() !== 'D:\\') {
    throw new Error(`${label} must be an absolute D-drive path`);
  }
  const normalized = path.win32.normalize(value);
  if (normalized !== value) throw new Error(`${label} must be a normalized path`);
  return normalized;
}

function requireBoundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function requireWholeMinute(value: unknown): number {
  const interval = requireBoundedInteger(value, 60_000, 3_600_000, 'sectorPersistIntervalMs');
  if (interval % 60_000 !== 0) throw new Error('sectorPersistIntervalMs must use whole-minute increments');
  return interval;
}

function requireFixedWatchlistLimit(value: unknown): 100 {
  if (value !== 100) throw new Error('watchlistLimit is fixed at 100');
  return 100;
}

function throwCleanupErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'market-intelligence disposal failed');
}

function cleanupErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}
