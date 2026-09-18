# SEN-25 — the leaderboard indexer (Envio HyperIndex)

`services/indexer/` is a standalone Envio HyperIndex that turns Monad testnet
(10143) fills from **Kuru Spot V2** and **Perpl** into per-account leaderboard
stored fields: realised PnL, volume, win/loss counts, open position, custody.

It is a real, working indexer. Both venues have been run **against real chain
blocks with the real handlers** (see [§proven](#proven-live-runs)); what is
outstanding is deployment, not correctness.

```
services/indexer/
  config.yaml            chains, addresses, event signatures
  schema.graphql         entities the leaderboard reads
  src/EventHandlers.ts    registry entry point (re-exports the two below)
  src/handlers/kuru.ts    Kuru: fills, book updates, AccountCore custody
  src/handlers/perpl.ts   Perpl: fills, accounts, collateral, listings
  src/lib/packed.ts       Kuru's bit-packed log decoder
  src/lib/stats.ts        FIFO/moving-average PnL, quote-atom maths, id helpers
  src/lib/perpl.ts        Perpl side mapping + tx-scoped attribution rules
  src/lib/markets.ts      market + daily aggregate writes
  src/lib/common.ts       entity helpers, BigDecimal bridging
  src/lib/accountAddress.ts  account id -> address, read off the venue (§addresses)
  src/lib/seeds.ts        market/token tables (mirrored from packages/venues)
  src/lib/*.test.ts       node --test suites (42 tests)
  scripts/verify-config-topics.ts   re-checks every signature against the chain
  abis/PerplExchange.events.json    vendored Perpl events
```

**It is deliberately not a pnpm workspace member** (`pnpm-workspace.yaml`
excludes `services/indexer`). `envio` vendors its own runtime — a tsx loader,
pino, Postgres, viem — and a hoisted workspace install would fight its pinned
toolchain. It has its own `package.json` and lockfile; install with `npm install`
inside it. That exclusion is why root `typecheck`/`lint`/`test` are unaffected by
anything in here, and why they must be run from `services/indexer` instead.

---

## What is indexed

Every signature was checked against the chain, not only against a vendored ABI.
`scripts/verify-config-topics.ts` recomputes each topic0 from the string in
`config.yaml` and greps recent logs for the configured addresses; a wrong
signature matches nothing, and a wrong `indexed` flag shows up as a topic-count
mismatch. Run it after any edit:

```bash
cd services/indexer
mise exec -- npm run verify:topics          # 5 windows of 100 blocks
mise exec -- npm run verify:topics -- 20    # 20 windows
```

| Contract           | Event                  | Indexed? | Leaderboard role               |
| ------------------ | ---------------------- | -------- | ------------------------------ |
| KuruOrderBook ×4   | `TradesPacked`         | ✓ live   | fills → `Trade` + stats        |
| KuruOrderBook ×4   | `BookUpdatesPacked`    | ✓ live   | order lifecycle (`MakerOrderUpdate`) |
| KuruAccountCore    | `SpotReserveUpdated`   | ✓ live   | absolute balances              |
| KuruAccountCore    | `Deposit` / `Withdrawal` | ✓      | cumulative custody flow        |
| KuruAccountCore    | `AccountRegistered`    | ✓        | account id → address           |
| PerplExchange      | `OrderRequestV2`       | ✓ live   | taker identity + intent        |
| PerplExchange      | `MakerOrderFilledV2`   | ✓ live   | maker leg                      |
| PerplExchange      | `TakerOrderFilledV2`   | ✓ live   | `Trade` row                    |
| PerplExchange      | `AccountCreated`       | rare     | account id → address           |
| PerplExchange      | `CollateralDeposit` / `CollateralWithdrawal` | rare | custody, `balanceCNS` |
| PerplExchange      | `ContractAdded`        | rare     | a perp listed inside the range |

Kuru addresses are the "Set C" Spot V2 deployment; the source of truth is
`packages/venues/src/kuru/constants.ts` and this file is a copy, because the
indexer cannot import workspace TS.

`SpotReserveUpdated(uint40 indexed userId, address indexed token, uint256
freeBalance, uint256 reservedBalance)` is **not in Kuru's deployment docs**. It
was found by scanning AccountCore's logs and matching topic0 against
`@toxicflow-labs/ts-sdk`'s `accountCoreAbi`, and it is the reason balances here
are exact rather than accumulated.

---

## Entity model

Envio maps a schema relation `market: Market!` to a plain `market_id` column on
the entity, so handlers write `market_id`, not `market`. Derived fields
(`@derivedFrom`) do not exist on the write side at all.

| Entity               | One row per                | Read by the leaderboard as        |
| -------------------- | -------------------------- | --------------------------------- |
| `Account`            | venue account              | identity + cross-market rollup    |
| `AccountMarketStats` | (account, market)          | **the leaderboard row**           |
| `AccountBalance`     | (account, token)           | custody                           |
| `Trade`              | match (see §perpl)         | trade tape                        |
| `Market`             | market                     | market metadata + rollup          |
| `MarketDay`          | (market, UTC day)          | daily series, VWAP                |
| `MakerOrderUpdate`   | resting order update       | order lifecycle feed              |
| `PerplOrderContext`  | Perpl order request        | internal join key (`@internal`)   |
| `PerplMakerFill`     | Perpl maker leg            | internal join key (`@internal`)   |

Ids are venue- and chain-qualified so the two venues never collide:
`kuru-62`, `perpl-1`, `kuru-<orderBookAddress>`, `perpl-16`,
`10143-<block>-<logIndex>-<recordIndex>`.

### §pnl

`AccountMarketStats` carries a signed moving-average cost basis, exact `BigInt`
quote atoms, floored:

- a fill that **adds** to the position extends the basis and realises nothing;
- a fill that **reduces** closes `min(|pos|, |fill|)` at the stored average and
  realises `(price − avgCost) × closed` for a long (mirrored for a short);
- a **flip** consumes the whole old basis and reopens the remainder at the trade
  price;
- `wins`/`losses` count each *reducing* fill by the sign of the delta it
  produced, so a flip counts once.

Two things it is not:

1. **Fees are excluded.** Fees are recorded on the `Trade` row
   (`takerFeeRaw`/`makerFeeRaw`, Kuru pps and Perpl CNS respectively) but are not
   netted out of `realizedPnlUsd`.
2. **Perpl funding and premium are invisible to fills.** A perp position's PnL
   includes funding and premium settlements that no fill event carries, so on
   Perpl this number is a *price-based approximation* of what the exchange
   actually settled. See §perpl for the authoritative source.

`boughtBase`/`soldBase`/`baseVolume` are scaled by the **book/LNS size unit**
(`decimalsFromPrecision(market.sizePrecision)`), not by the base token's ERC-20
decimals. MON-USDC sizes in 10^8 units while MON is 18-decimal; confusing the two
overstates base volume by 10^10. `Market.baseDecimals` holds the token's real
decimals as display metadata.

### §custody

AccountCore is read three ways, and they answer different questions:

| Field                                      | Meaning                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `deposited`, `withdrawn`, `net`            | cumulative wallet ↔ venue **flow**; `net` is not a balance          |
| `freeRaw`, `reservedRaw`                   | the **balance** the venue reports, written as absolute values        |

The absolute pair is what makes this robust: a `SpotReserveUpdated` that never
arrives is corrected by the next one, whereas an accumulated balance drifts
forever. For Perpl, `CollateralDeposit`/`CollateralWithdrawal` carry `balanceCNS`
(absolute) into `freeRaw`, and `reservedRaw` stays 0 because Perpl's
`lockedBalanceCNS` is not on those events.

### §addresses

`Account.address` is what the API joins on — `services/api` asks the indexer
`where: { address: { _in: [<agent wallets>] } }` — so an account without one is
not on the leaderboard at all.

The address used to come **only** from the one-shot registration events, Kuru's
`AccountRegistered` and Perpl's `AccountCreated`, and `config.yaml` starts at
block 61294867, about seven days. An account registered before that window never
emits its registration again, and a Kuru maker seen only as a record inside
somebody else's `TradesPacked` log never had an address in any event at all.
Both were invisible on the board forever, and nothing healed them. In the
§proven Kuru run, *all three* accounts are of this kind.

Two cheaper fixes do not work, and it is worth writing down why:

- **Taking it off the fill events.** Kuru's `TradesPacked` carries an
  `executor` — whoever submitted the order, an authorised signer rather than the
  account — and the maker leg inside `packedTrades` is a bare `uint40`. Every
  Perpl fill event carries an `accountId` at best. A wrong address on a
  leaderboard row is worse than none.
- **An earlier `start_block` for the registration events only.** Envio's
  per-contract `start_block` is documented in `envio/evm.schema.json` as "Can be
  greater than the chain start_block for more specific indexing" — later only.
  Reaching older registrations means moving the whole chain back, which is the
  seven-day window itself.

So `src/lib/accountAddress.ts` resolves the id against the contract the first
time the account is seen, through an Envio **effect** — deduplicated and cached,
so it is one RPC read per account id ever, not one per fill:

| Venue | Call                                    | Unknown id      |
| ----- | --------------------------------------- | --------------- |
| Kuru  | `AccountCore.userAddressById(uint40)`   | the zero address |
| Perpl | `Exchange.getAccountById(uint256)`      | reverts          |

Neither read is in its venue's docs; both were found by selector and verified
against the live contracts — `userAddressById(62)` and `(47)` answer the two
accounts of the §proven Kuru fill, and `getAccountById(1)` answers the
`AccountInfo` whose fifth word is `accountAddr`. `accountAddress.test.ts` pins
the exact calldata and the exact responses, so an ABI drift fails loudly.
"Unknown" is stored as **no address**, never as `0x000…0`, which would match an
agent's wallet exactly as badly as a wrong one. A revert is an answer; a
transport failure throws, so Envio retries instead of caching a null.

`ENVIO_MONAD_RPC_URL` overrides the RPC these reads go to (default:
`https://testnet-rpc.monad.xyz`, the same fallback `config.yaml` names). The
registration events are still indexed and still authoritative when they land
inside the window — they also carry `owner`, which no read gives.

### §perpl

Perpl's fill events are not self-describing, which is the whole complexity:

- **`TakerOrderFilledV2` has no `perpId` and no `accountId`.** The only place the
  aggressor's identity and intent appear is the `OrderRequestV2` the transaction
  opened with.
- **`MakerOrderFilledV2` has `perpId`+`accountId` but not the side** — the maker
  is simply the opposite of the taker it filled.

So attribution is by log order inside the transaction. That is stable and was
confirmed on chain, not assumed. Real shape of tx
`0xd58c92ad…070` (block 63311165):

```
logIndex 68  OrderRequestV2      accountId 2, perpId 16, orderType 1
logIndex 69  PositionDecreased   accountId 1   (maker leg)
logIndex 70  MakerOrderFilledV2  accountId 1, pricePNS 768109, lotLNS 588
logIndex 71  PositionDecreased   accountId 2   (taker leg)
logIndex 72  TakerOrderFilledV2  lotLNS 588, feeCNS 94847
logIndex 73  OrderBatchCompleted
```

Envio runs handlers in log order within a batch and serves `getWhere` from its
in-memory table, so the fill handlers read the rows the earlier handlers wrote in
the same batch — `OrderRequestV2` → `PerplOrderContext`, `MakerOrderFilledV2` →
`PerplMakerFill`. `src/lib/perpl.ts` holds the selection rules and
`src/lib/perpl.test.ts` replays this transaction.

**`OrderDescEnum` is zero-based**, and getting this wrong flips the sign of every
Perpl trade:

| Value | Order type   | Side (`OrderType::side()`) |
| ----- | ------------ | -------------------------- |
| 0     | `OpenLong`   | BUY                        |
| 1     | `OpenShort`  | SELL                       |
| 2     | `CloseLong`  | SELL                       |
| 3     | `CloseShort` | BUY                        |

`OpenLong`/`OpenShort` are not "open only" — Perpl uses them to decrease, close
or invert a position; only the `*Close*` pair are reduce-only. Authority:
`PerplFoundation/dex-sdk`, `crates/sdk/src/types/order.rs`. Confirmed live: this
transaction's `orderType` reads 1 while its long position *decreases* by the fill
size, which is only consistent with a sell.

Only the taker leg creates a `Trade` row, once per match: a multi-maker sweep
emits several `MakerOrderFilledV2` but a single `TakerOrderFilledV2`, so taping
the makers too would double-count volume. Every maker still gets its own
`AccountMarketStats` row from its own event, and the taker's `Trade` names the
first maker.

**Deliberately not indexed yet — `PositionDecreased.deltaPnlCNS`.** Perpl emits
the exchange's own realised PnL per position change:

```
PositionDecreased(perpId, accountId, positionType, startDepositCNS,
                  endDepositCNS, startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS)
```

`deltaPnlCNS` (a signed `int256`) *is* the answer a trading leaderboard wants —
it includes funding and premium, which our fill-derived number cannot see. It is
a schema addition plus one handler, and it should be the next step before the
Perpl leaderboard is shown to anyone. The same is true of `PositionIncreasedV2`
for entries. `abis/PerplExchange.events.json` currently holds only the seven
events above; the full deployed ABI is 204 events and lives in the SDK repo at
`crates/sdk/abi/dex/Exchange.json`.

---

## GraphQL for the leaderboard

Envio serves the schema through Hasura, so the auto-generated `<Entity>` /
`<Entity>_by_pk` roots and `_eq` / `_order_by` / `limit` arguments are
available. **These queries are written against the generated schema but have not
been executed against a live endpoint yet** — starting Hasura is part of
[§run-locally](#run-locally), and the first thing to do once it is up is run
them.

```graphql
# Top accounts, both venues, by realised PnL on the stored rollup.
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

# Per-market leaderboard — the row the app actually renders.
query MarketLeaderboard($marketId: String!, $limit: Int!) {
  AccountMarketStats(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ realizedPnlUsd: desc_nulls_last }]
    limit: $limit
  ) {
    id
    account { id address venue }
    market { id symbol venue base quote }
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
    taker { id address }
    maker { id address }
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
  Market(order_by: [{ venue: asc }, { symbol: asc }]) {
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
      market { id symbol venue }
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
      freeRaw
      reservedRaw
      lastUpdatedBlock
    }
  }
}

# Resting-order lifecycle for a market.
query BookUpdates($marketId: String!, $limit: Int!) {
  MakerOrderUpdate(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ blockNumber: desc }, { logIndex: desc }]
    limit: $limit
  ) {
    id
    makerAccountId
    slotIdx
    orderId
    priceRaw
    sizeRaw
    isBuy
    isLive
    blockNumber
    txHash
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
mise exec -- npm test                    # 42 unit tests, no network
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
the root `typecheck`/`lint`/`test` walk straight past it — for two months
nothing in the repo ran these tests at all.

Then the environment. `ENVIO_PG_*` selects the database (defaults shown; these
are already exported in this repo's shell):

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

**HyperSync needs an API token, and we do not have one.** This is the exact
blocker, verbatim from a fresh run:

```
Error: An Envio API token is required for using HyperSync as a data-source.
Set the ENVIO_API_TOKEN environment variable in your .env file.
Learn more or get a free Envio API token at: https://envio.dev/app/api-tokens
    at Module.requireApiToken (envio/src/sources/HyperSync.res.mjs:22:27)
    at Module.make (envio/src/sources/EvmHyperSyncSource.res.mjs:20:28)
    at Module.makeSources (envio/src/sources/EvmChain.res.mjs:23:63)
```

There is no token anywhere in `.env`, `.env.example` or the environment, and
there is no CLI switch to disable HyperSync (`envio` 3.12.0 exposes only
`ENVIO_HYPERSYNC_*` tuning vars). Envio builds the HyperSync source eagerly and
`requireApiToken` throws before anything can run.

**Why that is survivable, and what it means.** `EvmChain.makeSources` appends the
configured RPC sources whatever happens; when HyperSync 401s, Envio retries and
then falls back to the RPC. With HyperSync left configured, a run logs a burst of

```
ERROR hypersync_client] failed to get arrow data from server, retrying...
  The error was: http response status code 401 Unauthorized
```

and then **indexes the blocks anyway** — which is how the runs in §proven were
produced. Monad's public RPC caps `eth_getLogs` at 100 blocks
(`docs/monad-testnet-assets.md`), so the fallback is fine for spot checks and far
too slow for the 7-day backfill (`start_block: 61294867`). Getting
`ENVIO_API_TOKEN` is therefore the one prerequisite for a production sync.

To point the indexer at a different RPC, set `VERIFY_RPC` for the verify script
and the `rpc:` entry in `config.yaml` for the indexer.

---

## Proven live runs

Run with the real handlers over real blocks, in memory, via Envio's
`createTestIndexer()` — no Postgres, no account:

```bash
# scripts/local/live-range.ts <startBlock> [endBlock]
ENVIO_API_TOKEN=placeholder mise exec -- node --experimental-strip-types \
  --no-warnings scripts/local/live-range.ts 61406913 61406913
```

**Kuru** — block 61406913, tx `0x9d7fbce1…`, the fill documented in
`docs/kuru.md` ("placeMarket 388 MON → 317.737 filled"):

```
Trade=1 AccountMarketStats=2 Account=3 Market=4 MarketDay=1 MakerOrderUpdate=0
  trade 10143-61406913-9-0 KURU kuru-0xfdbe…ef61 BUY rawPrice=30974
        rawSize=31773742494 price=0.030974 notional=9.841599 taker=kuru-62 maker=kuru-47
  stats kuru-62-… n=1 takerN=1 vol=9.841599 open=31773742494/9841599
  stats kuru-47-… n=1 makerN=1 vol=9.841599 open=-31773742494/-9841599
  account kuru-47 KURU address=0x74443181214751970a785f5675bd372735245c9e
  account kuru-62 KURU address=0x15bbc549326dd8d053233c3a546aa7fdabb57256
  account kuru-1  KURU address=0xfba882999b0210a2eb80cc066e4d54529239e71d
  day kuru-0xfdbe…ef61-20260910 trades=1 volumeUsd=9.841599
        baseVolume=317.73742494 vwap=0.030973999999711838
```

Price 0.030974 and $9.841599 match the on-chain fill exactly, and the two legs
are mirrored. `MakerOrderUpdate=0` is right: that transaction contains no
`BookUpdatesPacked` log.

Two numbers in that output are the SEN-34 fixes, re-run on the same block:

- **`vwap=0.03097399…`** is the fill's own price, as a one-fill day must be.
  Until SEN-34 it read `0.009867`: `MarketDay.vwapPrice` was
  `volumeUsd.div(baseVolume, 18)`, and bignumber.js reads `div`'s second
  argument as the numeric **base** of the operands, not as a decimal-place
  count. Every VWAP the indexer ever wrote was a base-18 reading of two base-10
  numerals, and any operand large enough to print in exponential notation came
  out `NaN`. It is now `div(baseVolume).decimalPlaces(18)`, pinned in
  `markets.test.ts` against exactly these numbers.
- **`address=…` on all three accounts**, which were `NULL` before. None of the
  three registered inside the indexed window; see §addresses.

**Perpl** — block 63311165, tx `0xd58c92ad…`:

```
Trade=1 AccountMarketStats=2 Account=2 Market=7 MarketDay=1
PerplOrderContext=33 PerplMakerFill=1
  trade 10143-63311165-72-0 PERPL perpl-16 SELL rawPrice=768109 rawSize=588
        price=76810.9 notional=451.648092 taker=perpl-2 maker=perpl-1
  stats perpl-1-perpl-16 n=1 makerN=1 open=588/451648092
  stats perpl-2-perpl-16 n=1 takerN=1 open=-588/-451648092
  account perpl-1 PERPL address=0xa91f9339e65d6d0ded8861aa91de9e6ae9910cab
  account perpl-2 PERPL address=0x306e1912f314af6fca9832c13875e734172b4d46
  day perpl-16-20260917 trades=1 volumeUsd=451.648092
        baseVolume=0.00588 vwap=76810.9
```

The taker is `SELL` (orderType 1 = `OpenShort`), BTC prices at 76810.9, and the
maker is resolved from `MakerOrderFilledV2` across the `PerplMakerFill` join.
The day's VWAP is the fill price and both accounts carry an address, neither of
which was true before SEN-34 — `AccountCreated` for these two is older than the
indexed range.

---

## Deploy to Envio Cloud

`envio deploy` **does not exist** in `envio` 3.12.0 (subcommands are `init`,
`dev`, `stop`, `codegen`, `local`, `start`, `metrics`, `skills`, `tools`,
`config`). Cloud deployment is Git-based plus a separate `envio-cloud` CLI.

Cloud is Git-based: install the Envio Deployments GitHub App, register the
indexer against this repository with the right root directory and config path,
and push to the deployment branch.

```bash
cd services/indexer
npx envio-cloud login                       # browser; or ENVIO_GITHUB_TOKEN + login --token

# Register the indexer. --root-dir has to point at services/indexer, because the
# config is not at the repository root.
npx envio-cloud indexer add \
  --name sente-leaderboard \
  --repo <owner>/<repo> \
  --branch feat/SEN-25-envio-indexer \
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
prefixed) or the Cloud build hits exactly the blocker in §hypersync. Likewise
`--branch` must be the branch that actually carries the indexer; today that is
`feat/SEN-25-envio-indexer`, and it should be revisited when SEN-25 merges —
a Cloud indexer pointed at a branch that no longer receives commits looks
healthy and silently stops updating.

`envio-cloud` is alpha. Nothing here was run: **no Envio Cloud login was made and
no deployment exists.** The commands above are from
<https://docs.envio.dev/docs/HyperIndex/envio-cloud-cli>.

---

## Verification

| Check                        | Command                                     | State |
| ---------------------------- | ------------------------------------------- | ----- |
| Unit tests (42)              | `mise exec -- npm test`                     | pass  |
| Indexer typecheck            | `mise exec -- npm run typecheck`            | pass  |
| Config vs chain              | `mise exec -- npm run verify:topics`        | pass  |
| Real blocks → real entities  | `scripts/local/live-range.ts <block>`       | pass (both venues) |
| Root typecheck / lint        | `mise exec -- pnpm run typecheck` (root)    | pass (indexer excluded) |
| The indexer, from the root   | `mise exec -- pnpm run check:indexer`       | pass  |
| Live GraphQL query           | `envio dev` + Hasura on :8080               | **not run** |
| Envio Cloud deployment       | `envio-cloud …`                             | **not run** |

## Open work

1. **`ENVIO_API_TOKEN`** — prerequisite for any real sync. Everything else here
   is done.
2. **Index `PositionDecreased` → authoritative Perpl PnL** (§perpl). Do this
   before showing a Perpl leaderboard to anyone.
3. **Prove the GraphQL queries** against a live Hasura, then wire the leaderboard
   queries above into `services/api`.
4. **Deploy to Cloud** and set `ENVIO_API_TOKEN` on the deployment.
5. **Kuru `Withdrawal` has never been observed on chain** in the windows
   scanned. Its signature comes straight from the SDK ABI and its topic-count
   check is the same shape as `Deposit`, which *was* observed — but it is
   verified by argument, not by a log.
6. **Fee accounting** — fees are recorded but not applied to
   `realizedPnlUsd` (§pnl).
