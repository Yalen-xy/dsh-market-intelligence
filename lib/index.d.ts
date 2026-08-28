import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
import { type RuntimePaths, type UserState, type WatchlistMutation } from './config.js';
import type { MarketProvider } from './providers/provider.js';
import { SinaProvider, type SinaProviderOptions } from './providers/sina.js';
import { type TencentProviderOptions } from './providers/tencent.js';
import { type Clock, type MarketSchedulerOptions } from './scheduler.js';
import { MarketService, type MarketServiceOptions, type ServiceRepository, type ServiceScheduler } from './service.js';
import { type MarketToolsService } from './tools.js';
export declare const name = "market-intelligence";
export declare const inject: string[];
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
export declare const Config: Schema<unknown, RuntimeConfig>;
type SinaMarketProvider = Pick<MarketProvider, 'quotes'> & {
    sectors(signal: AbortSignal): ReturnType<SinaProvider['sectors']>;
};
export type PluginDependencies = {
    getDshHome(): string | undefined;
    mkdir(directory: string, options: {
        recursive: true;
    }): Promise<unknown>;
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
export declare function createApply(overrides?: Partial<PluginDependencies>): (ctx: Context, rawConfig: Config) => Promise<() => Promise<void>>;
export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
export {};
