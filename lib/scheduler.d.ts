import { type MarketClosures } from './calendar.js';
import type { Market } from './model.js';
export type Clock = {
    now(): Date;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timer: unknown): void;
};
export type QuoteCollectionResult = {
    marketTimes?: Partial<Record<Market, string | null>>;
    commit?(markets: Market[], signal: AbortSignal): Promise<void>;
    release?(): Promise<void> | void;
} | void;
export type SchedulerCallbacks = {
    collectQuotes(markets: Market[], signal: AbortSignal): Promise<QuoteCollectionResult>;
    collectSectors(signal: AbortSignal, persist: boolean): Promise<void>;
    runMaintenance(market: Market, tradingDate: string, signal: AbortSignal): Promise<void>;
};
export type MarketSchedulerOptions = {
    clock: Clock;
    closures?: MarketClosures;
    quoteIntervalMs?: number;
    sectorIntervalMs?: number;
    sectorPersistIntervalMs?: number;
    jitterMs?: (backoffMs: number) => number;
};
export declare class MarketScheduler {
    private readonly clock;
    private readonly closures;
    private readonly quoteIntervalMs;
    private readonly sectorIntervalMs;
    private readonly sectorPersistIntervalMs;
    private readonly jitterMs;
    private readonly nextQuoteAt;
    private readonly failures;
    private readonly marketTimes;
    private readonly maintained;
    private readonly pendingMaintenance;
    private readonly runningMaintenance;
    private readonly inFlight;
    private callbacks;
    private controller;
    private quoteTimer;
    private sectorTimer;
    private lastSectorBucket;
    private sectorFailures;
    private quoteTickRunning;
    private stopped;
    private disposal;
    constructor(options: MarketSchedulerOptions);
    start(callbacks: SchedulerCallbacks): () => Promise<void>;
    health(): {
        pendingTimers: number;
        inFlight: number;
    };
    private launchQuoteTick;
    private launchSectorTick;
    private quoteTick;
    private sectorTick;
    private recordQuoteResult;
    private recordQuoteFailure;
    private scheduleNextQuoteTick;
    private scheduleInitialSectorTick;
    private scheduleNextSectorTick;
    private scheduleQuote;
    private scheduleSector;
    private queueOutstandingMaintenance;
    private runPendingMaintenance;
    private runMaintenance;
    private sectorBucket;
    private backoffDelay;
    private safeJitter;
    private track;
    private dispose;
}
