# Tushare auction result threat review

## Scope and authorization

The user requested adding the 09:25 opening auction result after the Tushare `stk_auction` source and its separate permission requirement were described. This review covers that optional, read-only market-data request. It does not authorize broker access, account data, order placement, or other credential-bearing providers.

## Data and trust boundaries

- `TUSHARE_TOKEN` is read from the DSH or Claude host process environment at plugin startup. It is never accepted through a model-visible tool argument, local config file, or plugin configuration.
- The token is sent only in a JSON POST body to the fixed HTTPS endpoint `https://api.tushare.pro/`, with `api_name` fixed to `stk_auction` and `trade_date` derived from the local Asia/Shanghai trading date. Callers can select up to 100 canonical A-share symbols; they cannot select a host, route, header, or API name.
- Redirects are rejected, credentials/cookies are omitted, calls share the global provider concurrency limit, the request has a timeout, and the response is limited to 4 MiB and 8,000 rows.
- Provider messages and response bodies are not copied into errors, health output, or tool output. Parsing rejects malformed rows and invalid finite-number fields. Only the requested symbols' normalized results are stored in SQLite.
- Without a token, the provider is not constructed and the existing `market_auction` output stays unchanged. Without API permission or usable data, `settlement` reports unavailable; no synthetic result is generated. The two host adapters keep separate SQLite databases.

## Residual risks and verification

The user's process environment and Tushare account security govern token confidentiality. Tushare availability, field stability, and redistribution rights are external dependencies. The implementation has offline provider, repository, service, and tool tests; a live credentialed request was not made because no user token was supplied.
