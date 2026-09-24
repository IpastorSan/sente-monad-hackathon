# Privy-sponsored sends from a user-owned wallet (SEN-39, SEN-42)

Phase 3's user wallet is **a Privy server wallet + an owner key on the user's
device + Privy-paid gas**. That third part is the one nothing depended on yet,
so it was measured before any product code was written.

Run the probe:

```bash
mise exec -- pnpm --filter @sente/api run probe:privy-sponsor
#   -- --out report.json   write every request/response shape to a file
#   -- --no-fund           do not top the wallet up from the treasury
#   -- --fresh             ignore PRIVY_PROBE_SPONSOR_* and create new objects
```

It is `services/api/scripts/privy-sponsor-probe.ts`, it is re-runnable, and it
reuses the wallets it made last time — which is the point: the delegation
question was answered by running it **again** against the same address once the
dashboard step below was done — see "Run 2" below.

And the SEN-42 probe, which asks the same questions **through the code the API
ships** rather than through a hand-rolled request:

```bash
mise exec -- pnpm --filter @sente/api run probe:user-send
#   -- --fresh    make a NEW wallet, the only way to see a first send delegate one
#   -- --out report.json
```

That one (`services/api/scripts/user-send-probe.ts`) is "Run 3".

## Status: verified end to end, sponsored send included

**2026-09-24: gas sponsorship is ON, a sponsored send from a 0-MON wallet lands,
and the whole SEN-42 path — prepare on the server, sign with the device key,
execute, confirm the user operation — works live.** Run 1 below is kept because
it is the evidence of what a refusal looks like; Run 2 is the first landed send;
**Run 3 is the product path and the current state**.

### Run 1 — 2026-09-18, before the dashboard step

Run against app `<privy-app-id>` on Monad testnet
(10143). Probe wallet `0xab91d510F02c5A4191Db61121904f208E31A7Af8`, holding
**1 USDC and 0 MON** by design.

| #   | Check                                                   | Result                                                                     |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | wallet created with a raw `owner: {public_key}`         | **accepted** — `<privy-probe-sponsor-wallet-id>`                           |
| 1b  | what that owner actually is                             | an **auto-created 1-key quorum**, threshold 1, holding our key             |
| 2   | wallet created with `owner_id` = a 1-key quorum we made | **accepted** — `<privy-probe-sponsor-quorum-wallet-id>`                    |
| 3   | funded 1 USDC from the treasury, left at 0 MON          | landed, block 63580274                                                     |
| 4a  | `eth_signTransaction` with no authorization signature   | **401**                                                                    |
| 4b  | `eth_signTransaction` signed by an unrelated P-256 key  | **401**                                                                    |
| 4c  | `eth_signTransaction` signed by the owner key           | **signed**; `ecrecover` = the wallet address                               |
| 5   | `eth_signTypedData_v4` + `recoverTypedDataAddress`      | 65-byte `r‖s‖v`; recovers to the wallet address                            |
| 6   | `eth_sendTransaction` `sponsor: true`                   | **BLOCKED** — `400 invalid_data`, `"Gas sponsorship is not enabled."`      |
| 6b  | a second sponsored send, at once (gotcha 12)            | not reached — 6 never succeeded                                            |
| 7   | the same send with `sponsor` omitted                    | `400 transaction_broadcast_failure`, `"… Signer had insufficient balance"` |
| 8   | address and code after the attempts                     | address unchanged, `eth_getCode` still `0x` — **no delegation happened**   |

Check 6 was the acceptance criterion, and at Run 1 it was the one thing
outstanding.

### Run 2 — 2026-09-24, after the credits were bought

Same app, same probe wallet `0xab91d510F02c5A4191Db61121904f208E31A7Af8`, still
holding 1 USDC and 0 MON. 13 checks, one failure, and that failure is in the
probe rather than the chain.

| #   | Check                                 | Result                                                                                                      |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 6   | `eth_sendTransaction` `sponsor: true` | **LANDS** in 587 ms. `sponsorship_provider: "alchemy"`                                                      |
| 6r  | receipt for that send                 | **probe bug**: it waits for a _transaction_ receipt using a _user operation_ hash, which never appears      |
| 6b  | a second sponsored send, immediately  | `400 transaction_broadcast_failure`, "Execution reverted for an unknown reason" — **unresolved**            |
| 7   | the same send with `sponsor` omitted  | `400`, "Insufficient funds for gas \* price + value" — the control still fails, so sponsorship did the work |
| 8   | address and code afterwards           | address **unchanged**; `eth_getCode` `0x` → `0xef0100d6cedde84be40893d153be9d467cd6ad37875b28`              |

