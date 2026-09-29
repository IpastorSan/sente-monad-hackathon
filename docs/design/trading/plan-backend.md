# Trading-first Sente — backend plan, steps 1–3 (SEN-61)

Market data, the agent portfolio with a durable event log, and presets with per-agent cadence:
steps 1–3 of the build order in `index.html`, for the screens in `brief.md`. Grounded in
`capabilities.md`. Manual trading (step 4) is `plan-trading.md`; the app side is
`plan-mobile.md`. Every subtask has a stable id (`B-T…`) that tracker issues link to.

## Findings that shaped the plan

1. **Perpl positions will read empty for nearly every agent.** No API code path enrolls a Perpl
   key (`PerplAgentAccounts.credentials()` is only called from `scripts/agent-venues-live.ts`),
   and keys live in the in-memory `InMemoryAgentSecretStore`. The portfolio route therefore
   needs an on-chain fallback (balance without positions). A durable encrypted secret store and
   on-demand enrollment are a follow-up outside steps 1–3.
2. **The agent snapshot already stresses Perpl's rate limit.** Every run calls `get_depth` per
   allowed Perpl market, and `PerplVenue.getDepth`/`.quote` open a fresh socket per call
   (`fetchBookSnapshot`). Per-agent cadence multiplies that, so agent tools read through the
   same shared market-data service as the phone routes (B-T11).
3. **The event log can't reuse the JSON-file persistence.** `STATE_DIR` + `state/json-file.ts`
   rewrite the whole file per mutation — fine for tens of agent records, not for 10k events per
   agent. The smallest fit is an append-only JSONL file in the same `STATE_DIR`, loaded at boot
   into the existing in-memory log.
4. **Spot cost basis from the log is partial.** `gate.ts` only records fills at placement; a
   resting limit that fills later never produces a `fill` event, and user-funded base assets
   have no cost. Cost basis carries a `complete` flag. _Later fills: closed by SEN-149_ —
   `agents/fills/resting-fill.watcher.ts` reads the OrderBook's `TradesPacked` logs for agents'
   resting orders and appends one `fill` per trade record, deduplicated by `tradeKey`.

## Conventions

Nest wiring in module/provider files; files imported by scripts use erasable syntax and `.ts`
specifiers; money is decimal strings; jest specs next to the code (`*.spec.ts`). Done means
`mise exec -- pnpm run typecheck`, `mise exec -- pnpm run lint` and
`mise exec -- pnpm --filter @sente/api run test` pass; tasks touching `packages/venues` also run
`mise exec -- pnpm --filter @sente/venues run test`.

## Track A — market data (step 1)

### B-T1 — Probe Perpl's market-data socket and funding

Research, read-only against testnet, before B-T4 hardens.

