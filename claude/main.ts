import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  loadUserState,
  MARKET_RUNTIME_DEFAULTS,
  mutateWatchlist,
  type MarketRuntimeConfig,
} from '../src/config.js';
import { createSharedRequestLimiter, startMarketRuntime, type MarketRuntime, type MarketRuntimeOptions } from '../src/runtime.js';
import { assertSafeLocalWindowsPath } from '../src/paths.js';
import { SinaProvider } from '../src/providers/sina.js';
import { TencentProvider } from '../src/providers/tencent.js';
import { MarketRepository } from '../src/repository.js';
import { MarketScheduler, type Clock } from '../src/scheduler.js';
import { MarketService } from '../src/service.js';
import { readClaudeConfig, resolveClaudeBaseDirectory } from './config.js';
import { createClaudeLogger } from './logging.js';
import { createClaudeMcpServer } from './mcp-server.js';
import { ClaudeStdioServerTransport } from './stdio-transport.js';

type SignalSource = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type ClaudeServerStreams = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signals?: SignalSource;
  runtimeFactory?: (config: MarketRuntimeConfig, options: MarketRuntimeOptions) => Promise<MarketRuntime>;
  transportFactory?: (stdin: Readable, stdout: Writable) => Transport;
};

const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export async function runClaudeServer(
  environment: NodeJS.ProcessEnv,
  streams: ClaudeServerStreams,
): Promise<void> {
  const logger = createClaudeLogger(streams.stderr);
  let config: MarketRuntimeConfig;
  let baseDirectory: string;
  try {
    const claudeConfig = readClaudeConfig(environment);
    baseDirectory = resolveClaudeBaseDirectory(environment);
    config = { ...MARKET_RUNTIME_DEFAULTS, ...claudeConfig };
  } catch (error) {
    logger.error('config');
    throw error;
  }

  const runtimeOptions: MarketRuntimeOptions = {
    baseDirectory,
    assertSafePath: assertSafeLocalWindowsPath,
    mkdir,
    loadUserState,
    mutateWatchlist,
    openRepository: (databasePath) => MarketRepository.open(databasePath),
    createRequestLimiter: createSharedRequestLimiter,
    createTencent: (options) => new TencentProvider(options),
    createSina: (options) => new SinaProvider(options),
    createScheduler: (options) => new MarketScheduler(options),
    createService: (options) => new MarketService(options),
    clock: systemClock,
  };

  let runtime: MarketRuntime;
  try {
    runtime = await (streams.runtimeFactory ?? startMarketRuntime)(config, runtimeOptions);
  } catch (error) {
    logger.error('runtime');
    throw error;
  }

  const managed = createClaudeMcpServer(() => runtime, logger);
  const signals = streams.signals ?? process;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    shutdown = Promise.resolve().then(async () => {
      signals.off('SIGINT', handleSignal);
      signals.off('SIGTERM', handleSignal);
      await managed.close();
      logger.info('shutdown');
    });
    return shutdown;
  };
  const handleSignal = (): void => {
    void close().catch(() => logger.error('internal'));
  };
  signals.once('SIGINT', handleSignal);
  signals.once('SIGTERM', handleSignal);
  managed.server.onclose = handleSignal;

  try {
    const transport = (streams.transportFactory ?? ((input, output) => new ClaudeStdioServerTransport(input, output)))(streams.stdin, streams.stdout);
    await managed.server.connect(transport);
  } catch (error) {
    logger.error('protocol');
    try {
      await close();
    } catch {
      logger.error('internal');
    }
    throw error;
  }
  logger.info('ready');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runClaudeServer(process.env, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signals: process,
  }).catch(() => {
    process.exitCode = 1;
  });
}
