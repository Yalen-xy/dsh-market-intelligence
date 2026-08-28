import type { Bar, CanonicalQuote, Market, SectorObservation } from './model.js';
export type SeriesQuery = {
    symbol: string;
    interval: string;
    start?: string;
    end?: string;
    limit?: number;
};
export type SectorQuery = {
    category?: string;
    resolution?: SectorResolution;
    limit?: number;
};
export type SectorResolution = 'intraday' | 'daily';
export type CollectionGap = {
    market: Market;
    symbol: string | null;
    interval: string;
    start: string;
    end: string;
    reason: string;
    recordedAt: string;
};
export type RecoverySegmentCommit = {
    provider: string;
    market: Market;
    interval: 'quote';
    start: string;
    end: string;
    completedAt: string;
    items: CanonicalQuote[];
    gap: CollectionGap | null;
};
export type RecoveryCursorSeed = {
    market: Market;
    cursor: string;
};
export type ProviderHealthUpdate = {
    provider: string;
    available: boolean;
    latencyMs: number | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    error: string | null;
};
export type MaintenanceRecord = {
    runAt: string;
    completedAt: string;
    result: Record<string, unknown>;
};
export type RepositoryCounts = {
    quoteObservations: number;
    minuteBars: number;
    dailyBars: number;
    sectorObservations: number;
    sectorDailySummaries: number;
};
export type RepositoryHealth = {
    databaseBytes: number;
    liveDatabaseBytes: number;
    providers: ProviderHealthUpdate[];
    gaps: CollectionGap[];
    lastMaintenance: Record<string, unknown> | null;
    counts: RepositoryCounts;
};
export type RepositoryMaintenanceAccess = {
    rawTradingDates(market: Market): string[];
    rawQuotes(market: Market, tradingDate: string): CanonicalQuote[];
    upsertBars(bars: Bar[]): void;
    deleteRawSymbols(market: Market, tradingDate: string, symbols: string[]): number;
    recordGap(gap: CollectionGap): void;
    sectorIntradayDates(): string[];
    sectorIntraday(tradingDate: string): SectorObservation[];
    upsertSectors(sectors: SectorObservation[], resolution: SectorResolution): number;
    minuteTradingDates(market?: Market): string[];
    deleteMinuteDate(tradingDate: string, market?: Market): number;
    oldestMinuteTradingDate(): string | null;
    oldestSectorBucket(): string | null;
    deleteSectorBucket(bucket: string): number;
    liveDatabaseBytes(): number;
    attemptMutation<T>(operation: () => T, accept: (value: T) => boolean): {
        committed: boolean;
        value: T;
    };
    recordMaintenance(record: MaintenanceRecord): void;
};
export declare class MarketRepository {
    readonly path: string;
    private readonly database;
    private closed;
    private constructor();
    static open(path: string): MarketRepository;
    writeBatch(quotes: CanonicalQuote[]): void;
    initializeRecoveryCursors(provider: string, interval: 'quote', seeds: RecoveryCursorSeed[], updatedAt: string): void;
    recoveryCursor(provider: string, market: Market, interval: 'quote'): string | null;
    commitRecoverySegment(segment: RecoverySegmentCommit): void;
    latestQuotes(symbols: string[]): CanonicalQuote[];
    writeBars(bars: Bar[]): void;
    querySeries(query: SeriesQuery): Bar[];
    writeSectors(sectors: SectorObservation[], resolution?: SectorResolution): void;
    readSectors(query?: SectorQuery): SectorObservation[];
    rawTradingDates(market: Market): string[];
    recordGap(gap: CollectionGap): void;
    updateProviderHealth(update: ProviderHealthUpdate): void;
    health(): RepositoryHealth;
    runMaintenance<T>(operation: (access: RepositoryMaintenanceAccess) => T): T;
    close(): void;
    private insertQuotes;
    private insertBars;
    private insertSectors;
    private listRawTradingDates;
    private rawQuotes;
    private deleteRawSymbols;
    private sectorIntradayDates;
    private sectorIntraday;
    private minuteTradingDates;
    private deleteMinuteDate;
    private oldestMinuteTradingDate;
    private oldestSectorBucket;
    private deleteSectorBucket;
    private recordMaintenance;
    private counts;
    private liveDatabaseBytes;
    private databaseBytes;
    private attemptMutation;
    private transaction;
    private assertOpen;
}
