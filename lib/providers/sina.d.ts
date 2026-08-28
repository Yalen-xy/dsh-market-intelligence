import { type RequestLimiter, type TimeoutSignalFactory } from '../http.js';
import type { CanonicalQuote, SectorObservation } from '../model.js';
import type { MarketProvider, QuoteResult, SectorResult } from './provider.js';
export declare const SINA_QUOTE_URL = "https://hq.sinajs.cn/list={symbols}";
export declare const SINA_INDUSTRY_URL = "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php";
export declare const SINA_CONCEPT_URL = "https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class";
export declare const SINA_MAX_QUOTE_SYMBOLS = 100;
export type SinaProviderOptions = {
    fetch?: typeof fetch;
    now?: () => number;
    requestTimeoutMs?: number;
    requestLimiter?: RequestLimiter;
    timeoutSignal?: TimeoutSignalFactory;
};
export declare class SinaProvider implements Pick<MarketProvider, 'quotes' | 'sectors'> {
    readonly historyCapabilities: readonly [];
    private readonly fetchImpl;
    private readonly now;
    private readonly requestTimeoutMs;
    private readonly timeoutSignal;
    private readonly requestLimiter;
    constructor(options?: SinaProviderOptions);
    quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult>;
    sectors(signal: AbortSignal): Promise<SectorResult>;
    private getText;
    private fetchedAt;
}
export declare function parseSinaQuotes(payload: string, fetchedAt: string): CanonicalQuote[];
export declare function parseSinaSectors(payload: string, category: string, fetchedAt: string): SectorObservation[];
