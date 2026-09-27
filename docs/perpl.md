# Perpl — the perps leg

The adapter lives in `packages/venues/src/perpl/` and is exported as `@sente/venues/perpl`. How
agents enroll keys and trade through it is in [agents.md](agents.md); addresses and onboarding
costs are in [monad-testnet-assets.md](monad-testnet-assets.md). This page records what Perpl's
**public market data** actually does, because `PerplBookFeed` (SEN-64) was built before anyone had
looked.

The upstream reference is `PerplFoundation/api-docs` (`websocket.md`, `rest-endpoints.md`,
`types.md`; read at commit `25ab6e2`, 2026-09-25). Where that repo and a live frame disagree, the
frame wins; so far they agree.

## Market data, probed — SEN-62 (plan B-T1), 2026-09-28

**Method.** `packages/venues/scripts/perpl-feed-probe.ts`, read-only against testnet
(`wss://testnet.perpl.xyz/ws/v1/market-data`, `https://testnet.perpl.xyz/api`), no credentials:

```bash
cd packages/venues
mise exec -- node --no-warnings scripts/perpl-feed-probe.ts [--seconds=120] [--skip-limit]
# or: mise exec -- pnpm run probe:perpl-feed
```

It makes 6 REST reads, then holds socket A with **one** subscribe frame listing `order-book@<id>`
for each of the 7 open markets plus `market-state@10143` and `funding@10143`, sends nothing else
until 10 s before the end, and logs each frame's `mt`, `sid`, `sn` and size. Socket B then tests
the request limit (see (b)). Three runs:

| Run | Socket A held        | What it was for                                                    |
| --- | -------------------- | ------------------------------------------------------------------ |
| 1   | 1,405 s (23.4 min)   | idle behaviour, and one funding event arriving live; socket B      |
| 2   | 150 s                | maintained book vs REST book level by level; one bare re-subscribe |
| 3   | 20 s, `--skip-limit` | re-subscribe vs unsubscribe + subscribe in one frame               |

Testnet markets on the day: BTC 16, ETH 32, SOL 48, MON 64, ZEC 256, LIT 272, PUMP 320, all open.
`market-state` and `funding` also report 288 and 304, which `/pub/context` does not list.

### (a) After the snapshot: deltas, `mt:16`

Each subscribe gets one `mt:15` snapshot per stream, and after that only **`mt:16` L2BookUpdate**
frames. Run 1 had 7 snapshots and 2,755 updates in 23.4 min (about 2 a second across 7 markets,
1.2 KB/s), plus 2,820 `mt:9` market-state frames.

- An update has the snapshot's shape but lists **only the changed levels**, up to 16 a side. A level
  replaces the one at the same price, and **`s: 0, o: 0` removes it** (26,827 removals in run 1).
  Sides are sorted best first, like the snapshot.
- **A quiet market sends nothing.** In a 15 s trial run before these three, ETH sent no update at all. A book with no
  update is still current as long as its subscription is live.
- **`sn` is the block number** (`sn === at.b` on all 2,762 frames checked), not a per-stream
  counter, so it cannot detect a missed update. Watching for a closed socket is the only defence.
- **Proof that the deltas are applied correctly.** Run 2 kept BTC's book from its snapshot and
  150 s of updates using `applyL2BookUpdate`, then fetched the REST book: **both were at block
  66254723, and the first 100 bid and all 12 ask levels were identical.** The socket book had 113
  bids and REST had 100, so the REST book is truncated.
- **Asking again for a stream you already hold.** A bare re-subscribe is acked (`mt:6`, same
  `sid`) and sends **no** new snapshot (run 2). An unsubscribe and a subscribe **in one frame**
  (`[{stream, subscribe:false}, {stream, subscribe:true}]`) is acked twice with the same `sid` and
  **does** send a fresh `mt:15` (run 3).

### (b) What counts against 10 requests/min

A **frame** counts as a request. A stream inside a frame does not. Socket B sent one frame
carrying all 7 order-book streams, then 10 single-stream re-subscribes one second apart: **11
frames in about 10 s, all 11 acked, and the socket was not closed.** If each stream counted, that
would have been 17 requests. Upstream says going over the limit closes the socket with
`1008 too many requests`.

Sending 11 frames did not trigger that close, so this testnet server accepted at least 11. It may
also not count re-subscribes of a stream it already holds. The probe stops at 11 on purpose, so
the exact threshold was not measured. Budget against the documented 10.

### (c) Idle disconnect: none, and no pings needed

