# Kuru — the spot leg

Two earlier research passes contradicted each other on almost everything here.
This records what was settled empirically, and by what method, because the
package in question is deliberately hard to find.

The adapter itself lives in `packages/venues/src/kuru/` and is exported as
`@sente/venues/kuru`. The section **How the adapter trades (MOV-254)** at the
end is what it was built on; everything above it is the research that led
there.

## Set D: the account-id deployment Kuru moved testnet to (SEN-185)

**Current since 2026-09-25; found by Sente on 2026-10-09.** Kuru redeployed its
testnet exchange with a new account model. The Data Source
(`/api/v1/markets?status=all`) lists only these five books, and every address
below was read back from the chain on 2026-10-09. Everything in the sections
further down that names `0x6384…`, `0xfdbE…`, `0xEe07…` or the faucet is
**Set C, the previous market set**: still on chain, no longer listed, kept as
history.

| Contract                  | Address                                      | Read from                                         |
| ------------------------- | -------------------------------------------- | ------------------------------------------------- |
| AccountCore (proxy)       | `0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038` | each book's `accountCore()`; impl `0x980719BF…`   |
| SpotRouter (proxy)        | `0xf75A7529b83941e001d7D9bc113A73C92112947E` | `AccountCore.spotRouterAddress()`; books' owner   |
| OrderBook implementation  | `0xa4171E141A3Cf7801d7f06C126284aC0a509e6a9` | every book's ERC-1967 slot; router's default      |
| WithdrawalLimiter (proxy) | `0x6d9599d6B9A5Cf601C2cdBc43fF170462B256fe0` | deployment page; every `withdraw` is checked here |
| KuruTradingWallet (impl)  | `0x43F4BCA50dE3bbcB0A297227fA61Cf3bf2dE0dE1` | deployment page; unused by Sente                  |
| ProtocolAuthority         | `0xE3dea12b5141e42626A59d538E0e8A49620d657f` | every book's `authority()`                        |

| Market    | OrderBook                                    | Base token                                             | price / size precision | Book on 2026-10-09            |
| --------- | -------------------------------------------- | ------------------------------------------------------ | ---------------------- | ----------------------------- |
| MON-USDC  | `0x26cd68436B6A4AEB3ec52abC20A4d121f8B4BAc9` | native MON (18)                                        | 10^6 / **10^6**        | **empty both sides**          |
| WETH-USDC | `0x9d187971B64505Ac81f12c5FD2ac9c5247Ec62F3` | WETH `0x63c84e18184021c6CcE5ea57d0c3Ec0E65f3b303` (18) | 10^2 / 10^10           | ~$15 a level, 2678.20/2680.89 |
| WBTC-USDC | `0x8661cB7c5f4f8ae3ee116B63Aa5a23c69110e357` | WBTC `0x7cDC77B348a2E101C766aD290367f3c5F287af18` (8)  | 10^2 / 10^8            | ~$15 a level                  |
| XAUT-USDC | `0x0E2A5D9378fB61B8eC100Bd770c449F6fdD3e4d6` | XAUT `0x7553b18A8c8400a1b7746C1F5b4f453D57555838` (6)  | 10^2 / 10^6            | one bid, three asks           |
| USDT-USDC | `0x4A0888C502e64AEAE11115508Ec0955c70293dba` | USDT `0xF7d4179FC134D7Cb6BA3D26B2fb556Ff8903B666` (6)  | 10^6 / 10^6            | 8 + 15 USDT a level           |

All five are quoted in **a new USDC, `0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1`**
(6 decimals) — not Set C's `0xEe07…`. Common to every book (`getMarketParams()`):
tick 1, `minQuoteNotional` 10 USDC, `maxQuoteNotional` 5,000,000 USDC, **taker
7,000 pps (0.07%), maker 4,000 pps (0.04%)**. Those are the same rates Set C
charged, and the planner already reserves them: `quoteReserveAtoms` adds the
maker rate to a resting buy and the taker rate to an IOC, and `simulateQuote`
reports the taker fee on every quote.

