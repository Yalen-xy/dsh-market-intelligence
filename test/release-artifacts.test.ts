import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { stageRelease } from '../scripts/stage-release.mjs';

const execFileAsync = promisify(execFile);
const version = '0.1.0';
const expectedAssets = [
  'LICENSE.txt',
  'SHA256SUMS.txt',
  'dsh-market-intelligence-0.1.0.tgz',
  'dsh-market-intelligence-latest.zip',
  'install.ps1',
  'uninstall.ps1',
];

const expectedCustomerArchiveEntries = [
  'LICENSE.txt',
  'SHA256SUMS.txt',
  'dsh-market-intelligence-0.1.0.tgz',
  'install.ps1',
  'uninstall.ps1',
  'INSTALL.cmd',
];

test('stages exactly the verified release assets with canonical checksums', async (t) => {
  const fixture = await createStageFixture(t);

  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root });

  assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [...expectedAssets].sort());
  assert.deepEqual(await readFile(path.join(fixture.root, 'LICENSE')), await readFile(path.join(fixture.outputDirectory, 'LICENSE.txt')));
  assert.deepEqual(await readFile(fixture.packagePath), await readFile(path.join(fixture.outputDirectory, 'dsh-market-intelligence-0.1.0.tgz')));

  const manifest = await readFile(path.join(fixture.outputDirectory, 'SHA256SUMS.txt'), 'utf8');
  const rows = manifest.trimEnd().split('\n');
  assert.equal(manifest.endsWith('\n'), true);
  assert.deepEqual(rows.map((row) => row.slice(66)), [
    'LICENSE.txt',
    'dsh-market-intelligence-0.1.0.tgz',
    'install.ps1',
    'uninstall.ps1',
  ]);
  assert.deepEqual(rows, [...rows].sort((left, right) => left.slice(66) < right.slice(66) ? -1 : left.slice(66) > right.slice(66) ? 1 : 0));
  for (const row of rows) {
    assert.match(row, /^[a-f0-9]{64}  [^\\/:*?"<>|]+$/);
    const [hash, filename] = row.split('  ');
    assert.equal(hash, sha256(await readFile(path.join(fixture.outputDirectory, filename))));
  }
});

test('stages one fixed-name customer ZIP containing the verified release payloads and a double-click launcher', async (t) => {
  const fixture = await createStageFixture(t);
  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root });

  const archivePath = path.join(fixture.outputDirectory, 'dsh-market-intelligence-latest.zip');
  const listing = await execFileAsync('tar.exe', ['-tf', archivePath], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(String(listing.stdout).trimEnd().split(/\r?\n/).sort(), [...expectedCustomerArchiveEntries].sort());

  const extracted = path.join(fixture.root, 'customer-archive');
  await mkdir(extracted);
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extracted], { windowsHide: true });
  for (const name of expectedCustomerArchiveEntries.filter((entry) => entry !== 'INSTALL.cmd')) {
    assert.deepEqual(
      await readFile(path.join(extracted, name)),
      await readFile(path.join(fixture.outputDirectory, name)),
      name,
    );
  }
  const launcher = await readFile(path.join(extracted, 'INSTALL.cmd'), 'utf8');
  assert.match(launcher, /install\.ps1/);
  assert.match(launcher, /-Version "0\.1\.0"/);
  assert.match(launcher, /releases\/tags\/v0\.1\.0/);
  assert.doesNotMatch(launcher, /-AcceptLicense/);
});

