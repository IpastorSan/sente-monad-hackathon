# OpenRouter: per-user credit keys and the Kimi tool-use probe (MOV-279)

## Credits are OpenRouter keys

Each user gets their own OpenRouter API key, minted through the Management API with a **hard USD
limit that does not reset** — a one-off allowance, not a monthly refill. That is the whole credit
system. OpenRouter meters usage and enforces the limit, so we build no metering of our own.

| Piece                                                | What it does                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api/src/credits/openrouter.client.ts`      | `fetch` client over `https://openrouter.ai/api/v1/keys`: `createKey`, `getKey`, `updateKey`, `deleteKey`. Authenticated with `OPENROUTER_MANAGEMENT_KEY`.                                                                                                                       |
| `services/api/src/credits/store/credit-key-store.ts` | `CreditKeyStore` + `CREDIT_KEYS` token, **first write wins**. With `STATE_DIR` the keys persist, sealed under `AGENT_SECRETS_KEY`, in `credit-keys.json` (`file-credit-key-store.ts`) or the `credit_keys` table (`sqlite-credit-key-store.ts`, SEN-204); in memory without.    |
| `services/api/src/credits/credits.service.ts`        | `provision` (idempotent), `status`, and `keyFor(userId)`, which is **server-only**.                                                                                                                                                                                             |
| `services/api/src/credits/credits.controller.ts`     | `POST /credits/provision` → `{limitUsd, remainingUsd, usageMonthUsd, resetsAt, created}`; `GET /credits/plans`, `POST /credits/purchase`, `GET`/`PUT /credits/auto-top-up` (SEN-183). Every route sits behind `SessionAuthGuard` and uses the same principal seam as `wallet/`. |
| `services/api/src/credits/usage/`                    | `GET /credits` (SEN-183): the free tier, how it resets, and an estimated breakdown by agent and run from the SEN-178 transcripts. Its own module, because `AgentsModule` imports `CreditsModule`.                                                                               |
| `services/api/src/credits/purchase/`                 | The plans, the request checks, the `CREDITS_PURCHASES_ENABLED` flag and the `CreditPayments` seam (SEN-183). No payment is implemented.                                                                                                                                         |

The plaintext key (`sk-or-v1-…`) comes back **only** in the create response. The store keeps it,
and only `CreditsService.keyFor` hands it out, to the agent runner. No HTTP response and no log line
ever carries it. The controller builds each response field by field from a view type that has no key
and no hash, and a spec asserts this on the serialised JSON.

Every provisioned key is created with `limit: OPENROUTER_DEFAULT_LIMIT_USD` (default 10, the free
tier; 5 before SEN-183), `limit_reset: null` (`FREE_TIER_RESET` in `credits.service.ts`),
`include_byok_in_limit: true`, `name: sente:<userId>` and `external: { user: <userId> }`.
OpenRouter echoes the last one back as `external_user`.

## The free tier and buying credits (SEN-183)

Sente does not pay for users' AI beyond a free tier: **10 USD of model credits, once**, on us, on
the user's own key — a one-off allowance, not a monthly refill. A user who spends through it is
meant to buy more (next section), but that purchase flow is **flagged off for the testnet demo**
(`CREDITS_PURCHASES_ENABLED`): today the key just stays exhausted until it is raised by hand.

