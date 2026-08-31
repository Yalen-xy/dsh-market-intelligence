import type { MarketRuntimeConfig, RuntimePaths, UserState, WatchlistMutation } from './config.js';
import { type RequestLimiter } from './http.js';
import type { MarketProvider } from './providers/provider.js';
import type { SinaProvider, SinaProviderOptions } from './providers/sina.js';
import type { TencentProviderOptions } from './providers/tencent.js';
import type { Clock, MarketSchedulerOptions } from './scheduler.js';
import type { MarketService, MarketServiceOptions, ServiceRepository, ServiceScheduler } from './service.js';
import type { MarketToolsService } from './tool-contracts.js';
type SinaMarketProvider = Pick<MarketProvider, 'quotes'> & {
    sectors(signal: AbortSignal): ReturnType<SinaProvider['sectors']>;
};
type DisposableLimiter = RequestLimiter & {
    dispose(): Promise<void>;
};
export type MarketRuntime = {
    service: MarketToolsService;
    paths: RuntimePaths;
    dispose(): Promise<void>;
};
export type MarketRuntimeOptions = {
    baseDirectory: string;
    assertSafePath(pathValue: string): Promise<void>;
    mkdir(directory: string, options: {
        recursive: true;
    }): Promise<unknown>;
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
export declare function startMarketRuntime(config: MarketRuntimeConfig, options: MarketRuntimeOptions): Promise<MarketRuntime>;
export declare function createSharedRequestLimiter(concurrency: number): DisposableLimiter;
