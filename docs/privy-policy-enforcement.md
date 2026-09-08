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

## Still open

- **Stateful policies are documented as not real-time.** A rolling daily spend
  cap uses these. The staleness window is not yet established, and concurrent
  requests inside it may be able to exceed the cap. Resolve before designing the
  mandate around a rolling cap.
- Whether the policy engine's pre-flight simulation supports Monad's chain ID at
  all. Conditions on `to`/`value`/calldata are chain-agnostic and unaffected;
  this only bites where simulation is in the path.

## Plan availability

The policy engine is **included on the Developer plan**, not an add-on. The
"Available as add-on" label on the pricing page belongs to the _Advanced SSO_
row; in the DOM, Policy engine and Key quorum approvals both carry checkmarks in
the Developer column. Confirmed independently from `docs.privy.io/llms-full.txt`,
where the only Enterprise gate anywhere is production webhooks, and SSO is
separately described as an add-on at all tiers.
