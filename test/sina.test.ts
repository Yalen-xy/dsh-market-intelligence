import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSinaQuotes, parseSinaSectors, SinaProvider } from '../src/providers/sina.ts';

const fetchedAt = '2026-08-27T10:00:05+08:00';

test('parses a Sina A-share assignment as a sourced quote', () => {
  const result = parseSinaQuotes(
    'var hq_str_sh600000="浦发银行,10.00,9.90,10.15,10.20,9.80,10.14,10.15,1000,1015000,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-08-27,10:00:00,00";',
    fetchedAt,
  );
  assert.equal(result[0]?.price, 10.15);
  assert.equal(result[0]?.source, 'sina');
  assert.equal(result[0]?.marketTime, '2026-08-27T10:00:00+08:00');
  assert.deepEqual(result[0], {
    symbol: 'sh600000', name: '浦发银行', market: 'CN', currency: 'CNY', price: 10.15,
    open: 10, high: 10.2, low: 9.8, previousClose: 9.9, volume: 1000, amount: 1015000,
    change: 0.25, changePercent: 2.52525253, marketTime: '2026-08-27T10:00:00+08:00',
    fetchedAt, source: 'sina', isDelayed: false, isStale: false,
  });
});

test('rejects Sina quote assignments with executable or non-finite mandatory prices', () => {
  const payload = [
    'var hq_str_sh600001=(globalThis.compromised = true);',
    'var hq_str_sh600002="无效,10,9.9,NaN,10.2,9.8,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-08-27,10:00:00,00";',
  ].join('\n');
  assert.deepEqual(parseSinaQuotes(payload, fetchedAt), []);
  assert.equal((globalThis as Record<string, unknown>).compromised, undefined);
});

test('parses sector assignments and preserves unpublished values as null', () => {
  const rows = parseSinaSectors(
    'var S_Finance_bankuai_sinaindustry={"new_jrhy":"金融行业,2.10,100,200000000,sh600000,浦发银行,3.20"};',
    'industry',
    fetchedAt,
  );
  assert.deepEqual(rows[0], {
    id: 'new_jrhy', name: '金融行业', category: 'industry', changePercent: 2.1, turnover: 200000000,
    netFlow: null, leaderSymbol: 'sh600000', leaderName: '浦发银行', leaderChangePercent: 3.2,
    marketTime: null, fetchedAt, source: 'sina', isDelayed: false, isStale: false,
  });
});

test('parses the current Sina sector row layout with its repeated identifier', () => {
  const rows = parseSinaSectors(
    'var S_Finance_bankuai_sinaindustry={"new_blhy":"new_blhy,玻璃行业,19,16.927894,-0.0042105,-0.0248671,601963577,15531570330,sh600293,4.138,3.020,0.120,三峡新材"};',
    'industry',
    fetchedAt,
  );
  assert.deepEqual(rows[0], {
    id: 'new_blhy', name: '玻璃行业', category: 'industry', changePercent: -0.0248671, turnover: 15531570330,
    netFlow: null, leaderSymbol: 'sh600293', leaderName: '三峡新材', leaderChangePercent: 4.138,
    marketTime: null, fetchedAt, source: 'sina', isDelayed: false, isStale: false,
  });
});

test('does not publish sector rows with missing identifiers', () => {
  const rows = parseSinaSectors(
    'var S_Finance_bankuai_sinaindustry={"":"行业,1,0,1,sh600000,浦发银行,1","valid":" ,1,0,1,sh600000,浦发银行,1"};',
    'industry',
    fetchedAt,
  );
  assert.deepEqual(rows, []);
});

test('uses the fixed Sina hosts and routes, decodes actual GBK bytes, and sets the fixed Referer', async () => {
  const bodies = new Map<string, Uint8Array>([
    ['https://hq.sinajs.cn/list=sh600000', await fixture('sina-quote.txt')],
    ['https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php', await fixture('sina-industry.txt')],
    ['https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class', await fixture('sina-concept.txt')],
  ]);
  const calls: Array<{ url: string; referer: string | null }> = [];
  const provider = new SinaProvider({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), referer: new Headers(init?.headers).get('referer') });
      const body = bodies.get(url.toString()) ?? new Uint8Array();
      return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
    },
    now: () => Date.parse('2026-08-27T02:00:05Z'),
  });

  assert.deepEqual(await provider.quotes(['sh600000'], AbortSignal.timeout(2_000)), {
    items: [{
      symbol: 'sh600000', name: '浦发银行', market: 'CN', currency: 'CNY', price: 10.15,
      open: 10, high: 10.2, low: 9.8, previousClose: 9.9, volume: 1000, amount: 1015000,
      change: 0.25, changePercent: 2.52525253, marketTime: '2026-08-27T10:00:00+08:00',
      fetchedAt: '2026-08-27T02:00:05.000Z', source: 'sina', isDelayed: false, isStale: false,
    }],
  });
  assert.deepEqual(await provider.sectors!(AbortSignal.timeout(2_000)), {
    items: [
      { id: 'new_jrhy', name: '金融行业', category: 'industry', changePercent: 2.1, turnover: 200000000, netFlow: null, leaderSymbol: 'sh600000', leaderName: '浦发银行', leaderChangePercent: 3.2, marketTime: null, fetchedAt: '2026-08-27T02:00:05.000Z', source: 'sina', isDelayed: false, isStale: false },
      { id: 'gn_ai', name: '人工智能', category: 'concept', changePercent: 1.25, turnover: 123456789, netFlow: null, leaderSymbol: 'sz000001', leaderName: '平安银行', leaderChangePercent: -0.5, marketTime: null, fetchedAt: '2026-08-27T02:00:05.000Z', source: 'sina', isDelayed: false, isStale: false },
    ],
  });
  assert.deepEqual(calls, [
    { url: 'https://hq.sinajs.cn/list=sh600000', referer: 'https://finance.sina.com.cn/' },
    { url: 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php', referer: 'https://finance.sina.com.cn/' },
    { url: 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class', referer: 'https://finance.sina.com.cn/' },
  ]);
});

test('bounds a Sina quote request to 100 A-share symbols', async () => {
  const provider = new SinaProvider();
  await assert.rejects(
    () => provider.quotes(Array.from({ length: 101 }, (_, index) => 'sh' + String(600000 + index)), AbortSignal.timeout(2_000)),
    /100/,
  );
});

test('applies the configured timeout to Sina quote and sector fixed GETs', async () => {
  const timeoutMs: number[] = [];
  const timeoutControllers: AbortController[] = [];
  const fetchSignals: AbortSignal[] = [];
  const caller = new AbortController();
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    assert.ok(init?.signal);
    fetchSignals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const provider = new SinaProvider({
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
    provider.sectors(caller.signal),
  ]);

  assert.deepEqual(timeoutMs, [20, 20, 20]);
  assert.equal(fetchSignals.length, 3);
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

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL('./fixtures/' + name, import.meta.url));
}
