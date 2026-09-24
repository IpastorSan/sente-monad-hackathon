# Privy-sponsored sends from a user-owned wallet (SEN-39)

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

## Status: verified end to end, sponsored send included

**2026-09-24: gas sponsorship is ON and a sponsored send from a 0-MON wallet
lands.** Run 1 below is kept because it is the evidence of what a refusal looks
like; Run 2 is the current state.

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

Three consequences, each already written onto SEN-42:

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

It is deliberately not proof for a delegated one. The external research says
that after the 7702 upgrade `signature_options.type` may be `erc1271` instead of
`ecdsa`, and an ERC-1271 signature does not `ecrecover`. **Re-run check 5 after
sponsorship works and the wallet has code**, and test Perpl enrollment live
before Phase 3 depends on it. The probe signs its own typed-data payload rather
than Perpl's constant on purpose: gotcha 13 — signing a constant that has
drifted proves nothing about Perpl's live shape, so that test belongs in the
Perpl path, not here.

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

### Delegation: measured in Run 2, and the address survives

`eth_getCode` at the wallet is `0x` before and after, and Privy reports the same
address. That is the expected outcome of a sponsored send never happening — the
EIP-7702 upgrade to Kernel is part of the sponsored path. **The address-under-
delegation question is unanswered** and is the second thing the re-run settles.

When it is answered, CLAUDE.md gotcha 8 applies to whatever comes back: if the
response carries a **user-operation** hash rather than a transaction hash, a
successful carrying transaction says nothing about whether the operation
succeeded — read `eth_getUserOperationReceipt` and branch on its `success`. The
probe prints the whole response body for exactly this reason.

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

Ids from the 2026-09-18 run, for reference: wallet `<privy-probe-sponsor-wallet-id>`
(`0xab91d510F02c5A4191Db61121904f208E31A7Af8`), its implicit owner quorum
`<privy-probe-sponsor-implicit-quorum-id>`, explicit quorum `<privy-probe-sponsor-quorum-id>`, quorum
wallet `<privy-probe-sponsor-quorum-wallet-id>`
(`0x01F17Fab5a47F859966a45109866469447a2Db64`), funding tx
`0x2ade69ff5d3a7432f890901e1c6c01b01b2ae99c016d60fe453306baa0f91071`.

## Still to measure — and the probe already asks all of it

Every one of these is a branch the script takes as soon as check 6 stops being
refused. None of it needs new code; it needs the dashboard.

1. Does `sponsor: true` land, and what does the response body carry — a
   transaction hash or a user-operation hash (gotcha 8)? The probe prints every
   32-byte hash in `data` under its own key and follows one to a receipt,
   labelling it as a user-operation hash when the key says so.
2. Does the wallet keep its address after the 7702 delegation, and what code
   sits at it? Check 8 compares `eth_getCode` and the Privy address across the
   whole run.
3. Does `eth_signTypedData_v4` still return an `ecdsa` signature once the
   address has code, or does `signature_options.type` become `erc1271`? Check 5
   re-runs against the delegated wallet and recovers the signer.
4. Does a **second** sponsored send from the same 0-MON wallet work, or does
   Monad's reserve-balance rule (gotcha 12) refuse it? Check 6b fires it
   immediately after the first — the worst case for that rule.
5. Who is charged, and how long does it take from request to receipt? Both sends
   are timed, and the receipt records the submitting address and the wallet's
   MON and USDC afterwards.
