import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import packageMetadata from '../package.json' with { type: 'json' };
import { createClaudeManifest } from '../claude/manifest.js';

const executeFile = promisify(execFile);
const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const allowedArchiveFiles = ['LICENSE', 'manifest.json', 'server/index.js'];
const localMcpbCli = path.join(rootDirectory, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
const canonicalZipTimestamp = '1980-01-01T00:00:00';

export type ClaudeMcpbBuildResult = { output: string; sha256: string };
export type ClaudeMcpbBuildOptions = { temporaryDirectory?: string };

export async function buildClaudeMcpb(outputArgument: string, options: ClaudeMcpbBuildOptions = {}): Promise<ClaudeMcpbBuildResult> {
  const output = path.resolve(outputArgument);
  await assertNewOutputPath(output);
  await assertSafeOutputParent(output);
  await mkdir(path.dirname(output), { recursive: true });
  await assertSafeOutputParent(output);
  const temporaryDirectory = options.temporaryDirectory === undefined
    ? await mkdtemp(path.join(path.dirname(output), '.claude-mcpb-'))
    : path.resolve(options.temporaryDirectory);
  if (pathsOverlap(output, temporaryDirectory)) throw new Error('output target must not overlap its temporary staging directory');

  let completed = false;
  try {
    const stagingDirectory = path.join(temporaryDirectory, 'package');
    const serverDirectory = path.join(stagingDirectory, 'server');
    const serverEntry = path.join(serverDirectory, 'index.js');
    const packedOutput = path.join(temporaryDirectory, 'packed.mcpb');
    const canonicalOutput = path.join(temporaryDirectory, 'package.mcpb');
    const unpackedDirectory = path.join(temporaryDirectory, 'unpacked');
    await mkdir(serverDirectory, { recursive: true });
    const result = await build({
      absWorkingDir: rootDirectory,
      entryPoints: ['claude/main.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: serverEntry,
      sourcemap: false,
      legalComments: 'none',
      minify: true,
      metafile: true,
      plugins: [{
        name: 'bundle-package-version-only',
        setup(context) {
          context.onResolve({ filter: /^\.\.\/package\.json$/ }, (argument) => {
            if (argument.importer.endsWith(path.join('claude', 'mcp-server.ts'))) {
              return { path: 'package-version', namespace: 'claude-mcpb' };
            }
            return undefined;
          });
          context.onLoad({ filter: /^package-version$/, namespace: 'claude-mcpb' }, () => ({
            contents: JSON.stringify({ version: packageMetadata.version }),
            loader: 'json',
          }));
        },
      }],
    });
    assertBundleDependenciesAreSelfContained(result.metafile?.outputs ?? {});
    await copyFile(path.join(rootDirectory, 'LICENSE'), path.join(stagingDirectory, 'LICENSE'));
    await writeFile(path.join(stagingDirectory, 'manifest.json'), `${JSON.stringify(createClaudeManifest(packageMetadata.version), null, 2)}\n`, 'utf8');
    await runMcpbCli('validate', stagingDirectory);
    await runMcpbCli('pack', stagingDirectory, packedOutput);
    const archive = canonicalizeArchive(await readFile(packedOutput));
    await writeFile(canonicalOutput, archive.bytes);
    const canonicalArchive = inspectClaudeMcpbArchive(archive.bytes);
    await mkdir(unpackedDirectory);
    await writeFile(path.join(unpackedDirectory, 'manifest.json'), canonicalArchive['manifest.json']!);
    await runMcpbCli('validate', unpackedDirectory);
    inspectBundle(Buffer.from(canonicalArchive['server/index.js']!).toString('utf8'));
    const sha256 = createHash('sha256').update(archive.bytes).digest('hex');
    await assertNewOutputPath(output);
    await assertSafeOutputParent(output);
    await publishWithoutReplacement(canonicalOutput, output);
    completed = true;
    return { output, sha256 };
  } catch (error) {
    console.error(`Claude MCPB build failed; diagnostic directory: ${path.basename(temporaryDirectory)}`);
    throw error;
  } finally {
    if (completed && options.temporaryDirectory === undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function assertNewOutputPath(output: string): Promise<void> {
  try {
    await lstat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('output target must not already exist');
}

async function assertSafeOutputParent(output: string): Promise<void> {
  const parent = path.dirname(output);
  const root = path.parse(parent).root;
  const components = parent.slice(root.length).split(path.sep).filter((component) => component !== '');
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error('output parent contains a symbolic link, junction, or reparse point');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function publishWithoutReplacement(stagedArchive: string, output: string): Promise<void> {
  try {
    await executeFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(rootDirectory, 'scripts', 'publish-claude-mcpb.ps1'), '-Source', stagedArchive, '-Destination', output,
    ], { cwd: rootDirectory, windowsHide: true });
  } catch (error) {
    if (String(error).includes('output_exists')) throw new Error('output target must not already exist');
    throw error;
  }
  try {
    await unlink(stagedArchive);
  } catch {
    throw new Error('output was published but the staged archive could not be removed');
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const relative = path.relative(second, first);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertBundleDependenciesAreSelfContained(outputs: Record<string, { imports: Array<{ path: string }> }>): void {
  const unresolved = Object.values(outputs).flatMap(({ imports }) => imports.map(({ path: importPath }) => importPath)).filter((importPath) => !importPath.startsWith('node:'));
  if (unresolved.length > 0) throw new Error('server bundle contains unresolved production dependencies');
}

async function runMcpbCli(...arguments_: string[]): Promise<void> {
  try {
    await executeFile(process.execPath, [localMcpbCli, ...arguments_], { cwd: rootDirectory, windowsHide: true });
  } catch {
    throw new Error(`official MCPB ${arguments_[0] ?? 'command'} validation failed`);
  }
}

export function inspectClaudeMcpbArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  parseCentralDirectory(bytes);
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error('MCPB archive is unreadable');
  }
}

function canonicalizeArchive(bytes: Uint8Array): { bytes: Uint8Array } {
  const archive = inspectClaudeMcpbArchive(bytes);
  const entries: Record<string, Uint8Array> = {};
  for (const name of allowedArchiveFiles) entries[name] = archive[name]!;
  const canonicalBytes = zipSync(entries, { level: 9, mtime: canonicalZipTimestamp });
  parseCentralDirectory(canonicalBytes);
  return { bytes: canonicalBytes };
}

function parseCentralDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) throw new Error('MCPB archive uses multiple ZIP disks');
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('MCPB archive uses unsupported ZIP64 records');
  if (entryCount !== allowedArchiveFiles.length || centralOffset + centralSize !== endOffset) throw new Error('MCPB archive contains noncanonical files');
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== 0x02014b50) throw new Error('MCPB archive has an invalid central directory');
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || diskStart !== 0 || entryEnd > endOffset) throw new Error('MCPB archive has an unsafe ZIP entry');
    const name = Buffer.from(bytes.slice(offset + 46, offset + 46 + nameLength)).toString('utf8');
    if (!allowedArchiveFiles.includes(name) || names.has(name) || name.includes('\\') || name.includes('..') || name.startsWith('/')) {
      throw new Error('MCPB archive contains duplicate or noncanonical files');
    }
    assertOrdinaryZipFile(externalAttributes);
    names.add(name);
    offset = entryEnd;
  }
  if (offset !== endOffset || names.size !== allowedArchiveFiles.length) throw new Error('MCPB archive contains noncanonical files');
}

