# Test audit, 2026-10-09 (Fable)

Read-only audit of every test tier after two production failures that no test caught:

1. Kuru testnet moved to a new market set; our pinned addresses fell out of its catalog.
2. Perpl geoblocks its trading WebSocket from US IPs (451).

## Verdict

The unit suites test Sente's own logic well. The security core is strong:

- `apps/mobile/src/trade/contract.test.ts` runs the real server planner against the real phone verifier.
- The verifiers, the policy property test, the derivation vectors and the indicator references are all checked independently.

Every fake of an external service was written once and is never compared with the live service again, so coverage of external drift is zero.

### Why the failures were invisible

- `packages/venues/src/kuru/adapter.ts` `getMarkets()` intersects the live catalog with the pins and silently drops what doesn't match. `market-data.service.ts` then caches `[]` as a success. `venues.module.spec.ts` even asserts that "Kuru `[]` → ok".
- Pinned addresses live in at least 4 places, with no cross-check:
  - `packages/venues/src/kuru/constants.ts`
  - `services/indexer/src/lib/seeds.ts`
  - `services/indexer/config.yaml`
  - `packages/presets/src/params.ts` (by symbol)
- Perpl: nothing knows 451. A refused handshake surfaces as a generic socket close (`trading.ts`, `ws.ts`), and REST as a generic `PerplHttpError`. Agents connect directly, not through the proxy.
- `packages/venues/src/perpl/enroll.test.ts` still serves the 6-field payload; Perpl's has had 11 fields since 2026-09-11. `enroll.ts` never compares the `types` with the constant.
- `apps/mobile/scripts/web-reload-e2e.ts` scans the bundle for `sente.lol` only at the end, accepts `API_URL=https://api.sente.lol`, and doesn't intercept WebSockets.
- `apps/mobile/scripts/trade-live.ts` accepts `--api https://api.sente.lol`.
- Env drift: ten keys the API reads are on neither list in `infra/api-env.allowlist`, so production always runs on their defaults:
  - `AGENT_SCHEDULER_POLL_SECONDS`, `AGENT_SCHEDULE_MAX_CONCURRENT`, `AGENT_SCHEDULE_MAX_RUNS_PER_DAY`, `AGENT_SCHEDULE_MIN_CREDITS_USD`
  - `AGENT_FILL_POLL_SECONDS`, `AGENT_FILL_MAX_BLOCK_RANGE`
  - `USER_TRADE_ATOMIC_BATCH`
  - `VALUE_HISTORY_TICK_SECONDS`, `VALUE_HISTORY_EVERY_SECONDS`
  - `ANTHROPIC_API_KEY`
- `infra/deploy.sh` carries on when the container never goes healthy, and never runs `smoke.sh`.
- `/health` checks no dependencies.

### Tests that only echo their fake (delete or rewrite later)

- `venues/markets.controller.spec.ts:171-193`
- `credits/credits.controller.spec.ts:294-307`
- `agents/leaderboard/leaderboard.controller.spec.ts:76`
- `agents/agents.controller.spec.ts:1217`
- `packages/venues/src/kuru/constants.test.ts`
- `packages/venues/src/kuru/builder.test.ts:123-148` (a round trip of its own encoding)
- Mobile fetch stubs with invented bodies. Type them with the API DTOs instead.

## Plan

### Tier 1: unit (CI)

Keep the strong suites as they are. After submission:

- move `enroll.test` to the 11-field payload and add a test that refuses a drifted payload;
- add `PerplBlockedError` (451/403, socket closed before the first snapshot);
- type the mobile fetch stubs with the DTOs;
- make jest's global `fetch` throw unless a test opts in;
- delete the echo tests.

### Tier 2: local integration (`pnpm run check:local`, no production)

- **Drift check** (`packages/venues/scripts/drift-check.ts`, read-only, exit 1 on any FAIL):
  - **Kuru catalog vs pins:** address, precisions, tick, tokens and decimals. Reverse direction: list catalog markets we don't pin. Also `eth_getCode` on every pin.
  - **Perpl:** `/pub/context` contracts and markets, and the `/api-key/payload` types, domain and statement vs `PERPL_API_KEY_TYPED_DATA`.
  - **OpenRouter:** `/models` contains `AGENT_MODELS`.
  - **Envio:** `chain_metadata` lag is under 2000 blocks.
  - **Indexer:** its copies of the addresses match the constants.
- **Booted API:** a temporary `STATE_DIR`, starter kit and drips off, real testnet. Then `verify.sh`, `smoke.sh`, and an authenticated `/markets`, tickers and `/leaderboard`.
- **Bundle check:** `expo export --clear` against the local URL, then grep the bundle.
- **`infra/env-check.sh`:** the key names in the laptop `.env` that are allowlisted must equal the names in `/opt/sente/api.env` on the box.

### Tier 3: post-deploy (`infra/live-check.sh`, PASS/FAIL per line, non-zero exit)

**A. Read-only, every deploy:**

1. `verify.sh`, then `smoke.sh` (keep its token for the next checks).
2. Authenticated `/markets`: both venues `ok`, the Kuru symbol set equals the pins, Perpl includes `BTC-PERP`.
3. Tickers fresh (`stale:false`, `asOf` under 60 s old).
4. The drift check.
5. `/leaderboard` source configured, and Envio lag checked.
6. `/trade/capabilities` shows the trading flags as they should be.
7. `--box`, run over `gcloud compute ssh` on the box:
   - direct Perpl trading WebSocket returns 101 (a 451 FAILs as "Perpl geoblocks this region");
   - Perpl REST and Kuru API reachable;
   - the container is healthy and holds the state lock;
   - the env names on the box match the allowlisted laptop names.

`deploy.sh` must stop when the API is unhealthy, and run stage A.

**B. Real flows (`--flows`), one persistent test identity and agent, bootstrapped once.** It is pending approval because it costs one starter kit, a 100 AUSD Perpl account and one agent. Each run:

1. Kuru post-only bid at 50% of the best bid, then cancel.
2. Perpl post-only bid through the proxy, then cancel.
3. One agent run on Kimi, under $0.30.
4. The enclave refusal: an over-cap deposit, signed only, on the production agent.
5. Pre- and post-cleanup assertions and a budget check.

## Priorities

- **Day 1 (no money):** the drift check; `live-check.sh` stage A plus the `deploy.sh` gate; the production-safety guards; `getMarkets` no longer silent (in SEN-185).
- **Day 2:** stage B and `env-check.sh`.
- **After submission:** the tier 1 rewrites.