Three consequences, all three settled by run 3 below:

1. **A sponsored send returns a user-operation hash, not a transaction hash.**
   The response carries `hash: ""`, `user_operation_hash: 0xfb1cab9d…a059c6` and
   a `transaction_id`. CLAUDE.md gotcha 8 applies exactly: read the user
   operation receipt and branch on **its** success flag.
2. **The wallet is EIP-7702 delegated by the first sponsored send.** The address
   survives, but the account now has code. Anything assuming "no code means EOA"
   must be re-checked, and Perpl enrollment (`ecrecover`-only, gotcha 9) must be
   re-tested **from a delegated wallet** — check 5 below ran before delegation,
   so it does not answer this.
3. **Two sponsored sends back to back do not work yet.** Spacing must be
   measured before the demo, or the second action on stage fails.

### Run 3 — 2026-09-24, the product path (SEN-42)

A different probe, and the difference is the point:
`services/api/scripts/user-send-probe.ts`
(`pnpm --filter @sente/api run probe:user-send`) sends through the modules the
API ships — `wallet/send/sponsored-send.ts` composes the body and the payload,
`agents/privy/user-wallet.ts` creates the wallet — with a throwaway P-256 key
standing in for the phone's device key. Fresh wallet
`0xcC3c006d4654CBCE0F4Fbc89FBC5f1EAD49Ec29D`
(`<privy-probe-send-wallet-id>`), 1 USDC and **0 MON**.

| #   | Check                                                | Result                                                                                              |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 3   | the payload rebuilt from the intent vs the API's     | **identical** — URL, method, `caip2`, `sponsor`, `to`/`data`/`value`                                |
| 4   | a send signed by an UNRELATED P-256 key              | **401** — the owner check is real                                                                   |
| 5   | the device-signed sponsored send                     | **landed in 750 ms**; `hash: ""`, `user_operation_hash`, `sponsorship_provider: "alchemy"`          |
| 5r  | its USER OPERATION receipt, off `UserOperationEvent` | `success=true` in block 65392922, **256 ms** after the response                                     |
| 5b  | does OUR Pimlico endpoint answer for it?             | **yes** — full receipt, EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, `actualGasCost: 0` |
| 6   | a second send **1 ms** after the first               | **400** `transaction_broadcast_failure` — "**EIP-7702 nonce mismatch. Expected: 1, Actual: 0**"     |
| 6   | the same send **1,524 ms** after the first           | **landed in 609 ms**                                                                                |
| 6r  | the second send's user-operation receipt             | `success=true` in block 65392929                                                                    |
| 7   | address and code afterwards                          | address **unchanged**; code `0x` → `0xef0100d6cedde84be40893d153be9d467cd6ad37875b28`               |
| 8   | `eth_signTypedData_v4` from the **delegated** wallet | 65 bytes `r‖s‖v`, `recoverTypedDataAddress` → **the wallet's own address**                          |

Re-run immediately afterwards against the **same, now delegated** wallet: 12
checks, 0 failures, and the one that had failed passed — **two sponsored sends
1 ms apart both landed** (blocks 65393054 and 65393055, both
`success=true`).

Four answers, and the fourth is the one that changes the design:

1. **The user-operation hash is followable by our own bundler.** Pimlico's public
   Monad endpoint answers `eth_getUserOperationReceipt` for an operation
   Privy/Alchemy bundled, so `PollingOperationTracker` needs nothing new — it
   just has to be pointed at `user_operation_hash` instead of `hash`. The probe
   also reads the receipt straight off `UserOperationEvent`
   (`services/api/src/wallet/confirmation/user-operation-logs.ts`), which is what
   makes it independent of any bundler's indexer.
2. **Gas is free at the EntryPoint's own accounting**: `actualGasCost: 0`,
   `actualGasUsed: 133,989`, `paymaster: 0x0`. Alchemy settles it off chain, out
   of the prepaid credits — so the MON figure to watch is the credit balance in
   the dashboard, not anything on chain.
