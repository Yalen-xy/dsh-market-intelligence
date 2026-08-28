import type { Context } from '@deepseek-ai/cordis';
import type { RuntimePaths } from './config.js';
import type { MarketService } from './service.js';
export type MarketToolsService = Pick<MarketService, 'status' | 'quotes' | 'series' | 'sectors' | 'auction' | 'watchlist' | 'health'>;
type ToolPaths = Pick<RuntimePaths, 'config'>;
/** Register the seven model-visible market tools and return their sole lifecycle disposer. */
export declare function registerMarketTools(ctx: Context, service: MarketToolsService, paths: ToolPaths): () => void;
export {};
