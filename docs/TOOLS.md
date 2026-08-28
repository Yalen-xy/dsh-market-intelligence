# Tool reference

All tools use closed JSON-object schemas. Unknown parameters are rejected. Successful results contain only plain lossless JSON values; unavailable data is represented explicitly instead of being fabricated.

## `market_status`

Reports CN/HK trading phase, collection activity, trading date, next phase transition, and calendar confidence.

```json
{ "market": "CN" }
```

`market` is optional. Omit it to query both markets.

## `market_quotes`

Returns normalized current or cached snapshots for explicit symbols, the local watchlist, or the five fixed indices when neither is supplied.

```json
{
  "symbols": ["sh000001", "hkHSI", "hkHSTECH"],
  "refresh": true
}
```

At most 100 explicit symbols are accepted. The result distinguishes `live`, `cached`, `stale`, and `unavailable` states and reports comparable cross-source conflicts without merging incompatible records.

## `market_series`

Returns one symbol's minute, day, week, or month series from validated provider data and local storage.

```json
{
  "symbol": "sh600000",
  "interval": "day",
  "adjustment": "qfq",
  "limit": 120
}
```

Optional start/end timestamps must be explicit ISO timestamps. `adjustment` is supported only where the provider has an explicit adjusted-data capability.

## `market_sectors`

Returns Sina industry or concept observations with deterministic sorting.

```json
{
  "category": "industry",
  "sort": "changePercent",
  "direction": "desc",
  "limit": 20
}
```

Unpublished upstream fields remain `null`. Malformed rows are rejected instead of shifted into the wrong field.

## `market_auction`

Returns CN call-auction or HK pre-open observations for symbols in the requested market.

```json
{
  "market": "HK",
  "symbols": ["hk00700"]
}
```

Outside an auction/pre-open phase the tool returns a successful domain result with an empty `items` array and an explanatory reason.

## `market_watchlist`

Reads or atomically changes the plugin's local A/H watchlist.

```json
{ "action": "get" }
```

```json
{ "action": "add", "symbol": "700.HK" }
```

```json
{ "action": "remove", "symbol": "hk00700" }
```

The watchlist is capped at 100 canonical securities across CN and HK. Fixed indices do not consume watchlist entries.

## `market_data_health`

Reports provider attempts and availability, scheduler state, database counts and size, retention status, maintenance results, and collection gaps.

```json
{}
```

Use this tool before relying on quotes, sectors, or historical coverage. A gap represents missing collection, not zero trading activity.

## Supported symbol examples

| Input | Canonical result |
| --- | --- |
| `600000.SH` | `sh600000` |
| `000001.SZ` | `sz000001` |
| `700.HK` | `hk00700` |
| `sh000001` | `sh000001` |
| `hkHSI` | `hkHSI` |
| `hkHSTECH` | `hkHSTECH` |

The fixed index set is defined in `src/symbols.ts` and currently covers the Shanghai Composite, Shenzhen Component, CSI 300, Hang Seng Index, and Hang Seng TECH Index.
