import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { TENCENT_QUOTE_CONCURRENCY, TencentProvider } from '../src/providers/tencent.ts';

const fixtureFetch = (name: string): typeof fetch => async () => {
  const body = await readFile(new URL('./fixtures/' + name, import.meta.url));
  return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
};

function quoteFixture(symbol: string, price = '10.15'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    data: {
      [symbol]: {
        qt: { [symbol]: ['51', symbol, symbol, price, '10.10', '10.00', '125000', '', '10.20', '9.95'] },
        data: { date: '2026-08-27', data: ['0930 10.15 3200'] },
      },
    },
  }));
}

test('parses Tencent minute quote without coercing missing values to zero', async () => {
  const provider = new TencentProvider({
    fetch: fixtureFetch('tencent-minute.json'),
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });
  const result = await provider.quotes(['sh600000'], AbortSignal.timeout(2_000));
  assert.equal(result.items[0]?.symbol, 'sh600000');
  assert.equal(result.items[0]?.source, 'tencent');
  assert.equal(result.items[0]?.price, 10.15);
  assert.equal(result.items[0]?.amount, null);
  assert.deepEqual(result.items[0], {
    symbol: 'sh600000',
    name: '浦发银行',
    market: 'CN',
    currency: 'CNY',
    price: 10.15,
    open: 10,
    high: 10.2,
    low: 9.95,
    previousClose: 10.1,
    volume: 125000,
    amount: null,
    change: 0.05,
    changePercent: 0.4950495,
    marketTime: '2026-08-27T09:30:00+08:00',
    fetchedAt: '2026-08-27T02:00:05.000Z',
    source: 'tencent',
    isDelayed: false,
    isStale: false,
  });
});

test('parses Tencent minute and K-line rows into canonical bars', async () => {
  const provider = new TencentProvider({
    fetch: fixtureFetch('tencent-kline.json'),
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });
  const result = await provider.series({ symbol: 'sh600000', interval: 'day', count: 2 }, AbortSignal.timeout(2_000));
  assert.deepEqual(result.items, [
    { symbol: 'sh600000', market: 'CN', interval: 'day', timestamp: '2026-08-26T00:00:00+08:00', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 100000, turnover: 1010000 },
    { symbol: 'sh600000', market: 'CN', interval: 'day', timestamp: '2026-08-27T00:00:00+08:00', open: 10.1, high: 10.25, low: 10.05, close: 10.15, volume: 120000, turnover: 1218000 },
  ]);
});

test('parses the current unkeyed Tencent day rows when qfqday is absent', async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    data: { sh000001: { day: [['2026-08-28', '3950.240', '3952.180', '3970.310', '3947.800', '510581645.000']] } },
  }));
  const provider = new TencentProvider({
    fetch: async () => new Response(body, { headers: { 'content-length': String(body.byteLength) } }),
  });
  assert.deepEqual((await provider.series({ symbol: 'sh000001', interval: 'day', count: 1 }, AbortSignal.timeout(2_000))).items, [{
    symbol: 'sh000001', market: 'CN', interval: 'day', timestamp: '2026-08-28T00:00:00+08:00',
    open: 3950.24, high: 3970.31, low: 3947.8, close: 3952.18, volume: 510581645, turnover: null,
  }]);
});

test('returns only Hong Kong GP symbols from Tencent smartbox data', async () => {
  const provider = new TencentProvider({
    fetch: fixtureFetch('tencent-smartbox.txt'),
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });
  assert.deepEqual(await provider.search('腾讯', AbortSignal.timeout(2_000)), {
    items: [{ symbol: 'hk00700', name: '腾讯控股', market: 'HK', currency: 'HKD' }],
  });
});

test('parses the current Tencent smartbox assignment format', async () => {
  const body = new TextEncoder().encode('v_hint="sh~000847~Tencent Index~txja~ZS^hk~00700~Tencent~txkg~GP^hk~80700~Tencent-R~txkgr~GP";');
  const provider = new TencentProvider({
    fetch: async () => new Response(body, { headers: { 'content-length': String(body.byteLength) } }),
  });
  assert.deepEqual(await provider.search('腾讯', AbortSignal.timeout(2_000)), {
    items: [
      { symbol: 'hk00700', name: 'Tencent', market: 'HK', currency: 'HKD' },
      { symbol: 'hk80700', name: 'Tencent-R', market: 'HK', currency: 'HKD' },
    ],
  });
});

test('parses the current Tencent quote fields and compact trading date', async () => {
  const values = Array.from({ length: 38 }, () => '');
  Object.assign(values, {
    0: '1', 1: '上证指数', 2: '000001', 3: '3952.18', 4: '3956.57', 5: '3950.24', 6: '510581645',
    30: '20260828161402', 31: '-4.39', 32: '-0.11', 33: '3970.31', 34: '3947.80',
    35: '3952.18/510581645/970365152113', 36: '510581645', 37: '97036515',
  });
  const body = new TextEncoder().encode(JSON.stringify({
    data: { sh000001: { qt: { sh000001: values }, data: { date: '20260828', data: ['1500 3952.18 510581645 970365152113'] } } },
  }));
  const provider = new TencentProvider({
    fetch: async () => new Response(body, { headers: { 'content-length': String(body.byteLength) } }),
    now: () => Date.parse('2026-08-28T08:14:05Z'),
  });
  const quote = (await provider.quotes(['sh000001'], AbortSignal.timeout(2_000))).items[0];
  assert.equal(quote?.marketTime, '2026-08-28T15:00:00+08:00');
  assert.equal(quote?.high, 3970.31);
  assert.equal(quote?.low, 3947.8);
  assert.equal(quote?.volume, 510581645);
  assert.equal(quote?.amount, 970365152113);
});

