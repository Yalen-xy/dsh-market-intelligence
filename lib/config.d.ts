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
export type WatchlistMutation = (watchlist: string[]) => string[] | void;
export declare function resolveRuntimePaths(dshHome: string, storageDir?: string): RuntimePaths;
export declare function loadUserState(paths: RuntimePaths): Promise<UserState>;
export declare function mutateWatchlist(paths: RuntimePaths, mutation: WatchlistMutation): Promise<UserState>;
export declare function validateUserState(value: unknown): UserState;
export declare function validateMarketClosures(value: unknown): UserState['closures'];
