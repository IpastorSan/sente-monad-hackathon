# Privy policy enforcement — what is actually enclave-enforced

Sente's differentiator is that an AI agent's trading mandate is enforced by
hardware the agent does not control. This document records exactly how much of
that claim is true, because the answer is narrower than the marketing and
**wider than one sentence in Privy's docs makes it look**.

## The sentence that misleads

> "Privy enforces some policies at the API level. For example, limiting transfer
> sizes requires transaction simulation which runs outside the enclave today."

Read quickly, this says value caps are not enclave-enforced and our demo is
weaker than claimed. That reading is **wrong**.

The word doing the work is **Transfer** — capital-T, the wallet-action API, not
"a transfer" in the general sense. Privy's Transfer policies page:

> Privy evaluates policies against the original request body sent to the
> `transfer` endpoint **before it prepares the underlying transactions**.

That is a pre-transaction check on a request body, necessarily outside the
enclave because at that moment no transaction exists yet to inspect. It is the
`action_request_body` field source, and it is the only EVM-relevant one with
that property.

## The split

| Field source                  | Fields                                               | Needs chain state?   | Enforced      |
| ----------------------------- | ---------------------------------------------------- | -------------------- | ------------- |
| `ethereum_transaction`        | `to`, `value`, `chain_id`                            | no — verbatim        | **enclave**   |
| `ethereum_calldata`           | `function_name`, `function_name.param` (needs `abi`) | no — local decode    | **enclave**   |
| `ethereum_typed_data_domain`  | `chainId`, `verifyingContract`                       | no                   | **enclave**   |
| `ethereum_typed_data_message` | dot-path into `message`                              | no                   | **enclave**   |
| `ethereum_7702_authorization` | `contract`                                           | no                   | **enclave**   |
| `message`                     | `content`, `byte_length`                             | no                   | **enclave**   |
| `system`                      | `current_unix_timestamp`                             | no                   | **enclave**   |
| `action_request_body`         | Transfer `source.amount`/`asset`, Earn `vault_id`    | **yes — simulation** | **API level** |

Everything enclave-enforced is a verbatim or locally-decodable property of the
payload being signed. Nothing there needs an RPC. The enclave is AWS Nitro with
_"no persistent storage, no interactive access, and no network connectivity"_ —
which is precisely why simulation cannot run inside it, and why anything
requiring chain state necessarily falls outside.

## The architectural constraint this imposes

**Drive every agent transaction through the raw transaction signing path, never
Privy's Transfer wallet-action API.**

This is easy to get wrong: the Transfer API is the more convenient surface, and
reaching for it silently drops the mandate out of enclave enforcement into
API-level enforcement. Same policy object, same dashboard, materially weaker
guarantee — and no error tells you.

## What we can honestly claim

Constrain the agent with `ethereum_transaction.to ∈ {Perpl Exchange, Kuru
Router}`, `chain_id == 10143`, a `value` ceiling, and `ethereum_calldata`
conditions on specific functions and arguments (market address, size parameter).
All enclave-enforced.

The defensible sentence, close to Privy's own wording:

> The mandate is enforced at signing time inside a hardware enclave. A
> compromised client cannot bypass it.

Backed by three explicit statements in their security docs:

> Private keys for wallets are only accessible within the enclave, and can only
> be used to produce signatures compliant with the policies attached to the
> wallet.

> Policies are enforced in the enclave at signing time, so they apply regardless
> of which session or agent initiated the payment.

> …enforced at the moment Privy signs, inside the secure enclave, so a modified
> client cannot bypass it.

That last one describes a recipient allowlist as unbypassable by a modified
client — structurally identical to our demo.

**Do not claim** that a Transfer-API amount limit is enclave-enforced, and do
not describe Mera signing sessions as policy-bearing (they are an in-memory key
with a manual `end()` — no TTL, no cap, no revocation).

**One claim to drop:** a fiat- or asset-denominated cap like "max $500 per
trade" routed through the Transfer API. Express the cap as a `value` bound or a
decoded calldata argument on the raw transaction instead, and it moves back
inside the enclave.

## Use `eth_signTransaction`, not `eth_sendTransaction`

