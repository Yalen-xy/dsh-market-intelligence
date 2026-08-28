import { fixedGet, SharedRequestLimiter } from '../http.js';
import { canonicalizeSymbol } from '../symbols.js';
export const SINA_QUOTE_URL = 'https://hq.sinajs.cn/list={symbols}';
export const SINA_INDUSTRY_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
export const SINA_CONCEPT_URL = 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class';
export const SINA_MAX_QUOTE_SYMBOLS = 100;
const QUOTE_MAX_BYTES = 2 * 1024 * 1024;
const SECTOR_MAX_BYTES = 8 * 1024 * 1024;
const SINA_REFERER = 'https://finance.sina.com.cn/';
export class SinaProvider {
    historyCapabilities = [];
    fetchImpl;
    now;
    requestTimeoutMs;
    timeoutSignal;
    requestLimiter;
    constructor(options = {}) {
        this.fetchImpl = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs');
        this.timeoutSignal = options.timeoutSignal;
        this.requestLimiter = options.requestLimiter ?? new SharedRequestLimiter(3);
    }
    async quotes(symbols, signal) {
        if (symbols.length > SINA_MAX_QUOTE_SYMBOLS) {
            throw new Error('Sina supports at most 100 symbols');
        }
        const aShares = symbols
            .map(canonicalizeSymbol)
            .filter((symbol) => symbol.market === 'CN')
            .map((symbol) => symbol.symbol);
        if (aShares.length === 0)
            return { items: [] };
        const url = SINA_QUOTE_URL.replace('{symbols}', aShares.join(','));
        return { items: parseSinaQuotes(await this.getText(url, QUOTE_MAX_BYTES, signal), this.fetchedAt()) };
    }
    async sectors(signal) {
        const [industry, concept] = await Promise.all([
            this.getText(SINA_INDUSTRY_URL, SECTOR_MAX_BYTES, signal),
            this.getText(SINA_CONCEPT_URL, SECTOR_MAX_BYTES, signal),
        ]);
        const fetchedAt = this.fetchedAt();
        return {
            items: [
                ...parseSinaSectors(industry, 'industry', fetchedAt),
                ...parseSinaSectors(concept, 'concept', fetchedAt),
            ],
        };
    }
    async getText(url, maxBytes, signal) {
        const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet({ url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes, referer: SINA_REFERER }, this.fetchImpl, requestSignal, this.timeoutSignal));
        return new TextDecoder('gbk').decode(bytes);
    }
    fetchedAt() {
        return new Date(this.now()).toISOString();
    }
}
export function parseSinaQuotes(payload, fetchedAt) {
    return assignments(payload).flatMap(({ identifier, value }) => {
        if (!/^hq_str_(?:sh|sz)\d{6}$/.test(identifier) || typeof value !== 'string')
            return [];
        const fields = value.split(',');
        const price = finiteNumber(fields[3]);
        if (price === null)
            return [];
        const symbol = identifier.slice('hq_str_'.length);
        const previousClose = finiteNumber(fields[2]);
        const change = previousClose === null ? null : rounded(price - previousClose);
        return [{
                symbol,
                name: nonEmpty(fields[0]),
                market: 'CN',
                currency: 'CNY',
                price,
                open: finiteNumber(fields[1]),
                high: finiteNumber(fields[4]),
                low: finiteNumber(fields[5]),
                previousClose,
                volume: finiteNumber(fields[8]),
                amount: finiteNumber(fields[9]),
                change,
                changePercent: change === null || previousClose === null || previousClose === 0 ? null : rounded((change / previousClose) * 100),
                marketTime: marketTime(fields[30], fields[31]),
                fetchedAt,
                source: 'sina',
                isDelayed: false,
                isStale: false,
            }];
    });
}
export function parseSinaSectors(payload, category, fetchedAt) {
    return assignments(payload).flatMap(({ value }) => {
        if (!isRecord(value))
            return [];
        return Object.entries(value).flatMap(([id, row]) => {
            if (!nonEmpty(id) || typeof row !== 'string')
                return [];
            const fields = row.split(',');
            const currentLayout = fields[0] === id;
            const name = nonEmpty(fields[currentLayout ? 1 : 0]);
            if (name === null)
                return [];
            return [{
                    id,
                    name,
                    category,
                    changePercent: finiteNumber(fields[currentLayout ? 5 : 1]),
                    turnover: finiteNumber(fields[currentLayout ? 7 : 3]),
                    netFlow: null,
                    leaderSymbol: nonEmpty(fields[currentLayout ? 8 : 4]),
                    leaderName: nonEmpty(fields[currentLayout ? 12 : 5]),
                    leaderChangePercent: finiteNumber(fields[currentLayout ? 9 : 6]),
                    marketTime: null,
                    fetchedAt,
                    source: 'sina',
                    isDelayed: false,
                    isStale: false,
                }];
        });
    });
}
function assignments(payload) {
    return payload.split(/\r?\n/).flatMap((line) => {
        const match = /^(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.*?)\s*;?\s*$/.exec(line.trim());
        if (!match)
            return [];
        const value = jsonValue(match[2] ?? '');
        return value === undefined ? [] : [{ identifier: match[1], value }];
    });
}
function jsonValue(value) {
    if (!(value.startsWith('"') || value.startsWith('{')))
        return undefined;
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'string' || isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
function finiteNumber(value) {
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    if (typeof value === 'string' && value.trim() === '')
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function marketTime(date, time) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        && typeof time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(time)
        ? date + 'T' + time + '+08:00'
        : null;
}
function rounded(value) {
    return Number(value.toFixed(8));
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive integer`);
    return value;
}
