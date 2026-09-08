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

## Addresses: trust the contract-addresses page

Kuru's docs contradict themselves — the SDK quickstart page and the
contract-addresses page list **different** testnet addresses. The quickstart's
addresses have **no code on either chain**. Use the contract-addresses page.

## Open: is there a testnet REST API?

`https://exchange.kuru.io` appears to be **mainnet-only**. This is unresolved
and it matters — the spot leg's market-data plan assumed testnet coverage.

If there is genuinely no testnet REST API, the options are to drive the testnet
contracts directly through the new SDK and index events ourselves with Envio
(which we want for the leaderboard regardless), or to run the spot leg on
mainnet. Resolve before building against an API that does not serve our chain.
