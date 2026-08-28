import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('public repository dependency type remains compatible without the recovery extension', () => {
  const directory = mkdtempSync(path.join(process.cwd(), '.tmp-types-'));
  try {
    writeFileSync(path.join(directory, 'fixture.ts'), `
import type { PluginDependencies } from '../src/index.js';

const repository = {
  writeBatch() {},
  latestQuotes() { return []; },
  writeBars() {},
  querySeries() { return []; },
  writeSectors() {},
  readSectors() { return []; },
  updateProviderHealth() {},
  health() { throw new Error('not used'); },
  close() {},
} satisfies ReturnType<PluginDependencies['openRepository']>;

void repository;
`, 'utf8');

    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/typescript/lib/tsc.js'),
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--types', 'node',
      '--target', 'ES2023',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      path.join(directory, 'fixture.ts'),
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
