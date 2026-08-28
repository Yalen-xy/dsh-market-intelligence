export type Market = 'CN' | 'HK';
export type MarketPhase = 'auction' | 'preopen' | 'continuous' | 'lunch' | 'closed';
export type CanonicalQuote = {
    symbol: string;
    name: string | null;
    market: Market;
    currency: 'CNY' | 'HKD';
    price: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    previousClose: number | null;
    volume: number | null;
    amount: number | null;
    change: number | null;
    changePercent: number | null;
    marketTime: string | null;
    fetchedAt: string;
    source: string;
    isDelayed: boolean;
    isStale: boolean;
};
export type Bar = {
    symbol: string;
    market: Market;
    interval: string;
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
    turnover: number | null;
};
export type SectorObservation = {
    id: string;
    name: string;
    category: string;
    changePercent: number | null;
    turnover: number | null;
    netFlow: number | null;
    leaderSymbol: string | null;
    leaderName: string | null;
    leaderChangePercent: number | null;
    marketTime: string | null;
    fetchedAt: string;
    source: string;
    isDelayed: boolean;
    isStale: boolean;
};
export type ProviderHealth = {
    provider: string;
    available: boolean;
    latencyMs: number | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    error: string | null;
};
export type Availability = 'live' | 'cached' | 'stale' | 'unavailable';
export type SourceConflict = {
    symbol: string;
    field: string;
    observations: Array<{
        source: string;
        marketTime: string | null;
        value: number | string | null;
    }>;
    detectedAt: string;
};