function assertOrdinaryZipFile(externalAttributes: number): void {
  const forbiddenDosAttributes = 0x08 | 0x10 | 0x40 | 0x400;
  if ((externalAttributes & forbiddenDosAttributes) !== 0) throw new Error('MCPB archive entry is not an ordinary file');
  const fileType = (externalAttributes >>> 16) & 0o170000;
  if (fileType !== 0 && fileType !== 0o100000) throw new Error('MCPB archive entry is not an ordinary file');
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) return offset;
  }
  throw new Error('MCPB archive has no ZIP end-of-central-directory record');
}

function inspectBundle(bundle: string): void {
  const forbidden = [
    /sourceMappingURL/i,
    /\.ts(?:["'`]|$)/i,
    /(?:test[\\/]fixtures|\.log(?:["'`]|$))/i,
    /@deepseek-ai|cordis|schemastery|cordis\.patch|dsh\.patch/i,
    /[A-Z]:\\(?:Users|AI)\\|dsh-market-intelligence\\.worktrees/i,
    /(?:ghp_|github_pat_)[A-Za-z0-9_]+|Authorization:\s*Bearer/i,
  ];
  if (forbidden.some((pattern) => pattern.test(bundle))) {
    throw new Error('server bundle contains forbidden source, state, dependency, or path leakage');
  }
}

function readOutputArgument(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--output' || arguments_[1] === undefined || arguments_[1].trim() === '') {
    throw new Error('usage: node --import tsx scripts/build-claude-mcpb.ts --output <file>');
  }
  return arguments_[1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await buildClaudeMcpb(readOutputArgument(process.argv.slice(2)));
    console.log(`Built ${path.basename(result.output)} (${result.sha256})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Claude MCPB build failed');
    process.exitCode = 1;
  }
}
