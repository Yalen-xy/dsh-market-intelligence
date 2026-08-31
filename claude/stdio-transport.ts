import type { Readable, Writable } from 'node:stream';
import { serializeMessage, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ErrorCode,
  JSONRPCMessageSchema,
  RequestIdSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

export type ClaudeStdioServerTransportOptions = {
  maxBufferSize?: number;
};

/**
 * SDK-compatible stdio transport with one protocol-boundary correction:
 * malformed tools/call params containers receive Invalid Params instead of
 * being discarded before the MCP Server can classify them.
 */
export class ClaudeStdioServerTransport implements Transport {
  private buffer: Buffer | undefined;
  private readonly maxBufferSize: number;
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
    options?: ClaudeStdioServerTransportOptions,
  ) {
    this.maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly handleData = (chunk: Buffer): void => {
    try {
      this.append(chunk);
      this.processBuffer();
    } catch (error) {
      this.onerror?.(asError(error));
      void this.close().catch(() => undefined);
    }
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly handleEnd = (): void => {
    void this.close().catch((error: unknown) => this.onerror?.(asError(error)));
  };

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('ClaudeStdioServerTransport already started! If using Server class, note that connect() calls start() automatically.');
    }
    this.started = true;
    this.stdin.on('data', this.handleData);
    this.stdin.on('error', this.handleError);
    this.stdin.once('end', this.handleEnd);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off('data', this.handleData);
    this.stdin.off('error', this.handleError);
    this.stdin.off('end', this.handleEnd);
    if (this.stdin.listenerCount('data') === 0) this.stdin.pause();
    this.buffer = undefined;
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.stdout.write(serializeMessage(message))) resolve();
      else this.stdout.once('drain', resolve);
    });
  }

  private append(chunk: Buffer): void {
    const newSize = (this.buffer?.length ?? 0) + chunk.length;
    if (newSize > this.maxBufferSize) {
      this.buffer = undefined;
      throw new Error(`Stdio buffer exceeded maximum size of ${this.maxBufferSize} bytes`);
    }
    this.buffer = this.buffer === undefined ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  private processBuffer(): void {
    while (this.buffer !== undefined) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.toString('utf8', 0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (isMalformedToolsCallParams(value)) {
          void this.send({
            jsonrpc: '2.0',
            id: value.id,
            error: { code: ErrorCode.InvalidParams, message: 'Invalid tools/call request' },
          }).catch((error: unknown) => this.onerror?.(asError(error)));
          continue;
        }
        this.onmessage?.(JSONRPCMessageSchema.parse(value));
      } catch (error) {
        this.onerror?.(asError(error));
      }
    }
  }
}

function isMalformedToolsCallParams(value: unknown): value is {
  jsonrpc: '2.0';
  id: string | number;
  method: 'tools/call';
  params: unknown;
} {
  if (!isRecord(value)) return false;
  if (value.jsonrpc !== '2.0' || value.method !== 'tools/call') return false;
  if (!RequestIdSchema.safeParse(value.id).success) return false;
  if (!Object.hasOwn(value, 'params')) return false;
  return value.params === null || typeof value.params !== 'object' || Array.isArray(value.params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Invalid stdio message');
}
