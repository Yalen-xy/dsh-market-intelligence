import { McpbManifestSchema } from '@anthropic-ai/mcpb/schemas/0.4';
import type { z } from 'zod';

export type McpbManifest = z.infer<typeof McpbManifestSchema>;

const REPOSITORY_URL = 'https://github.com/Yalen-xy/dsh-market-intelligence';
const PROVIDER_NOTICE = 'Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.';

export function createClaudeManifest(version: string): McpbManifest {
  return {
    manifest_version: '0.4',
    name: 'dsh-market-intelligence',
    display_name: 'Market Intelligence',
    version,
    description: 'Read-only A-share and Hong Kong market intelligence for personal, non-commercial research.',
    long_description: PROVIDER_NOTICE,
    author: {
      name: 'Yalen-xy',
      url: REPOSITORY_URL,
    },
    repository: {
      type: 'git',
      url: `${REPOSITORY_URL}.git`,
    },
    homepage: REPOSITORY_URL,
    documentation: `${REPOSITORY_URL}/blob/main/docs/CLAUDE.md`,
    support: `${REPOSITORY_URL}/issues`,
    license: 'Personal Non-Commercial Limited Use License; see LICENSE',
    privacy_policies: [
      'https://www.tencent.com/privacy-policy/',
      'https://corp.sina.com.cn/eng/sina_priv_eng.htm',
    ],
    compatibility: {
      platforms: ['win32'],
      runtimes: { node: '^22.19.0 || >=24.0.0' },
    },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          CLAUDE_MARKET_STORAGE_DIR: '${user_config.storageDir}',
          CLAUDE_MARKET_REQUEST_TIMEOUT_MS: '${user_config.requestTimeoutMs}',
          CLAUDE_MARKET_QUOTE_INTERVAL_MS: '${user_config.quoteIntervalMs}',
          CLAUDE_MARKET_SECTOR_INTERVAL_MS: '${user_config.sectorIntervalMs}',
        },
      },
    },
    tools: [
      { name: 'market_auction', description: 'Read A-share call-auction or Hong Kong pre-open observations.' },
      { name: 'market_data_health', description: 'Diagnose market-data availability and provider failures.' },
      { name: 'market_quotes', description: 'Read current A-share and Hong Kong prices and market performance.' },
      { name: 'market_sectors', description: 'Read A-share industry and concept sector rankings.' },
      { name: 'market_series', description: 'Read minute, daily, weekly, or monthly bars for one supported symbol.' },
      { name: 'market_status', description: 'Read current A-share and Hong Kong market session state.' },
      { name: 'market_watchlist', description: 'Get, add, or remove one local A-share or Hong Kong watchlist symbol.' },
    ],
    tools_generated: false,
    user_config: {
      storageDir: {
        type: 'directory',
        title: 'Storage directory',
        description: 'Optional local Windows directory for this extension’s private market-data state.',
        default: '',
        required: false,
        sensitive: false,
      },
      requestTimeoutMs: {
        type: 'number',
        title: 'Request timeout (ms)',
        description: 'Provider request timeout in milliseconds.',
        default: 10_000,
        min: 100,
        max: 120_000,
        sensitive: false,
      },
      quoteIntervalMs: {
        type: 'number',
        title: 'Quote polling interval (ms)',
        description: 'Watchlist quote polling interval in milliseconds.',
        default: 10_000,
        min: 1_000,
        max: 300_000,
        sensitive: false,
      },
      sectorIntervalMs: {
        type: 'number',
        title: 'Sector polling interval (ms)',
        description: 'Sector polling interval in milliseconds.',
        default: 60_000,
        min: 10_000,
        max: 900_000,
        sensitive: false,
      },
    },
  };
}
