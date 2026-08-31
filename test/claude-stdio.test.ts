import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const expectedSevenNames = [
  'market_auction',
  'market_data_health',
  'market_quotes',
  'market_sectors',
  'market_series',
  'market_status',
  'market_watchlist',
];

const stagedBundle = path.resolve('.artifacts/claude-market-intelligence-latest.mcpb');

test('staged MCPB serves seven tools over a real stdio child process and shuts down cleanly', { timeout: 45_000 }, async (t) => {
  await access(stagedBundle);
  const result = await runClaudeSmoke(t, stagedBundle);

  assert.deepEqual(result.toolNames.sort(), expectedSevenNames);
  assert.equal(result.calls, 7);
  assert.equal(result.structuredTextCalls, 7);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.protocolNoise, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.pendingChildren, 0);
  assert.equal(result.shutdown.graceful, 0);
  assert.equal(result.shutdown.signal, 'SIGTERM');
  assert.equal(result.shutdown.eof, 0);
  assert.equal(result.outsideFiles, 0);
  assert.equal(result.storageReleased, true);
  assert.equal(result.temporaryRootRemoved, true);
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 4_096);
  assert.doesNotMatch(result.stderr, /[A-Z]:\\|\\Users\\|\/Users\//i);
});

type ClaudeSmokeResult = {
  toolNames: string[];
  calls: number;
  structuredTextCalls: number;
  networkRequests: number;
  protocolNoise: string;
  exitCode: number;
  pendingChildren: number;
  shutdown: { graceful: number; signal: 'SIGTERM'; eof: number };
  outsideFiles: number;
  storageReleased: boolean;
  temporaryRootRemoved: boolean;
  stderr: string;
};

async function runClaudeSmoke(t: Parameters<typeof test>[2], bundle: string): Promise<ClaudeSmokeResult> {
  const child = spawn(process.execPath, ['scripts/claude-smoke.mjs', '--bundle', bundle], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null, stderr);
  assert.equal(stderr, '');
  return JSON.parse(stdout) as ClaudeSmokeResult;
}
