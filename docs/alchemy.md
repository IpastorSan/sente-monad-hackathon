# Alchemy on Monad testnet — SEN-30

Code: `services/api/src/webhooks/` (the module), `services/api/src/main.ts` (one line,
the raw-body middleware), `services/api/src/agents/agents.service.ts#watchForDeposits`
(the best-effort registration on hire). Variables: `.env.example`, section
"Alchemy Notify webhook".

Two pieces, kept apart on purpose because they are different kinds of thing:

1. **The RPC** is configuration. Every HTTP chain read in the API already resolves
   through `MONAD_TESTNET_RPC_URL`, so pointing it at Alchemy is one line in `.env`
   and no code. It is product insurance against the public RPC's rate limit during
   a demo, not a bounty claim.
2. **The webhook** is a feature. `POST /webhooks/alchemy` appends a `deposit` event
   to a hired agent's Ledger the moment funds reach its wallet, instead of the
   deposit appearing only when something next polls.

> **WHAT HAS AND HAS NOT BEEN RUN.** As of 2026-09-24 there is **no Alchemy
> account**. Everything below was built and specced against fakes and the
> documentation cited inline; the route was exercised live against a locally booted
> API with a signing key of our own (transcript in "What was verified locally").
> **No real Alchemy delivery has ever reached this code, and no real Alchemy RPC
> URL has ever been used.** The runbook is what closes that gap; until someone
> follows it, treat the live half as unproven.

---

## Privy's gas sponsorship runs on Alchemy. That is NOT this integration.

Worth writing down before anyone finds it and draws the wrong conclusion. When an
agent's Privy wallet sends a sponsored transaction, Privy's response carries
`sponsorship_provider: "alchemy"` — Privy's gas sponsorship is powered by Alchemy
underneath.

**That is Privy's plumbing, and Sente has no part in it.** We hold no Alchemy
account there, configure nothing, pay nothing and see nothing but that one string in
a response body. It is not an Alchemy integration of ours and must never be
presented as one. Sente's own Alchemy surfaces are exactly three, and only these:

| Surface                               | Variable(s)                                                                             | State                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Monad testnet RPC                     | `MONAD_TESTNET_RPC_URL`                                                                 | code-ready, one line; public RPC today                                            |
| Notify Address Activity webhook       | `ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_NOTIFY_AUTH_TOKEN`, `ALCHEMY_NOTIFY_WEBHOOK_ID` | built and specced, never run live                                                 |
| Gas Manager as the ERC-7677 paymaster | `WALLET_PAYMASTER_PROVIDER=alchemy`, `ALCHEMY_RPC_URL`, `ALCHEMY_GAS_POLICY_ID`         | wired before SEN-30 (`wallet/paymaster/erc7677-sponsorship.ts`), never configured |

The third is pre-existing and unrelated to this issue; it is listed so the variable
names near the top of `.env.example` are not mistaken for the webhook's.

---

## Part 1 — the RPC

### Every API chain read already goes through one variable

Verified by reading the code, not assumed. `MONAD_TESTNET_RPC_URL` is read at:

| File                                         | What it points                                          |
| -------------------------------------------- | ------------------------------------------------------- |
| `wallet/wallet.config.ts:183`                | user smart-account reads, balances, sponsorship         |
| `gas/gas.config.ts:218`                      | the MON gas drip                                        |
| `agents/venues/agent-venues.providers.ts:32` | the agents' Kuru and Perpl clients                      |
| `agents/reputation/erc8004.ts:248`           | the ERC-8004 identity and reputation registries         |
| `chain/chain.module.ts:25`                   | the consensus service's `eth_getBlockByNumber` fallback |

Set it and all five move together. The scripts follow (`scripts/fund-agent.ts`,
`agent-venues-live.ts`, `agent-withdraw-live.ts`, `privy-probe.ts`,
`privy-sponsor-probe.ts`, `consensus-watch.ts`, plus `packages/venues/scripts/*` and
`apps/mobile/scripts/claim-ausd.ts`).

### Three things that do NOT follow it, named so nobody is surprised

- **`MONAD_WS_URL`** — the `monadNewHeads` socket (SEN-21). A different transport,
  deliberately separate, and Alchemy's WebSocket endpoint is a different URL
  (`wss://monad-testnet.g.alchemy.com/v2/<API_KEY>`). Moving the HTTP reads does not
  move the socket.
