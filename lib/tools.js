import { assertSupportedJsonSchema, ToolArgsError, ToolOutputError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createMarketToolContracts, MarketToolArgsError, MarketToolOutputError } from './tool-contracts.js';
/** Register the canonical market tools in the DSH registry. */
export function registerMarketTools(ctx, service, paths) {
    const definitions = createMarketToolContracts(service, paths).map((contract) => strictDefinition({
        name: contract.name,
        description: contract.description,
        parameters: contract.inputSchema,
        output: { schema: contract.outputSchema, render: renderJson },
        async execute(args, exec) {
            try {
                return await contract.execute(args, { signal: exec.signal });
            }
            catch (error) {
                if (error instanceof MarketToolArgsError)
                    throw new ToolArgsError([...error.issues]);
                if (error instanceof MarketToolOutputError)
                    throw new ToolOutputError(contract.name, [...error.issues]);
                throw error;
            }
        },
        presentCall: contract.name === 'market_watchlist'
            ? () => ({ card: 'generic', title: 'Update market watchlist', kind: 'edit', locations: [{ path: paths.config }] })
            : () => readView(presentTitle(contract.name)),
    }, contract.inputSchema, contract.outputSchema));
    const disposers = [];
    try {
        for (const definition of definitions)
            disposers.push(ctx.tools.register(definition));
    }
    catch (error) {
        for (const dispose of disposers.reverse())
            dispose();
        throw error;
    }
    let disposed = false;
    return () => {
        if (disposed)
            return;
        disposed = true;
        for (const dispose of disposers.reverse())
            dispose();
    };
}
function strictDefinition(definition, parameters, outputSchema) {
    assertSupportedJsonSchema(parameters);
    assertSupportedJsonSchema(outputSchema);
    const execute = definition.execute.bind(definition);
    const presentCall = definition.presentCall?.bind(definition);
    return {
        ...definition,
        parameters: parameters,
        async execute(args, exec) {
            const violations = validateJsonSchemaValue(parameters, args, '');
            if (violations.length > 0)
                throw new ToolArgsError(violations);
            const value = await execute(args, exec);
            const outputViolations = validateJsonSchemaValue(outputSchema, value, '');
            if (outputViolations.length > 0)
                throw new ToolOutputError(definition.name, outputViolations);
            return value;
        },
        ...(presentCall === undefined ? {} : { presentCall(args) {
                if (validateJsonSchemaValue(parameters, args, '').length > 0)
                    return undefined;
                return presentCall(args);
            } }),
    };
}
function renderJson(_args, value) {
    const text = JSON.stringify(value);
    if (text === undefined)
        throw new Error('validated JSON value could not be serialized');
    return [{ type: 'text', text }];
}
function readView(title) {
    return { card: 'generic', title, kind: 'read' };
}
function presentTitle(name) {
    return {
        market_status: 'Read market status', market_quotes: 'Read market quotes', market_series: 'Read market series',
        market_sectors: 'Read market sectors', market_auction: 'Read market auction', market_data_health: 'Read market data health',
    }[name] ?? 'Read market data';
}