**What the limit actually is.** The key's `limit` is a hard USD cap that OpenRouter enforces; with
`limit_reset: null` OpenRouter never resets the key's usage counter, so `limit_remaining = limit −
usage` falls to zero once the 10 USD is spent and stays there — there is no reset to bring it back.
A run that would go past the cap gets OpenRouter's 402 and ends `credits_exhausted`; the scheduler
also skips scheduled runs while less than `AGENT_SCHEDULE_MIN_CREDITS_USD` (0.10) is left. `GET
/credits` reports whichever reset the key actually carries, so a key minted before this was a
one-off (`limit_reset: 'monthly'`) still reports `monthly` honestly until it is migrated (next
paragraph).

**Existing keys.** A key minted under the old 5 USD default, or still carrying the old monthly
reset, is raised and converted to the one-off free tier the first time the API reads it (`GET
/credits`, the scheduler's credit check, a run's provision): one `PATCH /keys/:hash {limit,
limit_reset: null}`, with `limit` sent as `max(current, target)` so it is never lowered — a key
already at or above the target that only needed its reset converted keeps its own limit. It only
ever raises or converts, and only for a key that is ours (`sente:` name) and enabled, and either
below the current default or still resetting monthly; a failed PATCH is logged and not retried by
that process. To cap one user below the free tier, disable their key rather than lowering its
limit, or the next read raises it again.

**`GET /credits`** → the four original fields, plus:

| Field         | Meaning                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tier`        | `free` — every user, until purchases open.                                                                                                                      |
| `provisioned` | `false` until the first run mints a key. Reading never mints; the answer is the untouched free tier.                                                            |
| `mode`        | `shared` on a dev server where every user draws on one key (the numbers are everyone's).                                                                        |
| `usedUsd`     | OpenRouter's meter for this window — exact.                                                                                                                     |
| `reset`       | `{period, resetsAt, rollover: false, summary}`, from the key's own `limit_reset`.                                                                               |
| `usage`       | `estimated: true`. By agent (this window) and the 20 newest runs, from the run transcripts. `unattributedUsd` is the meter less what the held runs account for. |

The breakdown is an estimate on purpose: the transcripts keep only the last 10 runs per agent
(SEN-178), and a run's cost is the sum of OpenRouter's per-response `usage.cost`.

**`GET /credits/plans`** → packs of 10, 20 and 50 USD, a custom amount (5–500 whole USD), auto
top-up options (threshold 1/2/5 USD, amount 10/20/50 USD), the payment assets (USDC, AUSD) and
`purchasesEnabled` from `CREDITS_PURCHASES_ENABLED` (off unless `1`/`true`), with `note` saying why
when it is off. `POST /credits/purchase` (`{plan: 'pack_20'}` or `{plan: 'custom', amountUsd}`) and
`PUT /credits/auto-top-up` refuse:

| reason                 | HTTP | when                                                        |
| ---------------------- | ---- | ----------------------------------------------------------- |
| `purchases_disabled`   | 403  | the flag is off — checked before the body is read           |
| `purchase_invalid`     | 400  | the flag is on and the plan or amount is not one we sell    |
| `payments_unavailable` | 501  | the flag is on and no payment rail is bound (today, always) |

**The payment seam** (`purchase/credit-payments.ts`, `CREDIT_PAYMENTS`, bound to
`NoCreditPayments`). The rail it is shaped for: the app makes a sponsored send of the pack's USD in
USDC or AUSD from the user's Privy wallet to the treasury and hands the API the UserOperation hash;
the API confirms it from the bundler's UserOperation receipt (`success` on the operation, never the
carrying transaction — CLAUDE.md gotcha 8), checks token, amount, sender and recipient from the
Transfer log, and only then raises the key's `limit` by the amount through `updateKey`, keyed by the
UserOperation hash so a retried confirmation never credits twice. Auto top-up is the same, started
by the server under the threshold; it needs a standing authorisation to move the user's funds (a
Privy policy rule scoped to the treasury, with a monthly cap), which is not designed yet.

Refusals (`credits.errors.ts`) are part of the API contract:

| reason                 | HTTP | when                                                                                |
| ---------------------- | ---- | ----------------------------------------------------------------------------------- |
| `credits_unconfigured` | 503  | `OPENROUTER_MANAGEMENT_KEY` unset                                                   |
| `not_provisioned`      | 404  | internal reads before the first mint (`GET /credits` answers the free tier instead) |
| `provision_failed`     | 502  | OpenRouter would not mint the key                                                   |
| `status_unavailable`   | 502  | OpenRouter could not report the key's usage                                         |

Concurrency: concurrent provisions for one user in one process share a single mint. Across
replicas, the store's first-write-wins `claim()` decides the winner, and the loser **deletes the key
it just minted** so no orphan with budget attached is left behind.

Caveat, closed in production by SEN-204: without `STATE_DIR` the store is in memory and lost on
restart, while the keys live on at OpenRouter, so a restart followed by a provision mints a second
key for that user — a free top-up. The first key is orphaned but still capped by its own limit. With
`STATE_DIR` the binding survives, sealed at rest.

### Management API facts (from OpenRouter's OpenAPI spec, 2026-09-11)

- Bearer auth only: `Authorization: Bearer <key>`. This holds for `/keys*` and for `/messages`
  alike; the spec declares no `x-api-key` scheme.