3. **The back-to-back failure is DELEGATION, not a rate limit and not Monad's
   reserve rule.** The first sponsored send also performs the EIP-7702 upgrade,
   which bumps the account's nonce; a second send composed before that has landed
   is built against nonce 0 and the EntryPoint refuses it. Once the wallet has
   code, sends 1 ms apart are fine. `WALLET_SEND_SPACING_MS` (default **4 s**,
   `send/sponsored-send.ts#SponsoredSendPacer`) makes the second send WAIT rather
   than fail; it is a floor, not a delay, and it is applied to every send because
   "has this wallet been delegated yet" would be a chain read on the spending
   path.
4. **Gotcha 9 survives delegation.** `eth_signTypedData_v4` from an account with
   `0xef0100…` code still returns a 65-byte `r‖s‖v` that `ecrecover`s to the
   wallet's address — so Perpl's `ecrecover`-only enrollment can still work from
   a delegated Privy wallet. The signature is
   `0xcb295a2f…1c` over the probe's own typed data; gotcha 13 still applies to
   Perpl's live struct, which this does not test.

## The human step, and its exact wording

Nothing in the API can turn this on. In the **Privy dashboard**, for app
`<privy-app-id>`:

1. Open **Wallet infrastructure → Gas sponsorship** (Privy also labels this
   "Gas policies" / "Paymaster").
2. Choose **App pays** — Sente pays, not the user.
3. Add **Monad Testnet (10143)** to the sponsored networks.
4. Buy or top up **prepaid gas credits** for it; sponsorship on a network with
   no credits is the same as sponsorship off.
5. Confirm **TEE execution** is enabled (it already is for this app).

Then re-run the probe. It reuses `PRIVY_PROBE_SPONSOR_*` and hits the same
0-MON wallet, so the result is directly comparable to the table above.
**Done on 2026-09-24; Run 2 is that result.**

If the dashboard turns out not to offer "App pays" for this app or for Monad
Testnet, **stop and say so**: SEN-40 and SEN-42 then have to fall back to the
user's wallet paying its own gas from a MON drip, and that is a product
decision, not an implementation detail.

## What the results mean

### A raw `owner: {public_key}` is sugar for a 1-key quorum

`POST /v1/wallets` with `owner: {public_key: "<base64 SPKI DER>"}` is accepted,
but the response carries **no `owner` field** — it carries an `owner_id`. Read
that id back and it is an ordinary key quorum with `authorization_threshold: 1`
whose single `authorization_keys[].public_key` is the key we sent:

```
POST /v1/wallets  {chain_type, owner:{public_key}}  →  {id, address, owner_id: "<quorum-id>", policy_ids: [], …}
GET  /v1/key_quorums/<quorum-id>                    →  {authorization_threshold: 1, authorization_keys:[{public_key: ours}]}
```

So the two forms are the same object, reached two ways, and the choice is only
about whether we want the quorum id in advance. **Phase 3 should use the
explicit quorum** anyway: a device key that may later be joined by a recovery
key needs a quorum we can PATCH, and creating it up front means we hold the id
without a second round trip. The raw form is fine for throwaway wallets.

### The signature model is unchanged by having a user-held owner

The owner key here is a P-256 key generated locally with
`generateAuthorizationKey()` and never sent to Privy in any form but its public
half — exactly the shape a device key would have. Against it:

- no `privy-authorization-signature` → `401 "Missing privy-authorization-signature header or no signatures provided."`
- a signature from an unrelated key → `401 "No valid authorization signatures were provided."`
- the owner's signature → signed.

Those three go through `agent-wallet.ts`'s own `signTransaction()`, not a
hand-rolled POST, precisely so the check covers the path product code takes
(`privy-agent-wallet.provider.ts`) rather than a parallel copy of it. So the
existing `authorization-key.ts` / `privy.client.ts` / `agent-wallet.ts` stack
works verbatim for a user-owned wallet: nothing about the canonicalization, the
DER encoding, or the request wrapping changes when the owner is a person instead
of our server. On the wire the answer is
`{"method":"eth_signTransaction","data":{"signed_transaction":"0x02f8…","encoding":"rlp"}}`.

### `eth_signTypedData_v4` still returns a plain EOA signature

`{"method":"eth_signTypedData_v4","data":{"signature":"0x…","encoding":"hex"}}` —
65 bytes, `r‖s‖v`, and `recoverTypedDataAddress` returns the wallet's own
address. (Through `agent-wallet.ts`'s `signTypedData()`, for the same reason as
check 4.) CLAUDE.md gotcha 9's assumption — that Perpl's
`ecrecover`-only enrollment can work from one of our wallets — therefore still
holds **for an undelegated wallet**.

