import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMarketToolContracts, type MarketToolsService } from '../src/tool-contracts.js';

const service = {
  status() { throw new Error('not called'); },
  async quotes() { throw new Error('not called'); },
  async series() { throw new Error('not called'); },
  async sectors() { throw new Error('not called'); },
  async auction() { throw new Error('not called'); },
  async watchlist() { throw new Error('not called'); },
  health() { throw new Error('not called'); },
} satisfies MarketToolsService;

test('canonical contracts expose exactly the seven DSH market tools', () => {
  const contracts = createMarketToolContracts(service, { config: 'D:\\fixture\\config.json' });
  assert.deepEqual(contracts.map(({ name }) => name).sort(), [
    'market_auction',
    'market_data_health',
    'market_quotes',
    'market_sectors',
    'market_series',
    'market_status',
    'market_watchlist',
  ]);
  for (const contract of contracts) {
    assert.equal(contract.inputSchema.type, 'object');
    assert.equal(contract.inputSchema.additionalProperties, false);
    assert.equal(contract.outputSchema.type, 'object');
    assert.equal(contract.outputSchema.additionalProperties, false);
  }
});

test('canonical auction contract exposes a separate final settlement', async () => {
  const settlement = {
    symbol: 'sh600000', tradingDate: '2026-11-13', price: 10.5, volume: 12000,
    amount: 126000, previousClose: 10, turnoverRate: 0.2, volumeRatio: 1.4,
    fetchedAt: '2026-11-13T01:27:00.000Z', source: 'tushare' as const,
  };
  const candidate = {
    ...service,
    async auction() {
      return { availability: 'unavailable' as const, phase: 'continuous' as const,
        reason: 'CN auction is inactive', items: [],
        settlement: { availability: 'cached' as const, reason: null, items: [settlement] } };
    },
  };
  const contract = createMarketToolContracts(candidate, { config: 'D:\\fixture\\config.json' })
    .find(({ name }) => name === 'market_auction')!;
  const value = await contract.execute({ market: 'CN', symbols: ['sh600000'] }, { signal: new AbortController().signal });
  assert.deepEqual((value as { settlement?: unknown }).settlement, { availability: 'cached', reason: null, items: [settlement] });
});
