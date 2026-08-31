import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClaudeConfig, resolveClaudeBaseDirectory } from '../claude/config.ts';
import { resolveDshBaseDirectory } from '../src/index.ts';

const LOCAL_APP_DATA = 'C:\\Users\\fixture\\AppData\\Local';

test('Claude defaults to an isolated LocalAppData root', () => {
  assert.equal(
    resolveClaudeBaseDirectory({ LOCALAPPDATA: LOCAL_APP_DATA }),
    'C:\\Users\\fixture\\AppData\\Local\\dsh-market-intelligence\\claude',
  );
});

test('Claude defaults configuration without reading DSH_HOME or unknown environment values', () => {
  assert.deepEqual(readClaudeConfig({
    LOCALAPPDATA: LOCAL_APP_DATA,
    DSH_HOME: 'D:\\AI\\dsh',
    UNRELATED_SETTING: 'must-not-affect-Claude',
  }), {
    requestTimeoutMs: 10_000,
    quoteIntervalMs: 10_000,
    sectorIntervalMs: 60_000,
  });
});

test('Claude accepts an explicit D-drive storage directory', () => {
  assert.equal(readClaudeConfig({
    LOCALAPPDATA: LOCAL_APP_DATA,
    CLAUDE_MARKET_STORAGE_DIR: 'D:\\AI\\claude-market-intelligence',
  }).storageDir, 'D:\\AI\\claude-market-intelligence');
});

test('Claude treats omitted and blank custom storage directories as absent', () => {
  for (const storageDir of [undefined, '', '  \t']) {
    assert.equal(readClaudeConfig({
      LOCALAPPDATA: LOCAL_APP_DATA,
      ...(storageDir === undefined ? {} : { CLAUDE_MARKET_STORAGE_DIR: storageDir }),
    }).storageDir, undefined);
  }
});

test('Claude accepts exact interval bounds from canonical decimal environment values', () => {
  assert.deepEqual(readClaudeConfig({
    LOCALAPPDATA: LOCAL_APP_DATA,
    CLAUDE_MARKET_REQUEST_TIMEOUT_MS: '100',
    CLAUDE_MARKET_QUOTE_INTERVAL_MS: '300000',
    CLAUDE_MARKET_SECTOR_INTERVAL_MS: '10000',
  }), {
    requestTimeoutMs: 100,
    quoteIntervalMs: 300_000,
    sectorIntervalMs: 10_000,
  });
  assert.deepEqual(readClaudeConfig({
    LOCALAPPDATA: LOCAL_APP_DATA,
    CLAUDE_MARKET_REQUEST_TIMEOUT_MS: '120000',
    CLAUDE_MARKET_QUOTE_INTERVAL_MS: '1000',
    CLAUDE_MARKET_SECTOR_INTERVAL_MS: '900000',
  }), {
    requestTimeoutMs: 120_000,
    quoteIntervalMs: 1_000,
    sectorIntervalMs: 900_000,
  });
});

test('Claude rejects malformed and out-of-range numeric environment values', () => {
  for (const [name, value] of [
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '99'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '120001'],
    ['CLAUDE_MARKET_QUOTE_INTERVAL_MS', '999'],
    ['CLAUDE_MARKET_QUOTE_INTERVAL_MS', '300001'],
    ['CLAUDE_MARKET_SECTOR_INTERVAL_MS', '9999'],
    ['CLAUDE_MARKET_SECTOR_INTERVAL_MS', '900001'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '0100'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '100.0'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '1e3'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', '+100'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', ' 100'],
    ['CLAUDE_MARKET_REQUEST_TIMEOUT_MS', ''],
  ] as const) {
    assert.throws(() => readClaudeConfig({ LOCALAPPDATA: LOCAL_APP_DATA, [name]: value }), /integer/i, `${name}=${value}`);
  }
});

test('Claude rejects missing, blank, and unsafe LocalAppData or custom storage paths without a fallback', () => {
  for (const [label, environment] of [
    ['missing LocalAppData', {}],
    ['blank LocalAppData', { LOCALAPPDATA: '  ' }],
    ['relative LocalAppData', { LOCALAPPDATA: '.\\local' }],
    ['UNC LocalAppData', { LOCALAPPDATA: '\\\\server\\share\\local' }],
    ['device LocalAppData', { LOCALAPPDATA: '\\\\?\\C:\\local' }],
    ['traversing LocalAppData', { LOCALAPPDATA: 'C:\\safe\\..\\local' }],
    ['trailing LocalAppData component', { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData.\\Local' }],
    ['reserved LocalAppData component', { LOCALAPPDATA: 'C:\\Users\\fixture\\NUL.txt' }],
  ] as const) {
    assert.throws(() => resolveClaudeBaseDirectory(environment), /local Windows path/i, label);
    assert.throws(() => readClaudeConfig(environment), /local Windows path/i, label);
  }
  for (const [label, environment] of [
    ['relative storage', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: '.\\claude' }],
    ['UNC storage', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: '\\\\server\\share\\claude' }],
    ['device storage', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: '\\\\?\\C:\\claude' }],
    ['traversing storage', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: 'C:\\safe\\..\\claude' }],
    ['ADS storage', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: 'C:\\safe\\claude:stream' }],
    ['trailing storage component', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: 'D:\\AI\\claude. ' }],
    ['reserved storage component', { LOCALAPPDATA: LOCAL_APP_DATA, CLAUDE_MARKET_STORAGE_DIR: 'D:\\AI\\COM1.log' }],
  ] as const) {
    assert.throws(() => readClaudeConfig(environment), /local Windows path/i, label);
  }
});

test('production DSH and Claude environment resolvers ignore hostile adapter-specific values', () => {
  assert.equal(resolveDshBaseDirectory({
    DSH_HOME: 'D:\\AI\\dsh',
    CLAUDE_MARKET_STORAGE_DIR: '.\\unsafe-claude-storage',
    CLAUDE_MARKET_REQUEST_TIMEOUT_MS: 'not-an-integer',
    CLAUDE_MARKET_QUOTE_INTERVAL_MS: '999',
    CLAUDE_MARKET_SECTOR_INTERVAL_MS: '900001',
  }), 'D:\\AI\\dsh');
  const claudeEnvironment = {
    LOCALAPPDATA: LOCAL_APP_DATA,
    DSH_HOME: '\\\\?\\C:\\unsafe-dsh-home',
  };
  assert.equal(resolveClaudeBaseDirectory(claudeEnvironment),
    'C:\\Users\\fixture\\AppData\\Local\\dsh-market-intelligence\\claude');
  assert.deepEqual(readClaudeConfig(claudeEnvironment), {
    requestTimeoutMs: 10_000,
    quoteIntervalMs: 10_000,
    sectorIntervalMs: 60_000,
  });
});
