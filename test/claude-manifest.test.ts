import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeManifest } from '../claude/manifest.ts';

const expectedToolNames = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
];

test('Claude MCPB manifest declares the fixed Windows market extension', () => {
  const manifest = createClaudeManifest('0.2.0');

  assert.equal(manifest.manifest_version, '0.4');
  assert.equal(manifest.name, 'dsh-market-intelligence');
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.documentation, 'https://github.com/Yalen-xy/dsh-market-intelligence/blob/main/docs/CLAUDE.md');
  assert.deepEqual(manifest.compatibility?.platforms, ['win32']);
  assert.equal(manifest.compatibility?.runtimes?.node, '^22.19.0 || >=24.0.0');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server/index.js');
  assert.deepEqual(manifest.privacy_policies, [
    'https://www.tencent.com/privacy-policy/',
    'https://corp.sina.com.cn/eng/sina_priv_eng.htm',
  ]);
  assert.deepEqual(manifest.tools?.map(({ name }) => name).sort(), expectedToolNames);
  assert.equal(manifest.tools_generated, false);
});

test('Claude MCPB manifest maps only its four safe configuration fields to runtime environment variables', () => {
  const manifest = createClaudeManifest('0.2.0');
  const configuration = manifest.user_config;

  assert.deepEqual(Object.keys(configuration ?? {}).sort(), [
    'quoteIntervalMs',
    'requestTimeoutMs',
    'sectorIntervalMs',
    'storageDir',
  ]);
  assert.deepEqual(manifest.server.mcp_config.env, {
    CLAUDE_MARKET_STORAGE_DIR: '${user_config.storageDir}',
    CLAUDE_MARKET_REQUEST_TIMEOUT_MS: '${user_config.requestTimeoutMs}',
    CLAUDE_MARKET_QUOTE_INTERVAL_MS: '${user_config.quoteIntervalMs}',
    CLAUDE_MARKET_SECTOR_INTERVAL_MS: '${user_config.sectorIntervalMs}',
  });
  assert.deepEqual(configuration?.storageDir, {
    type: 'directory',
    title: 'Storage directory',
    description: 'Optional local Windows directory for this extension’s private market-data state.',
    default: '',
    required: false,
    sensitive: false,
  });
  assert.deepEqual(configuration?.requestTimeoutMs, {
    type: 'number',
    title: 'Request timeout (ms)',
    description: 'Provider request timeout in milliseconds.',
    default: 10_000,
    min: 100,
    max: 120_000,
    sensitive: false,
  });
  assert.deepEqual(configuration?.quoteIntervalMs, {
    type: 'number',
    title: 'Quote polling interval (ms)',
    description: 'Watchlist quote polling interval in milliseconds.',
    default: 10_000,
    min: 1_000,
    max: 300_000,
    sensitive: false,
  });
  assert.deepEqual(configuration?.sectorIntervalMs, {
    type: 'number',
    title: 'Sector polling interval (ms)',
    description: 'Sector polling interval in milliseconds.',
    default: 60_000,
    min: 10_000,
    max: 900_000,
    sensitive: false,
  });
});

test('Claude MCPB manifest keeps the limited-use and provider-authority disclaimer', () => {
  const manifest = createClaudeManifest('0.2.0');
  const description = `${manifest.description}\n${manifest.long_description ?? ''}`;

  assert.match(description, /personal, non-commercial, read-only research/i);
  assert.match(description, /Tencent and Sina are not partners of, and have not authorized, this project/i);
  assert.doesNotMatch(description, /(?:Tencent|Sina)[^\n]*(?:officially authorized|合法授权|已授权)/i);
});
