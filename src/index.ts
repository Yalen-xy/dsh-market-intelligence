import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type Schema from '@deepseek-ai/schemastery';
import {
  loadUserState,
  mutateWatchlist,
  type RuntimePaths,
} from './config.js';
import { mkdir } from 'node:fs/promises';
import { SinaProvider } from './providers/sina.js';
import { TencentProvider } from './providers/tencent.js';
import { MarketRepository } from './repository.js';
import { MarketScheduler, type Clock } from './scheduler.js';
import { MarketService } from './service.js';
import { registerMarketTools, type MarketToolsService } from './tools.js';
import { assertSafeLocalWindowsPath, requireLocalWindowsPath } from './paths.js';
import { createSharedRequestLimiter, startMarketRuntime, type MarketRuntimeConfig, type MarketRuntimeOptions } from './runtime.js';

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

type RuntimeConfig = MarketRuntimeConfig;

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

export type PluginDependencies = Omit<MarketRuntimeOptions, 'baseDirectory'> & {
  getDshHome(): string | undefined;
  registerTools(ctx: Context, service: MarketToolsService, paths: RuntimePaths): () => void;
};

const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

const defaultDependencies: PluginDependencies = {
  getDshHome: () => resolveDshBaseDirectory(process.env),
  assertSafePath: assertSafeLocalWindowsPath,
  mkdir,
  loadUserState,
  mutateWatchlist,
  openRepository: (databasePath) => MarketRepository.open(databasePath),
  createRequestLimiter: createSharedRequestLimiter,
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
    return ctx.effect(
      async () => startLifecycle(ctx, config, dshHome, dependencies),
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
  dshHome: string,
  dependencies: PluginDependencies,
): Promise<() => Promise<void>> {
  const { getDshHome: _getDshHome, registerTools, ...runtimeOptions } = dependencies;
  const runtime = await startMarketRuntime(config, { ...runtimeOptions, baseDirectory: dshHome });
  let unregisterTools: (() => void) | undefined;
  try {
    unregisterTools = registerTools(ctx, runtime.service, runtime.paths);
  } catch (registrationError) {
    try {
      await runtime.dispose();
    } catch (cleanupError) {
      throw new AggregateError([registrationError, ...cleanupErrors(cleanupError)], 'market-intelligence tool registration and rollback failed');
    }
    throw registrationError;
  }
  let disposal: Promise<void> | undefined;
  return () => {
    if (disposal) return disposal;
    disposal = (async () => {
      const errors: unknown[] = [];
      try {
        unregisterTools?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        await runtime.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwCleanupErrors(errors);
    })();
    return disposal;
  };
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
  if (typeof value !== 'string' || value.trim() === '') throw new Error('DSH_HOME must be a non-empty normalized absolute local Windows path');
  return requireLocalWindowsPath(value, 'DSH_HOME');
}

export function resolveDshBaseDirectory(environment: NodeJS.ProcessEnv): string {
  return requireDshHome(environment.DSH_HOME);
}

function requireStorageDir(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('storageDir must be a non-empty normalized absolute local Windows path');
  return requireLocalWindowsPath(value, 'storageDir', 'dsh-market-intelligence');
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
