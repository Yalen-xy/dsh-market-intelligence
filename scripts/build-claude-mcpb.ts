import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { unzipSync } from 'fflate';
import packageMetadata from '../package.json' with { type: 'json' };
import { createClaudeManifest } from '../claude/manifest.js';

const executeFile = promisify(execFile);
const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const allowedArchiveFiles = ['LICENSE', 'manifest.json', 'server/index.js'];
const localMcpbCli = path.join(rootDirectory, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

export type ClaudeMcpbBuildResult = { output: string; sha256: string };
export type ClaudeMcpbBuildOptions = { temporaryDirectory?: string };

export async function buildClaudeMcpb(outputArgument: string, options: ClaudeMcpbBuildOptions = {}): Promise<ClaudeMcpbBuildResult> {
  const output = path.resolve(outputArgument);
  await assertNewOutputPath(output);
  await mkdir(path.dirname(output), { recursive: true });
  const temporaryDirectory = options.temporaryDirectory === undefined
    ? await mkdtemp(path.join(path.dirname(output), '.claude-mcpb-'))
    : path.resolve(options.temporaryDirectory);
  if (pathsOverlap(output, temporaryDirectory)) throw new Error('output target must not overlap its temporary staging directory');

  let completed = false;
  try {
    const stagingDirectory = path.join(temporaryDirectory, 'package');
    const serverDirectory = path.join(stagingDirectory, 'server');
    const serverEntry = path.join(serverDirectory, 'index.js');
    const packedOutput = path.join(temporaryDirectory, 'package.mcpb');
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
    const archive = await inspectArchive(packedOutput);
    await mkdir(unpackedDirectory);
    await writeFile(path.join(unpackedDirectory, 'manifest.json'), archive['manifest.json']!);
    await runMcpbCli('validate', unpackedDirectory);
    inspectBundle(Buffer.from(archive['server/index.js']!).toString('utf8'));
    const packedBytes = await readFile(packedOutput);
    const sha256 = createHash('sha256').update(packedBytes).digest('hex');
    await assertNewOutputPath(output);
    await rename(packedOutput, output);
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

async function inspectArchive(archivePath: string): Promise<Record<string, Uint8Array>> {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(await readFile(archivePath));
  } catch {
    throw new Error('official MCPB pack produced an unreadable archive');
  }
  const actualNames = Object.keys(archive).sort();
  if (actualNames.length !== allowedArchiveFiles.length || actualNames.some((name, index) => name !== allowedArchiveFiles[index])) {
    throw new Error('MCPB archive contains noncanonical files');
  }
  return archive;
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