This single choice resolves two separate problems at once, and it is the second
architectural constraint this document imposes.

**Stateful aggregations — which a rolling spend cap requires — are supported on
`eth_signTransaction` and `eth_signUserOperation` only. Not
`eth_sendTransaction`.**

Separately, `eth_sendTransaction` is the sign-and-broadcast path, and it is
exactly where _"transaction simulation runs before policy evaluation"_ — the one
place an unsupported-simulation failure on Monad could bite us.

So signing and broadcasting ourselves unlocks rolling caps **and** sidesteps the
Monad simulation question entirely. We already broadcast through Pimlico's
bundler, so this costs nothing.

## Rolling caps: the concurrency exposure, and how to size it

Privy is explicit that stateful policies are not real-time:

> Aggregation values are updated **after** a request is successfully signed, not
> before. This means multiple concurrent requests may all pass policy evaluation
> before any of their values are recorded. Stateful policies are designed for
> disaster prevention rather than strict real-time enforcement.

**There is no fixed staleness window**, and that is the actual answer rather than
a gap in the research. It is not a cache TTL — the exposure is precisely the
in-flight interval between a request passing evaluation and its value being
recorded after signing. ~~Serial requests are exact.~~ **Measured on 10143, they
are not** (see "Verified live on 10143" below): the recording itself lags the
signature by somewhere between ~0.1 s and 5 s, so even strictly serial signs
overshoot when they come faster than that.

Worst case with N requests in flight: an overshoot of up to
**(N − 1) × per-transaction maximum** above the cap. Two levers, both ours:

- **Drive N to 1.** Serialize the agent's submissions — one in-flight signing
  request at a time. That removes the in-flight race, but not the recording
  lag measured below — also space signs by a few seconds. Natural for a trading agent
  anyway, and we already serialize per-key in the drip relayer for nonce reasons.
- **Shrink the per-transaction max.** Pair the rolling cap with a tight
  per-transaction `value` limit so any breach is bounded and small. Privy's own
  recommended mitigation.

Two mechanics make this better than the warning first reads:

- Evaluation is **forward-looking** — the engine uses the aggregated value _plus_
  the current request, so a single request that would breach the cap is denied
  correctly. Only a burst races.
- **Denied requests still count** toward the aggregate.

Rolling windows accept `duration_seconds` between **3600 (1h) and 259200 (72h)**.
A 24h cap sits comfortably inside, and is Privy's own worked example.

## Still open

- Whether the policy engine's pre-flight simulation supports Monad's chain ID.
  **Largely defused** by choosing `eth_signTransaction`, which keeps simulation
  out of the path. Conditions on `to`/`value`/calldata are chain-agnostic
  regardless.
- ~~None of the enforcement claims here were tested empirically.~~ The refusal
  path was exercised for real on 2026-09-11 — see the next section. The app
  runs Privy's TEE execution mode (confirmed in the dashboard; it is the default).

## Verified live on 10143

SEN-3, 2026-09-11. `services/api/scripts/privy-probe.ts`, which only signs and
**never broadcasts**. Every outcome below is what Privy actually answered; the
two failures are recorded as failures.

```bash
pnpm --filter @sente/api run privy:keys     # the two authorization keys, into .env, unprinted
pnpm --filter @sente/api run probe:privy    # [-- --env-file <path>] [-- --out report.json]
```

**The Privy app is shared.** It is turnstile's app (`<privy-app-id>`),
reused rather than a new Sente app. The probe only _creates_ objects, all named
`sente-probe-…` (the owner quorums "Sente agent key" / "Sente mandate owner"),
and only PATCHes policies it created in the same run. Turnstile's quorums,
policy and wallet were never read or t**Execution mode: TEE.** Confirmed by the app owner in the Privy dashboard on
2026-09-11; TEE execution is Privy's default. The API itself cannot show this:
the wallet object has no execution-mode field (`id, address, display_name,
chain_type, policy_ids, additional_signers, exported_at, imported_at,
archived_at, created_at, owner_id, entity`), and `GET /v1/apps/{id}` returns 59
keys, none of which names TEE, enclave or execution mode. So the dashboard is the
evidence, and "enclave-enforced" is accurate for the field sources listed above.
The two lags below (aggregation, policy PATCH) are real regardless of mode;
don't claim an exact cumulative cap or instant revocation.
er mode.

