import { fixedGet, SharedRequestLimiter, type RequestLimiter, type TimeoutSignalFactory } from '../http.js';
import type { Bar, CanonicalQuote, MarketPhase } from '../model.js';
import { canonicalizeSymbol } from '../symbols.js';
import type { AuctionResult, MarketProvider, QuoteResult, SeriesRequest, SeriesResult } from './provider.js';

export const TENCENT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1';
export const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq';
export const TENCENT_SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/?v=2&q={query}&t=all';

const QUOTE_MAX_BYTES = 2 * 1024 * 1024;
export const TENCENT_MAX_QUOTE_SYMBOLS = 100;
export const TENCENT_QUOTE_CONCURRENCY = 4;

export type TencentProviderOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  quoteConcurrency?: number;
  requestLimiter?: RequestLimiter;
  timeoutSignal?: TimeoutSignalFactory;
};

export type SearchResult = {
  items: Array<{
    symbol: string;
    name: string;
    market: 'HK';
    currency: 'HKD';
  }>;
};

export class TencentProvider implements MarketProvider {
  readonly historyCapabilities = [] as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly quoteConcurrency: number;
  private readonly timeoutSignal: TimeoutSignalFactory | undefined;
  private readonly requestLimiter: RequestLimiter;

  constructor(options: TencentProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs');
    this.quoteConcurrency = boundedInteger(options.quoteConcurrency ?? TENCENT_QUOTE_CONCURRENCY, 1, TENCENT_MAX_QUOTE_SYMBOLS, 'quoteConcurrency');
    this.timeoutSignal = options.timeoutSignal;
    this.requestLimiter = options.requestLimiter ?? new SharedRequestLimiter(this.quoteConcurrency);
  }

  async quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult> {
    if (symbols.length > TENCENT_MAX_QUOTE_SYMBOLS) {
      throw new Error('Tencent supports at most 100 symbols');
    }
    const quotes = await mapWithConcurrency(symbols, this.quoteConcurrency, (symbol) => this.quote(symbol, signal));
    return { items: quotes.filter((quote): quote is CanonicalQuote => quote !== null) };
  }

  async series(request: SeriesRequest, signal: AbortSignal): Promise<SeriesResult> {
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

  async auction(symbols: string[], phase: MarketPhase, signal: AbortSignal): Promise<AuctionResult> {
    if (phase !== 'auction' && phase !== 'preopen') return { phase, items: [] };
    const market = phase === 'auction' ? 'CN' : 'HK';
    const phaseSymbols = symbols.filter((symbol) => canonicalizeSymbol(symbol).market === market);
    return { phase, items: (await this.quotes(phaseSymbols, signal)).items };
  }

  async search(query: string, signal: AbortSignal): Promise<SearchResult> {
    const url = TENCENT_SMARTBOX_URL.replace('{query}', encodeURIComponent(query));
    const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet(
      { url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes: QUOTE_MAX_BYTES },
      this.fetchImpl,
      requestSignal,
      this.timeoutSignal,
    ));
    const text = new TextDecoder('gbk').decode(bytes);
    const assignment = /^v_hint\s*=\s*("(?:\\.|[^"\\])*")\s*;?\s*$/s.exec(text.trim());
    let rows: string[];
    if (assignment) {
      try {
        const value = JSON.parse(assignment[1] as string) as unknown;
        rows = typeof value === 'string' ? value.split('^') : [];
      } catch {
        rows = [];
      }
    } else {
      rows = text.split(/\r?\n/);
    }
    const items = rows
      .map((row) => row.split('~'))
      .filter((fields) => fields[0] === 'hk' && fields[4] === 'GP')
      .map((fields) => {
        const code = fields[1];
        const name = fields[2];
        if (!/^\d{1,5}$/.test(code ?? '') || !name) return null;
        return { symbol: canonicalizeSymbol('hk' + code).symbol, name, market: 'HK' as const, currency: 'HKD' as const };
      })
      .filter((item): item is SearchResult['items'][number] => item !== null);
    return { items };
  }

  private async quote(symbol: string, signal: AbortSignal): Promise<CanonicalQuote | null> {
    const canonical = canonicalizeSymbol(symbol);
    const url = TENCENT_MINUTE_URL.replace('{code}', encodeURIComponent(canonical.symbol));
    return parseQuote(await this.getJson(url, signal), canonical.symbol, canonical.market, canonical.currency, this.now());
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet(
      { url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes: QUOTE_MAX_BYTES },
      this.fetchImpl,
      requestSignal,
      this.timeoutSignal,
    ));
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error('Invalid Tencent response');
    }
  }
}