test('reports a validated quote as an auction observation only for the matching phase', async () => {
  const provider = new TencentProvider({
    fetch: fixtureFetch('tencent-minute.json'),
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });
  const active = await provider.auction(['sh600000'], 'auction', AbortSignal.timeout(2_000));
  assert.deepEqual(active, { phase: 'auction', items: [active.items[0]] });
  assert.equal(active.items[0]?.price, 10.15);
  assert.deepEqual(await provider.auction(['sh600000'], 'closed', AbortSignal.timeout(2_000)), { phase: 'closed', items: [] });
});

test('bounds quote batches to 100 symbols and honors configured request concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const scriptedFetch: typeof fetch = async (input) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    const symbol = new URL(String(input)).searchParams.get('code') ?? 'sh600000';
    const body = quoteFixture(symbol);
    return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
  };
  const provider = new TencentProvider({ fetch: scriptedFetch, quoteConcurrency: 2 });
  const symbols = ['sh600000', 'sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005', 'sh600006', 'sh600007'];
  assert.equal((await provider.quotes(symbols, AbortSignal.timeout(2_000))).items.length, symbols.length);
  assert.equal(maxInFlight, 2);
  await assert.rejects(
    () => provider.quotes(Array.from({ length: 101 }, (_, index) => 'sh' + String(600000 + index)), AbortSignal.timeout(2_000)),
    /100/,
  );
});

test('applies the configured timeout to every Tencent fixed-GET capability', async () => {
  const timeoutMs: number[] = [];
  const timeoutControllers: AbortController[] = [];
  const fetchSignals: AbortSignal[] = [];
  const caller = new AbortController();
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    assert.ok(init?.signal);
    fetchSignals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const provider = new TencentProvider({
    fetch: hangingFetch,
    requestTimeoutMs: 20,
    timeoutSignal(milliseconds) {
      timeoutMs.push(milliseconds);
      const controller = new AbortController();
      timeoutControllers.push(controller);
      return controller.signal;
    },
  });
  const pending = Promise.allSettled([
    provider.quotes(['sh600000'], caller.signal),
    provider.series({ symbol: 'sh600000', interval: 'minute' }, caller.signal),
    provider.series({ symbol: 'sh600000', interval: 'day' }, caller.signal),
    provider.search('腾讯', caller.signal),
  ]);

  assert.deepEqual(timeoutMs, [20, 20, 20, 20]);
  assert.equal(fetchSignals.length, 4);
  for (let index = 0; index < fetchSignals.length; index++) {
    assert.notEqual(fetchSignals[index], caller.signal);
    assert.notEqual(fetchSignals[index], timeoutControllers[index]?.signal);
    assert.equal(fetchSignals[index]?.aborted, false);
  }
  for (const controller of timeoutControllers) controller.abort(new DOMException('configured timeout', 'TimeoutError'));

  const results = await pending;
  assert.equal(results.every(({ status }) => status === 'rejected'), true);
  assert.equal(fetchSignals.every(({ aborted }) => aborted), true);
  assert.equal(caller.signal.aborted, false);
});

test('preserves a published Tencent quote with an unavailable price as null', async () => {
  const provider = new TencentProvider({
    fetch: async () => {
      const body = quoteFixture('sh600000', '');
      return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
    },
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });
  const result = await provider.quotes(['sh600000'], AbortSignal.timeout(2_000));
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    symbol: 'sh600000',
    name: 'sh600000',
    market: 'CN',
    currency: 'CNY',
    price: null,
    open: 10,
    high: 10.2,
    low: 9.95,
    previousClose: 10.1,
    volume: 125000,
    amount: null,
    change: null,
    changePercent: null,
    marketTime: '2026-08-27T09:30:00+08:00',
    fetchedAt: '2026-08-27T02:00:05.000Z',
    source: 'tencent',
    isDelayed: false,
    isStale: false,
  });
});

test('returns only CN auction observations from mixed symbols', async () => {
  const provider = new TencentProvider({ fetch: quoteFetch });
  assert.deepEqual((await provider.auction(['sh600000', 'hk00700'], 'auction', AbortSignal.timeout(2_000))).items.map((item) => item.symbol), ['sh600000']);
});

test('returns only HK pre-open observations from mixed symbols', async () => {
  const provider = new TencentProvider({ fetch: quoteFetch });
  assert.deepEqual((await provider.auction(['sh600000', 'hk00700'], 'preopen', AbortSignal.timeout(2_000))).items.map((item) => item.symbol), ['hk00700']);
});

const quoteFetch: typeof fetch = async (input) => {
  const symbol = new URL(String(input)).searchParams.get('code') ?? 'sh600000';
  const body = quoteFixture(symbol);
  return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
};
