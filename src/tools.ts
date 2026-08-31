import type { Context } from '@deepseek-ai/cordis';
import { assertSupportedJsonSchema, ToolArgsError, ToolOutputError, validateJsonSchemaValue, type JsonSchemaNode, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { RuntimePaths } from './config.js';
import { createMarketToolContracts, MarketToolArgsError, MarketToolOutputError, type MarketToolsService } from './tool-contracts.js';

export type { MarketToolsService } from './tool-contracts.js';

type ToolPaths = Pick<RuntimePaths, 'config'>;

/** Register the canonical market tools in the DSH registry. */
export function registerMarketTools(ctx: Context, service: MarketToolsService, paths: ToolPaths): () => void {
  const definitions = createMarketToolContracts(service, paths).map((contract) => strictDefinition({
    name: contract.name,
    description: contract.description,
    parameters: contract.inputSchema as Record<string, unknown>,
    output: { schema: contract.outputSchema as JsonSchemaNode, render: renderJson },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> {
      try {
        return await contract.execute(args, { signal: exec.signal });
      } catch (error) {
        if (error instanceof MarketToolArgsError) throw new ToolArgsError([...error.issues]);
        if (error instanceof MarketToolOutputError) throw new ToolOutputError(contract.name, [...error.issues]);
        throw error;
      }
    },
    presentCall: contract.name === 'market_watchlist'
      ? () => ({ card: 'generic' as const, title: 'Update market watchlist', kind: 'edit' as const, locations: [{ path: paths.config }] })
      : () => readView(presentTitle(contract.name)),
  } as unknown as ToolDefinition, contract.inputSchema, contract.outputSchema));

  const disposers: Array<() => void> = [];
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) dispose();
  };
}

function strictDefinition(definition: ToolDefinition, parameters: JsonSchemaNode, outputSchema: JsonSchemaNode): ToolDefinition {
  assertSupportedJsonSchema(parameters);
  assertSupportedJsonSchema(outputSchema);
  const execute = definition.execute.bind(definition);
  const presentCall = definition.presentCall?.bind(definition);
  return {
    ...definition,
    parameters: parameters as Record<string, unknown>,
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(parameters, args, '');
      if (violations.length > 0) throw new ToolArgsError(violations);
      const value = await execute(args, exec);
      const outputViolations = validateJsonSchemaValue(outputSchema, value, '');
      if (outputViolations.length > 0) throw new ToolOutputError(definition.name, outputViolations);
      return value;
    },
    ...(presentCall === undefined ? {} : { presentCall(args: unknown) {
      if (validateJsonSchemaValue(parameters, args, '').length > 0) return undefined;
      return presentCall(args);
    } }),
  };
}

function renderJson(_args: unknown, value: JsonValue) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('validated JSON value could not be serialized');
  return [{ type: 'text' as const, text }];
}

function readView(title: string) {
  return { card: 'generic' as const, title, kind: 'read' as const };
}

function presentTitle(name: string): string {
  return {
    market_status: 'Read market status', market_quotes: 'Read market quotes', market_series: 'Read market series',
    market_sectors: 'Read market sectors', market_auction: 'Read market auction', market_data_health: 'Read market data health',
  }[name] ?? 'Read market data';
}