What changed beyond the addresses, and what Sente changed with it:

- **cbBTC-USDC is gone; WBTC-USDC replaces it.** XAUt is now spelled **XAUT**
  (the token's own `symbol()`), and USDT-USDC is new.
- **Custody is keyed by numeric account id.** The 0.0.x SDK's
  `deposit(token, amount)`, `withdraw(token, amount)`, `getBalance(user, token)`
  and `userRegistry(user)` do not exist on this AccountCore (their selectors
  are absent from the implementation's bytecode). It needs
  **`@toxicflow-labs/ts-sdk` 0.3.0**: `deposit(rootOwner, token, amount)`
  (registers the root on first use), `withdraw(rootAccountId, token, amount,
recipient)`, `getBalance(accountId, token)`, `rootAccountIdOf(owner)`,
  `getAccountOwner(accountId)`. The OrderBook's `batch` overloads,
  `TradesPacked` and the builder surface are unchanged; `batch(0, …)` still
  means the caller's own root.
- **Both custody calls now name a third party, so the policy pins them.**
  `deposit` credits whichever `rootOwner` it names and `withdraw` pays whichever
  `recipient` it names; Set C always credited and paid the caller. An agent's
  withdraw rule pins `withdraw.recipient` to the owner's `returnTo`, and an
  amend pins `deposit.rootOwner` to the agent's own wallet (a hire cannot: Privy
  creates the policy before the wallet). The phone verifier holds both to the
  user's own wallet.
- **Withdrawals can be refused for capacity.** A protocol-wide USD budget
  (24 h deposit credit, then a capped drip) gates every `withdraw`; a refused
  one reverts whole.
- **No public faucet.** The deployment page: _"No public faucet was deployed;
  request test assets from your Kuru integration contact."_ Set C's faucet
  still pays, but only Set C tokens.
- **Builder fees** credit the builder's root free balance directly;
  `claimBuilderFees`/`getClaimableBuilderFees` are gone. A builder withdraws
  like any root.
- **`AccountRegistered`** is now `(uint40 indexed accountId, uint40 indexed
rootAccountId, address indexed rootOwner, uint16 subaccountSeq)`.

The Set-C markets map to these as `KURU_RETIRED_DEPLOYMENT` in
`constants.ts` records: MON-USDC, WETH-USDC → same names; cbBTC-USDC →
WBTC-USDC; XAUt-USDC → XAUT-USDC; Set-C USDC → USDC. An agent's stored mandate
and live Privy policy still name the Set-C books until its owner amends it
(CLAUDE.md gotcha 13): `GET /agents/:id` then carries `kuruRetired` with the
sentence to show and the moved mandate, the app's Amend form loads the moved
markets, and every Kuru order or deposit is refused with `kuru_market_retired`
instead of a bare `policy_violation`.

## `@toxicflow-labs/ts-sdk` exists, and it is the SDK we want

`https://registry.npmjs.org/@toxicflow-labs%2Fts-sdk` → **200**.

| Version            | Published      |
| ------------------ | -------------- |
| 0.0.1              | 2026-09-01     |
| 0.0.2              | 2026-09-03     |
| 0.0.3              | 2026-09-07     |
| **0.0.4** (pinned) | **2026-09-09** |

_"Viem-first TypeScript SDK for Kuru contracts."_ Single dependency
`viem ^2.51.3`. Maintainer `toxicflow-labs`, licence `UNLICENSED`.
`packages/venues` pins **exactly `0.0.4`** — a `0.0.x` package gives no
compatibility promise between patches.

**Why a competent search missed it:** up to 0.0.3 the package had **no
`repository` field and no `homepage`** — nothing linked it back to Kuru — and it
was the only result for `npm search toxicflow`. 0.0.4 added both, pointing at
`github.com/Kuru-Labs/ts-sdk`, whose README says _"Releases are published to npm
as `@toxicflow-labs/ts-sdk`."_

Modules: `relay/`, `trading-wallet/`, `spot/`, `account/`, `exchange-ws/`,
`events/`, `abi/`, `generated/`, `errors/`, `utils/`.

Contrast with the old `@kuru-labs/kuru-sdk`: latest `0.0.95` (2026-01-27), built
on `ethers 5.7.1`. **Prefer the new SDK** — viem-first matches our whole account
stack, and it is under active development where the old one is eight months
stale.

## EIP-7702 delegated trading wallets are real

Verbatim: _"It builds, hashes, and signs the five current `KuruTradingWallet`
EIP-712 intents, and it can create the EIP-7702 authorization that delegates a
wallet EOA to the configured implementation."_

Exports `signEip7702Authorization`, `prepareReplaceBySlotIntent`,
`signPreparedWalletIntent`, `createWalletClientIntentSigner`. Examples use
`chainId: 10143`. ABIs pinned to `spot-contracts-v2` commit `e37bc396`.

Embedded wallets are explicitly anticipated: _"Injected, passkey, and
embedded-wallet integrations can use `createWalletClientIntentSigner(...)`. If a
provider offers EIP-7702 through its own API, adapt that method to the small
`Eip7702AuthorizationSigner` interface."_

One constraint: _"Do not use an authorization mode that treats the wallet as the
outer transaction executor. The relay sponsor submits the EIP-7702
transaction."_

### This composes with the Privy mandate — and it is a pitch beat

Privy exposes `eth_sign7702Authorization` with an
`ethereum_7702_authorization.contract` policy condition. So **the 7702
delegation target is itself enclave-constrainable**: the agent cannot redelegate
its trading wallet to an arbitrary implementation, because the enclave refuses
to sign an authorization pointing anywhere but the allowlisted one.

That is a second, independent enclave guarantee on the Kuru leg, and it closes
an attack the mandate would otherwise miss entirely — an agent that cannot
exceed its spend cap but _can_ redelegate its wallet has escaped the cap.

**The user's own account does not use this path** — see below. It stays
relevant for a later issue, as one way to give an _agent_ a signer.

## The relay is live

`POST https://relay.testnet.kuru.io/auth/challenge` → **200**, returning a real
SIWE challenge with `Chain ID: 10143` and an expiry.

Flow: `POST /auth/challenge` → `personal_sign` the exact message → `POST
/auth/token` → JWT, cached to `expiresAt`.

An earlier pass concluded the host was dead. It had hit bare `GET /` → **404**.
`GET` on the real routes returns **405** (route exists, wrong method), which is
the signal that distinguishes "no such host" from "wrong verb".

What the Relay is, per its docs: **gas sponsorship for a secondary trading EOA
that is EIP-7702-delegated to KuruTradingWallet.** Every order method
(`wallet.execute_batch`, `wallet.execute_replace_by_slot`) takes an intent
signed by that delegated EOA. It is not a general order-entry API, and a smart
account cannot use it as itself.

**Unverified:** whether _our_ wallet would be admitted. The SDK docs say
_"Authentication works with allowlisted and `allow-all` Relay deployments… the
SDK does not infer it from configuration."_ Nothing was signed, so admission is
untested — and MOV-254 does not need it.

## Addresses: there were THREE sets, and the obvious one was wrong (Set C was current until 2026-09-25)

| Set   | Source                                                    | Status                            |
| ----- | --------------------------------------------------------- | --------------------------------- |
| A     | `docs.kuru.io` SDK quickstart                             | **dead** — 0 bytes on both chains |
| B     | `docs.kuru.io` contract-addresses                         | live, but **V1**                  |
| **C** | **`kuru-testnet-docs.mintlify.site/deployments/testnet`** | **live, Spot V2 — use this**      |

**Use Set C.** `ts-sdk` targets Spot V2: its `generated/metadata.ts` pins
artifacts named `AccountCore`, `SpotRouter`, `OrderBook`, `KuruTradingWallet`,
`SpotPeriphery` — not V1's `Router`/`MarginAccount`. Its README says it targets
_"the new Kuru exchange contracts"_ and that _"the spot market artifact is now
`OrderBook`."_ Pairing the new SDK with Set B is a category error.

Verified by `eth_getCode` — every one has code on testnet 10143 and **zero on
mainnet 143**:

| Contract               | Address                                      | testnet  |
| ---------------------- | -------------------------------------------- | -------- |
| AccountCore (proxy)    | `0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22` | 141 B    |
| SpotRouter (proxy)     | `0xba24a1042701f06e8F7edCF04389260D1Fa4c697` | 141 B    |
| OrderBook impl         | `0xE20f57e673d7F254279c19270862A3d1E6F5B0d4` | 85,584 B |
| KuruTradingWallet      | `0xc7f2a9761276F7050D6561d2FDC51abC993F45E9` | 18,352 B |
| **TestnetTokenFaucet** | `0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9` | 2,427 B  |

Four live markets, all quoted in **Kuru Testnet USDC**
`0xee0722ead54f1b4fe97be399be43bc0226a6f97e` (6 decimals) — _not_ AUSD:

| Market     | Address                                      | Base       |
| ---------- | -------------------------------------------- | ---------- |
| MON/USDC   | `0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61` | native MON |
| WETH/USDC  | `0xa9C2936656a7D2143720BcD91Ba8506200B7CbE7` | 18 dec     |
| cbBTC/USDC | `0x5BDEA6F9F9abA34F4EcB9B865646A792b835ef7f` | 8 dec      |
| XAUt/USDC  | `0x0B4dD2A7b09d5c5401149fFe51301Cc589017343` | 6 dec      |

Two copying traps in the deployment page itself:

- **WETH `0x8B6C…380aaf8` is printed with a broken EIP-55 checksum.** viem
  rejects it at call time with `InvalidAddressError`, deep inside an encoder.
  The valid form is `0x8B6C5fafeF85B030bB1e71ae7ac085cC2380aAf8`.
  `constants.test.ts` checks every configured address so the next typo fails a
  test instead of a live run.
- The page calls the gold token **XAUt0**; its own `symbol()` and the Data
  Source catalog both say **`XAUt`**. The adapter uses `XAUt`.

### The spot leg needs Kuru Testnet USDC, not AUSD — and its faucet is generous (Set C only)

_Set D (above) has a different USDC and no public faucet; this faucet pays only the Set-C tokens._

`TestnetTokenFaucet` `0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9` is **not a
proxy** (EIP-1967 impl slot is zero), so its 30-selector dispatch table is the
real one — unlike Agora's faucet, where reading the proxy misleads.

**One `claim()` pays 10,000 USDC, 1 WETH, 0.1 cbBTC and 1 XAUt to
`msg.sender`**, observed from the Transfer logs of tx
`0xe0e063e9055614f27e253ab7e41f737c00f0800a43453079fb6fe2ef26c5b314`. Getter
values, read off the contract and matching the payout: `USDC_AMOUNT()` =
10,000e6, `WETH_AMOUNT()` = 1e18.

**The cooldown is 12 hours PER ADDRESS** — not global like Agora's AUSD
faucet. Established on chain, not from the getter names:

| Check                                          | Result                                           |
| ---------------------------------------------- | ------------------------------------------------ |
| `COOLDOWN()` (`0xa2724a4d`)                    | `43200` (12 h)                                   |
| `nextClaimAt(me)` (`0x11a163e9`) before claim  | `0`                                              |
| `nextClaimAt(me)` after claim                  | claim block timestamp **+ 43,200** exactly       |
| `nextClaimAt(anyone else)` after my claim      | still `0`                                        |
| Second `claim()` from me                       | reverts `0x15f3b7ab` + `uint256 nextClaimAt`     |
| `claim()` from a fresh address, right after it | **succeeds**                                     |
| `claim()` simulated from a contract address    | succeeds — a Kernel account can claim for itself |

So there is no contention with other teams: every address, including every
user's smart account, gets its own 10,000 USDC every 12 h. Unlike AUSD,
claim-on-demand is fine for the spot leg. Measured cost: 261,237 gas.

**Use this, not the treasury AUSD.** It is Kuru-native, permissionless, and
nearly ten million deep, where Agora's AUSD supply is finite and needed by the
Perpl leg.

## Testnet market data exists — on a different host

`https://exchange.kuru.io` **is mainnet-only**, confirmed: the markets its
`exchangeInfo` lists have code on mainnet 143 and **zero on testnet 10143**, and
its quote asset is the mainnet USDC. It is an older, separate surface.

Testnet exposes **three independent API surfaces**
(`kuru-testnet-docs.mintlify.site/api/introduction`). Every route below was
called and answered 200 with live data:

| Surface                  | Host                              | Routes the adapter uses                                                                |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------- |
| Data Source (finalized)  | `https://api.testnet.kuru.io`     | `/api/v1/markets`, `/api/v1/markets/{addr}/candles`, `/api/v1/users/{id}/order-events` |
| Exchange Gateway (live)  | `https://gateway.testnet.kuru.io` | `/api/depth?symbol=MONUSDC`, `/api/v1/users/{id}/orders?state=proposed`                |
| Relay (sponsored writes) | `https://relay.testnet.kuru.io`   | none                                                                                   |

Things that are easy to get wrong:

- **Gateway book routes take Kuru's symbol, not an address**:
  `/api/depth?symbol=MONUSDC&levels=20` and `/api/bbo?symbol=MONUSDC`.
  `/api/v1/markets/{addr}/l2book` 404s.
- **Candles need `from`** (Unix seconds); without it the API answers
  `400 from is required`. Native intervals are `1s 1m 5m 1h 6h 1d` only — the
  adapter builds 15m/30m from 5m, 4h from 1h and 1w (Monday-aligned) from 1d.
  `v` is **quote** volume ×1e18; there is no base-volume column, so
  `Kline.volume` is an estimate at each candle's typical price and says so.
- Every quantity is an **integer string in market units**: price ÷
  `pricePrecision`, size ÷ `sizePrecision`. MON/USDC is `1e6` / `1e8`.
- `/api/v1/users/by-address/{addr}` resolves an address to its account id; the
  adapter reads `AccountCore.userRegistry` on chain instead.
- User routes want the **numeric AccountCore id**, not an address.

**So no Envio indexer is required for the spot leg, and no mainnet fallback.**
Envio is still wanted for the agent leaderboard ($1k bounty), just not as a
market-data workaround.

## How the adapter trades (MOV-254)

### Finding 1 — orders go straight to the OrderBook, not through the Relay

The Exchange Gateway REST is read-only: **confirmed** — its reference lists
only book, BBO, balances and open orders, with no write route. Spot V2 accepts
an order two ways:

1. **Direct:** `OrderBook.batch(userId, orders, cancelSlotIdxs[, clientOrderId])`
   from any address holding live `TRADE` permission on `userId`. **`userId = 0`
   resolves to the caller's own account**, so whoever deposited trades with no
   id bookkeeping.
2. **Relay:** a secondary EOA, 7702-delegated to KuruTradingWallet, signs an
   EIP-712 intent; the Relay pays gas.

The adapter uses (1). It produces calls; the caller's submitter lands them. For
the Kernel account that is one ERC-7579 batch through
`apps/mobile/src/wallet/batch.ts`, so deposit-then-place is atomic.

### Finding 2 — a Kernel smart account can be the AccountCore root directly

Nothing in AccountCore or the OrderBook requires an EOA caller. Verified by
simulation against a real Kernel v0.3.1 account deployed on testnet during
MOV-253 (`0xEC4b217240f0292c65Bf136b341e400e2D28cA6F`): `execute(batch)` called
from the EntryPoint, with legs **faucet `claim` → USDC `approve` → AccountCore
`deposit` → OrderBook `batch` (resting GTC bid)**, succeeds with revert-on-
failure exec type, ~842k gas. The call list was the adapter's own
(`depositCalls` + `limitOrderCalls`) run through `encodeKernelExecute`. The
first `deposit` registers the Kernel address as a **root** account.

**Then landed as a real UserOperation**, because only a real transaction proves
an ERC-7579 batch (CLAUDE.md gotcha 8). Same account, same four legs, same
`encodeKernelExecute` call list, via `scripts/kuru-kernel-userop.ts`:

|                         |                                                                          |
| ----------------------- | ------------------------------------------------------------------------ |
| UserOperation           | `0x1c46d2646aeecee64a4c3f0c7384431074c0e5d5ed9759f58d414847e859857a`     |
| Bundle tx (`handleOps`) | `0x6c70f693e4b5b9a3cd237432fab5579297c9ed085698f3a848bbfb7560f24b98`     |
| tx status               | `success`                                                                |
| `UserOperationEvent`    | **`success = true`**, `actualGasUsed` 919,857, `actualGasCost` 0         |
| Result                  | AccountCore id **63** (root); order `0:3683` resting, 10.004 USDC locked |

`getOrderId(63, 0)` read back `3683` afterwards. The script checks the app's
encoder against `permissionless`'s `encodeCalls` before signing.

**Self-bundling with a zero fee bid.** The treasury called
`EntryPoint.handleOps` itself as beneficiary, and the UserOperation bid
`maxFeePerGas = 0`. That makes the required prefund
`(vgl + cgl + pvg) × maxFeePerGas` zero, so the account needed no MON and
nothing stranded in the EntryPoint — being the beneficiary alone does not do
that, since the prefund is still taken from the account. Limits:
`verificationGasLimit` 220,000, `callGasLimit` 812,498 (the measured execute
cost of this exact callData, minus 21k intrinsic), `preVerificationGas`
21,000; the outer transaction took 1,038,005 gas = 0.1059 MON at 102 gwei.

**Not landed:** the follow-up cancel as a second UserOperation. It estimated at
466,409 gas (0.0476 MON) and would have exceeded the cap, so the script
refused to send it. Order `0:3683` is still resting on that account.

> **Test vectors use Anvil default keys. Never fund an account derived from
> one.** `0xEC4b…A6F` is owned by `0x70997970…` — Anvil/Hardhat default account
> #1, whose private key is public. Anyone can drive that account; it holds only
> worthless test tokens and must stay that way. On mainnet, sweeper bots drain
> addresses derived from default keys within a block.

**Why root-owner-direct and not KuruTradingWallet.** KuruTradingWallet is
logic 7702-delegated into an EOA. For our users that would mean delegating
either the Mera EOA or a new trading EOA:

|                       | Kernel account as root (chosen)        | 7702 trading EOA + Relay                                         |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Gas                   | our paymaster, like every other action | Kuru's Relay sponsor — if our wallet is admitted (unverified)    |
| Monad reserve balance | not affected                           | a delegated EOA loses the exception and cannot go below 10 MON   |
| Atomic fund-and-place | yes, one ERC-7579 batch                | no — deposit is a separate AccountCore action                    |
| Moving parts          | none new                               | 7702 auth + AccountCore signer grant + Relay JWT + intent nonces |
| Stored TP/SL triggers | not available                          | available in the contract; **disabled on the testnet Relay**     |

### Subaccounts and delegated signers — how they would compose with agents

Not exercised on chain; read from the contracts reference, recorded for the
issue that wires agents in.

- **Delegated signers:** `authorizeAccountSigner(account, signer, permissions,
expiry)` grants a bitmap — `TRADE` 1, `INTERNAL_TRANSFER` 4, `WITHDRAW` 8,
  `ADMIN` 16 — optionally expiring. The signer then calls `batch` **itself**,
  naming the owner's `userId`. Revocation advances
  `accountSignerAuthorizationNonces(account)`, which also kills any
  trading-wallet intent signed under the old epoch. `…BySig` variants let
  anyone relay an EIP-712 grant.
- **Subaccounts:** a root links a consenting address with
  `createSubaccount(subaccount, deadline, signature)` (EIP-712 consent from the
  subaccount; ERC-1271 accepted). A subaccount has its own balances, orders and
  signers; `transferBetweenAccounts` moves free balance inside one root tree.
- **Composition with Privy mandates:** one subaccount per hired agent, funded
  with the mandate's allocation, and the agent's Privy wallet authorized on it
  with **`TRADE` only** and an expiry equal to the mandate's window. That gives
  two independent layers: the enclave limits what the agent can _sign_
  (`to` ∈ markets, `batch` calldata bounds), and AccountCore limits what the
  agent's address can _do_ — trade that subaccount's funds, never withdraw
  them, and nothing after expiry. Open question for that issue: the agent's
  Privy wallet is an EOA, so it needs gas for `batch` unless it goes through
  the Relay, which brings back 7702.

### Verified live on Monad testnet (2026-09-10, Set C — the previous market set)

From a throwaway EOA (`0x15BBC549326dd8D053233c3A546Aa7fDAbB57256`, AccountCore
id 62), via `pnpm --filter @sente/venues run kuru:live`:

| Step                                             | Transaction                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Faucet `claim()`                                 | `0xe0e063e9055614f27e253ab7e41f737c00f0800a43453079fb6fe2ef26c5b314` |
| USDC `approve` (30 USDC)                         | `0x40e4afde9d423e7fd43f3c9b345644dcc6037ffee3adb2c99fce028f61e48216` |
| AccountCore `deposit` — registers id 62          | `0xf0b6ffc917e6965f4e4cb88ed602c018b38e01144f7219ae907c26620e9c1e9a` |
| `placeLimit` 500 MON @ 0.02 GTC → rests `0:3680` | `0x2e22612f7d6542b2466ff09c7ca18c681ae67037c430d2d2f92d27ca78bf1111` |
| `cancel` `0:3680`                                | `0x2a9e40b3055783cb9b65b14c729f5756a346a36dbac084cadab3a428e523262b` |
| `placeMarket` 388 MON, 2% bound → 317.737 filled | `0x9d7fbce17b32fb4585612ed292ba064da5e85c0da865edee6dcfb2aefb2d30fd` |

After placing, `getOpenOrders` listed `0:3680` and 10.004 USDC was locked (10 +
maker-fee headroom); after cancelling it was gone. A second `cancel` of the
same id sent no transaction and reported `cancelled` from order history. The
IOC swept the whole best ask (317.73742494 MON at 0.030974); the next ask sat
above the bound, so the remainder was discarded and the order reads
`cancelled` with a partial fill. The USDC debit matched notional + 0.07% taker
fee to the atom. These receipts are `receipts.fixture.ts`.

### Gas, measured (Monad charges on the limit) — on Set C; re-measure on Set D

| Call                                             | Gas                                         |
| ------------------------------------------------ | ------------------------------------------- |
| USDC `approve`                                   | 52,089                                      |
| First `deposit` (registers the account)          | 252,059                                     |
| `batch`, GTC resting                             | 404,204                                     |
| `batch`, IOC sweeping one level                  | 425,430                                     |
| `batch`, cancel one slot                         | 242,923                                     |
| `AccountCore.withdraw`, USDC, from an EOA        | 150,407 (landed exactly this, SEN-15)       |
| USDC `transfer` between two holders              | 46,525 (landed exactly this, SEN-15)        |
| Faucet `claim`                                   | 261,237                                     |
| Kernel `execute` of claim+approve+deposit+place  | 812,498 `callGasLimit`; landed              |
| ↳ self-bundled `handleOps` transaction around it | 1,038,005                                   |
| Kernel cancel, one slot (estimated, not landed)  | 266,556 `callGasLimit`; 466,409 `handleOps` |

Also in `KURU_MEASURED_GAS`. Placement grows with the number of price levels
crossed.

## Builder fee (SEN-184)

Kuru lets an integrator ("builder") charge a fee on the orders it routes. Sente
uses it for its own fee: **10 bps (10,000 pps) on Kuru orders, paid to the
treasury**. Perpl has no equivalent Sente can use (its builder codes are issued
by hand), so Perpl trades carry no Sente fee.

### The contract surface

Read from the SDK's ABIs (`@toxicflow-labs/ts-sdk` 0.0.4, Set C) and, where marked, from
testnet AccountCore `0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22` on 2026-10-09.

| Piece                                                                                       | What it does                                                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AccountCore.approveBuilder(builder, uint32 maxFeePps, uint64 expiry)`                      | The root account lets `builder` charge up to `maxFeePps` until `expiry` (Unix s).                        |
| `AccountCore.getBuilderApproval(root, builder)`                                             | `(maxFeePps, expiry, active)`; all zero when never granted.                                              |
| `AccountCore.revokeBuilder(builder)`                                                        | Withdraws the approval.                                                                                  |
| `PPS_MULTIPLIER()` / `MAX_FEE_PPS()`                                                        | `10,000,000` / `100,000` (1%), read on testnet.                                                          |
| `OrderBook.batch(…, (address builder, uint32 feePps))`                                      | `0xed7dc4d7`; the plain `batch(uint40,tuple[],uint8[])` plus `builderConfig`.                            |
| `OrderBook.batch(…, bytes32 clientOrderId, (address, uint32))`                              | `0x2975ed7e`; the client-order-id overload plus `builderConfig`.                                         |
| `BuilderApprovalNotFound()` / `BuilderFeeTooHigh()`                                         | `0xd595f3a2` / `0x89c89cba`: an order naming an unapproved builder or a higher rate.                     |
| `event BuilderFeeAccrued(builder, asset, takerAccountId, orderBook, builderFeePps, amount)` | One per fee-paying execution; `builder`, `asset` and `takerAccountId` indexed.                           |
| `AccountCore.getClaimableBuilderFees(builder, asset)` / `claimBuilderFees(asset)`           | Set C only: fees accrued inside AccountCore, claimed per asset. Set D credits the builder root directly. |

`approveBuilder` is called by the root account itself, so it needs no account
id. `eth_estimateGas` on testnet (2026-10-09): **104,858** from a registered
account (the Kernel test account, id 63), **188,689** from an address AccountCore
has never seen — the call registers it. Not yet measured from a landed
transaction.

### How Sente uses it

- **Orders.** `placeOrderCall(market, order, clientOrderId?, builder?)` encodes
  the builder overload when `builder` is given and the plain one otherwise.
  `KuruVenue({ builder })` puts every order through it.
- **Approval.** Before an order, `KuruVenue.builderApprovalCalls()` reads
  `getBuilderApproval(account, builder)` and adds an `approveBuilder` leg when
  the approval is missing, inactive, below the rate, or about to lapse. Users
  approve for a year and re-approve with a day left; agents approve until their
  mandate's `expiresAt` (their policy's ceiling) and re-approve only within a
  minute of it lapsing.
- **What was paid.** `decodeBuilderFees(logs, accountCore, builder, accountId)`
  reads `BuilderFeeAccrued` off the execution's own logs; a placed order reports
  it as `Order.builderFee`.
- **Reserve.** A buy sets the builder rate aside on top of the venue fee
  (`quoteReserveAtoms` with `feePps + builderPps`, and the phone's
  `depositCapAtoms(…, builderFeePps)`), so the deposit covers the fee whichever
  way Kuru takes it.

### Not yet observed on chain

No builder order has landed yet. Three things the code assumes and a live
taker fill must confirm (`agent:venues-live -- --skip-perpl --builder
--builder-take`, see `docs/agents.md`):

1. **Taker only.** `BuilderFeeAccrued` names a `takerAccountId`, so a resting
   order's maker fills are taken to pay nothing; the creator ledger and
   `Order.builderFee` only count taker fills.
2. **Charged in the quote token, on top of Kuru's own fee.** The fee estimate,
   the ledger's asset and the reserve headroom assume USDC.
3. **Gas.** The builder overload costs more than the plain one (an approval read
   and a fee write). `KURU_BUILDER_ORDER_SURCHARGE_GAS` (40,000) is an
   allowance, not a reading: replace it with the measured difference.
