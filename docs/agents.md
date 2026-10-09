# Agents on the venues

How an agent's Privy wallet trades on Kuru and Perpl (SEN-6), and what the live
check on Monad testnet (10143) proved on 2026-09-11.

## The model

An agent trades from **its own EOA**: a Privy server wallet whose key lives in
the enclave and signs only what its compiled mandate policy allows (SEN-2,
SEN-3). The agent owns its own venue accounts, separate from the user's:

| Venue | Agent's account                                    | User's account (gotcha 9) |
| ----- | -------------------------------------------------- | ------------------------- |
| Kuru  | AccountCore root = the agent EOA (`userId = 0`)    | the Kernel smart account  |
| Perpl | owned by the agent EOA; API key enrolled by it too | the passkey EOA           |

A Privy wallet is a plain secp256k1 EOA, so Perpl's `ecrecover`-only
enrollment works for it exactly as for the passkey EOA.

## The code (`services/api/src/agents/venues/`)

| File                        | What it is                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `agent-transactions.ts`     | `AgentTransactionSender`: sign at Privy, broadcast ourselves, read the receipt. One transaction in flight per wallet. |
| `privy-kuru-submitter.ts`   | `PrivyKuruSubmitter implements KuruSubmitter`, and `kuruGasLimit(call)` — the fixed gas table.                        |
| `perpl-agent.ts`            | `PerplAgentAccounts`: `onboard(agent)`, `credentials(agent)` (enroll once, then reuse).                               |
| `agent-secret-store.ts`     | `AgentSecretStore` behind `AGENT_SECRETS`; `InMemoryAgentSecretStore`; sealed credentials.                            |
| `agent-venues.ts`           | `AgentVenues.forAgent(agent) → { kuru, perpl? }`, `release(agentId)`.                                                 |
| `agent-venues.providers.ts` | Nest wiring. `AgentsModule` exports `AGENT_SECRETS`, `AgentVenues`, `PerplAgentAccounts`, `AgentTransactionSender`.   |

The venue files use `.ts` specifiers and erasable syntax only, so the scripts
load them under node's type stripping (CLAUDE.md gotcha 10). Nest wiring lives
in `agent-venues.providers.ts`.

### What the runtime (SEN-7) calls

```ts
type AgentIdentity = { agentId: string; walletId: string; address: Address };

const { kuru, perpl } = await agentVenues.forAgent(agent); // perpl only once enrolled
await perplAccounts.onboard(agent); // 3 txs; a no-op if the account exists
await perplAccounts.credentials(agent); // enrolls once, stores, reuses
agentVenues.release(agent.agentId); // on revoke: closes the Perpl socket
await secrets.deleteAgent(agent.agentId); // on revoke: forget the Perpl key
```

Ask `forAgent` per task. A set left idle for 5 minutes is torn down, Perpl
socket included, and the next call builds a fresh one.

### Transactions

- **Signed in the enclave, broadcast by us.** Each call becomes one
  `eth_signTransaction` with `chain_id: 10143` and every integer as `0x`-hex
  (Privy rejects decimal strings). Then `eth_sendRawTransaction`, then the
  receipt. For an EOA the receipt's `status` **is** the outcome, so `success`
  comes from it. Gotcha 8 is about UserOperations and does not apply here.
- **One in flight per wallet.** Sign, broadcast and receipt finish before the
  wallet's next transaction starts, and a call list is one unit of that queue.
  Kuru and Perpl onboarding share the queue: there is one
  `AgentTransactionSender` per process. The queue keeps nonces sane and keeps
  Privy's rolling-cap aggregation as exact as Privy allows (SEN-3: Privy
  records a signature late). The nonce is `max(pending, last + 1)`, because
  the public RPC is load-balanced and can lag its own receipts.
- **Not atomic.** `approve` then `deposit` are two transactions. A list stops
  at the first revert and reports `success: false` with that hash, and
  anything already landed stays landed. The Kernel batch the user's app
  sends is atomic; this one is not.
- **A refusal sends nothing.** `EnclaveRefusedError` propagates unchanged from
  the signing call, before anything reaches the chain. An unmeasured call
  (`UnmeasuredCallError`) is refused before its list signs its first leg.
- **Fixed gas, never estimated** (gotcha 4). The receipts below show Monad
  charges exactly the limit: `gasUsed` equals the limit on every one of them.

| Call                                | Limit   | Source                                                                |
| ----------------------------------- | ------- | --------------------------------------------------------------------- |
| ERC-20 `approve` (USDC, AUSD)       | 80,000  | measured 52,089 (USDC) and 71,099 (AUSD, fresh spender)               |
| Kuru `AccountCore.deposit`          | 252,059 | `KURU_MEASURED_GAS.firstDeposit` (includes registration)              |
| Kuru `batch`, one order             | 425,430 | `placeTakingOneLevel`; covers a resting GTC (404,204)                 |
| Kuru `batch`, one cancel            | 242,923 | `cancelOne`                                                           |
| Kuru `AccountCore.withdraw`         | 150,407 | `KURU_MEASURED_GAS.withdraw`; landed using exactly this (SEN-15)      |
| ERC-20 `transfer` (return to owner) | 46,525  | `KURU_MEASURED_GAS.erc20Transfer`; landed using exactly this (SEN-15) |
| Perpl `createAccount`               | 203,000 | measured 202,237                                                      |
| Perpl `allowOrderForwarding(true)`  | 72,000  | measured 71,363                                                       |

An IOC order that sweeps more than one price level can need more than 425,430.
Pass `gasLimit` to `PrivyKuruSubmitter` for that.

### Perpl credentials

`credentials(agent)` returns the stored key if one is held. Otherwise it checks
that the address has a Perpl account (no sign without one) and enrolls with
`enrollApiKey`, whose signer is
`{ address, signTypedData: td => AGENT_WALLETS.signTypedData(walletId, td) }`.
Then it stores the key. Concurrent callers share one enrollment. The Ed25519
secret never leaves the server. The store hands out **sealed** objects whose
fields are readable but not enumerable, and `JSON.stringify` and
`util.inspect` print `[PerplCredentials redacted]`.

The store is **in memory**, like the gas drip ledger. A restart forgets every
key, and the next use enrolls a new one; an account holds at most 16 active
keys. A durable store must encrypt at rest. Rebind `AGENT_SECRETS` and nothing
else changes.

### Gas and collateral for the agent EOA

Collateral comes from the user in production. **Gas on hire is not wired
yet.** The hire route is SEN-5's, and `GasDripService.drip` refuses
`user_already_dripped` for a user whose passkey EOA was already funded. So an
agent drip needs its own principal namespace (e.g. `agent:<id>`) and its own
IP bucket. Size it too: one pass of this live check cost the agent 0.138 MON
(below).

For development, `pnpm --filter @sente/api run agent:fund -- --to <addr>
--mon … --ausd … --usdc …` funds an agent from `TREASURY_PRIVATE_KEY`:

- it refuses anything above 0.25 MON, 150 AUSD or 100 USDC, and refuses
  addresses controlled by published keys (gotcha 11);
- it claims Kuru USDC from the faucet when the treasury holds too little;
- it never prints the key.

## Monad's reserve balance bit the treasury

Treasury nonce 13 was a 0.2 MON transfer to the agent. It **reverted**, and the
trace reads `"error":"reserve balance violation"`. It came one block after the
treasury's faucet claim, with the treasury holding 4.09 MON, below the
10 MON default reserve. The same transfer sent on its own a few minutes later
landed.

The reading is Monad's reserve-balance rule: a value transfer may take an EOA
below the reserve only as an "emptying" transaction, which needs the sender
to have sent nothing in the last few blocks. The trace string and the
sequence are observed. The exact block window is not measured.

`fund-agent` now sends native MON first. Gas-only ERC-20 calls were
unaffected.