test('rejects tags and package metadata that cannot identify an exact stable release', async (t) => {
  const fixture = await createStageFixture(t);
  for (const tag of ['v01.0.0', 'v1.00.0', 'v1.0.00', 'v1.0', 'v1.0.0-beta.1', 'v1.0.0+build', 'latest']) {
    await assert.rejects(stageRelease({ tag, packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root }), /stable release tag/i);
  }

  const wrongName = await createPackage(fixture.root, { name: 'other-package', version });
  await assert.rejects(stageRelease({ tag: 'v0.1.0', packagePath: wrongName, outputDirectory: path.join(fixture.root, 'wrong-name'), rootDirectory: fixture.root }), /package name/i);

  const wrongVersion = await createPackage(fixture.root, { name: 'dsh-market-intelligence', version: '0.1.1' });
  await assert.rejects(stageRelease({ tag: 'v0.1.0', packagePath: wrongVersion, outputDirectory: path.join(fixture.root, 'wrong-version'), rootDirectory: fixture.root }), /package version/i);
});

test('rejects archives and staging roots that do not meet installer safety requirements', async (t) => {
  const fixture = await createStageFixture(t);
  const missingPackageLicense = await createPackage(fixture.root, { name: 'dsh-market-intelligence', version, omit: 'LICENSE' });
  await assert.rejects(stageRelease({ tag: 'v0.1.0', packagePath: missingPackageLicense, outputDirectory: path.join(fixture.root, 'missing-entry'), rootDirectory: fixture.root }), /package archive entries invalid/i);

  await mkdir(fixture.outputDirectory);
  await writeFile(path.join(fixture.outputDirectory, 'unexpected.txt'), 'do not overwrite');
  await assert.rejects(stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root }), /output target/i);

  const noLicenseRoot = path.join(fixture.root, 'no-license');
  await copyFixtureRoot(fixture.root, noLicenseRoot);
  await rm(path.join(noLicenseRoot, 'LICENSE'));
  await assert.rejects(stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: path.join(fixture.root, 'no-license-output'), rootDirectory: noLicenseRoot }), /license/i);
});

test('produces byte-identical assets and manifest when staging identical inputs twice', async (t) => {
  const fixture = await createStageFixture(t);
  const secondOutput = path.join(fixture.root, 'release-second');
  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root });
  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: secondOutput, rootDirectory: fixture.root });

  for (const asset of expectedAssets) {
    assert.deepEqual(await readFile(path.join(fixture.outputDirectory, asset)), await readFile(path.join(secondOutput, asset)), asset);
  }
});

test('stages assets through the documented command-line interface', async (t) => {
  const fixture = await createStageFixture(t);
  const scriptPath = path.join(process.cwd(), 'scripts', 'stage-release.mjs');
  await execFileAsync(process.execPath, [scriptPath, '--tag', 'v0.1.0', '--package', fixture.packagePath, '--output', fixture.outputDirectory], {
    windowsHide: true,
  });
  assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [...expectedAssets].sort());
});

test('CLI reports a fixed error when the staging temp cannot be created', async (t) => {
  const fixture = await createStageFixture(t);
  const scriptPath = path.join(process.cwd(), 'scripts', 'stage-release.mjs');
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--permission',
      '--allow-fs-read=*',
      scriptPath,
      '--tag', 'v0.1.0',
      '--package', fixture.packagePath,
      '--output', fixture.outputDirectory,
    ], { windowsHide: true }),
    (error: NodeJS.ErrnoException & { stderr?: string | Buffer }) => {
      assert.equal(error.code, 1);
      assert.equal(String(error.stderr).trim(), 'release staging failed');
      for (const privatePath of [fixture.packagePath, fixture.root, fixture.outputDirectory]) {
        assert.doesNotMatch(String(error.stderr), new RegExp(escapeRegExp(privatePath), 'i'));
      }
      return true;
    },
  );
  await assert.rejects(readdir(fixture.outputDirectory), { code: 'ENOENT' });
});

