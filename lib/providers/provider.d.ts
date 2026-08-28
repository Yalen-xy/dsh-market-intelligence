import type { Bar, CanonicalQuote, Market, MarketPhase, SectorObservation } from '../model.js';
export type QuoteResult = {
    items: CanonicalQuote[];
};
export type SeriesRequest = {
    symbol: string;
    interval: 'minute' | 'day' | 'week' | 'month';
    count?: number;
};
export type SeriesResult = {
    items: Bar[];
};
export type AuctionResult = {
    phase: MarketPhase;
    items: CanonicalQuote[];
};
export type SectorResult = {
    items: SectorObservation[];
};
export type ProviderHistoryCapability = {
    interval: 'quote';
    markets: readonly Market[];
    maxItems: number;
};
export type ProviderHistoryRequest = {
    market: Market;
    interval: 'quote';
    start: string;
    end: string;
    symbols: string[];
    limit: number;
};
export type ProviderHistoryResult = {
    items: CanonicalQuote[];
    complete: boolean;
};
export interface MarketProvider {
    readonly historyCapabilities?: readonly ProviderHistoryCapability[];
    quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult>;
    series(request: SeriesRequest, signal: AbortSignal): Promise<SeriesResult>;
    auction(symbols: string[], phase: MarketPhase, signal: AbortSignal): Promise<AuctionResult>;
    sectors?(signal: AbortSignal): Promise<SectorResult>;
    backfill?(request: ProviderHistoryRequest, signal: AbortSignal): Promise<ProviderHistoryResult>;
}
