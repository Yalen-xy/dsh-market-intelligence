import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const MAX_PROTOCOL_BYTES = 262_144;
const OVERALL_TIMEOUT_MS = 30_000;

export async function runClaudeSmoke(bundleArgument, options = {}) {
  const bundle = path.resolve(bundleArgument);
  await access(bundle);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-mcpb-smoke-'));
  assert.match(path.parse(temporaryRoot).root, /^[A-Za-z]:\\$/, 'smoke root must be on a local fixed disk');
  options.onTemporaryRoot?.(temporaryRoot);
  const context = {
    children: new Set(),
    client: undefined,
    transport: undefined,
    stderrCollectors: [],
    stdoutCollectors: [],
    timeoutMs: options.timeoutMs ?? OVERALL_TIMEOUT_MS,
    onChild: options.onChild,
    timedOut: false,
  };
  let result;
  let timeout;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
    timeout = setTimeout(() => {
      context.timedOut = true;
      void shutdownOwnedChildren(context).then(() => rejectDeadline(new Error(`Claude MCPB smoke timed out after ${context.timeoutMs}ms`)));
    }, context.timeoutMs);
  });
  try {
    const operation = runSmokeOperation(bundle, temporaryRoot, context, options);
    const guardedOperation = operation.catch((error) => context.timedOut ? deadline : Promise.reject(error));
    result = await Promise.race([guardedOperation, deadline]);
    return result;
  } catch (error) {
    const diagnostics = boundedDiagnostics(context.stderrCollectors.map((collector) => collector.text()).join(''));
    const reason = error instanceof Error ? boundedDiagnostics(error.message) : 'unknown failure';
    throw new Error(`Claude MCPB smoke failed: ${reason}${diagnostics === '' ? '' : `; diagnostics: ${diagnostics}`}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    await shutdownOwnedChildren(context);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (result) result.temporaryRootRemoved = true;
  }
}

async function runSmokeOperation(bundle, temporaryRoot, context, options) {
  const packageDirectory = path.join(temporaryRoot, 'package');
  const guardPath = path.join(temporaryRoot, 'network-guard.mjs');
  const redirectedRoots = redirectedDirectories(temporaryRoot);
  await extractBundle(bundle, packageDirectory);
  await Promise.all(Object.values(redirectedRoots).map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(guardPath, networkGuardSource, 'utf8');

  const primary = await runClientSmoke(packageDirectory, temporaryRoot, guardPath, redirectedRoots, context, options.server);
  const eofExit = await runEofShutdownSmoke(packageDirectory, path.join(temporaryRoot, 'eof-storage'), guardPath, redirectedRoots, context, options.server);
  const storageDirectories = [primary.storageDirectory, path.join(temporaryRoot, 'eof-storage')];
  assertInsideRoot(temporaryRoot, packageDirectory, guardPath, ...storageDirectories, ...Object.values(redirectedRoots));
  await verifyStorageReleased(storageDirectories);
  const redirectedFiles = await scanRedirectedRoots(temporaryRoot, Object.values(redirectedRoots));
  assertRawSafety(context);
  assert.equal(primary.protocolErrors.length, 0, 'the staged server emitted a malformed MCP frame');

  return {
    toolNames: primary.toolNames,
    calls: TOOL_CALLS.length,
    structuredTextCalls: primary.structuredTextCalls,
    protocolNoise: protocolNoise(primary.stdout.text()),
    exitCode: primary.exitCode,
    pendingChildren: [...context.children].filter((child) => child.exitCode === null && child.signalCode === null).length,
    shutdown: { graceful: primary.exitCode, eof: eofExit.exitCode },
    guardEvents: 0,
    redirectedFiles,
    storageReleased: true,
    temporaryRootRemoved: false,
    stderr: boundedDiagnostics(context.stderrCollectors.map((collector) => collector.text()).join('')),
  };
}

async function runClientSmoke(packageDirectory, temporaryRoot, guardPath, redirectedRoots, context, server) {
  const storageDirectory = path.join(temporaryRoot, 'client-storage');
  await seedClosedMarketState(storageDirectory);
  const transport = new StdioClientTransport(serverParameters(packageDirectory, storageDirectory, guardPath, redirectedRoots, server));
  const client = new Client({ name: 'claude-mcpb-smoke', version: '1.0.0' }, { capabilities: {} });
  const stderr = collectBoundedStream(transport.stderr, 'stderr');
  context.stderrCollectors.push(stderr);
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    await originalStart();
    const child = transport._process;
    assert.ok(child, 'stdio client did not create its owned server process');
    registerChild(context, child);
    const stdout = collectBoundedStream(child.stdout, 'stdout', MAX_PROTOCOL_BYTES);
    context.stdoutCollectors.push(stdout);
    transport._smokeStdout = stdout;
  };
  const protocolErrors = [];
  client.onerror = (error) => { protocolErrors.push(error.message); };
  context.client = client;
  context.transport = transport;
  await client.connect(transport);
  const child = transport._process;
  assert.ok(child, 'stdio client did not create its owned server process');
  const stdout = transport._smokeStdout;
  assert.ok(stdout, 'stdio stdout collector was not attached before initialization');
  const exited = closeResult(child);
  const listed = await client.listTools();
  const toolNames = listed.tools.map(({ name }) => name);
  assert.deepEqual(toolNames.toSorted(), TOOL_CALLS.map(({ name }) => name).toSorted(), 'staged server must list exactly seven tools');
  let structuredTextCalls = 0;
  for (const request of TOOL_CALLS) {
    const result = await client.callTool(request);
    assert.notEqual(result.isError, true, `${request.name} returned a tool error`);
    assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text', `${request.name} did not return JSON text`);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${request.name} text and structured content differ`);
    validateToolResult(request.name, result.structuredContent);
    structuredTextCalls += 1;
  }
  await client.close();
  const { exitCode } = await exited;
  assert.equal(exitCode, 0, 'client close must allow the staged server to exit cleanly');
  context.client = undefined;
  context.transport = undefined;
  return { toolNames, structuredTextCalls, stdout, protocolErrors, exitCode, storageDirectory };
}

