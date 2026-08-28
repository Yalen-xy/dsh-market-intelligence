import { type RequestLimiter, type TimeoutSignalFactory } from '../http.js';
import type { Bar, MarketPhase } from '../model.js';
import type { AuctionResult, MarketProvider, QuoteResult, SeriesRequest, SeriesResult } from './provider.js';
export declare const TENCENT_MINUTE_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1";
export declare const TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq";
export declare const TENCENT_SMARTBOX_URL = "https://smartbox.gtimg.cn/s3/?v=2&q={query}&t=all";
export declare const TENCENT_MAX_QUOTE_SYMBOLS = 100;
export declare const TENCENT_QUOTE_CONCURRENCY = 4;
export type TencentProviderOptions = {
    fetch?: typeof fetch;
    now?: () => number;
    requestTimeoutMs?: number;
    quoteConcurrency?: number;
    requestLimiter?: RequestLimiter;
    timeoutSignal?: TimeoutSignalFactory;
};
export type SearchResult = {
    items: Array<{
        symbol: string;
        name: string;
        market: 'HK';
        currency: 'HKD';
    }>;
};
export declare class TencentProvider implements MarketProvider {
    readonly historyCapabilities: readonly [];
    private readonly fetchImpl;
    private readonly now;
    private readonly requestTimeoutMs;
    private readonly quoteConcurrency;
    private readonly timeoutSignal;
    private readonly requestLimiter;
    constructor(options?: TencentProviderOptions);
    quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult>;
    series(request: SeriesRequest, signal: AbortSignal): Promise<SeriesResult>;
    auction(symbols: string[], phase: MarketPhase, signal: AbortSignal): Promise<AuctionResult>;
    search(query: string, signal: AbortSignal): Promise<SearchResult>;
    private quote;
    private getJson;
}
declare function parseMinuteBars(payload: unknown, symbol: string, market: 'CN' | 'HK'): Bar[];
declare function parseKlineBars(payload: unknown, symbol: string, market: 'CN' | 'HK', interval: 'day' | 'week' | 'month'): Bar[];
export declare const tencentParsing: {
    parseMinuteBars: typeof parseMinuteBars;
    parseKlineBars: typeof parseKlineBars;
};
export {};
