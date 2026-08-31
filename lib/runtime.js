import { resolveRuntimePaths } from './config.js';
import { SharedRequestLimiter } from './http.js';
export async function startMarketRuntime(config, options) {
    const paths = resolveRuntimePaths(options.baseDirectory, config.storageDir);
    let repository;
    let requestLimiter;
    let service;
    let disposal;
    const dispose = () => {
        if (disposal)
            return disposal;
        disposal = (async () => {
            const errors = [];
            let limiterDrain;
            if (requestLimiter) {
                try {
                    limiterDrain = requestLimiter.dispose();
                }
                catch (error) {
                    errors.push(error);
                }
            }
            if (service) {
                try {
                    await service.dispose();
                }
                catch (error) {
                    errors.push(error);
                }
            }
            else if (repository) {
                try {
                    repository.close();
                }
                catch (error) {
                    errors.push(error);
                }
            }
            if (limiterDrain) {
                try {
                    await limiterDrain;
                }
                catch (error) {
                    errors.push(error);
                }
            }
            throwCleanupErrors(errors);
        })();
        return disposal;
    };
    try {
        await options.assertSafePath(options.baseDirectory);
        await options.assertSafePath(paths.root);
        await options.mkdir(paths.root, { recursive: true });
        const initialState = await options.loadUserState(paths);
        repository = options.openRepository(paths.database);
        requestLimiter = options.createRequestLimiter(config.providerConcurrency);
        const now = () => options.clock.now().getTime();
        const tencent = options.createTencent({
            now,
            requestTimeoutMs: config.requestTimeoutMs,
            quoteConcurrency: config.providerConcurrency,
            requestLimiter,
        });
        const sina = options.createSina({ now, requestTimeoutMs: config.requestTimeoutMs, requestLimiter });
        const scheduler = options.createScheduler({
            clock: options.clock,
            closures: initialState.closures,
            quoteIntervalMs: config.quoteIntervalMs,
            sectorIntervalMs: config.sectorIntervalMs,
            sectorPersistIntervalMs: config.sectorPersistIntervalMs,
        });
        service = options.createService({
            clock: options.clock,
            tencent,
            sina,
            repository,
            scheduler,
            stateStore: {
                mutateWatchlist: (mutation) => options.mutateWatchlist(paths, mutation),
            },
            initialState,
            config: {
                providerBatchSize: config.providerBatchSize,
                minuteRetentionTradingDays: config.minuteRetentionTradingDays,
                storageSoftLimitBytes: config.storageSoftLimitBytes,
            },
        });
        return { service, paths, dispose };
    }
    catch (startupError) {
        try {
            await dispose();
        }
        catch (cleanupError) {
            throw new AggregateError([startupError, ...cleanupErrors(cleanupError)], 'market-intelligence startup and rollback failed');
        }
        throw startupError;
    }
}
export function createSharedRequestLimiter(concurrency) {
    return new SharedRequestLimiter(concurrency);
}
function throwCleanupErrors(errors) {
    if (errors.length === 0)
        return;
    if (errors.length === 1)
        throw errors[0];
    throw new AggregateError(errors, 'market-intelligence disposal failed');
}
function cleanupErrors(error) {
    return error instanceof AggregateError ? [...error.errors] : [error];
}
