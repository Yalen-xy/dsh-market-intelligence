import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { validateManifest } from '@anthropic-ai/mcpb/node';
import { buildClaudeMcpb } from '../scripts/build-claude-mcpb.ts';

const expectedFiles = ['LICENSE', 'manifest.json', 'server/index.js'];

test('Claude MCPB builder produces an officially valid self-contained Windows package', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const output = path.join(temporaryDirectory, 'claude-market-intelligence-latest.mcpb');

  const result = await buildClaudeMcpb(output);
  const archive = unzipSync(await readFile(output));
  const names = Object.keys(archive).sort();
  const manifestDirectory = path.join(temporaryDirectory, 'manifest-validation');
  await mkdir(manifestDirectory);
  await writeFile(path.join(manifestDirectory, 'manifest.json'), archive['manifest.json']!);
  const server = Buffer.from(archive['server/index.js']!).toString('utf8');

  assert.equal(result.output, output);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(names, expectedFiles);
  assert.equal(validateManifest(manifestDirectory), true);
  assert.doesNotMatch(server, /sourceMappingURL|\.ts(?:["'`]|$)|test\/fixtures|\.log(?:["'`]|$)/i);
  assert.doesNotMatch(server, /@deepseek-ai|cordis|schemastery|cordis\.patch|dsh\.patch/i);
  assert.doesNotMatch(server, /D:\\AI|[A-Z]:\\Users\\|dsh-market-intelligence\\.worktrees/i);
  assert.doesNotMatch(server, /(?:ghp_|github_pat_)[A-Za-z0-9_]+|Authorization:\s*Bearer/i);
});

test('Claude MCPB builder fails closed for unsafe output targets', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-output-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const existingFile = path.join(temporaryDirectory, 'existing.mcpb');
  await writeFile(existingFile, 'corrupt output must remain untouched');
  await assert.rejects(buildClaudeMcpb(existingFile), /must not already exist/i);
  assert.equal(await readFile(existingFile, 'utf8'), 'corrupt output must remain untouched');

  const directoryTarget = path.join(temporaryDirectory, 'directory.mcpb');
  await mkdir(directoryTarget);
  await assert.rejects(buildClaudeMcpb(directoryTarget), /must not already exist/i);

  const overlappingTarget = path.join(temporaryDirectory, 'overlap.mcpb');
  await assert.rejects(
    buildClaudeMcpb(overlappingTarget, { temporaryDirectory }),
    /must not overlap its temporary staging directory/i,
  );
});

test('Claude MCPB builder fails closed for a symlink output target', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-symlink-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const symlinkTarget = path.join(temporaryDirectory, 'symlink-target.mcpb');
  const symlinkOutput = path.join(temporaryDirectory, 'symlink-output.mcpb');
  await writeFile(symlinkTarget, 'target');
  try {
    await symlink(symlinkTarget, symlinkOutput, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') t.skip('Windows does not permit test symlink creation');
    throw error;
  }
  await assert.rejects(buildClaudeMcpb(symlinkOutput), /must not already exist/i);
});