test('rejects noncanonical and ambiguous tar entry names before creating output', async (t) => {
  const fixture = await createStageFixture(t);
  const cases: Array<{ name: string; entries: RawTarEntry[] }> = [
    { name: 'dot segment', entries: [{ name: './package/package.json', content: packageMetadata(), type: '0' }] },
    { name: 'repeated separator', entries: [{ name: 'package//package.json', content: packageMetadata(), type: '0' }] },
    { name: 'traversal suffix', entries: [{ name: 'package/lib/../payload.js', content: Buffer.from('payload'), type: '0' }] },
    { name: 'case duplicate', entries: [{ name: 'PACKAGE/license', content: Buffer.from('duplicate'), type: '0' }] },
    { name: 'required duplicate', entries: [{ name: 'package/LICENSE', content: Buffer.from('duplicate'), type: '0' }] },
    { name: 'outside package root', entries: [{ name: 'outside.txt', content: Buffer.from('outside'), type: '0' }] },
    { name: 'reserved device', entries: [{ name: 'package/CON', content: Buffer.from('device'), type: '0' }] },
    { name: 'trailing dot component', entries: [{ name: 'package/foo.', content: Buffer.from('dot'), type: '0' }] },
  ];

  for (const entryCase of cases) {
    await t.test(entryCase.name, async (child) => {
      const outputDirectory = path.join(fixture.root, `reject-${entryCase.name.replaceAll(' ', '-')}`);
      const packagePath = await createRawPackage(fixture.root, entryCase.entries);
      await assert.rejects(
        stageRelease({ tag: 'v0.1.0', packagePath, outputDirectory, rootDirectory: fixture.root }),
        /package archive entries invalid/i,
      );
      await assert.rejects(readdir(outputDirectory), { code: 'ENOENT' });
      child.diagnostic(`rejected ${entryCase.name}`);
    });
  }
});

test('rejects a required archive member that is not an ordinary file', async (t) => {
  const fixture = await createStageFixture(t);
  const packagePath = await createRawPackage(
    fixture.root,
    [{ name: 'package/LICENSE', content: Buffer.alloc(0), type: '5' }],
    ['package/LICENSE'],
  );
  const outputDirectory = path.join(fixture.root, 'directory-license');
  await assert.rejects(
    stageRelease({ tag: 'v0.1.0', packagePath, outputDirectory, rootDirectory: fixture.root }),
    /package archive entries invalid/i,
  );
  await assert.rejects(readdir(outputDirectory), { code: 'ENOENT' });
});

test('retains a diagnostic temp after an invalid staged tarball and retries the same target', async (t) => {
  const fixture = await createStageFixture(t);
  const validPackage = await readFile(fixture.packagePath);
  await writeFile(fixture.packagePath, Buffer.from('invalid staged tarball'));
  await assert.rejects(
    stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root }),
    /package archive could not be inspected/i,
  );
  await assert.rejects(readdir(fixture.outputDirectory), { code: 'ENOENT' });
  assert.equal((await stageDirectories(fixture.root)).length, 1);
  await writeFile(fixture.packagePath, validPackage);
  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root });
  assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [...expectedAssets].sort());
  assert.equal((await stageDirectories(fixture.root)).length, 1);
});

test('snapshots all four sources and ignores caller-provided hook objects', async (t) => {
  const fixture = await createStageFixture(t);
  const sources = await Promise.all([
    readFile(fixture.packagePath),
    readFile(path.join(fixture.root, 'installer', 'install.ps1')),
    readFile(path.join(fixture.root, 'installer', 'uninstall.ps1')),
    readFile(path.join(fixture.root, 'LICENSE')),
  ]);
  let called = false;
  await stageRelease({
    tag: 'v0.1.0',
    packagePath: fixture.packagePath,
    outputDirectory: fixture.outputDirectory,
    rootDirectory: fixture.root,
    dependencies: {
      beforeCommitImpl: () => { called = true; throw new Error('must not run'); },
    },
  });
  assert.equal(called, false);
  await Promise.all([
    writeFile(fixture.packagePath, 'source changed after staging'),
    writeFile(path.join(fixture.root, 'installer', 'install.ps1'), 'source changed after staging'),
    writeFile(path.join(fixture.root, 'installer', 'uninstall.ps1'), 'source changed after staging'),
    writeFile(path.join(fixture.root, 'LICENSE'), 'source changed after staging'),
  ]);
  for (const [index, name] of ['dsh-market-intelligence-0.1.0.tgz', 'install.ps1', 'uninstall.ps1', 'LICENSE.txt'].entries()) {
    assert.deepEqual(await readFile(path.join(fixture.outputDirectory, name)), sources[index], name);
  }
});

