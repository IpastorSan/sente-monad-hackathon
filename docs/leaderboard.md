# The agent leaderboard (SEN-26)

`GET /leaderboard` ranks agents by settled performance, with `n` beside every
win rate and the ROI formula printed in the response and in the app.

```
services/api/src/agents/leaderboard/
  indexer.ts               Envio GraphQL client (SEN-25's schema)
  metrics.ts               n / win rate / ROI, and the n < 3 rule
  mandate-summary.ts       one line: venues, markets, largest order
  leaderboard.service.ts   the join, the split, the honest failures
  leaderboard.controller.ts GET /leaderboard
  leaderboard.module.ts    wiring (AgentsModule + the indexer)
apps/mobile/src/agents/leaderboard.ts   row formatting, pure
apps/mobile/src/app/leaderboard.tsx     the screen
```

---

## Configuration

| Variable            | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| `ENVIO_GRAPHQL_URL` | Envio HyperIndex's GraphQL (Hasura) endpoint from SEN-25 |

It is **not in `.env.example` yet** — SEN-27 owns that file.

Unset, the API boots and `GET /leaderboard` answers
`source: { kind: 'unconfigured' }` with no rows and a note saying so, rather
than an empty board or invented numbers. A malformed value fails at boot.

With `services/indexer` running locally (`npx envio dev`), the endpoint is
`http://localhost:8080/v1/graphql`:

```bash
ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql mise exec -- pnpm --filter @sente/api run start:dev
curl -s localhost:3000/leaderboard -H 'x-sente-user-id: 0x…' | jq
```

`GET /leaderboard` keeps the placeholder auth guard (`x-sente-user-id`, like
every other route) until MOV-251 lands. The ranking itself is global — every
active agent, whichever owner hired it — and the service never reads the
principal. **It becomes public later**: a ranking of agents is information
about agents, not about the caller, and dropping the guard is the intended
change, not an oversight. `leaderboard.controller.spec.ts` pins the guard so
that change has to be deliberate.

---

## The metrics, and exactly what each one counts

Published verbatim as `formula` in the response:

> n = settled trades (wins + losses) · win rate = wins ÷ n · ROI = realised PnL ÷ capital deployed

| Metric            | Definition                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `n`               | settled trades: the fills that closed a position. The indexer's `winningTradeCount + losingTradeCount` — each _reducing_ fill, counted by the sign of the delta it produced (`docs/indexer.md` §pnl).                                                  |
| `wins`            | `winningTradeCount`, summed over the agent's venue accounts.                                                                                                                                                                                           |
| `winRate`         | `wins / n`, rounded half up at 4dp in integer arithmetic. `null` at `n = 0`: 0/0 is not a perfect record.                                                                                                                                              |
| `realisedPnl`     | `realizedPnlUsd`, summed over the agent's accounts. Signed exact decimal string; fees are NOT netted out (the indexer does not either).                                                                                                                |
| `capitalDeployed` | the stablecoin **net flow** into the venues: every 6-decimal `AccountBalance`'s `net` (`deposited − withdrawn`), summed. MON is 18dp, is gas, and is never capital. A negative total clamps to 0, so a partial sync cannot flip the sign of every ROI. |
| `roi`             | `realisedPnl / capitalDeployed`, rounded half up at 4dp. `null` when there is no capital to divide by.                                                                                                                                                 |

Everything is summed with `BigInt` and a scale — a float only ever appears
after the digit has been decided (`metrics.ts`). The one mixed-unit caveat, and
it is in the response's `notes` too: Kuru's PnL is USDC and Perpl's is AUSD.
Both are 6-decimal stables on Monad testnet and the indexer's own `*Usd` field
names treat them as one unit; this sums them the same way.

### The `n < 3` rule

`MIN_RANKED_TRADES = 3`. Rows below it are returned in `tooFewTrades` — never
hidden, never ordered — because at two trades a win rate is noise and a board
that orders noise teaches its readers to trust it. Ranked rows are ordered by
ROI, then win rate, then `n` (a bigger sample outranks a smaller one at the
same rate), then name. A row with no ROI (no capital deployed) sorts below
every row that has one.

### Three sources, two denominators

| Source                 | What it contributes                                                                |
| ---------------------- | ---------------------------------------------------------------------------------- |
| the indexer (SEN-25)   | `n`, wins, losses, fills, realised PnL, capital deployed — the **ranked** numbers  |
| the event log (SEN-22) | `theses: { settled, held, open }` — a per-**thesis** reading, shown beside the row |
| the agent store        | name, model, mandate summary                                                       |

The two readings are deliberately **not** blended: a thesis settles only when
its own fills close it (`held` is a boolean), while `n` counts reducing fills,
and dividing one by the other would be a number with no meaning. Both travel
with their own denominators so a reader can see they disagree.

Revoked agents are left out: their mandate is empty and they cannot trade
again. `AgentStore` is read through `listActive()` for the same reason.

---

## Honesty rules this file exists to record

- **No rows when the numbers cannot be verified.** An unreachable or
  unconfigured indexer answers with empty lists and `source.kind`, never with
  zeros: "0 trades" and "we could not read the indexer" are different claims,
  and only one of them is about the agent.
- **A malformed indexer row is refused** (`IndexerQueryError`), not coerced.
  A missing `realizedPnlUsd` read as `0` would put a number we cannot stand
  behind on a board whose whole point is that its numbers are real.
- **The URL is never echoed** in a response: an Envio endpoint may carry a
  token in its query, and `fetch`'s own failure message is the bare
  `fetch failed`.
- **Testnet samples are thin.** The last note in every response says so. A win
  rate over four trades is a fact about four trades.

---

## Verification

| Check                                              | Command                                               | State                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API typecheck                                      | `mise exec -- pnpm --filter @sente/api run typecheck` | pass                                                                                                                     |
| API specs (metrics, n < 3, client, service, route) | `mise exec -- pnpm --filter @sente/api run test`      | pass (43 leaderboard, 513 total)                                                                                         |
| Mobile specs (row formatting)                      | `mise exec -- pnpm --filter @sente/mobile run test`   | pass                                                                                                                     |
| Root typecheck / lint                              | `mise exec -- pnpm run typecheck`, `… run lint`       | pass                                                                                                                     |
| Live query against a running indexer               | `envio dev` + `curl localhost:3000/leaderboard`       | **not run** — no Envio deployment and no `ENVIO_API_TOKEN` (SEN-25 §hypersync), so there is no endpoint to point this at |

**What is not proven:** the GraphQL document has been executed only against the
recording `fetch` in `indexer.spec.ts`. `docs/indexer.md` records the same
caveat for its own queries — **no Envio deployment exists**, so the query is
written against the generated schema (`Account`, `balances`, `_in`, `limit`)
but has never been answered by Hasura. The first thing to do once the indexer
is deployed is run it and compare one agent's `n` against the Ledger's own
fills.

Related: `docs/indexer.md` (the entities and their semantics),
`docs/agents.md` (the mandate and the venue accounts).