- **`ENVIO_MONAD_RPC_URL`** — read by `services/indexer`
  (`src/lib/accountAddress.ts:219`), never by the API.
- **`EXPO_PUBLIC_MONAD_RPC_URL`** — the mobile app's own endpoint. `EXPO_PUBLIC_*` is
  compiled into the app bundle, so it is public by construction: **an Alchemy URL
  must never go there**, because the key is in the path and would ship inside the
  APK. Leave it on the public node.

### The URL, and why the whole thing is a secret

`https://monad-testnet.g.alchemy.com/v2/<API_KEY>` — the form Alchemy's own Monad
Testnet page prints ([alchemy.com/rpc/monad-testnet](https://www.alchemy.com/rpc/monad-testnet)),
chain id 10143, which matches `ERC8004_CHAIN_ID` and viem's `monadTestnet`. The key
is a **path segment, not a header**, so anyone who sees the URL can spend the
account's compute units. It goes in `.env` (gitignored) and nowhere else: not in a
log line, not in a commit, not in an `EXPO_PUBLIC_` name.

That page also lists what Monad Testnet supports — "RPC API, Block Timestamp API,
User OP Simulation API, Debug API, Bundler API, Websockets, Gas Manager, Webhooks" —
and what it does not: "Transaction receipts API, Prices API, Trace API, Token API,
NFT API, gRPC, Transfers API". Two consequences for us: **Webhooks are supported on
Monad testnet**, and the Transfers API is not, which matters below.

### The measurement the issue asked for, and its honest answer

`docs/erc8004.md` (line 280) records that the read-only ERC-8004 probe "is written
for the public testnet RPC's 15-requests-a-second limit — bulk reads are spaced". The
spacing is `READ_SPACING_MS = 120` in `services/api/scripts/erc8004-live.ts:85`, about
8 requests a second over roughly a dozen reads — so it costs the probe around 1.4 s.

**Not relaxed, and not because it was unmeasurable.** Two reasons, and the second is
the real one:

1. It cannot be measured without an account, which is Ignacio's step.
2. Even with one, `MONAD_TESTNET_RPC_URL` **defaults to the public node** when unset,
   and that is how the probe runs on a fresh checkout. A constant tuned for Alchemy
   would make the probe's default path flaky — half its reads coming back as
   rate-limit errors that read as a broken deployment, which is the exact failure the
   spacing was added to prevent. Relaxing it would mean making it conditional on the
   endpoint, which is more machinery than 1.4 s of sleep is worth.

The measurement is still worth having, so it is step 7 of the runbook: run the probe
both ways and compare the wall time. `eth_getLogs`'s 100-block cap
(`docs/monad-testnet-assets.md:369`) is the limit that actually blocks work — the
indexer backfill — and whether Alchemy lifts it is the interesting number, also step 7.

---

## Part 2 — the webhook

### The route

`POST /webhooks/alchemy`, and it is **public** — the only unguarded route in the API
that writes anything. `SessionAuthGuard` cannot apply: Alchemy is the caller and
carries no Sente session. What authenticates it instead is the HMAC, checked before
anything in the body is looked at. The route is listed in `auth/auth.controller.ts`'s
inventory of unguarded routes, and `webhooks.controller.spec.ts` pins the ABSENCE of
the guard so that removing the signature check cannot quietly leave the route open.

| Case                                               | Answer                             | Alchemy retries?              |
| -------------------------------------------------- | ---------------------------------- | ----------------------------- |
| body over 1 MiB                                    | `413 body_too_large`               | yes — none of it is kept      |
| `ALCHEMY_WEBHOOK_SIGNING_KEY` unset                | `503 webhook_unconfigured`         | yes — and nothing is appended |
| signature missing, forged, or over different bytes | `401 signature_invalid`            | yes — and nothing is appended |
| verified, not JSON / not `ADDRESS_ACTIVITY`        | `200 {ignored}`                    | no                            |
| verified, address is no hired agent's              | `200 {ignored:"no_watched_agent"}` | no                            |
| verified, a hired agent's wallet                   | `200 {appended:N}`                 | no                            |
| verified, a delivery already seen                  | `200 {ignored:"already_seen"}`     | no                            |

Only the two refusals are retried, which is the point: a 4xx or 5xx brings the
delivery back with exponential backoff for up to ten minutes on the free and
pay-as-you-go tiers, so anything a retry cannot fix answers 200.

### The signature — where every detail came from

From Alchemy's **Webhooks Quickstart**
([alchemy.com/docs/reference/notify-api-quickstart](https://www.alchemy.com/docs/reference/notify-api-quickstart)):

- the header is `X-Alchemy-Signature`;
- their own Node sample is
  `crypto.createHmac("sha256", signingKey).update(body, "utf8").digest("hex")` — so
  hex HMAC-SHA256, keyed by that webhook's signing key;
- the body must be the "raw string body, not json transformed version of the body";
- the signing key is **per webhook**: "navigate to the webhooks dashboard, select your
  webhook, and copy the signing key from the top right of that webhook's detail page";
- a listener should answer "200 status code once it successfully receives the webhook
  event", and "Webhooks have built-in retry-logic with exponential backoff for
  non-200 response codes".

Three implementation consequences, each in the code with the reasoning beside it:

- **The raw bytes are preserved narrowly, for this path only.** `main.ts` mounts
  `alchemyRawBody` on `/webhooks/alchemy` _before_ `listen()`, which is what makes it
  narrow: Nest registers its own body parsers inside `app.init()`, so an `app.use()`
  written earlier reaches Express first and only for that path. Every other route
  keeps the parsed JSON it has today. Nest's own `{ rawBody: true }` would have
  buffered a copy of every request to every route.

  What stops Nest parsing it a second time is worth stating exactly, because the
  obvious answer is wrong for this dependency tree: `@nestjs/platform-express` 12
  mounts **body-parser 2.3.0**, which begins `if (onFinished.isFinished(req))`
  (`lib/read.js:39`) and has **deleted** the `req._body` check older guides
  describe (`grep -rn _body node_modules/body-parser` finds nothing). The
  middleware drains the stream, so the request is finished and the JSON parser
  returns untouched. `webhooks.controller.spec.ts` therefore asserts the stream is
  ended rather than asserting a flag nobody reads.

- **The HMAC is over the Buffer, not over `body.toString('utf8')`.** Same bytes for
  any valid UTF-8 body, and it cannot go wrong: a round trip through a JS string
  replaces any byte node cannot decode, and the digest would then be of something
  Alchemy never sent. `alchemy.spec.ts` pins both — that our digest equals the docs'
  sample for a JSON body, and that it differs for a body that is not valid UTF-8.
- **The comparison is constant time and length-checked first.** `Buffer.from('zz',
'hex')` returns an EMPTY buffer, so parsing before checking the shape would make
  garbage compare equal to garbage; a signature that is not 64 hex characters is
  refused outright.

### The payload — where every field came from

From Alchemy's **Address Activity Webhook** reference
([alchemy.com/docs/reference/address-activity-webhook](https://www.alchemy.com/docs/reference/address-activity-webhook)),
whose example delivery is reproduced field for field as the fixture in
`alchemy.spec.ts` (`erc721TokenId`, `erc1155Metadata`, `typeTraceAddress` and all),
with only the network and the addresses changed:

```json
{
  "webhookId": "wh_...",
  "id": "whevt_...",
  "createdAt": "…",
  "type": "ADDRESS_ACTIVITY",
  "event": {
    "network": "MONAD_TESTNET",
    "activity": [
      {
        "blockNum": "0xdf34a3",
        "hash": "0x…",
        "fromAddress": "0x…",
        "toAddress": "0x…",
        "value": 293.092129,
        "asset": "USDC",
        "category": "token",
        "rawContract": { "rawValue": "0x…", "address": "0x…", "decimals": 6 }
      }
    ]
  }
}
```

The docs describe `activity` as the "List of transfer events whose `from` or `to`
address matches the address configured", `id` as the "ID of the event", `value` as the
"Converted asset transfer value as a number", and `blockNum` as hexadecimal. The
parser is strict about the five fields we use (`id`, `type`, and each activity's
`toAddress`, `hash`, `blockNum`) and tolerant about everything else, because Alchemy
adds fields on their schedule, not ours.

**One limitation from the docs, not from us.** The `internal` category is documented as
supported on Ethereum, Polygon, Arbitrum, Optimism, Base, BNB, Avalanche, Robinhood
and Arc — **Monad is not on that list**, and the Monad Testnet page separately says the
Transfers API is unavailable there. So expect `external` (a plain EOA transfer) and the
token categories; a deposit made _by a contract call_ may well produce no delivery at
all. **Step 6 of the runbook is the measurement that settles it**, and until it is run,
this is a documented unknown rather than a claim either way.

### The `deposit` event

`deposit` is a new kind in `AGENT_EVENT_KINDS`, and the only one no tool produces, so
it carries no `runId` and no `tool` — nothing the agent did caused it. Its `detail` is
`AgentDepositDetail`:

```
asset  amount  rawAmount?  from  to  tokenAddress?  decimals?
blockNumber  txHash  category?  network?  deliveryId  dedupeKey
```

`amount` is Alchemy's already-scaled figure, kept as a string so it does not travel as
a float; `rawAmount` is the exact integer word from the log, so nothing downstream has
to trust the float to reconstruct the quantity.

### Idempotency, stated exactly

`dedupeKey` is `txHash:index:toAddress:rawValue`, where `index` is the transfer's
position in `event.activity`. That is stable across Alchemy's retries — a retry
re-sends the same payload, so the same transfer sits at the same index — while still
telling two otherwise identical transfers in one transaction apart. Keys are kept in a
bounded process-local `Set` (10,000, oldest evicted), the same shape
`Erc8004Reputation` uses for published verdicts.

A key is reserved _before_ the append, so two deliveries in flight for the same
transfer cannot both get past it, and **released when the append fails**. That
release is not tidiness: without it a transient log failure would lose the deposit
for good, because the key would stay reserved while the `200 append_failed` tells
Alchemy not to retry, and a later manual replay would read as a duplicate.

Two residual cases, written down rather than hidden:

- The same transfer arriving under a **different delivery id at a different index**
  would not be recognised. That needs a log index, and Alchemy's documented `log`
  object does not carry one.
- The set is lost on restart — but so is the event log (in memory, like every store in
  this API), so after a restart there is nothing left for a re-delivery to duplicate.

### Registration on hire

Each hire adds the new agent's wallet to the webhook's address list, via
`PATCH https://dashboard.alchemy.com/api/update-webhook-addresses` with an
`X-Alchemy-Token` header and a body of `webhook_id`, `addresses_to_add` and
`addresses_to_remove` ("List of addresses to add **(empty array if none)**") — source
[Update webhook addresses](https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/update-webhook-addresses),
which also states the endpoint is idempotent, so a repeated hire needs no bookkeeping
on our side.

It is **best effort and never fails a hire**, exactly like the ERC-8004 registration:
`watchAddress` returns `{ok:false, reason}` instead of throwing, and
`AgentsService.watchForDeposits` logs and moves on. The cost of a failure is that
deposits to that agent do not reach its Ledger until someone adds the address by hand
— a missing feature, never a lost wallet. `hire-watch.spec.ts` asserts the agent is
still `active` for a refusal, an unreachable endpoint, a client that throws, an
unconfigured client and no client at all.

It runs **after** the gas drip, deliberately: the drip is our own MON and is normally
already mined by then, so it does not appear as a user deposit. A drip still pending
when the address is registered could produce one.

---

## The runbook — Ignacio's half

Nothing here can be done without an Alchemy account, and none of it has been done.
Each step names which dashboard value becomes which variable.

### 1. Create the app

[dashboard.alchemy.com](https://dashboard.alchemy.com) → create an app → enable
**Monad Testnet** (chain id 10143).

### 2. The RPC URL → `MONAD_TESTNET_RPC_URL`

Copy the app's HTTPS endpoint. It looks like
`https://monad-testnet.g.alchemy.com/v2/<API_KEY>`.

```
MONAD_TESTNET_RPC_URL=https://monad-testnet.g.alchemy.com/v2/<API_KEY>
```

Whole URL is the secret. Do **not** also set `EXPO_PUBLIC_MONAD_RPC_URL` to it.
Optionally `MONAD_WS_URL=wss://monad-testnet.g.alchemy.com/v2/<API_KEY>` — separate
transport, separate decision, and the fallback already works without it.

Confirm the endpoint before anything else depends on it:

```bash
curl -sS -X POST "$MONAD_TESTNET_RPC_URL" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# expect {"jsonrpc":"2.0","id":1,"result":"0x279f"}   <- 10143
```

### 3. Expose the API where Alchemy can reach it

The webhook is Alchemy calling _us_, so `localhost` will not do. Either deploy, or
tunnel — `ssh -R`, `cloudflared tunnel`, `ngrok http 3000`, whatever is at hand. The
public URL plus `/webhooks/alchemy` is what goes in the dashboard.

**Deploying is now the intended answer** (SEN-51): `docs/deploy.md` puts the API on
`https://api.sente.lol`, so the dashboard URL is
`https://api.sente.lol/webhooks/alchemy` and it stays the same between demos — a
tunnel's URL does not, and every change means re-editing the webhook. Note the
ordering that follows: the webhook cannot be created until the API is public, and
its signing key cannot reach the API until the next `push-secrets.sh` +
`deploy.sh`, so the first deploy necessarily runs with this route answering
`503 webhook_unconfigured`.

### 4. Create the webhook → `ALCHEMY_NOTIFY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SIGNING_KEY`

Dashboard → **Data → Webhooks** → **Create Webhook** → **Address Activity**:

- **Network**: Monad Testnet (`MONAD_TESTNET` is in the API's network enum, so the
  dashboard offers it).
- **Webhook URL**: `https://<your-host>/webhooks/alchemy`
- **Addresses**: one hired agent's wallet, to start. Later hires add themselves.

Then, from that webhook's detail page:

| Dashboard value               | Where it is                                          | Variable                      |
| ----------------------------- | ---------------------------------------------------- | ----------------------------- |
| the webhook's **signing key** | webhook detail page, **top right**                   | `ALCHEMY_WEBHOOK_SIGNING_KEY` |
| the webhook's **id** (`wh_…`) | on the webhook in the list                           | `ALCHEMY_NOTIFY_WEBHOOK_ID`   |
| the app's **AUTH TOKEN**      | Webhooks dashboard, **AUTH TOKEN** button, top right | `ALCHEMY_NOTIFY_AUTH_TOKEN`   |

The signing key and the auth token are **different secrets doing opposite jobs**: the
signing key proves a delivery came _from_ Alchemy; the auth token authenticates _us_
calling Alchemy to add an address. Swapping them fails silently in both directions —
every delivery 401s, and every registration 403s.

Restart the API and check the boot log says both halves are on:

```
[AlchemyConfig] Alchemy webhook enabled: POST /webhooks/alchemy verifies X-Alchemy-Signature …
[AlchemyConfig] Alchemy Notify enabled: each hired agent wallet is added to webhook wh_… …
```

A `WARN` naming a variable means that half is off. Nothing here fails the boot.

### 5. Prove the plumbing before spending any MON

**a.** Dashboard → the webhook → **Test Webhook**. Alchemy sends a sample delivery.
Expect `200 {"received":true,"appended":0,"ignored":…}` — the sample's addresses are
not agents, so nothing is appended; what this proves is that the URL is reachable and
the signature verifies.

**b.** The negative case, which matters more. From any shell:

```bash
curl -i -X POST https://<your-host>/webhooks/alchemy \
  -H 'content-type: application/json' \
  -H 'X-Alchemy-Signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  --data '{"type":"ADDRESS_ACTIVITY","id":"forged","event":{"activity":[]}}'
# expect HTTP/1.1 401 {"statusCode":401,"reason":"signature_invalid",…}
```

If that returns anything but 401, stop and fix it before step 6: the route is public.

### 6. The live half — one real transfer

1. Hire an agent (`POST /agents`). The boot log's Notify line means its wallet was
   added; confirm with `GET /agents/:id` for the address and the dashboard for the list.
2. Send that address something — USDC, AUSD or plain MON — from the phone or
   `scripts/fund-agent.ts`.
3. Within a block or two, `GET /agents/:id/events?kind=deposit` should carry one
   `deposit` with the right asset, amount, sender, block and tx hash.
4. **Record which categories actually arrived.** A plain MON transfer from an EOA is
   `external`; a token transfer is `token`. Then try a deposit _from a contract_ and
   note whether anything arrives at all — that is the `internal`-on-Monad question
   above, and the answer belongs in this file.
5. Re-send Alchemy's delivery (the dashboard shows deliveries and allows a resend) and
   confirm `GET /agents/:id/events?kind=deposit` still shows exactly one.

### 7. Two numbers worth writing down while the key is fresh

```bash
# a) does the ERC-8004 probe still need its 120 ms spacing?
time mise exec -- pnpm --filter @sente/api run erc8004:live            # Alchemy, from .env
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz \
  time mise exec -- pnpm --filter @sente/api run erc8004:live          # public node

# b) does Alchemy lift the public RPC's 100-block eth_getLogs cap? (docs/indexer.md)
curl -sS -X POST "$MONAD_TESTNET_RPC_URL" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0x3e8"}]}'
```

(b) is the one that changes what is possible: the indexer backfill is impractical
today because of that cap (`docs/indexer.md` §hypersync).

### 8. Update this document

Replace the warning at the top with what was actually run, and put the measured
numbers here. A doc that says "specced, not run" after it has been run is worse than
no doc.

---

## What was verified locally, and how

Run on 2026-09-24 against `node dist/main.js` on port 3399, with
`ALCHEMY_WEBHOOK_SIGNING_KEY=whsec_sen30_local_probe` — a key of our own invention, not
Alchemy's. Signatures computed with `openssl dgst -sha256 -hmac`, which is an
independent implementation of the scheme, not ours.

```
$ curl -sS http://localhost:3399/health
{"status":"ok"}

# no X-Alchemy-Signature
-> HTTP 401 {"statusCode":401,"reason":"signature_invalid","message":"X-Alchemy-Signature is missing or does not match the signing key"}

# HMAC of the same body under a DIFFERENT key
-> HTTP 401 {"statusCode":401,"reason":"signature_invalid",…}

# the REAL signature, over a body with "value":25 changed to "value":26
-> HTTP 401 {"statusCode":401,"reason":"signature_invalid",…}

# the correct signature, address belongs to no hired agent
-> HTTP 200 {"received":true,"appended":0,"ignored":"no_watched_agent"}

# correctly signed, but type: "GRAPHQL"
-> HTTP 200 {"received":true,"appended":0,"ignored":"not_address_activity"}

# GET /webhooks/alchemy — no handler
-> HTTP 404

# a 1.1 MB body, correctly signed
-> HTTP 413 {"statusCode":413,"reason":"body_too_large","message":"an Alchemy delivery may not exceed 1048576 bytes"}

# and on a second instance booted with NO signing key:
-> HTTP 503 {"statusCode":503,"reason":"webhook_unconfigured","message":"ALCHEMY_WEBHOOK_SIGNING_KEY is not set, so this delivery cannot be verified and is not accepted"}
```

The fourth case is the load-bearing one: a 200 there means the raw bytes survived
Nest's parser chain and the HMAC was taken over exactly what was sent. The third
proves the bytes, not a re-serialisation, are what is hashed.

Everything else is under `mise exec -- pnpm run test` — signature verification good,
bad and missing; the payload mapping against Alchemy's own example; idempotency on a
repeat; a delivery staying replayable when the log failed; an unknown wallet; the
`503`; the `413`; and hire surviving five different Notify failures. What none of it
proves is that Alchemy's live payload matches the payload their documentation
describes. Only step 6 does that.

---

## Left open

- ~~**The mobile Ledger drops a `deposit`.**~~ **Closed by SEN-50** (2026-09-24):
  `toLedgerEntry` now maps a fifth kind and the Ledger draws the row, reading the
  exact integer from `rawContract.rawValue` rather than Alchemy's scaled float. The
  consensus ramp works for it with no API change, because since SEN-35 the
  controller gates on whether an event names a block, not on a list of kinds.
- **Whether Monad emits anything for a contract-made deposit.** See the `category`
  note above; step 6.4 of the runbook is the measurement.
- **Idempotency is per process.** Two API replicas would each keep their own `Set`
  and could both append one delivery. Single-instance today, and the event log is in
  memory too, so a restart loses both halves together — but a durable log would want
  the key on its own insert (`UNIQUE (agent_id, dedupe_key)`) rather than beside it,
  the way `gas/ledger/drip-ledger.ts` describes for the drip.
