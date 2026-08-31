import type { MarketRuntimeConfig, RuntimePaths, UserState, WatchlistMutation } from './config.js';
import { resolveRuntimePaths } from './config.js';
import { SharedRequestLimiter, type RequestLimiter } from './http.js';
import type { MarketProvider } from './providers/provider.js';
import type { SinaProvider, SinaProviderOptions } from './providers/sina.js';
import type { TencentProvider, TencentProviderOptions } from './providers/tencent.js';
import type { Clock, MarketSchedulerOptions } from './scheduler.js';
import type { MarketService, MarketServiceOptions, ServiceRepository, ServiceScheduler } from './service.js';
import type { MarketToolsService } from './tool-contracts.js';

type SinaMarketProvider = Pick<MarketProvider, 'quotes'> & {
  sectors(signal: AbortSignal): ReturnType<SinaProvider['sectors']>;
};

type DisposableLimiter = RequestLimiter & { dispose(): Promise<void> };
type DisposableService = MarketToolsService & { dispose(): Promise<void> };
type CleanupOutcome = { failed: false } | { failed: true; error: unknown };

export type MarketRuntime = {
  service: MarketToolsService;
  paths: RuntimePaths;
  dispose(): Promise<void>;
};

export type MarketRuntimeOptions = {
  baseDirectory: string;
  assertSafePath(pathValue: string): Promise<void>;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  loadUserState(paths: RuntimePaths): Promise<UserState>;
  mutateWatchlist(paths: RuntimePaths, mutation: WatchlistMutation): Promise<UserState>;
  openRepository(databasePath: string): ServiceRepository;
  createRequestLimiter(concurrency: number): DisposableLimiter;
  createTencent(options: TencentProviderOptions): MarketProvider;
  createSina(options: SinaProviderOptions): SinaMarketProvider;
  createScheduler(options: MarketSchedulerOptions): ServiceScheduler;
  createService(options: MarketServiceOptions): MarketService;
  clock: Clock;
};

export type { MarketRuntimeConfig } from './config.js';

export async function startMarketRuntime(
  config: MarketRuntimeConfig,
  options: MarketRuntimeOptions,
): Promise<MarketRuntime> {
  const paths = resolveRuntimePaths(options.baseDirectory, config.storageDir);
  let repository: ServiceRepository | undefined;
  let requestLimiter: DisposableLimiter | undefined;
  let service: DisposableService | undefined;
  let disposal: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      const errors: unknown[] = [];
      let limiterDrain: Promise<CleanupOutcome> | undefined;
      if (requestLimiter) {
        try {
          limiterDrain = requestLimiter.dispose().then<CleanupOutcome, CleanupOutcome>(
            () => ({ failed: false }),
            (error) => ({ failed: true, error }),
          );
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
        const outcome = await limiterDrain;
        if (outcome.failed) errors.push(outcome.error);
      }
      throwCleanupErrors(errors);
    })();
    return disposal;
  };

  try {
    await options.assertSafePath(options.baseDirectory);
    await options.assertSafePath(paths.root);
    await options.mkdir(paths.root, { recursive: true });
    const initialState = await options.loadUserState(paths);
    repository = options.openRepository(paths.database);
    requestLimiter = options.createRequestLimiter(config.providerConcurrency);
    const now = () => options.clock.now().getTime();
    const tencent = options.createTencent({
      now,
      requestTimeoutMs: config.requestTimeoutMs,
      quoteConcurrency: config.providerConcurrency,
      requestLimiter,
    });
    const sina = options.createSina({ now, requestTimeoutMs: config.requestTimeoutMs, requestLimiter });
    const scheduler = options.createScheduler({
      clock: options.clock,
      closures: initialState.closures,
      quoteIntervalMs: config.quoteIntervalMs,
      sectorIntervalMs: config.sectorIntervalMs,
      sectorPersistIntervalMs: config.sectorPersistIntervalMs,
    });
    service = options.createService({
      clock: options.clock,
      tencent,
      sina,
      repository,
      scheduler,
      stateStore: {
        mutateWatchlist: (mutation) => options.mutateWatchlist(paths, mutation),
      },
      initialState,
      config: {
        providerBatchSize: config.providerBatchSize,
        minuteRetentionTradingDays: config.minuteRetentionTradingDays,
        storageSoftLimitBytes: config.storageSoftLimitBytes,
      },
    });
    return { service, paths, dispose };
  } catch (startupError) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([startupError, ...cleanupErrors(cleanupError)], 'market-intelligence startup and rollback failed');
    }
    throw startupError;
  }
}

export function createSharedRequestLimiter(concurrency: number): DisposableLimiter {
  return new SharedRequestLimiter(concurrency);
}

function throwCleanupErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'market-intelligence disposal failed');
}

function cleanupErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}