### Results (run 6 of 6 — earlier runs found the fixes below)

| #    | Check                                                                   | Expected | Got                                           |
| ---- | ----------------------------------------------------------------------- | -------- | --------------------------------------------- |
| 0    | a `to`-only rule signs at all                                           | signed   | signed; signer recovered = wallet             |
| 0a   | `chain_id` + expiry exactly as `@sente/mandate` emits them              | signed   | signed                                        |
| 0b   | same, expiry in the past                                                | refused  | refused                                       |
| 0c   | same, `chain_id` 1                                                      | refused  | refused                                       |
| 0d   | `chain_id` as hex `"0x279f"`                                            | —        | accepted, signed                              |
| 0e   | `chain_id` as decimal `"10143"`                                         | —        | accepted, signed                              |
| 0f   | expiry as hex                                                           | —        | **400 at write** (see finding 1)              |
| 0g   | expiry as decimal                                                       | —        | accepted, signed                              |
| M    | `compileMandate` output (7 rules) accepted as a policy                  | ok       | ok                                            |
| 1    | Kuru `deposit` 5 USDC, under the 10 USDC cap                            | signed   | signed; chain 10143, `to`, signer verified    |
| 1b   | USDC `approve` 5 to AccountCore                                         | signed   | signed; verified                              |
| 2    | `deposit` 11 USDC, over the cap                                         | refused  | refused `policy_violation`                    |
| 3a   | `OrderBook.batch` to the allowlisted MON-USDC (ABI with both overloads) | signed   | signed; verified                              |
| 3    | `OrderBook.batch` to WETH-USDC, not allowlisted                         | refused  | refused `policy_violation`                    |
| 4    | check 1 with `chain_id: 1`                                              | refused  | refused `policy_violation`                    |
| 5a   | rolling cap 15 USDC/1 h: 1st `approve` of 8                             | signed   | signed                                        |
| 5    | rolling cap: 2nd `approve` of 8 **immediately** (16 > 15)               | refused  | **SIGNED — FAILED** (finding 6)               |
| 5+   | rolling cap: another `approve` of 8 after 5 s, and after 30 s           | refused  | refused, refused                              |
| 5d   | the same four with the cap spelled in decimal                           | —        | same pattern: signed, **signed**, refused ×2  |
| 6    | Perpl API-key enrollment typed data                                     | signed   | signed; signer recovered = wallet             |
| 6b   | the same typed data with a different `statement`                        | refused  | refused `policy_violation`                    |
| 6c–h | one enrollment condition at a time (bisection)                          | —        | see finding 4                                 |
| 7a   | PATCH the policy with no signature                                      | 401      | 401 "Missing `privy-authorization-signature`" |
| 7    | PATCH the policy signed by the **agent** key alone                      | 401      | 401 "No valid authorization signatures"       |
| 7b   | PATCH the policy signed by the **mandate-owner** key                    | ok       | ok                                            |
| 7c   | owner lowers the cap to 1 USDC; re-sign the 5 USDC deposit              | refused  | refused on the first try, 336 ms after        |
| 8    | `eth_signTransaction` round trip, p50 of 10 serial calls                | —        | **123 ms** (111–481); runs 3–5: 121, 117, 124 |

Refusals all read `"RPC request denied due to policy violation"`, code
`policy_violation`, status 400 — never which rule or condition decided.

### Findings, and what changed because of them

1. **`system.current_unix_timestamp` must be a decimal string.** Hex is refused
   when the policy is written: `400 invalid_policy_format`, "Condition value
   must be a numerical string value for the current_unix_timestamp field". The
   first run died on this. `unixTimestampLte` in `@sente/mandate` now emits
   decimal. 0a/0b show the decimal bound is really compared.
2. **`ethereum_typed_data_domain.chainId` must be a decimal string** too:
   `400 invalid_policy_format`, "Condition value must be a numerical string when
   using the 'chainId' field". `typedDataChainIdEq` now emits decimal.
