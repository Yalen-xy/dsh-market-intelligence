import type { Market } from './model.js';
export type CanonicalSymbol = {
    symbol: string;
    market: Market;
    currency: 'CNY' | 'HKD';
};
export declare const SUPPORTED_INDICES: {
    readonly SSE: "sh000001";
    readonly SZSE: "sz399001";
    readonly CSI300: "sh000300";
    readonly HSI: "hkHSI";
    readonly HSTECH: "hkHSTECH";
};
export declare function canonicalizeSymbol(input: string): CanonicalSymbol;
