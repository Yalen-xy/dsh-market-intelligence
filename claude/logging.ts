import type { Writable } from 'node:stream';

export type ClaudeLogger = {
  info(event: string): void;
  error(category: 'config' | 'runtime' | 'protocol' | 'internal'): void;
};

const PUBLIC_INFO_EVENTS = new Set(['ready', 'shutdown']);

export function createClaudeLogger(stderr: Pick<Writable, 'write'>): ClaudeLogger {
  return {
    info(event) {
      const publicEvent = PUBLIC_INFO_EVENTS.has(event) ? event : 'internal';
      stderr.write(`claude_mcp info ${publicEvent}\n`);
    },
    error(category) {
      stderr.write(`claude_mcp error ${category}\n`);
    },
  };
}
