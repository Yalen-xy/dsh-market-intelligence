import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeSymbol, SUPPORTED_INDICES } from '../src/symbols.ts';
import { resolveRuntimePaths, validateUserState } from '../src/config.ts';
import type { CanonicalQuote } from '../src/model.ts';

test('canonicalizes A/H symbols and fixed indices', () => {
  assert.deepEqual(canonicalizeSymbol('600000'), { symbol: 'sh600000', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol('00700.HK'), { symbol: 'hk00700', market: 'HK', currency: 'HKD' });
  assert.equal(SUPPORTED_INDICES.HSTECH, 'hkHSTECH');
  assert.throws(() => canonicalizeSymbol('AAPL'), /unsupported symbol/i);
});

test('canonicalizes fixed index symbols and case-insensitive explicit prefixes', () => {
  assert.deepEqual(canonicalizeSymbol(SUPPORTED_INDICES.SSE), { symbol: 'sh000001', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol(SUPPORTED_INDICES.SZSE), { symbol: 'sz399001', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol(SUPPORTED_INDICES.CSI300), { symbol: 'sh000300', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol(SUPPORTED_INDICES.HSI), { symbol: 'hkHSI', market: 'HK', currency: 'HKD' });
  assert.deepEqual(canonicalizeSymbol(SUPPORTED_INDICES.HSTECH), { symbol: 'hkHSTECH', market: 'HK', currency: 'HKD' });
  assert.deepEqual(canonicalizeSymbol('SH000001'), { symbol: 'sh000001', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol('Sz399001'), { symbol: 'sz399001', market: 'CN', currency: 'CNY' });
  assert.deepEqual(canonicalizeSymbol('HKhsi'), { symbol: 'hkHSI', market: 'HK', currency: 'HKD' });
});

test('left-pads short Hong Kong .HK codes', () => {
  assert.deepEqual(canonicalizeSymbol('700.HK'), { symbol: 'hk00700', market: 'HK', currency: 'HKD' });
  assert.deepEqual(canonicalizeSymbol('1.hk'), { symbol: 'hk00001', market: 'HK', currency: 'HKD' });
});

test('canonical quotes round-trip as complete JSON-safe records', () => {
  const quote: CanonicalQuote = {
    symbol: 'sh600000',
    name: '浦发银行',
    market: 'CN',
    currency: 'CNY',
    price: 10.5,
    open: 10.2,
    high: 10.8,
    low: 10.1,
    previousClose: 10.3,
    volume: 123456,
    amount: 1_296_288,
    change: 0.2,
    changePercent: 1.94,
    marketTime: '2026-08-27T07:00:00.000Z',
    fetchedAt: '2026-08-27T07:00:01.000Z',
    source: 'provider-a',
    isDelayed: false,
    isStale: false,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(quote)), quote);
});

test('runtime paths stay below the configured DSH storage root', () => {
  const paths = resolveRuntimePaths('D:\\AI\\dsh');
  assert.equal(paths.root, 'D:\\AI\\dsh\\storages\\dsh-market-intelligence');
  assert.equal(paths.database, 'D:\\AI\\dsh\\storages\\dsh-market-intelligence\\market.sqlite');
});

test('an explicit storage directory is the final plugin root and is never nested twice', () => {
  const storageDir = 'D:\\AI\\dsh\\storages\\dsh-market-intelligence';
  const paths = resolveRuntimePaths('D:\\AI\\dsh', storageDir);
  assert.deepEqual(paths, {
    root: storageDir,
    database: `${storageDir}\\market.sqlite`,
    config: `${storageDir}\\config.json`,
  });
});

test('user state rejects duplicate symbols and more than 100 entries', () => {
  assert.throws(() => validateUserState({ watchlist: ['sh600000', 'sh600000'], closures: {} }), /duplicate/i);
  assert.throws(() => validateUserState({ watchlist: Array.from({ length: 101 }, (_, i) => `hk${String(i).padStart(5, '0')}`), closures: {} }), /100/);
});

test('closure configuration rejects malformed years, dates, cross-year entries, and duplicates', () => {
  const sparse: string[] = [];
  sparse[1] = '2026-10-01';
  const invalid: Array<[string, unknown]> = [
    ['non-plain closure root', new Date('2026-01-01T00:00:00.000Z')],
    ['short year', { '26': { CN: [], HK: [] } }],
    ['non-decimal year', { '20x6': { CN: [], HK: [] } }],
    ['noncanonical date', { '2026': { CN: ['2026-1-01'], HK: [] } }],
    ['nondate string', { '2026': { CN: ['not-a-date'], HK: [] } }],
    ['non-leap February', { '2026': { CN: ['2026-02-29'], HK: [] } }],
    ['impossible month day', { '2026': { CN: [], HK: ['2026-04-31'] } }],
    ['cross-year date', { '2026': { CN: ['2027-01-01'], HK: [] } }],
    ['duplicate CN date', { '2026': { CN: ['2026-10-01', '2026-10-01'], HK: [] } }],
    ['duplicate HK date', { '2026': { CN: [], HK: ['2026-10-01', '2026-10-01'] } }],
    ['sparse dates', { '2026': { CN: sparse, HK: [] } }],
    ['extra market', { '2026': { CN: [], HK: [], US: [] } }],
    ['non-plain year entry', { '2026': new Date('2026-01-01T00:00:00.000Z') }],
  ];

  for (const [label, closures] of invalid) {
    assert.throws(() => validateUserState({ watchlist: [], closures }), undefined, label);
  }
});

test('closure configuration accepts empty explicit years and the same closure in both markets', () => {
  const state = {
    watchlist: [],
    closures: {
      '2026': { CN: ['2026-10-01'], HK: ['2026-10-01'] },
      '2027': { CN: [], HK: [] },
    },
  };

  assert.deepEqual(validateUserState(state), state);
});
