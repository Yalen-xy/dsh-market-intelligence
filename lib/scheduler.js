import { lastClosedTradingDate, marketState, nextStateChange, shanghaiMinuteOfDay } from './calendar.js';
const BACKOFF_MS = [10_000, 30_000, 60_000, 300_000];
const MARKETS = ['CN', 'HK'];
const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
export class MarketScheduler {
    clock;
    closures;
    quoteIntervalMs;
    sectorIntervalMs;
    sectorPersistIntervalMs;
    jitterMs;
    nextQuoteAt = new Map();
    failures = new Map();
    marketTimes = new Map();
    maintained = new Set();
    pendingMaintenance = new Map();
    runningMaintenance = new Set();
    inFlight = new Set();
    callbacks = null;
    controller = null;
    quoteTimer;
    sectorTimer;
    lastSectorBucket = null;
    sectorFailures = 0;
    quoteTickRunning = false;
    stopped = false;
    disposal = null;
    constructor(options) {
        this.clock = options.clock;
        this.closures = options.closures ?? {};
        this.quoteIntervalMs = options.quoteIntervalMs ?? 10_000;
        this.sectorIntervalMs = options.sectorIntervalMs ?? 60_000;
        this.sectorPersistIntervalMs = options.sectorPersistIntervalMs ?? 300_000;
        this.jitterMs = options.jitterMs ?? (() => Math.floor(Math.random() * 1_000));
    }
    start(callbacks) {
        if (this.callbacks)
            throw new Error('MarketScheduler has already started');
        this.callbacks = callbacks;
        this.controller = new AbortController();
        this.launchQuoteTick();
        this.scheduleInitialSectorTick();
        return () => this.dispose();
    }
    health() {
        return {
            pendingTimers: Number(this.quoteTimer !== undefined) + Number(this.sectorTimer !== undefined),
            inFlight: this.inFlight.size,
        };
    }
    launchQuoteTick() {
        if (this.quoteTickRunning)
            return;
        this.quoteTickRunning = true;
        const task = this.quoteTick();
        this.track(task);
        const finish = () => {
            this.quoteTickRunning = false;
            if (!this.stopped)
                this.scheduleNextQuoteTick();
        };
        void task.then(finish, finish);
    }
    launchSectorTick() {
        this.track(this.sectorTick());
    }
    async quoteTick() {
        if (this.stopped || !this.callbacks || !this.controller)
            return;
        const state = marketState(this.clock.now(), this.closures);
        this.queueOutstandingMaintenance();
        this.runPendingMaintenance();
        const now = this.clock.now().getTime();
        const active = MARKETS.filter((market) => state[market].active && (this.nextQuoteAt.get(market) ?? now) <= now);
        if (active.length > 0) {
            try {
                const result = await this.callbacks.collectQuotes(active, this.controller.signal);
                if (!this.stopped)
                    await this.recordQuoteResult(active, result);
            }
            catch (error) {
                if (!this.controller.signal.aborted)
                    this.recordQuoteFailure(active);
            }
        }
        if (!this.stopped)
            this.scheduleNextQuoteTick();
    }
    async sectorTick() {
        if (this.stopped || !this.callbacks || !this.controller)
            return;
        const state = marketState(this.clock.now(), this.closures).CN;
        if (state.active) {
            const bucket = this.sectorBucket(state.tradingDate);
            const persist = bucket !== this.lastSectorBucket;
            try {
                await this.callbacks.collectSectors(this.controller.signal, persist);
                if (persist)
                    this.lastSectorBucket = bucket;
                this.sectorFailures = 0;
            }
            catch {
                if (!this.controller.signal.aborted)
                    this.sectorFailures++;
            }
        }
        if (!this.stopped)
            this.scheduleNextSectorTick();
    }
    async recordQuoteResult(markets, result) {
        const times = result && typeof result === 'object' ? result.marketTimes : undefined;
        const advanced = [];
        for (const market of markets) {
            const timestamp = times?.[market];
            const parsed = typeof timestamp === 'string' ? parseCanonicalTimestamp(timestamp) : null;
            const previous = this.marketTimes.get(market);
            if (parsed !== null && (previous === undefined || parsed > previous)) {
                advanced.push({ market, timestamp: parsed });
            }
            else {
                this.recordQuoteFailure([market]);
            }
        }
        const controller = this.controller;
        try {
            if (advanced.length === 0 || !this.callbacks || !controller)
                return;
            if (result?.commit)
                await result.commit(advanced.map(({ market }) => market), controller.signal);
        }
        catch {
            if (controller && !controller.signal.aborted)
                this.recordQuoteFailure(advanced.map(({ market }) => market));
            return;
        }
        finally {
            if (result?.release) {
                try {
                    await result.release();
                }
                catch {
                    if (controller && !controller.signal.aborted)
                        this.recordQuoteFailure(advanced.map(({ market }) => market));
                }
            }
        }
        if (this.stopped)
            return;
        for (const { market, timestamp } of advanced) {
            this.marketTimes.set(market, timestamp);
            this.failures.set(market, 0);
            this.nextQuoteAt.set(market, this.clock.now().getTime() + this.quoteIntervalMs);
        }
    }
    recordQuoteFailure(markets) {
        for (const market of markets) {
            const failures = (this.failures.get(market) ?? 0) + 1;
            this.failures.set(market, failures);
            const backoff = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
            this.nextQuoteAt.set(market, this.clock.now().getTime() + backoff + this.safeJitter(backoff));
        }
    }
    scheduleNextQuoteTick() {
        const now = this.clock.now();
        const state = marketState(now, this.closures);
        const candidates = [];
        for (const market of MARKETS) {
            if (state[market].active)
                candidates.push(this.nextQuoteAt.get(market) ?? now.getTime());
            candidates.push(nextStateChange(now, market, this.closures).getTime());
        }
        for (const [key, pending] of this.pendingMaintenance) {
            if (!this.runningMaintenance.has(key))
                candidates.push(pending.nextAttemptAt);
        }
        this.scheduleQuote(Math.max(0, Math.min(...candidates) - now.getTime()));
    }
    scheduleInitialSectorTick() {
        const now = this.clock.now();
        const state = marketState(now, this.closures).CN;
        const delay = state.active
            ? this.sectorIntervalMs
            : Math.max(0, nextStateChange(now, 'CN', this.closures).getTime() - now.getTime()) + this.sectorIntervalMs;
        this.scheduleSector(delay);
    }
    scheduleNextSectorTick() {
        const now = this.clock.now();
        const state = marketState(now, this.closures).CN;
        const delay = state.active
            ? (this.sectorFailures === 0 ? this.sectorIntervalMs : this.backoffDelay(this.sectorFailures))
            : Math.max(0, nextStateChange(now, 'CN', this.closures).getTime() - now.getTime()) + this.sectorIntervalMs;
        this.scheduleSector(delay);
    }
    scheduleQuote(delayMs) {
        if (this.quoteTimer !== undefined)
            this.clock.clearTimeout(this.quoteTimer);
        this.quoteTimer = this.clock.setTimeout(() => {
            this.quoteTimer = undefined;
            this.launchQuoteTick();
        }, delayMs);
    }
    scheduleSector(delayMs) {
        if (this.sectorTimer !== undefined)
            this.clock.clearTimeout(this.sectorTimer);
        this.sectorTimer = this.clock.setTimeout(() => {
            this.sectorTimer = undefined;
            this.launchSectorTick();
        }, delayMs);
    }
    queueOutstandingMaintenance() {
        for (const market of MARKETS) {
            const tradingDate = lastClosedTradingDate(this.clock.now(), market, this.closures);
            const key = `${market}:${tradingDate}`;
            if (this.maintained.has(key) || this.pendingMaintenance.has(key))
                continue;
            this.pendingMaintenance.set(key, { market, tradingDate, failures: 0, nextAttemptAt: this.clock.now().getTime() });
        }
    }
    runPendingMaintenance() {
        if (!this.callbacks || !this.controller)
            return;
        for (const [key, pending] of this.pendingMaintenance) {
            if (this.stopped || this.runningMaintenance.has(key) || pending.nextAttemptAt > this.clock.now().getTime())
                continue;
            this.runningMaintenance.add(key);
            this.track(this.runMaintenance(key, pending));
        }
    }
    async runMaintenance(key, pending) {
        if (!this.callbacks || !this.controller)
            return;
        try {
            await this.callbacks.runMaintenance(pending.market, pending.tradingDate, this.controller.signal);
            this.pendingMaintenance.delete(key);
            this.maintained.add(key);
        }
        catch {
            if (!this.controller.signal.aborted) {
                pending.failures++;
                pending.nextAttemptAt = this.clock.now().getTime() + this.backoffDelay(pending.failures);
            }
        }
        finally {
            this.runningMaintenance.delete(key);
            if (!this.stopped && !this.quoteTickRunning)
                this.scheduleNextQuoteTick();
        }
    }
    sectorBucket(tradingDate) {
        const minutes = shanghaiMinuteOfDay(this.clock.now());
        return `${tradingDate}:${Math.floor(minutes / (this.sectorPersistIntervalMs / 60_000))}`;
    }
    backoffDelay(failures) {
        const backoff = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
        return backoff + this.safeJitter(backoff);
    }
    safeJitter(backoffMs) {
        const value = this.jitterMs(backoffMs);
        return Number.isFinite(value) ? Math.max(0, value) : 0;
    }
    track(task) {
        this.inFlight.add(task);
        void task.then(() => this.inFlight.delete(task), () => this.inFlight.delete(task));
    }
    async dispose() {
        if (this.disposal)
            return this.disposal;
        this.disposal = (async () => {
            this.stopped = true;
            if (this.quoteTimer !== undefined)
                this.clock.clearTimeout(this.quoteTimer);
            if (this.sectorTimer !== undefined)
                this.clock.clearTimeout(this.sectorTimer);
            this.quoteTimer = undefined;
            this.sectorTimer = undefined;
            this.controller?.abort();
            await Promise.allSettled([...this.inFlight]);
        })();
        return this.disposal;
    }
}
function parseCanonicalTimestamp(value) {
    const match = CANONICAL_TIMESTAMP.exec(value);
    if (!match)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const zone = match[8];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
        return null;
    }
    const offsetMinutes = parseOffsetMinutes(zone);
    if (offsetMinutes === null)
        return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        return null;
    const local = new Date(timestamp + offsetMinutes * 60_000);
    if (local.getUTCFullYear() !== year
        || local.getUTCMonth() + 1 !== month
        || local.getUTCDate() !== day
        || local.getUTCHours() !== hour
        || local.getUTCMinutes() !== minute
        || local.getUTCSeconds() !== second) {
        return null;
    }
    return timestamp;
}
function parseOffsetMinutes(zone) {
    if (zone === 'Z')
        return 0;
    const sign = zone[0] === '+' ? 1 : -1;
    const hour = Number(zone.slice(1, 3));
    const minute = Number(zone.slice(4, 6));
    if (hour > 23 || minute > 59)
        return null;
    return sign * (hour * 60 + minute);
}
function daysInMonth(year, month) {
    if (month === 2)
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
