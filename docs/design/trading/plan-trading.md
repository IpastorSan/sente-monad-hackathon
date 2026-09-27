# Manual trading from the user's own wallet — implementation plan (build step 4)

Step 4 of the trading study's build order ("Your trades"): users trade from their own Privy
wallet — Kuru spot (market and limit orders, cancel, withdraw) and Perpl perps (account setup,
long/short with leverage, close). It serves the screens in [trade.html](./trade.html) and
[portfolio.html](./portfolio.html), under the constraints in [brief.md](./brief.md) and
[capabilities.md](./capabilities.md) §4–6 and "Design constraints". Every write is
**phone-verified**: the server composes requests; the phone decodes each one independently and
checks it against the order the user confirmed before its device key signs. The phone never
blind-signs server-provided calldata. Task ids use `M-` so they don't collide with
`plan-backend.md`'s `B-` ids; the app side is `plan-mobile.md` (`U-`).

## Architecture

### 1. Who signs, and how

The user's account is a Privy server wallet owned by a 1-key quorum over the phone's `device`
P-256 key. It has no signers and no policies, so the server holds the app secret and still
cannot move a wei (`docs/user-wallet.md:88-99`, `services/api/src/agents/privy/user-wallet.ts:75-81`).
Every user write reuses the SEN-42 pattern:

- the server composes a sponsored `eth_sendTransaction` and the `AuthorizationPayload` the phone
  must sign (`services/api/src/wallet/user-wallet.provider.ts:84-94`);
- it keeps the request single-use with a 5-minute expiry
  (`services/api/src/agents/prepared-approval.ts:57,94-127`);
- it forwards the phone's signature **alone** (`user-wallet.provider.ts:100-108`), spaced per
  wallet (`services/api/src/wallet/user-wallet.service.ts:316-336`, `WALLET_SEND_SPACING_MS`);
- it follows the returned **user-operation hash**, never the carrying transaction's status
  (CLAUDE.md gotcha 8; `services/api/src/wallet/send/sponsored-send.ts:173-184`).

`signPrivyAuthorization` is a blind signer (`apps/mobile/src/auth/deviceKey.ts:14-21,165`), so
verification on the phone is the whole security boundary.

**Where calldata is built.** The server builds it with the existing adapters:
`KuruVenue.limitOrderCalls`, `depositCalls`, `withdrawCall`
(`packages/venues/src/kuru/adapter.ts:231-250`, `orders.ts:273-318`) and `perplOnboardingCalls`
(`packages/venues/src/perpl/onboarding.ts:162-197`). The phone does **not** re-run the same
builder — that would only prove both sides ran the same code (`apps/mobile/src/wallet/batch.ts:4-14`).
Instead it:

1. decodes with its **own hand-written ABI fragments**, whose selectors a test pins to the SDK's;
2. **re-encodes** the decoded arguments and requires byte equality (rejects trailing data and
   non-canonical encoding);
3. checks every value against the confirmed intent, and bounds against facts it read **itself**
   over its own RPC (`apps/mobile/src/chain/client.ts`) — the app already bundles
   `@sente/venues/kuru`, so it can run a read-only `KuruVenue` for `getMarketParams` and
   `bestBidAsk`.

**Phone checks** (new `apps/mobile/src/trade/`, pure TS, `node --test`):

- **Envelope** (a stricter copy of `apps/mobile/src/wallet/send.ts:131-169`): `version` 1 and
  `POST`; `url` exactly `https://api.privy.io/v1/wallets/<walletId>/rpc`; headers only
  `privy-app-id` plus a **required** `privy-idempotency-key` equal to
  `sente-trade:<clientTradeId>:<stepIndex>`; body exactly `method`, `caip2`, `sponsor`, `params`
  with `eth_sendTransaction`, `eip155:10143`, `sponsor: true`; `params.transaction` exactly
  `to`, `data`, `chain_id: 10143`, plus `value` only for a native-MON deposit.
- **Call list:** one call, or a call to the wallet itself (`to == wallet`,
  `execute(bytes32 mode, bytes calldata)`) whose `mode` equals `BATCH_EXECUTION_MODE` or
  `SINGLE_EXECUTION_MODE` (revert-on-failure `0x00`). **Delegatecall (`0xff`) and try-mode are
  refused**; no leg may target the wallet itself.
- **Allowed functions** (anything else fails to decode and is refused): ERC-20
  `approve(spender, amount)` on the intent's token with spender AccountCore `0x6384e9b2…eE22` or
  the Perpl Exchange `0x1964C32f…80cc`; `AccountCore.deposit(token, amount)`;
  `AccountCore.withdraw(token, amount)` (no recipient; pays `msg.sender` —
  `docs/privy-policy-enforcement.md` "Recipient pinning"); `OrderBook.batch` **3- and 4-argument
  overloads only** — the SDK's two `builderConfig(address builder, uint32 feePps)` overloads
  (`node_modules/@toxicflow-labs/ts-sdk/dist/spot/index.js:2666-2700`) would let a server skim
  builder fees; Perpl `createAccount(uint256)` and `allowOrderForwarding(true)`. So `transfer`,
  `transferFrom`, `permit`, `increaseAllowance` and `withdrawFromAccount` are never signable.
