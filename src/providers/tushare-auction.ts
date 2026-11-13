import type { RequestLimiter } from '../http.js';
import type { AuctionSettlement } from '../model.js';

const ENDPOINT = 'https://api.tushare.pro/';
const FIELDS = ['ts_code', 'trade_date', 'vol', 'price', 'amount', 'pre_close', 'turnover_rate', 'volume_ratio'] as const;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type TushareAuctionOptions = {
  token: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  requestLimiter?: RequestLimiter;
};

export class TushareAuctionProvider {
  private readonly token: string;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestLimiter?: RequestLimiter;

  constructor(options: TushareAuctionOptions) {
    if (!options.token || typeof options.token !== 'string') throw new Error('Tushare token is required');
    this.token = options.token;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.requestLimiter = options.requestLimiter;
  }

  async fetch(symbols: string[], tradingDate: string, signal: AbortSignal): Promise<AuctionSettlement[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) throw new Error('Invalid auction trading date');
    if (!Array.isArray(symbols) || symbols.length > 100 || symbols.some((item) => !/^(sh|sz)\d{6}$/.test(item))) {
      throw new Error('Invalid auction symbols');
    }
    if (symbols.length === 0) return [];
    const run = async (operationSignal: AbortSignal) => {
      const requestSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(this.timeoutMs)]);
      let response: Response;
      try {
        response = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          redirect: 'manual',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_name: 'stk_auction', token: this.token, params: { trade_date: tradingDate.replaceAll('-', '') }, fields: FIELDS.join(',') }),
          signal: requestSignal,
        });
      } catch {
        throw new Error('Tushare auction request failed');
      }
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new Error('Tushare auction response unavailable');
      }
      const body = await readBounded(response, requestSignal);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new Error('Tushare auction response invalid');
      }
      return parseAuctionPayload(payload, new Set(symbols), tradingDate, this.now().toISOString());
    };
    return this.requestLimiter ? this.requestLimiter.run(signal, run) : run(signal);
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error('Tushare auction response too large');
  }
  if (!response.body) throw new Error('Tushare auction response empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Tushare auction request failed');
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Tushare auction response too large');
      chunks.push(next.value);
    }
  } catch {
    throw new Error('Tushare auction response unavailable');
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function parseAuctionPayload(payload: unknown, requested: Set<string>, tradingDate: string, fetchedAt: string): AuctionSettlement[] {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data) || !Array.isArray(payload.data.fields) || !Array.isArray(payload.data.items)) {
    throw new Error('Tushare auction response invalid');
  }
  const fields = payload.data.fields;
  const indices = FIELDS.map((field) => fields.indexOf(field));
  if (indices.some((index) => index < 0) || payload.data.items.length > 8_000) throw new Error('Tushare auction response invalid');
  const found = new Set<string>();
  const results: AuctionSettlement[] = [];
  for (const row of payload.data.items) {
    if (!Array.isArray(row) || row.length !== fields.length) throw new Error('Tushare auction row invalid');
    const values = indices.map((index) => row[index]);
    const code = values[0];
    if (typeof code !== 'string') throw new Error('Tushare auction row invalid');
    const match = /^(\d{6})\.(SH|SZ)$/.exec(code);
    if (!match) continue;
    const symbol = `${match[2].toLowerCase()}${match[1]}`;
    if (!requested.has(symbol)) continue;
    if (found.has(symbol) || values[1] !== tradingDate.replaceAll('-', '')) throw new Error('Tushare auction row invalid');
    found.add(symbol);
    const volume = finiteNonnegative(values[2]);
    const price = finiteNonnegative(values[3], true);
    const amount = finiteNonnegative(values[4]);
    const previousClose = finiteNonnegative(values[5], true);
    const turnoverRate = finiteNonnegative(values[6], true);
    const volumeRatio = finiteNonnegative(values[7], true);
    results.push({ symbol, tradingDate, volume, price, amount, previousClose, turnoverRate, volumeRatio, fetchedAt, source: 'tushare' });
  }
  return results;
}

function finiteNonnegative(value: unknown): number;
function finiteNonnegative(value: unknown, nullable: true): number | null;
function finiteNonnegative(value: unknown, nullable = false): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Tushare auction row invalid');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
