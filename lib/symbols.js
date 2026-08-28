export const SUPPORTED_INDICES = {
    SSE: 'sh000001',
    SZSE: 'sz399001',
    CSI300: 'sh000300',
    HSI: 'hkHSI',
    HSTECH: 'hkHSTECH',
};
export function canonicalizeSymbol(input) {
    const value = input.trim();
    const prefixed = /^(sh|sz|hk)(.+)$/i.exec(value);
    if (prefixed) {
        return canonicalizePrefixed(prefixed[1].toLowerCase(), prefixed[2]);
    }
    const hongKongSuffix = /^(\d{1,5})\.hk$/i.exec(value);
    if (hongKongSuffix) {
        return hongKongSymbol(hongKongSuffix[1]);
    }
    if (/^\d{5}$/.test(value)) {
        return { symbol: `hk${value}`, market: 'HK', currency: 'HKD' };
    }
    if (/^(60|68|51)\d{4}$/.test(value)) {
        return { symbol: `sh${value}`, market: 'CN', currency: 'CNY' };
    }
    if (/^(00|30|39)\d{4}$/.test(value)) {
        return { symbol: `sz${value}`, market: 'CN', currency: 'CNY' };
    }
    throw new Error(`Unsupported symbol: ${input}`);
}
function canonicalizePrefixed(prefix, value) {
    if ((prefix === 'sh' || prefix === 'sz') && /^\d{6}$/.test(value)) {
        return { symbol: `${prefix}${value}`, market: 'CN', currency: 'CNY' };
    }
    if (prefix === 'hk') {
        if (/^\d{1,5}$/.test(value))
            return hongKongSymbol(value);
        const namedIndex = Object.values(SUPPORTED_INDICES).find((index) => index.toLowerCase() === `hk${value}`.toLowerCase());
        if (namedIndex)
            return { symbol: namedIndex, market: 'HK', currency: 'HKD' };
    }
    throw new Error(`Unsupported symbol: ${prefix}${value}`);
}
function hongKongSymbol(value) {
    return { symbol: `hk${value.padStart(5, '0')}`, market: 'HK', currency: 'HKD' };
}