3. **`ethereum_transaction.chain_id` takes hex or decimal** alike (0d, 0e), and
   is really compared (0c, 4). Left as hex. Calldata `lte` bounds stay hex, as
   turnstile proved and checks 1/2 re-prove.
4. **A typed-data message condition matches only when its `typed_data.types`
   carries `EIP712Domain` as well as the struct.** With the struct alone (the
   shape SEN-2 shipped) the condition never matched and every enrollment was
   refused — check 6 failed in runs 3 and 4. Bisection: expiry-only,
   chainId-only, verifyingContract-only and `message.signer`-only rules all
   signed (6c, 6d, 6e, 6h); `message.statement` with the struct alone refused
   (6f); the same condition with `EIP712Domain` added signed (6g).
   `PERPL_ENROLL_TYPED_DATA` now derives `EIP712Domain` with viem's
   `getTypesForEIP712Domain`, exactly as the client sends it (Perpl's domain has
   a `salt`, so the domain type has five fields). Check 6 then signed.

   **Correction (2026-09-11, SEN-6):** check 6 signed typed data built from
   `PERPL_API_KEY_TYPED_DATA`, not from a live Perpl payload. By 2026-09-11 the
   live `PerplRegisterApiKey` struct had grown from 6 fields to 11
   (`expiresAt`, `ipCidrs`, `origin`, `builderId`, `maxBuilderFeePer100K`), and
   because the condition's `types` must equal the request's exactly, the first
   real agent enrollment was refused `policy_violation` (docs/agents.md). The
   finding above still holds — `EIP712Domain` must be present — and so does
   its corollary: the struct in the policy must track Perpl's byte for byte.
   The constant is updated; every policy compiled before the change must be
   PATCHed. The rule JSON quoted below shows the old 6-field struct.

5. **Aggregation body: `window.seconds`, not `duration_seconds`** —
   `400 invalid_aggregation_format`, "Required at window.seconds; Unrecognized
   key(s) in object: 'duration_seconds'". `compileRollingCap` fixed. A rule
   references an aggregation as `field_source: "reference"`,
   `field: "aggregation.<id>"` (Privy's own error message spells this out; a
   bare id, or `field_source: "aggregation"`, is refused). The cap is accepted
   in hex or decimal. New builder: `aggregationLte(id, cap)`.
6. **The rolling cap is enforced, but late.** A second `approve` sent right
   after the first (~0.1 s, strictly serial) passed a cap it pushed over; the
   next one, 5 s later, was refused, and so was one 30 s after that. Same in
   runs 4, 5 and 6, and the same with the cap in hex or decimal. So Privy
   records the aggregate some time after it signs, not at signing. **A rolling
   cap is a bound with a small, measurable overshoot, not an exact one**: up to
   one per-transaction maximum per few seconds of signing. The runner must
   pace signs (seconds apart) as well as serialise them, and the per-trade cap
   must stay tight — which is Privy's own advice.
7. **A policy PATCH can also lag.** In run 5, a sign straight after the owner
   PATCHed in an already-expired rule was still signed under the previous rule
   (0b); in run 6, with a 5 s pause after every PATCH, all variants behaved,
   and 7c's amendment bit on the first try at 336 ms. So propagation is usually
   sub-second but not guaranteed immediate: **do not promise a revocation is
   instant; treat it as effective after a few seconds.**
8. **The policy owner split holds — but owning the wallet was itself the hole
   (SEN-31).** The agent key gets a 401 editing the _policy_; only the
   mandate-owner key can. That much is real. What this run missed is that the
   agent key also **owned the wallet**, and a Privy wallet owner can `PATCH
   /v1/wallets/{id}` to set `policy_ids: []`, swap in a permissive policy, add an
   unrestricted `additional_signers` entry, or change `owner_id` — none of which
   touches the policy, so all of them slipped past the 401 above. Verified live
   2026-09-13: an agent-owned wallet detached its own mandate and the previously
   refused transaction then signed. **The fix is the owner/signer model below:**
   the trading key is a wallet _signer_, never the owner, and a signer cannot
   PATCH the wallet at all. Do not cite this finding as proof the mandate holds;
   cite the next section.