In run 1, socket A sent **nothing after its subscribe for 23.4 min** and was never closed. The
market-data subscriptions sent no `mt:100` heartbeat, because heartbeats come only on
`heartbeat@<chain>`, which the probe did not subscribe to. Upstream agrees: "Market-data connections
do not need `mt: 1` at all". Node's `WebSocket` answers protocol-level pings automatically, and
the `1008 idle timeout` (10 s on testnet) applies to the trading socket's sign-in.

### (d) Funding: two public REST paths, and it is already in `/pub/context`

| Path                                                   | Returns                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/market-data/:market_id/funding/:from-:to` | `{mt, at, m, d: FundingEvent[]}`, oldest first, ≤ 1024 intervals per call                                 |
| `GET /api/v1/market-data/funding/:from-:to`            | `{mt, at, d: {[marketId]: FundingEvent[]}}`, all markets; ≤ 128 intervals; markets with no history absent |

`from`/`to` are epoch **ms**, matched against the time a rate **applies**. Neither needs
authentication. Live, BTC over 24 h:

```json
{
  "at": { "b": 66245259, "t": 1790548247000 },
  "feb": 66245259,
  "rate": 30,
  "idx": 844713,
  "ppl": 25,
  "sum": 117111,
  "div": 1
}
```

- `rate` is in **micros per funding interval**: `30` means 0.003% per interval. On testnet every
  market has `funding_interval_sec: 2580` (43 min). The observed gap between two events was
  2,643 s, because the interval is really fixed in blocks (`funding_interval_blocks`).
- `idx` is the index price, scaled by `price_decimals`. `ppl` is the payment per lot, and `sum`/`div`
  are the cumulative funding sum.
- **Every market in `GET /v1/pub/context` already has its latest event as `funding`**, next to
  `funding_interval_sec`. Neither field is in `PerplMarket` in `wire.ts` yet.
- On `funding@<chain>`, one interval produces two `mt:10` frames. In run 1 the rate for block
  66253830 was published about 78 blocks early with an estimated `at.t` (`…890946`), then again at
  that block with the exact `at.t` (`…890000`). The frames are keyed by market id, like the
  all-markets REST call.

**Wired in SEN-145: `TickerDto.funding`, and the agents' `get_funding` tool reads it.** It costs no new request. In
`PerplMarketReader.#ticker`, read `m.raw.funding` and `m.raw.funding_interval_sec` from the
context it already caches, then set `rate = fromScaled(funding.rate, 6)`,
`intervalHours = funding_interval_sec / 3600` and `nextAt = funding.at.t + funding_interval_sec *
1000`. That `nextAt` is an estimate, because the interval is counted in blocks. It also means
adding `funding` and `funding_interval_sec` to `PerplMarket`. Use the REST paths only for history,
such as a funding chart or the Funding Harvester's look-back.

### (e) `state.orl` is the oracle price, and it is the index to show

`types.md` names `orl` "Oracle price" and `FundingEvent.idx` "Index price". They are different
numbers: `idx` is fixed once per funding interval, while `orl` moves every block. When the run 1
funding event was published, `idx` sat within **0.06%** of the same block's `orl` on all 9 markets.
For example, BTC was 84,219.2 against 84,228.5, and SOL was 121.51 against 121.52. About 22 min into
the previous interval, an `idx` had drifted up to 1.5% away from `orl` (market 304). So `orl` is the live index,
and `PerplMarketReader` keeps mapping `TickerDto.index` from it. `idx` belongs to the funding
object.

### (f) `balanceCNS` units: not probed

This needs the dev account's credentials (`PERPL_DEV_*`), and they were not in the probe's
environment, so it was skipped. `scripts/perpl-live.ts` already prints `balanceCNS` formatted with
the collateral's 6 decimals next to the socket's balances. Comparing the two there answers it.

### What changed in code because of this

- `applyL2BookUpdate` (`packages/venues/src/perpl/book.ts`) and `MT.L2BookUpdate = 16`.
- `PerplBookFeed` folds in `mt:16` by default through `DEFAULT_DELTA_HANDLERS`.
- `PerplBookFeed` counts a subscribed book as fresh while the socket is live, so quiet markets no
  longer look stale.
- `PerplBookFeed` refreshes a stale book with unsubscribe + subscribe in one frame, because a bare
  re-subscribe brings no snapshot.
- `PerplBookFeed` sends no pings by default (`pingIntervalMs: 0`), which frees 2 of the 10
  requests a minute.
- The `orl` → `index` comment in `PerplMarketReader` is now confirmed. The doc comments in `rest.ts`
  and `ws.ts` that said Perpl has no REST book have been corrected.
