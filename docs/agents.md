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
| policy recompiled + PATCHed (5 s settle) | ok                                                              | policy `<privy-agent-venues-policy-id>`                                    |
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

## Getting the money back: withdraw and return to owner (SEN-15)

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

The choices, and why:

- **The contract pins the withdraw recipient; no address condition does.** No
  AccountCore withdraw function takes an outside recipient, so pinning the
  function pins the recipient to the signer. It also means the rule needs no
  agent address, which matters because hire compiles the policy before the
  wallet exists. An address pin would cost a second PATCH after every hire.
- **`returnTo` is a new, optional mandate field**: the owner's smart-account
  address, EIP-55 checked, never the zero address. Without it no transfer rule
  exists and the wallet can send nothing (fail closed). Nothing sets it yet:
  the mobile app and hire don't send it, so a client has to put it in the
  mandate. Revoke-then-owner-key stays the fallback for agents without it.
- **Native MON is not covered.** A `to = returnTo` value rule would also let
  the agent call the owner's account with any calldata. Leftover gas stays
  with the agent.
- **Both survive mandate expiry.** They carry `chain_id` and no
  `current_unix_timestamp`, unlike every risk-taking rule. Each can only move
  money toward the owner. If they expired, an expired agent's collateral
  would be stranded until the owner re-PATCHed the policy. Revocation still
  stops them, because it replaces the policy with `[]`. Layer 1 agrees:
  `checkIntent` passes `withdraw` like cancel and close, after expiry too. A
  Kuru cancel still expires in the enclave, because a cancel `batch` cannot
  be told apart from a placing one.
- **Tool:** `withdraw {asset, amount}` is a write with no thesis and no
  notional cap, allowed on Kuru even after expiry. It calls
  `KuruVenue.withdraw` (`withdrawCall`, fixed gas 150,407). Only free balance
  can leave; resting orders keep their reserve until cancelled.
- **The user-side path is the rule plus `erc20TransferCall`.** No API route
  triggers a return yet; the live script sends it through
  `AgentTransactionSender`. A `POST /agents/:id/return` is a follow-up.

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

The endpoint uses the same placeholder auth as every agents route
(`x-sente-user-id`), and it is refused under `NODE_ENV=production`. The body
is `{instruction?: string}`, at most 2,000 characters, and nothing else is
allowed.

| Status | `reason`                           | When                                                              |
| ------ | ---------------------------------- | ----------------------------------------------------------------- |
| 200    | —                                  | Any run that ended on its own terms; the body is the `RunResult`. |
| 402    | `credits_exhausted`                | Out of credits; `run` carries the `RunResult`.                    |
| 502    | `model_error`                      | Upstream failure; `run` carries the `RunResult`.                  |
| 404    | `agent_not_found`                  | No such agent, or not yours.                                      |
| 409    | `agent_revoked`, `run_in_progress` | Revoked, or already running.                                      |
| 503    | `credits_unconfigured`             | `OPENROUTER_MANAGEMENT_KEY` unset.                                |
| 401    | —                                  | No or malformed `x-sente-user-id`.                                |

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

| Step | Result | Tx |
| --- | --- | --- |
| `record_thesis` MON-USDC | recorded | — |
| `deposit` 11 USDC into AccountCore | ok | `0x484ab888f4ef1514e8058293ccce4cffc527903c0bb68dde13461ff86fd0f281` |
| `place_limit` buy 727 MON @ 0.01445 (≈10.51 USDC, half the best bid) | ok — order `0:4209` resting | `0xcbb45e0255bdddba10dbc37d8169c43e770cb070ec8f3718f474b153b373813b` |
| `cancel_order` `0:4209` | ok — cancelled | `0xf3a29c8f2d1bdc907ba0ff64de75a969c28a8fbe04dd5a7cf6956c4bc266a1e2` |

After the run the agent holds 0.048 MON and 1 USDC in its wallet, with 11 USDC free in AccountCore. The four
transactions (approve, deposit, place, cancel) cost about **0.10 MON** of gas — so the 0.15 MON agent gas drip
(SEN-14) covers roughly one run of this shape.