test('has no post-verification hook or unverified commit path', async (t) => {
  const fixture = await createStageFixture(t);
  await stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root });
  assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [...expectedAssets].sort());
  const source = await readFile(path.join(process.cwd(), 'scripts', 'stage-release.mjs'), 'utf8');
  assert.doesNotMatch(source, /dependencies|beforeCommitImpl|resolveStageDependencies/);
  assert.match(source, /await assertFilesExist\(sourceAssets\.slice\(1\)\);\s*assertOutputDoesNotOverlapSources\([^;]+;[\s\S]*?const temporaryOutput[\s\S]*?for \(const asset of sourceAssets\)/);
  assert.match(source, /await verifyStagedAssets\([^;]+;\s*await assertOutputTargetAbsent\(output\);\s*await rename\(temporaryOutput, output\);/s);
});

test('requires directory names to agree with tar member types', async (t) => {
  const fixture = await createStageFixture(t);
  const noncanonicalDirectory = await createRawPackage(
    fixture.root,
    [{ name: 'package/cache', content: Buffer.alloc(0), type: '5' }],
  );
  await assert.rejects(
    stageRelease({ tag: 'v0.1.0', packagePath: noncanonicalDirectory, outputDirectory: path.join(fixture.root, 'bad-directory'), rootDirectory: fixture.root }),
    /package archive entries invalid/i,
  );
  const canonicalDirectory = await createRawPackage(
    fixture.root,
    [{ name: 'package/cache/', content: Buffer.alloc(0), type: '5' }],
  );
  const outputDirectory = path.join(fixture.root, 'canonical-directory');
  await stageRelease({ tag: 'v0.1.0', packagePath: canonicalDirectory, outputDirectory, rootDirectory: fixture.root });
  assert.deepEqual((await readdir(outputDirectory)).sort(), [...expectedAssets].sort());
});

test('rejects source overlap and an existing output link without altering sources', async (t) => {
  const fixture = await createStageFixture(t);
  const licenseBefore = await readFile(path.join(fixture.root, 'LICENSE'));
  await assert.rejects(
    stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.root, rootDirectory: fixture.root }),
    /overlaps source/i,
  );
  assert.deepEqual(await readFile(path.join(fixture.root, 'LICENSE')), licenseBefore);

  const protectedDirectory = path.join(fixture.root, 'protected-output');
  await mkdir(protectedDirectory);
  const sentinel = path.join(protectedDirectory, 'sentinel.txt');
  await writeFile(sentinel, 'preserve me');
  await symlink(protectedDirectory, fixture.outputDirectory, 'junction');
  await assert.rejects(
    stageRelease({ tag: 'v0.1.0', packagePath: fixture.packagePath, outputDirectory: fixture.outputDirectory, rootDirectory: fixture.root }),
    /output target/i,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
});

test('CLI rejects missing, duplicate, and unknown arguments without printing local paths', async (t) => {
  const fixture = await createStageFixture(t);
  const scriptPath = path.join(process.cwd(), 'scripts', 'stage-release.mjs');
  const cases = [
    [],
    ['--tag', 'v0.1.0', '--package', fixture.packagePath],
    ['--tag', 'v0.1.0', '--tag', 'v0.1.0', '--package', fixture.packagePath, '--output', fixture.outputDirectory],
    ['--tag', 'v0.1.0', '--package', fixture.packagePath, '--output', fixture.outputDirectory, '--extra', 'value'],
  ];
  for (const argumentsList of cases) {
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, ...argumentsList], { windowsHide: true }),
      (error: NodeJS.ErrnoException & { stderr?: string | Buffer }) => {
        assert.doesNotMatch(String(error.stderr), new RegExp(escapeRegExp(fixture.root), 'i'));
        return true;
      },
    );
  }
});

