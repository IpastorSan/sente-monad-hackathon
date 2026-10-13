# Privy-sponsored sends from a user-owned wallet (SEN-39, SEN-42) and an agent's (SEN-211)

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

### Run 4 — 2026-10-13, an AGENT wallet under its mandate (SEN-211)

Runs 1–3 were user wallets, which carry no policy. This one asks whether an
agent's Privy server wallet can send sponsored too, and whether its mandate
still binds on that path:

```bash
mise exec -- pnpm --filter @sente/api run probe:agent-sponsor
#   -- --env-file <path>   the repo-root .env by default
#   -- --out report.json
```

`services/api/scripts/privy-agent-sponsor-probe.ts` provisions a NEW
throwaway wallet on every run, through `PrivyAgentWalletProvider.provision`
(mandate policy, mandate quorum as owner, the agent key as the only signer),
under a real `compileMandate` policy: Kuru Set C, cbBTC-USDC, deposits and
approves ≤ 5 USDC, `returnTo` the treasury. The wallet holds **0 MON and 0
USDC**: an `approve` needs no balance, so nothing is funded. Every request is
signed by the agent key, as the API would sign it.

Five runs. The table is run 4's (wallet `<privy-agent-sponsor-probe-wallet-id>`,
`0x3ac51C49B77B4B70666Cc14A79D6641a0FE77089`), with what the others added:

| #   | Check                                                                                                                          | Result                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a0  | sponsored `approve(AccountCore, 1 USDC)` under the policy **as compiled**                                                      | **400 `policy_violation`** — every rule is `eth_signTransaction`, and a rule binds only its own method                                                                                                |
| a1  | the same, after adding an `eth_sendTransaction` twin of every rule                                                             | **accepted in 862 ms**, userOp `0xc9a7f83c…eea3`                                                                                                                                                      |
| a   | its user-operation receipt                                                                                                     | `success=true`, tx `0xd5394f5c35ff52d57029b48d3a7a4726164eda430d556825050fd7a7c3e319f3`, block 70706428, `actualGasCost` 0, confirmed 77 ms after the response                                        |
| a+  | the allowance on chain                                                                                                         | 1,000,000 — the approve took effect                                                                                                                                                                   |
| a′  | the EIP-7702 delegation                                                                                                        | code `0x` → `0xef0100d6cedde84be40893d153be9d467cd6ad37875b28`, in that same operation. **No `eth_sign7702Authorization` rule was needed** (see below)                                                |
| b1  | `approve(AccountCore, cap + 1)`                                                                                                | **400 `policy_violation`**                                                                                                                                                                            |
| b2  | `approve(Perpl Exchange, 1 USDC)` — a spender the mandate never names                                                          | **400 `policy_violation`**                                                                                                                                                                            |
| b3  | `approve` on AUSD — a token the mandate never names                                                                            | **400 `policy_violation`**                                                                                                                                                                            |
| b4  | USDC `transfer(0xdEaD, 0)` — the return rule pins the recipient                                                                | **400 `policy_violation`**                                                                                                                                                                            |
| c0  | a second allowed send 68 ms after the delegating one was accepted                                                              | accepted; `success=true` in block 70706430. **Runs 1, 2 and 5 refused it at 0–33 ms**: "EIP-7702 nonce mismatch. Expected: 1, Actual: 0", as in run 3 above                                           |
| c1  | an allowed send ~4 s after the previous request                                                                                | accepted in 934 ms; `success=true`, tx `0x2359aa59412d47bfcd3df7ef3285d4bed2f1cf9247c3377308d4333f8a0ac0dc`, block 70706529                                                                           |
| c2  | another, 72 ms after c1 was accepted                                                                                           | accepted in 677 ms; `success=true`, tx `0x88bfc1adeee7eae9d5efc482e800526c4ac5dedcafe4879248af863a46845088`, block 70706531                                                                           |
| f   | an allowed approve with **no `value` key** (every rule pins `value lte 0x0`)                                                   | accepted; `success=true` in block 70706511. On the send path Privy reads an absent value as zero                                                                                                      |
| d   | `eth_signTransaction` from the **delegated** wallet                                                                            | **signed**; `recoverTransactionAddress` → the wallet. Not broadcast (0 MON). The sign path survives delegation, so it stays a fallback                                                                |
| e   | address after delegation                                                                                                       | unchanged                                                                                                                                                                                             |
| g   | run 5: `AgentTransactionSender` in sponsored mode, the product path, policy from `compileMandate(…, { sponsoredSends: true })` | `success=true`, userOp `0x3d74d1ef…cacd`, tx `0x0f67ecf1bc94e4774a71f68e0b5b21ab8e7379d4eb52ffd7e9566e3c5b3ccebd`, block 70709062; exactly one log of its own (the USDC `Approval`), 1.2 s end to end |

