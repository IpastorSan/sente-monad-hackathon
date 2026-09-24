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
- Tokens: the bases behind our markets, mapped to their mainnet proxies by
  **contract address**, not by name (SEN-49). The mapping lives in
  `tokenForMarket` in `services/api/src/agents/tools/nansen.ts`. A perp symbol
  like `BTC-PERP` reads its base and maps to cbBTC.

  | Base(s)        | Token | Monad mainnet address (lowercase)            |
  | -------------- | ----- | -------------------------------------------- |
  | `MON`          | MON   | `0x0000…0000` (native) and WMON below        |
  | `WMON`         | WMON  | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
  | `WETH`, `ETH`  | WETH  | `0xee8c0e9f1bffb4eb878d8f15f368a02a35481242` |
  | `cbBTC`, `BTC` | cbBTC | `0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b` |
  | `XAUt`, `PAXG` | XAUt0 | `0x01bff41798a0bcf287b996046ca68b395dbc1071` |

  **Source for every address:** the official Monad token list,
  `github.com/monad-crypto/token-list`, `tokenlist-mainnet.json` at commit
  `20779d2ccf0e5d305d3790a21dcef4cb73342c60` (2026-09-21), cross-checked on
  `monadscan.com/token/<address>`. Monad's gold token is **XAUt0** (a LayerZero
  OFT), not plain XAUt — there is no `XAUt` contract on Monad. Addresses are
  stored lowercase because that is how Nansen returns them. A base we have no
  address for is matched by symbol instead, and the result says
  `matchedBy: "symbol"` so the model knows the match is weaker.

## Endpoints

Base `https://api.nansen.ai`, auth header `apikey: <NANSEN_API_KEY>`, JSON POST
bodies. Client: `services/api/src/agents/tools/nansen.ts` (`NansenClient`).

### `POST /api/v1/smart-money/netflow`

Aggregated smart-money inflow minus outflow per token (DEX trades + CEX
transfers), over rolling 1 h / 24 h / 7 d / 30 d windows ending at request
time. We send **no token filter at all**:

```json
{
  "chains": ["monad"],
  "filters": { "include_native_tokens": true, "include_stablecoins": true },
  "pagination": { "page": 1, "per_page": 100 }
}
```

Read per row: `token_address` (lowercase — this is what we match on),
`token_symbol`, `net_flow_24h_usd` (direction + size), `net_flow_1h_usd` (is it
moving now), `trader_count` (how many smart wallets traded it in 30 d). Both
`include_*` flags default to `false`, so both are set: MON is native, and a
stablecoin-based market must still be matchable.

#### `filters.token_address` does not work — measured, not assumed (SEN-49)

SEN-29 shipped with `token_address: token.symbol` and a comment claiming the
filter "accepts a token symbol". It had only ever been run against our own
fake. Against the live API, with a real key, on **2026-09-24**:

| Request `filters`                                                        | chain      | Live result                                    |
| ------------------------------------------------------------------------ | ---------- | ---------------------------------------------- |
| `{"token_address":"MON","include_native_tokens":true}`                   | `monad`    | **HTTP 422** `Invalid address format: MON`     |
| `{"include_native_tokens":true,"include_stablecoins":true}`              | `monad`    | HTTP 200, `data: []` (Monad has no rows today) |
| `{"include_native_tokens":true,"include_stablecoins":true}`              | `ethereum` | HTTP 200, **rows** — WETH at `0xc02aaa39…cc2`  |
| `{"token_address":"0xC02aaA39…756Cc2"}` (checksummed)                    | `ethereum` | HTTP 200, `data: []`                           |
| `{"token_address":"0xc02aaa39…756cc2"}` (lowercase, exactly as returned) | `ethereum` | HTTP 200, `data: []`                           |
| `{"token_address":["0xc02aaa39…756cc2"]}` (the documented array form)    | `ethereum` | HTTP 200, `data: []`                           |

So the live contract is:

- **It is an address field, not a symbol field.** The docs
  (`docs.nansen.ai/api/smart-money/netflows`) describe it as "Token address or
  symbol filter"; the server rejects a symbol with a 422. The docs are wrong.
- **And an address does not work either.** The endpoint returns WETH at
  `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` when unfiltered, and returns
  nothing when asked for exactly that address — string or array, either case.
  It validates the format and then matches nothing, **silently, with a 200**.

Hence: no token filter, one page per chain, match client-side on the address.
Two consequences, both in our favour:

- the netflow body no longer depends on the market, so every market shares one
  cache entry — **netflow costs one credit per 10 minutes in total**, not one
  per market;
