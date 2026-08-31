export type PluginConfig = {
    enabled?: boolean;
    refreshIntervalMs?: number;
    requestTimeoutMs?: number;
};
export type Config = {
    marketIntelligence?: PluginConfig;
};
export type UserState = {
    watchlist: string[];
    closures: Record<string, {
        CN: string[];
        HK: string[];
    }>;
};
export type RuntimePaths = {
    root: string;
    database: string;
    config: string;
};
export type MarketRuntimeConfig = {
    storageDir?: string;
    requestTimeoutMs: number;
    providerBatchSize: number;
    providerConcurrency: number;
    quoteIntervalMs: number;
    sectorIntervalMs: number;
    sectorPersistIntervalMs: number;
    minuteRetentionTradingDays: number;
    storageSoftLimitBytes: number;
    watchlistLimit: 100;
};
export declare const MARKET_RUNTIME_DEFAULTS: {
    readonly requestTimeoutMs: 10000;
    readonly providerBatchSize: 100;
    readonly providerConcurrency: 4;
    readonly quoteIntervalMs: 10000;
    readonly sectorIntervalMs: 60000;
    readonly sectorPersistIntervalMs: 300000;
    readonly minuteRetentionTradingDays: 30;
    readonly storageSoftLimitBytes: number;
    readonly watchlistLimit: 100;
};
export declare const MARKET_RUNTIME_INTEGER_LIMITS: {
    readonly requestTimeoutMs: {
        readonly minimum: 100;
        readonly maximum: 120000;
    };
    readonly quoteIntervalMs: {
        readonly minimum: 1000;
        readonly maximum: 300000;
    };
    readonly sectorIntervalMs: {
        readonly minimum: 10000;
        readonly maximum: 900000;
    };
};
export type WatchlistMutation = (watchlist: string[]) => string[] | void;
export declare function resolveRuntimePaths(dshHome: string, storageDir?: string): RuntimePaths;
export declare function loadUserState(paths: RuntimePaths): Promise<UserState>;
export declare function mutateWatchlist(paths: RuntimePaths, mutation: WatchlistMutation): Promise<UserState>;
export declare function validateUserState(value: unknown): UserState;
export declare function validateMarketClosures(value: unknown): UserState['closures'];
