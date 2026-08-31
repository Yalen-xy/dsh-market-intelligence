import type { RuntimePaths } from './config.js';
import type { MarketService } from './service.js';
export type MarketToolsService = Pick<MarketService, 'status' | 'quotes' | 'series' | 'sectors' | 'auction' | 'watchlist' | 'health'>;
export type MarketToolName = 'market_auction' | 'market_data_health' | 'market_quotes' | 'market_sectors' | 'market_series' | 'market_status' | 'market_watchlist';
export type JsonSchemaObject = Readonly<Record<string, unknown>> & {
    readonly type: 'object';
    readonly additionalProperties: false;
};
export type MarketToolCallContext = {
    signal: AbortSignal;
};
export type MarketToolContract = {
    readonly name: MarketToolName;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
    readonly outputSchema: JsonSchemaObject;
    execute(args: unknown, context: MarketToolCallContext): Promise<unknown>;
};
export declare class MarketToolArgsError extends Error {
    readonly issues: readonly string[];
    constructor(issues: readonly string[]);
}
export declare class MarketToolOutputError extends Error {
    readonly issues: readonly string[];
    constructor(issues: readonly string[]);
}
type ToolPaths = Pick<RuntimePaths, 'config'>;
export declare function createMarketToolContracts(service: MarketToolsService, _paths: ToolPaths): readonly MarketToolContract[];
export {};
