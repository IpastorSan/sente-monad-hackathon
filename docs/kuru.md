# Kuru — the spot leg

Two earlier research passes contradicted each other on almost everything here.
This records what was settled empirically, and by what method, because the
package in question is deliberately hard to find.

## `@toxicflow-labs/ts-sdk` exists, and it is the SDK we want

`https://registry.npmjs.org/@toxicflow-labs%2Fts-sdk` → **200**.

| Version            | Published      |
| ------------------ | -------------- |
| 0.0.1              | 2026-09-01     |
| 0.0.2              | 2026-09-03     |
| **0.0.3** (latest) | **2026-09-07** |

_"Viem-first TypeScript SDK for Kuru contracts."_ Single dependency
`viem ^2.51.3`. Maintainer `toxicflow-labs`, licence `UNLICENSED`.

**Why a competent search misses it:** the package has **no `repository` field
and no `homepage`** — nothing links it back to Kuru — and it is the only result
for `npm search toxicflow`. It never surfaces unless you query the exact name.
`github.com/Kuru-Labs/ts-sdk` (pushed 2026-09-07) closes the gap: _"Releases are
published to npm as `@toxicflow-labs/ts-sdk`."_

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

## The relay is live

`POST https://relay.testnet.kuru.io/auth/challenge` → **200**, returning a real
SIWE challenge with `Chain ID: 10143` and an expiry.

Flow: `POST /auth/challenge` → `personal_sign` the exact message → `POST
/auth/token` → JWT, cached to `expiresAt`.

An earlier pass concluded the host was dead. It had hit bare `GET /` → **404**.
`GET` on the real routes returns **405** (route exists, wrong method), which is
the signal that distinguishes "no such host" from "wrong verb".

**Unverified:** whether _our_ wallet would be admitted. The SDK docs say
_"Authentication works with allowlisted and `allow-all` Relay deployments… the
SDK does not infer it from configuration."_ Nothing was signed, so admission is
untested.

## Addresses: there are THREE sets, and the obvious one is wrong

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
| XAUt0/USDC | `0x0B4dD2A7b09d5c5401149fFe51301Cc589017343` | 6 dec      |

**The spot leg needs Kuru Testnet USDC, not AUSD.** `TestnetTokenFaucet` is
deployed and presumably dispenses it — _unverified_, but it is a Kuru-native
faucet and therefore a cleaner path than anything touching Agora's finite AUSD
supply, which the Perpl leg needs.

## Testnet market data exists — on a different host

`https://exchange.kuru.io` **is mainnet-only**, confirmed: the markets its
`exchangeInfo` lists have code on mainnet 143 and **zero on testnet 10143**, and
its quote asset is the mainnet USDC. It is an older, separate surface.

The testnet stack is entirely different hosts. Per
`kuru-testnet-docs.mintlify.site/api/introduction`, testnet exposes **three
independent API surfaces**. Confirmed serving live data:

```
GET https://api.testnet.kuru.io/api/v1/markets   -> 200, 4 active markets
GET https://api.testnet.kuru.io/api/v1/tokens    -> 200
```

Note the path shape is `/api/v1/...` — **not** the mainnet host's Binance-style
`/api/v3/exchangeInfo`, which 404s here. Probing `/api/v1/candles`, `/trades`,
`/orderbook`, `/balances`, `/orders` all 404 as bare paths, so they take
required parameters; read the API docs rather than guessing.

**So no Envio indexer is required for the spot leg, and no mainnet fallback.**
Envio is still wanted for the agent leaderboard ($1k bounty), just not as a
market-data workaround.

**Unconfirmed:** the Exchange Gateway REST surface is reportedly read-only,
which would mean order _placement_ goes through the relay. Confirm before
designing submission.