**And for a delegated one too, measured in run 3.** The external research warned
that after the 7702 upgrade `signature_options.type` might become `erc1271`, and
an ERC-1271 signature does not `ecrecover`. It does not: an account holding
`0xef0100d6cedde84be40893d153be9d467cd6ad37875b28` still answered with 65 bytes
of `r‖s‖v` that recovered to its own address. Perpl enrollment from a user
wallet is therefore not blocked by delegation.

What is still untested is Perpl's LIVE enrollment struct from such a wallet —
gotcha 13: signing a constant that has drifted proves nothing, so that test
belongs in the Perpl path, with the payload Perpl actually serves, not here.

### Privy does reach the chain — the unsponsored send proves it

With `sponsor` omitted, the same `eth_sendTransaction` comes back as
`400 transaction_broadcast_failure`, `"Missing or invalid parameters. Double
check you have provided the correct parameters. Details: Signer had
insufficient balance"`. That is the chain refusing a 0-MON EOA, not Privy
refusing the request shape — so `caip2: "eip155:10143"` is routed, the wallet is
a plain EOA today, and the only missing piece really is who pays.

### The refusal is app-level, and it is not a shape error

Both body shapes get the identical answer:

```json
{ "error": "Gas sponsorship is not enabled.", "code": "invalid_data" }
```

— HTTP **400**, for
`{"method":"eth_sendTransaction","caip2":"eip155:10143","sponsor":true,"params":{"transaction":{"to":…,"data":…,"chain_id":10143}}}`
and for the same body without `chain_id`. The probe sends both precisely so this
cannot be misread as a malformed request. Note the `code` is `invalid_data`, the
same code a genuinely malformed body gets: **do not branch on the code, branch
on the message** if any product code ever has to detect this.

### Delegation: the first sponsored send upgrades the account, and the address survives

`eth_getCode` at the wallet is `0x` before the first sponsored send and
`0xef0100d6cedde84be40893d153be9d467cd6ad37875b28` after it — an EIP-7702
delegation to Kernel, performed as part of the sponsored path. Privy reports the
**same address** throughout, so nothing downstream has to migrate.

Two things follow, and both are load-bearing:

- **"No code" no longer means "not our wallet".** Anything that inferred EOA-ness
  from an empty `eth_getCode` has to be re-read. Nothing in `wallet/` or
  `agents/` does today (the Kernel account's `deployed` flag is about a different
  address entirely), but gotcha 12's reserve-balance note is written for
  delegated EOAs for exactly this reason.
- **The delegation is what makes two immediate sends fail.** See run 3's third
  answer: the upgrade bumps the nonce, so the send composed before it lands is
  built against a stale one. It is not a rate limit.

CLAUDE.md gotcha 8 applies to what comes back: the response carries a
**user-operation** hash, so a successful carrying transaction says nothing about
whether the operation succeeded. Read the user-operation receipt and branch on
its `success` — `eth_getUserOperationReceipt` at the bundler, or
`UserOperationEvent` off the chain.

## Costs and caps

The probe spends from the treasury `0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8`
and only on its first run for a given wallet — afterwards it sees the 1 USDC and
skips funding.

| Item                               | Amount            |
| ---------------------------------- | ----------------- |
| USDC moved to the probe wallet     | 1.000000 USDC     |
| Treasury gas for that one transfer | 0.008364 MON      |
| MON sent to the probe wallet       | **0, on purpose** |

