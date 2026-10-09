# SEN-25 — the leaderboard indexer (Envio HyperIndex)

`services/indexer/` is a standalone Envio HyperIndex that turns **Kuru Spot V2**
fills on Monad testnet (10143) into per-account leaderboard stored fields:
realised PnL, volume, win/loss counts, open position, custody flow, and per-market
daily aggregates with VWAP.

It indexes **Kuru only**. Perpl was indexed until SEN-171 and was taken out
because its event volume does not fit the Envio plan the indexer runs on — see
[§budget](#budget). The handlers have been run **against real chain blocks**
(see [§proven](#proven-live-runs)).

```
services/indexer/
  config.yaml            chain, addresses, event signatures, start_block
  schema.graphql         entities the leaderboard reads
  src/EventHandlers.ts    registry entry point (re-exports the one below)
  src/handlers/kuru.ts    Kuru: fills, AccountCore custody flow and registrations
  src/lib/packed.ts       Kuru's bit-packed TradesPacked decoder
  src/lib/stats.ts        moving-average PnL, quote-atom maths, id helpers
  src/lib/markets.ts      market + daily aggregate writes
  src/lib/common.ts       entity helpers, BigDecimal bridging
  src/lib/accountAddress.ts  account id -> address, read off AccountCore (§addresses)
  src/lib/seeds.ts        market/token tables (mirrored from packages/venues)
  src/lib/*.test.ts       node --test suites (29 tests)
  scripts/verify-config-topics.ts   re-checks every signature against the chain
  scripts/local/live-range.ts       runs the real handlers over real blocks
```

**It is deliberately not a pnpm workspace member** (`pnpm-workspace.yaml`
excludes `services/indexer`). `envio` vendors its own runtime — a tsx loader,
pino, Postgres, viem — and a hoisted workspace install would fight its pinned
toolchain. It has its own `package.json` and lockfile; install with `npm install`
inside it. That exclusion is why root `typecheck`/`lint`/`test` are unaffected by
anything in here, and why `pnpm run check:indexer` exists.

---

## §budget

Envio Cloud's free **Development** plan stops at **100,000 processed events**
and an indexer on it lives **30 days**. The paid plan ($70) stops at 1,000,000.
The first deployment indexed both venues plus Kuru's book and balance events; it
hit the 100k cap within minutes and is scheduled for shutdown.

Event rates on Monad testnet, measured 2026-10-09:

| Source                                    | Rate                     | Indexed? |
| ----------------------------------------- | ------------------------ | -------- |
| PerplExchange, all events                 | ~216,000 / hour          | no       |
| — of which `OrderRequestV2`               | ~211,000 / hour          | no       |
| Kuru AccountCore `SpotReserveUpdated`     | ~29,000 / day            | no       |
| Kuru OrderBook `BookUpdatesPacked`        | ~18,000 / day            | no       |
| Kuru OrderBook `TradesPacked`             | ~2,200 / day             | **yes**  |
| Kuru AccountCore `Deposit` / `Withdrawal` | rare (≤ ~100 / day seen) | **yes**  |
| Kuru AccountCore `AccountRegistered`      | rare                     | **yes**  |

Perpl cannot be narrowed: `OrderRequestV2` has no indexed parameters, so there
is no topic to filter it by, and Perpl's fills cannot be attributed without it
(the taker fill carries no market and no account). One hour of Perpl is twice
the whole free plan, and a week of it is past the paid one. Paying does not fix
it.

`BookUpdatesPacked` (the resting-order feed) and `SpotReserveUpdated` (absolute
free/reserved balances) cost ~47,000 events a day between them, and the
leaderboard reads neither: it ranks on fills and divides by the custody _flow_.
Both were dropped with their entities.

### Sizing `start_block`

The indexer has to stay under 100k from `start_block` until it is retired, which
on a Development-plan deployment made 2026-10-09 is ~2026-11-08.

Kuru's `TradesPacked` is bursty, not steady. Sampled 2026-10-09 by
`eth_getLogs` over 100-block windows spread evenly through each period (100–150
windows each, ~1% of the blocks), against the four OrderBooks and AccountCore:

| Period (2026)   | `TradesPacked` / day |
| --------------- | -------------------- |
| Sep 10 – Sep 15 | ~480                 |
| Sep 15 – Sep 20 | ~1,400               |
| Sep 20 – Sep 25 | ~13,000              |
| Sep 25 – Oct 9  | none seen            |

The previous `start_block`, 61294867 (2026-09-10), would replay that whole
burst — ~75,000 `TradesPacked` before reaching the present — and then add 30 days
of new fills on top: ~140,000 at the ~2,200/day average. It does not fit.

`start_block` is now **67394632, 2026-10-02T00:00:00Z** — 7 days before the
redeploy, the same backfill window the indexer was designed around:

| Part                                          | Events      |
| --------------------------------------------- | ----------- |
| Backfill, Oct 2 – Oct 9 (none seen)           | ~0          |
| `TradesPacked`, Oct 9 – Nov 8 at ~2,200 / day | ~66,000     |
| AccountCore, 37 days at ≤ ~100 / day          | ≤ ~3,700    |
| **Total**                                     | **~70,000** |

That leaves ~30% headroom at the average rate, and much more at the rate seen
in the last two weeks. It does not survive a repeat of the Sep 20–25 burst
lasting more than about two days: ~13,000 fills a day would spend the headroom
on its own. Sente's own agents' Kuru fills count toward the same total. Watch
the deployment's processed-event count; if a burst starts, the fix is to
redeploy with a later `start_block`, not to add events back.

---

## What is indexed

Every signature was checked against the chain, not only against a vendored ABI.
`scripts/verify-config-topics.ts` recomputes each topic0 from the string in
`config.yaml` and greps recent logs for the configured addresses plus a few
documented transactions; a wrong signature matches nothing, and a wrong
`indexed` flag shows up as a topic-count mismatch. Run it after any edit:

```bash
cd services/indexer
mise exec -- npm run verify:topics          # 5 windows of 100 blocks
mise exec -- npm run verify:topics -- 20    # 20 windows
```

Until SEN-171 the script read only double-quoted addresses and signatures, and
`config.yaml` is single-quoted (prettier), so it had been reporting on nothing.
It accepts both now. On 2026-10-09 it verified `TradesPacked`, `Deposit` and
`AccountRegistered` from the documented transactions (recent windows held no
Kuru logs at all).

| Contract         | Event                    | Leaderboard role                  |
| ---------------- | ------------------------ | --------------------------------- |
| KuruOrderBook ×4 | `TradesPacked`           | fills → `Trade` + stats           |
| KuruAccountCore  | `Deposit` / `Withdrawal` | cumulative custody flow (capital) |
| KuruAccountCore  | `AccountRegistered`      | account id → address, owner       |

Kuru addresses are the "Set C" Spot V2 deployment; the source of truth is
`packages/venues/src/kuru/constants.ts` and this file is a copy, because the
indexer cannot import workspace TS.

---

## Entity model

Envio maps a schema relation `market: Market!` to a plain `market_id` column on
the entity, so handlers write `market_id`, not `market`. Derived fields
(`@derivedFrom`) do not exist on the write side at all.

| Entity               | One row per       | Read by the leaderboard as     |
| -------------------- | ----------------- | ------------------------------ |
| `Account`            | Kuru account      | identity + cross-market rollup |
| `AccountMarketStats` | (account, market) | **the leaderboard row**        |
| `AccountBalance`     | (account, token)  | custody flow (ROI denominator) |
| `Trade`              | matched record    | trade tape                     |
| `Market`             | market            | market metadata + rollup       |
| `MarketDay`          | (market, UTC day) | daily series, VWAP             |

Ids are chain- and venue-qualified: `kuru-62`, `kuru-<orderBookAddress>`,
`10143-<block>-<logIndex>-<recordIndex>`. The `Venue` enum and the `kuru-`
prefix stay although Kuru is the only venue, so the API's reads keep their shape.

### §pnl

`AccountMarketStats` carries a signed moving-average cost basis, exact `BigInt`
quote atoms, floored:

- a fill that **adds** to the position extends the basis and realises nothing;
- a fill that **reduces** closes `min(|pos|, |fill|)` at the stored average and
  realises `(price − avgCost) × closed` for a long (mirrored for a short);
- a **flip** consumes the whole old basis and reopens the remainder at the trade
  price;
- `wins`/`losses` count each _reducing_ fill by the sign of the delta it
  produced, so a flip counts once.

**Fees are excluded.** They are recorded on the `Trade` row
(`takerFeeRaw`/`makerFeeRaw`, quote atoms from the pps rates) but are not netted
out of `realizedPnlUsd`.

`boughtBase`/`soldBase`/`baseVolume` are scaled by the **book size unit**
(`decimalsFromPrecision(market.sizePrecision)`), not by the base token's ERC-20
decimals. MON-USDC sizes in 10^8 units while MON is 18-decimal; confusing the two
overstates base volume by 10^10. `Market.baseDecimals` holds the token's real
decimals as display metadata.

### §custody

`AccountBalance` is the cumulative wallet ↔ AccountCore **flow** per token:
`deposited`, `withdrawn`, and `net = deposited − withdrawn`. `net` is not a
balance — fills and fees never touch it — and that is the point: the API's ROI
divides by the capital put in, not by what the account has grown or shrunk to.
The absolute balance (`SpotReserveUpdated`) used to be stored alongside as
`freeRaw`/`reservedRaw`; nothing read it, and it was dropped for §budget.

### §addresses

`Account.address` is what the API joins on — `services/api` asks the indexer
`where: { address: { _in: [<agent wallets>] } }` — so an account without one is
not on the leaderboard at all.

The address used to come **only** from the one-shot `AccountRegistered`, and
`config.yaml` starts 7 days before deployment. An account registered before that
window never emits its registration again, and a Kuru maker seen only as a
record inside somebody else's `TradesPacked` log never had an address in any
event at all. Both were invisible on the board forever. In the §proven run,
both accounts are of this kind.

Two cheaper fixes do not work, and it is worth writing down why:

- **Taking it off the fill events.** `TradesPacked` carries an `executor` —
  whoever submitted the order, an authorised signer rather than the account —
  and the maker leg inside `packedTrades` is a bare `uint40`. A wrong address on
  a leaderboard row is worse than none.
- **An earlier `start_block` for the registration events only.** Envio's
  per-contract `start_block` is documented in `envio/evm.schema.json` as "Can be
  greater than the chain start_block for more specific indexing" — later only.
  Reaching older registrations means moving the whole chain back, and with it
  the §budget.

So `src/lib/accountAddress.ts` resolves the id with
`AccountCore.userAddressById(uint40)` the first time the account is seen,
through an Envio **effect** — deduplicated and cached, so it is one RPC read per
account id ever, not one per fill. It is a contract read, not an event, so it
costs nothing against the event cap.

The call is not in Kuru's docs; it was found by selector and verified against
the live contract — `userAddressById(62)` and `(47)` answer the two accounts of
the §proven fill. `accountAddress.test.ts` pins the exact calldata and the exact
responses, so an ABI drift fails loudly. An unknown id answers the zero address,
which is stored as **no address**, never as `0x000…0` (that would match an
agent's wallet exactly as badly as a wrong one). A revert is read the same way;
a transport failure throws, so Envio retries instead of caching a null.

`ENVIO_MONAD_RPC_URL` overrides the RPC these reads go to (default:
`https://testnet-rpc.monad.xyz`, the same fallback `config.yaml` names).
`AccountRegistered` is still indexed and still authoritative when it lands
inside the window — it also carries `owner`, which the read does not give.

### Perpl, before SEN-171

The Perpl handlers attributed fills across three events in one transaction
(`OrderRequestV2` → `MakerOrderFilledV2` → `TakerOrderFilledV2`, by log order),
and their research — the zero-based `OrderDescEnum`, the verified attribution
against tx `0xd58c92ad…070`, why `PositionDecreased.deltaPnlCNS` is the
authoritative PnL — is in this file and in `services/indexer/src/lib/perpl.ts`
at commit `cf4b191`, the last one before they were removed. Re-adding Perpl
needs a plan with a per-hour event allowance far above anything Envio's tiers
offered on 2026-10-09; see §budget.

On the leaderboard, an agent's Perpl record now comes from its own event log,
not from the chain — see `docs/leaderboard.md`.

---

## GraphQL for the leaderboard

Envio serves the schema through Hasura, so the auto-generated `<Entity>` /
`<Entity>_by_pk` roots and `_eq` / `_order_by` / `limit` arguments are
available. `services/api` reads `Account` and its `balances` (the query is in
`services/api/src/agents/leaderboard/indexer.ts`). The others below are written
against the generated schema and have not been executed against a live endpoint.

```graphql
# Top accounts by realised PnL on the stored rollup.
query Leaderboard {
  Account(order_by: [{ realizedPnlUsd: desc_nulls_last }], limit: 50) {
    id
    venue
    address
    accountId
    totalTradeCount
    totalVolumeUsd
    realizedPnlUsd
    winningTradeCount
    losingTradeCount
  }
}

# Per-market leaderboard.
query MarketLeaderboard($marketId: String!, $limit: Int!) {
  AccountMarketStats(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ realizedPnlUsd: desc_nulls_last }]
    limit: $limit
  ) {
    id
    account {
      id
      address
      venue
    }
    market {
      id
      symbol
      venue
      base
      quote
    }
    n
    takerN
    makerN
    volumeUsd
    boughtBase
    soldBase
    realizedPnlUsd
    wins
    losses
    openBaseRaw
    openCostRaw
    firstTradeBlock
    lastTradeBlock
  }
}

# Trade tape for a market, newest first.
query Trades($marketId: String!, $limit: Int!) {
  Trade(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ blockNumber: desc }, { logIndex: desc }, { id: desc }]
    limit: $limit
  ) {
    id
    venue
    side
    rawPrice
    rawSize
    price
    notionalUsd
    takerFeeRaw
    makerFeeRaw
    blockNumber
    timestamp
    txHash
    logIndex
    taker {
      id
      address
    }
    maker {
      id
      address
    }
  }
}

# Daily series for a market (volume, VWAP range, who traded).
query MarketDays($marketId: String!) {
  MarketDay(where: { market_id: { _eq: $marketId } }, order_by: [{ day: desc }]) {
    id
    day
    date
    tradeCount
    buyCount
    sellCount
    volumeUsd
    baseVolume
    highPrice
    lowPrice
    vwapPrice
    activeAccountIds
  }
}

# Market directory, with rollups.
query Markets {
  Market(order_by: [{ symbol: asc }]) {
    id
    venue
    symbol
    base
    quote
    pricePrecision
    sizePrecision
    baseDecimals
    quoteDecimals
    address
    tradeCount
    volumeUsd
    latestTradeBlock
  }
}

# One account: everything the profile screen needs.
query AccountProfile($accountId: String!) {
  Account_by_pk(id: $accountId) {
    id
    venue
    address
    owner
    accountId
    firstSeenBlock
    firstSeenAt
    totalTradeCount
    totalVolumeUsd
    realizedPnlUsd
    winningTradeCount
    losingTradeCount
    marketStats {
      id
      market {
        id
        symbol
      }
      volumeUsd
      realizedPnlUsd
      wins
      losses
      openBaseRaw
    }
    balances {
      id
      token
      decimals
      deposited
      withdrawn
      net
      lastUpdatedBlock
    }
  }
}
```

Hasura also exposes `<table>_aggregate { aggregate { count sum avg max min } }`
per table, and a `_meta` root (`{ _meta { chainMetadata { chainId } } }`) that is
the cheapest liveness check for a deployment.

---

## Run locally

From `services/indexer`. Node ≥ 22 and a running Postgres are required; the
upstream runtime resolves its own toolchain, so run it with `npm`, not the root
workspace.

```bash
cd services/indexer
mise exec -- npm install                 # its own lockfile, not the workspace one
mise exec -- npm run codegen             # regenerates .envio/ from config + schema
mise exec -- npm test                    # 29 unit tests, no network
mise exec -- npm run typecheck           # codegen, then tsc -p tsconfig.json --noEmit
mise exec -- npm run verify:topics       # config.yaml vs the chain
```

`typecheck` runs `codegen` first on purpose. `.envio/` is gitignored, and
without it `envio`'s types degrade to a "Run `envio codegen`" placeholder that
fails every handler registration — so on a fresh clone a bare `tsc` reports
dozens of errors that say nothing about the code. Running codegen first makes
the typecheck mean what it says.

The whole thing from the repo root, which is what CI and a fresh clone want:

```bash
mise exec -- pnpm run check:indexer      # npm ci + codegen + typecheck + tests
```

That script exists because `pnpm-workspace.yaml` excludes `services/indexer`, so
the root `typecheck`/`lint`/`test` walk straight past it.

Then the environment. `ENVIO_PG_*` selects the database (defaults shown):

```bash
export ENVIO_PG_HOST=localhost ENVIO_PG_PORT=5432
export ENVIO_PG_USER=envio ENVIO_PG_PASSWORD=... ENVIO_PG_DATABASE=envio
```

```bash
mise exec -- npx envio local docker up   # Postgres
mise exec -- npx envio dev               # indexer + Hasura GraphQL, hot reload
# GraphQL playground: http://localhost:8080
mise exec -- npx envio stop              # stop, delete the local database
```

`envio dev` runs `codegen` first, so `config.yaml`/`schema.graphql` edits are
picked up without a separate step.

### §hypersync

HyperSync needs `ENVIO_API_TOKEN`. Without one, Envio still builds the HyperSync
source eagerly and `requireApiToken` throws before anything runs:

```
Error: An Envio API token is required for using HyperSync as a data-source.
Set the ENVIO_API_TOKEN environment variable in your .env file.
```

Any non-empty value gets past that check; HyperSync then answers `401`, and
`EvmChain.makeSources` falls back to the RPC sources configured in
`config.yaml`, logging a burst of

```
ERROR hypersync_client] failed to get arrow data from server, retrying...
  The error was: http response status code 401 Unauthorized
```

before it **indexes the blocks anyway** — which is how the run in §proven was
produced. Monad's public RPC caps `eth_getLogs` at 100 blocks
(`docs/monad-testnet-assets.md`), so the fallback is fine for spot checks and far
too slow for the 7-day backfill. A real sync needs a real token.

To point the indexer at a different RPC, set `VERIFY_RPC` for the verify script
and the `rpc:` entry in `config.yaml` for the indexer.

---

## Proven live runs

Run with the real handlers over real blocks, in memory, via Envio's
`createTestIndexer()` — no Postgres, no account:

```bash
# services/indexer/scripts/local/live-range.ts <startBlock> [endBlock]
mise exec -- node --experimental-strip-types \
  --no-warnings scripts/local/live-range.ts 61406913
```

The script is **committed** (the rest of `scripts/local/` is gitignored scratch),
because a documented run nobody can re-run is a claim rather than evidence. It
fills `ENVIO_API_TOKEN` in itself — see §hypersync — and `endBlock` defaults to
`startBlock`: one block, a few seconds, diffable against the explorer by hand.

The test indexer refuses a block before `start_block`, and this fill is older
than the current one, so re-running it means lowering `start_block` locally (and
running `npm run codegen`), then putting both back.

**Kuru** — block 61406913, tx `0x9d7fbce1…`, the fill documented in
`docs/kuru.md` ("placeMarket 388 MON → 317.737 filled"). Verbatim, re-run
2026-10-09 on the Kuru-only handlers:

```
Trade=1 AccountMarketStats=2 Account=2 Market=4 MarketDay=1 AccountBalance=0
  trade 10143-61406913-9-0 KURU kuru-0xfdbe…ef61 BUY rawPrice=30974
        rawSize=31773742494 price=0.030974 notional=9.841599 taker=kuru-62 maker=kuru-47
  stats kuru-62-kuru-0xfdbe…ef61 n=1 takerN=1 makerN=0 vol=9.841599
        open=31773742494/9841599
  stats kuru-47-kuru-0xfdbe…ef61 n=1 takerN=0 makerN=1 vol=9.841599
        open=-31773742494/-9841599
  account kuru-62 KURU address=0x15bbc549326dd8d053233c3a546aa7fdabb57256
  account kuru-47 KURU address=0x74443181214751970a785f5675bd372735245c9e
  day kuru-0xfdbe…ef61-20260910 trades=1 volumeUsd=9.841599
        baseVolume=317.73742494 vwap=0.030973999999711838
```

Price 0.030974 and $9.841599 match the on-chain fill exactly, and the two legs
are mirrored. The fill rows are identical to the 2026-09-18 run with every event
indexed. What changed is what SEN-171 removed: that run also had `Account=3`
and `AccountBalance=5`, both written by the `SpotReserveUpdated` logs in the
same transaction.

Two numbers in that output are the SEN-34 fixes:

- **`vwap=0.03097399…`** is the fill's own price, as a one-fill day must be.
  Until SEN-34 it read `0.009867`: `MarketDay.vwapPrice` was
  `volumeUsd.div(baseVolume, 18)`, and bignumber.js reads `div`'s second
  argument as the numeric **base** of the operands, not as a decimal-place
  count. It is now `div(baseVolume).decimalPlaces(18)`, pinned in
  `markets.test.ts` against exactly these numbers.
- **`address=…` on both accounts**, which were `NULL` before. Neither registered
  inside the indexed window; see §addresses.

---

## Deploy to Envio Cloud

Cloud deployment is Git-based plus a separate `envio-cloud` CLI (`envio deploy`
does not exist in `envio` 3.12.0): install the Envio Deployments GitHub App,
register the indexer against this repository with the right root directory and
config path, and push to the deployment branch.

```bash
cd services/indexer
npx envio-cloud login                       # browser; or ENVIO_GITHUB_TOKEN + login --token

# --root-dir has to point at services/indexer: the config is not at the repo root.
npx envio-cloud indexer add \
  --name sente-leaderboard \
  --repo <owner>/<repo> \
  --branch <branch> \
  --root-dir services/indexer \
  --config-file config.yaml \
  --tier development \
  --dry-run                                  # drop --dry-run to create it

npx envio-cloud indexer env set sente-leaderboard <org> ENVIO_API_TOKEN=...   # required
npx envio-cloud indexer commits sente-leaderboard <org>      # watch builds land
npx envio-cloud deployment status sente-leaderboard <commit> <org> --watch-till-synced
npx envio-cloud deployment promote sente-leaderboard <commit> <org>
npx envio-cloud deployment endpoint sente-leaderboard <commit> <org>   # GraphQL URL
```

`ENVIO_API_TOKEN` must be set on the deployment (all env keys are `ENVIO_`-
prefixed) or the Cloud build hits the §hypersync error. `--branch` must be the
branch that actually carries the indexer: a Cloud indexer pointed at a branch
that no longer receives commits looks healthy and silently stops updating.

The first deployment (2026-10-09) ran the pre-SEN-171 config on the Development
tier and hit its 100k-event cap within minutes (§budget). The Kuru-only config
needs a fresh deployment, and the 30-day clock starts again with it.

---

## Verification

| Check                       | Command                               | State                                    |
| --------------------------- | ------------------------------------- | ---------------------------------------- |
| Unit tests (29)             | `mise exec -- npm test`               | pass                                     |
| Indexer typecheck           | `mise exec -- npm run typecheck`      | pass                                     |
| Config vs chain             | `mise exec -- npm run verify:topics`  | pass (`Withdrawal` unobserved, below)    |
| Real blocks → real entities | `scripts/local/live-range.ts <block>` | pass (2026-10-09, Kuru)                  |
| The indexer, from the root  | `mise exec -- pnpm run check:indexer` | pass                                     |
| Live GraphQL query          | `envio dev` + Hasura on :8080         | **not run**                              |
| Envio Cloud, Kuru-only      | `envio-cloud …`                       | **not deployed** (first one hit the cap) |

## Open work

1. **Redeploy** the Kuru-only config and watch its processed-event count
   against §budget.
2. **Prove the GraphQL queries** above against a live Hasura.
3. **Kuru `Withdrawal` has never been observed on chain** in the windows
   scanned. Its signature comes straight from the SDK ABI and its topic-count
   check is the same shape as `Deposit`, which _was_ observed — but it is
   verified by argument, not by a log.
4. **Fee accounting** — fees are recorded but not applied to
   `realizedPnlUsd` (§pnl).
