import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

test('installer test launcher selects the shell through child environment without a command shell', async () => {
  const { runInstallerTests } = await import('../scripts/run-installer-tests.mjs');
  const calls: Array<{ args: string[]; file: string; options: Record<string, unknown> }> = [];
  const spawnImpl = (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args, file, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };

  const exitCode = await runInstallerTests('pwsh', { spawnImpl: spawnImpl as never });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, ['--import', 'tsx', '--test', 'test/installer-*.test.ts']);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal('shell' in calls[0].options, false);
  assert.equal((calls[0].options.env as NodeJS.ProcessEnv).DSH_INSTALLER_TEST_SHELL, 'pwsh');
});