Every sponsored request answered in 0.5–1.0 s, and every operation was in a
block within ~80 ms of the answer. Run 1 also showed what an
`eth_sendTransaction` that would revert looks like: a 1-atom USDC transfer
from a wallet holding none came back
`400 transaction_broadcast_failure`, "Execution reverted", from Alchemy's
`eth_estimateUserOperationGas` — **Privy simulates before it evaluates the
policy**. That is why b4 transfers zero: a refusal check must use a call that
would succeed, or it proves only the simulation. (Run 3's confirmations timed
out because the probe read logs from a fixed 50-block lookback long after the
operations landed; they had all succeeded, and the probe now reads from the
block it sent at.)

What it means:

1. **The mandate binds the sponsored path, but only if the policy names it.**
   A Privy rule matches its own `method` and nothing else, so today's
   compiled policy refuses every sponsored send (a0), and the same rules
   repeated under `eth_sendTransaction` let exactly the allowed call through
   and refuse the four the mandate forbids (b1–b4). Every condition the sign
   path enforces (`to`, the calldata decode, the caps, `value`, the expiry, the
   recipient pin) is a property of the transaction and is evaluated the same.
   SEN-204 already refuses `rollingCap`, the one thing that was sign-path-only.
2. **The delegation is not gated by the wallet's policy.** Privy signed the
   EIP-7702 authorization to `0xd6ce…5b28` (Kernel) as part of the first
   sponsored send, with no `eth_sign7702Authorization` rule in the policy. The
   delegate is Privy's choice, not the agent's: the agent key cannot name
   another one through `eth_sendTransaction`. Kernel in EIP-7702 mode
   validates a user operation with the EOA's own signature, which the enclave
   gives only under the wallet's policy; that last step is read from Kernel's
   design, not measured here.
3. **Space the second send after the delegating one, or wait for it to land.**
   Three of five runs refused a send fired at once after the first; sends from an
   already-delegated wallet 72 ms apart both landed (c2, as in run 3).
4. **A sponsored agent never needs MON** for a contract call: `actualGasCost` 0,
   paid from Privy's credits. The native-MON Kuru deposit is the exception —
   its value is the agent's own MON, and a delegated wallet under 10 MON cannot
   send it at all (run 5, 7b and 7e).

### Run 5 — 2026-10-13, the whole agent lifecycle through the product (SEN-212)

Run 4 asked whether the enclave binds a sponsored send. This run asks whether
the product works end to end with `AGENT_SPONSORED_SENDS=1`: a local API
(`nest build`, fresh `STATE_DIR`, `STORE_BACKEND=sqlite`, `KURU_DEPLOYMENT=set-c`,
the repo `.env` with every shared sender key blanked — gas drip, starter kit,
ERC-8004 — so nothing collides with the box), driven the way the phone and an
outside MCP client drive it. One throwaway user (a fresh secp256k1 sign-in key
and P-256 device key, `POST /wallet/register`) and one **device-owned** agent,
the production shape: every amend and revoke was prepared by the API, checked
by the app's own `approval.ts` mirror and signed with the device key. Every
agent action went through `/mcp` with the agent's token — the tools the runner
uses — not through raw Privy calls.

```bash
pnpm --filter @sente/mobile run sponsored:e2e -- --api http://localhost:3712 \
  --api-log <the API's stdout> --state-dir <its STATE_DIR> --phase <phase>
# phases: setup hire fund kuru perpl forbidden amend mon signpath fallback
#         monrefusal return revoke sweep — some need the API restarted with
#         other flags; the script header says which
```

