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