9. Signatures are real: every signed transaction parsed to chain 10143 with the
   requested `to` and recovered to the wallet's address; typed-data signatures
   recovered to the wallet. Nonce, gas and fees were filled from Monad RPC as
   `0x` hex.

## Owner/signer model — verified (SEN-31, 2026-09-13)

Finding 8 above was the hole under the whole pitch. Until SEN-31 the agent
(trading) key **owned** each wallet, and a Privy wallet owner can rewrite the
wallet — so "the key that trades can never raise its own limit" was **false**.
The fix makes the trading key a **signer**, never the owner:

- the wallet is **owned by the mandate quorum** (`PRIVY_MANDATE_QUORUM_ID`,
  key `PRIVY_MANDATE_OWNER_KEY`), with the mandate policy attached;
- the **agent quorum** (`PRIVY_AGENT_QUORUM_ID`, key `PRIVY_AGENT_AUTH_KEY`) is
  an `additional_signers` entry whose `override_policy_ids` is that same mandate
  policy. A signer is evaluated **only** against its override, so the override is
  always the mandate policy, never empty (an empty override is an unrestricted
  signer).

Per Privy's docs a signer "cannot update a wallet's owner, signers, or
policies"; only the owner can. Confirmed live on Monad testnet 10143 by
`services/api/scripts/sen31-signer-probe.ts` (sign-only, nonce 1,000,000, never
broadcast, `sente-sen31-probe-*` resources only):

| #   | Check                                                                             | Expected                | Got                           |
| --- | --------------------------------------------------------------------------------- | ----------------------- | ----------------------------- |
| a   | the agent SIGNER signs an ALLOWED `eth_signTransaction` (to allowlisted, 10143)    | signed                  | **SIGNED**, parsed to 10143   |
| b   | the agent SIGNER signs a NOT-allowed one                                           | refused                 | **refused `policy_violation`** (400) |
| c1  | agent SIGNER `PATCH /v1/wallets/{id}` `{policy_ids: []}` (detach)                  | 401                     | **401 `invalid_data`**        |
| c2  | agent SIGNER `PATCH` `{owner_id: <attacker quorum>}`                               | 401                     | **401 `invalid_data`**        |
| c3  | agent SIGNER `PATCH` `{additional_signers: [{attacker, override: permissive}]}`    | 401                     | **401 `invalid_data`**        |
| d   | the OWNER (mandate) key `PATCH /v1/wallets/{id}` `{policy_ids: []}`                | ok                      | **200** (then restored)       |

After each refused (c) attempt the wallet still refused the not-allowed
transaction, and the read-back showed `policy_ids`, `owner_id` and
`additional_signers` unchanged. So the agent signer trades within the mandate
and can change **nothing** about the wallet; only the owner can. `DESIGN OK`.

### Migration of the existing wallets

`services/api/scripts/migrate-agent-wallets.ts` PATCHes each wallet named in
`.env` (while the agent key is still owner, so it can) into the owner=mandate /
signer=agent shape, idempotently (a wallet already owned by the mandate quorum is
skipped). Run 2026-09-13, both moved and then verified sign-only that the agent
key can no longer detach the policy (`PATCH {policy_ids: []}` by the agent key →
401, policy still attached):

| `.env` var                     | wallet id                  | owner before → after                | result   | detach by agent key |
| ------------------------------ | -------------------------- | ----------------------------------- | -------- | ------------------- |
| `PRIVY_AGENT_VENUES_WALLET_ID` | `qqhg4rxobx0qnjg398tjzgi9` | agent quorum → **mandate quorum**   | migrated | **401, refused**    |
| `PRIVY_PROBE_WALLET_ID`        | `j1vvfuszwb4vzw2z3gb613oh` | agent quorum → **mandate quorum**   | migrated | **401, refused**    |

The agent quorum is now an `additional_signers` entry on each, its
`override_policy_ids` the wallet's own mandate policy
(`PRIVY_AGENT_VENUES_POLICY_ID` / `PRIVY_PROBE_POLICY_ID`).

