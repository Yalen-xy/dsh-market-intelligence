import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import packageMetadata from '../package.json' with { type: 'json' };
import type { MarketRuntime } from '../src/runtime.js';
import {
  createMarketToolContracts,
  MarketToolArgsError,
} from '../src/tool-contracts.js';
import type { ClaudeLogger } from './logging.js';

export type ClaudeRuntimeFactory = () => MarketRuntime;

export function createClaudeMcpServer(runtimeFactory: ClaudeRuntimeFactory, logger: ClaudeLogger): {
  server: Server;
  close(): Promise<void>;
} {
  const runtime = runtimeFactory();
  const contracts = createMarketToolContracts(runtime.service, runtime.paths);
  const server = new Server(
    { name: 'dsh-market-intelligence', version: packageMetadata.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: contracts.map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
    })),
  }));

  server.fallbackRequestHandler = async (request, extra) => {
    if (request.method !== 'tools/call') {
      throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
    }
    const parsed = CallToolRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid tools/call request');
    }
    const contract = contracts.find(({ name }) => name === parsed.data.params.name);
    if (!contract) throw new McpError(ErrorCode.InvalidParams, 'Unknown market tool');
    try {
      const result = await contract.execute(parsed.data.params.arguments ?? {}, { signal: extra.signal });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof MarketToolArgsError) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid market tool arguments');
      }
      logger.error('runtime');
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Market data request failed' }],
      };
    }
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        await server.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await runtime.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Claude MCP shutdown failed');
    });
    return closing;
  };

  return { server, close };
}