**Open for the gas drip:** a drip sender holding under 10 MON sends a value
transfer on every drip. Two drips from the same sender a block or two apart
would revert the second, and Monad charges the full 21,000 gas limit for it.
`SenderPool` with 3–5 keys spreads the load, but nothing enforces spacing.

## Live check — 2026-09-11

`pnpm --filter @sente/api run agent:venues-live [-- --skip-kuru]`
(`services/api/scripts/agent-venues-live.ts`).

**Agent:**

- Privy wallet `<privy-agent-venues-wallet-id>`, display name
  `sente-agent-venues-live`, EOA `0xE05F6A1e4d896f48dDcA52e46a05A6c7ffab0B6E`.
- Policy `<privy-agent-venues-policy-id>`, compiled from this mandate:
  - Kuru: MON-USDC, deposits ≤ 20 USDC per transaction.
  - Perpl: BTC-PERP, collateral ≤ 100 AUSD, leverage ≤ 5.
- Ids are recorded in the main checkout's `.env` as `PRIVY_AGENT_VENUES_*`.

**Run 1: provision and stop.** The script created the wallet and policy and
stopped at the funding gate. Nothing was sent.

### Run 2: Kuru passed; Perpl onboarded, then enrollment was REFUSED

| Step                                                                   | Result                                           | Transaction / id                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| over-cap deposit (25 USDC > 20)                                        | `EnclaveRefusedError`, nonce 0 → 0, nothing sent | —                                                                    |
| Kuru `approve` 12 USDC → AccountCore                                   | success                                          | `0xb716556681863c8843b6bd41b60368a94221f58bd6e0b16faaaaee15c433342b` |
| Kuru `deposit` 12 USDC                                                 | success, account id 64                           | `0x90a5453e5f8642a7a5c1b78f2b7d6deb18b74934ba6ceec03c1b9214c3fe5a40` |
| Kuru GTC bid 726.59331535 MON @ 0.014451 (half the best bid, 0.028902) | resting, order `0:3918`; Gateway listed it       | `0xbc839d3cd579c5b897f88bd80ba890e0969d66501df00bd0b84a362e1e294092` |
| Kuru cancel `0:3918`                                                   | `cancelled`                                      | `0xf344784edf70d6eebc633897e23bb894dc7da1655b840499f77e8dd58eeb45c9` |
| Perpl `approve` 100 AUSD → Exchange                                    | success                                          | `0x19ad432882e6f3335c15fe9ca72cfc00b8b9f4303408bfd73787a46195d1fea2` |
| Perpl `createAccount(100 AUSD)`                                        | success, **account 505**                         | `0x1ca3da474add080bdb1c2e8a6076e03d3db63edbfc057d42eb6fc5bb00cac2d9` |
| Perpl `allowOrderForwarding(true)`                                     | success                                          | `0x10623c0f385e884a932b0424c59c3cbb17bb99c6dea02e69751b484d0e5392b7` |
| Perpl enrollment (`eth_signTypedData_v4`)                              | **refused, `policy_violation`**                  | —                                                                    |

**Why the enrollment was refused.** The enclave was right, and our policy was
stale. Perpl's live `PerplRegisterApiKey` struct had grown from the 6 fields
recorded on 2026-09-10 to 11, adding `expiresAt`, `ipCidrs`, `origin`,
`builderId` and `maxBuilderFeePer100K`. A Privy typed-data message condition
matches only when its `types` equal the request's exactly (SEN-3 finding 4).
So the compiled `statement` condition never matched, and the enclave failed
closed.

SEN-3's check 6 had passed only because it signed typed data built from our
own constant, never from a live payload. The domain `salt` also changed
between the two days (`…6aa2f731…` → `…6aa3eb20…`). No policy compares the
salt, so that change is harmless.

**Fix:**

- `PERPL_API_KEY_TYPED_DATA` in `packages/venues/src/perpl/constants.ts` now
  carries the 11-field struct.
- The live script re-PATCHes its own policy with freshly compiled rules on
  every reuse.
- **Every agent policy compiled before this change must be PATCHed**, or its
  agent can never enroll.

### Run 3 (`--skip-kuru`): all steps passed

| Step                                     | Result                                                          | Transaction / id                                                     |
| ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| policy recompiled + PATCHed (5 s settle) | ok                                                              | policy `<privy-agent-venues-policy-id>`                              |
| over-cap deposit again                   | `EnclaveRefusedError`, nonce 7 → 7, nothing sent                | —                                                                    |
| Perpl onboard                            | no-op: account 505 exists                                       | —                                                                    |
| Perpl enrollment via the agent's wallet  | enrolled; the second `credentials()` call reused it             | key held server-side, never printed                                  |
| POST_ONLY bid 0.001 BTC @ 69,248.1       | `open`, order **4037575770112**                                 | `0x0d1006acc90fae89fbac52f88925fc69ad84c72ae62dca12f5e0445c84ce0b68` |
| cancel 4037575770112                     | `cancelled`                                                     | `0x0a063508cdc23143e5aa5a2ba9f6cffeb9be9ef630154c9591e0a4aa069d6bd0` |
| market buy 0.001 BTC, 5x                 | `filled` @ 76,982.4, order **4037576294400**                    | `0xa5f47f261c7697b56da1d557865ee27e0dd2fcd5a782fb7f07da1b27c8a97f49` |
| close the position                       | `filled` @ 76,945.5, order **4037576556544**; 0 positions after | `0x3fe6eb6bc204e88508334ff477633106dffe70bba8e2926309f39a53e12979b0` |
| socket closed via `AgentVenues.release`  | ok                                                              | —                                                                    |

