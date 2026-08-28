import { type UserState, type WatchlistMutation } from './config.js';
import type { Availability, Bar, CanonicalQuote, Market, MarketPhase, SectorObservation, SourceConflict } from './model.js';
import type { MarketProvider, SectorResult } from './providers/provider.js';
import { type MaintenanceResult, type RetentionPolicy } from './retention.js';
import { type CollectionGap, type ProviderHealthUpdate, type RecoveryCursorSeed, type RecoverySegmentCommit, type RepositoryHealth, type SectorQuery, type SectorResolution, type SeriesQuery } from './repository.js';
import type { Clock, SchedulerCallbacks } from './scheduler.js';
type SinaProvider = Pick<MarketProvider, 'quotes'> & {
    sectors(signal: AbortSignal): Promise<SectorResult>;
};
export type ServiceRepository = {
    writeBatch(quotes: CanonicalQuote[]): void;
    latestQuotes(symbols: string[]): CanonicalQuote[];
    writeBars(bars: Bar[]): void;
    querySeries(query: SeriesQuery): Bar[];
    writeSectors(sectors: SectorObservation[], resolution?: SectorResolution): void;
    readSectors(query?: SectorQuery): SectorObservation[];
    updateProviderHealth(update: ProviderHealthUpdate): void;
    recordGap?(gap: CollectionGap): void;
    initializeRecoveryCursors?(provider: string, interval: 'quote', seeds: RecoveryCursorSeed[], updatedAt: string): void;
    recoveryCursor?(provider: string, market: Market, interval: 'quote'): string | null;
    commitRecoverySegment?(segment: RecoverySegmentCommit): void;
    health(): RepositoryHealth;
    close(): void;
};
export type ServiceStateStore = {
    mutateWatchlist(mutation: WatchlistMutation): Promise<UserState>;
};
export type ServiceScheduler = {
    start(callbacks: SchedulerCallbacks): () => Promise<void>;
    health?(): {
        pendingTimers?: number;
        inFlight?: number;
    };
};
export type MarketServiceConfig = {
    providerBatchSize?: number;
    quoteFreshnessMs?: number;
    sectorFreshnessMs?: number;
    conflictComparableWindowMs?: number;
    minuteRetentionTradingDays?: number;
    storageSoftLimitBytes?: number;
};
export type MaintenanceRunner = (repository: ServiceRepository, policy: RetentionPolicy, now: Date) => MaintenanceResult | Promise<MaintenanceResult>;
export type MarketServiceOptions = {
    clock: Pick<Clock, 'now'>;
    tencent: MarketProvider;
    sina: SinaProvider;
    repository: ServiceRepository;
    scheduler: ServiceScheduler;
    stateStore: ServiceStateStore;
    initialState: UserState;
    config?: MarketServiceConfig;
    maintenance?: MaintenanceRunner;
};
export type StatusRequest = {
    market?: Market;
};
export type StatusResult = {
    asOf: string;
    collectionActive: boolean;
    lastSuccessfulUpdate: string | null;
    markets: Array<{
        market: Market;
        phase: MarketPhase;
        tradingDate: string;
        sessionStart: string | null;
        sessionEnd: string | null;
        collectionActive: boolean;
        calendarConfidence: 'configured' | 'degraded';
    }>;
};
export type QuotesRequest = {
    symbols?: string[];
    refresh?: boolean;
};
export type QuotesResult = {
    availability: Availability;
    items: CanonicalQuote[];
    conflicts: SourceConflict[];
};
export type ServiceSeriesRequest = {
    symbol: string;
    interval: 'minute' | 'day' | 'week' | 'month';
    refresh?: boolean;
    start?: string;
    end?: string;
    adjustment?: 'qfq';
    limit?: number;
};
export type SeriesResult = {
    availability: Availability;
    source: 'storage' | 'provider' | 'both' | null;
    items: Bar[];
};
export type SectorsRequest = {
    category?: string;
    sort?: 'changePercent' | 'turnover' | 'netFlow';
    direction?: 'asc' | 'desc';
    limit?: number;
    refresh?: boolean;
};
export type SectorsResult = {
    availability: Availability;
    items: SectorObservation[];
};
export type AuctionRequest = {
    market: Market;
    symbols?: string[];
};
export type AuctionServiceResult = {
    availability: Availability;
    phase: MarketPhase;
    reason: string | null;
    items: CanonicalQuote[];
};
export type WatchlistRequest = {
    action: 'get' | 'add' | 'remove';
    symbol?: string;
};
export type WatchlistResult = {
    watchlist: string[];
};
export type ProviderServiceHealth = {
    provider: string;
    available: boolean;
    latencyMs: number | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    errorCategory: ErrorCategory | null;
};
export type HealthResult = {
    providers: ProviderServiceHealth[];
    scheduler: {
        state: 'running' | 'stopping' | 'stopped';
        pendingTimers: number | null;
        inFlight: number | null;
    };
    database: {
        databaseBytes: number;
        liveDatabaseBytes: number;
        counts: RepositoryHealth['counts'];
    };
    gaps: RepositoryHealth['gaps'];
    retention: {
        status: 'ok' | 'over-cap' | 'unknown';
        lastResult: Record<string, unknown> | null;
    };
};
type ErrorCategory = 'timeout' | 'abort' | 'http' | 'decode' | 'parse' | 'storage' | 'network' | 'validation' | 'partial' | 'unknown';
export declare class MarketService {
    private readonly clock;
    private readonly tencent;
    private readonly sina;
    private readonly repository;
    private readonly scheduler;
    private readonly stateStore;
    private readonly config;
    private readonly maintenanceRunner;
    private readonly providerHealth;
    private readonly lifecycle;
    private readonly directOperations;
    private readonly quoteWriteStates;
    private readonly attemptSequences;
    private readonly appliedAttemptSequences;
    private readonly cancelScheduler;
    private readonly recoveryAnchor;
    private readonly recoveryEnd;
    private readonly recoveryOperations;
    private readonly recoveredMarkets;
    private watchlistSnapshot;
    private closures;
    private watchlistQueue;
    private sectorCache;
    private sectorCacheIsLive;
    private lastSuccessfulUpdate;
    private lastMaintenance;
    private disposing;
    private disposed;
    private disposal;
    constructor(options: MarketServiceOptions);
    status(request?: StatusRequest): StatusResult;
    quotes(request: QuotesRequest | undefined, requestSignal: AbortSignal): Promise<QuotesResult>;
    private quotesOperation;
    series(request: ServiceSeriesRequest, requestSignal: AbortSignal): Promise<SeriesResult>;
    private seriesOperation;
    sectors(request: SectorsRequest | undefined, requestSignal: AbortSignal): Promise<SectorsResult>;
    private sectorsOperation;
    auction(request: AuctionRequest, requestSignal: AbortSignal): Promise<AuctionServiceResult>;
    private auctionOperation;
    watchlist(request: WatchlistRequest, requestSignal?: AbortSignal): Promise<WatchlistResult>;
    private watchlistOperation;
    health(): HealthResult;
    collectQuotes(markets: Market[], requestSignal: AbortSignal): Promise<{
        marketTimes: Partial<Record<Market, string | null>>;
        commit(markets: Market[], signal: AbortSignal): Promise<void>;
        release(): Promise<void>;
    }>;
    private collectQuotesOperation;
    collectSectors(requestSignal: AbortSignal, persist: boolean): Promise<void>;
    private collectSectorsOperation;
    maintain(market?: Market, closedTradingDate?: string, requestSignal?: AbortSignal): Promise<MaintenanceResult>;
    private maintainOperation;
    private recoverDowntime;
    private recoverDowntimeOperation;
    private bootstrapRecoveryCursors;
    private readRecoveryCursor;
    private commitRecoverySegment;
    dispose(): Promise<void>;
    private trackDirect;
    private acquireQuoteWrite;
    private writeAdmittedQuotes;
    private sealQuoteWritesAndWait;
    private refreshQuotes;
    private fetchProviderQuotes;
    private cachedQuotes;
    private withStorageHealth;
    private readRepositoryHealth;
    private recordStorageFailure;
    private beginAttempt;
    private finishAttempt;
    private now;
    private assertUsable;
}
export {};
