import {
  MARKET_RUNTIME_DEFAULTS,
  MARKET_RUNTIME_INTEGER_LIMITS,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../src/config.js';
import { requireLocalWindowsPath } from '../src/paths.js';
import path from 'node:path';

export type ClaudeRuntimeConfig = {
  storageDir?: string;
  requestTimeoutMs: number;
  quoteIntervalMs: number;
  sectorIntervalMs: number;
};

const CLAUDE_STORAGE_DIRECTORY = 'claude';
const CLAUDE_APPLICATION_DIRECTORY = 'dsh-market-intelligence';
const CLAUDE_DATABASE_FILE = 'claude-market.sqlite';
const CLAUDE_CONFIG_FILE = 'claude-config.json';
const DECIMAL_INTEGER = /^[1-9]\d*$/;

export function resolveClaudeBaseDirectory(environment: NodeJS.ProcessEnv): string {
  const localAppData = environment.LOCALAPPDATA;
  if (typeof localAppData !== 'string' || localAppData.trim() === '') {
    throw new Error('LOCALAPPDATA must be a non-empty normalized absolute local Windows path');
  }
  return path.win32.join(
    requireLocalWindowsPath(localAppData, 'LOCALAPPDATA'),
    CLAUDE_APPLICATION_DIRECTORY,
    CLAUDE_STORAGE_DIRECTORY,
  );
}

export function resolveClaudeRuntimePaths(baseDirectory: string, storageDir?: string): RuntimePaths {
  const paths = resolveRuntimePaths(baseDirectory, storageDir);
  return {
    ...paths,
    database: path.win32.join(paths.root, CLAUDE_DATABASE_FILE),
    config: path.win32.join(paths.root, CLAUDE_CONFIG_FILE),
  };
}

export function readClaudeConfig(environment: NodeJS.ProcessEnv): ClaudeRuntimeConfig {
  resolveClaudeBaseDirectory(environment);
  const storageDir = readOptionalStorageDirectory(environment.CLAUDE_MARKET_STORAGE_DIR);
  return {
    ...(storageDir === undefined ? {} : { storageDir }),
    requestTimeoutMs: readBoundedInteger(
      environment.CLAUDE_MARKET_REQUEST_TIMEOUT_MS,
      MARKET_RUNTIME_DEFAULTS.requestTimeoutMs,
      MARKET_RUNTIME_INTEGER_LIMITS.requestTimeoutMs,
      'CLAUDE_MARKET_REQUEST_TIMEOUT_MS',
    ),
    quoteIntervalMs: readBoundedInteger(
      environment.CLAUDE_MARKET_QUOTE_INTERVAL_MS,
      MARKET_RUNTIME_DEFAULTS.quoteIntervalMs,
      MARKET_RUNTIME_INTEGER_LIMITS.quoteIntervalMs,
      'CLAUDE_MARKET_QUOTE_INTERVAL_MS',
    ),
    sectorIntervalMs: readBoundedInteger(
      environment.CLAUDE_MARKET_SECTOR_INTERVAL_MS,
      MARKET_RUNTIME_DEFAULTS.sectorIntervalMs,
      MARKET_RUNTIME_INTEGER_LIMITS.sectorIntervalMs,
      'CLAUDE_MARKET_SECTOR_INTERVAL_MS',
    ),
  };
}

function readOptionalStorageDirectory(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return requireLocalWindowsPath(value, 'CLAUDE_MARKET_STORAGE_DIR');
}

function readBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  limits: { minimum: number; maximum: number },
  label: string,
): number {
  if (value === undefined) return defaultValue;
  if (!DECIMAL_INTEGER.test(value)) {
    throw new Error(`${label} must be a canonical decimal integer from ${limits.minimum} to ${limits.maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < limits.minimum || parsed > limits.maximum) {
    throw new Error(`${label} must be an integer from ${limits.minimum} to ${limits.maximum}`);
  }
  return parsed;
}
