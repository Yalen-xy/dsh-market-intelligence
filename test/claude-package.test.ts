import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { validateManifest } from '@anthropic-ai/mcpb/node';
import { buildClaudeMcpb, inspectClaudeMcpbArchive } from '../scripts/build-claude-mcpb.ts';

const expectedFiles = ['LICENSE', 'manifest.json', 'server/index.js'];
const executeFile = promisify(execFile);

test('Claude MCPB builder produces an officially valid self-contained Windows package', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const output = path.join(temporaryDirectory, 'claude-market-intelligence-latest.mcpb');

  const result = await buildClaudeMcpb(output);
  const archive = inspectClaudeMcpbArchive(await readFile(output));
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

test('Claude MCPB builder canonicalizes identical inputs to byte-identical output', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-deterministic-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const firstOutput = path.join(temporaryDirectory, 'first.mcpb');
  const secondOutput = path.join(temporaryDirectory, 'second.mcpb');

  const first = await buildClaudeMcpb(firstOutput);
  const second = await buildClaudeMcpb(secondOutput);

  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(firstOutput), await readFile(secondOutput));
});

test('Claude MCPB builder canonicalizes identical input bytes across timezones', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-timezone-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputs: string[] = [];
  for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    const output = path.join(temporaryDirectory, `${timezone.replace('/', '-')}.mcpb`);
    await executeFile(process.execPath, ['--import', 'tsx', 'scripts/build-claude-mcpb.ts', '--output', output], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: timezone },
      windowsHide: true,
    });
    outputs.push(output);
  }
  const bytes = await Promise.all(outputs.map((output) => readFile(output)));
  assert.deepEqual(bytes[0], bytes[1]);
  assert.deepEqual(bytes[0], bytes[2]);
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

test('Claude MCPB builder publishes only one concurrent output without replacement', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-race-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const output = path.join(temporaryDirectory, 'race.mcpb');

  const results = await Promise.allSettled([buildClaudeMcpb(output), buildClaudeMcpb(output)]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.ok(failure !== undefined && failure.status === 'rejected');
  assert.match(String(failure.reason), /must not already exist/i);
  assert.deepEqual(Object.keys(inspectClaudeMcpbArchive(await readFile(output))).sort(), expectedFiles);
});

test('Claude MCPB builder rejects a junction in an output-parent ancestor', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-junction-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const targetDirectory = path.join(temporaryDirectory, 'target');
  const junctionDirectory = path.join(temporaryDirectory, 'junction');
  await mkdir(targetDirectory);
  try {
    await symlink(targetDirectory, junctionDirectory, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows does not permit test junction creation');
      return;
    }
    throw error;
  }

  await assert.rejects(buildClaudeMcpb(path.join(junctionDirectory, 'artifact.mcpb')), /reparse|symbolic link|junction/i);
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
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows does not permit test symlink creation');
      return;
    }
    throw error;
  }
  await assert.rejects(buildClaudeMcpb(symlinkOutput), /must not already exist/i);
});

test('Claude MCPB central-directory parser rejects duplicate and non-ordinary entries', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-central-directory-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const output = path.join(temporaryDirectory, 'artifact.mcpb');
  await buildClaudeMcpb(output);
  const archive = await readFile(output);

  assert.throws(() => inspectClaudeMcpbArchive(appendFirstCentralDirectoryEntry(archive)), /duplicate|exactly three|noncanonical/i);
  assert.throws(() => inspectClaudeMcpbArchive(markFirstCentralDirectoryEntryAsSymbolicLink(archive)), /ordinary/i);
  for (const attribute of [0x08, 0x10, 0x40, 0x400]) {
    assert.throws(() => inspectClaudeMcpbArchive(markFirstCentralDirectoryEntryWithDosAttribute(archive, attribute)), /ordinary/i);
  }
});

function appendFirstCentralDirectoryEntry(archive: Uint8Array): Uint8Array {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const nameLength = view.getUint16(centralOffset + 28, true);
  const extraLength = view.getUint16(centralOffset + 30, true);
  const commentLength = view.getUint16(centralOffset + 32, true);
  const entryLength = 46 + nameLength + extraLength + commentLength;
  const duplicate = archive.slice(centralOffset, centralOffset + entryLength);
  const result = new Uint8Array(archive.length + entryLength);
  result.set(archive.slice(0, eocdOffset), 0);
  result.set(duplicate, eocdOffset);
  result.set(archive.slice(eocdOffset), eocdOffset + entryLength);
  const resultView = new DataView(result.buffer);
  const resultEocdOffset = eocdOffset + entryLength;
  resultView.setUint16(resultEocdOffset + 8, view.getUint16(eocdOffset + 8, true) + 1, true);
  resultView.setUint16(resultEocdOffset + 10, view.getUint16(eocdOffset + 10, true) + 1, true);
  resultView.setUint32(resultEocdOffset + 12, view.getUint32(eocdOffset + 12, true) + entryLength, true);
  return result;
}

function markFirstCentralDirectoryEntryAsSymbolicLink(archive: Uint8Array): Uint8Array {
  const result = archive.slice();
  const eocdOffset = findEndOfCentralDirectory(result);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  view.setUint32(centralOffset + 38, 0o120000 << 16, true);
  return result;
}

function markFirstCentralDirectoryEntryWithDosAttribute(archive: Uint8Array, attribute: number): Uint8Array {
  const result = archive.slice();
  const eocdOffset = findEndOfCentralDirectory(result);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  view.setUint32(centralOffset + 38, attribute, true);
  return result;
}

function findEndOfCentralDirectory(archive: Uint8Array): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset, 4);
    if (view.getUint32(0, true) === 0x06054b50) return offset;
  }
  throw new Error('fixture has no ZIP end-of-central-directory record');
}
