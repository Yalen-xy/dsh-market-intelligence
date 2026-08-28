import { isMarketTradingDate, lastClosedTradingDate, shanghaiDate } from './calendar.js';
import { MarketRepository } from './repository.js';
export const MEBIBYTE = 1_048_576;
export const DEFAULT_MAX_BYTES = 512 * MEBIBYTE;
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CUMULATIVE_QUOTE_SOURCES = new Set(['tencent', 'sina']);
export function maintainRepository(repository, policy = {}, now) {
    if (!(repository instanceof MarketRepository))
        throw new Error('repository must be a MarketRepository');
    const runAt = validatedNow(now);
    const minuteTradingDays = policy.minuteTradingDays ?? 30;
    if (!Number.isSafeInteger(minuteTradingDays) || minuteTradingDays < 0)
        throw new Error('minuteTradingDays must be a non-negative safe integer');
    const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error('maxBytes must be a positive safe integer');
    if (policy.closedTradingDate !== undefined && policy.market === undefined)
        throw new Error('market is required with closedTradingDate');
    if (policy.closedTradingDate !== undefined && !isTradingDate(policy.closedTradingDate))
        throw new Error('closedTradingDate must be a valid YYYY-MM-DD date');
    if (policy.closedTradingDate !== undefined && policy.market !== undefined
        && !isMarketTradingDate(policy.closedTradingDate, policy.market, policy.closures ?? {})) {
        throw new Error(`${policy.market} date ${policy.closedTradingDate} is not a trading date`);
    }
    if (policy.closedTradingDate !== undefined && policy.market !== undefined
        && policy.closedTradingDate > lastClosedTradingDate(now, policy.market, policy.closures ?? {})) {
        throw new Error(`${policy.market} trading date ${policy.closedTradingDate} is not closed`);
    }
    if (policy.databaseBytes !== undefined && typeof policy.databaseBytes !== 'function')
        throw new Error('databaseBytes must be a function');
    return repository.runMaintenance((access) => {
        const databaseBytes = policy.databaseBytes ?? (() => access.liveDatabaseBytes());
        const bytesBefore = measuredBytes(databaseBytes);
        const currentTradingDate = shanghaiDate(runAt);
        const result = {
            runAt,
            completedAt: runAt,
            compactedTradingDates: [],
            compactedRawRows: 0,
            createdMinuteBars: 0,
            createdDailyBars: 0,
            createdDailySectorSummaries: 0,
            deletedRawRows: 0,
            expiredMinuteTradingDates: [],
            expiredMinuteRows: 0,
            prunedMinuteTradingDates: [],
            prunedMinuteRows: 0,
            prunedSectorBuckets: [],
            prunedSectorRows: 0,
            bytesBefore,
            bytesAfter: bytesBefore,
            maxBytes,
            capSatisfied: bytesBefore <= maxBytes,
        };
        const markets = policy.market === undefined ? ['CN', 'HK'] : [policy.market];
        for (const market of markets) {
            const upperBound = market === policy.market ? policy.closedTradingDate : undefined;
            const dates = access.rawTradingDates(market).filter((date) => isCompactableDate(date, currentTradingDate, upperBound));
            for (const date of dates)
                compactClosedDate(access, market, date, runAt, result);
        }
        if (markets.includes('CN'))
            compactSectorSummaries(access, currentTradingDate, policy.market === 'CN' ? policy.closedTradingDate : undefined, result);
        expireMinuteDates(access, policy.market, minuteTradingDays, result);
        enforceSoftCap(access, databaseBytes, maxBytes, result);
        result.completedAt = runAt;
        access.recordMaintenance({ runAt, completedAt: result.completedAt, result: { ...result } });
        return result;
    });
}
function compactClosedDate(access, market, tradingDate, runAt, result) {
    const raw = access.rawQuotes(market, tradingDate);
    if (raw.length === 0)
        return;
    const bars = compactQuotes(raw, tradingDate);
    access.upsertBars(bars.minute);
    access.upsertBars(bars.daily);
    const deleted = access.deleteRawSymbols(market, tradingDate, bars.compactedSymbols);
    const expectedDeleted = raw.filter(({ symbol }) => bars.compactedSymbols.includes(symbol)).length;
    if (deleted !== expectedDeleted)
        throw new Error('raw quote compaction deletion count changed unexpectedly');
    for (const gap of bars.failedIntervals) {
        access.recordGap({
            market,
            symbol: gap.symbol,
            interval: 'minute',
            start: gap.start,
            end: gap.end,
            reason: 'compaction_unavailable',
            recordedAt: runAt,
        });
    }
    if (deleted > 0)
        result.compactedTradingDates.push(`${market}:${tradingDate}`);
    result.compactedRawRows += deleted;
    result.createdMinuteBars += bars.minute.length;
    result.createdDailyBars += bars.daily.length;
    result.deletedRawRows += deleted;
}
function compactQuotes(raw, tradingDate) {
    const bySymbol = groupBy(raw, ({ symbol }) => symbol);
    const minute = [];
    const daily = [];
    const compactedSymbols = [];
    const failedIntervals = [];
    for (const symbol of [...bySymbol.keys()].sort()) {
        const candidates = bySymbol.get(symbol);
        const withDeltas = attachCumulativeDeltas(candidates);
        const byMinute = groupBy(withDeltas, ({ marketTime, fetchedAt }) => shanghaiMinute(marketTime ?? fetchedAt));
        const selectedMinutes = [];
        for (const timestamp of [...byMinute.keys()].sort()) {
            const bySource = groupBy(byMinute.get(timestamp), ({ source }) => source);
            const selectedSource = [...bySource.keys()].sort(compareSources)
                .find((source) => bySource.get(source).some(({ price }) => price !== null));
            if (selectedSource === undefined) {
                failedIntervals.push({ symbol, start: timestamp, end: nextMinute(timestamp) });
                continue;
            }
            const bar = aggregateBar(bySource.get(selectedSource), 'minute', timestamp);
            if (bar !== null)
                selectedMinutes.push({ bar, source: selectedSource });
        }
        if (selectedMinutes.length === 0) {
            continue;
        }
        minute.push(...selectedMinutes.map(({ bar }) => bar));
        daily.push(aggregateDailyBar(selectedMinutes, tradingDate));
        compactedSymbols.push(symbol);
    }
    return { minute, daily, compactedSymbols, failedIntervals };
}
function compareSources(left, right) {
    const priority = (source) => source === 'tencent' ? 0 : source === 'sina' ? 1 : 2;
    return priority(left) - priority(right) || left.localeCompare(right);
}
function attachCumulativeDeltas(observations) {
    const previous = new Map();
    return observations.map((observation) => {
        const before = previous.get(observation.source);
        const semanticsPermit = CUMULATIVE_QUOTE_SOURCES.has(observation.source);
        const volumeDelta = semanticsPermit ? nonNegativeDelta(before?.volume ?? null, observation.volume) : null;
        const amountDelta = semanticsPermit ? nonNegativeDelta(before?.amount ?? null, observation.amount) : null;
        previous.set(observation.source, { volume: observation.volume, amount: observation.amount });
        return { ...observation, volumeDelta, amountDelta };
    });
}
function nonNegativeDelta(previous, current) {
    if (previous === null || current === null || current < previous)
        return null;
    const delta = current - previous;
    return Number.isFinite(delta) ? delta : null;
}
function aggregateBar(observations, interval, timestamp) {
    const priced = observations.filter((observation) => observation.price !== null);
    if (priced.length === 0)
        return null;
    const first = priced[0];
    const last = priced.at(-1);
    const volume = summedDeltas(observations, 'volumeDelta');
    const turnover = summedDeltas(observations, 'amountDelta');
    return {
        symbol: first.symbol,
        market: first.market,
        interval,
        timestamp,
        open: first.price,
        high: Math.max(...priced.map(({ price }) => price)),
        low: Math.min(...priced.map(({ price }) => price)),
        close: last.price,
        volume,
        turnover,
    };
}
function aggregateDailyBar(minutes, tradingDate) {
    const first = minutes[0].bar;
    const last = minutes.at(-1).bar;
    const oneSource = new Set(minutes.map(({ source }) => source)).size === 1;
    return {
        symbol: first.symbol,
        market: first.market,
        interval: 'day',
        timestamp: `${tradingDate}T00:00:00+08:00`,
        open: first.open,
        high: Math.max(...minutes.map(({ bar }) => bar.high)),
        low: Math.min(...minutes.map(({ bar }) => bar.low)),
        close: last.close,
        volume: oneSource ? sumAvailable(minutes.map(({ bar }) => bar.volume)) : null,
        turnover: oneSource ? sumAvailable(minutes.map(({ bar }) => bar.turnover)) : null,
    };
}
function sumAvailable(values) {
    const available = values.filter((value) => value !== null);
    if (available.length === 0)
        return null;
    const total = available.reduce((sum, value) => sum + value, 0);
    return Number.isFinite(total) ? total : null;
}
function compactSectorSummaries(access, currentTradingDate, closedUpperBound, result) {
    const dates = access.sectorIntradayDates().filter((date) => isCompactableDate(date, currentTradingDate, closedUpperBound));
    for (const date of dates) {
        const observations = access.sectorIntraday(date);
        const latest = new Map();
        for (const observation of observations) {
            const key = `${observation.category}\u0000${observation.id}\u0000${observation.source}`;
            latest.set(key, observation);
        }
        const summaries = [...latest.values()];
        result.createdDailySectorSummaries += access.upsertSectors(summaries, 'daily');
    }
}
function isCompactableDate(date, currentTradingDate, closedUpperBound) {
    return closedUpperBound === undefined
        ? date < currentTradingDate
        : date <= currentTradingDate && date <= closedUpperBound;
}
function summedDeltas(observations, field) {
    if (observations.some(({ source }) => !CUMULATIVE_QUOTE_SOURCES.has(source)))
        return null;
    const values = observations.map((observation) => observation[field]).filter((value) => value !== null);
    if (values.length === 0)
        return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return Number.isFinite(total) ? total : null;
}
function expireMinuteDates(access, selectedMarket, keep, result) {
    const markets = selectedMarket === undefined ? ['CN', 'HK'] : [selectedMarket];
    for (const market of markets) {
        const dates = access.minuteTradingDates(market);
        for (const date of dates.slice(0, Math.max(0, dates.length - keep))) {
            const deleted = access.deleteMinuteDate(date, market);
            if (deleted === 0)
                continue;
            result.expiredMinuteTradingDates.push(`${market}:${date}`);
            result.expiredMinuteRows += deleted;
        }
    }
}
function enforceSoftCap(access, databaseBytes, maxBytes, result) {
    let bytes = measuredBytes(databaseBytes);
    let stoppedForNoProgress = false;
    while (bytes > maxBytes) {
        const oldest = access.oldestMinuteTradingDate();
        if (oldest === null)
            break;
        const attempt = access.attemptMutation(() => ({ deleted: access.deleteMinuteDate(oldest), bytesAfter: measuredBytes(databaseBytes) }), (candidate) => candidate.deleted > 0 && candidate.bytesAfter < bytes);
        if (attempt.value.deleted === 0)
            throw new Error('oldest minute date could not be pruned');
        if (!attempt.committed) {
            stoppedForNoProgress = true;
            break;
        }
        result.prunedMinuteTradingDates.push(oldest);
        result.prunedMinuteRows += attempt.value.deleted;
        bytes = attempt.value.bytesAfter;
    }
    while (!stoppedForNoProgress && bytes > maxBytes) {
        const oldest = access.oldestSectorBucket();
        if (oldest === null)
            break;
        const attempt = access.attemptMutation(() => ({ deleted: access.deleteSectorBucket(oldest), bytesAfter: measuredBytes(databaseBytes) }), (candidate) => candidate.deleted > 0 && candidate.bytesAfter < bytes);
        if (attempt.value.deleted === 0)
            throw new Error('oldest sector bucket could not be pruned');
        if (!attempt.committed)
            break;
        result.prunedSectorBuckets.push(oldest);
        result.prunedSectorRows += attempt.value.deleted;
        bytes = attempt.value.bytesAfter;
    }
    result.bytesAfter = bytes;
    result.capSatisfied = bytes <= maxBytes;
}
function measuredBytes(databaseBytes) {
    const value = databaseBytes();
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('databaseBytes must return a non-negative safe integer');
    return value;
}
function validatedNow(now) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw new Error('now must be a valid Date');
    return now.toISOString();
}
function isTradingDate(value) {
    if (!TRADING_DATE.test(value))
        return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year === undefined || month === undefined || day === undefined || month < 1 || month > 12 || day < 1)
        return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}
function nextMinute(value) {
    return shanghaiMinute(new Date(Date.parse(value) + 60_000).toISOString());
}
function shanghaiMinute(timestamp) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00+08:00`;
}
function groupBy(items, key) {
    const groups = new Map();
    for (const item of items) {
        const value = key(item);
        const group = groups.get(value);
        if (group)
            group.push(item);
        else
            groups.set(value, [item]);
    }
    return groups;
}