**`receipt.gasUsed` on that transfer read `82000` — exactly the limit we set,
not the consumption.** Read off the receipt for
`0x2ade69ff5d3a7432f890901e1c6c01b01b2ae99c016d60fe453306baa0f91071`
(`effectiveGasPrice` 102 gwei, and 82,000 × 102 gwei = 0.008364 MON, the whole
of the treasury's balance change). That is worth writing down, because
`docs/monad-testnet-assets.md` records **72,918** for the same call shape — an
`eth_estimateGas` figure. So on Monad the two numbers are not the same thing:
estimation tells you what the call consumes, the receipt reports what you are
billed for, and gotcha 4's "charges the limit" shows up in the receipt's own
`gasUsed` field. Do not size a limit from a receipt; estimate it. The limit here
is fixed in the script for exactly that reason.

Once sponsorship is on, the sponsored sends themselves cost **Privy gas
credits**, not treasury MON, and the second send in a re-run is what shows
whether Monad's 10-MON reserve rule (gotcha 12) bites a delegated 0-MON EOA
moving only ERC-20s. The external research says it should not — a revert happens
only when the balance decreases and drops below 10, and an ERC-20 transfer paid
for by a paymaster does neither — but that is a claim to measure, not to trust.

## Environment variables

The probe reads `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `TREASURY_PRIVATE_KEY` and
the optional `MONAD_TESTNET_RPC_URL`, and writes these back to the env file
(mode 0600) so a re-run probes the same objects. All of them are testnet
throwaways. They are **not** in `.env.example`: nothing in the app reads them,
only this probe does.

| Variable                                    | What it holds                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIVY_PROBE_SPONSOR_OWNER_KEY`             | The throwaway P-256 owner key, base64 PKCS#8 DER. Stands in for a user's device key. Lose it and the probe wallets are unreachable — `--fresh` then makes new ones. |
| `PRIVY_PROBE_SPONSOR_WALLET_ID`             | The wallet created with a **raw** `owner: {public_key}`. The one every later check runs against.                                                                    |
| `PRIVY_PROBE_SPONSOR_WALLET_ADDRESS`        | Its EVM address, recorded so a change under delegation would be visible.                                                                                            |
| `PRIVY_PROBE_SPONSOR_QUORUM_ID`             | The explicit 1-key quorum holding the same public key.                                                                                                              |
| `PRIVY_PROBE_SPONSOR_QUORUM_WALLET_ID`      | The wallet owned by that quorum — the comparison case for "raw owner vs quorum".                                                                                    |
| `PRIVY_PROBE_SPONSOR_QUORUM_WALLET_ADDRESS` | Its EVM address.                                                                                                                                                    |

The SEN-42 probe keeps its own two, for the same reason and with the same
warning — lose the key and that wallet is unreachable:

| Variable                          | What it holds                                                            |
| --------------------------------- | ------------------------------------------------------------------------ |
| `PRIVY_PROBE_SEND_DEVICE_KEY`     | The throwaway P-256 key standing in for a phone's `device` key.          |
| `PRIVY_PROBE_SEND_WALLET_ID`      | The user wallet it owns. Delegated after its first sponsored send.       |
| `PRIVY_PROBE_SEND_WALLET_ADDRESS` | Its EVM address, recorded so a change under delegation would be visible. |

Ids from the 2026-09-18 run, for reference: wallet `<privy-probe-sponsor-wallet-id>`
(`0xab91d510F02c5A4191Db61121904f208E31A7Af8`), its implicit owner quorum
`<privy-probe-sponsor-implicit-quorum-id>`, explicit quorum `<privy-probe-sponsor-quorum-id>`, quorum
wallet `<privy-probe-sponsor-quorum-wallet-id>`
(`0x01F17Fab5a47F859966a45109866469447a2Db64`), funding tx
`0x2ade69ff5d3a7432f890901e1c6c01b01b2ae99c016d60fe453306baa0f91071`.

## Measured, and what is left

Everything the two probes set out to ask is answered:

| Question                                          | Answer                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| Does `sponsor: true` land from a 0-MON wallet?    | yes, in 0.5–0.8 s                                                 |
| A transaction hash or a user-operation hash?      | a **user-operation** hash; `hash` is `""` (gotcha 8)              |
| Can we follow it?                                 | yes — our own Pimlico endpoint, and `UserOperationEvent` on chain |
| Does the address survive delegation?              | yes; the account gains `0xef0100…` code                           |
| Does typed data still `ecrecover` once delegated? | yes, 65 bytes `r‖s‖v` (gotcha 9 holds)                            |
| Does a second sponsored send work?                | not within ~1.5 s of the DELEGATING one; freely afterwards        |
| Who pays?                                         | Privy's prepaid credits; `actualGasCost` at the EntryPoint is 0   |

What is still open, and neither is this document's to close:

1. **Perpl enrollment from a delegated user wallet**, against the struct Perpl
   actually serves (gotcha 13). The signature shape is no longer the risk; the
   `types` still are.
2. **The user gas drip is now unnecessary for Privy users.** `POST /gas/drip`
   (SEN-16) exists so a user's own account can pay for its own transactions; a
   Privy user never needs MON for a transfer, because sponsorship pays. It is
   deliberately **left in place** — the Kernel path still uses it until SEN-45,
   and agents still get their own drip (SEN-14, and an agent's wallet is NOT
   sponsored) — but nothing on the Phase 3 path calls it, and the demo should not.