`apps/mobile/scripts/sponsored-agent-e2e.ts` refuses any API under `sente.lol`
and keeps its two throwaway keys in `.secrets/` (0600, never printed). It reads
each leg back from the API's own log line (`[AgentTransactions] sponsored ok …`,
added for this run) and then off the chain: the `UserOperationEvent` for that
user operation, its `success`, its `sender`, `paymaster` and `actualGasCost`.

User wallet `0x85fa81E5c73370015F46a02f02B02140540aF34c`, agent
`0x298804B8266eE0A83408af25fF415c2A6FC198c1` (`<privy-sen212-agent-wallet-id>`),
mandate: Kuru Set C cbBTC-USDC and MON-USDC (deposits ≤ 25 USDC and ≤ 0.05 MON),
Perpl BTC-PERP (≤ 100 AUSD collateral, 2x), orders ≤ 30 USDC, `returnTo` the
user wallet. The agent held **0 MON from hire to step 7**.

| #   | Step                                                                       | Result                                                                                                                                                                                                                                                                                                     | Agent MON             | Latency                           |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------- |
| 1   | hire (device-owned)                                                        | **pass**. Policy 35 rules: 17 `eth_signTransaction`, **17 `eth_sendTransaction` twins**, 1 typed-data; `sponsoredSends: true` on the stored record; no code at the address. Set C needs no deposit-pin amend                                                                                               | 0                     | 1.14 s                            |
| 2   | fund 25 USDC + 100 AUSD from the user wallet (`fundAgent`, the Fund sheet) | **pass**. `0x69b45146…3a53`, `0xdd138993…36c6`                                                                                                                                                                                                                                                             | 0 → 0                 | 1.4 s, 4.9 s                      |
| 3a  | Kuru `deposit` 20 USDC                                                     | **pass**, 2 legs. approve: userOp `0x9478743d…0671` in `0x1dfa1a28a6a2310cc910cfc4b12abc3809dc8196c48ac01135c3369bf00c87d4`, a **type-4 bundle carrying the EIP-7702 authorization** to Kernel `0xd6ce…5b28` (the delegation); deposit: userOp `0x22332679…3634` in `0xe83fd9ac…5349`. Both `success=true` | 0 → 0                 | 1.85 s + 1.03 s                   |
| 3b  | Kuru `place_market` buy 0.00015413 cbBTC (13 USDC)                         | **pass**, filled at 84,348.32. Sente-fee approval userOp `0xfaf7ea18…636d` in `0x15798c23…327d`; order userOp `0x7917b1bb…bf89` in `0xb56bc1888930ad38357998ebf6df62f27f1ff2cfc37a485caca0e4389aa3f0f5`. Ledger: `order` + `fill` events with that tx hash, consensus `Verified`                           | 0 → 0                 | tool 2.5 s                        |
| 3c  | Kuru `place_market` sell 0.00015396 cbBTC                                  | **pass**, filled at 83,969.9. userOp `0x2c438b5b…d8f9` in `0x55a79f8dd0f9195d5f980390efb6c639f4ad19b540666cfe9cff7e5b38ff8310`; `fill` event with that hash                                                                                                                                                | 0 → 0                 | tool 1.4 s                        |
| 4a  | Perpl onboarding (`POST /agents/:id/perpl/onboard`)                        | **FAIL, then pass after a fix**. First `needs_gas`: "needs 0.04331 MON … holds 0 MON" — the onboarder's own gate ignored sponsorship. Fixed (below): approve `0x255d2395…c065`, createAccount `0x1270b4f2…76dc`, allowOrderForwarding `0xc0d20194…9766`, all sponsored, account 1240, key enrolled         | 0 → 0                 | 6.0 s for all three               |
| 4b  | Perpl `place_market` 0.00001 BTC-PERP at 1x, then `close_position`         | **pass**: filled 83,369, closed 83,374.7, no positions after. Off chain, so no agent transaction                                                                                                                                                                                                           | 0 → 0                 | 1.8 s, 2.8 s                      |
| 5a  | over-cap `deposit` 26 USDC through `/mcp` (`AGENT_PRECHECK=off`)           | **pass**: "Refused by the Privy enclave (policy_violation)"                                                                                                                                                                                                                                                | 0 → 0                 | 0.75–0.92 s                       |
| 5b  | buy on WETH-USDC, a market the mandate never names                         | **pass**: refused by the enclave                                                                                                                                                                                                                                                                           | 0 → 0                 | 0.70 s                            |
| 5c  | the same straight at `eth_sendTransaction` with the agent key              | **pass**: approve over the cap, approve on AUSD (a token the mandate never names), USDC `transfer` to `0xdEaD` — each `400 policy_violation` on the send path. Agent nonce 1 → 1; the only user operation from the agent in the window is the allowed probe below                                          | 0 → 0                 | 0.37–0.47 s                       |
| 6   | amend (device-signed), then a 1 USDC deposit                               | **pass**: 35 rules, every twin present, record `true`; approve `0x549ab688…5bbe`, deposit `0x0b3b06f0…da04`, sponsored                                                                                                                                                                                     | 0 → 0                 | amend 0.79 s; legs 1.57 s, 1.12 s |
| 7a  | treasury sends the delegated agent 0.05 MON, gas 21,000                    | **reverted**, out of gas (`0xd8c294ab…c9bb`): the delegated account runs Kernel's code on receive. `eth_estimateGas` 22,707; sent with 60,000 it landed (`0xa97956ff…08ac`)                                                                                                                                | 0 → 0.05              |                                   |
| 7b  | sponsored native-MON `deposit` 0.01 on MON-USDC                            | **FAIL**: Privy accepted it (userOp `0xea311e13…f65d`), neither Alchemy nor Pimlico ever saw it again, the tool gave up after 60 s ("did not surface on chain"). Nothing moved. Now refused up front (below)                                                                                               | 0.05 → 0.05           | 61 s                              |
| 7c  | sponsored USDC deposit from the delegated wallet holding MON               | **pass**, MON untouched                                                                                                                                                                                                                                                                                    | 0.05 → 0.05           | 1.1–1.5 s per leg                 |
| 7d  | flag **off** (rollback): signed `withdraw` 1 USDC from the delegated agent | **pass**: `0x322f1f30…17b3`, paid 0.0153 MON. The sign path works on a delegated wallet that holds MON                                                                                                                                                                                                     | 0.15 → 0.1347         | 0.76 s                            |
| 7e  | flag off: signed native-MON deposit 0.005                                  | **reverted**: `0xfddc0b5e…a4fd`, trace `"error":"reserve balance violation"`; 0.0257 MON of gas burnt                                                                                                                                                                                                      | 0.1347 → 0.1089       |                                   |
| 7f  | amend with the flag off, then flag on: `withdraw` 1 USDC                   | **pass**: policy 18 rules (no twins), record `false`; the sponsored send was refused, the sign path carried it (`signed_after_refusal`, `0x1ea7c99c…a7c`), paid in MON                                                                                                                                     | 0.1089 → 0.0936       | 1.14 s (+0.36 s for the refusal)  |
| 7g  | amend with the flag on again, then `withdraw` 1 USDC                       | **pass**: twins back, sponsored again (userOp `0x1dc4217d…6da7`)                                                                                                                                                                                                                                           | 0.0936 → 0.0936       | 1.59 s                            |
| 7h  | after the fix: native-MON `deposit`                                        | **pass**: refused `native_mon_reserve` before anything was signed                                                                                                                                                                                                                                          | unchanged             | 4 ms                              |
| 8a  | `POST /agents/:id/return` on the active agent                              | **pass**, 4 sponsored legs: Kuru withdraw + transfer of 24.888936 USDC (`0x95537cd5…7292`), the same for 1 sat of cbBTC. `monSpent: "0"`; the 0.0936 MON is not swept, by design                                                                                                                           | unchanged             | 5.75 s for four legs              |
| 8b  | revoke (device-signed), then return 2 USDC                                 | **pass**: policy left with 12 rules, the 6 recovery rules and their 6 twins; the return to the owner went sponsored (`0xe549d02d…eddb`)                                                                                                                                                                    | unchanged             | revoke 0.41 s; return 1.74 s      |
| 8c  | archive                                                                    | **pass**, 200: MON (0.0936) is ignored, Perpl collateral (99.999 AUSD) is excluded (SEN-203), no positions                                                                                                                                                                                                 | 0.0936 left, for good |                                   |

