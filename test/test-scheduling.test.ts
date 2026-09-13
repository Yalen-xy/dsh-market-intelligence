import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const scriptName of ['test', 'test:claude']) {
  test(`${scriptName} schedules test files without overlapping bounded integration work`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-test-scheduling-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const events = path.join(root, 'events.jsonl');
    const fixtures = ['first', 'second'].map((name) => path.join(root, `${name}.test.mjs`));
    for (const [index, fixture] of fixtures.entries()) {
      await writeFile(fixture, `
import { appendFileSync } from 'node:fs';
import test from 'node:test';
test('resource-owning fixture', async () => {
  const record = (phase) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ file: ${index}, phase }) + '\\n');
  record('start');
  await new Promise((resolve) => setTimeout(resolve, 500));
  record('end');
});
`, 'utf8');
    }
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    const [command, ...args] = manifest.scripts[scriptName].split(/\s+/);
    assert.equal(command, 'node', 'exercise the actual npm script runner options');
    assert.match(args.at(-1)!, /^test\/.*\.test\.ts$/);
    const environment = { ...process.env };
    // This is a fresh runner, not another worker of the enclosing node:test run.
    delete environment.NODE_TEST_CONTEXT;
    // Replace only test discovery, retaining the npm script's actual runner options.
    await execute(process.execPath, [...args.slice(0, -1), ...fixtures], {
      cwd: process.cwd(), env: environment, windowsHide: true, timeout: 15_000,
    });
    const records = (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 4, 'both files must run to completion');
    assert.deepEqual(records.map(({ phase }) => phase), ['start', 'end', 'start', 'end'],
      'file-level concurrency must not compete with the operation-wide smoke deadline');
    assert.equal(records[0].file, records[1].file);
    assert.equal(records[2].file, records[3].file);
    assert.notEqual(records[0].file, records[2].file);
  });
}