async function runEofShutdownSmoke(packageDirectory, storageDirectory, guardPath, redirectedRoots, context, server) {
  await seedClosedMarketState(storageDirectory);
  const parameters = serverParameters(packageDirectory, storageDirectory, guardPath, redirectedRoots, server);
  const child = spawn(parameters.command, parameters.args, {
    cwd: packageDirectory,
    env: parameters.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registerChild(context, child);
  const stderr = collectBoundedStream(child.stderr, 'stderr');
  context.stderrCollectors.push(stderr);
  await waitFor(() => stderr.text().includes('claude_mcp info ready'), 5_000, 'EOF server did not become ready');
  const exited = closeResult(child);
  child.stdin.end();
  const result = await waitForExit(exited, child, 'EOF server did not exit', 5_000);
  assert.equal(result.exitCode, 0, 'EOF shutdown must exit with code zero');
  return { exitCode: result.exitCode };
}

function serverParameters(packageDirectory, storageDirectory, guardPath, redirectedRoots, server) {
  return {
    command: server?.command ?? process.execPath,
    args: server?.args ?? ['server/index.js'],
    cwd: packageDirectory,
    env: serverEnvironment(storageDirectory, guardPath, redirectedRoots),
    stderr: 'pipe',
  };
}

function serverEnvironment(storageDirectory, guardPath, redirectedRoots) {
  return {
    CLAUDE_MARKET_STORAGE_DIR: storageDirectory,
    CLAUDE_SMOKE_ROOT: path.dirname(storageDirectory),
    APPDATA: redirectedRoots.appData,
    HOME: redirectedRoots.home,
    HOMEDRIVE: path.parse(redirectedRoots.profile).root.slice(0, 2),
    HOMEPATH: path.relative(path.parse(redirectedRoots.profile).root, redirectedRoots.profile),
    LOCALAPPDATA: redirectedRoots.localAppData,
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
    PATH: process.env.PATH ?? '',
    TEMP: redirectedRoots.temp,
    TMP: redirectedRoots.tmp,
    USERPROFILE: redirectedRoots.profile,
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

function collectBoundedStream(stream, label, limit = MAX_DIAGNOSTIC_BYTES) {
  let value = '';
  let byteLength = 0;
  let overflow = false;
  stream?.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (byteLength + bytes.length > limit) {
      overflow = true;
      return;
    }
    byteLength += bytes.length;
    value += bytes.toString('utf8');
  });
  return { label, limit, text: () => value, overflow: () => overflow };
}

function closeResult(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
  }
  return once(child, 'close').then(([exitCode, signal]) => ({ exitCode, signal }));
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
  const exited = closeResult(child);
  child.kill('SIGTERM');
  try {
    await waitForExit(exited, child, 'owned child did not terminate', 2_000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = closeResult(child);
      child.kill('SIGKILL');
      await waitForExit(forcedExit, child, 'owned child did not terminate after forced cleanup', 2_000);
    }
  }
}

async function shutdownOwnedChildren(context) {
  await context.client?.close().catch(() => undefined);
  await context.transport?.close().catch(() => undefined);
  await Promise.allSettled([...context.children].map((child) => terminateOwnedChild(child)));
  context.client = undefined;
  context.transport = undefined;
}

function registerChild(context, child) {
  context.children.add(child);
  context.onChild?.(child);
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

function redirectedDirectories(root) {
  return {
    appData: path.join(root, 'app-data'),
    home: path.join(root, 'home'),
    localAppData: path.join(root, 'local-app-data'),
    profile: path.join(root, 'user-profile'),
    temp: path.join(root, 'temp'),
    tmp: path.join(root, 'tmp'),
  };
}

async function scanRedirectedRoots(root, directories) {
  let files = 0;
  const scan = async (directory) => {
    assertInsideRoot(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      assertInsideRoot(root, candidate);
      files += 1;
      if (entry.isDirectory()) await scan(candidate);
    }
  };
  for (const directory of directories) await scan(directory);
  return files;
}

function assertRawSafety(context) {
  const collectors = [...context.stderrCollectors, ...context.stdoutCollectors];
  for (const collector of collectors) {
    assert.equal(collector.overflow(), false, `${collector.label} exceeded ${collector.limit} bytes`);
  }
  const stderr = context.stderrCollectors.map((collector) => collector.text()).join('');
  assert.equal(countNetworkAttempts(stderr), 0, 'the staged server attempted an HTTP request');
  assert.equal((stderr.match(/claude_smoke fs_blocked /g) ?? []).length, 0, 'the staged server attempted a filesystem mutation outside its test root');
  assert.doesNotMatch(stderr, /[A-Z]:\\|\\Users\\|\/(?:Users|home)\/|(?:secret|token)|\bat .+\.(?:[cm]?js|ts):\d+/i, 'raw diagnostics leaked sensitive or absolute-path data');
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

function validateToolResult(name, value) {
  assert.ok(isRecord(value), `${name} must return an object`);
  switch (name) {
    case 'market_status': {
      assert.match(value.asOf, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(value.collectionActive, false);
      assert.ok(Array.isArray(value.markets) && value.markets.length === 2);
      for (const market of ['CN', 'HK']) {
        const entry = value.markets.find((candidate) => candidate?.market === market);
        assert.ok(isRecord(entry), `market_status is missing ${market}`);
        assert.equal(entry.phase, 'closed');
        assert.equal(entry.collectionActive, false);
        assert.match(entry.tradingDate, /^\d{4}-\d{2}-\d{2}$/);
      }
      return;
    }
    case 'market_quotes':
      assert.deepEqual(value, { availability: 'unavailable', items: [], conflicts: [] });
      return;
    case 'market_series':
      assert.deepEqual(value, { availability: 'unavailable', source: null, items: [] });
      return;
    case 'market_sectors':
      assert.equal(value.availability, 'unavailable');
      assert.deepEqual(value.items, []);
      return;
    case 'market_auction':
      assert.deepEqual(value, { availability: 'unavailable', phase: 'closed', reason: 'CN auction is inactive', items: [] });
      return;
    case 'market_watchlist':
      assert.deepEqual(value, { watchlist: [] });
      return;
    case 'market_data_health':
      assert.ok(Array.isArray(value.providers));
      assert.ok(isRecord(value.scheduler) && ['running', 'stopping', 'stopped'].includes(value.scheduler.state));
      assert.ok(isRecord(value.database) && isRecord(value.database.counts));
      assert.ok(Array.isArray(value.gaps));
      return;
    default:
      throw new Error('unknown smoke tool');
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
const path = require('node:path');
const root = path.resolve(process.env.CLAUDE_SMOKE_ROOT ?? '');
const isInsideRoot = (value) => {
  if (typeof value !== 'string' && !(value instanceof URL)) return true;
  const target = path.resolve(String(value));
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const blocked = (kind) => {
  process.stderr.write(\`claude_smoke network_blocked \${kind}\\n\`);
  throw new Error('network blocked by Claude smoke');
};
const blockedFs = (kind, value) => {
  if (isInsideRoot(value)) return;
  process.stderr.write(\`claude_smoke fs_blocked \${kind}\\n\`);
  throw new Error('filesystem mutation blocked by Claude smoke');
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
const fs = require('node:fs');
const promises = require('node:fs/promises');
for (const name of ['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile']) {
  for (const module of [fs, promises]) {
    if (typeof module[name] !== 'function') continue;
    const original = module[name];
    module[name] = (target, ...args) => {
      blockedFs(name, target);
      if (name === 'rename' || name === 'copyFile' || name === 'cp' || name === 'link' || name === 'symlink') blockedFs(name, args[0]);
      return original.call(module, target, ...args);
    };
  }
}
const originalOpen = promises.open;
promises.open = (target, flags, ...args) => {
  if (typeof flags === 'string' && /[wa+]/.test(flags)) blockedFs('open', target);
  return originalOpen.call(promises, target, flags, ...args);
};
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