- matching on address rather than symbol cannot be fooled by a same-named
  impostor token, which is exactly what a smart-money read must not be.

**Nansen's Monad coverage is all but empty right now, and that is the honest
answer.** Measured 2026-09-24:

- an unfiltered `monad` netflow page, natives and stablecoins included, returns
  `data: []` with `is_last_page: true` — zero smart-money netflow rows for the
  whole chain;
- the trailing-24 h `monad` dex-trades page returns **one** trade, between AUSD
  (`0x00000000efe302beaa2b3e6e1b18d08d69a9012a`) and DUST
  (`0xad96c3dffcd6374294e2573a7fbba96097cc8d7c`).

So `MON-USDC` and `BTC-PERP` both come back `no_data` today. That is a real
absence of smart-money activity, not a failure, and the tool must not dress it
up as one. Do not "fix" a `no_data` by loosening the matching — check the raw
page first.

That one trade is also a useful cross-check on the whole scheme: the AUSD
address Nansen returns is exactly the mainnet AUSD already recorded in
`docs/monad-testnet-assets.md`, lowercase, so Nansen and the Monad token list
agree on address form and our client-side matching is comparing the right
things.

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
Monad trades and match our token client-side — on `token_bought_address` /
`token_sold_address`, same rule as netflow. `pageTruncated: true` in the summary
says the 24 h held more than the page. Each matched trade counts as a buy (token
was bought) or a sell, with its USD value and trader address.

## The tool's answer

`smart_money_signals { market }` returns one compact summary, never raw rows:

```json
{
  "status": "ok",
  "market": "MON-USDC",
  "token": "MON",
  "chain": "monad",
  "network": "mainnet",
  "matchedBy": "address", // "symbol" for a base we have no verified address for
  "degraded": null, // set when one endpoint failed and the other still answered
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
- `unavailable` — **both** endpoints failed, or the one that failed left the
  other with nothing to report; `partial` names it. The message tells the model
  not to retry more than once.
- `ok` with `degraded` — one endpoint failed, the other carried a real signal.
  Its half of the summary (`flow24h` or `dexTrades24h`) is `null` and
  `degraded.endpoint` names the endpoint that failed (SEN-49: discarding a good
  dex-trades read because netflow 422'd threw away the only usable half).
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

One uncached call costs exactly two credits — **for all markets at once**,
since SEN-49 made both request bodies market-independent. Repeats inside ten
minutes cost zero.

### What the SEN-49 verification run cost

**10 credits in total**, on 2026-09-24, against a hard budget of 10. No loops,
no retries, and the spec suite was never pointed at the live API.

| Calls | Cost | What it bought                                                           |
| ----- | ---- | ------------------------------------------------------------------------ |
| 1     | 2    | the original bug report: `MON-USDC` → `422 Invalid address format: MON`  |
| 5     | 5    | the `token_address` table above — the whole filter contract              |
| 1     | 2    | end-to-end `fetchSmartMoneySignals` after the fix: `no_data`, no 422     |
| 1     | 1    | the `monad` dex-trades page, to check our addresses against Nansen's own |

The five probes were single-endpoint `curl`-equivalents, not tool calls, which
is why they cost one credit each rather than two: one unfiltered `monad`
netflow page, one `ethereum` netflow with a checksummed WETH address, one
unfiltered `ethereum` page (the one that produced the evidence), and two more
`ethereum` netflows re-asking for the address it had just returned — lowercase,
then as an array.

**If you need to verify Nansen again, budget on paper first.** One tool call is
two credits, the plan allows 100 then ~10 a day, and a burnt quota costs a demo.

## Specs

`services/api/src/agents/tools/nansen.spec.ts` runs against a fake `fetch`
— **never against the live API**, which would spend credits per assertion. It
(same style as `privy.client.spec.ts`): header + chain on the wire, the 10-min
cache and its expiry, cached failures, concurrent dedupe, `not_configured`
with no key and no network, the summary shape (direction, wallets, buys vs
sells), and that the key never appears in a result.

Three of them exist because of SEN-49 and are the ones that would have caught
it:

- the netflow request body must be exactly
  `{"include_native_tokens":true,"include_stablecoins":true}`, and **no
  `*_address` field on any request may hold anything but `/^0x[0-9a-f]{40}$/`** —
  a symbol there fails the spec;
- every mapped base must carry at least one lowercase `0x…` address;
- a row whose `token_symbol` says `MON` but whose `token_address` is some other
  contract is **not** our token — it reads as `no_data`, not as a signal.
