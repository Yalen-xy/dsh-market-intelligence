import { isMarketTradingDate, lastClosedTradingDate, marketState, nextStateChange, shanghaiDate, shanghaiMinuteOfDay } from './calendar.js';
import { validateMarketClosures } from './config.js';
import { DEFAULT_MAX_BYTES, maintainRepository } from './retention.js';
import { canonicalizeSymbol, SUPPORTED_INDICES } from './symbols.js';
class StorageFailure extends Error {
    #original;
    constructor(original) {
        super('Storage operation failed');
        this.name = 'StorageFailure';
        this.#original = original;
    }
    unwrap() {
        return this.#original;
    }
}
const MARKETS = ['CN', 'HK'];
const PROVIDERS = ['sina', 'tencent'];
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_QUOTE_FRESHNESS_MS = 30_000;
const DEFAULT_SECTOR_FRESHNESS_MS = 120_000;
const DEFAULT_CONFLICT_WINDOW_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_RECOVERY_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_SEGMENTS = 128;
const MAX_RECOVERY_ITEMS = 10_000;
export class MarketService {
    clock;
    tencent;
    sina;
    repository;
    scheduler;
    stateStore;
    config;
    maintenanceRunner;
    providerHealth = new Map();
    lifecycle = new AbortController();
    directOperations = new Set();
    quoteWriteStates = new Map();
    attemptSequences = new Map();
    appliedAttemptSequences = new Map();
    cancelScheduler;
    recoveryAnchor;
    recoveryEnd;
    recoveryOperations = new Map();
    recoveredMarkets = new Set();
    watchlistSnapshot;
    closures;
    watchlistQueue = Promise.resolve();
    sectorCache = [];
    sectorCacheIsLive = false;
    lastSuccessfulUpdate = null;
    lastMaintenance = null;
    disposing = false;
    disposed = false;
    disposal = null;
    constructor(options) {
        if (!options || typeof options !== 'object')
            throw new Error('MarketService options are required');
        if (!options.clock || typeof options.clock.now !== 'function')
            throw new Error('MarketService clock is required');
        if (!options.tencent || !options.sina || !options.repository || !options.scheduler || !options.stateStore) {
            throw new Error('MarketService dependencies are required');
        }
        this.clock = options.clock;
        this.tencent = options.tencent;
        this.sina = options.sina;
        this.repository = options.repository;
        this.scheduler = options.scheduler;
        this.stateStore = options.stateStore;
        this.config = validatedConfig(options.config ?? {});
        this.watchlistSnapshot = canonicalWatchlist(options.initialState?.watchlist ?? []);
        this.closures = cloneClosures(options.initialState?.closures ?? {});
        this.maintenanceRunner = options.maintenance ?? ((repository, policy, now) => maintainRepository(repository, policy, now));
        let persistedHealth = null;
        try {
            persistedHealth = this.readRepositoryHealth();
            for (const item of persistedHealth.providers) {
                this.providerHealth.set(item.provider, serviceHealthFromStored(item));
            }
        }
        catch (error) {
            if (!(error instanceof StorageFailure))
                throw error;
        }
        this.recoveryAnchor = recoveryAnchor(persistedHealth?.providers ?? []);
        this.recoveryEnd = this.now();
        this.bootstrapRecoveryCursors();
        this.cancelScheduler = this.scheduler.start({
            collectQuotes: (markets, requestSignal) => this.collectQuotes(markets, requestSignal),
            collectSectors: (requestSignal, persist) => this.collectSectors(requestSignal, persist),
            runMaintenance: async (market, tradingDate, requestSignal) => {
                await this.maintain(market, tradingDate, requestSignal);
            },
        });
    }
    status(request = {}) {
        this.assertUsable();
        if (request.market !== undefined)
            validateMarket(request.market);
        const now = this.now();
        const state = marketState(now, this.closures);
        const selected = request.market === undefined ? MARKETS : [request.market];
        const markets = selected.map((market) => {
            const session = state[market];
            const bounds = sessionBounds(market, session.phase, shanghaiMinuteOfDay(now));
            return {
                market,
                phase: session.phase,
                tradingDate: session.tradingDate,
                sessionStart: bounds.start,
                sessionEnd: bounds.end,
                collectionActive: session.active && !this.disposing && !this.disposed,
                calendarConfidence: session.calendarConfidence,
            };
        });
        return {
            asOf: now.toISOString(),
            collectionActive: markets.some(({ collectionActive }) => collectionActive),
            lastSuccessfulUpdate: this.lastSuccessfulUpdate,
            markets,
        };
    }
    quotes(request = {}, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.quotesOperation(request, operationSignal));
    }
    async quotesOperation(request, requestSignal) {
        const defaultSymbols = this.watchlistSnapshot.length > 0
            ? this.watchlistSnapshot
            : Object.values(SUPPORTED_INDICES);
        const symbols = requestedSymbols(request.symbols ?? defaultSymbols);
        if (symbols.length > 100)
            throw new Error('At most 100 symbols may be requested');
        if (symbols.length === 0)
            return unavailableQuotes();
        const cached = this.cachedQuotes(symbols);
        const state = marketState(this.now(), this.closures);
        // Scheduled collection is session-gated by the scheduler. An explicit user
        // refresh is different: providers expose the latest closing snapshot after
        // hours, which is essential when an earlier collection attempt failed.
        const refreshSymbols = request.refresh === true ? symbols : [];
        const leases = new Map();
        for (const market of new Set(refreshSymbols.map((symbol) => canonicalizeSymbol(symbol).market))) {
            const lease = this.acquireQuoteWrite(market, state[market].tradingDate);
            if (lease)
                leases.set(market, lease);
        }
        const attempted = new Set(refreshSymbols);
        let selected = new Map();
        let persistedSymbols = new Set();
        try {
            selected = refreshSymbols.length > 0
                ? (await this.refreshQuotes(refreshSymbols, requestSignal)).selected
                : new Map();
            const liveRecords = symbols.flatMap((symbol) => {
                const item = selected.get(symbol);
                return item ? [item] : [];
            });
            if (liveRecords.length > 0) {
                persistedSymbols = this.writeAdmittedQuotes(liveRecords, leases);
                if (persistedSymbols.size > 0)
                    this.lastSuccessfulUpdate = this.now().toISOString();
            }
        }
        finally {
            for (const lease of leases.values())
                lease.release();
        }
        const items = [];
        const conflicts = [];
        let liveReturned = false;
        for (const symbol of symbols) {
            const live = selected.get(symbol);
            const previous = cached.get(symbol);
            if (live) {
                const conflict = previous ? sourceConflict(live, previous, this.config.conflictComparableWindowMs, this.now().toISOString()) : null;
                if (conflict)
                    conflicts.push(conflict);
                const preferred = conflict && previous?.source === 'tencent' && live.source !== 'tencent' ? previous : live;
                const returnedFromLive = preferred === live;
                const representedDate = shanghaiDate(live.marketTime ?? live.fetchedAt);
                const liveRepresentsCurrentTradingDate = representedDate === state[live.market].tradingDate;
                items.push({ ...preferred, isStale: returnedFromLive ? live.isStale || !liveRepresentsCurrentTradingDate : true });
                liveReturned ||= returnedFromLive && liveRepresentsCurrentTradingDate;
                continue;
            }
            if (previous) {
                const stale = attempted.has(symbol)
                    || previous.isStale
                    || (state[previous.market].active && (isOlderThan(previous.fetchedAt, this.now(), this.config.quoteFreshnessMs)
                        || (previous.marketTime !== null && isOlderThan(previous.marketTime, this.now(), this.config.quoteFreshnessMs))));
                items.push({ ...previous, isStale: stale });
            }
        }
        return {
            availability: availabilityFor(items, liveReturned),
            items,
            conflicts,
        };
    }
    series(request, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.seriesOperation(request, operationSignal));
    }
    async seriesOperation(request, requestSignal) {
        if (!request || typeof request !== 'object')
            throw new Error('series request is required');
        const canonical = canonicalizeSymbol(request.symbol);
        validateInterval(request.interval);
        const limit = validatedLimit(request.limit ?? 500);
        if (request.adjustment !== undefined && request.adjustment !== 'qfq')
            throw new Error('series adjustment is unsupported');
        if (request.start !== undefined)
            requireTimestamp(request.start, 'series start');
        if (request.end !== undefined)
            requireTimestamp(request.end, 'series end');
        if (request.start !== undefined && request.end !== undefined && Date.parse(request.start) >= Date.parse(request.end)) {
            throw new Error('series start must be before end');
        }
        const cached = this.withStorageHealth(() => this.repository.querySeries({
            symbol: canonical.symbol,
            interval: request.interval,
            start: request.start,
            end: request.end,
            limit,
        })).map((item) => canonicalBar(item, canonical.symbol, canonical.market, request.interval));
        let providerItems = [];
        let refreshFailed = false;
        if (request.refresh !== false) {
            const attempt = this.beginAttempt('tencent');
            try {
                const response = await this.tencent.series({ symbol: canonical.symbol, interval: request.interval, count: limit }, requestSignal);
                throwIfAborted(requestSignal);
                if (!response || !isDenseArray(response.items))
                    throw new Error('invalid provider series result');
                let invalid = false;
                for (const item of response.items) {
                    try {
                        providerItems.push(canonicalBar(item, canonical.symbol, canonical.market, request.interval));
                    }
                    catch {
                        invalid = true;
                    }
                }
                const category = invalid ? (providerItems.length > 0 ? 'partial' : 'validation') : null;
                refreshFailed = category !== null && providerItems.length === 0;
                this.finishAttempt('tencent', attempt, category, providerItems.length > 0 || response.items.length === 0);
            }
            catch (error) {
                if (requestSignal.aborted)
                    throw abortReason(requestSignal);
                if (error instanceof StorageFailure)
                    throw error;
                refreshFailed = true;
                const category = isValidationFailure(error) ? 'validation' : errorCategory(error);
                this.finishAttempt('tencent', attempt, category, false);
            }
        }
        if (providerItems.length > 0)
            this.withStorageHealth(() => this.repository.writeBars(providerItems));
        const merged = new Map();
        for (const item of cached)
            merged.set(item.timestamp, item);
        for (const item of providerItems)
            merged.set(item.timestamp, item);
        const items = [...merged.values()]
            .filter((item) => request.start === undefined || Date.parse(item.timestamp) >= Date.parse(request.start))
            .filter((item) => request.end === undefined || Date.parse(item.timestamp) < Date.parse(request.end))
            .sort(compareTimestamp)
            .slice(-limit);
        const source = cached.length > 0 && providerItems.length > 0
            ? 'both'
            : providerItems.length > 0
                ? 'provider'
                : cached.length > 0
                    ? 'storage'
                    : null;
        return {
            availability: providerItems.length > 0 ? 'live' : cached.length > 0 ? refreshFailed ? 'stale' : 'cached' : 'unavailable',
            source,
            items,
        };
    }
    sectors(request = {}, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.sectorsOperation(request, operationSignal));
    }
    async sectorsOperation(request, requestSignal) {
        const limit = validatedLimit(request.limit ?? 500);
        if (request.category !== undefined && (typeof request.category !== 'string' || request.category.trim() === '')) {
            throw new Error('sector category must be a non-empty string');
        }
        const sort = request.sort ?? 'changePercent';
        if (!['changePercent', 'turnover', 'netFlow'].includes(sort))
            throw new Error('sector sort is unsupported');
        const direction = request.direction ?? 'desc';
        if (direction !== 'asc' && direction !== 'desc')
            throw new Error('sector direction is unsupported');
        let refreshFailed = false;
        if (request.refresh === true) {
            try {
                await this.collectSectorsOperation(requestSignal, true);
            }
            catch (error) {
                if (requestSignal.aborted)
                    throw abortReason(requestSignal);
                if (error instanceof StorageFailure)
                    throw error;
                refreshFailed = true;
            }
        }
        const fromMemory = this.sectorCache.length > 0;
        const source = fromMemory
            ? this.sectorCache.map((item) => ({ ...item }))
            : this.withStorageHealth(() => this.repository.readSectors({ category: request.category, resolution: 'intraday', limit: 10_000 }))
                .map((item) => canonicalSector(item));
        const state = marketState(this.now(), this.closures).CN;
        const items = source
            .filter((item) => request.category === undefined || item.category === request.category)
            .map((item) => ({
            ...item,
            isStale: item.isStale || refreshFailed || (state.active && isOlderThan(item.fetchedAt, this.now(), this.config.sectorFreshnessMs)),
        }))
            .sort((left, right) => compareSectors(left, right, sort, direction))
            .slice(0, limit);
        return {
            availability: items.length === 0
                ? 'unavailable'
                : items.some(({ isStale }) => isStale)
                    ? 'stale'
                    : fromMemory && this.sectorCacheIsLive
                        ? 'live'
                        : 'cached',
            items,
        };
    }
    auction(request, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.auctionOperation(request, operationSignal));
    }
    async auctionOperation(request, requestSignal) {
        if (!request || typeof request !== 'object')
            throw new Error('auction request is required');
        validateMarket(request.market);
        const phase = marketState(this.now(), this.closures)[request.market].phase;
        const expectedPhase = request.market === 'CN' ? 'auction' : 'preopen';
        if (phase !== expectedPhase) {
            return { availability: 'unavailable', phase, reason: `${request.market} auction is inactive`, items: [] };
        }
        const requested = requestedSymbols(request.symbols ?? this.watchlistSnapshot);
        if (requested.length > 100)
            throw new Error('At most 100 symbols may be requested');
        const symbols = requested.filter((symbol) => canonicalizeSymbol(symbol).market === request.market);
        if (symbols.length === 0)
            return { availability: 'unavailable', phase, reason: 'No symbols requested', items: [] };
        const attempt = this.beginAttempt('tencent');
        try {
            const response = await this.tencent.auction(symbols, phase, requestSignal);
            throwIfAborted(requestSignal);
            if (!response || !isDenseArray(response.items))
                throw new Error('invalid provider auction result');
            if (response.phase !== phase)
                throw new Error('invalid provider auction phase');
            const requestedSymbolsSet = new Set(symbols);
            const seen = new Set();
            const items = [];
            let invalid = false;
            for (const raw of response.items) {
                try {
                    const item = canonicalQuote(raw, 'tencent');
                    if (!requestedSymbolsSet.has(item.symbol) || item.market !== request.market || seen.has(item.symbol))
                        throw new Error('unexpected auction symbol');
                    seen.add(item.symbol);
                    items.push({ ...item, isStale: false });
                }
                catch {
                    invalid = true;
                }
            }
            if (invalid && items.length === 0)
                throw new Error('invalid provider auction items');
            this.finishAttempt('tencent', attempt, invalid ? (items.length > 0 ? 'partial' : 'validation') : null, items.length > 0 || response.items.length === 0);
            return {
                availability: items.length > 0 ? 'live' : 'unavailable',
                phase,
                reason: items.length > 0 ? null : 'No auction observations available',
                items,
            };
        }
        catch (error) {
            if (requestSignal.aborted)
                throw abortReason(requestSignal);
            if (error instanceof StorageFailure)
                throw error;
            this.finishAttempt('tencent', attempt, isValidationFailure(error) ? 'validation' : errorCategory(error), false);
            const cached = this.cachedQuotes(symbols);
            const items = symbols.flatMap((symbol) => {
                const item = cached.get(symbol);
                return item ? [{ ...item, isStale: true }] : [];
            });
            return {
                availability: items.length > 0 ? 'stale' : 'unavailable',
                phase,
                reason: items.length > 0 ? 'Live auction refresh failed' : 'No auction observations available',
                items,
            };
        }
    }
    watchlist(request, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.watchlistOperation(request, operationSignal));
    }
    async watchlistOperation(request, requestSignal) {
        if (!request || typeof request !== 'object')
            throw new Error('watchlist request is required');
        if (!['get', 'add', 'remove'].includes(request.action))
            throw new Error('watchlist action is unsupported');
        const action = request.action;
        if (action === 'get') {
            await this.watchlistQueue;
            throwIfAborted(requestSignal);
            return { watchlist: [...this.watchlistSnapshot] };
        }
        if (typeof request.symbol !== 'string')
            throw new Error(`watchlist ${action} requires a symbol`);
        const symbol = canonicalizeSymbol(request.symbol).symbol;
        const operation = this.watchlistQueue.then(async () => {
            throwIfAborted(requestSignal);
            this.assertUsable();
            if (action === 'add' && this.watchlistSnapshot.includes(symbol))
                throw new Error(`${symbol} is already in the watchlist`);
            if (action === 'add' && this.watchlistSnapshot.length >= 100)
                throw new Error('Watchlist cannot contain more than 100 symbols');
            if (action === 'remove' && !this.watchlistSnapshot.includes(symbol))
                throw new Error(`${symbol} is not in the watchlist`);
            throwIfAborted(requestSignal);
            this.assertUsable();
            const persisted = await this.stateStore.mutateWatchlist((current) => mutateCanonicalWatchlist(current, action, symbol));
            const next = canonicalWatchlist(persisted.watchlist);
            this.watchlistSnapshot = next;
            this.closures = cloneClosures(persisted.closures);
            throwIfAborted(requestSignal);
            this.assertUsable();
            return { watchlist: [...next] };
        });
        this.watchlistQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }
    health() {
        this.assertUsable();
        let stored;
        try {
            stored = this.readRepositoryHealth();
        }
        catch (error) {
            throw unwrapStorageFailure(error);
        }
        const providers = new Map();
        for (const item of stored.providers)
            providers.set(item.provider, serviceHealthFromStored(item));
        for (const provider of PROVIDERS) {
            if (!providers.has(provider))
                providers.set(provider, emptyProviderHealth(provider));
        }
        for (const [provider, item] of this.providerHealth)
            providers.set(provider, { ...item });
        const schedulerHealth = this.scheduler.health?.() ?? {};
        const lastResult = this.lastMaintenance ?? stored.lastMaintenance;
        const capSatisfied = lastResult?.capSatisfied;
        return canonicalHealthValue({
            providers: [...providers.values()].sort((left, right) => left.provider.localeCompare(right.provider)),
            scheduler: {
                state: this.disposed ? 'stopped' : this.disposing ? 'stopping' : 'running',
                pendingTimers: nonNegativeSafeIntegerOrNull(schedulerHealth.pendingTimers),
                inFlight: nonNegativeSafeIntegerOrNull(schedulerHealth.inFlight),
            },
            database: {
                databaseBytes: stored.databaseBytes,
                liveDatabaseBytes: stored.liveDatabaseBytes,
                counts: { ...stored.counts },
            },
            gaps: structuredClone(stored.gaps),
            retention: {
                status: capSatisfied === true ? 'ok' : capSatisfied === false ? 'over-cap' : 'unknown',
                lastResult: lastResult === null ? null : structuredClone(lastResult),
            },
        });
    }
    collectQuotes(markets, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.collectQuotesOperation(markets, operationSignal));
    }
    async collectQuotesOperation(markets, requestSignal) {
        if (!isDenseArray(markets))
            throw new Error('collection markets must be a dense array');
        const requestedMarkets = [...new Set(markets.map((market) => {
                validateMarket(market);
                return market;
            }))];
        const state = marketState(this.now(), this.closures);
        const leases = new Map();
        for (const market of requestedMarkets) {
            const lease = this.acquireQuoteWrite(market, state[market].tradingDate);
            if (lease)
                leases.set(market, lease);
        }
        const admittedMarkets = requestedMarkets.filter((market) => leases.has(market));
        const scheduledSymbols = requestedSymbols([
            ...this.watchlistSnapshot,
            ...Object.values(SUPPORTED_INDICES),
        ]).filter((symbol) => admittedMarkets.includes(canonicalizeSymbol(symbol).market));
        let selected;
        try {
            selected = (await this.refreshQuotes(scheduledSymbols, requestSignal)).selected;
        }
        catch (error) {
            for (const lease of leases.values())
                lease.release();
            throw error;
        }
        const staged = [...selected.values()];
        const marketTimes = {};
        for (const market of requestedMarkets) {
            marketTimes[market] = newestMarketTime(staged.filter((item) => item.market === market));
        }
        const committed = new Set();
        const releaseMarkets = (marketsToRelease) => {
            for (const market of marketsToRelease) {
                leases.get(market)?.release();
                leases.delete(market);
            }
        };
        return {
            marketTimes,
            commit: (approvedMarkets, commitSignal) => {
                let releaseTargets = [];
                return this.trackDirect(commitSignal, async (operationSignal) => {
                    throwIfAborted(operationSignal);
                    if (!isDenseArray(approvedMarkets))
                        throw new Error('approved markets must be a dense array');
                    const approved = [...new Set(approvedMarkets.map((market) => {
                            validateMarket(market);
                            if (!requestedMarkets.includes(market))
                                throw new Error('cannot commit an unrequested market');
                            if (marketTimes[market] === null || marketTimes[market] === undefined)
                                throw new Error(`${market} has no advancing market timestamp`);
                            return market;
                        }))].filter((market) => !committed.has(market));
                    const rows = staged.filter((item) => approved.includes(item.market));
                    const persisted = this.writeAdmittedQuotes(rows, leases);
                    for (const market of approved)
                        committed.add(market);
                    if (persisted.size > 0)
                        this.lastSuccessfulUpdate = this.now().toISOString();
                    releaseTargets = approved;
                }).then(() => releaseMarkets(releaseTargets), (error) => {
                    releaseMarkets([...leases.keys()]);
                    throw error;
                });
            },
            release: async () => releaseMarkets(requestedMarkets),
        };
    }
    collectSectors(requestSignal, persist) {
        return this.trackDirect(requestSignal, (operationSignal) => this.collectSectorsOperation(operationSignal, persist));
    }
    async collectSectorsOperation(requestSignal, persist) {
        if (typeof persist !== 'boolean')
            throw new Error('sector persistence flag must be boolean');
        const attempt = this.beginAttempt('sina');
        let attemptFinished = false;
        let items = [];
        try {
            const response = await this.sina.sectors(requestSignal);
            throwIfAborted(requestSignal);
            if (!response || !isDenseArray(response.items))
                throw new Error('invalid provider sector result');
            let invalid = false;
            for (const raw of response.items) {
                try {
                    items.push(canonicalSector(raw, 'sina'));
                }
                catch {
                    invalid = true;
                }
            }
            if (items.length === 0 && response.items.length === 0) {
                this.finishAttempt('sina', attempt, 'parse', false);
                attemptFinished = true;
                throw new Error('Sina sector response was empty');
            }
            const category = invalid ? (items.length > 0 ? 'partial' : 'validation') : null;
            this.finishAttempt('sina', attempt, category, items.length > 0 || response.items.length === 0);
            attemptFinished = true;
            if (invalid && items.length === 0)
                throw new Error('invalid Sina sector response');
        }
        catch (error) {
            if (requestSignal.aborted)
                throw abortReason(requestSignal);
            if (error instanceof StorageFailure)
                throw error;
            if (!attemptFinished) {
                this.finishAttempt('sina', attempt, isValidationFailure(error) ? 'validation' : errorCategory(error), false);
            }
            throw error;
        }
        if (persist)
            this.withStorageHealth(() => this.repository.writeSectors(items, 'intraday'));
        this.sectorCache = items.map((item) => ({ ...item, isStale: false }));
        this.sectorCacheIsLive = true;
        this.lastSuccessfulUpdate = this.now().toISOString();
    }
    maintain(market, closedTradingDate, requestSignal) {
        return this.trackDirect(requestSignal, (operationSignal) => this.maintainOperation(market, closedTradingDate, operationSignal));
    }
    async maintainOperation(market, closedTradingDate, requestSignal) {
        if (market !== undefined)
            validateMarket(market);
        if (closedTradingDate !== undefined) {
            if (market === undefined)
                throw new Error('market is required with a closed trading date');
            requireTradingDate(closedTradingDate);
            if (!isMarketTradingDate(closedTradingDate, market, this.closures)) {
                throw new Error(`${market} date ${closedTradingDate} is not a trading date`);
            }
            if (closedTradingDate > lastClosedTradingDate(this.now(), market, this.closures)) {
                throw new Error(`${market} trading date ${closedTradingDate} is not closed`);
            }
            await this.recoverDowntime(market, requestSignal);
            await this.sealQuoteWritesAndWait(market, closedTradingDate, requestSignal);
        }
        let result;
        try {
            result = await this.maintenanceRunner(this.repository, {
                market,
                closedTradingDate,
                closures: cloneClosures(this.closures),
                minuteTradingDays: this.config.minuteRetentionTradingDays,
                maxBytes: this.config.storageSoftLimitBytes,
            }, this.now());
        }
        catch (error) {
            this.recordStorageFailure();
            throw new StorageFailure(error);
        }
        throwIfAborted(requestSignal);
        this.lastMaintenance = structuredClone(result);
        return structuredClone(result);
    }
    recoverDowntime(market, requestSignal) {
        if (this.recoveredMarkets.has(market))
            return Promise.resolve();
        const running = this.recoveryOperations.get(market);
        if (running)
            return running;
        const operation = this.recoverDowntimeOperation(market, requestSignal).then(() => {
            this.recoveredMarkets.add(market);
        }).finally(() => {
            this.recoveryOperations.delete(market);
        });
        this.recoveryOperations.set(market, operation);
        return operation;
    }
    async recoverDowntimeOperation(market, requestSignal) {
        const cursor = this.readRecoveryCursor(market);
        if (cursor === null) {
            if (this.recoveryAnchor === null)
                return;
            this.withStorageHealth(() => {
                throw new Error('repository recovery cursor bootstrap is unavailable');
            });
            return;
        }
        const anchor = Date.parse(cursor);
        if (anchor >= this.recoveryEnd.getTime())
            return;
        const boundedStart = new Date(Math.max(anchor, this.recoveryEnd.getTime() - MAX_RECOVERY_LOOKBACK_MS));
        const intervals = activeMarketIntervals(boundedStart, this.recoveryEnd, market, this.closures);
        const capability = quoteHistoryCapability(this.tencent, market);
        const symbols = requestedSymbols([
            ...this.watchlistSnapshot,
            ...Object.values(SUPPORTED_INDICES),
        ]).filter((symbol) => canonicalizeSymbol(symbol).market === market);
        const attempt = capability && this.tencent.backfill && intervals.length > 0 ? this.beginAttempt('tencent') : null;
        let attemptCategory = null;
        let attemptHadSuccess = false;
        for (const interval of intervals) {
            throwIfAborted(requestSignal);
            let items = [];
            let complete = false;
            if (capability && this.tencent.backfill) {
                const requestLimit = Math.min(capability.maxItems, MAX_RECOVERY_ITEMS);
                try {
                    const response = await this.tencent.backfill({
                        market,
                        interval: 'quote',
                        start: interval.start,
                        end: interval.end,
                        symbols,
                        limit: requestLimit,
                    }, requestSignal);
                    throwIfAborted(requestSignal);
                    if (!response || !isDenseArray(response.items) || response.items.length > requestLimit || typeof response.complete !== 'boolean') {
                        throw new Error('invalid provider history result');
                    }
                    items = response.items.map((raw) => canonicalHistoricalQuote(raw, 'tencent', market, symbols, interval));
                    complete = response.complete;
                    attemptHadSuccess ||= complete;
                    if (!complete && attemptCategory === null)
                        attemptCategory = 'partial';
                }
                catch (error) {
                    if (requestSignal.aborted)
                        throw abortReason(requestSignal);
                    if (attemptCategory === null)
                        attemptCategory = isValidationFailure(error) ? 'validation' : errorCategory(error);
                }
            }
            const gap = complete ? null : {
                market,
                symbol: null,
                interval: 'quote',
                start: interval.start,
                end: interval.end,
                reason: 'provider_history_unavailable',
                recordedAt: this.recoveryEnd.toISOString(),
            };
            this.commitRecoverySegment({
                provider: 'tencent',
                market,
                interval: 'quote',
                start: interval.start,
                end: interval.end,
                completedAt: this.recoveryEnd.toISOString(),
                items,
                gap,
            });
        }
        if (attempt !== null)
            this.finishAttempt('tencent', attempt, attemptCategory, attemptHadSuccess);
    }
    bootstrapRecoveryCursors() {
        if (this.recoveryAnchor === null)
            return;
        const initialize = this.repository.initializeRecoveryCursors;
        if (initialize === undefined)
            return;
        const cursor = new Date(this.recoveryAnchor).toISOString();
        this.withStorageHealth(() => initialize.call(this.repository, 'tencent', 'quote', MARKETS.map((market) => ({
            market,
            cursor,
        })), this.recoveryEnd.toISOString()));
    }
    readRecoveryCursor(market) {
        const read = this.repository.recoveryCursor;
        if (read === undefined)
            return null;
        const cursor = this.withStorageHealth(() => read.call(this.repository, 'tencent', market, 'quote'));
        if (cursor !== null)
            requireTimestamp(cursor, 'recovery cursor');
        return cursor;
    }
    commitRecoverySegment(segment) {
        this.withStorageHealth(() => {
            const commit = this.repository.commitRecoverySegment;
            if (commit === undefined)
                throw new Error('repository does not support crash-consistent recovery persistence');
            commit.call(this.repository, segment);
        });
    }
    dispose() {
        if (this.disposal)
            return this.disposal;
        this.disposing = true;
        let resolveDisposal;
        let rejectDisposal;
        const sharedDisposal = new Promise((resolve, reject) => {
            resolveDisposal = resolve;
            rejectDisposal = reject;
        });
        this.disposal = sharedDisposal;
        let schedulerCancellation;
        try {
            schedulerCancellation = this.cancelScheduler();
        }
        catch (error) {
            schedulerCancellation = Promise.reject(error);
        }
        const directOperations = [...this.directOperations];
        const shutdownDrain = Promise.allSettled([schedulerCancellation, ...directOperations]);
        this.lifecycle.abort(new DOMException('MarketService is disposing', 'AbortError'));
        void (async () => {
            let schedulerError;
            let repositoryError;
            const [schedulerResult] = await shutdownDrain;
            if (schedulerResult?.status === 'rejected')
                schedulerError = schedulerResult.reason;
            try {
                this.repository.close();
            }
            catch (error) {
                repositoryError = error;
            }
            this.disposed = true;
            this.disposing = false;
            if (schedulerError !== undefined && repositoryError !== undefined) {
                throw new AggregateError([schedulerError, repositoryError], 'MarketService disposal failed');
            }
            if (schedulerError !== undefined)
                throw schedulerError;
            if (repositoryError !== undefined)
                throw repositoryError;
        })().then(resolveDisposal, rejectDisposal);
        return sharedDisposal;
    }
    trackDirect(requestSignal, operation) {
        try {
            this.assertUsable();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const controller = new AbortController();
        const signals = [...new Set([this.lifecycle.signal, requestSignal].filter((item) => item !== undefined))];
        const listeners = [];
        for (const source of signals) {
            if (source.aborted) {
                controller.abort(abortReason(source));
                break;
            }
            const listener = () => controller.abort(abortReason(source));
            source.addEventListener('abort', listener, { once: true });
            listeners.push({ signal: source, listener });
        }
        const cleanup = () => {
            for (const { signal, listener } of listeners)
                signal.removeEventListener('abort', listener);
        };
        const tracked = Promise.resolve()
            .then(() => {
            throwIfAborted(controller.signal);
            return operation(controller.signal);
        })
            .catch((error) => {
            throw unwrapStorageFailure(error);
        });
        let drain;
        drain = tracked.then(() => {
            cleanup();
            this.directOperations.delete(drain);
        }, () => {
            cleanup();
            this.directOperations.delete(drain);
        });
        this.directOperations.add(drain);
        return tracked;
    }
    acquireQuoteWrite(market, tradingDate) {
        const key = `${market}:${tradingDate}`;
        const state = this.quoteWriteStates.get(key) ?? { sealed: false, active: 0, waiters: new Set() };
        if (state.sealed)
            return null;
        this.quoteWriteStates.set(key, state);
        state.active++;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            this.lifecycle.signal.removeEventListener('abort', release);
            state.active--;
            if (state.active < 0)
                throw new Error('quote writer lease count became negative');
            if (state.active === 0) {
                for (const waiter of [...state.waiters])
                    waiter();
                if (!state.sealed && state.waiters.size === 0)
                    this.quoteWriteStates.delete(key);
            }
        };
        this.lifecycle.signal.addEventListener('abort', release, { once: true });
        return { market, tradingDate, release };
    }
    writeAdmittedQuotes(rows, prefetchLeases) {
        const groups = new Map();
        const rowGroups = new Map();
        const representedDates = new Map();
        for (const row of rows) {
            const representedTime = row.marketTime ?? row.fetchedAt;
            let tradingDate = representedDates.get(representedTime);
            if (tradingDate === undefined) {
                tradingDate = shanghaiDate(representedTime);
                representedDates.set(representedTime, tradingDate);
            }
            const key = `${row.market}:${tradingDate}`;
            rowGroups.set(row, key);
            if (!groups.has(key))
                groups.set(key, { market: row.market, tradingDate });
        }
        const admittedGroups = new Set();
        const representedLeases = [];
        try {
            for (const [key, group] of groups) {
                const prefetch = prefetchLeases.get(group.market);
                if (prefetch?.tradingDate === group.tradingDate) {
                    admittedGroups.add(key);
                    continue;
                }
                const represented = this.acquireQuoteWrite(group.market, group.tradingDate);
                if (!represented)
                    continue;
                representedLeases.push(represented);
                admittedGroups.add(key);
            }
            const admitted = rows.filter((row) => admittedGroups.has(rowGroups.get(row)));
            if (admitted.length > 0)
                this.withStorageHealth(() => this.repository.writeBatch(admitted));
            return new Set(admitted.map(({ symbol }) => symbol));
        }
        finally {
            for (const lease of representedLeases)
                lease.release();
        }
    }
    async sealQuoteWritesAndWait(market, tradingDate, signal) {
        throwIfAborted(signal);
        const key = `${market}:${tradingDate}`;
        const state = this.quoteWriteStates.get(key) ?? { sealed: false, active: 0, waiters: new Set() };
        this.quoteWriteStates.set(key, state);
        state.sealed = true;
        if (state.active === 0)
            return;
        await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                state.waiters.delete(released);
                signal.removeEventListener('abort', aborted);
            };
            const released = () => {
                if (settled || state.active !== 0)
                    return;
                settled = true;
                cleanup();
                resolve();
            };
            const aborted = () => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(abortReason(signal));
            };
            state.waiters.add(released);
            signal.addEventListener('abort', aborted, { once: true });
            released();
        });
    }
    async refreshQuotes(symbols, requestSignal) {
        if (symbols.length === 0)
            return { selected: new Map() };
        const tencent = await this.fetchProviderQuotes('tencent', this.tencent, symbols, requestSignal);
        const missingA = tencent.unresolved.filter((symbol) => canonicalizeSymbol(symbol).market === 'CN');
        const sina = missingA.length > 0
            ? await this.fetchProviderQuotes('sina', this.sina, missingA, requestSignal)
            : { items: new Map(), unresolved: [] };
        const selected = new Map();
        for (const symbol of symbols) {
            const item = tencent.items.get(symbol) ?? sina.items.get(symbol);
            if (item)
                selected.set(symbol, { ...item, isStale: false });
        }
        return { selected };
    }
    async fetchProviderQuotes(providerName, provider, symbols, requestSignal) {
        const attempt = this.beginAttempt(providerName);
        const items = new Map();
        const categories = [];
        let invalid = false;
        for (const batch of marketBatches(symbols, this.config.providerBatchSize)) {
            throwIfAborted(requestSignal);
            try {
                const response = await provider.quotes(batch, requestSignal);
                throwIfAborted(requestSignal);
                if (!response || !isDenseArray(response.items))
                    throw new Error('invalid provider quote result');
                const requested = new Set(batch);
                for (const raw of response.items) {
                    try {
                        const item = canonicalQuote(raw, providerName);
                        if (!requested.has(item.symbol) || items.has(item.symbol))
                            throw new Error('unexpected provider quote symbol');
                        items.set(item.symbol, { ...item, isStale: false });
                    }
                    catch {
                        invalid = true;
                    }
                }
            }
            catch (error) {
                if (requestSignal.aborted)
                    throw abortReason(requestSignal);
                categories.push(isValidationFailure(error) ? 'validation' : errorCategory(error));
            }
        }
        const unresolved = symbols.filter((symbol) => !items.has(symbol));
        let category = null;
        if (invalid && items.size === 0)
            category = 'validation';
        else if (items.size > 0 && (invalid || categories.length > 0 || unresolved.length > 0))
            category = 'partial';
        else if (categories.length > 0)
            category = categories[0];
        else if (unresolved.length > 0)
            category = 'partial';
        this.finishAttempt(providerName, attempt, category, items.size > 0);
        return { items, unresolved };
    }
    cachedQuotes(symbols) {
        const requested = new Set(symbols);
        const result = new Map();
        for (const raw of this.withStorageHealth(() => this.repository.latestQuotes(symbols))) {
            const item = canonicalQuote(raw);
            if (!requested.has(item.symbol) || result.has(item.symbol))
                throw new Error('repository returned an unexpected quote');
            result.set(item.symbol, item);
        }
        return result;
    }
    withStorageHealth(operation) {
        try {
            return operation();
        }
        catch (error) {
            if (error instanceof StorageFailure)
                throw error;
            this.recordStorageFailure();
            throw new StorageFailure(error);
        }
    }
    readRepositoryHealth() {
        return this.withStorageHealth(() => this.repository.health());
    }
    recordStorageFailure() {
        const attempt = this.beginAttempt('storage');
        const completed = this.now();
        const previous = this.providerHealth.get('storage') ?? emptyProviderHealth('storage');
        const current = {
            provider: 'storage',
            available: false,
            latencyMs: Math.max(0, completed.getTime() - attempt.startedAt),
            lastAttemptAt: attempt.attemptedAt,
            lastSuccessAt: previous.lastSuccessAt,
            lastFailureAt: completed.toISOString(),
            consecutiveFailures: previous.consecutiveFailures + 1,
            errorCategory: 'storage',
        };
        this.appliedAttemptSequences.set('storage', attempt.sequence);
        this.providerHealth.set('storage', current);
        try {
            this.repository.updateProviderHealth({
                provider: current.provider,
                available: current.available,
                latencyMs: current.latencyMs,
                lastAttemptAt: current.lastAttemptAt,
                lastSuccessAt: current.lastSuccessAt,
                lastFailureAt: current.lastFailureAt,
                consecutiveFailures: current.consecutiveFailures,
                error: current.errorCategory,
            });
        }
        catch {
            // The in-memory health fact remains available when health persistence is itself unavailable.
        }
    }
    beginAttempt(provider) {
        const sequence = (this.attemptSequences.get(provider) ?? 0) + 1;
        this.attemptSequences.set(provider, sequence);
        const now = this.now();
        return { sequence, startedAt: now.getTime(), attemptedAt: now.toISOString() };
    }
    finishAttempt(provider, attempt, category, hadSuccess) {
        if (attempt.sequence < (this.appliedAttemptSequences.get(provider) ?? 0))
            return;
        const completed = this.now();
        const previous = this.providerHealth.get(provider) ?? emptyProviderHealth(provider);
        const success = category === null;
        const current = {
            provider,
            available: success,
            latencyMs: Math.max(0, completed.getTime() - attempt.startedAt),
            lastAttemptAt: attempt.attemptedAt,
            lastSuccessAt: success || hadSuccess ? completed.toISOString() : previous.lastSuccessAt,
            lastFailureAt: success ? previous.lastFailureAt : completed.toISOString(),
            consecutiveFailures: success ? 0 : previous.consecutiveFailures + 1,
            errorCategory: category,
        };
        this.appliedAttemptSequences.set(provider, attempt.sequence);
        this.providerHealth.set(provider, current);
        try {
            this.repository.updateProviderHealth({
                provider,
                available: current.available,
                latencyMs: current.latencyMs,
                lastAttemptAt: current.lastAttemptAt,
                lastSuccessAt: current.lastSuccessAt,
                lastFailureAt: current.lastFailureAt,
                consecutiveFailures: current.consecutiveFailures,
                error: current.errorCategory,
            });
        }
        catch (error) {
            this.recordStorageFailure();
            throw new StorageFailure(error);
        }
    }
    now() {
        const now = this.clock.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
            throw new Error('MarketService clock returned an invalid date');
        return new Date(now);
    }
    assertUsable() {
        if (this.disposed || this.disposing)
            throw new Error('MarketService is disposed');
    }
}
function validatedConfig(config) {
    const providerBatchSize = config.providerBatchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(providerBatchSize) || providerBatchSize < 1 || providerBatchSize > 100) {
        throw new Error('providerBatchSize must be an integer from 1 to 100');
    }
    const quoteFreshnessMs = positiveSafeInteger(config.quoteFreshnessMs ?? DEFAULT_QUOTE_FRESHNESS_MS, 'quoteFreshnessMs');
    const sectorFreshnessMs = positiveSafeInteger(config.sectorFreshnessMs ?? DEFAULT_SECTOR_FRESHNESS_MS, 'sectorFreshnessMs');
    const conflictComparableWindowMs = positiveSafeInteger(config.conflictComparableWindowMs ?? DEFAULT_CONFLICT_WINDOW_MS, 'conflictComparableWindowMs');
    const minuteRetentionTradingDays = config.minuteRetentionTradingDays ?? 30;
    if (!Number.isSafeInteger(minuteRetentionTradingDays) || minuteRetentionTradingDays < 0) {
        throw new Error('minuteRetentionTradingDays must be a non-negative safe integer');
    }
    const storageSoftLimitBytes = positiveSafeInteger(config.storageSoftLimitBytes ?? DEFAULT_MAX_BYTES, 'storageSoftLimitBytes');
    return { providerBatchSize, quoteFreshnessMs, sectorFreshnessMs, conflictComparableWindowMs, minuteRetentionTradingDays, storageSoftLimitBytes };
}
function positiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive safe integer`);
    return value;
}
function requestedSymbols(inputs) {
    if (!isDenseArray(inputs))
        throw new Error('symbols must be a dense array');
    const result = [];
    const seen = new Set();
    for (const input of inputs) {
        if (typeof input !== 'string')
            throw new Error('symbols must contain strings');
        const canonical = canonicalizeSymbol(input).symbol;
        if (!seen.has(canonical)) {
            seen.add(canonical);
            result.push(canonical);
        }
    }
    return result;
}
function canonicalWatchlist(inputs) {
    const result = requestedSymbols(inputs);
    if (result.length !== inputs.length)
        throw new Error('Watchlist contains duplicate symbols');
    if (result.length > 100)
        throw new Error('Watchlist cannot contain more than 100 symbols');
    return result;
}
function mutateCanonicalWatchlist(current, action, symbol) {
    const canonical = canonicalWatchlist(current);
    const index = canonical.indexOf(symbol);
    if (action === 'add') {
        if (index >= 0)
            throw new Error(`${symbol} is already in the watchlist`);
        if (canonical.length >= 100)
            throw new Error('Watchlist cannot contain more than 100 symbols');
        return [...canonical, symbol];
    }
    if (index < 0)
        throw new Error(`${symbol} is not in the watchlist`);
    return canonical.filter((item) => item !== symbol);
}
function cloneClosures(closures) {
    return validateMarketClosures(closures);
}
function recoveryAnchor(providers) {
    const tencent = providers.find(({ provider }) => provider === 'tencent');
    if (!tencent)
        return null;
    const candidates = [tencent.lastAttemptAt, tencent.lastSuccessAt]
        .filter((value) => value !== null)
        .map((value) => Date.parse(value))
        .filter(Number.isFinite);
    return candidates.length === 0 ? null : Math.max(...candidates);
}
function activeMarketIntervals(start, end, market, closures) {
    const intervals = [];
    let cursor = new Date(start);
    while (cursor.getTime() < end.getTime() && intervals.length < MAX_RECOVERY_SEGMENTS) {
        const boundary = nextStateChange(cursor, market, closures);
        if (boundary.getTime() <= cursor.getTime())
            throw new Error('market calendar did not advance during recovery');
        const segmentEnd = new Date(Math.min(boundary.getTime(), end.getTime()));
        if (marketState(cursor, closures)[market].active && segmentEnd.getTime() > cursor.getTime()) {
            intervals.push({ start: cursor.toISOString(), end: segmentEnd.toISOString() });
        }
        cursor = boundary;
    }
    return intervals;
}
function quoteHistoryCapability(provider, market) {
    const capabilities = provider.historyCapabilities;
    if (!isDenseArray(capabilities))
        return null;
    for (const capability of capabilities) {
        if (!isPlainRecord(capability)
            || capability.interval !== 'quote'
            || !isDenseArray(capability.markets)
            || !capability.markets.every((candidate) => candidate === 'CN' || candidate === 'HK')
            || !Number.isSafeInteger(capability.maxItems)
            || capability.maxItems < 1)
            continue;
        if (capability.markets.includes(market))
            return capability;
    }
    return null;
}
function canonicalHistoricalQuote(raw, expectedSource, market, symbols, interval) {
    const item = canonicalQuote(raw, expectedSource);
    const representedAt = Date.parse(item.marketTime ?? item.fetchedAt);
    if (item.market !== market || !symbols.includes(item.symbol))
        throw new Error('unexpected provider history symbol');
    if (representedAt < Date.parse(interval.start) || representedAt >= Date.parse(interval.end)) {
        throw new Error('provider history item falls outside the requested interval');
    }
    return item;
}
function marketBatches(symbols, size) {
    const batches = [];
    for (const market of MARKETS) {
        const selected = symbols.filter((symbol) => canonicalizeSymbol(symbol).market === market);
        for (let index = 0; index < selected.length; index += size)
            batches.push(selected.slice(index, index + size));
    }
    return batches;
}
function canonicalQuote(value, expectedSource) {
    const record = plainRecord(value, 'quote');
    const symbol = requiredString(record.symbol, 'quote symbol');
    const canonical = canonicalizeSymbol(symbol);
    if (canonical.symbol !== symbol)
        throw new Error('quote symbol must be canonical');
    const market = requiredMarket(record.market, 'quote market');
    if (canonical.market !== market)
        throw new Error('quote symbol does not match market');
    const currency = record.currency;
    if ((market === 'CN' && currency !== 'CNY') || (market === 'HK' && currency !== 'HKD'))
        throw new Error('quote currency does not match market');
    const source = requiredString(record.source, 'quote source');
    if (expectedSource !== undefined && source !== expectedSource)
        throw new Error('quote source does not match provider');
    const marketTime = nullableString(record.marketTime, 'quote marketTime');
    if (marketTime !== null)
        requireTimestamp(marketTime, 'quote marketTime');
    const fetchedAt = requiredString(record.fetchedAt, 'quote fetchedAt');
    requireTimestamp(fetchedAt, 'quote fetchedAt');
    return {
        symbol,
        name: nullableString(record.name, 'quote name'),
        market,
        currency: currency,
        price: nullableFinite(record.price, 'quote price'),
        open: nullableFinite(record.open, 'quote open'),
        high: nullableFinite(record.high, 'quote high'),
        low: nullableFinite(record.low, 'quote low'),
        previousClose: nullableFinite(record.previousClose, 'quote previousClose'),
        volume: nullableFinite(record.volume, 'quote volume'),
        amount: nullableFinite(record.amount, 'quote amount'),
        change: nullableFinite(record.change, 'quote change'),
        changePercent: nullableFinite(record.changePercent, 'quote changePercent'),
        marketTime,
        fetchedAt,
        source,
        isDelayed: requiredBoolean(record.isDelayed, 'quote isDelayed'),
        isStale: requiredBoolean(record.isStale, 'quote isStale'),
    };
}
function canonicalBar(value, symbol, market, interval) {
    const record = plainRecord(value, 'bar');
    if (requiredString(record.symbol, 'bar symbol') !== symbol)
        throw new Error('bar symbol does not match request');
    if (requiredMarket(record.market, 'bar market') !== market)
        throw new Error('bar market does not match request');
    if (requiredString(record.interval, 'bar interval') !== interval)
        throw new Error('bar interval does not match request');
    const timestamp = requiredString(record.timestamp, 'bar timestamp');
    requireTimestamp(timestamp, 'bar timestamp');
    return {
        symbol,
        market,
        interval,
        timestamp,
        open: requiredFinite(record.open, 'bar open'),
        high: requiredFinite(record.high, 'bar high'),
        low: requiredFinite(record.low, 'bar low'),
        close: requiredFinite(record.close, 'bar close'),
        volume: nullableFinite(record.volume, 'bar volume'),
        turnover: nullableFinite(record.turnover, 'bar turnover'),
    };
}
function canonicalSector(value, expectedSource) {
    const record = plainRecord(value, 'sector');
    const marketTime = nullableString(record.marketTime, 'sector marketTime');
    if (marketTime !== null)
        requireTimestamp(marketTime, 'sector marketTime');
    const fetchedAt = requiredString(record.fetchedAt, 'sector fetchedAt');
    requireTimestamp(fetchedAt, 'sector fetchedAt');
    const source = requiredString(record.source, 'sector source');
    if (expectedSource !== undefined && source !== expectedSource)
        throw new Error('sector source does not match provider');
    return {
        id: requiredString(record.id, 'sector id'),
        name: requiredString(record.name, 'sector name'),
        category: requiredString(record.category, 'sector category'),
        changePercent: nullableFinite(record.changePercent, 'sector changePercent'),
        turnover: nullableFinite(record.turnover, 'sector turnover'),
        netFlow: nullableFinite(record.netFlow, 'sector netFlow'),
        leaderSymbol: nullableString(record.leaderSymbol, 'sector leaderSymbol'),
        leaderName: nullableString(record.leaderName, 'sector leaderName'),
        leaderChangePercent: nullableFinite(record.leaderChangePercent, 'sector leaderChangePercent'),
        marketTime,
        fetchedAt,
        source,
        isDelayed: requiredBoolean(record.isDelayed, 'sector isDelayed'),
        isStale: requiredBoolean(record.isStale, 'sector isStale'),
    };
}
function sourceConflict(first, second, windowMs, detectedAt) {
    if (first.source === second.source || first.price === null || second.price === null || first.marketTime === null || second.marketTime === null)
        return null;
    const firstTime = strictTimestamp(first.marketTime);
    const secondTime = strictTimestamp(second.marketTime);
    if (firstTime === null || secondTime === null || Math.abs(firstTime - secondTime) > windowMs)
        return null;
    const preferred = first.source === 'tencent' ? first : second.source === 'tencent' ? second : first;
    const alternate = preferred === first ? second : first;
    const threshold = Math.max(0.01, Math.abs(preferred.price ?? 0) * 0.001);
    if (Math.abs((preferred.price ?? 0) - (alternate.price ?? 0)) <= threshold)
        return null;
    return {
        symbol: preferred.symbol,
        field: 'price',
        observations: [
            { source: preferred.source, marketTime: preferred.marketTime, value: preferred.price },
            { source: alternate.source, marketTime: alternate.marketTime, value: alternate.price },
        ],
        detectedAt,
    };
}
function newestMarketTime(items) {
    let latest = null;
    for (const item of items) {
        if (item.marketTime === null)
            continue;
        const time = strictTimestamp(item.marketTime);
        if (time !== null && (latest === null || time > latest.time))
            latest = { value: item.marketTime, time };
    }
    return latest?.value ?? null;
}
function availabilityFor(items, liveReturned) {
    if (items.length === 0)
        return 'unavailable';
    if (items.some(({ isStale }) => isStale))
        return 'stale';
    return liveReturned ? 'live' : 'cached';
}
function unavailableQuotes() {
    return { availability: 'unavailable', items: [], conflicts: [] };
}
function isOlderThan(timestamp, now, ageMs) {
    return now.getTime() - Date.parse(timestamp) > ageMs;
}
function compareTimestamp(left, right) {
    return Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.timestamp.localeCompare(right.timestamp);
}
function compareSectors(left, right, field, direction) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue === null && rightValue !== null)
        return 1;
    if (leftValue !== null && rightValue === null)
        return -1;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        return direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
    }
    return left.category.localeCompare(right.category) || left.id.localeCompare(right.id) || left.source.localeCompare(right.source);
}
function sessionBounds(market, phase, minute) {
    if (market === 'CN' && phase === 'auction')
        return { start: '09:15', end: '09:30' };
    if (market === 'HK' && phase === 'preopen')
        return { start: '09:00', end: '09:30' };
    if (phase === 'continuous') {
        if (market === 'CN')
            return minute < 12 * 60 ? { start: '09:30', end: '11:30' } : { start: '13:00', end: '15:00' };
        return minute < 12 * 60 + 30 ? { start: '09:30', end: '12:00' } : { start: '13:00', end: '16:00' };
    }
    return { start: null, end: null };
}
function emptyProviderHealth(provider) {
    return {
        provider,
        available: false,
        latencyMs: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        errorCategory: null,
    };
}
function unwrapStorageFailure(error) {
    return error instanceof StorageFailure ? error.unwrap() : error;
}
function canonicalHealthValue(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error('health numeric fields must be finite');
        return (Object.is(value, -0) ? 0 : value);
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (isDenseArray(value))
        return value.map((item) => canonicalHealthValue(item));
    if (isPlainRecord(value)) {
        const result = {};
        for (const [key, item] of Object.entries(value))
            result[key] = canonicalHealthValue(item);
        return result;
    }
    throw new Error('health must contain only lossless plain JSON values');
}
function serviceHealthFromStored(item) {
    return {
        provider: item.provider,
        available: item.available,
        latencyMs: item.latencyMs,
        lastAttemptAt: item.lastAttemptAt,
        lastSuccessAt: item.lastSuccessAt,
        lastFailureAt: item.lastFailureAt,
        consecutiveFailures: item.consecutiveFailures,
        errorCategory: storedErrorCategory(item.error),
    };
}
function storedErrorCategory(value) {
    if (value === null)
        return null;
    return ['timeout', 'abort', 'http', 'decode', 'parse', 'storage', 'network', 'validation', 'partial', 'unknown'].includes(value)
        ? value
        : 'unknown';
}
function errorCategory(error) {
    const name = error instanceof Error ? error.name.toLowerCase() : '';
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (name.includes('timeout') || message.includes('timeout') || message.includes('timed out'))
        return 'timeout';
    if (name.includes('abort') || message.includes('abort') || message.includes('cancel'))
        return 'abort';
    if (message.includes('http') || message.includes('status'))
        return 'http';
    if (message.includes('decode') || message.includes('encoding'))
        return 'decode';
    if (message.includes('parse') || message.includes('json') || message.includes('response'))
        return 'parse';
    if (message.includes('sqlite') || message.includes('database') || message.includes('storage') || message.includes('disk'))
        return 'storage';
    if (message.includes('network') || message.includes('socket') || message.includes('fetch') || message.includes('offline'))
        return 'network';
    return 'unknown';
}
function isValidationFailure(error) {
    return error instanceof Error && error.message.startsWith('invalid provider');
}
function isAlreadyRecordedSectorValidation(error) {
    return error instanceof Error && error.message === 'invalid Sina sector response';
}
function nonNegativeSafeIntegerOrNull(value) {
    return Number.isSafeInteger(value) && value >= 0 ? Object.is(value, -0) ? 0 : value : null;
}
function validatedLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
        throw new Error('limit must be an integer from 1 to 10000');
    return value;
}
function validateInterval(value) {
    if (value !== 'minute' && value !== 'day' && value !== 'week' && value !== 'month')
        throw new Error('series interval is unsupported');
}
function validateMarket(value) {
    if (value !== 'CN' && value !== 'HK')
        throw new Error('market must be CN or HK');
}
function requireTradingDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error('closed trading date must be YYYY-MM-DD');
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
        throw new Error('closed trading date must be a valid calendar date');
    }
}
function requireTimestamp(value, label) {
    if (strictTimestamp(value) === null)
        throw new Error(`${label} must be a valid ISO timestamp`);
}
function strictTimestamp(value) {
    const match = TIMESTAMP.exec(value);
    if (!match)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const zone = match[8];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59)
        return null;
    const offset = offsetMinutes(zone);
    const timestamp = Date.parse(value);
    if (offset === null || !Number.isFinite(timestamp))
        return null;
    const represented = new Date(timestamp + offset * 60_000);
    if (represented.getUTCFullYear() !== year || represented.getUTCMonth() + 1 !== month || represented.getUTCDate() !== day
        || represented.getUTCHours() !== hour || represented.getUTCMinutes() !== minute || represented.getUTCSeconds() !== second)
        return null;
    return timestamp;
}
function offsetMinutes(zone) {
    if (zone === 'Z')
        return 0;
    const hour = Number(zone.slice(1, 3));
    const minute = Number(zone.slice(4, 6));
    if (hour > 23 || minute > 59)
        return null;
    return (zone[0] === '+' ? 1 : -1) * (hour * 60 + minute);
}
function daysInMonth(year, month) {
    if (month === 2)
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function plainRecord(value, label) {
    if (!isPlainRecord(value))
        throw new Error(`${label} must be a plain object`);
    return value;
}
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isDenseArray(value) {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Object.keys(value).length === value.length;
}
function requiredString(value, label) {
    if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function nullableString(value, label) {
    if (value !== null && typeof value !== 'string')
        throw new Error(`${label} must be a string or null`);
    return value;
}
function requiredFinite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${label} must be finite`);
    return Object.is(value, -0) ? 0 : value;
}
function nullableFinite(value, label) {
    if (value === null)
        return null;
    return requiredFinite(value, label);
}
function requiredBoolean(value, label) {
    if (typeof value !== 'boolean')
        throw new Error(`${label} must be boolean`);
    return value;
}
function requiredMarket(value, label) {
    if (value !== 'CN' && value !== 'HK')
        throw new Error(`${label} must be CN or HK`);
    return value;
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw abortReason(signal);
}
function abortReason(signal) {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