- `POST /keys` → `201 {key, data}`. Only `name` is required. `expires_at` must be ISO-8601 **with
  seconds**.
- `GET /keys/:hash` and `PATCH /keys/:hash` → `{data}`. `DELETE /keys/:hash` → `{deleted: true}`.
- Every `limit`, `limit_remaining` and `usage*` field is in **USD**.
- Resets happen at 00:00 UTC. Weeks run Monday to Sunday; monthly limits reset on the 1st.

## The probe

`services/api/scripts/openrouter-probe.ts` mints a throwaway key with a $1 limit that self-expires
after 1 h, then runs two targets:

- **(a)** the Anthropic model. The default is `anthropic/claude-sonnet-5`; override it with
  `PROBE_ANTHROPIC_MODEL` once the runner (MOV-283) fixes its default.
- **(b)** `moonshotai/kimi-k2.6` with `provider: { order: ['Moonshot AI'], allow_fallbacks: false }`.

Each target gets one tool (`get_price`) over two turns (tool_use → tool_result → final answer),
then one call with `thinking: { type: 'adaptive' }`. After each target the probe reads the key's
`usage` back via `GET /keys/:hash`. It deletes the key in a `finally`.

### First attempt, 2026-09-11: no credentials

`OPENROUTER_MANAGEMENT_KEY` was not set in `sente/.env` then; the probe exits 0 and prints
`pending credentials: OPENROUTER_MANAGEMENT_KEY not set`. The tool-use half ran two days later on
an inference key ("Verified live" below), and per-user provisioning has run in production since the
Credits page shipped on 2026-10-09 (SEN-183).

To run it once the key exists (create it at https://openrouter.ai/settings/management-keys, put it
in the repo-root `.env`, never print it):

```bash
mise exec -- pnpm --filter @sente/api run probe:openrouter
```

It prints a JSON report. Copy it into the table below and replace this section's heading:

| Target                      | Tool round-trip | Final answer used tool_result | `thinking: adaptive` | Cost (key usage delta) | Served by |
| --------------------------- | --------------- | ----------------------------- | -------------------- | ---------------------- | --------- |
| `anthropic/claude-sonnet-5` | pending         | pending                       | pending              | pending                | pending   |
| `moonshotai/kimi-k2.6`      | pending         | pending                       | pending              | pending                | pending   |

**If Kimi fails over `/messages`, record it here plainly.** Then Kimi needs an OpenAI-compatible
`chat/completions` path instead, which is Phase 5, the KIMI bounty. OpenRouter's own blog says
non-Anthropic models "aren't supported through the native endpoint" for Claude Code. That is why
this is a probe rather than an assumption.

What we know without credentials (public `GET /api/v1/models`, 2026-09-11):

- `moonshotai/kimi-k2.6` is listed, and its `supported_parameters` include `tools`, `tool_choice`
  and `parallel_tool_calls`. That says the model supports tools. It says nothing about whether they
  survive the Anthropic-shaped endpoint.
- The Anthropic ids listed include `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`,
  `anthropic/claude-fable-5.1` and `anthropic/claude-haiku-4.5`.
- `/v1/messages` accepts OpenRouter's `provider` routing object, and only `model` and `messages`
  are required.

## Anthropic SDK against OpenRouter (for MOV-283)

`@anthropic-ai/sdk@0.125.0`:

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://openrouter.ai/api', // the SDK appends /v1/messages
  authToken: userKey, // -> Authorization: Bearer <key>
  apiKey: null, // load-bearing, see below
});
```

- `apiKey: null` is **required, not cosmetic**. Left `undefined`, the SDK falls back to
  `process.env.ANTHROPIC_API_KEY` and would send a real Anthropic key to OpenRouter in an
  `X-Api-Key` header. With `null`, `apiKeyAuth` returns no header.
- Likewise, an `undefined` `authToken` falls back to `ANTHROPIC_AUTH_TOKEN`. With neither set, the
  SDK tries to resolve credentials from config files. Always pass the user's key explicitly.
- OpenRouter-only body fields (`provider`) are not in the SDK's types. Pass them through a
  `MessageCreateParamsNonStreaming & { provider?: … }` value; the SDK serialises the whole params
  object. OpenRouter adds `usage.cost` (USD) and a top-level `provider` to each response.
- The SDK is exact-pinned, and `pnpm-workspace.yaml` lists it in `minimumReleaseAgeExclude`. It was
  published less than a day before it was added, and pnpm 12's release-age gate otherwise fails
  every pnpm command on the lockfile, `pnpm exec` included.

## Verified live — 2026-09-13 (tool-use round trips)

Run with an OpenRouter **inference** key (not a management key — see below), through the Anthropic SDK pointed at
`https://openrouter.ai/api` with `authToken` set and `apiKey: null`. One tool (`get_price`), two turns
(tool_use → tool_result → final answer), `max_tokens: 1024`.