Perpl orders are forwarded, so the exchange pays their gas, and the agent spent
**0 MON** in run 3. Its Perpl balance went 100 → 99.909994 AUSD (the
round-trip's fees and price move).

### Funds spent (both SEN-6 sessions)

The first SEN-6 session was cut off before it sent anything; the treasury
read nonce 12 and 4.095 MON at resume.

| Account                | Change                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treasury `0x93e6…33b8` | **−0.248552 MON** (0.2 sent to the agent; 0.048552 gas across 5 txs, including 0.002142 for the reverted transfer). **−100 AUSD** (19,900 → 19,800). USDC **+10,000** from the faucet (`0x55017d7422a3fd565754347a311c03fe362aae20db9841ff80ee28afbced367b`), **−12** to the agent. |
| Agent `0xE05F…0B6E`    | 0.138252024 MON of gas (7 txs, 1,355,412 gas at 102 gwei). Holds 0.061747976 MON, 12 USDC in Kuru AccountCore, and 99.909994 AUSD in Perpl account 505.                                                                                                                             |

Funding txs: MON `0x78cef755919eee0af91e318170b8c3c468f97d5cb2ddd8a31ae0d7e85bef205b`,
AUSD `0xa6ab4f761f7eeb98f6552cdbc2dca6c1535684b740eefe7fcd8b52cad81344c3`,
USDC `0x708f5a489fcee075a9bd3533d4b2452d1370f50ec6bcfdb08c491ad54a16a96b`.
The reverted MON transfer is
`0x5aa461749014fc69e48392f5147f325aa2d7de6fb13d49eda7134adbf9141d6c`.

### Privy objects created

- Only in the shared app, only `sente-`-named: the wallet and policy above.
- One PATCH, to that same policy.
- Nothing else in the app was read or touched.

## Rerunning

```bash
pnpm --filter @sente/api run agent:venues-live -- --env-file ../../.env   # or omit in the main checkout
pnpm --filter @sente/api run agent:venues-live -- --skip-kuru             # Perpl only, no MON
```

When the agent is short, the script prints the exact `agent:fund` command and
stops. Each run enrolls one new Perpl key, because the secret store is in
memory.

## Getting the money back: withdraw and return to owner (SEN-15, SEN-17)

An agent funds its own Kuru account, so its mandate must also let that money
come back out, and only ever toward the owner. Until SEN-15 the compiled
mandate had no withdraw rule, and the probe agent's 14 USDC sat in AccountCore
where its wallet could not reach it.

### Two recovery rules

`compileMandate` adds them:

| Rule                                                           | Conditions                                                                            | Why no other recipient can be named                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Kuru: withdraw to its own wallet`, whenever Kuru is a venue   | `chain_id`; `to` = AccountCore; `function_name` = `withdraw`, with a one-function ABI | `withdraw(token, amount)` has no recipient parameter: AccountCore debits the caller's account and pays the caller. A `debug_traceCall` from the agent showed `Withdrawal.recipient` = the agent before any code was written. `withdrawFromAccount(account, …)` also pays the caller (`account` is the source), and `transferBetweenAccounts(from, to, …)` names a destination inside Kuru. Neither decodes against the one-function ABI, so both are refused. |
| `Return <TOKEN> to the owner`, when the mandate has `returnTo` | `chain_id`; `to` = the token; `transfer.to` = `returnTo`                              | One rule per ERC-20 the wallet can hold (USDC, WETH, cbBTC, XAUt, AUSD), whatever the venues, so funds an earlier mandate allowed can still go home.                                                                                                                                                                                                                                                                                                          |

**SEN-185 changed the first row.** Kuru's current AccountCore takes
`withdraw(rootAccountId, token, amount, recipient)` and pays whoever it names, so
the rule is now `Kuru: withdraw to the owner` with `withdraw.recipient` pinned
to `returnTo`, collateral goes straight home, and a mandate without `returnTo`
has no withdraw rule. Deposits name a `rootOwner`, pinned to the agent on every
amend. The table and the first bullet below describe Set C, and the live runs
in this section all landed on Set C (`docs/privy-policy-enforcement.md`,
"Kuru's account-id AccountCore").

The choices, and why:

- **The contract pins the withdraw recipient; no address condition does.** No
  AccountCore withdraw function takes an outside recipient, so pinning the
  function pins the recipient to the signer. It also means the rule needs no
  agent address, which matters because hire compiles the policy before the
  wallet exists. An address pin would cost a second PATCH after every hire.
- **`returnTo` is an optional mandate field, and the SERVER writes it**
  (SEN-17): the address of the caller's own Privy user wallet, out of the
  registry `POST /wallet/register` fills (SEN-40), EIP-55 checked, never the
  zero address. It is the user's wallet and not the old Kernel smart account,
  because Phase 3 made that the user's account and SEN-45 retires the other one.
  Resolution happens in `AgentsService.parseFor`, on every hire, fork and amend:
  - a client value equal to it (in any case) is accepted, a different one is
    refused `return_address_mismatch`, and one sent by a caller with no
    registered wallet is refused `return_address_unavailable`. A client that
    could name the exit could name its own;
  - without it — a caller with no wallet — the mandate compiles with no transfer
    rule and the wallet can send nothing (fail closed). Every agent hired before
    SEN-17 is in that state, and an amend gives it a way out.
- **Native MON is not covered.** A `to = returnTo` value rule would also let
  the agent call the owner's account with any calldata. Leftover gas stays
  with the agent.
- **Both survive mandate expiry, AND revocation** (SEN-17). They carry
  `chain_id` and no `current_unix_timestamp`, unlike every risk-taking rule,
  because each can only move money toward the owner. If they expired, an expired
  agent's collateral would be stranded until the owner re-PATCHed the policy —
  and a revoke used to do exactly that stranding, by replacing the policy with
  `[]`. It now replaces it with `compileRevocationRules(mandate)`: these two
  rules and nothing else. See "What a revoke leaves behind" below. Layer 1 agrees:
  `checkIntent` passes `withdraw` like cancel and close, after expiry too. A
  Kuru cancel still expires in the enclave, because a cancel `batch` cannot
  be told apart from a placing one.
- **Tool:** `withdraw {asset, amount}` is a write with no thesis and no
  notional cap, allowed on Kuru even after expiry. It calls
  `KuruVenue.withdraw` (`withdrawCall`, fixed gas 150,407). Only free balance
  can leave; resting orders keep their reserve until cancelled.
- **The user-side path is a route, not a script** (SEN-17):
  `POST /agents/:id/return {asset?, amount?}` →
  `ReturnFundsService` (`services/api/src/agents/recovery/`). Per asset it reads
  the free Kuru collateral (`AccountCore.getBalance`, one call per token rather
  than `getBalances`' ten — the public RPC allows 15 a second), withdraws it to
  the agent's own wallet, re-reads the wallet balance and transfers it to
  `returnTo`, through the same per-wallet `AgentTransactionSender` queue. No body
  sweeps every returnable asset; `{asset}` picks one, `{asset, amount}` part of
  one.
  - **Agent-signed, so no owner signature is involved.** Both legs are rules the
    policy already carries, so the route stays one call even for a device-owned
    agent — there is nothing here a prepare/commit pair could add that the policy
    does not already pin.
  - **It works on a revoked or expired agent**, which is the whole point.
  - Refusals, all before anything is signed: `return_address_missing` (409, the
    mandate names no exit), `return_asset_not_supported` / `return_amount_invalid`
    (400), `return_gas_insufficient` (409, with the shortfall and the
    `agent:fund` command — Monad charges the gas limit), `agent_not_found` (404).
    Each leg reports its own hash and its own `success`: an agent wallet is an
    EOA, so a withdraw that landed stays landed even if the transfer after it
    reverts, and the response never averages the two into one verdict.
  - **Native MON is never swept.** An agent's leftover gas stays with it.
  - On the phone: a "Return funds" button on the agent screen, on an active agent
    and on a revoked one, confirmed in an in-app sheet (`app/agents/[id].tsx`).

### What a revoke leaves behind (SEN-17)

Revoking used to PATCH the policy to `[]`. That stops the agent — and also
strands whatever it is holding, because a wallet whose policy has no rules can
sign nothing at all, and a revoked agent cannot be amended either
(`agent_revoked`). The owner's money then depended on someone re-PATCHing the
policy with the owner key, which in `device` mode is a phone ceremony and in the
worst case a lost key.

So a revoke now leaves the way out open: `compileRevocationRules(mandate)` — the
Kuru withdraw and the per-token returns, and nothing else.

| After a revoke                                  | Before SEN-17 | Now          |
| ----------------------------------------------- | ------------- | ------------ |
| `approve`, `deposit`, `batch`, Perpl enrollment | refused       | refused      |
| `AccountCore.withdraw` to its own wallet        | refused       | **signed**   |
| ERC-20 `transfer` to `returnTo`                 | refused       | **signed**   |
| ERC-20 `transfer` anywhere else                 | refused       | refused      |
| `POST /agents/:id/return`                       | impossible    | **the exit** |

Nothing in that list is new authority: every surviving rule was already in the
live policy, so a revoke can still only take rules away. A mandate with no
`returnTo` and no Kuru venue still revokes to `[]`, which is the fail-closed
case rather than the intended one.

`policyCleared` keeps its name and means what it always did — the revocation
PATCH landed — but "cleared" now means "cleared of everything that takes risk",
not "empty". A device-owned revoke goes through the same prepare/commit pair as
before (SEN-44), and the phone checks the payload against its own mirror of
`compileRevocationRules` (`apps/mobile/src/agents/approval.ts`), so it refuses to
sign a revoke that would leave the agent able to trade — and equally refuses one
that would sign the exit away.

### Live check — 2026-09-11, all 21 checks passed

`pnpm --filter @sente/api run agent:withdraw-live [-- --env-file <path>]`
(`services/api/scripts/agent-withdraw-live.ts`).

The mandate was compiled with **`returnTo` = the treasury
`0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8`**, standing in for the owner's
smart account. This probe agent has no smart-account owner; the treasury
funded it. The mandate also allowed Kuru MON-USDC, USDC deposits of at most
1 USDC, and 24 h, which compiled to 9 rules. The owner key PATCHed it over the
empty policy SEN-9's revoke left. The PATCH returned in 299 ms, and the rule
answered twice in a row 1,326 ms later.

Sign-only probes, each at a nonce a million ahead and **never broadcast**:

| Probe                                               | Live mandate | Expired mandate |
| --------------------------------------------------- | ------------ | --------------- |
| `withdraw(USDC, 14)`, which pays the agent itself   | signed       | **signed**      |
| `withdrawFromAccount(treasury, USDC, 1)`            | refused      | refused         |
| `withdrawFromAccount(agent, USDC, 1)`               | refused      | —               |
| `transferBetweenAccounts(agent → 0x…dEaD, USDC, 1)` | refused      | —               |
| USDC `transfer(treasury, 14)`                       | signed       | **signed**      |
| WETH `transfer(treasury, 1)`                        | signed       | —               |
| USDC `transfer(0x…dEaD, 14)`                        | **refused**  | **refused**     |
| USDC `transfer(agent itself, 14)`                   | refused      | —               |
| `approve(AccountCore, 1 USDC)`, within the cap      | signed       | **refused**     |
| `approve(AccountCore, 2 USDC)`, over the cap        | refused      | —               |

The "expired mandate" column is the same mandate with `expiresAt` 60 s in the
past. The PATCH returned in 358 ms and applied 1,233 ms later.

Then it moved the money for real, which proves the ABI as well as the rule
shape (gotcha 13):

| Step                                    | Result                                                                                       | Transaction                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `withdraw` 14 USDC from Kuru account 64 | success; `Withdrawal.recipient` and `Transfer.to` = the agent `0xE05F…0B6E`; gasUsed 150,407 | `0x6b12d44db57c0655e3c415596848c4e04913035ac10e5963e31755032a068c7b` |
| USDC `transfer` 14 to the treasury      | success; `Transfer` agent → treasury, 14,000,000 atoms; gasUsed 46,525 (estimate 46,525)     | `0xc9e1cb5f383c28088f967fbf40c44c16151eb99dc6d0ab02e564a5739d25d048` |

**Spend.** The agent paid 0.020087064 MON of gas: 0.015341514 for the
withdraw and 0.00474555 for the transfer, both at 102 gwei, each charged its
full limit. Its balance went from 0.027877958 to 0.007790894 MON, nonce 9 → 11. The
treasury got its 14 USDC back and spent nothing. No top-up was needed.

**State left behind.** The agent holds 0 USDC, in its wallet and in Kuru,
and about 0.0078 MON. Its policy `<privy-agent-venues-policy-id>` is left on the
**expired** mandate, so it signs only a withdraw to itself and a return to the
treasury. `agent:venues-live`, `agent:run-live` and `demo:refusal` re-PATCH it
as before. Only this wallet's own `sente-` policy was touched: two owner
PATCHes and 23 sign-only probes, and nothing else in the shared Privy app.

### Live check — 2026-09-25, the whole path from the product, all 8 checks passed

`pnpm --filter @sente/api run build && pnpm --filter @sente/api run agent:return-live`
(`services/api/scripts/agent-return-live.ts`). Unlike `agent:withdraw-live`, which
re-arms the SEN-6 probe wallet, this hires a REAL agent through
`AgentsService.hire` and takes its money back through `ReturnFundsService`, so
what it proves is the product's own path. The dev treasury
`0x93e6…33b8` stands in for the owner's Privy wallet — it is bound in the user
wallet registry as this run's owner, so `hire` resolves `returnTo` exactly as it
does for a real user, and the money goes back where it came from.

| Step                                               | Result                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| hire (agent `0x2E4A89c5…64Ea`, policy `hhwpau0e…`) | `mandate.returnTo` = the treasury, resolved server-side with no client value; 9 rules, 5 of them `Return <TOKEN> to the owner` |
| treasury → agent                                   | 0.06113176 MON `0x90af259e…94b5` (the drip was unconfigured), then 1.5 USDC `0x09df6aa5…a317`                                  |
| the AGENT deposits into Kuru                       | 0.5 USDC `0x62f824f6…0310`; free collateral 0.5 USDC, wallet 1 USDC                                                            |
| revoke                                             | policy left with **6 rules**: the Kuru withdraw and the five returns. No approve, no deposit, no market                        |
| `returnFunds` on the REVOKED agent                 | withdraw 0.5 USDC `0x17995a4f…278d`, then transfer **1.5 USDC** to the treasury `0x47aa7e8c…ada1`, both `success`              |
| balances                                           | agent 1 USDC + 0.5 in Kuru → **0 and 0**; treasury 9,981.3 → **9,982.8 USDC**, exactly the 1.5 it funded                       |

**Spend.** The agent paid 0.020087064 MON of gas for the two return legs (MON
0.027261742 → 0.007174678), the same figure SEN-15 measured for the same pair of
transactions. The treasury is whole in USDC and spent 0.0611 MON on the top-up
plus two transfers' gas.

**State left behind.** Agent `0x2E4A89c5…64Ea` is revoked, holds no tokens and
about 0.0072 MON, and its policy holds the six recovery rules — the honest
end state, and the one a user's revoked agent will be in. Its leftover MON is
not recoverable: no rule lets an agent move native MON.

**An accidental second proof.** An earlier attempt on this branch left 1 USDC
(plus 0.5 in Kuru) in agent `0x2928b02f880fd9Ed0486ffB99179448a75aF2f25`: it
failed between the revoke and the return, on Monad's public-RPC 15-a-second
limit, which is what moved the collateral read off `getBalances`. Its agent
record only ever lived in that process's memory, so the product could not reach
it — but its POLICY still carried the recovery rules, which is the property this
issue is about, so a throwaway script signing through the same
`AgentTransactionSender` emptied it: withdraw
`0xdc9a149b91415a6cd4230a30ea44aac951ba1118443e5f2f339beaf3e5d6b2c6`, transfer
`0x2d085f0298b7add89c2e5ee5a81a391ef962e6a0c033d67a75a4839c89f72dea`, 1.5 USDC
back to the treasury for 0.0201 MON of that agent's own gas. A revoked agent's
money is reachable as long as anything can address its wallet — which is the
argument for SEN-48's persistence, not against the exit rules.

## The Sente fee on agents' Kuru orders (SEN-184)

An agent's Kuru orders pay Sente's builder fee (10 bps, to `KURU_BUILDER_ADDRESS`)
through Kuru's builder overload of `batch` (`docs/kuru.md`, "Builder fee").
**Perpl orders carry no Sente fee.**

The enclave is what bounds it. A policy compiled with the fee
(`compileMandate(mandate, { kuruBuilder })`) has one rule that lets the agent
approve Sente's builder, at no more than the rate and until no later than the
mandate's expiry, and one rule per market that lets it place through the builder
overloads (`docs/privy-policy-enforcement.md`, "The Sente fee rules"). Before an
order, `KuruVenue` adds an `approveBuilder` transaction when the agent's approval
does not cover the rate; the order then names Sente as builder.

**Old policies keep working, without the fee.** A live policy is whatever was last
PATCHed (CLAUDE.md gotcha 13), and one compiled before SEN-184 has no builder
rules: the enclave would refuse a builder order. So the agent record carries
`kuruBuilder` — the builder and maximum rate its live policy was compiled with —
set at hire, fork and amend, and `agentKuruBuilder` gives an agent's venue the fee
only when that grant names the configured builder at no less than the configured
rate. Every other agent places through the plain overloads, which every policy
signs. To move an existing agent onto the fee, amend its mandate (unchanged is
fine): a server-owned agent with `PATCH /agents/:id/mandate`, a device-owned one
with an amend its owner approves on an app build that pins the same builder and
rate (`EXPO_PUBLIC_KURU_BUILDER_*`). The phone accepts a policy with the fee
rules only for its pinned builder, and one without them always, so with the fee
on an app build WITHOUT the pin refuses every amend of a device-owned agent: ship
the pinned app before setting `KURU_BUILDER_ADDRESS`. Revokes are unaffected (a
revoked policy carries no fee rule). Revoked agents trade nothing, fee or not.

**What each fill records.** A Kuru fill event carries `senteFee` and
`senteFeeAsset` — what AccountCore's `BuilderFeeAccrued` said this agent paid in
that execution — next to the venue's own `fee`.

**Creators get 3 of the 10 bps.** When the trading agent was forked from another
user's agent (`forkedFrom`), the source agent's owner is owed 3/10 of each fill's
Sente fee, floored to whole atoms. `CreatorFeeEventLog` records that share in
`<STATE_DIR>/creator-fees.json` as the fill event is appended, once per agent and
transaction, whichever writer appended it. Forking your own agent accrues
nothing. The creator reads it at `GET /creators/me/fees`:

```json
{
  "share": "0.3",
  "totals": [{ "asset": "USDC", "accrued": "0.0105", "paid": "0", "owed": "0.0105" }],
  "recent": [
    {
      "kind": "accrued",
      "asset": "USDC",
      "amount": "0.0105",
      "fee": "0.035",
      "agentId": "…",
      "sourceAgentId": "…",
      "txHash": "0x…",
      "at": "2026-10-09T10:00:00.000Z"
    }
  ]
}
```

The fee itself lands in the treasury whole. Paying creators is periodic and by
hand: send the amount from the treasury, then record it, with the API stopped
(the script takes the `STATE_DIR` lock):

```bash
pnpm --filter @sente/api run creator:payout -- --state-dir services/api/.state
pnpm --filter @sente/api run creator:payout -- --state-dir services/api/.state \
  --creator <userId> --asset USDC --amount 0.0105 --tx 0x<treasury transfer>
```

The first lists what each creator is owed; the second refuses a payout above what
is owed or a transaction hash already recorded. The treasury claims its accrued
builder fees from AccountCore with `claimBuilderFees(asset)` (by hand, not wired) on Set C;
on Set D (SEN-185) they credit the treasury's own root and leave by an ordinary
`withdraw(rootId, asset, amount, recipient)`.

### Live probe: PENDING

Two things only a live run can show, both covered by one command against a
throwaway probe agent (it only creates and re-PATCHes its own wallet's policy):

```bash
# .env: PRIVY_* and KURU_BUILDER_ADDRESS (the treasury) set.
pnpm --filter @sente/api run agent:venues-live -- --skip-perpl --builder --builder-take
```

1. **Privy matches the builder overloads by name.** The policy PATCH must be
   accepted with the new ABIs, the `approveBuilder` leg must sign, and the
   resting bid — the builder overload, whose `builderConfig` is a bare tuple,
   not the `tuple[]` the plain rules already proved — must sign. A
   `policy_violation` on the bid means Privy does not match it; the fallback is
   `KURU_BUILDER_AGENTS=0` (agents trade fee-free through the plain overloads
   while users' trades still pay), see `docs/privy-policy-enforcement.md`.
2. **What a taker fill is charged.** `--builder-take` buys the minimum as an IOC
   and prints `senteFee`; check `BuilderFeeAccrued` on that transaction for the
   side charged (taker), the asset (USDC) and the amount (10 bps of the
   notional), and compare its `gasUsed` with the plain place's 425,430 to replace
   `KURU_BUILDER_ORDER_SURCHARGE_GAS`.

## The runner (SEN-8)

An agent **runs** as one bounded Tool Runner loop
(`client.beta.messages.toolRunner`, `@anthropic-ai/sdk` 0.125.0) over the gated
tools (SEN-7). The loop uses the agent's own model, prompt and strategy, and it
is billed to its owner's OpenRouter key (SEN-4). It does not use the Claude
Agent SDK: that SDK's Bash and file tools are the wrong shape for a trading
agent, and the Tool Runner loops only over tools we define.

### The code (`services/api/src/agents/runner/`)

| File                        | What it is                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `agent-runner.service.ts`   | `AgentRunnerService.run(principal, agentId, {instruction?, trigger?}) → RunResult`.                     |
| `prompt.ts`                 | The three-part system prompt and the tick message.                                                      |
| `openrouter-client.ts`      | `createOpenRouterClient(key)`, `classifyModelError`, `redactSecrets`.                                   |
| `write-spacing.ts`          | `WriteSpacer` and `spaceWrites`: the one place signing writes are slowed down.                          |
| `agent-run.scheduler.ts`    | `AGENT_TICK_SECONDS`: runs every active agent on an interval. Off by default.                           |
| `runner.config.ts`          | The env → config loader. A malformed value fails the boot.                                              |
| `agent-runner.providers.ts` | Nest wiring. `AgentsModule` imports `CreditsModule`, spreads these in and exports `AgentRunnerService`. |

### One run

1. **Refused before anything is spent** (it throws):
   - `agent_not_found`: no such agent, or another user's;
   - `agent_revoked`;
   - `run_in_progress`: one run per agent at a time, per process;
   - `credits_unconfigured` / `provision_failed`.
2. **The key.** `CreditsService.keyFor(userId)` supplies it. A user without one
   is provisioned first. The client is
   `new Anthropic({ baseURL: 'https://openrouter.ai/api', authToken: key, apiKey: null })`.
   `apiKey: null` is load-bearing: without it the SDK sends an ambient
   `ANTHROPIC_API_KEY` to OpenRouter. A spec pins that no `x-api-key` header
   goes out even with one set. If the key's `limit_remaining` is already 0,
   the run ends `credits_exhausted` without calling the model.
3. **The prompt.** The system prompt has three parts:
   - (a) a fixed Sente preamble: the mandate can't be changed; `record_thesis`
     comes before any trade; refusals are final, so don't route around them;
     stop when there is nothing to do;
   - (b) the mandate, rendered by the same `describeMandate` that
     `get_mandate` returns;
   - (c) the user's `systemPrompt` and `strategy`, fenced in
     `<user_instructions>`.

   Any look-alike tag inside the user's text is defused. The first message is
   the tick snapshot: time, balances, positions, open orders and 5 levels of
   depth for every allowed market. It is read through the same gated read
   tools, followed by the optional `instruction`, fenced in
   `<user_run_instruction>`. The fence is hygiene, not the boundary: the
   mandate and the enclave are.

4. **The loop.** The call is
   `toolRunner({model, max_tokens: 4096, system, tools: toRunnerTools(ctx), messages, max_iterations: 12}, {signal})`,
   iterated with `for await`. Each turn's `tool_use` blocks are logged (name
   and truncated input). Before each turn's tools run, the agent is re-read,
   so an agent revoked mid-run stops there (`agent_revoked`). An
   `AbortController` enforces the wall-clock budget.
5. **After the loop**, the runner reads the last `stop_reason` itself. The
   Tool Runner ends quietly on `refusal`, `max_tokens` and
   `model_context_window_exceeded`, so without this check those look like
   success.
6. **A summary event**, kind `run`, is appended to the event log. It records
   the trigger, model, stop reason, iterations, tool calls, start, end and
   duration, whether the precheck was on, the instruction, the final text, a
   redacted error if any, and the cost.

Per-model request extras live in `AGENT_MODEL_REQUEST_EXTRAS`
(`agents.config.ts`). Kimi is pinned to
`provider: { order: ['Moonshot AI'], allow_fallbacks: false }`, as the credits
probe calls it. They reach the wire through a
`BetaToolRunnerParams & OpenRouterRequestExtras` value.

What is left out:

- `thinking` is behind `AGENT_RUNNER_THINKING=adaptive` and off by default,
  because the probe that would show it passes through OpenRouter is pending
  credentials.
- The server-side `fallbacks` beta is not used.

### `RunResult`

```ts
{
  runId, agentId, trigger: 'manual' | 'schedule', model,
  stopReason, iterations, toolCalls, startedAt, endedAt, durationMs,
  finalText?,   // the model's last words, truncated
  error?,       // redacted; never the key
  costUsd?,     // Σ OpenRouter usage.cost, else the key's usage_monthly delta
  events,       // this run's thesis/order/fill/refusal events, then its `run` summary
}
```

| `stopReason`                                             | Means                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `end_turn`, `stop_sequence`                              | The model finished.                                              |
| `refusal`, `max_tokens`, `model_context_window_exceeded` | The model stopped for that reason. Recorded, not hidden.         |
| `max_iterations`                                         | The loop hit its cap while the model still wanted tools.         |
| `timeout`                                                | The wall-clock budget (`AGENT_RUN_TIMEOUT_MS`) ran out.          |
| `agent_revoked`                                          | Revoked while the run was open.                                  |
| `credits_exhausted`                                      | OpenRouter's 402 (or a 403 about the key limit), or a spent key. |
| `model_error`                                            | Any other API failure; `error` says which.                       |

`costUsd` is best effort, because OpenRouter records key usage
asynchronously. The summary event keeps `reportedCostUsd` and
`keyUsageDeltaUsd` separately.

### `POST /agents/:id/run {instruction?}`

The endpoint uses the same session auth as every agents route (see
[Authenticating](#authenticating) below). The body is
`{instruction?: string}`, at most 2,000 characters, and nothing else is
allowed.

| Status | `reason`                           | When                                                              |
| ------ | ---------------------------------- | ----------------------------------------------------------------- |
| 200    | —                                  | Any run that ended on its own terms; the body is the `RunResult`. |
| 402    | `credits_exhausted`                | Out of credits; `run` carries the `RunResult`.                    |
| 502    | `model_error`                      | Upstream failure; `run` carries the `RunResult`.                  |
| 404    | `agent_not_found`                  | No such agent, or not yours.                                      |
| 409    | `agent_revoked`, `run_in_progress` | Revoked, or already running.                                      |
| 503    | `credits_unconfigured`             | `OPENROUTER_MANAGEMENT_KEY` unset.                                |
| 401    | —                                  | No session token, or one that is expired or forged.               |

### Run transcripts (SEN-178)

Each run records a transcript as it goes, so the agent page can show it in a
terminal, live and afterwards (`runner/transcript/`). Entries, each with a
per-run `seq` and `at`:

- `start` (trigger, model, the instruction, whether `thinking` was asked for),
  then a `note` naming the markets whose book the tick snapshot carried;
- per model turn, in content order: `thinking` (`visible` with its text,
  `omitted` when only a signature came back, `redacted` for an encrypted
  `redacted_thinking` block; a loose `reasoning` field or block is captured as
  `source: 'reasoning'`), `text`, `tool_call` (tool, `market` when the input
  names one, a one-line input summary), then `usage` (tokens, `usage.cost`);
- `tool_result` per call: `ok`, `refused` with the layer (`sente`: our gate or
  precheck, `enclave`: Privy) and code, or `error`. Input the zod schema rejects
  before the gate is recorded as `refused`/`invalid_input` without a
  `toolUseId`;
- `end`: stop reason, totals, duration, the redacted error, and how many turns
  carried any thinking (`0` reads "the model returned no reasoning").

Bounds: text 2,000 chars, thinking 4,000, summaries 240, 400 entries per run
(then one "transcript full" note; the `end` is always kept), last 10 runs per
agent. Every string is redacted on the way in: the run's own OpenRouter key,
`sk-or-`/`sk-ant-` shapes, `Bearer …`, `sente_mcp_…`, and any value under a key
named like a secret. With `STATE_DIR` it is journalled to `agent-runs.jsonl`
(not fsynced, unreadable lines skipped, compacted at boot); a run left open by
a restart reads `interrupted`. It is a view, not a record of account: orders
and fills stay in the event log.

- `GET /agents/:id/runs` → `{runs}`: summaries, newest first (`status`
  `running` | `ended` | `interrupted`, iterations, tool calls, tokens, cost,
  `lastSeq`).
- `GET /agents/:id/runs/:runId?after=<seq>` → `{run, entries, nextSeq}`. Poll
  with `nextSeq` while `run.status` is `running`.

Both are owner-only (404 `agent_not_found` for someone else's agent); a run the
server does not hold for this agent is 404 `run_not_found`.

What the two models send (as of the 2026-09-13 probe in `docs/openrouter.md`;
not re-measured for SEN-178): Kimi K2.6 returned thinking blocks over
OpenRouter's `/messages` even without the `thinking` parameter; Claude Sonnet 5
returned none, even with `thinking: adaptive`, and `AGENT_RUNNER_THINKING` is
off by default, so a Sonnet run normally ends with "no reasoning".

### Write spacing

Privy enforces its rolling-cap aggregation late (SEN-3 checks 5 and 5d):

- a second sign straight after the first overshot the cap;
- the same sign 5 s later was refused;
- a sign right after a policy PATCH can run under the old rule.

The Tool Runner runs a turn's tool calls with `Promise.all`, so a model that
fires two orders at once would hit exactly that gap. `WriteSpacer` therefore
queues the **signing** writes per agent, process-wide: the next one starts no
sooner than `AGENT_WRITE_SPACING_MS` (default **5000**, 0 = off) after the
previous one finished.

- `record_thesis` and the reads are never spaced.
- A write still waiting when the run times out is not sent. The model is told
  so, and nothing is signed.
- This narrows Privy's window. It does not make the rolling cap exact. The
  per-order cap and the enclave's per-transaction rules are exact; the
  rolling cap is a best-effort bound.
- MCP sessions are not spaced.

### Scheduler

`AGENT_TICK_SECONDS` is unset (off) by default, because a timer spends users'
credits unprompted. Set it to 30 or more and every active agent runs once per
interval, concurrently. An agent whose previous run is still open is skipped.
Chainlink CRE replaces this timer in Phase 5.

The other knobs:

- `AGENT_RUN_TIMEOUT_MS`, default 180000;
- `AGENT_RUN_MAX_ITERATIONS`, default 12;
- `AGENT_RUN_MAX_TOKENS`, default 4096;
- `AGENT_RUNNER_THINKING`, default `off`.

### Live check: PENDING CREDENTIALS

**Not run.** `OPENROUTER_MANAGEMENT_KEY` is not set in `sente/.env` (checked
2026-09-11, by name only). No live run exists, so no thesis or order event
from one is recorded here. What is proven without credentials comes from the
jest specs in `runner/`, which run the real SDK `BetaToolRunner` against a
stubbed `fetch`:

- tool_use → tool_result → end_turn;
- `max_iterations`;
- `refusal`, `max_tokens` and `model_context_window_exceeded`;
- 402 → `credits_exhausted`;
- `run_in_progress`, revoked and mid-run revoke;
- timeout, and write spacing;
- the key never appearing in logs, results or events.

To run it once the key exists (put it in the repo-root `.env`; never print
it), from the main checkout, where the funded SEN-6 probe wallet is recorded
as `PRIVY_AGENT_VENUES_*`:

```bash
mise exec -- pnpm --filter @sente/api run build
mise exec -- pnpm --filter @sente/api run agent:run-live
# options: -- --model moonshotai/kimi-k2.6   -- --instruction "..."   -- --out run.json
```

The script is `services/api/scripts/agent-run-live.ts`. It:

1. boots the compiled API;
2. re-PATCHes the probe wallet's policy to a small mandate (Kuru MON-USDC and
   Perpl BTC-PERP, no order over 20 USDC);
3. registers the wallet as an agent;
4. runs it with an instruction to record a thesis, rest one tiny Kuru bid far
   under the touch, and cancel it;
5. prints the `RunResult` and every event;
6. deletes the OpenRouter key it minted.

It exits 1 unless the run produced at least one `thesis` event and one
`order` event that landed. Without the key it prints
`pending credentials: OPENROUTER_MANAGEMENT_KEY not set` and exits 0. Copy
its output here and replace this heading.

**Correction (2026-09-11, SEN-9):** the refusal demo is no longer this
script with an instruction. It is `pnpm --filter @sente/api run demo:refusal
-- --mode scripted|model`, runbook in [`demo-refusal.md`](./demo-refusal.md).
It runs both layers (pre-check off, then on), the owner-only amend and the
revoke, and asserts on the event log, the Privy call count and the nonce. What
follows still holds for a one-off enclave-only run.

**For SEN-9 (the refusal demo):** `AGENT_PRECHECK=off` passes through to the
script, so
`AGENT_PRECHECK=off pnpm --filter @sente/api run agent:run-live -- --instruction "<a trade over the mandate>"`
runs the agent with only the enclave in the way. The events come back in
`RunResult.events`, including any `refusal` events with `layer: 'enclave'`.
Over HTTP it is the same:
`POST /agents/:id/run {"instruction": "…"}` against an API started with
`AGENT_PRECHECK=off`; the response body is the `RunResult`, events included.

## Live agent run on the shared OpenRouter key — SEN-18 / SEN-19, 2026-09-13

`agent:run-live` with `OPENROUTER_API_KEY` (shared-key dev mode, SEN-18), `anthropic/claude-sonnet-5`,
pre-check on, agent wallet `0xE05F6A1e4d896f48dDcA52e46a05A6c7ffab0B6E` (the SEN-6 probe wallet).

**Run 1 — failed, and why (fixed in SEN-19).** Funded with 0.1 MON (`0x8c14a327…82a8`) + 6 USDC (`0xf9806c97…77ae0`).
The model recorded a thesis, then placed a Kuru buy of 693 MON @ 0.01445 **before depositing anything** — reverted
with `InsufficientBalance()` (`0x2469e551…65db`, full 425,430 gas limit paid). It then tried to deposit 10 USDC from a
wallet holding 6 — reverted with `ERC20InsufficientBalance` (`0xeed00261…09ae`, 252,059 gas paid). About 0.077 MON was
burned on writes that could never succeed, and the model concluded "the wallet holds 0 USDC" because `get_balances`
showed only AccountCore. Kuru's minimum order on MON-USDC is **10 USDC**; the script had asked for 5.

**SEN-19 fix.** With the pre-check on, `deposit` checks the wallet and Kuru `place_limit`/`place_market` check the
market's minimum notional and the AccountCore balance **before signing**, refusing as Sente-layer
`insufficient_balance` / `below_min_notional`. (On Monad a revert still pays the whole gas limit.) With
`AGENT_PRECHECK=off` the pre-flight is skipped, so the refusal demo still reaches the enclave. `get_balances` now shows
the Kuru wallet next to AccountCore.

**Run 2 — passed** (run `run-2747e22a`, 6 iterations, 5 tool calls, 33 s, $0.114). Topped up with 0.12 MON
(`0x7d90216d…64a2`) + 6 USDC (`0xa4d25874…1599`), so the wallet held 12 USDC.

| Step                                                                 | Result                      | Tx                                                                   |
| -------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `record_thesis` MON-USDC                                             | recorded                    | —                                                                    |
| `deposit` 11 USDC into AccountCore                                   | ok                          | `0x484ab888f4ef1514e8058293ccce4cffc527903c0bb68dde13461ff86fd0f281` |
| `place_limit` buy 727 MON @ 0.01445 (≈10.51 USDC, half the best bid) | ok — order `0:4209` resting | `0xcbb45e0255bdddba10dbc37d8169c43e770cb070ec8f3718f474b153b373813b` |
| `cancel_order` `0:4209`                                              | ok — cancelled              | `0xf3a29c8f2d1bdc907ba0ff64de75a969c28a8fbe04dd5a7cf6956c4bc266a1e2` |

After the run the agent holds 0.048 MON and 1 USDC in its wallet, with 11 USDC free in AccountCore. The four
transactions (approve, deposit, place, cancel) cost about **0.10 MON** of gas — so the 0.15 MON agent gas drip
(SEN-14) covers roughly one run of this shape.

## Indicators: `get_indicators` (SEN-180)

Models compute indicators badly from raw `get_klines` candles, so Sente computes them. `get_indicators`
is a read tool in `agents/tools/registry.ts`, gated like every other tool, so the runner and the MCP
server both offer it. The math is in `agents/tools/indicators.ts`, a pure module.

**Input.**

| Field        | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `venue`      | `kuru` or `perpl`                                                                                             |
| `market`     | must be a market in the agent's mandate, or it is refused `market_not_allowed` (`venue_not_allowed`)          |
| `timeframes` | 1 to 4 distinct `get_klines` intervals, e.g. `["1h","15m","5m"]` for Elder's triple screen; Perpl has no `1w` |
| `indicators` | 1 to 8 specs, `{ type, ...params }`; every param is optional                                                  |
| `lookback`   | candles fetched per timeframe, 2 to 500, default 200                                                          |
| `series`     | recent values shown per output, 1 to 20, default 5                                                            |

| `type`        | Params and defaults                  | Outputs                                            |
| ------------- | ------------------------------------ | -------------------------------------------------- |
| `sma`         | `period=20`                          | value                                              |
| `ema`         | `period=20` (seeded with the SMA)    | value                                              |
| `wma`         | `period=20`                          | value                                              |
| `macd`        | `fast=12, slow=26, signal=9`         | line, signal, histogram                            |
| `rsi`         | `period=14` (Wilder)                 | value                                              |
| `stochastic`  | `k=14, d=3, smooth=3`                | k (smoothed %K), d                                 |
| `atr`         | `period=14` (Wilder)                 | value                                              |
| `bollinger`   | `period=20, stddev=2` (population σ) | upper, middle, lower, percentB, bandwidth          |
| `vwap`        | none                                 | value, anchored at the first candle fetched        |
| `obv`         | none                                 | value, starting from 0 at the first candle         |
| `adx`         | `period=14` (Wilder)                 | adx, plusDi, minusDi                               |
| `force_index` | `period=13` (Elder)                  | value: EMA of Δclose × volume                      |
| `elder_ray`   | `period=13`                          | ema, bullPower (high − EMA), bearPower (low − EMA) |

Periods are integers from 2 to 200 (stochastic `d` and `smooth` from 1), `stddev` from 0.5 to 5, and
`macd` needs `fast < slow`. Anything else is `invalid_input`.

**Output.** `{ venue, market, timeframes: { "<tf>": { candles, last, indicators, warnings? } } }`.
`last` is the candle every value is computed on (`t`, `close`, and `closed: false` while it is
still forming). Each indicator is keyed by its label with defaults filled in (`rsi(14)`,
`macd(12,26,9)`) and shows `value`, the latest, and `series`, the last few values oldest first.
Multi-output indicators show both as objects keyed by output. An indicator that has too few
candles shows `{ value: null, needs, have }` and a warning. It never shows a value computed during
warm-up. A warning also flags missing candles (the venue skips an interval with no trades, and
the math treats the series as contiguous), a flat window, and a VWAP with no volume.

Values are decimal strings. Prices carry the market's tick precision plus two places. If the
catalog cannot say, the closes' own precision is used, at most 8 places. Oscillators carry two
places, ratios (%b, bandwidth) four, and volume-based values six significant digits. Ratios with a
zero denominator take their neutral value: RSI 50 on a flat series, stochastic 50 on a flat range,
%b 0.5 when the bands collapse, and DI/DX 0 without movement.

**Load.** Candles come through `MarketDataService.klines`, the shared TTL cache, with one read per
timeframe. The tick size comes from the cached catalog. Without the shared service (specs), the
tool falls back to the agent's own venue, as `get_klines` does.

**Tests.** `indicators.spec.ts` pins SMA, EMA and RSI to the StockCharts ChartSchool worked
examples. It pins WMA, MACD, ATR, ADX, stochastic, Bollinger, VWAP, OBV, force index and Elder
ray to small hand-checked series, with the arithmetic in comments. It also covers flat series,
too few candles, empty windows and gaps. `get-indicators.spec.ts` covers the tool through the
gate.

## Watchers: wake-ups without the model (SEN-182)

A scheduled agent used to call the model on every tick: at 5 minutes, about 290 runs a day, most
of them ending in "nothing to do". With watchers, the agent leaves conditions behind during a
run. On each later tick the scheduler checks them deterministically, with no model call, and
starts a run only when one fires, or when the **heartbeat** comes due (no run of any trigger for
`heartbeatHours`, default 4) so the agent can re-plan. An agent with no watchers keeps the old
behaviour: one run per tick.

The code is in `agents/watchers/`: `watcher.schema.ts` (shape and validation),
`watcher-eval.ts` (the check), `watcher.service.ts` (set, edit, check, counters),
`watcher-store.ts` (persistence), `watchers.controller.ts` (owner routes), and `wake.ts` (what
the woken run is told).

**Tools.** `set_watchers {watchers, heartbeatHours?}` replaces the agent's set. `list_watchers`
reads it back, each condition in words with its fire count. `clear_watchers` removes them all.
They go through the gate like every tool, so the runner and `/mcp` both have them. The two
writes take the agent's write lock and need it active, but they reach no venue and are not
write-spaced (`signs: false` on the tool, like `record_thesis`). Setting watchers writes nothing to the event log: they are not trades. They
show up in the run transcript as tool calls.

**A watcher.** `{id?, label, match: "all"|"any" (default all), clauses: 1-4, cooldownMinutes:
1-1440 (default 60)}`, at most 8 per agent, heartbeat 1 to 24 h. Passing a watcher's `id` back
with the same condition keeps its edge state and history. Every market must be in the mandate
(`market_not_allowed` / `venue_not_allowed` otherwise), at set time and again at every check: a
market amended out of the mandate is no longer read.

| Clause       | Fields                                                                                       | Fires                  |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------- |
| `price`      | `venue, market, source: mark (default; the mid on Kuru) or last, op, value`                  | `above`/`below`: level |
|              |                                                                                              | `crosses_*`: edge      |
| `price_band` | `venue, market, source, op: inside / outside / enters / leaves, low < high`                  | inside/outside: level  |
|              |                                                                                              | enters/leaves: edge    |
| `indicator`  | `venue, market, timeframe, indicator` (a `get_indicators` spec), `output`, `op`, then either | as `price`             |
|              | `value` or `compareTo: {indicator?, output}` (default: the same indicator)                   |                        |
| `position`   | `market` (Perpl), `op: pnl_above / pnl_below` (`value`: unrealised P&L as % of margin)       | P&L: level             |
|              | or `opened / closed`                                                                         | opened/closed: edge    |
| `funding`    | `market` (Perpl), `op: above / below`, `value`: % per 8 h, as `get_funding`'s `ratePctPer8h` | level                  |

`output` names a multi-output indicator's output (`line`, `signal`, `histogram` for MACD) and may
be omitted for a one-value indicator. "MACD line crosses its signal on 15m" is
`{type: "indicator", timeframe: "15m", indicator: {type: "macd"}, output: "line", op:
"crosses_above", compareTo: {output: "signal"}}`.

**The check.** An EDGE clause is true only on the check where its condition flips from false
to true, so each one keeps the previous check's answer. The first readable check only records.
A LEVEL clause is true on every check while it holds. A watcher fires when its clauses are true
by `match` and its cooldown has passed. Edges are recorded during a cooldown too, so a cross
inside one is consumed, never reported late. A clause whose data cannot be read (venue down,
indicator still warming up, no position) is unknown: not true, and its edge state is kept, so
an outage neither fires nor hides a cross. Indicators use the same candles (`MarketDataService.
klines`, 200 of them, the shared TTL cache) and the same `computeIndicator` as `get_indicators`.
The value is the newest candle's, which may still be forming. Prices and funding come from the
cached ticker. Positions come from the agent's own Perpl venue, which never enrolls a key for a
check. A check reads each market once, however many clauses share it.

**The scheduler** (`runner/agent-run.scheduler.ts`). When an agent with watchers is due, it is
checked instead of run, and its next due time moves a cadence on. A check that wakes nothing
is counted as a model call saved. One that fires starts a normal scheduled run through the
existing credits guard, daily cap and one-run-per-agent lock, with a `wake` naming the fired
watchers, what they saw and when. A wake the guard holds back stays pending and is retried on
the next poll, without re-checking. It is dropped after a heartbeat's length. A run in progress
is neither checked nor run.

**The woken run.** The first message says, outside the user's fences, "Woken by your watchers
at <time>:" with one line per firing, for example `“MACD 15m cross” (macd) — BTC-PERP 15m
macd(12,26,9).line 1.23 crossed above macd(12,26,9).signal 1.19`. The labels are the agent's own
text, so they are defused like user text. The transcript opens with the same line as a note
(`Woken by: …`), and the run's `run` event carries `detail.wake`. A heartbeat run says so
instead. The system prompt has one rule about watchers (rule 7).

**Owner routes**, session-authenticated and owner-only (another user's agent is a 404
`agent_not_found`):

| Route                              | Does                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /agents/:id/watchers`         | the set: each watcher with `reads` (in words), last check, last firing, fire count, |
|                                    | last error; `checks`, `wakes`, `heartbeats`, `modelCallsSaved`, `everySeconds`      |
| `PUT /agents/:id/watchers`         | replaces the set: `{watchers, heartbeatHours?}`                                     |
| `PUT /agents/:id/watchers/:wid`    | adds or edits one watcher: `{label, match?, clauses, cooldownMinutes?}`             |
| `DELETE /agents/:id/watchers/:wid` | deletes one; 404 `watcher_not_found` when there is none                             |

Bodies go through the same validation as the tool. A rule broken is a 400 with `reason`
`invalid_input`, `market_not_allowed` or `venue_not_allowed`. `GET /agents/:id/schedule` gains
`watchers: {count, heartbeatSeconds} | null`. With
watchers set, its `nextRunAt` is the next check.

**Persistence.** `<STATE_DIR>/agent-watchers.json`, rewritten on every change and every check, so
edge state survives a restart. In memory without `STATE_DIR`.

**Tests.** `watcher.schema.spec.ts` covers validation and mandate scoping.
`watcher-eval.spec.ts` covers edge crossings with state, the cooldown, unknowns, all/any, bands,
positions, and a MACD cross checked against `computeIndicator`. `watcher.service.spec.ts`
covers the persistence round-trip, the tools through the gate and the owner-only routes.
`watcher-scheduler.spec.ts` covers no-run checks, exactly one run per firing with its
instruction, the heartbeat, a wake held by the guard, the lock, and the woken run's prompt,
transcript and summary.

## Authenticating

Every `/agents` route (and `/wallet`, `/credits`, `/chain`, `POST /gas/drip`)
is behind `SessionAuthGuard` since SEN-37. The caller proves it holds the
passkey-derived key for an address by signing a nonce the server chose, and
gets a bearer token whose subject is that address lowercased — the same string
`AgentRecord.userId` has always held.

```bash
ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
# 1. a challenge: {address, nonce, message, expiresAt}. Five minutes, single use.
MSG=$(curl -sS localhost:3000/auth/challenge -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\"}" | jq -r .message)
# 2. sign MSG with the EOA (EIP-191 personal_sign) — the app does this with the
#    Mera viem account; `cast wallet sign "$MSG"` does it from a shell.
# 3. the token: {address, token, expiresAt}
TOKEN=$(curl -sS localhost:3000/auth/session -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\",\"signature\":\"$SIG\"}" | jq -r .token)
curl -sS localhost:3000/agents -H "authorization: Bearer $TOKEN" | jq
```

`AUTH_SESSION_SECRET` (32 bytes of hex) signs the tokens and is required: the
API refuses to boot without it. `AUTH_SESSION_TTL_S` sets their lifetime
(default 86400).

**Recipes in this repo that send `x-sente-user-id` still work under
`AUTH_PLACEHOLDER=1`**, which keeps the old header alive for a request with no
bearer token. It is refused under `NODE_ENV=production`: the header is not
auth, it is a name anyone can claim.