async function createStageFixture(t: TestContext): Promise<{ root: string; packagePath: string; outputDirectory: string }> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-release-artifacts-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'installer'), { recursive: true });
  await writeFile(path.join(root, 'LICENSE'), Buffer.from('limited use license\r\n', 'utf8'));
  await writeFile(path.join(root, 'installer', 'install.ps1'), 'install bytes\r\n');
  await writeFile(path.join(root, 'installer', 'uninstall.ps1'), 'uninstall bytes\r\n');
  return {
    root,
    packagePath: await createPackage(root, { name: 'dsh-market-intelligence', version }),
    outputDirectory: path.join(root, 'release'),
  };
}

async function createPackage(root: string, options: { name: string; version: string; omit?: 'LICENSE' }): Promise<string> {
  const packageParent = await mkdtemp(path.join(root, 'package-source-'));
  const packageDirectory = path.join(packageParent, 'package');
  await mkdir(path.join(packageDirectory, 'lib'), { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: options.name,
    version: options.version,
    main: './lib/index.js',
    license: 'SEE LICENSE IN LICENSE',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  await writeFile(path.join(packageDirectory, 'lib', 'index.js'), 'export {};\n');
  await writeFile(path.join(packageDirectory, 'cordis.patch.yml'), 'bundles: []\n');
  if (options.omit !== 'LICENSE') await writeFile(path.join(packageDirectory, 'LICENSE'), 'limited use license\n');
  const packagePath = path.join(root, `${options.name}-${options.version}-${crypto.randomUUID()}.tgz`);
  await execFileAsync('tar.exe', ['-czf', packagePath, '-C', packageParent, 'package'], { windowsHide: true });
  return packagePath;
}

async function createRawPackage(root: string, extraEntries: RawTarEntry[], omittedEntries: string[] = []): Promise<string> {
  const packagePath = path.join(root, `raw-${crypto.randomUUID()}.tgz`);
  const standardEntries: RawTarEntry[] = [
    { name: 'package/package.json', content: packageMetadata(), type: '0' },
    { name: 'package/lib/index.js', content: Buffer.from('export {};\n'), type: '0' },
    { name: 'package/cordis.patch.yml', content: Buffer.from('bundles: []\n'), type: '0' },
    { name: 'package/LICENSE', content: Buffer.from('limited use license\n'), type: '0' },
  ];
  await writeFile(packagePath, createRawTarGz([
    ...standardEntries.filter((entry) => !omittedEntries.includes(entry.name)),
    ...extraEntries,
  ]));
  return packagePath;
}

function packageMetadata(): Buffer {
  return Buffer.from(JSON.stringify({
    name: 'dsh-market-intelligence',
    version,
    main: './lib/index.js',
    license: 'SEE LICENSE IN LICENSE',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
}

interface RawTarEntry {
  content: Buffer;
  name: string;
  type: '0' | '5';
}

function createRawTarGz(entries: RawTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    writeTarString(header, entry.name, 0, 100);
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, entry.type === '0' ? entry.content.length : 0, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, 'ascii');
    writeTarString(header, 'ustar', 257, 6);
    writeTarString(header, '00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    if (entry.type === '0') {
      blocks.push(entry.content);
      const padding = (512 - (entry.content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) throw new Error('raw tar test entry field is too long');
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

async function copyFixtureRoot(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
  await mkdir(path.join(destination, 'installer'));
  await copyFile(path.join(source, 'installer', 'install.ps1'), path.join(destination, 'installer', 'install.ps1'));
  await copyFile(path.join(source, 'installer', 'uninstall.ps1'), path.join(destination, 'installer', 'uninstall.ps1'));
}

async function stageDirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.stage-release-'))
    .map((entry) => entry.name);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
