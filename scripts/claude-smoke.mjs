import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { unzipSync } from 'fflate';

const TOOL_CALLS = [
  { name: 'market_status', arguments: {} },
  { name: 'market_quotes', arguments: { symbols: [], refresh: false } },
  { name: 'market_series', arguments: { symbol: 'sh000001', interval: 'day', refresh: false } },
  { name: 'market_sectors', arguments: { refresh: false } },
  { name: 'market_auction', arguments: { market: 'CN', symbols: [] } },
  { name: 'market_watchlist', arguments: { action: 'get' } },
  { name: 'market_data_health', arguments: {} },
];
const EXPECTED_FILES = ['LICENSE', 'manifest.json', 'server/index.js'];
const MAX_DIAGNOSTIC_BYTES = 4_096;
const OVERALL_TIMEOUT_MS = 30_000;

export async function runClaudeSmoke(bundleArgument) {
  const bundle = path.resolve(bundleArgument);
  await access(bundle);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-smoke-'));
  assert.match(path.parse(temporaryRoot).root, /^[A-Za-z]:\\$/, 'smoke root must be on a local fixed disk');
  const ownedChildren = new Set();
  let timedOut = false;
  let result;
  const timeout = setTimeout(() => {
    timedOut = true;
    void Promise.allSettled([...ownedChildren].map((child) => terminateOwnedChild(child)));
  }, OVERALL_TIMEOUT_MS);
  const assertWithinTimeout = () => assert.equal(timedOut, false, 'Claude MCPB smoke exceeded its 30-second timeout');
  try {
    const packageDirectory = path.join(temporaryRoot, 'package');
    const guardPath = path.join(temporaryRoot, 'network-guard.mjs');
    await extractBundle(bundle, packageDirectory);
    await writeFile(guardPath, networkGuardSource, 'utf8');

    const primary = await runClientSmoke(packageDirectory, temporaryRoot, guardPath, ownedChildren);
    assertWithinTimeout();
    const signalExit = await runShutdownSmoke(packageDirectory, path.join(temporaryRoot, 'signal-storage'), guardPath, 'signal', ownedChildren);
    assertWithinTimeout();
    const eofExit = await runShutdownSmoke(packageDirectory, path.join(temporaryRoot, 'eof-storage'), guardPath, 'eof', ownedChildren);
    assertWithinTimeout();
    const storageDirectories = [primary.storageDirectory, path.join(temporaryRoot, 'signal-storage'), path.join(temporaryRoot, 'eof-storage')];
    assertInsideRoot(temporaryRoot, packageDirectory, guardPath, ...storageDirectories);
    await verifyStorageReleased(storageDirectories);

    const stderr = boundedDiagnostics([primary.stderr, signalExit.stderr, eofExit.stderr].filter(Boolean).join(''));
    assert.ok(Buffer.byteLength(stderr, 'utf8') <= MAX_DIAGNOSTIC_BYTES, 'server diagnostics must be bounded');
    assert.doesNotMatch(stderr, /[A-Z]:\\|\\Users\\|\/Users\//i, 'server diagnostics must not contain absolute paths');
    const networkRequests = countNetworkAttempts(stderr);
    assert.equal(networkRequests, 0, 'the staged server attempted an HTTP request');
    assert.equal(primary.protocolErrors.length, 0, 'the staged server emitted a malformed MCP frame');

    result = {
      toolNames: primary.toolNames,
      calls: TOOL_CALLS.length,
      structuredTextCalls: primary.structuredTextCalls,
      networkRequests,
      protocolNoise: protocolNoise(primary.stdout),
      exitCode: primary.exitCode,
      pendingChildren: [...ownedChildren].filter((child) => child.exitCode === null && child.signalCode === null).length,
      shutdown: { graceful: primary.exitCode, signal: signalExit.signal, eof: eofExit.exitCode },
      outsideFiles: 0,
      storageReleased: true,
      temporaryRootRemoved: false,
      stderr,
    };
    return result;
  } catch (error) {
    const diagnostics = boundedDiagnostics([...ownedChildren].map((child) => child.stderrText?.() ?? '').join(''));
    const reason = error instanceof Error ? boundedDiagnostics(error.message) : 'unknown failure';
    throw new Error(`Claude MCPB smoke failed: ${reason}${diagnostics === '' ? '' : `; diagnostics: ${diagnostics}`}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([...ownedChildren].map((child) => terminateOwnedChild(child)));
    await rm(temporaryRoot, { recursive: true, force: true });
    if (result) result.temporaryRootRemoved = true;
  }
}

async function runClientSmoke(packageDirectory, temporaryRoot, guardPath, ownedChildren) {
  const storageDirectory = path.join(temporaryRoot, 'client-storage');
  await seedClosedMarketState(storageDirectory);
  const transport = new StdioClientTransport(serverParameters(packageDirectory, storageDirectory, guardPath));
  const client = new Client({ name: 'claude-mcpb-smoke', version: '1.0.0' }, { capabilities: {} });
  const stderr = collectStream(transport.stderr);
  const protocolErrors = [];
  client.onerror = (error) => { protocolErrors.push(error.message); };
  await client.connect(transport);
  const child = transport._process;
  assert.ok(child, 'stdio client did not create its owned server process');
  ownedChildren.add(child);
  child.stderrText = stderr.read;
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += Buffer.from(chunk).toString('utf8'); });
  const exited = exitResult(child);
  const listed = await client.listTools();
  const toolNames = listed.tools.map(({ name }) => name);
  assert.deepEqual(toolNames.toSorted(), TOOL_CALLS.map(({ name }) => name).toSorted(), 'staged server must list exactly seven tools');
  let structuredTextCalls = 0;
  for (const request of TOOL_CALLS) {
    const result = await client.callTool(request);
    assert.notEqual(result.isError, true, `${request.name} returned a tool error`);
    assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text', `${request.name} did not return JSON text`);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${request.name} text and structured content differ`);
    structuredTextCalls += 1;
  }
  await client.close();
  const { exitCode } = await exited;
  assert.equal(exitCode, 0, 'client close must allow the staged server to exit cleanly');
  return { toolNames, structuredTextCalls, stdout, stderr: stderr.read(), protocolErrors, exitCode, storageDirectory };
}

async function runShutdownSmoke(packageDirectory, storageDirectory, guardPath, mode, ownedChildren) {
  await seedClosedMarketState(storageDirectory);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: packageDirectory,
    env: serverEnvironment(storageDirectory, guardPath),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  ownedChildren.add(child);
  const stderr = collectStream(child.stderr);
  child.stderrText = stderr.read;
  await waitFor(() => stderr.read().includes('claude_mcp info ready'), 5_000, `${mode} server did not become ready`);
  const exited = exitResult(child);
  if (mode === 'signal') child.kill('SIGTERM');
  else child.stdin.end();
  const result = await waitForExit(exited, child, `${mode} server did not exit`, 5_000);
  if (mode === 'signal') assert.equal(result.signal, 'SIGTERM', 'signal shutdown must terminate with SIGTERM');
  else assert.equal(result.exitCode, 0, 'EOF shutdown must exit with code zero');
  const diagnostics = stderr.read();
  return { exitCode: result.exitCode, signal: result.signal, stderr: diagnostics };
}

function serverParameters(packageDirectory, storageDirectory, guardPath) {
  return {
    command: process.execPath,
    args: ['server/index.js'],
    cwd: packageDirectory,
    env: serverEnvironment(storageDirectory, guardPath),
    stderr: 'pipe',
  };
}

function serverEnvironment(storageDirectory, guardPath) {
  return {
    CLAUDE_MARKET_STORAGE_DIR: storageDirectory,
    LOCALAPPDATA: path.join(path.dirname(storageDirectory), 'local-app-data'),
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
  };
}

async function extractBundle(bundle, packageDirectory) {
  const archive = unzipSync(await readFile(bundle));
  assert.deepEqual(Object.keys(archive).sort(), EXPECTED_FILES);
  for (const [name, bytes] of Object.entries(archive)) {
    const destination = path.join(packageDirectory, name);
    assert.ok(destination.startsWith(`${packageDirectory}${path.sep}`), 'MCPB archive path escaped the test root');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function seedClosedMarketState(storageDirectory) {
  const date = shanghaiDate();
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(path.join(storageDirectory, 'config.json'), `${JSON.stringify({
    watchlist: [],
    closures: { [date.slice(0, 4)]: { CN: [date], HK: [date] } },
  })}\n`, 'utf8');
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function collectStream(stream) {
  let text = '';
  stream?.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  return { read: () => text };
}

function exitResult(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
  }
  return once(child, 'exit').then(([exitCode, signal]) => ({ exitCode, signal }));
}

async function waitForExit(exited, child, message, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } catch (error) {
    await terminateOwnedChild(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function terminateOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitResult(child);
  child.kill('SIGTERM');
  try {
    await waitForExit(exited, child, 'owned child did not terminate', 2_000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function verifyStorageReleased(storageDirectories) {
  for (const storageDirectory of storageDirectories) {
    const released = `${storageDirectory}-released`;
    await rename(storageDirectory, released);
    await rename(released, storageDirectory);
  }
}

function assertInsideRoot(root, ...paths) {
  for (const candidate of paths) {
    const relative = path.relative(root, candidate);
    assert.ok(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'smoke created a file outside its test root');
  }
}

function protocolNoise(stdout) {
  if (stdout === '') return 'missing MCP stdout frames';
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some((line) => line === '')) return 'non-protocol stdout';
  try {
    for (const line of lines) JSONRPCMessageSchema.parse(JSON.parse(line));
  } catch {
    return 'non-protocol stdout';
  }
  return '';
}

function countNetworkAttempts(stderr) {
  return (stderr.match(/claude_smoke network_blocked (?:fetch|http|https|net|tls)/g) ?? []).length;
}

function boundedDiagnostics(value) {
  return value
    .replace(/[A-Z]:\\[^\r\n]*/gi, '<path>')
    .replace(/\/(?:Users|home)\/[^\r\n]*/gi, '<path>')
    .slice(0, MAX_DIAGNOSTIC_BYTES);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const networkGuardSource = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const blocked = (kind) => {
  process.stderr.write(\`claude_smoke network_blocked \${kind}\\n\`);
  throw new Error('network blocked by Claude smoke');
};
globalThis.fetch = async () => blocked('fetch');
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = () => blocked(name === 'node:http' ? 'http' : 'https');
  module.get = () => blocked(name === 'node:http' ? 'http' : 'https');
}
for (const name of ['node:net', 'node:tls']) {
  const module = require(name);
  module.connect = () => blocked(name === 'node:net' ? 'net' : 'tls');
  module.createConnection = () => blocked(name === 'node:net' ? 'net' : 'tls');
}
syncBuiltinESMExports();
`;

function readBundleArgument(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== '--bundle' || arguments_[1]?.trim() === '') {
    throw new Error('usage: node scripts/claude-smoke.mjs --bundle <mcpb-path>');
  }
  return arguments_[1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runClaudeSmoke(readBundleArgument(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Claude MCPB smoke failed');
    process.exitCode = 1;
  }
}
