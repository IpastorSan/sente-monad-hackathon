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

| Call                               | Limit   | Source                                                   |
| ---------------------------------- | ------- | -------------------------------------------------------- |
| ERC-20 `approve` (USDC, AUSD)      | 80,000  | measured 52,089 (USDC) and 71,099 (AUSD, fresh spender)  |
| Kuru `AccountCore.deposit`         | 252,059 | `KURU_MEASURED_GAS.firstDeposit` (includes registration) |
| Kuru `batch`, one order            | 425,430 | `placeTakingOneLevel`; covers a resting GTC (404,204)    |
| Kuru `batch`, one cancel           | 242,923 | `cancelOne`                                              |
| Perpl `createAccount`              | 203,000 | measured 202,237                                         |
| Perpl `allowOrderForwarding(true)` | 72,000  | measured 71,363                                          |

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

- Privy wallet `qqhg4rxobx0qnjg398tjzgi9`, display name
  `sente-agent-venues-live`, EOA `0xE05F6A1e4d896f48dDcA52e46a05A6c7ffab0B6E`.
- Policy `nmfedw3sc6i1pkndz3a38msh`, compiled from this mandate:
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
| policy recompiled + PATCHed (5 s settle) | ok                                                              | policy `nmfedw3sc6i1pkndz3a38msh`                                    |
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
