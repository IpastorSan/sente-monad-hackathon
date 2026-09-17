# Nansen smart-money signals (SEN-29)

The agents' `smart_money_signals` read tool: what it calls, which data it uses,
and how it stays inside the free API plan.

Why: an agent that only sees its own venue book trades blind. Nansen's Smart
Money cohort — institutional funds and historically profitable traders — is a
_decision input_: when smart wallets are accumulating the token behind a market
on mainnet, that is context for what the agent does on testnet.

## What Nansen covers for us

- **Chain: `monad` (mainnet) only.** Nansen has indexed Monad since **14 May
  2025** and has no testnet coverage. Our agents trade Kuru/Perpl **testnet**
  (chain 10143), so this data describes the real market and is used as context
  for testnet trades — never as a mirror of the venue book. The tool result
  carries `network: "mainnet"` and a `reading` line saying exactly that.
- Smart Money **Netflow** and **DEX Trades** both support `monad` (verified
  against `docs.nansen.ai/reference/chains.md`). Netflow keeps a rolling 30
  days; DEX Trades is the trailing 24 hours with no date parameter.
- Tokens: the bases behind our markets, mapped to their mainnet proxies —
  `MON` (native), `WETH`, `cbBTC` (our BTC exposure), `XAUt` (gold). The
  mapping lives in `tokenForMarket` in `services/api/src/agents/tools/nansen.ts`.
  A perp symbol like `BTC-PERP` reads its base and maps to cbBTC.

## Endpoints

Base `https://api.nansen.ai`, auth header `apikey: <NANSEN_API_KEY>`, JSON POST
bodies. Client: `services/api/src/agents/tools/nansen.ts` (`NansenClient`).

### `POST /api/v1/smart-money/netflow`

Aggregated smart-money inflow minus outflow per token (DEX trades + CEX
transfers), over rolling 1 h / 24 h / 7 d / 30 d windows ending at request
time. We send:

```json
{
  "chains": ["monad"],
  "filters": { "token_address": "MON", "include_native_tokens": true },
  "pagination": { "page": 1, "per_page": 100 }
}
```

`token_address` accepts a symbol. `include_native_tokens` matters for MON
(netflow hides native tokens otherwise). Read per row: `net_flow_24h_usd`
(direction + size), `net_flow_1h_usd` (is it moving now), `trader_count` (how
many smart wallets traded it in 30 d).

### `POST /api/v1/smart-money/dex-trades`

Trade-level smart-money DEX activity, trailing 24 h only. We send:

```json
{
  "chains": ["monad"],
  "pagination": { "page": 1, "per_page": 200 },
  "order_by": [{ "field": "trade_value_usd", "direction": "DESC" }]
}
```

Nansen has no OR-filter across bought/sold tokens, so we take the biggest 200
Monad trades and match our token client-side; `pageTruncated: true` in the
summary says the 24 h held more than the page. Each matched trade counts as a
buy (token was bought) or a sell, with its USD value and trader address.

## The tool's answer

`smart_money_signals { market }` returns one compact summary, never raw rows:

```json
{
  "status": "ok",
  "market": "MON-USDC",
  "token": "MON",
  "chain": "monad",
  "network": "mainnet",
  "flow24h": {
    "netUsd": 45000,
    "net1hUsd": 1200,
    "direction": "accumulating", // |net| ≤ $1k reads as "flat"
    "smartMoneyWallets": 87
  },
  "dexTrades24h": {
    "buys": 12,
    "sells": 4,
    "buyUsd": 30000.0,
    "sellUsd": 5000.0,
    "wallets": 9,
    "pageTruncated": false
  }
}
```

Other statuses, each a real answer rather than a failure:

- `not_configured` — no `NANSEN_API_KEY`. The run continues on venue data.
- `unavailable` — upstream 4xx/5xx or network error; `partial` names the
  endpoint that failed. The message tells the model not to retry more than once.
- `no_data` — Nansen has neither a netflow row nor a matched trade for the
  token: no smart-money activity in the window, which is itself information.

The runner's snapshot includes it for the first mandate-allowed market when the
key is set (`agent-runner.service.ts`), so every run sees smart-money context
even if the model never thinks to call the tool.

## Credits — the budget that shaped the client

The free plan is **100 credits, then ~10 a day** (each endpoint call costs at
least one). With two endpoints per tool call, an uncached agent run could spend
the daily budget in a handful of calls. So `NansenClient`:

- caches every response — **successes and failures alike** — for **10 minutes**
  per endpoint+body (`NANSEN_CACHE_TTL_MS`); a dead key never burns a credit on
  every tool call the model makes;
- dedupes concurrent identical calls through an in-flight map: two tools
  running in parallel cost one request per endpoint;
- is a process-wide singleton (`registry.ts`), built on first use, so the cache
  outlives a single run and reads `NANSEN_API_KEY` after the environment is
  loaded;
- caps pages small (netflow 100, trades 200) and adds no pagination loops.

One call to one market costs exactly two credits; repeats inside ten minutes
cost zero.

## Specs

`services/api/src/agents/tools/nansen.spec.ts` runs against a fake `fetch`
(same style as `privy.client.spec.ts`): header + chain on the wire, the 10-min
cache and its expiry, cached failures, concurrent dedupe, `not_configured`
with no key and no network, the summary shape (direction, wallets, buys vs
sells), and that the key never appears in a result.