### Demo re-verified against the migrated wallet

`demo:refusal --mode scripted` was rerun live on the migrated
`PRIVY_AGENT_VENUES_WALLET_ID` (2026-09-13): **all 24 checks passed**. Act 4
still shows a _policy_ PATCH signed by the agent key alone refused with 401, the
owner-signed amend raising the cap, and the agent _signer_ then signing and
landing the 2 USDC deposit on chain (nonces 20→22, both receipts `success`). The
signer model changes nothing the demo depends on except closing the detach hole.

### The JSON that worked

A compiled transaction rule (`abi` elided; it is the one-fragment `deposit`
ABI — the `batch` rule carries both overloads, two fragments, and that is
accepted):

```json
{
  "name": "Kuru: deposit USDC",
  "method": "eth_signTransaction",
  "action": "ALLOW",
  "conditions": [
    {
      "field_source": "ethereum_transaction",
      "field": "chain_id",
      "operator": "eq",
      "value": "0x279f"
    },
    {
      "field_source": "system",
      "field": "current_unix_timestamp",
      "operator": "lte",
      "value": "1789718333"
    },
    {
      "field_source": "ethereum_transaction",
      "field": "to",
      "operator": "eq",
      "value": "0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22"
    },
    {
      "field_source": "ethereum_calldata",
      "field": "deposit.token",
      "abi": ["…"],
      "operator": "eq",
      "value": "0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E"
    },
    {
      "field_source": "ethereum_calldata",
      "field": "deposit.amount",
      "abi": ["…"],
      "operator": "lte",
      "value": "0x989680"
    }
  ]
}
```

The typed-data rule:

```json
{
  "name": "Perpl: enroll an API key",
  "method": "eth_signTypedData_v4",
  "action": "ALLOW",
  "conditions": [
    {
      "field_source": "ethereum_typed_data_domain",
      "field": "chainId",
      "operator": "eq",
      "value": "10143"
    },
    {
      "field_source": "system",
      "field": "current_unix_timestamp",
      "operator": "lte",
      "value": "1789718333"
    },
    {
      "field_source": "ethereum_typed_data_domain",
      "field": "verifyingContract",
      "operator": "eq",
      "value": "0x0000000000000000000000000000000000000000"
    },
    {
      "field_source": "ethereum_typed_data_message",
      "field": "statement",
      "operator": "eq",
      "value": "I authorize the creation of Perpl API key with the specified scope and parameters",
      "typed_data": {
        "primary_type": "PerplRegisterApiKey",
        "types": {
          "EIP712Domain": [
            { "name": "name", "type": "string" },
            { "name": "version", "type": "string" },
            { "name": "chainId", "type": "uint256" },
            { "name": "verifyingContract", "type": "address" },
            { "name": "salt", "type": "bytes32" }
          ],
          "PerplRegisterApiKey": [
            { "name": "signer", "type": "address" },
            { "name": "statement", "type": "string" },
            { "name": "publicKey", "type": "string" },
            { "name": "scope", "type": "string" },
            { "name": "label", "type": "string" },
            { "name": "time", "type": "uint64" }
          ]
        }
      }
    }
  ]
}
```

The `eth_signTypedData_v4` RPC body (`POST /v1/wallets/{id}/rpc`) is
`{ "method": "eth_signTypedData_v4", "params": { "typed_data": { domain, types,
primary_type, message } } }`. `types` repeats `EIP712Domain`, the domain carries
a numeric `chainId` (`10143`) and Perpl's `salt`, and `message.time` is a JSON
number. The response's signature is at `data.signature`.

The aggregation (`POST /v1/aggregations`), and the condition that references it:

```json
{
  "name": "Sente rolling cap, 3600s",
  "method": "eth_signTransaction",
  "metric": {
    "field_source": "ethereum_calldata",
    "field": "approve.amount",
    "abi": ["…"],
    "function": "sum"
  },
  "window": { "type": "rolling", "seconds": 3600 },
  "conditions": [
    {
      "field_source": "ethereum_transaction",
      "field": "chain_id",
      "operator": "eq",
      "value": "0x279f"
    },
    {
      "field_source": "ethereum_transaction",
      "field": "to",
      "operator": "eq",
      "value": "0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E"
    }
  ]
}
```

