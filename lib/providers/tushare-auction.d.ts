import type { RequestLimiter } from '../http.js';
import type { AuctionSettlement } from '../model.js';
export type TushareAuctionOptions = {
    token: string;
    now?: () => Date;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    requestLimiter?: RequestLimiter;
};
export declare class TushareAuctionProvider {
    private readonly token;
    private readonly now;
    private readonly fetchImpl;
    private readonly timeoutMs;
    private readonly requestLimiter?;
    constructor(options: TushareAuctionOptions);
    fetch(symbols: string[], tradingDate: string, signal: AbortSignal): Promise<AuctionSettlement[]>;
}
