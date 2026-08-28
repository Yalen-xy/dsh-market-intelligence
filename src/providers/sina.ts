import { fixedGet, SharedRequestLimiter, type RequestLimiter, type TimeoutSignalFactory } from '../http.js';
import type { CanonicalQuote, SectorObservation } from '../model.js';
import { canonicalizeSymbol } from '../symbols.js';
import type { MarketProvider, QuoteResult, SectorResult } from './provider.js';

export const SINA_QUOTE_URL = 'https://hq.sinajs.cn/list={symbols}';
export const SINA_INDUSTRY_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
export const SINA_CONCEPT_URL = 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class';
export const SINA_MAX_QUOTE_SYMBOLS = 100;

const QUOTE_MAX_BYTES = 2 * 1024 * 1024;
const SECTOR_MAX_BYTES = 8 * 1024 * 1024;
const SINA_REFERER = 'https://finance.sina.com.cn/' as const;

export type SinaProviderOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  requestLimiter?: RequestLimiter;
  timeoutSignal?: TimeoutSignalFactory;
};

export class SinaProvider implements Pick<MarketProvider, 'quotes' | 'sectors'> {
  readonly historyCapabilities = [] as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly timeoutSignal: TimeoutSignalFactory | undefined;
  private readonly requestLimiter: RequestLimiter;

  constructor(options: SinaProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs');
    this.timeoutSignal = options.timeoutSignal;
    this.requestLimiter = options.requestLimiter ?? new SharedRequestLimiter(3);
  }

  async quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult> {
    if (symbols.length > SINA_MAX_QUOTE_SYMBOLS) {
      throw new Error('Sina supports at most 100 symbols');
    }
    const aShares = symbols
      .map(canonicalizeSymbol)
      .filter((symbol) => symbol.market === 'CN')
      .map((symbol) => symbol.symbol);
    if (aShares.length === 0) return { items: [] };

    const url = SINA_QUOTE_URL.replace('{symbols}', aShares.join(','));
    return { items: parseSinaQuotes(await this.getText(url, QUOTE_MAX_BYTES, signal), this.fetchedAt()) };
  }

  async sectors(signal: AbortSignal): Promise<SectorResult> {
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

  private async getText(url: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    const bytes = await this.requestLimiter.run(signal, (requestSignal) => fixedGet(
      { url: new URL(url), timeoutMs: this.requestTimeoutMs, maxBytes, referer: SINA_REFERER },
      this.fetchImpl,
      requestSignal,
      this.timeoutSignal,
    ));
    return new TextDecoder('gbk').decode(bytes);
  }

  private fetchedAt(): string {
    return new Date(this.now()).toISOString();
  }
}

export function parseSinaQuotes(payload: string, fetchedAt: string): CanonicalQuote[] {
  return assignments(payload).flatMap(({ identifier, value }) => {
    if (!/^hq_str_(?:sh|sz)\d{6}$/.test(identifier) || typeof value !== 'string') return [];
    const fields = value.split(',');
    const price = finiteNumber(fields[3]);
    if (price === null) return [];
    const symbol = identifier.slice('hq_str_'.length);
    const previousClose = finiteNumber(fields[2]);
    const change = previousClose === null ? null : rounded(price - previousClose);
    return [{
      symbol,
      name: nonEmpty(fields[0]),
      market: 'CN' as const,
      currency: 'CNY' as const,
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

export function parseSinaSectors(payload: string, category: string, fetchedAt: string): SectorObservation[] {
  return assignments(payload).flatMap(({ value }) => {
    if (!isRecord(value)) return [];
    return Object.entries(value).flatMap(([id, row]) => {
      if (!nonEmpty(id) || typeof row !== 'string') return [];
      const fields = row.split(',');
      const currentLayout = fields[0] === id;
      const name = nonEmpty(fields[currentLayout ? 1 : 0]);
      if (name === null) return [];
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

function assignments(payload: string): Array<{ identifier: string; value: unknown }> {
  return payload.split(/\r?\n/).flatMap((line) => {
    const match = /^(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.*?)\s*;?\s*$/.exec(line.trim());
    if (!match) return [];
    const value = jsonValue(match[2] ?? '');
    return value === undefined ? [] : [{ identifier: match[1] as string, value }];
  });
}

function jsonValue(value: string): unknown | undefined {
  if (!(value.startsWith('"') || value.startsWith('{'))) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' || isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketTime(date: unknown, time: unknown): string | null {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && typeof time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(time)
    ? date + 'T' + time + '+08:00'
    : null;
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