**Latency.** 20 sponsored legs: Privy answered in a median of **698 ms**
(549–1,094; the delegating first one was the slowest), and the operation was
read off `UserOperationEvent` a median **417 ms** later (69–1,082) — about
**1.2 s per leg**, 1.85 s at worst. A signed leg is ~0.3 s + ~0.4 s. A fallback
(a refused sponsored try, then the sign path) adds ~0.36 s. A Kuru deposit is
two legs and a market order one or two, so a write tool takes 1.4–3 s.

**Who paid.** Every one of the 20 operations: `actualGasCost` 0, `paymaster`
`0x0`, `sender` the agent — Privy's credits through Alchemy's bundler
(`sponsorship_provider: "alchemy"` on the raw response; three different bundler
EOAs carried them, one operation per bundle). The agent's MON never moved on a
sponsored leg. What it cost the sponsor, measured on chain: `actualGasUsed`
122,530–519,796 per operation (4.48 M in all), and the bundles themselves — on
Monad charged at their gas limit — **0.751 MON for the 20, about 0.038 MON per
leg**, against 0.015–0.026 MON for the same calls signed. Budget the credits
for roughly **1.5–2× the MON** the drip-funded path spent. The dashboard is the
authority on what Privy actually bills.

The raw sponsored response, for the record (one allowed `approve`, 617 ms):
`{"method":"eth_sendTransaction","data":{"hash":"","caip2":"eip155:10143","user_operation_hash":"0x8794…29a5","sponsorship_provider":"alchemy","transaction_request":{…},"transaction_id":"…"}}`.

