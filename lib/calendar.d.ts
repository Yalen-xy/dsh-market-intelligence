import type { Market, MarketPhase } from './model.js';
export type MarketClosures = Record<string, {
    CN: string[];
    HK: string[];
}>;
export type CalendarConfidence = 'configured' | 'degraded';
export type MarketSession = {
    phase: MarketPhase;
    calendarConfidence: CalendarConfidence;
    tradingDate: string;
    active: boolean;
};
export type MarketState = Record<Market, MarketSession>;
export declare function marketState(now: Date, closures: MarketClosures): MarketState;
export declare function isActivePhase(phase: MarketPhase): boolean;
export declare function shanghaiMinuteOfDay(now: Date): number;
export declare function shanghaiDate(timestamp: string | Date): string;
export declare function isMarketTradingDate(tradingDate: string, market: Market, closures: MarketClosures): boolean;
export declare function nextStateChange(now: Date, market: Market, closures: MarketClosures): Date;
export declare function lastClosedTradingDate(now: Date, market: Market, closures: MarketClosures): string;