```json
{ "field_source": "reference", "field": "aggregation.<id>", "operator": "lte", "value": "0xe4e1c0" }
```

`GET /v1/aggregations/{id}` echoes the definition back with `"group_by": []` and
`"owner_id": null` — and **no running value**, so the aggregate cannot be read
back to check it. Note `group_by: []`: whether one aggregation sums across
every wallet whose policy references it was not tested; the probe gave each
wallet its own aggregation.

### Ids (run 6)

Also written to the repo-root `.env` as `PRIVY_PROBE_*` (the list endpoints
answer 405, so this is the record). None of these is secret.

| Object                               | Id                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------- |
| agent-key quorum (owns wallets)      | `<privy-probe-agent-quorum-id>` (also `PRIVY_AGENT_QUORUM_ID`)                 |
| mandate-owner quorum (owns policies) | `<privy-probe-mandate-quorum-id>` (also `PRIVY_MANDATE_QUORUM_ID`)               |
| mandate wallet                       | `<privy-probe-wallet-id>` → `0x9c3cf0f7D73C4386E63754d9e42593141DDCDb3c` |
| its policy (cap now 1 USDC after 7c) | `<privy-probe-policy-id>`                                                |
| aggregation, hex cap / decimal cap   | `<privy-probe-aggregation-id>` / `<privy-probe-aggregation-id-decimal>`                   |

Runs 1–5 left their own `sente-probe-…` wallets and policies in the app. They
are unfunded, owned by the two quorums above (so still controllable with our
keys), and their ids were not kept — only the last run's are in `.env`.

## Recipient pinning (SEN-15)

Two rules that move money out of the agent's hands, each pinned to one
recipient. They carry `chain_id` and deliberately **no expiry**. Verified live
on 10143: each signed what it should and refused anyone else, and both
survived an expired mandate. Tx hashes are in `docs/agents.md`.

```json
{
  "name": "Kuru: withdraw to its own wallet",
  "method": "eth_signTransaction",
  "action": "ALLOW",
  "conditions": [
    {
      "field_source": "ethereum_transaction",
      "field": "chain_id",
      "operator": "eq",
      "value": "0x279f"
    },
    {
      "field_source": "ethereum_transaction",
      "field": "to",
      "operator": "eq",
      "value": "0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22"
    },
    {
      "field_source": "ethereum_calldata",
      "field": "function_name",
      "abi": ["withdraw(address token, uint256 amount) only"],
      "operator": "eq",
      "value": "withdraw"
    }
  ]
}
```

```json
{
  "name": "Return USDC to the owner",
  "method": "eth_signTransaction",
  "action": "ALLOW",
  "conditions": [
    {
      "field_source": "ethereum_transaction",
      "field": "chain_id",
      "operator": "eq",
      "value": "0x279f"
    },
    {
      "field_source": "ethereum_transaction",
      "field": "to",
      "operator": "eq",
      "value": "0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E"
    },
    {
      "field_source": "ethereum_calldata",
      "field": "transfer.to",
      "abi": ["transfer(address to, uint256 amount)"],
      "operator": "eq",
      "value": "0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8"
    }
  ]
}
```

- `withdraw` names no recipient: AccountCore pays `msg.sender`. The ABI
  handed to Privy has that one function, so `withdrawFromAccount` and
  `transferBetweenAccounts` fail to decode and are refused. That is the same
  mechanism the `batch` rule uses.
- A calldata param called `to` (`transfer.to`) is fine. It is distinct from
  the transaction's `to`.

## Plan availability

The policy engine is **included on the Developer plan**, not an add-on. The
"Available as add-on" label on the pricing page belongs to the _Advanced SSO_
row; in the DOM, Policy engine and Key quorum approvals both carry checkmarks in
the Developer column. Confirmed independently from `docs.privy.io/llms-full.txt`,
where the only Enterprise gate anywhere is production webhooks, and SSO is
separately described as an add-on at all tiers.