**Spend.** Treasury: 0.188 MON (two funding transfers, the reverted one's gas,
a top-up for step 7, its own gas) and 0.111 USDC (trading fees and spread; the
rest came back). AUSD came from Agora's faucet straight to the throwaway user,
not the treasury, and its 9,900 left over went to the treasury: net **+9,900
AUSD**. Left behind: 0.0936 MON in the revoked, archived agent (unrecoverable,
see below) and 99.999 AUSD in its Perpl account 1240 (no Perpl withdraw).

#### What it found, and what changed (branch `test/SEN-212-sponsored-e2e`)

1. **Bug: a 0-MON sponsored agent could not open its Perpl account.**
   `AgentPerplOnboarder` priced the three legs in the agent's own MON and
   answered `needs_gas` forever; `ReturnFundsService` did the same
   (`return_gas_insufficient`). Both now step aside when
   `AgentTransactionSender.sponsorsGasFor(agent)` — sends are sponsored **and**
   the agent's live policy has the twins. An agent whose policy predates the
   flag still signs, so it is still gated.
2. **Platform limit: a delegated agent can never move native MON.** Monad's
   reserve balance forbids an EIP-7702-delegated account to go below 10 MON,
   with no exception (gotcha 12). Signed, the deposit reverts and burns gas
   (7e); sponsored, Privy accepts it and the bundler silently drops it (7b).
   The `deposit` tool now refuses a native-MON deposit from an agent whose gas
   is sponsored as `native_mon_reserve`, before anything is signed, precheck on
   or off.