| Model                                                                              | Tool round trip                      | Final stop | Thinking blocks returned                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic/claude-sonnet-5`                                                        | ✅ `get_price {"symbol":"MON-USDC"}` | `end_turn` | no                                                                                                                                |
| `anthropic/claude-sonnet-5` + `thinking: {type:'adaptive'}`                        | ✅                                   | `end_turn` | **no** — the parameter is accepted but no thinking block came back, so pass-through is unproven; keep `AGENT_RUNNER_THINKING=off` |
| `moonshotai/kimi-k2.6`, `provider: {order:['Moonshot AI'], allow_fallbacks:false}` | ✅                                   | `end_turn` | yes                                                                                                                               |
| `moonshotai/kimi-k2.6`, any provider                                               | ✅                                   | `end_turn` | yes                                                                                                                               |

**Kimi tool calls do round-trip through `/api/v1/messages`**, despite OpenRouter's blog saying non-Anthropic models
"aren't supported through the native endpoint" for Claude Code. So the runner works with Kimi as-is, and no
`chat/completions` path is needed for the KIMI bounty. Latency was 2.4–4.2 s per two-turn trial.

### Kimi's speed on a real run — SEN-209

A runner-shaped request (the 21 tools, the preamble, a Range Trader prompt and a heartbeat wake,
`max_tokens: 16384`), replayed with canned tool results on 2026-10-13 through Moonshot's endpoint:

| Turn                                 | Output tokens (reasoning included) | Time    |
| ------------------------------------ | ---------------------------------- | ------- |
| Read (`get_klines`, `list_watchers`) | 210–960                            | 4–15 s  |
| Plan (`set_watchers`, end of run)    | 1,000–2,650                        | 14–41 s |

That is about 65 tokens/s, every turn reasons, and a three- or four-turn trial took 32–57 s
where a trading run takes up to twelve turns. On the 180 s budget Sonnet runs in, every scheduled Kimi
run that day timed out, so Kimi has its own budget (`AGENT_RUN_TIMEOUT_MS_KIMI`, 480 s). What did
not help:

- `reasoning: {effort: 'low'}`, `{max_tokens: 1024}` and `{enabled: false}` on `/v1/messages`: Kimi
  still reasoned 300–2,500 tokens a turn.
- `provider: {sort: 'throughput'}` landed on CoreWeave: about 180 tokens/s on one trial, 47 on the
  next, so it is no steadier than the Moonshot pin.

the key in `OPENROUTER_MANAGEMENT_KEY` was an inference key
(`GET /api/v1/key` → `is_management_key: false`, $10 limit), so `POST /api/v1/keys` returned
`401 Invalid API key` and `probe:openrouter` failed at its first step. A management key comes from
**Settings → Management keys** at https://openrouter.ai/settings/management-keys; production has one,
and mints each user's key with it (the Credits page, SEN-183, live since 2026-10-09).

## Shared-key dev mode — SEN-18

Set `OPENROUTER_API_KEY` (an ordinary inference key) and leave `OPENROUTER_MANAGEMENT_KEY` unset:

- `CreditsService.keyFor` hands every user that one key; nothing is minted or stored.
- `provision` and `status` read `GET /api/v1/key` — the shared key's own limit and usage, i.e. everyone's budget.
- The API **refuses to boot** in this mode when `NODE_ENV=production`; if both variables are set, per-user mode wins.
- `agent:run-live`, `demo:refusal -- --mode model` and `probe:openrouter` all accept it (no minting, no key deletion).
- `costUsd` from the key's usage delta blurs when runs overlap; the per-response `usage.cost` sum stays exact.
