import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
export function resolveRuntimePaths(dshHome, storageDir) {
    const root = storageDir ?? path.join(dshHome, 'storages', 'dsh-market-intelligence');
    return {
        root,
        database: path.join(root, 'market.sqlite'),
        config: path.join(root, 'config.json'),
    };
}
export async function loadUserState(paths) {
    try {
        const content = await readFile(paths.config, 'utf8');
        return validateUserState(JSON.parse(content));
    }
    catch (error) {
        if (isMissingFile(error))
            return { watchlist: [], closures: {} };
        throw error;
    }
}
export async function mutateWatchlist(paths, mutation) {
    const state = await loadUserState(paths);
    const watchlist = [...state.watchlist];
    const result = mutation(watchlist);
    const next = validateUserState({
        ...state,
        watchlist: result ?? watchlist,
    });
    await writeUserState(paths, next);
    return next;
}
export function validateUserState(value) {
    if (!isRecord(value) || !Array.isArray(value.watchlist) || !isRecord(value.closures)) {
        throw new Error('Invalid user state');
    }
    if (value.watchlist.length > 100) {
        throw new Error('Watchlist cannot contain more than 100 symbols');
    }
    if (!value.watchlist.every((symbol) => typeof symbol === 'string' && symbol.length > 0)) {
        throw new Error('Watchlist entries must be non-empty symbols');
    }
    const normalized = value.watchlist.map((symbol) => symbol.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
        throw new Error('Watchlist contains duplicate symbols');
    }
    return { watchlist: [...value.watchlist], closures: validateMarketClosures(value.closures) };
}
export function validateMarketClosures(value) {
    if (!isRecord(value))
        throw new Error('Market closures must be an object');
    const closures = {};
    for (const [year, markets] of Object.entries(value)) {
        if (!/^\d{4}$/.test(year) || !isRecord(markets) || !hasExactKeys(markets, ['CN', 'HK'])) {
            throw new Error(`Invalid market closures for ${year}`);
        }
        closures[year] = {
            CN: validatedClosureDates(markets.CN, year, 'CN'),
            HK: validatedClosureDates(markets.HK, year, 'HK'),
        };
    }
    return closures;
}
async function writeUserState(paths, state) {
    await mkdir(paths.root, { recursive: true });
    const temporaryPath = `${paths.config}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, paths.config);
}
function isMissingFile(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
function isRecord(value) {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function isStringArray(value) {
    return Array.isArray(value)
        && Object.getPrototypeOf(value) === Array.prototype
        && Object.keys(value).length === value.length
        && value.every((entry) => typeof entry === 'string');
}
function validatedClosureDates(value, year, market) {
    if (!isStringArray(value))
        throw new Error(`Invalid ${market} market closures for ${year}`);
    const seen = new Set();
    for (const date of value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) !== year || !isCalendarDate(date)) {
            throw new Error(`Invalid ${market} closure date ${date} for ${year}`);
        }
        if (seen.has(date))
            throw new Error(`Duplicate ${market} closure date ${date}`);
        seen.add(date);
    }
    return [...value];
}
function isCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
        return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}
function daysInMonth(year, month) {
    if (month === 2)
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}