3. **Product: no MON drip under the flag.** MON sent to such an agent could
   only be stranded: nothing it may do needs it, returns never sweep it, and it
   cannot leave. A hire with the flag on records `gasFunding.reason:
"gas_sponsored"` instead of spending `GAS_DRIP_AGENT_AMOUNT_MON`.
4. **A fallback the agent cannot pay for** used to reach the RPC and fail as
   the bare "Missing or invalid parameters"; it is now an `InsufficientGasError`
   after the enclave signs and before anything is broadcast (a forbidden call
   is still the enclave's refusal).
5. **Observability**: the API logs every agent transaction's path
   (`sponsored`, `signed`, `signed_after_refusal`), user operation, bundle and
   timings — the source of the latency figures above.

Also learned, no code needed: MON sent TO a delegated wallet needs more than
21,000 gas (7a). The agent drip already picks its limit by `eth_getCode`
(`GAS_DRIP_GAS_LIMIT_CONTRACT`, 46,000), `agent:fund` refuses MON to an address
with code, and the app's Fund sheet sends sponsored, sized by the bundler.

#### Verdict, and how to turn it on

**Safe to enable in production once this branch is merged and deployed with the
web app and a new APK.** Sponsorship worked for every agent write the product
makes — Kuru deposit, fee approve, market buy and sell, withdraw, return,
Perpl's three onboarding legs, before and after an amend and after a revoke —
from a wallet holding 0 MON, and the enclave refused every forbidden call on
the send path exactly as on the sign path. Without the fixes it is not safe:
an AUSD-funded agent could not open Perpl.

1. Merge `test/SEN-212-sponsored-e2e`, and ship the **APK** first or together:
   an app build without SEN-211's `approval.ts` refuses to sign an amend or a
   **revoke** of a policy carrying the twins. `deploy.sh` ships the web build
   with the API, so the web app follows on its own.
2. Change the one line of copy that becomes false,
   `apps/mobile/src/howItWorks/content.ts`: "Agents are separate wallets and
   pay their own gas in MON."
3. Check the Privy dashboard's gas credits for Monad testnet (about 0.04 MON
   equivalent per agent transaction).
4. Put `AGENT_SPONSORED_SENDS=1` in the repo `.env`, then:

   ```bash
   cd infra
   DRY_RUN=1 ./push-secrets.sh          # AGENT_SPONSORED_SENDS must be listed as sent (it is in api-env.allowlist)
   PROJECT=… ZONE=… ./push-secrets.sh
   PROJECT=… ZONE=… ./deploy.sh         # recreates the API container; the flag is read at boot
   ```

   The boot log says `agents: transactions Privy-sponsored (AGENT_SPONSORED_SENDS)`;
   each transaction then logs `[AgentTransactions] sponsored ok …`.

5. **Existing agents need an amend to get sponsorship, and nothing breaks
   meanwhile.** Every agent hired before the flag has no twins: its sends are
   refused on the sponsored path and carried by the sign path, paid in its own
   MON, as today (`signed_after_refusal` in the log). They are device-owned, so
   only their owners can amend them — any mandate edit approved in the app
   compiles the twins (there is no bulk path; gotcha 13). On the box, the
   active ones without twins:

   ```sql
   SELECT id, user_id FROM agents
   WHERE status = 'active' AND archived_at IS NULL
     AND coalesce(json_extract(data, '$.sponsoredSends'), 0) != 1;
   ```

   Revoked agents need nothing new: their returns keep signing with their MON.

6. Rolling back is removing the flag and redeploying, with one cost: agents
   hired under it got no drip and are delegated, so on the sign path they pay
   gas from MON they do not have until someone funds them (with more than
   21,000 gas, 7a).

Not exercised here: the ERC-8004 mandate anchor (its registrar key was blanked
locally with the other sender keys; `mandate-anchor.spec.ts` covers hashing the
twins), the model-driven runner (the tools are the same ones `/mcp` serves), Kuru Set D,
and a Kuru `cancel` (a `batch`, the same rule shape as an order).

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
| An agent's whole lifecycle, 0 MON? (run 5)        | yes, after SEN-212's fixes; native MON can never leave it         |

What is still open, and neither is this document's to close:

1. **Perpl enrollment from a delegated user wallet**, against the struct Perpl
   actually serves (gotcha 13). The signature shape is no longer the risk; the
   `types` still are.
2. **The user gas drip is now unnecessary for Privy users.** `POST /gas/drip`
   (SEN-16) exists so a user's own account can pay for its own transactions; a
   Privy user never needs MON for a transfer, because sponsorship pays. It is
   deliberately **left in place** — the Kernel path still uses it until SEN-45,
   and agents still get their own drip (SEN-14) — but nothing on the Phase 3
   path calls it, and the demo should not. An agent's wallet can be sponsored
   too since SEN-211 (run 4 above), behind `AGENT_SPONSORED_SENDS`.
