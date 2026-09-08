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
recorded after signing. **Serial requests are exact.** The gap only opens under
concurrency, and its width is set by our own request pattern.

Worst case with N requests in flight: an overshoot of up to
**(N − 1) × per-transaction maximum** above the cap. Two levers, both ours:

- **Drive N to 1.** Serialize the agent's submissions — one in-flight signing
  request at a time. At N = 1 the cap is exact. Natural for a trading agent
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
- None of the enforcement claims here were tested empirically — they are a
  careful reading of primary documentation. Verify the refusal path for real in
  Phase 3, since it is the demo centrepiece.

## Plan availability

The policy engine is **included on the Developer plan**, not an add-on. The
"Available as add-on" label on the pricing page belongs to the _Advanced SSO_
row; in the DOM, Policy engine and Key quorum approvals both carry checkmarks in
the Developer column. Confirmed independently from `docs.privy.io/llms-full.txt`,
where the only Enterprise gate anywhere is production webhooks, and SSO is
separately described as an add-on at all tiers.