- **Kuru values** (SDK enums: side BUY 0 / SELL 1; tif GTC 0 / IOC 1 / FOK 2; execution
  instruction NONE 0 / POST_ONLY 1): `to` is the confirmed market and in `KURU_TESTNET_MARKETS`;
  `userId == 0` (the caller's own account, `docs/kuru.md:396-399`); exactly one order and no
  cancels (or no orders and exactly the confirmed slot for a cancel); `side` and `quantity` equal
  the confirmed values; `price` equals the limit price, or for a market order the
  **phone-computed** worst price with `tif == IOC`; `executionInstruction` 1 only for post-only;
  `minSizeAfterBlock == 0`; `clientOrderId == keccak256(clientTradeId)`;
  `approve.amount == deposit.amount` exactly; deposit ≤ the phone-computed cap; leg order exactly
  `[approve?, deposit?, place]`; `value == 0` except for a native deposit.

### 2. Kuru flow

For a user, the Kuru account owner (AccountCore root) is **the Privy wallet's address**. Gotcha
9's "the Kernel account is root" predates SEN-40 and refers to the retired counterfactual Kernel
address. Kuru accepts contract callers (`docs/kuru.md:407-416`); after the first sponsored send
the wallet is EIP-7702-delegated to a Kernel implementation and executes as its own address
(`docs/privy-sponsorship.md:255-260`).

Sequence: `approve` (exact) → `deposit` of only the **shortfall** against the free Kuru balance
(`getBalance`) → `batch` (GTC limit, or IOC at the phone's worst price) → cancel via
`batch(0, [], [slot])` after the adapter's `getOrderId` pre-check (`adapter.ts:424-445`) →
`withdraw`. Fills credit the Kuru account, not the wallet, so selling MON bought on Kuru needs no
deposit.

**Batching.** Privy's sponsored send takes one transaction. A call from the delegated wallet to
its own `execute(BATCH_EXECUTION_MODE, calls)` should run atomically — **unverified (probe P1)**.

- **Default is non-atomic.** The phone signs every step's payload in one go (the device key is in
  memory; no extra passkey prompt). The server runs steps in order, each waiting for the previous
  user operation's `success`. On failure it stops and says where the funds are ("USDC you
  deposited stays in your Kuru account").
- **If P1 passes**, `USER_TRADE_ATOMIC_BATCH=1` packs each step's calls into one self-call. The
  verifier accepts both shapes.

Step statuses: `awaiting_signature | queued | submitted | included | reverted | not_sent |
unknown` (a timeout is `unknown`, never a failure). Fills and partial fills are decoded from the
user operation's own receipt logs (`bundler.receipt(hash).logs`) with `decodeOrderOutcome`
(`orders.ts:407-460`) — that drives "Filled 62% · rest cancelled".

### 3. Perpl flow

- **Onboarding:** three sponsored transactions — `approve` exactly the amount (≥ the 100 AUSD
  minimum) → `createAccount(amount)` → `allowOrderForwarding(true)` — or one batch if P1 passes.
  It resumes: an existing account skips the first two; forwarding already on skips the third.
- **Trade key custody (decided, D1): the phone holds the Perpl trade key.** Perpl authenticates
  **per socket, not per order**: the `mt: 29` sign-in is signed
  (`packages/venues/src/perpl/signing.ts:126-158`), later `mt: 22` order frames aren't
  (`trading.ts:1-17`). Whoever holds a trade-scoped key can place any order; no key can withdraw
  (`enroll.ts:37`). So the phone opens the trading WebSocket itself and places, cancels and closes
  through `PerplVenue` over React Native's global `WebSocket` (`perpl/ws.ts:21`). The server never
  holds a key that can trade.
- **Key derivation (decided, D2):** Ed25519 secret =
  `HKDF-SHA256(ikm = device private key, salt = empty, info = "sente.perpl.trade-key.v1" ‖
lowercase wallet address)`, 32 bytes. Deterministic: no storage, survives reinstall, no new
  passkey prompt. **The label `sente.perpl.trade-key.v1` becomes permanent the moment a key
  derived under it is enrolled.** Changing it (or the inputs) derives a different key Perpl no
  longer recognises, forcing re-enrollment and burning one of the account's 16 key slots each
  time. Unlike the PRF salts it can't lose funds, but treat it like a `sente.prf.v1.*` namespace:
  add labels, never rename one. Add it to CLAUDE.md's permanent values when M-T7 lands.
- **Server read-only key (decided, D3):** the server generates and holds, in memory, a
  **read-scoped** key per user for Portfolio. A restart forgets it; the next Portfolio read reports
  `perpl.status: 'unlinked'` until the phone re-approves an enrollment.
- **Enrollment** (both keys in one prepare): the server calls Perpl `/v1/api-key/payload` once per
  key (the phone's public key, trade scope; the server's public key, read scope), wraps each
  `typed_data` in a Privy `eth_signTypedData_v4` request; the phone checks both, signs both Privy
  payloads with the device key, and computes the Ed25519 proof-of-possession for **its own** key
  over a digest it hashes itself (`hashTypedData(toViemTypedData(typed_data))`); the server
  submits both enrollments and returns the phone key's `api_key` token (not secret on its own).
  Delegated Privy wallets still produce plain `ecrecover`-able typed-data signatures
  (`docs/privy-sponsorship.md:143-148`).
- **Enrollment typed-data checks (fail closed on drift, D4):** domain `name == 'perpl.xyz'`,
  `version == '1'`, `chainId == 10143`, `verifyingContract == 0x0` (the salt is **not** pinned —
  it drifted between days, `docs/agents.md` Run 2); `primary_type == 'PerplRegisterApiKey'`;
  `types` exactly `EIP712Domain` (5 fields) plus the 11-field struct in
  `packages/venues/src/perpl/constants.ts:52-77` — **any drift refuses** with "Perpl changed its
  sign-up format; update the app" (gotcha 13); `message.signer == wallet`; `statement` exact;
  `publicKey` = the expected key; `scope` = the expected scope (format pinned by P5);
  `builderId == ''` and no builder fee (exact empty value pinned by P5); `ipCidrs == ''`;
  `origin == ''`; `expiresAt` empty or as P5 records; `time` within ±5 minutes of the phone clock.

### 4. Server API

A new `TradeModule` behind `SessionAuthGuard` and the feature flag; identity is always the
session subject.

| Route                                 | Body → response                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /trade/capabilities`             | → `{enabled, atomicBatch, chainId: 10143, venues: {kuru, perpl}}`                                                            |
| `POST /trade/prepare`                 | `TradeIntent` → `PreparedTrade`                                                                                              |
| `POST /trade/:tradeId/commit`         | `{signatures: string[]}` (one per step, by index) → `TradeView`                                                              |
| `GET /trade/:tradeId`                 | → `TradeView`                                                                                                                |
| `GET /trade?limit=`                   | → `TradeView[]` (recent, in memory)                                                                                          |
| `GET /trade/perpl/account`            | → `{accountId: string \| null, forwarding: boolean, minOpenAtoms: string, apiKey?: string, readKey: 'linked' \| 'unlinked'}` |
| `POST /trade/perpl/enroll/prepare`    | `{publicKeyHex, label}` → `{prepareId, expiresAt, items: [{role: 'trade' \| 'read', payload, typedData}]}`                   |
| `POST /trade/perpl/enroll/commit`     | `{prepareId, signatures: string[], popSignature: Hex}` → `{apiKey, accountId, readKey: 'linked'}`                            |
| `GET /portfolio`                      | → `Portfolio` (wallet, Kuru, Perpl)                                                                                          |
| `GET /portfolio/fills?venue=&cursor=` | → `{fills, next}`                                                                                                            |

- **Idempotency:** the same `clientTradeId` (UUID v4 from the phone) with the same intent returns
  the same prepared trade; a different intent under that id is 409 `trade_id_conflict`. A second
  commit returns the current `TradeView` and resends nothing. Privy drops a repeat with the same
  `privy-idempotency-key` for 24h (`services/api/src/agents/privy/privy.client.ts:108-109`).
- **Concurrency:** one executing trade per wallet, sharing `SEND_SPACER` with transfers (so the
  first-send EIP-7702 nonce mismatch waits instead of failing).
- **Persistence:** the trade store is in memory (the repo standard). Portfolio always re-reads
  chain and venue state, so a restart loses only unsent signatures and can't misreport a balance.
- **Perpl orders are not server routes** — the phone places them itself (D1).

### 5. Feature flag

- **Server:** `USER_TRADING=1|true`, off by default. Off → every `/trade/*` and `/portfolio`
  route answers 404 `trading_disabled`, except `GET /trade/capabilities` → `{enabled: false}`.
  `USER_TRADE_ATOMIC_BATCH` is honoured only when `USER_TRADING` is on.
- **App:** Buy/Sell/Long/Short only when compile-time `EXPO_PUBLIC_USER_TRADING=1` **and**
  `capabilities.enabled` **and** `MONAD_NETWORK === 'testnet'`.

### 6. Threat model

| Threat                                        | Mitigation                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buggy or compromised API proposes other calls | The phone decodes with its own ABI, re-encodes byte-for-byte, checks every value against the confirmed intent and its own chain reads; server summaries are shown, never trusted                                                |
| Replay of a signed payload                    | Consumed 5-minute prepares; phone-chosen `privy-idempotency-key` (Privy 24h dedupe, P2). After 24h a replay can only repeat an action the user approved, and funds stay in the user's wallet or Kuru account. Nonce pinning: P3 |
| Wrong recipient                               | No allowed leg names a recipient except `approve`'s spender (pinned); `transfer`/`withdrawFromAccount` are never decodable                                                                                                      |
| Unlimited approvals                           | `approve.amount` must equal the following deposit exactly                                                                                                                                                                       |
| Slippage                                      | The worst price is computed on the phone from its own `bestBidAsk` read and the user's slippage setting; the server can refuse but not widen it                                                                                 |
| Delegatecall or re-delegation                 | Execution mode exactly `BATCH_EXECUTION_MODE` or `SINGLE_EXECUTION_MODE`; body keys exact (no authorization list); RPC method pinned                                                                                            |
| Builder-fee skim                              | Kuru builder-config overloads refused; enrollment requires an empty builder fee                                                                                                                                                 |
| Perpl key abuse                               | The trade key exists only on the phone; the server's key is read-scoped; no key can withdraw                                                                                                                                    |
| Mainnet                                       | `caip2` and `chain_id` pinned to 10143 on both sides; only testnet address tables exist; server refuses if the wallet chain isn't 10143; app disabled unless `MONAD_NETWORK === 'testnet'`                                      |
| Native MON reserve rule                       | A delegated wallet can't go below 10 MON (gotcha 12): native deposits refused with `reserve_balance` when wallet MON after the deposit would be under 10; P4 confirms                                                           |
| Passkey can sign any Perpl enrollment         | Enrollment typed data is checked on the phone; a device-owned Privy policy as a second, enclave-enforced layer is M-T22 (later)                                                                                                 |

## Probes (live testnet)

- **P1 — atomic batch and receipts** (M-T0a). Throwaway P-256 "device" key, fresh user wallet,
  20 USDC from the Kuru faucet. Must show: (a) single sponsored `approve`, `deposit`, GTC `batch`
  each land with user-operation `success=true`, and the receipt `logs` decode via
  `decodeOrderOutcome` to the resting order; (b) a self-call `execute(BATCH_EXECUTION_MODE,
[approve, deposit, place])` through Privy lands as **one** user operation with `success=true`;
  (c) the same batch with an order below min notional → `success=false` **and** the USDC
  allowance is still 0 (atomic); (d) a cancel and a withdraw land.
- **P2 — idempotency.** The same signed payload sent twice with the same
  `privy-idempotency-key` → exactly one user operation, the second response echoes the first.
  Without a key → a second operation (confirms the replay risk the key closes).
- **P3 — nonce pinning.** Is `params.transaction.nonce` refused, ignored or honoured on a
  sponsored send? Record which.
- **P4 — reserve rule.** A native-MON `deposit` of 0.1 MON from a delegated wallet holding under
  10 MON → expected `reserve balance violation` (charged or refused). Record exactly what happens.
- **P5 — Perpl as a user** (M-T0b; the user funds the throwaway wallet with 100+ AUSD, D5). Must
  show: three sponsored onboarding transactions landing; the **live** `/v1/api-key/payload` typed
  data recorded verbatim, with the exact format of `scope`, `expiresAt`, `ipCidrs`, `origin`,
  `builderId`, `maxBuilderFeePer100K` for trade and read scope; enrollment of an HKDF-derived
  trade key and a read-scoped key from the delegated wallet; WebSocket sign-in with the read key
  shows snapshot and positions and an order is **refused**; a leveraged market order and a close
  through the trade key.

## Decisions (answered 2026-09-27)

- **D1 — Perpl trade-key custody:** the **phone** holds it and places orders itself.
- **D2 — derivation:** HKDF from the device key, label `sente.perpl.trade-key.v1`, **permanent
  once used** (§3).
- **D3 — server read-only key:** **yes**, one per user, in memory, re-approved after a restart.
- **D4 — enrollment struct drift:** **fail closed**.
- **D5 — AUSD:** the user funds the P5 throwaway wallet with 100+ AUSD; users otherwise get AUSD
  as today.
- **D6 — CLAUDE.md gotcha 9 update** (the user's Privy wallet is both Kuru root and Perpl owner):
  follow-up after P1 and P5.

## Subtasks

Test commands: API `mise exec -- pnpm --filter @sente/api test` (jest); mobile
`mise exec -- pnpm --filter @sente/mobile test` (`node --test`); venues
`mise exec -- pnpm --filter @sente/venues test`. Every task also passes `mise exec -- pnpm run
typecheck` and `lint`. API files that scripts import use erasable syntax and `.ts` specifiers
(gotcha 10).

### Shared wire types

```ts
type KuruPlaceIntent = {
  kind: 'kuru.place';
  clientTradeId: string; // UUID v4, phone-generated
  market: Address; // OrderBook address
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  sizeAtoms: string; // book size units
  priceUnits: string; // limit price, or the phone-computed worst price; on tick
  postOnly?: boolean; // limit only
  maxDepositAtoms: string; // phone-computed cap for the funding leg
};
type KuruCancelIntent = {
  kind: 'kuru.cancel';
  clientTradeId: string;
  market: Address;
  orderId: string;
}; // "<slot>:<orderId>"
type KuruWithdrawIntent = {
  kind: 'kuru.withdraw';
  clientTradeId: string;
  token: Address;
  amountAtoms: string;
};
type PerplOnboardIntent = { kind: 'perpl.onboard'; clientTradeId: string; amountAtoms: string };
type TradeIntent = KuruPlaceIntent | KuruCancelIntent | KuruWithdrawIntent | PerplOnboardIntent;

type StepKind =
  | 'approve'
  | 'deposit'
  | 'place'
  | 'cancel'
  | 'withdraw'
  | 'perpl.approve'
  | 'perpl.createAccount'
  | 'perpl.allowForwarding'
  | 'batch';
type PreparedStep = { index: number; kind: StepKind; title: string; payload: AuthorizationPayload };
type PreparedTrade = {
  tradeId: string;
  clientTradeId: string;
  expiresAt: string;
  wallet: { walletId: string; address: Address };
  steps: PreparedStep[];
  summary: Record<string, unknown>; // render only
};
type StepStatus =
  'awaiting_signature' | 'queued' | 'submitted' | 'included' | 'reverted' | 'not_sent' | 'unknown';
type KuruPlaceResult = {
  status: 'filled' | 'partially_filled' | 'resting' | 'cancelled' | 'rejected';
  orderId?: string;
  requestedSize: string;
  filledSize: string;
  avgPrice?: string;
  fee: string;
  feeAsset: 'USDC';
  fills: { price: string; size: string; tradeId: string }[];
  unfilledCancelled?: string;
};
type TradeView = {
  tradeId: string;
  clientTradeId: string;
  kind: TradeIntent['kind'];
  status: 'prepared' | 'executing' | 'completed' | 'failed' | 'expired';
  steps: {
    index: number;
    kind: StepKind;
    title: string;
    status: StepStatus;
    userOpHash?: Hex;
    transactionHash?: Hex;
    blockNumber?: string;
    error?: string;
  }[];
  result?: KuruPlaceResult;
  funds?: { where: 'wallet' | 'kuru' | 'perpl'; symbol: string; amount: string }[];
  updatedAt: string;
};
```

Refusal reasons: `trading_disabled`, `trade_id_conflict`, `trade_not_found`, `trade_expired`,
`reserve_balance`, `below_min_notional`, `already_terminal`, `market_not_allowed`,
`perpl_not_onboarded`, `perpl_enroll_refused`, plus the existing `account_not_registered` and
`invalid_authorization`.

### M-T0a — Probes P1–P4 (Kuru, batching, replay, reserve)

- **Create:** `services/api/scripts/user-trade-probe.ts`, `docs/user-trading.md` (results).
  **Modify:** `services/api/package.json` (`probe:user-trade`).
- **Read:** `services/api/scripts/user-send-probe.ts`, `wallet/send/sponsored-send.ts`,
  `wallet/confirmation/user-operation-logs.ts`, `apps/mobile/src/wallet/batch.ts`,
  `packages/venues/src/kuru/orders.ts`.
- **Mini-plan:** reuse the SEN-42 probe's wallet and key handling (`PRIVY_PROBE_TRADE_*` in the
  env file); build calls with `depositCalls`, `placeOrderCall`, `cancelOrderCall`; for (b)/(c)
  wrap with `encodeKernelExecute` as `{to: wallet, data}`; read the user-operation receipt and
  logs; print pass/fail per check; `--out report.json`.
- **Acceptance:** the doc has a table per check with user-operation and transaction hashes and a
  verdict; nothing reuses Anvil keys (gotcha 11).
- **Depends on:** nothing. Group 0.

### M-T0b — Probe P5 (Perpl as a user)

- **Create:** `services/api/scripts/user-perpl-probe.ts`; P5 section in `docs/user-trading.md`.
  **Modify:** `services/api/package.json` (`probe:user-perpl`).
- **Read:** `agents/venues/perpl-agent.ts`,
  `packages/venues/src/perpl/{enroll,onboarding,signing,trading,venue}.ts`.
- **Mini-plan:** once the user has funded the throwaway wallet with 100+ AUSD: three sponsored
  onboarding txs; `/payload` twice (trade and read scope), recorded verbatim; sign through Privy
  with the device key; enroll both; WebSocket sign-in with each; place and close a small
  leveraged order with the trade key; show an order with the read key is refused.
- **Acceptance:** recorded payload JSON; accepted/refused table.
- **Depends on:** D5 funding. Group 0.

### M-T1 — Trade feature flag and module skeleton

- **Create:** `services/api/src/trade/trade.config.ts` (+ spec), `trade/trade.module.ts`.
  **Modify:** `services/api/src/app.module.ts`; `services/api/src/wallet/wallet.module.ts:263`
  (also export `USER_WALLETS`, `SEND_SPACER`, `BUNDLER`, `MONAD_PUBLIC_CLIENT`).
- **Read:** `auth/auth.config.ts:54`, `wallet/wallet.config.ts`.
- **Mini-plan:** `loadTradeConfig(env = process.env): { enabled: boolean; atomicBatch: boolean;
chainId: 10143 }` (only `'1'`/`'true'` count; `atomicBatch` requires `enabled`), provided as
  `TRADE_CONFIG`.
- **Acceptance:** off by default; `'true'`/`'1'`; `atomicBatch` ignored without `enabled`; app
  boots with the flag off.
- **Depends on:** nothing. Group 0.

### M-T2 — Kuru call builders for manual orders

- **Modify:** `packages/venues/src/kuru/adapter.ts`, `orders.ts`, `orders.test.ts`.
- **Read:** `adapter.ts:388-413,502-606`.
- **Mini-plan:** `KuruVenue.marketOrderCalls(req: MarketOrderRequest): Promise<KuruCall[]>`
  lifted from `placeMarket` (still refuses a missing bound; `placeMarket` calls it);
  `quoteReserveAtoms(order: NativeOrderInput, params: KuruMarketParams, quoteDecimals: number,
feePps: bigint): bigint` = notional + fee, rounded up.
- **Acceptance:** unbounded refusal; tick-floored bound; reserve matches the 10 → 10.004 USDC
  observation in `docs/kuru.md`.
- **Depends on:** nothing. Group 0.

### M-T3 — Phone call-list decoder

- **Create:** `apps/mobile/src/trade/calls.ts` + test. **Read:** `apps/mobile/src/wallet/batch.ts`.
- **Mini-plan:** `decodeTransactionCalls(tx: unknown, wallet: Address): {ok: true; calls:
Erc7579Call[]; batched: boolean} | {ok: false; problem: string}` — `to != wallet` → one call;
  `to == wallet` → decode `execute(bytes32, bytes)`, mode must equal `BATCH_EXECUTION_MODE` or
  `SINGLE_EXECUTION_MODE`, decode executions, refuse any leg with `to == wallet`; re-encode with
  `encodeKernelExecute` and require byte equality.
- **Acceptance:** fixtures built with `permissionless` decode; delegatecall, try-mode, a nested
  self-call and trailing bytes refused.
- **Depends on:** nothing. Group 0.

### M-T4 — Phone envelope verifier

- **Create:** `apps/mobile/src/trade/envelope.ts` + test.
- **Read:** `apps/mobile/src/wallet/send.ts:131-195`, `apps/mobile/src/auth/privyApproval.ts`.
- **Mini-plan:** `verifyTradeEnvelope(p: AuthorizationPayload, e: {walletId: string;
idempotencyKey: string; rpcMethod: 'eth_sendTransaction' | 'eth_signTypedData_v4'}): {ok: true;
params: Record<string, unknown>} | {ok: false; problem: string}` — version, POST, exact URL,
  headers exactly `privy-app-id` + the required matching idempotency key; sends: exact body keys,
  `caip2`, `sponsor: true`; typed data: body exactly `{method, params: {typed_data}}`.
- **Acceptance:** a tampered test per rule; a missing idempotency key refused.
- **Depends on:** nothing. Group 0.

### M-T5 — Idempotency key through prepare and commit

- **Modify:** `services/api/src/wallet/user-wallet.provider.ts`,
  `services/api/src/wallet/send/sponsored-send.ts`, `sponsored-send.spec.ts`.
- **Read:** `agents/privy/privy.client.ts:99-153,216-219`.
- **Mini-plan:** `prepareSend(input: PrepareSendInput & {idempotencyKey?: string})` passes it to
  `authorizationPayload(..., {idempotencyKey})` and stores it on the request; `commitSend` sends
  the same header; add `sponsoredCallTransaction(to: Address, data: Hex, value?: bigint):
Record<string, unknown>` following `sponsored-send.ts:17-32` (checksummed `to`, hex value,
  `value` only when non-zero).
- **Acceptance:** the key appears in the signed and the sent headers; existing send specs pass.
- **Depends on:** nothing. Group 0.

### M-T6 — Trade store

- **Create:** `services/api/src/trade/trade-store.ts` + spec. **Read:** `agents/prepared-approval.ts`.
- **Mini-plan:** `Trade = {id, userId, clientTradeId, intentHash, walletId, address, steps: {kind,
title, request: EnclaveRequest, payload, status, ...}[], status, expiresAt, result?, funds?}`;
  `put(t)`, `byClientId(userId, clientTradeId)`, `get(userId, id)`, `claimForCommit(userId, id,
now): Trade | 'committed' | undefined` (atomic prepared → executing), `update(id, patch)`,
  `listRecent(userId, n)`; another user's id is not found; a sweep removes expired entries.
- **Acceptance:** conflict on a different `intentHash`; double claim; expiry; cross-user isolation.
- **Depends on:** nothing. Group 0.

### M-T7 — Phone Perpl trade key (HKDF)

- **Create:** `apps/mobile/src/auth/perplKey.ts` + test.
- **Read:** `apps/mobile/src/auth/derive.ts`, `deviceKey.ts`, `packages/venues/src/perpl/signing.ts`.
- **Mini-plan:** `perplTradeKey(devicePrivateKey: Uint8Array, wallet: Address): {secretKey:
Uint8Array; publicKeyHex: Hex}` via `hkdf(sha256, ikm, undefined,
utf8("sente.perpl.trade-key.v1") ‖ utf8(lowercase wallet), 32)`. Export
  `PERPL_TRADE_KEY_LABEL` with a comment that it is **permanent once used**; add it to CLAUDE.md's
  permanent values.
- **Acceptance:** fixed test vector; different wallets → different keys; public key matches
  `publicKeyOf`.
- **Depends on:** nothing. Group 0.

### M-T8 — Phone Kuru market facts

- **Create:** `apps/mobile/src/trade/kuruMarket.ts` + test.
- **Read:** `packages/venues/src/kuru/adapter.ts:475-500,580-606`, `apps/mobile/src/chain/client.ts`.
- **Mini-plan:** pure `worstPriceUnits(bestUnits: bigint, slippageBps: number, tick: bigint, side:
Side): bigint` (floor for buys, ceil for sells, as the adapter); pure
  `depositCapAtoms(order, params, quoteDecimals)`; thin I/O `readMarketFacts(client, market):
Promise<{params; bestBid; bestAsk}>` and `readKuruFree(client, wallet, token): Promise<bigint>`.
- **Acceptance:** pure functions match the adapter's `#slippageBound` on shared cases.
- **Depends on:** nothing. Group 0.

### M-T9 — Phone Kuru call classifier

- **Create:** `apps/mobile/src/trade/kuruLegs.ts` + test.
- **Read:** `packages/venues/src/kuru/orders.ts:205-340`, SDK `spot/index.js:2572-2700`.
- **Mini-plan:** hand-written fragments for `approve`, `deposit`, `withdraw`, `batch/3`,
  `batch/4`; `classifyKuruCall(call: Erc7579Call): KuruLeg | {ok: false; problem}` where
  `KuruLeg` = `approve{token, spender, amount}` | `deposit{token, amount, value}` |
  `withdraw{token, amount}` | `place{market, userId, order, clientOrderId?}` |
  `cancel{market, userId, slots}`; each decode followed by a canonical re-encode check.
- **Acceptance:** selectors pinned to `kuruAbi`; both builder-config overloads,
  `withdrawFromAccount`, `transfer`, `transferFrom` and an off-canonical encoding refused.
- **Depends on:** M-T3. Group 1.

### M-T10 — Kuru policy verifier

- **Create:** `apps/mobile/src/trade/verifyKuru.ts` + test.
- **Read:** `trade/{envelope,calls,kuruLegs,kuruMarket}.ts`.
- **Mini-plan:** `verifyKuruTrade(steps: PreparedStep[], ctx: {walletId: string; wallet: Address;
intent: KuruPlaceIntent | KuruCancelIntent | KuruWithdrawIntent; facts: MarketFacts}):
VerifyResult` — per step: envelope with key `sente-trade:<clientTradeId>:<index>` → decode calls
  → classify → leg sequence and values. A cancel slot equals the slot parsed from
  `intent.orderId`; a withdraw equals the intent's token and amount.
- **Acceptance:** one passing fixture per intent kind; one tampered test per rule (market,
  `userId`, side, size, price, tif, post-only, `minSizeAfterBlock`, `clientOrderId`, approve ≠
  deposit, deposit > cap, extra leg, wrong order, non-zero value).
- **Depends on:** M-T4, M-T8, M-T9. Group 1.

### M-T11 — Step executor

- **Create:** `services/api/src/trade/step-executor.ts` + spec.
- **Read:** `wallet/user-wallet.service.ts:316-404`, `wallet/bundler/pimlico-bundler.ts:114-124`,
  `agents/tools/keyed-mutex.ts`, `spacing/write-spacer.ts`.
- **Mini-plan:** `class StepExecutor { execute(trade: Trade, signatures: string[]):
Promise<void> }` — per-wallet `KeyedMutex`; per step:
  `SEND_SPACER.run(walletId, () => commitSend(step.request, {signature}))` → `submitted`; poll
  `bundler.receipt(userOpHash)` (≤ `WALLET_CONFIRMATION_TIMEOUT_MS`) → `included` or `reverted`,
  keep receipt `logs`; on `reverted`, a Privy error or a timeout, remaining steps → `not_sent`
  (timeout → `unknown`); error mapping copied from `commitOrRefuse`; `onStepLanded(step,
receipt)` hook for M-T15.
- **Acceptance:** fake provider: all included; step 2 reverted → 3 `not_sent`; timeout →
  `unknown`; steps strictly sequential; refused signature → `invalid_authorization`.
- **Depends on:** M-T5, M-T6. Group 1.

### M-T12 — Kuru planner

- **Create:** `services/api/src/trade/kuru-planner.ts` + spec.
- **Read:** `packages/venues/src/kuru/adapter.ts`, `orders.ts`, `wallet/balances/token-balances.ts`.
- **Mini-plan:** `planKuru(intent, deps: {client: PublicClient; wallet: Address; atomicBatch:
boolean}): Promise<{steps: {kind: StepKind; title: string; calls: KuruCall[]}[]; summary}>`
  with a read-only `KuruVenue` (`account: wallet`). Place: market allowlisted; price on tick; min
  notional (`below_min_notional`); funding token (quote for buys, base for sells); shortfall =
  max(0, reserve − free) ≤ `maxDepositAtoms`; native MON with wallet MON − shortfall < 10 →
  `reserve_balance`; steps `[approve?, deposit?, place]`, packed into one `batch` step when
  `atomicBatch`. Cancel: `getOrderId` pre-check else `already_terminal`. Withdraw: `withdrawCall`.
- **Acceptance:** shortfall 0 → single step; MON reserve refusal; atomic packing; off-tick and
  below-minimum refusals.
- **Depends on:** M-T2. Group 1.

### M-T13 — Split Perpl enrollment into payload and submit

- **Modify:** `packages/venues/src/perpl/enroll.ts`, `enroll.test.ts`. **Read:** `enroll.ts:144-183`.
- **Mini-plan:** `requestEnrollPayload(o: {restUrl; chainId; address; publicKeyHex; scope; label;
fetchImpl?}): Promise<{typed_data: PerplTypedData; mac: string; typedData: PerplEip712; digest:
Hex}>`; `submitEnrollment(o: {restUrl; chainId; address; typed_data; mac; signature: Hex;
popSignature: Hex; fetchImpl?}): Promise<ApiKeyInfo>`; `enrollApiKey` becomes their composition,
  behaviour unchanged.
- **Acceptance:** existing tests pass; new tests for each half with fake fetch.
- **Depends on:** nothing. Group 1 (can start at once).

### M-T14 — Trade service, controller and DTOs

- **Create:** `services/api/src/trade/trade.service.ts`, `trade.controller.ts`,
  `dto/trade.dto.ts`, `trade.service.spec.ts`.
- **Read:** `wallet/wallet.controller.ts`, `wallet/dto/wallet.dto.ts`, `wallet/wallet.errors.ts`.
- **Mini-plan:** `prepare(principal, intent)`: flag check → binding → `intentHash` → idempotency
  via `byClientId` → planner → per step `sponsoredCallTransaction` (or a self-call for batched
  steps) → `prepareSend({walletId, transaction, idempotencyKey: 'sente-trade:' + clientTradeId +
':' + index})` → store → `PreparedTrade`. `commit(principal, id, {signatures})`:
  `claimForCommit` → length check → executor in the background → `TradeView`. `status`, `list`.
  DTOs: class-validator on the discriminated union.
- **Acceptance:** flag off → 404 `trading_disabled`; prepare idempotency; 409 conflict; double
  commit; another user's id → 404; payload headers carry the key.
- **Depends on:** M-T1, M-T6, M-T11, M-T12. Group 2.

### M-T15 — Fill and partial-fill result

- **Create:** `services/api/src/trade/outcome.ts` + spec. **Modify:** `trade/step-executor.ts`
  (call it from the hook).
- **Read:** `packages/venues/src/kuru/orders.ts:388-460`, `adapter.ts` `toPlacedOrder`,
  `receipts.fixture.ts`.
- **Mini-plan:** `placeResult(logs: KuruLog[], market: Address, accountId: bigint, params,
requestedSize: bigint, quoteDecimals): KuruPlaceResult` (`accountId` via `userRegistry(wallet)`
  after the deposit); `fundsAfter(trade): TradeView['funds']` (e.g. deposited but the order
  failed → in your Kuru account).
- **Acceptance:** the IOC partial-fill fixture → `partially_filled` with the remainder; a GTC →
  `resting` with `orderId`.
- **Depends on:** M-T11. Group 2.

### M-T16 — Phone Perpl verifiers (onboarding and enrollment)

- **Create:** `apps/mobile/src/trade/verifyPerpl.ts` + test.
- **Read:** `packages/venues/src/perpl/{onboarding,constants,enroll}.ts`,
  `apps/mobile/src/agents/mandate.ts:39-70`.
- **Mini-plan:** `verifyPerplOnboard(steps, ctx: {walletId; wallet; intent: PerplOnboardIntent}):
VerifyResult` (approve AUSD → Exchange == amount; `createAccount(amount)`;
  `allowOrderForwarding(true)`; a resumed subset allowed in order); `verifyEnrollment(payload,
ctx: {walletId; wallet; role: 'trade' | 'read'; publicKeyHex; now: number}): VerifyResult` with
  all §3 checks, `scope`/`builderId`/fee constants from P5.
- **Acceptance:** tampered tests for drifted `types`, builder fee, wrong signer, wrong public key,
  wrong scope, stale `time`; a pinned salt is **not** required.
- **Depends on:** M-T4; field constants from M-T0b. Group 2.

### M-T17 — Server Perpl onboarding and account route

- **Create:** `services/api/src/trade/perpl-planner.ts` + spec. **Modify:**
  `trade/trade.controller.ts`, `trade/trade.service.ts`.
- **Read:** `agents/venues/perpl-agent.ts:44-70`, `packages/venues/src/perpl/onboarding.ts`.
- **Mini-plan:** `planPerplOnboard(intent, {client, wallet, context}): Promise<{steps}>` — amount ≥
  `minAccountOpenAmount`; `perplAccountReader` to resume; read forwarding state; steps as above.
  `account(principal)` → `{accountId, forwarding, minOpenAtoms, apiKey?, readKey}`.
- **Acceptance:** below-minimum refusal; fresh = 3 steps; existing account = 1 or 0 steps; atomic
  packing.
- **Depends on:** M-T14. Group 3.

### M-T18 — Enrollment service and the user's read key

- **Create:** `services/api/src/trade/perpl-enroll.service.ts`, `trade/user-venue-secrets.ts`,
  spec. **Modify:** `trade/trade.controller.ts` (the two routes).
- **Read:** `agents/venues/agent-secret-store.ts`, `agents/privy/agent-wallet.ts:216-231`, `enroll.ts`.
- **Mini-plan:** `prepare(principal, {publicKeyHex, label})`: require an account
  (`perpl_not_onboarded`); generate the server's read key with `newSecretKey()`;
  `requestEnrollPayload` twice; for each, prepare `POST /v1/wallets/<id>/rpc` with
  `eth_signTypedData_v4` and key `sente-enroll:<prepareId>:<role>`; store single-use, 5-minute
  expiry. `commit(principal, {prepareId, signatures, popSignature})`: Privy RPC per signature;
  `submitEnrollment` for the trade key with the phone's PoP and the read key with a server PoP;
  store sealed read credentials and the trade `apiKey` token. `UserVenueSecretStore {
getPerplRead(userId); putPerplRead(userId, creds); getPerplTradeToken(userId);
putPerplTradeToken(userId, token) }`, in memory, sealed.
- **Acceptance:** fake Privy + fake Perpl: call order; stored secret prints redacted; replayed
  commit → 404; refusal → `perpl_enroll_refused`.
- **Depends on:** M-T13, M-T14. Group 3.

### M-T19 — User portfolio

- **Create:** `services/api/src/portfolio/portfolio.service.ts`, `portfolio.controller.ts`, spec.
- **Read:** `plan-backend.md` B-T5 `MarketDataService` and B-T9 `AgentPortfolioService`,
  `wallet/balances/token-balances.ts`.
- **Overlap — share the venue-read code with the backend plan:** reuse B-T5 `MarketDataService`
  for prices and marks, and the Kuru and Perpl read helpers B-T9 extracts for
  `AgentPortfolioService` (balances free/locked, open orders, positions). Don't write a second
  copy; if B-T9 hasn't extracted them, extract them there first.
- **Mini-plan:** `Portfolio = {asOf; wallet: TokenBalance[]; kuru: {accountId: string | null;
balances: {asset; available; locked}[]; openOrders: Order[]}; perpl: {status: 'unlinked' | 'ok'
| 'not_onboarded'; balances?; positions?; openOrders?}}` — Kuru via the shared helpers with
  `account` = the wallet; Perpl via the read key when linked; fills: Kuru from the trade store's
  decoded results plus Data Source `order-events`, Perpl from signed REST `fills`.
- **Acceptance:** unlinked Perpl; empty Kuru account (id 0); mixed balances; the flag gates it.
- **Depends on:** M-T1, B-T5, B-T9 (and M-T18 for Perpl). Group 3.

### M-T20 — Mobile trade API client

- **Create:** `apps/mobile/src/trade/api.ts` + test. **Read:** `apps/mobile/src/wallet/api.ts:223-410`.
- **Mini-plan:** `class TradeApi` — `capabilities()`, `prepare(intent)`, `commit(id, signatures)`,
  `status(id)`, `list()`, `perplAccount()`, `enrollPrepare(b)`, `enrollCommit(b)`, `portfolio()`,
  `fills(q)`; errors `TradeApiError{status, reason}`; wire types copied from `dto/trade.dto.ts`.
- **Acceptance:** fake-fetch tests per method and reason mapping.
- **Depends on:** M-T14. Group 3.

### M-T21 — Mobile trade flow

- **Create:** `apps/mobile/src/trade/flow.ts` + test. **Read:** `apps/mobile/src/wallet/send.ts:241-320`.
- **Mini-plan:** `runTrade(api: TradeApi, intent: TradeIntent, ctx: {walletId; wallet; facts?},
sign: Approver | null, onUpdate: (v: TradeView) => void, opts?)` — verify with
  `verifyKuruTrade`/`verifyPerplOnboard` (refusal → throw `TradeApprovalRefusedError`, sign
  nothing) → sign every step → commit → poll `status` with back-off until terminal or timeout;
  `describeTradeError(e)` → copy; `runPerplEnrollment(api, {deviceKey, wallet, walletId}, sign)`
  derives the key (M-T7), verifies both items (M-T16), signs, computes the PoP locally.
- **Acceptance:** a refused step signs nothing; timeout → `pending`; happy path with fakes.
- **Depends on:** M-T4, M-T10, M-T16, M-T20. Group 4.

### M-T22 — Device-owned Privy policy on the user wallet (later)

- **Create:** `services/api/src/wallet/user-policy.ts` + spec;
  `apps/mobile/src/trade/verifyPolicy.ts`.
- **Mini-plan:** compile rules (`to` allowlist, function names, `chain_id`); the device approves
  the policy create and the wallet PATCH via the SEN-44 prepare/commit pattern.
- **Acceptance:** a probe shows an off-list call refused with `policy_violation` while sends land.
- **Depends on:** M-T14 and a separate go-ahead. Not on the critical path.

### M-T23 — Phone Perpl trader

- **Create:** `apps/mobile/src/trade/perplTrader.ts` + test. **Modify:**
  `apps/mobile/metro.config.js` (alias `@sente/venues/perpl` to its `source` entry, gotcha 10).
- **Read:** `packages/venues/src/perpl/{venue,trading,ws,signing}.ts`, `apps/mobile/metro.config.js`.
- **Mini-plan:** `createPerplTrader({credentials: {apiKey, secretKey}, webSocket?, restUrl,
wsUrl}): {placeMarket({symbol, side, size, leverage, maxSlippage}); placeLimit(...);
cancel(...); closePosition({symbol, size?, maxSlippage}); positions(); openOrders(); release()}`
  — leverage clamped to the market max and refused above it; no unbounded market order; socket
  opened per action and released after.
- **Acceptance:** fake socket: sign-in is the first frame; leverage in hundredths; unbounded order
  refused; release. No native module expected (rebuild the dev client only if one is added).
- **Depends on:** M-T7. Group 4.

### M-T24 — UI

Implemented as `plan-mobile.md` U-12 (Portfolio), U-13 (spot ticket) and U-14 (perp ticket,
Perpl setup, close). **Depends on:** M-T21, M-T8, M-T23.

## Critical path and parallel groups

- **Group 0:** M-T0a, M-T0b (after funding), M-T1, M-T2, M-T3, M-T4, M-T5, M-T6, M-T7, M-T8, M-T13.
- **Group 1:** M-T9, M-T10, M-T11, M-T12.
- **Group 2:** M-T14, M-T15, M-T16.
- **Group 3:** M-T17, M-T18, M-T19, M-T20.
- **Group 4:** M-T21, M-T23.
- **Group 5:** UI (U-12, U-13, U-14).

Critical path: M-T5/M-T6 → M-T11 → M-T14 → M-T20 → M-T21 → UI, with M-T3 → M-T9 → M-T10
alongside. Perpl track: M-T0b → M-T16; M-T13 → M-T18; M-T7 → M-T23. The atomic batch flag waits
on M-T0a (P1). The CLAUDE.md updates (D6, and `sente.perpl.trade-key.v1` in the permanent values)
follow P1, P5 and M-T7.
