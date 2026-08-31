import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
import { type RuntimePaths } from './config.js';
import { type MarketToolsService } from './tools.js';
import { type MarketRuntimeConfig, type MarketRuntimeOptions } from './runtime.js';
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
type RuntimeConfig = MarketRuntimeConfig;
export declare const Config: Schema<unknown, RuntimeConfig>;
export type PluginDependencies = Omit<MarketRuntimeOptions, 'baseDirectory'> & {
    getDshHome(): string | undefined;
    registerTools(ctx: Context, service: MarketToolsService, paths: RuntimePaths): () => void;
};
export declare function createApply(overrides?: Partial<PluginDependencies>): (ctx: Context, rawConfig: Config) => Promise<() => Promise<void>>;
export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
export {};
