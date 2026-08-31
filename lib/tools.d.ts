import type { Context } from '@deepseek-ai/cordis';
import type { RuntimePaths } from './config.js';
import { type MarketToolsService } from './tool-contracts.js';
export type { MarketToolsService } from './tool-contracts.js';
type ToolPaths = Pick<RuntimePaths, 'config'>;
/** Register the canonical market tools in the DSH registry. */
export declare function registerMarketTools(ctx: Context, service: MarketToolsService, paths: ToolPaths): () => void;