function parseQuote(payload: unknown, symbol: string, market: 'CN' | 'HK', currency: 'CNY' | 'HKD', now: number): CanonicalQuote | null {
  const entry = quoteEntry(payload, symbol);
  const values = entry?.qt?.[symbol];
  if (!Array.isArray(values)) return null;

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

function parseMinuteBars(payload: unknown, symbol: string, market: 'CN' | 'HK'): Bar[] {
  const entry = quoteEntry(payload, symbol);
  const date = normalizedDate(entry?.data?.date);
  const lines = entry?.data?.data;
  if (!date || !Array.isArray(lines)) return [];
  return lines.flatMap((line) => {
    const parts = typeof line === 'string' ? line.trim().split(/\s+/) : [];
    const price = finiteNumber(parts[1]);
    if (!/^\d{4}$/.test(parts[0] ?? '') || price === null) return [];
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

function parseKlineBars(payload: unknown, symbol: string, market: 'CN' | 'HK', interval: 'day' | 'week' | 'month'): Bar[] {
  const data = objectValue(payload);
  const entry = objectValue(objectValue(data?.data)?.[symbol]);
  const rows = entry?.['qfq' + interval] ?? entry?.[interval];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const [date, open, close, high, low, volume, turnover] = row;
    const parsedOpen = finiteNumber(open);
    const parsedClose = finiteNumber(close);
    const parsedHigh = finiteNumber(high);
    const parsedLow = finiteNumber(low);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || parsedOpen === null || parsedClose === null || parsedHigh === null || parsedLow === null) return [];
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

function quoteEntry(payload: unknown, symbol: string): { qt?: Record<string, unknown>; data?: { date?: unknown; data?: unknown } } | null {
  const data = objectValue(objectValue(payload)?.data);
  const entry = objectValue(data?.[symbol]);
  if (!entry) return null;
  return {
    qt: objectValue(entry.qt) ?? undefined,
    data: objectValue(entry.data) ?? undefined,
  };
}

function marketTime(entry: { data?: { date?: unknown; data?: unknown } } | null, values: unknown[]): string | null {
  const date = normalizedDate(entry?.data?.date);
  const lines = entry?.data?.data;
  if (date && Array.isArray(lines) && lines.length > 0) {
    const last = lines[lines.length - 1];
    const hhmm = typeof last === 'string' ? last.trim().split(/\s+/)[0] : undefined;
    if (hhmm && /^\d{4}$/.test(hhmm)) return date + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2) + ':00+08:00';
  }
  const timestamp = stringValue(values[30]);
  return timestamp && /^\d{14}$/.test(timestamp)
    ? timestamp.slice(0, 4) + '-' + timestamp.slice(4, 6) + '-' + timestamp.slice(6, 8)
      + 'T' + timestamp.slice(8, 10) + ':' + timestamp.slice(10, 12) + ':' + timestamp.slice(12, 14) + '+08:00'
    : null;
}

function normalizedDate(value: unknown): string | null {
  const date = stringValue(value);
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return /^\d{8}$/.test(date) ? date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const output: U[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      output[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}

export const tencentParsing = { parseMinuteBars, parseKlineBars };
