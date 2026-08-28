import { fixedGet, SharedRequestLimiter } from '../http.js';
import { canonicalizeSymbol } from '../symbols.js';
export const TENCENT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1';
export const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq';
export const TENCENT_SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/?v=2&q={query}&t=all';
const QUOTE_MAX_BYTES = 2 * 1024 * 1024;
export const TENCENT_MAX_QUOTE_SYMBOLS = 100;
export const TENCENT_QUOTE_CONCURRENCY = 4;
export class TencentProvider {
    historyCapabilities = [];
    fetchImpl;
    now;
    requestTimeoutMs;
    quoteConcurrency;
    timeoutSignal;
    requestLimiter;
    constructor(options = {}) {
        this.fetchImpl = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs');
        this.quoteConcurrency = boundedInteger(options.quoteConcurrency ?? TENCENT_QUOTE_CONCURRENCY, 1, TENCENT_MAX_QUOTE_SYMBOLS, 'quoteConcurrency');
        this.timeoutSignal = options.timeoutSignal;
        this.requestLimiter = options.requestLimiter ?? new SharedRequestLimiter(this.quoteConcurrency);
    }
    async quotes(symbols, signal) {
        if (symbols.length > TENCENT_MAX_QUOTE_SYMBOLS) {
            throw new Error('Tencent supports at most 100 symbols');
        }
        const quotes = await mapWithConcurrency(symbols, this.quoteConcurrency, (symbol) => this.quote(symbol, signal));
        return { items: quotes.filter((quote) => quote !== null) };
    }
    async series(request, signal) {
        const symbol = canonicalizeSymbol(request.symbol);
        if (request.interval === 'minute') {
            const url = TENCENT_MINUTE_URL.replace('{code}', encodeURIComponent(symbol.symbol));
            return { items: parseMinuteBars(await this.getJson(url, signal), symbol.symbol, symbol.market) };
        }
        const url = TENCENT_KLINE_URL
            .replace('{code}', encodeURIComponent(symbol.symbol))
            .replace('{period}', request.interval)
            .replace('{count}', String(request.count ?? 320));
        return { items: parseKlineBars(await this.getJson(url, signal), symbol.symbol, symbol.market, request.interval) };
    }
    async auction(symbols, phase, signal) {
        if (phase !== 'auction' && phase !== 'preopen')
            return { phase, items: [] };
        const market = phase === 'auction' ? 'CN' : 'HK';
        const phaseSymbols = symbols.filter((symbol) => canonicalizeSymbol(symbol).market === market);
        return { phase, items: (await this.quotes(phaseSymbols, signal)).items };
    }
    async search(query, signal) {
        const url = TENCENT_SMARTBOX_URL.replace('{query}', encodeURIComponent(query));
        const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet({ url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes: QUOTE_MAX_BYTES }, this.fetchImpl, requestSignal, this.timeoutSignal));
        const text = new TextDecoder('gbk').decode(bytes);
        const assignment = /^v_hint\s*=\s*("(?:\\.|[^"\\])*")\s*;?\s*$/s.exec(text.trim());
        let rows;
        if (assignment) {
            try {
                const value = JSON.parse(assignment[1]);
                rows = typeof value === 'string' ? value.split('^') : [];
            }
            catch {
                rows = [];
            }
        }
        else {
            rows = text.split(/\r?\n/);
        }
        const items = rows
            .map((row) => row.split('~'))
            .filter((fields) => fields[0] === 'hk' && fields[4] === 'GP')
            .map((fields) => {
            const code = fields[1];
            const name = fields[2];
            if (!/^\d{1,5}$/.test(code ?? '') || !name)
                return null;
            return { symbol: canonicalizeSymbol('hk' + code).symbol, name, market: 'HK', currency: 'HKD' };
        })
            .filter((item) => item !== null);
        return { items };
    }
    async quote(symbol, signal) {
        const canonical = canonicalizeSymbol(symbol);
        const url = TENCENT_MINUTE_URL.replace('{code}', encodeURIComponent(canonical.symbol));
        return parseQuote(await this.getJson(url, signal), canonical.symbol, canonical.market, canonical.currency, this.now());
    }
    async getJson(url, signal) {
        const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet({ url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes: QUOTE_MAX_BYTES }, this.fetchImpl, requestSignal, this.timeoutSignal));
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        }
        catch {
            throw new Error('Invalid Tencent response');
        }
    }
}
function parseQuote(payload, symbol, market, currency, now) {
    const entry = quoteEntry(payload, symbol);
    const values = entry?.qt?.[symbol];
    if (!Array.isArray(values))
        return null;
    const price = finiteNumber(values[3]);
    const previousClose = finiteNumber(values[4]);
    const change = price === null || previousClose === null ? null : rounded(price - previousClose);
    const currentLayout = values.length >= 36 && finiteNumber(values[33]) !== null && finiteNumber(values[34]) !== null;
    const amountParts = currentLayout && typeof values[35] === 'string' ? values[35].split('/') : [];
    return {
        symbol,
        name: stringValue(values[1]),
        market,
        currency,
        price,
        open: finiteNumber(values[5]),
        high: finiteNumber(values[currentLayout ? 33 : 8]),
        low: finiteNumber(values[currentLayout ? 34 : 9]),
        previousClose,
        volume: finiteNumber(values[currentLayout ? 36 : 6]) ?? finiteNumber(values[6]),
        amount: finiteNumber(currentLayout ? amountParts[2] : values[7]),
        change,
        changePercent: change === null || previousClose === null || previousClose === 0 ? null : rounded((change / previousClose) * 100),
        marketTime: marketTime(entry, values),
        fetchedAt: new Date(now).toISOString(),
        source: 'tencent',
        isDelayed: false,
        isStale: false,
    };
}
function parseMinuteBars(payload, symbol, market) {
    const entry = quoteEntry(payload, symbol);
    const date = normalizedDate(entry?.data?.date);
    const lines = entry?.data?.data;
    if (!date || !Array.isArray(lines))
        return [];
    return lines.flatMap((line) => {
        const parts = typeof line === 'string' ? line.trim().split(/\s+/) : [];
        const price = finiteNumber(parts[1]);
        if (!/^\d{4}$/.test(parts[0] ?? '') || price === null)
            return [];
        return [{
                symbol,
                market,
                interval: 'minute',
                timestamp: date + 'T' + parts[0].slice(0, 2) + ':' + parts[0].slice(2) + ':00+08:00',
                open: price,
                high: price,
                low: price,
                close: price,
                volume: finiteNumber(parts[2]),
                turnover: null,
            }];
    });
}
function parseKlineBars(payload, symbol, market, interval) {
    const data = objectValue(payload);
    const entry = objectValue(objectValue(data?.data)?.[symbol]);
    const rows = entry?.['qfq' + interval] ?? entry?.[interval];
    if (!Array.isArray(rows))
        return [];
    return rows.flatMap((row) => {
        if (!Array.isArray(row))
            return [];
        const [date, open, close, high, low, volume, turnover] = row;
        const parsedOpen = finiteNumber(open);
        const parsedClose = finiteNumber(close);
        const parsedHigh = finiteNumber(high);
        const parsedLow = finiteNumber(low);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || parsedOpen === null || parsedClose === null || parsedHigh === null || parsedLow === null)
            return [];
        return [{
                symbol,
                market,
                interval,
                timestamp: String(date) + 'T00:00:00+08:00',
                open: parsedOpen,
                high: parsedHigh,
                low: parsedLow,
                close: parsedClose,
                volume: finiteNumber(volume),
                turnover: finiteNumber(turnover),
            }];
    });
}
function quoteEntry(payload, symbol) {
    const data = objectValue(objectValue(payload)?.data);
    const entry = objectValue(data?.[symbol]);
    if (!entry)
        return null;
    return {
        qt: objectValue(entry.qt) ?? undefined,
        data: objectValue(entry.data) ?? undefined,
    };
}
function marketTime(entry, values) {
    const date = normalizedDate(entry?.data?.date);
    const lines = entry?.data?.data;
    if (date && Array.isArray(lines) && lines.length > 0) {
        const last = lines[lines.length - 1];
        const hhmm = typeof last === 'string' ? last.trim().split(/\s+/)[0] : undefined;
        if (hhmm && /^\d{4}$/.test(hhmm))
            return date + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2) + ':00+08:00';
    }
    const timestamp = stringValue(values[30]);
    return timestamp && /^\d{14}$/.test(timestamp)
        ? timestamp.slice(0, 4) + '-' + timestamp.slice(4, 6) + '-' + timestamp.slice(6, 8)
            + 'T' + timestamp.slice(8, 10) + ':' + timestamp.slice(10, 12) + ':' + timestamp.slice(12, 14) + '+08:00'
        : null;
}
function normalizedDate(value) {
    const date = stringValue(value);
    if (!date)
        return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date))
        return date;
    return /^\d{8}$/.test(date) ? date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) : null;
}
function objectValue(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function finiteNumber(value) {
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    if (typeof value === 'string' && value.trim() === '')
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function rounded(value) {
    return Number(value.toFixed(8));
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive integer`);
    return value;
}
function boundedInteger(value, minimum, maximum, label) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}
async function mapWithConcurrency(values, concurrency, mapper) {
    const output = new Array(values.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            output[index] = await mapper(values[index]);
        }
    });
    await Promise.all(workers);
    return output;
}
export const tencentParsing = { parseMinuteBars, parseKlineBars };
