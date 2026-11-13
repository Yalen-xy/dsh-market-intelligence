import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TushareAuctionProvider } from '../src/providers/tushare-auction.ts';

test('reads the final auction trade for requested A shares without exposing the token', async () => {
  let request: RequestInit | undefined;
  const provider = new TushareAuctionProvider({
    token: 'private-token',
    now: () => new Date('2026-11-13T01:27:00.000Z'),
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ code: 0, msg: null, data: {
        fields: ['ts_code', 'trade_date', 'vol', 'price', 'amount', 'pre_close', 'turnover_rate', 'volume_ratio'],
        items: [
          ['600000.SH', '20261113', 12000, 10.5, 126000, 10, 0.2, 1.4],
          ['000001.SZ', '20261113', 5000, 8.3, 41500, 8.2, 0.1, 0.8],
        ],
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const items = await provider.fetch(['sh600000'], '2026-11-13', new AbortController().signal);
  assert.equal(request?.method, 'POST');
  assert.equal(JSON.parse(String(request?.body)).api_name, 'stk_auction');
  assert.deepEqual(items, [{
    symbol: 'sh600000', tradingDate: '2026-11-13', price: 10.5, volume: 12000,
    amount: 126000, previousClose: 10, turnoverRate: 0.2, volumeRatio: 1.4,
    fetchedAt: '2026-11-13T01:27:00.000Z', source: 'tushare',
  }]);
  assert.equal(JSON.stringify(items).includes('private-token'), false);
});

test('rejects malformed auction rows and provider errors', async () => {
  for (const payload of [
    { code: -2001, msg: 'private-token invalid', data: null },
    { code: 0, data: { fields: ['ts_code', 'trade_date', 'vol', 'price', 'amount', 'pre_close', 'turnover_rate', 'volume_ratio'], items: [['600000.SH', '20261113', -1, 10, 10, 9, 0, 0]] } },
  ]) {
    const provider = new TushareAuctionProvider({
      token: 'private-token',
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(provider.fetch(['sh600000'], '2026-11-13', new AbortController().signal), (error: Error) => !error.message.includes('private-token'));
  }
});