- **Create:** `packages/venues/scripts/perpl-feed-probe.ts`; findings section in the Perpl docs.
- **Read:** `packages/venues/src/perpl/ws.ts`, `wire.ts`, `rest.ts`, `scripts/perpl-live.ts`.
- **Steps:** open one socket to `wss://testnet.perpl.xyz/ws/v1/market-data`; one
  `SubscriptionRequest` whose `subs` lists `order-book@<id>` for every open market; log every
  frame's `mt`, `sid`, size for 120 s. Answer: (a) are later frames repeated `mt:15` snapshots,
  deltas with a new `mt`, or nothing? (b) does one multi-stream subscribe count as one request
  against 10/min (send 12 single subscribes, see when refused)? (c) idle/heartbeat disconnect
  (`mt:100`)? (d) which REST path serves funding (`rest.ts` mentions it, doesn't wrap it)? (e)
  what `state.orl` is (oracle/index?) vs `mrk`; (f) is `getAccountByAddr().balanceCNS` in AUSD
  atoms (compare with the socket's `b`, using `PERPL_DEV_*`).
- **Acceptance:** script runs with `node --no-warnings`; findings written down. Nothing depends on
  it in code yet.
- **Depends on:** none.

### B-T2 — Kuru adapter additions: fees, book snapshot, pure slippage bound

- **Modify:** `packages/venues/src/types.ts`, `kuru/mapping.ts`, `kuru/adapter.ts`,
  `kuru/mapping.test.ts`.
- **Read:** `kuru/orders.ts` (`PPS_DENOMINATOR`, `KuruMarketParams`), `kuru/api.ts`.
- **Steps:**
  1. `types.ts`: optional `Market.makerFee?: Decimal; takerFee?: Decimal` (fractions, e.g.
     `'0.0007'`) and `marginMode?: MarginMode`. Additive; `list_markets` inherits them.
  2. `toMarket`: fees from `takerFeePps`/`makerFeePps` ÷ `PPS_DENOMINATOR` via `ratioToDecimal`.
  3. Export pure `kuruSlippageBound(best: bigint, side: Side, maxSlippage: Decimal, params:
Pick<KuruMarketParams,'pricePrecision'|'tickSize'>): Decimal`, lifted from
     `#slippageBound` (same floor/ceil); `#slippageBound` delegates.
  4. `KuruVenue.bookSnapshot(symbol): Promise<{ params; bids: BookLevel[]; asks: BookLevel[];
bestBid: bigint|null; bestAsk: bigint|null; observedAt: number }>` reusing `quote()`'s
     `getL2Book(100)` read; `quote()` refactored to use it.
- **Acceptance:** new `mapping.test.ts` cases (fee scaling; `kuruSlippageBound` equals the old
  private function for buy/sell at edge ticks); existing venues tests pass.
- **Depends on:** none.

### B-T3 — Perpl public (credential-free) reader

- **Create:** `packages/venues/src/perpl/public.ts` + `public.test.ts`. **Modify:**
  `perpl/venue.ts` (delegate), `perpl/index.ts` (export).
- **Read:** `perpl/venue.ts:333-457`, `rest.ts`, `wire.ts`.
- **Steps:** extract pure helpers from `PerplVenue`: `perplMarkets(context): Market[]` (now with
  fees `maker_fee/1e6`, `marginMode:'isolated'`, `maxLeverage`), `bookToDepth(book, m, limit)`,
  `quoteFromBook(book, m, req): Quote`, `perplSlippageBound(markScaled, side, maxSlippage, m):
{ price: Decimal; effectiveSlippage: Decimal }` (clamps to `order_max_market_slippage_bps` as
  `venue.ts:664-683` does), `candlesToKlines(series, m, interval, from, to, count)`. Add:

  ```ts
  export class PerplMarketData {
    constructor(o: { network?: PerplNetwork; fetchImpl?: typeof fetch; contextMaxAgeMs?: number });
    readonly rest: PerplRest; // no credentials
    context(maxAgeMs?: number): Promise<PerplContext>;
    getMarkets(): Promise<Market[]>;
    resolve(symbol: string): Promise<ResolvedMarket>;
    getKlines(q: KlineQuery): Promise<Kline[]>;
    state(
      symbol: string,
    ): Promise<{ mark; last; mid; bid; ask; index: Decimal | null; at: number }>;
  }
  ```

  `PerplVenue` keeps its public API and calls these helpers.

- **Acceptance:** `public.test.ts` with a fixture context and book: `quoteFromBook` equals the
  old `quote()` on the same book; slippage clamp covered; `venue.test.ts` unchanged and green.
- **Depends on:** B-T2 (the `types.ts` fields).

### B-T4 — PerplBookFeed: the one held market-data socket

- **Create:** `services/api/src/venues/perpl/perpl-book-feed.ts` + spec.
- **Read:** `perpl/ws.ts`, `perpl/trading.ts:200-300` (ping/reconnect pattern), B-T1 findings.
- **Steps:**

  ```ts
  export class PerplBookFeed {
    constructor(o: { wsUrl: string; marketIds: () => Promise<number[]>; webSocket?: WebSocketFactory;
      idleCloseMs?: number /*300_000*/; staleMs?: number /*15_000*/; maxRequestsPerMin?: number /*8*/;
      now?: () => number; logger?: Pick<Logger, 'log' | 'warn'> });
    book(marketId: number): { book: PerplL2Book; receivedAt: number; stale: boolean } | undefined; // opens lazily
    waitFor(marketId: number, timeoutMs: number): Promise<...>;
    status(): { connected: boolean; markets: number[]; lastFrameAt: number | null; reconnects: number; requestsLastMin: number };
    close(): void; // onModuleDestroy
  }
  ```

  Lazy open on first read, idle close after `idleCloseMs` without readers; one batched
  subscribe per connection; a request counter that refuses to exceed `maxRequestsPerMin`;
  reconnect with exponential backoff + jitter capped at 60 s; per-subscription error codes
  (`mt:6`); ping interval; keep the latest `mt:15` per market (apply deltas if B-T1 finds them,
  otherwise count and ignore unknown `mt`).

- **Acceptance:** spec with a fake `WebSocketFactory`: lazy open, a single subscribe carrying N
  streams, snapshot stored, reconnect with backoff, request budget never exceeded across
  reconnects, idle close, stale flag.
- **Depends on:** none for code; merge after B-T1 or keep delta handling pluggable.

### B-T5a — TtlCache and MarketDataService (Kuru side)

- **Create:** `services/api/src/venues/ttl-cache.ts`, `venues/market-data.service.ts`,
  `venues/dto/markets.dto.ts` (types only — paste the wire contract below first), specs.
- **Read:** `kuru/adapter.ts`, `kuru/api.ts`, `venues/venues.service.ts`.
- **Steps:**
  1. `TtlCache<K,V>.get(key, ttlMs, load, { staleIfErrorMs? })`: single-flight per key; serves
     the last good value flagged stale when a load fails.
  2. `MarketDataService` with readers injected by interface: `KuruReader` (read-only
     `KuruVenue({ publicClient })`, no `account`) and `PerplReader` (stubbed; B-T5b fills it).
  3. Methods: `markets(): Promise<MarketsResponseDto>`, `market(venue, symbol)`,
     `ticker(venue, symbol)`, `tickers(venue?)`, `depth(venue, symbol, limit)`,
     `klines(venue, symbol, interval, limit, endTime?)`, `quote(venue, symbol, { side, size,
maxSlippage })`, `mark(venue, symbol): Promise<Decimal | null>` (the portfolio uses it).
  4. Kuru caching: markets from Data Source 60 s; depth + bid/ask from Gateway
     `depth(venueSymbol, 50)` 2 s per symbol, sliced to `limit`; `last` = latest 1m candle close
     10 s; 24h open/high/low/volume from 25 × 1h candles 60 s; klines 10 s (1m) / 30 s (5m) /
     60 s (≥15m) with a bucketed `endTime` in the key; quote book via `kuru.bookSnapshot()`
     1.5 s per market.
  5. Kuru quote for any size simulated locally with `simulateQuote`; `worstPrice` from
     `kuruSlippageBound`; `fillableWithinWorstPrice` walks only levels at or inside the bound.
  6. Typed errors: `MarketNotFoundError`, `IntervalNotSupportedError`, `VenueUnavailableError`.
- **Acceptance:** specs with a fake Kuru reader: cache hit (load once within TTL), single-flight
  under concurrency, stale-if-error, quote with a partial fill inside the bound, `minNotionalOk`;
  merged markets with Perpl down yield `venues:[{venue:'perpl', ok:false}]`.
- **Depends on:** B-T2.

### B-T5b — MarketDataService Perpl side and module wiring

- **Modify:** `market-data.service.ts`, `venues/venues.module.ts`, `venues/venues.service.ts`
  (`describe()` → `implemented: true`; `get(id)` returns the read-only venues).
- **Steps:**
  1. Perpl readers: context from `PerplMarketData.context()` cached 3 s globally (one REST call
     serves mark/last/bid/ask for every Perpl market); depth and quote from
     `PerplBookFeed.book()`; if the feed has no book or it's older than 15 s, fall back to
     `fetchBookSnapshot` at most once per market per 30 s via `TtlCache`, else return
     `stale: true`; klines via `PerplMarketData.getKlines`, `1w` → `IntervalNotSupportedError`;
     `funding` stays `null` until B-T1 names the endpoint.
  2. Providers: `MARKET_PUBLIC_CLIENT` (viem, built like `AGENT_PUBLIC_CLIENT`, with
     `batch: { multicall: true }` if multicall3 is confirmed on Monad testnet), `KURU_READER`,
     `PerplMarketData`, `PerplBookFeed` (marketIds from the context), `MarketDataService`
     (exported), plus `SessionAuthGuard` + `Auth` as in `leaderboard.module.ts`.
- **Acceptance:** specs: Perpl ticker maps `mrk/lst/orl/bid/ask`; depth prefers the feed; the
  fallback is throttled; `1w` refused. A `Test.createTestingModule` smoke spec boots the module
  with network readers overridden.
- **Depends on:** B-T3, B-T4, B-T5a.

### B-T6 — /markets routes

- **Create:** `services/api/src/venues/markets.controller.ts` + spec. **Modify:**
  `venues/dto/markets.dto.ts` (class-validator query DTOs), `venues/venues.module.ts`.
- **Read:** `agents/agents.controller.ts` (`guard()` error pattern), `agents/agents.errors.ts`.
- **Routes** (all `@UseGuards(SessionAuthGuard)`): `GET /markets`; `GET /markets/tickers?venue=`;
  `GET /markets/:venue/:symbol/ticker`; `GET /markets/:venue/:symbol/depth?limit=` (1–50,
  default 20); `GET /markets/:venue/:symbol/klines?interval=&limit=&endTime=` (limit 1–1000,
  default 200); `GET /markets/:venue/:symbol/quote?side=&size=&maxSlippage=` (default
  `'0.005'`, max `'0.05'`). Params: `venue ∈ {kuru, perpl}`, `symbol` matches
  `^[A-Za-z0-9._-]{1,32}$`. Errors `{statusCode, reason, message}`: 404 `market_not_found`,
  400 `interval_not_supported`, 400 `invalid_size`, 503 `venue_unavailable` (+ `retryAfterMs`).
- **Acceptance:** controller spec with a fake `MarketDataService`: 401 without a session, each
  route's shape, each error mapping, query validation (bad `interval` → 400).
- **Depends on:** B-T5a (code against the interface in parallel with B-T5b; merge after it).

## Track B — durable event log (step 2)

### B-T7 — Append-only JSONL event log

- **Create:** `services/api/src/agents/events/file-agent-event-log.ts` + spec.
- **Modify:** `events/agent-event-log.ts` (`InMemoryAgentEventLog` constructor gains
  `(maxPerAgent = AGENT_EVENTS_PER_AGENT, seed: readonly AgentEvent[] = [])`: load the seed in
  `seq` order, apply the per-agent cap, set `this.seq` to the highest seen);
  `tools/agent-tools.providers.ts` (`agentEventsProvider` picks `FileAgentEventLog` when
  `stateDir()` is set); `.env.example` (mention `agent-events.jsonl` in the `STATE_DIR` comment).
- **Read:** `state/json-file.ts`, `store/file-agent-store.ts`, `store/agent-store.module.ts`,
  `reputation/erc8004.ts#ReputationEventLog` (keeps wrapping the new log).
- **Behaviour:**

  ```ts
  export class FileAgentEventLog implements AgentEventLog {
    constructor(
      path: string,
      opts?: { maxPerAgent?: number; logger?: Pick<Logger, 'warn' | 'error'> },
    );
    get path(): string;
    get size(): number;
    append(e: NewAgentEvent): Promise<AgentEvent>; // inner.append, then writeSync(fd, JSON.stringify({v:1,e})+'\n') + fsyncSync
    list(agentId, q?): Promise<AgentEvent[]>; // delegates to inner
    close(): void;
  }
  ```

  Path `<STATE_DIR>/agent-events.jsonl`; events are JSON-safe already (`toJsonSafe`), no
  `$date`/`$bigint` tagging. Load: a torn **last** line (crash mid-append) is truncated with a
  warning; a torn line anywhere else, or a wrong `v`, fails boot (the "refuse to start empty"
  rule of `json-file.ts`). Compaction at boot when the file holds more than 1.5× kept events +
  1,000 lines: rewrite atomically (temp, fsync, rename) with only the kept events. Append
  failure: log an error and still resolve — `FileAgentStore` rejects on write failure, but here
  the trade already happened and rejecting would make the gate report a landed order as failed;
  document the trade-off in the header. `seq` keeps increasing across restarts, so the phone's
  `afterSeq` cursors stay valid.

- **Acceptance:** spec in a `mkdtemp` dir: events survive a restart and `seq` continues; torn
  last line tolerated; corrupt middle line throws; per-agent cap holds after reload; compaction
  shrinks the file; a refusal without `layer` is still rejected; `list` semantics equal the
  in-memory log (reuse the table from `agent-event-log.spec.ts`).
- **Depends on:** none. Start immediately.

## Track C — agent portfolio (step 2)

### B-T8 — Spot cost basis from the event log (pure)

- **Create:** `services/api/src/agents/portfolio/cost-basis.ts` + spec.
- **Read:** `events/verdict.ts` (`decimalOf`, `addScaled`, `decimalString`, FIFO notes),
  `tools/gate.ts#fillOf`, `tools/decimal.ts`.
- **API:**

  ```ts
  export interface CostBasis {
    market: string;
    openSize: Decimal;
    avgPrice: Decimal | null;
    costQuote: Decimal;
    realisedPnl: Decimal;
    unmatchedSellSize: Decimal;
    fills: number;
  }
  export function fifoCostBasis(events: readonly AgentEvent[], market: string): CostBasis;
  export function reconcileHolding(
    basis: CostBasis,
    heldSize: Decimal,
    mark: Decimal | null,
  ): { coveredSize; uncoveredSize; avgPrice; unrealizedPnl: Decimal | null; complete: boolean };
  ```

  Uses only `kind:'fill'` with `detail.venue==='kuru'` and matching `detail.symbol`
  (`side`/`filledSize`/`averageFillPrice`); buy fees added to cost only when `feeAsset` is the
  quote; exact bigint fixed-point at 18 dp.

- **Acceptance:** single buy; FIFO partial sells across two lots; sell with no lot → unmatched;
  holding larger than the log explains → `complete:false`; fees; Perpl fills ignored.
- **Depends on:** none.

### B-T9 — AgentPortfolioService

- **Create:** `services/api/src/agents/portfolio/portfolio.service.ts` + spec.
- **Modify:** `agents/venues/perpl-agent.ts` (add `perplAccountInfo(client, address, exchange?) →
{ accountId: bigint; balance: bigint; locked: bigint } | null` reading the full
  `getAccountByAddr` tuple); `agents/agents.module.ts` (provide the service, import
  `VenuesModule` — safe, it imports nothing from agents).
- **Read:** `agents/venues/agent-venues.ts`, `wallet/balances/token-balances.ts`,
  `kuru/adapter.ts` (`getBalances`, `getOpenOrders`, `accountId`), `perpl/venue.ts`
  (`getPositions`, `getBalances`).
- **Behaviour:** `portfolio(agent: AgentRecord): Promise<AgentPortfolioDto>`, cached 3 s per
  agent (single-flight); sections read in parallel, each a `SectionResult` so one failing venue
  never fails the whole response.
  - Wallet: `ViemTokenBalanceReader(AGENT_PUBLIC_CLIENT, [...KURU_TESTNET_TOKENS, AUSD])`.
  - Kuru: read-only `new KuruVenue({ publicClient, account: agent.address })` (no Privy):
    `accountId()`, `getBalances()`, `getOpenOrders()`; account id 0 → empty.
  - Perpl: not in the mandate → `{status:'not_in_mandate'}`; credentials held →
    `agentVenues.forAgent(...)` → `getBalances()/getPositions()/getOpenOrders()`, `status:'ok'`;
    otherwise `perplAccountInfo` → `status:'not_enrolled'` (balance only) or `'no_account'`.
  - Holdings: per Kuru base token, wallet + AccountCore total + open-order locked; `mark` from
    `marketData.mark('kuru', symbol)`; cost basis `fifoCostBasis(await events.list(agent.id))` →
    `reconcileHolding`. Say that wallet MON includes gas.
  - Totals: `approxUsd` treats USDC and AUSD as $1, labelled "≈ $".
- **Acceptance:** spec with fake readers: all sections ok; Perpl `not_enrolled` with balance from
  chain; a throwing Kuru read leaves other sections intact; cache within 3 s; holding uPnL uses
  mark × covered size.
- **Depends on:** B-T5b (`MarketDataService` export), B-T8.

### B-T10 — GET /agents/:id/portfolio

- **Modify:** `agents/agents.controller.ts` (route; ownership first via
  `agents.get(principal, id)` so another user's agent is a 404), `agents/dto/agent.dto.ts` or a
  new `dto/portfolio.dto.ts` (wire types), `agents.controller.spec.ts`.
- **Acceptance:** 200 shape for the owner; 404 for another user's agent; 401 without a session; a
  revoked agent still returns 200 (funds can still sit there).
- **Depends on:** B-T9.

## Track D — presets and agent capabilities (step 3)

### B-T11 — get_klines and quote agent tools; Perpl get_depth on the shared feed

- **Modify:** `agents/tools/registry.ts`, `agents/tools/context.ts`,
  `agents/tools/agent-tools.providers.ts` (extend `tools/testing/fake-venues.ts` only if needed).
- **Steps:**
  1. `ToolContext`/`AgentToolsOptions` gain optional `readonly marketData?:
Pick<MarketDataService, 'klines' | 'quote' | 'depth'>` (existing specs keep working).
  2. `get_klines`: input `{ venue, market, interval: enum('1m','5m','15m','30m','1h','4h','1d','1w'),
limit: int 1..200 (default 48) }` → `{ interval, volumeIsEstimate, candles: [{t,o,h,l,c,qv}] }`
     (short keys to save tokens).
  3. `quote`: input `{ venue, market, side, size: positive, maxSlippage?: decimal ≤ 0.05 }` → the
     `QuoteDto` fields; its description says to use `worstPrice` as `slippageLimitPrice`.
  4. Both `kind:'read'`, no thesis, no intent; read via `ctx.marketData`, fall back to
     `venueOf(...).getKlines/quote` when absent.
  5. Perpl `get_depth` also reads via `ctx.marketData` when present (kills the per-run socket per
     market).
  6. Add both to `AGENT_TOOLS` (reads section); inject `MarketDataService` in the provider.
- **Acceptance:** registry/gate specs: both pass the gate without a thesis; listed by
  `toRunnerTools` and `mcp`; a Perpl `1w` request is an invalid-input result, not a throw;
  `mcp.spec` tool count updated.
- **Depends on:** B-T5b; land after B-T7 (shares `agent-tools.providers.ts`).

### B-T12 — Per-agent schedule on the record + PATCH /agents/:id/schedule

- **Modify:** `store/agent-store.ts` (`AgentRecord.schedule?: { readonly everySeconds: number }`,
  `'schedule'` in `AgentPatch`); `dto/agent.dto.ts` (`ScheduleDto { everySeconds: number|null }`
  with `@IsInt @Min(60) @Max(604800)` (a week since SEN-158) or null; `CreateAgentDto.schedule?`;
  `AgentResponseDto.schedule: {everySeconds} | null`); `agents.service.ts`
  (`setSchedule(principal, id, everySeconds|null): Promise<AgentRecord>`, owner-scoped, revoked →
  409 `agent_revoked`; hire accepts `schedule`; fork does NOT copy it — it spends the forker's
  credits); `agents.controller.ts` (`@Patch(':id/schedule')`).
- **Acceptance:** set/clear/read back; range validated (59 → 400); other user → 404; revoked →
  409; the file store round-trips the field.
- **Depends on:** none.

### B-T13 — Scheduler rewrite with a credits guard

- **Modify:** `runner/agent-run.scheduler.ts`, `runner/runner.config.ts`. **Create:**
  `runner/schedule-guard.ts` + specs; small `GET /agents/:id/schedule` in the controller.
- **Config:** `AGENT_SCHEDULER_POLL_SECONDS` (15), `AGENT_SCHEDULE_MAX_CONCURRENT` (3),
  `AGENT_SCHEDULE_MIN_CREDITS_USD` (0.10), `AGENT_SCHEDULE_MAX_RUNS_PER_DAY` (288).
  `AGENT_TICK_SECONDS` stays as the default cadence for agents without their own (still off by
  default).
- **Scheduler:** one poll timer; cadence = `agent.schedule?.everySeconds ?? config.tickSeconds`
  (neither → skip); due when `now ≥ lastStart + cadence`; `lastStart` seeded at boot from the
  durable log (`events.list(id,{kind:'run',limit:1})`), or a random offset within the cadence
  when there's no history (no thundering herd after restart); due runs through a concurrency
  limiter.
- **`ScheduleGuard.check(agent, now)`** → `{ok:true} | {ok:false, reason:'credits_low'|
'credits_exhausted'|'credits_unavailable'|'daily_cap', until?}`; `CreditsService.status` cached
  60 s per user; a run ending `credits_exhausted` pauses that agent until the credits `resetsAt`.
- **`GET /agents/:id/schedule`** → `{ everySeconds|null, source:'agent'|'global'|null,
lastRunAt|null, nextRunAt|null, paused:{reason, until|null}|null }`.
- **Acceptance:** fake-timer scheduler spec: per-agent cadences, concurrency cap,
  `run_in_progress` skipped, credits-low skip doesn't call `runner.run`, pause lifted at
  `resetsAt`, boot seed from the last `run` event, legacy `AGENT_TICK_SECONDS` still runs agents
  without a schedule; config spec for bounds and parse errors.
- **Depends on:** B-T12; B-T7 softly (without it the seed is empty after restart).

### B-T14a — packages/presets: scaffold, params, render, two presets

- **Create:** `packages/presets/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.mjs}`
  (copied from `packages/mandate`: ESM, exports `types`/`source`/`default`,
  `node --conditions=source --test`, erasable syntax, no deps); `src/index.ts`, `src/types.ts`,
  `src/params.ts`, `src/catalog.ts`, `src/presets/range-trader.ts`, `src/presets/guardian.ts`,
  `src/presets.test.ts`. **Modify:** `services/api/Dockerfile` (COPY the package.json).
- **API:**

  ```ts
  export type ParamValue = string | number | boolean | readonly string[];
  export interface PresetDefinition {
    id: PresetId;
    version: number;
    name: string;
    tagline: string;
    description: string;
    venues: readonly ('kuru' | 'perpl')[];
    params: readonly ParamSpec[];
    tools: readonly string[];
    suggestedCadenceSeconds(p: Params): number;
    suggestedMandate(p: Params): SuggestedMandate;
    render(p: Params): { strategy: string; systemPrompt: string };
  }
  export function listPresets(): readonly PresetDefinition[];
  export function getPreset(id: string): PresetDefinition | undefined;
  export function resolveParams(
    def,
    raw: Record<string, unknown>,
  ): { ok: true; params: Params } | { ok: false; errors: { key: string; message: string }[] };
  export function renderPreset(
    id: string,
    raw: Record<string, unknown>,
  ): { ok: true; id; version; params; strategy; systemPrompt } | { ok: false; errors };
  ```

  `render` is deterministic; every stop/target is phrased "checked every run, not a venue order";
  presets reference `get_klines`/`quote` only once B-T11 has shipped.

- **Acceptance:** every preset renders defaults and extreme params within `strategy ≤ 2000` and
  `systemPrompt ≤ 8000` chars; `resolveParams` rejects out-of-range and unknown keys; render
  pinned by a snapshot string; ids unique; `mise exec -- pnpm install` adds the workspace to the
  lockfile; root typecheck/lint/test green.
- **Depends on:** none.

### B-T14b — Remaining presets

Trend Rider, Funding Harvester, DCA Stacker, Mean Reverter in `src/presets/`, registered in
`catalog.ts` (params as in `agents.html` → "The catalog"). The same test table covers them.
**Depends on:** B-T14a.

### B-T15 — Hire records its preset

- **Modify:** `store/agent-store.ts` (`AgentRecord.preset?: { id; version; params:
Record<string, ParamValue>; customized: boolean }`); `dto/agent.dto.ts` (nested
  `PresetRefDto { id; version?; params }` on `CreateAgentDto`; `systemPrompt`/`strategy` become
  `@ValidateIf(o => !o.preset)`; response `preset: {id, version, name, params, customized} |
null`); `agents.service.ts` (on hire with `preset`: `renderPreset`, failure → `preset_invalid`
  with field errors; absent `strategy`/`systemPrompt` filled from the render; `customized` =
  submitted text differs from the render; `fork` copies `preset` and sets `customized` when the
  source prompt wasn't copied); `agents.errors.ts` (`preset_invalid`, 400);
  `services/api/package.json` (`"@sente/presets": "workspace:*"`).
- **Acceptance:** hire with preset only → rendered text, `customized:false`; edited text →
  `customized:true`; unknown id or bad params → 400 `preset_invalid`; DTO rejects a body with
  neither `preset` nor `strategy`; fork carries the preset; jest resolves `@sente/presets` via
  the `source` condition.
- **Depends on:** B-T14a; land after B-T12 (same three files).

### B-T16a — AgentStore.listAll()

- **Modify:** `store/agent-store.ts` (interface + in-memory), `store/file-agent-store.ts`, the
  shared store spec table. Returns every agent including revoked, oldest first (the stats need
  it to avoid survivorship bias).
- **Depends on:** none (trivial conflicts with B-T12/B-T15).

### B-T16b — /presets catalog and cohort stats

- **Create:** `services/api/src/presets/{presets.module.ts,presets.controller.ts,preset-stats.ts}`
  - specs. **Modify:** `app.module.ts`.
- **Routes:** `GET /presets` (catalog minus functions, plus a `defaults` render);
  `GET /presets/:id/stats`: `running` = active agents with that `preset.id`; cohort = every agent
  on the preset active at any point in the last 30 days (`listAll`, filter by
  `createdAt`/`revokedAt`); `medianPnl30d` = median realised verdict P&L in the window (the
  `summary.ts` helpers, USDC+AUSD as one); `medianReturn30d` = P&L ÷ capital, capital = the
  agent's `deposit` events, only agents with capital > 0, sample reported as `returnN`; both
  medians null below `minN = 5`; customized agents included and counted in `customized`; cached
  60 s; unknown id → 404 `preset_not_found`. Session-guarded; `PresetsModule` imports
  `AgentsModule` for `AGENT_STORE`/`AGENT_EVENTS` like `LeaderboardModule`.
- **Acceptance:** pure spec for `preset-stats` (odd/even median, window filter, revoked-in-window
  counted, nulls below `minN`, `returnN` separate from `n`); controller spec for 404 and shape.
- **Depends on:** B-T15, B-T16a.

## Order and parallelism

| Wave | Parallel                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------- |
| 1    | B-T1, B-T2, B-T4, B-T7, B-T8, B-T12, B-T14a, B-T16a                                                |
| 2    | B-T3 (after T2), B-T5a (after T2), B-T13 (after T12), B-T14b (after T14a), B-T15 (after T14a, T12) |
| 3    | B-T5b (after T3, T4, T5a), B-T16b (after T15, T16a)                                                |
| 4    | B-T6 (after T5a, merge after T5b), B-T9 (after T5b, T8), B-T11 (after T5b, T7)                     |
| 5    | B-T10 (after T9)                                                                                   |

Shared files — land in this order: `agent-store.ts`, `agent.dto.ts`, `agents.service.ts`:
B-T12 → B-T15 → B-T16a. `agents.controller.ts`: B-T12 → B-T13 → B-T10.
`agent-tools.providers.ts`: B-T7 → B-T11. `agents.module.ts`: B-T9 adds the `VenuesModule`
import that B-T11 relies on (whichever lands first adds it).

## Wire contract

```ts
type Decimal = string; // exact decimal, never a float
type VenueId = 'kuru' | 'perpl';
type QuoteCurrency = 'USDC' | 'AUSD'; // Kuru Testnet USDC vs Agora AUSD — never interchangeable
interface ApiError {
  statusCode: number;
  reason: string;
  message: string;
  retryAfterMs?: number;
}

// GET /markets
interface MarketDto {
  venue: VenueId;
  symbol: string;
  venueSymbol: string;
  kind: 'spot' | 'perp';
  base: string;
  quote: QuoteCurrency;
  tickSize: Decimal;
  stepSize: Decimal;
  minSize: Decimal;
  minNotional: Decimal | null; // Kuru only (quote units)
  maxLeverage: number | null; // perps only
  marginMode: 'isolated' | null;
  makerFee: Decimal;
  takerFee: Decimal; // fractions: '0.0007' = 7 bps
}
interface MarketsResponseDto {
  markets: MarketDto[];
  venues: { venue: VenueId; ok: boolean; error?: string }[]; // partial when a venue is down
  asOf: number;
}

// GET /markets/tickers?venue=  and  GET /markets/:venue/:symbol/ticker
interface TickerDto {
  venue: VenueId;
  symbol: string;
  quote: QuoteCurrency;
  last: Decimal | null;
  mark: Decimal | null;
  index: Decimal | null; // mark/index: perps
  bid: Decimal | null;
  ask: Decimal | null;
  mid: Decimal | null;
  open24h: Decimal | null;
  high24h: Decimal | null;
  low24h: Decimal | null;
  change24h: Decimal | null;
  change24hPct: Decimal | null; // pct as a fraction
  quoteVolume24h: Decimal | null;
  funding: { rate: Decimal; intervalHours: number; nextAt: number | null } | null; // null until B-T1
  stale: boolean;
  asOf: number;
}
interface TickersResponseDto {
  tickers: TickerDto[];
  asOf: number;
}

// GET /markets/:venue/:symbol/depth?limit=20  (1..50)
interface DepthDto {
  venue: VenueId;
  symbol: string;
  bids: { price: Decimal; size: Decimal }[]; // best first
  asks: { price: Decimal; size: Decimal }[];
  sequence: number | null;
  stale: boolean;
  asOf: number;
}

// GET /markets/:venue/:symbol/klines?interval=1h&limit=200&endTime=
type KlineInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'; // perpl: no '1w'
interface KlineDto {
  openTime: number;
  closeTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal; // base units — an estimate on both venues
  quoteVolume: Decimal | null;
}
interface KlinesDto {
  venue: VenueId;
  symbol: string;
  interval: KlineInterval;
  klines: KlineDto[]; // oldest first
  volumeIsEstimate: true;
  asOf: number;
}

// GET /markets/:venue/:symbol/quote?side=buy&size=1.5&maxSlippage=0.005
interface QuoteDto {
  venue: VenueId;
  symbol: string;
  side: 'buy' | 'sell';
  size: Decimal;
  fillableSize: Decimal;
  averagePrice: Decimal | null;
  notional: Decimal;
  estimatedFee: Decimal;
  feeAsset: QuoteCurrency;
  slippageVsMid: Decimal;
  maxSlippage: Decimal; // effective (Perpl clamps to venue bps)
  worstPrice: Decimal | null; // pass as slippageLimitPrice when placing
  fillableWithinWorstPrice: Decimal;
  partial: boolean; // fillableWithinWorstPrice < size → "filled 62%, rest cancelled"
  minNotionalOk: boolean | null; // Kuru only
  bookAsOf: number;
  stale: boolean;
}

// GET /agents/:id/portfolio   (owner-scoped, 404 for others)
type SectionResult<T> = ({ ok: true } & T) | { ok: false; error: string };
interface BalanceDto {
  asset: string;
  available: Decimal;
  locked: Decimal;
  total: Decimal;
}
interface OrderDto {
  venue: VenueId;
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: string;
  price: Decimal | null;
  size: Decimal;
  filledSize: Decimal;
  leverage: number | null;
  createdAt: number;
  updatedAt: number;
}
interface PositionDto {
  symbol: string;
  side: 'long' | 'short';
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  liquidationPriceEst: Decimal | null; // our formula, excludes accrued funding — label "est."
  leverage: number;
  margin: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal | null;
  fundingPaid: Decimal | null;
  quote: 'AUSD';
  updatedAt: number;
}
interface SpotHoldingDto {
  asset: string;
  market: string;
  amount: Decimal;
  inWallet: Decimal;
  inAccount: Decimal;
  lockedInOrders: Decimal;
  markPrice: Decimal | null;
  value: Decimal | null; // USDC
  costBasis: {
    avgPrice: Decimal | null;
    coveredSize: Decimal;
    uncoveredSize: Decimal;
    unrealizedPnl: Decimal | null;
    complete: boolean;
    source: 'event-log-fifo';
  };
  note?: string;
}
interface AgentPortfolioDto {
  agentId: string;
  address: string;
  asOf: number;
  wallet: SectionResult<{ balances: (BalanceDto & { decimals: number })[] }>;
  kuru: SectionResult<{ accountId: string | null; balances: BalanceDto[]; openOrders: OrderDto[] }>;
  perpl: SectionResult<
    | {
        status: 'ok';
        accountId: string;
        balances: BalanceDto[];
        positions: PositionDto[];
        openOrders: OrderDto[];
      }
    | {
        status: 'not_enrolled';
        accountId: string;
        balances: BalanceDto[];
        positions: null;
        openOrders: null;
      }
    | { status: 'no_account' }
    | { status: 'not_in_mandate' }
  >;
  holdings: SpotHoldingDto[];
  totals: { approxUsd: Decimal; byQuote: { USDC: Decimal; AUSD: Decimal }; note: string };
}

// Schedule
// PATCH /agents/:id/schedule  body { everySeconds: number | null } (60..604800; null = manual only) → AgentResponseDto
// AgentResponseDto += { schedule: { everySeconds: number } | null }; CreateAgentDto += { schedule?: { everySeconds: number } }
interface AgentScheduleStatusDto {
  // GET /agents/:id/schedule
  everySeconds: number | null;
  source: 'agent' | 'global' | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  paused: {
    reason: 'credits_low' | 'credits_exhausted' | 'credits_unavailable' | 'daily_cap';
    until: string | null;
  } | null;
}

// Presets
type ParamSpec =
  | {
      key: string;
      label: string;
      type: 'number';
      min: number;
      max: number;
      step: number;
      unit?: '%' | 'x' | 'USDC' | 'AUSD' | 'min' | 'h';
      default: number;
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: 'enum';
      options: { value: string; label: string }[];
      default: string;
      help?: string;
    }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string }
  | {
      key: string;
      label: string;
      type: 'market';
      venue: VenueId | 'any';
      multiple: boolean;
      default: string | string[];
      help?: string;
    };
interface SuggestedMandateDto {
  tier: 'cautious' | 'standard' | 'wide'; // maps onto the app's mandate presets
  venues: VenueId[];
  kuruMarkets: string[];
  perplMarkets: string[];
  maxOrderNotional: Decimal;
  maxLeverage: number | null;
  depositCaps: { asset: string; amount: Decimal }[];
  perplCollateral: Decimal | null;
  expiryDays: number;
  softRules: string[]; // e.g. 'sell-only' — NOT enforceable by the mandate
}
interface PresetDto {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: VenueId[];
  params: ParamSpec[];
  tools: string[];
  defaults: {
    params: Record<string, unknown>;
    strategy: string;
    systemPrompt: string;
    suggestedMandate: SuggestedMandateDto;
    suggestedCadenceSeconds: number;
  };
}
// GET /presets → { presets: PresetDto[] }
// CreateAgentDto += { preset?: { id: string; version?: number; params: Record<string, unknown> } }
// AgentResponseDto += { preset: { id; version; name; params: Record<string, unknown>; customized: boolean } | null }
// 400 'preset_invalid' carries { errors: { key: string; message: string }[] }
interface PresetStatsDto {
  // GET /presets/:id/stats
  presetId: string;
  window: '30d';
  running: number;
  n: number;
  minN: 5;
  medianPnl30d: Decimal | null; // ≈$ (USDC+AUSD); null when n < minN
  medianReturn30d: Decimal | null;
  returnN: number;
  customized: number;
  definition: string;
  notes: string[];
  asOf: number;
}
```

## Risks

- **Perpl socket behaviour is unverified** (B-T1): held-subscription updates, batched-subscribe
  accounting, idle drops. If it only ever sends one snapshot, the feed re-subscribes every ~10 s
  within budget and depth is that fresh. No known funding endpoint yet (`funding: null`);
  `index` from `state.orl` unconfirmed; REST limits for `/pub/context` and candles unknown (the
  3 s context cache is the guard).
- **Agents' Perpl positions will mostly be `not_enrolled`** until a durable secret store and a
  real enrollment path exist (keys are lost on restart; an account holds at most 16 keys).
- **RPC load:** each Kuru quote is an `eth_call` (1.5 s cache); a cold portfolio read is ~17 RPC
  calls (multicall once confirmed on Monad testnet; 3 s cache backstop). Kuru has no mark/index;
  `last` is the latest finalized 1m close; Gateway depth lags the live book.
- **Event log** is single-process (two replicas would split the file); append failures are logged,
  not raised.
- **Cost basis** misses later fills of resting orders and user-deposited base; shown as
  `complete:false`, never guessed.
- **Scheduler cost:** at 60 s an agent may run 1,440×/day; the guard (min credits, daily cap,
  pause until reset, concurrency) is the safety. In shared-key dev mode one user's agents can
  drain everyone's budget.
- **Presets:** soft rules can't be enforced by the mandate (no side or drawdown field) and are
  reported as `softRules`; `customized` is exact text equality; cohort return depends on
  `deposit` events (Alchemy webhook), so `returnN` may be 0 for a long time.
- **Mixed currencies:** totals add USDC and AUSD as dollars and say "≈ $"; Perpl figures are never
  labelled USDC.
- **Auth:** `/markets` and `/presets` are session-guarded like the leaderboard; making them public
  is a one-line change pinned by a spec.
