export type FixedRequest = {
    url: URL;
    timeoutMs: number;
    maxBytes: number;
    referer?: 'https://finance.sina.com.cn/';
};
export type TimeoutSignalFactory = (timeoutMs: number) => AbortSignal;
export interface RequestLimiter {
    run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export declare class SharedRequestLimiter implements RequestLimiter {
    private readonly limit;
    private readonly lifecycle;
    private readonly queue;
    private readonly idleWaiters;
    private active;
    private disposal;
    constructor(limit: number);
    run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    private execute;
    dispose(): Promise<void>;
    private acquire;
    private release;
    private startQueuedWork;
}
export declare function fixedGet(request: FixedRequest, fetchImpl: typeof fetch, signal: AbortSignal, timeoutSignal?: TimeoutSignalFactory): Promise<Uint8Array>;
