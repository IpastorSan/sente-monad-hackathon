# Monad testnet — verified addresses and how to get funded

Everything here was verified by direct JSON-RPC against `https://testnet-rpc.monad.xyz`
(chain **10143**) on 2026-09-08, not read from documentation. Where a claim is
inferred rather than observed it says so.

> Monad testnet was **reset from genesis on 2025-12-16**. Any address published
> before that date is dead. Treat old blog posts and tutorials accordingly.

## Addresses

| What                 | Address                                      | Verified                                                                      |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| AUSD (Agora)         | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` | `name()`/`symbol()` = "AUSD", `decimals()` = 6, `totalSupply()` = 302,010,000 |
| AUSD faucet          | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` | deployed, 1,201 bytes                                                         |
| ↳ its implementation | `0xba804df5c476e8eaef87bf8085f295300cce2a49` | holds the real dispatch table                                                 |
| Perpl Exchange       | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` | deployed                                                                      |
| Kuru Router          | `0x7EFbE105Ca7415dE98F96622173458ac1c054630` | from Kuru docs, **not yet verified on-chain**                                 |
| Kuru MarginAccount   | `0xd029C2D98ff85D8F64799017fE00a59B1159CE02` | from Kuru docs, **not yet verified on-chain**                                 |

AUSD is **6 decimals**, not 18. Scale by `1e6`.

## Getting testnet AUSD

**It is documented** — on Agora's [contract-deployments page](https://docs.agora.finance/developer/contract-deployments),
listed under Monad Testnet next to the testnet AUSD address. It is _also_
described in their Instant Settlement docs as a Sepolia thing, which is what
sends you down the wrong path. Read the deployments page, not the product docs.

```solidity
// 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
function requestFunds(address recipient) external;   // selector 0x544c7cf9
```

**Payout: exactly 10,000 AUSD per call**, verified by `debug_traceCall` — it
performs `AUSD.transfer(recipient, 10000000000)`. Costs ~130k gas. `token()`
returns exactly the AUSD address above, so it dispenses the right asset.

**Not one-shot — you can top up repeatedly.** Two independent guards, both
verified, with distinct revert codes:

| Guard                     | Value            | Revert when tripped |
| ------------------------- | ---------------- | ------------------- |
| Recipient balance ceiling | **100,000 AUSD** | `0x0949dab9`        |
| **Global** cooldown       | **60 seconds**   | `0x20e5bc67`        |

Config read straight off the contract (names inferred from values and behaviour,
not from an ABI — no verified source exists on any chain):

| Selector     | Value          | Reading                          |
| ------------ | -------------- | -------------------------------- |
| `0x905467f6` | `10000000000`  | payout = 10,000 AUSD             |
| `0x14bc2fd7` | `100000000000` | recipient ceiling = 100,000 AUSD |
| `0x48645704` | `60`           | cooldown seconds                 |
| `0xd9772a25` | unix ts        | last request, **global**         |
| `0xfc0c546a` | AUSD address   | `token()`                        |

**The cooldown is global, not per-address — plan for contention.** `0xd9772a25`
returns the same value regardless of caller or argument, and steps forward when
_anyone's_ claim lands. Confirmed by binary-searching historical `eth_call`
around a real claim: block 60828793 (ts 1788891723) reverts `0x20e5bc67`, block
60828794 (ts 1788891724) succeeds. Exactly 60 seconds.

Operationally this means other Metropolis teams claiming can make us lose the
race. **Retry on `0x20e5bc67`** with a short backoff; a 60-second ceiling makes
it a non-issue as long as the code expects it.

Live payouts were observed during investigation — two real claims of exactly
10,000 AUSD in a ~30 minute window, and the faucet balance dropping
750,000 → 740,000. It is in active use, not abandoned.

### Supply is finite and draining fast — claim early

**No mint path exists for us.** AUSD's implementation exposes
`mint(address,uint256)` and `MINTER_ROLE()`, but `mint` reverts with
`0xdfcadb5b` from every sender simulated — a random EOA, a real faucet
recipient, and **the faucet contract itself**. The faucet holds no minter role;
`requestFunds` performs a plain `transfer` from a pre-funded balance. The
balance is strictly finite unless Agora tops it up manually.

**It has never been refilled within observable history.** Sampling the balance
backwards shows monotonic decline: 840,000 (6.8d ago) → 830,000 → 810,000 →
770,000 → **740,000 now**. The public RPC prunes state beyond ~2M blocks
(~7 days), so a refill before that cannot be ruled out — **unverified** past a
week.

**The burn rate is accelerating sharply**, which is the part that matters:

| Window      | Claims/day |
| ----------- | ---------- |
| 7d → 4d ago | 0.0        |
| ~4d ago     | 1.4        |
| ~2d ago     | 2.9        |
| ~1d ago     | 5.7        |
| last ~8h    | **8.6**    |

At the 7-day average the remaining 74 claims last ~50 days. **At the current
rate, ~9 days.** The acceleration is almost certainly other Metropolis teams
onboarding, so assume the pessimistic number.

**Mitigation: claim once or twice now into a treasury wallet and bank it.**
10,000 AUSD ÷ 100 AUSD minimum = **100 fundable accounts per claim**. Two claims
covers the entire hackathon. AUSD is a plain transferable ERC-20, so distribute
internally from the treasury rather than re-claiming per demo run.

**Do not build claim-on-demand into the app's demo flow.** That is what drains a
shared faucet, and it makes the demo depend on a resource we do not control at
the moment a judge is watching.

MON for gas comes from `https://faucet.monad.xyz` (0.5–10 MON per address per
24h, depending on whether the address holds mainnet ETH).

## Perpl collateral: the api-docs README is stale, and the wrong token is _tempting_

`PerplFoundation/api-docs` (README line 143) states testnet collateral is
`0xdf5b718d8fcc173335185a2a1513ee8151e3c027`. **That is wrong for the live
Exchange.** The token does exist on testnet — it is named "Test USD" / `USD`,
6 decimals — and it has a **fully permissionless `mint(address,uint256)`** with
no owner check and no cap. So it looks like the easy path, right up until
nothing works.

Verified by tracing `createAccount(100e6)` against the live Exchange:

```
CALL          -> 0x1964c32f... (Exchange)   0xcab13915  reverted
 DELEGATECALL -> 0x5dce9e6a...              0xcab13915  reverted
   CALL       -> 0xa9012a05... (AUSD)       0x23b872dd  reverted
```

It calls `transferFrom` on **AUSD**, and reverts only with
`ERC20InsufficientAllowance` (`0xfb8f41b2`) — meaning everything else passed.
Corroborated three ways: the Exchange holds **0** Test USD but **63,973,144
AUSD**; the live `GET /api/v1/pub/context` names AUSD; and `PerplFoundation/perpl-docs`
`networks-and-configuration.md` names AUSD.

**Use AUSD `0xa9012a05...`. Ignore the api-docs README on this point.**
(Found independently by two separate investigations, so this is not a one-off
misreading.)

## Perpl testnet onboarding — the working sequence

There is **no faucet in the Perpl testnet UI**. The frontend bundle (3.5 MB) has
zero occurrences of `faucet` or `requestFunds`, but 57 of `deposit` and strings
like _"Deposit to start trading"_ — it expects you to arrive already holding
AUSD. The Agora faucet is the only path and Perpl does not link to it.

```
1. MON for gas                      faucet.monad.xyz
2. requestFunds(you)                0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
                                    -> 10,000 AUSD
3. approve(Exchange, amt)           on AUSD 0xa9012a05...5322dC
4. createAccount(amt)               amt >= 100000000  (100 AUSD)
5. allowOrderForwarding(true)       without it, orders fail with reason 34
```

Steps 3-5 are three separate transactions and three failure modes — batch them
into one sponsored userOp via the ERC-7579 helper.

**Minimum is exactly 100.000000 AUSD**, established two independent ways:
on-chain binary search (99.999999 reverts `0xcfe73bb0`, 100.000000 passes) and
the live API's `min_account_open_amount`. Subsequent top-ups need only 10 AUSD
(`min_deposit_amount`); minimum withdrawal is 0.01 AUSD.

## Perpl onboarding — verified numbers

|                           | Testnet (10143)                    | Mainnet (143)             |
| ------------------------- | ---------------------------------- | ------------------------- |
| `min_account_open_amount` | **100 AUSD**                       | **10 AUSD**               |
| `min_deposit_amount`      | 10 AUSD                            | 10 AUSD                   |
| `max_account_equity`      | —                                  | 1,000,000 AUSD            |
| Collateral                | AUSD `0xa9012a05…5322dc`           | AUSD `0x00000000eF…9012a` |
| Markets                   | BTC, ETH, SOL, MON, ZEC, LIT, PUMP | 8 markets                 |

From the live `GET /api/v1/pub/context`. **Testnet costs 10x mainnet to open an
account** — 100 AUSD versus 10. One faucet claim (10,000 AUSD) covers 100
testnet account opens, so this is comfortable, but it is the opposite of what
you would assume.

Two calls are required, not one. `createAccount(uint256)` leaves order
forwarding **disabled**; `allowOrderForwarding(bool)` must be called separately
or the API cannot post orders. Both selectors confirmed present in the deployed
implementation: `createAccount` = `0xcab13915`, `allowOrderForwarding` =
`0x7962f910`. Note it takes a **bool** argument.

## Perpl API keys: we do NOT need to be whitelisted

The docs say _"the request's `Origin` must be whitelisted by Perpl… requests
from a non-whitelisted Origin are rejected."_ That is true for a _wrong_ Origin
and false for **no** Origin:

| `Origin` header             | `POST /api/v1/api-key/payload` |
| --------------------------- | ------------------------------ |
| _omitted_                   | **200** + `typed_data` + `mac` |
| `https://testnet.perpl.xyz` | **200**                        |
| `https://evil.example.com`  | 400                            |
| `http://localhost:3000`     | 400                            |

Route-existence controls confirm 400 means rejected rather than missing:
`POST /api/v1/api-key/nope` → 404, `GET …/payload` → 405. Mainnet behaves
identically.

**React Native's `fetch` does not send an `Origin` header**, so this is the
natural path for our app rather than a workaround. The returned typed data has
`"origin": ""`, and enrollment records that as `ApiKeyInfo.origin`.

**Unverified:** whether `/api-key/enroll` shares this behaviour. Probing it with
deliberately invalid signatures returns a bare 400 for both no-Origin and
bad-Origin, so the two failure modes are indistinguishable without a real
enrollment. The _payload_ step is proven reachable; enroll is not.

One gotcha worth stating: the payload endpoint 400s on a malformed key in a way
that looks like an Origin rejection. It wants a **32-byte Ed25519** public key
(`openssl genpkey -algorithm ed25519`); a 33-byte secp256k1 key 400s from every
origin and reads as a whitelist block.

## Perpl API keys need an EOA owner — ERC-1271 is not accepted (MOV-255)

**`/api-key/enroll` verifies the wallet signature with `ecrecover` only.** A
smart account can own a Perpl account on chain, but it can never get an API
key for it, so it can never trade through the API. The Perpl account must be
owned by the **passkey EOA**, not the Kernel smart account. Verified on testnet
2026-09-10, with controls that rule out everything else:

| Signer                          | Owns a Perpl account? | Signature                                                     | `/enroll` |
| ------------------------------- | --------------------- | ------------------------------------------------------------- | --------- |
| EOA `0xDBb4…611F`               | no                    | valid EIP-712                                                 | **404**   |
| same EOA, wrong key / garbage   | no                    | invalid                                                       | **400**   |
| same EOA                        | **yes** (account 493) | valid EIP-712                                                 | **200**   |
| Kernel `0x75b4…AeFf` (that EOA) | **yes**               | ERC-1271; the account's own `isValidSignature` → `0x1626ba7e` | **400**   |

The server checks the signature first (a bad one is 400) and looks up the
profile second (a missing one is 404). The Kernel account owned a live Perpl
account and produced a signature it validates on chain itself — and got the
same 400 as garbage. `target_profile` does not help either: it is for Perpl's
own `DelegatedAccount` contracts, and pointing it at the Kernel account returns 404.

The Kernel account's Perpl account was created with **one ERC-7579 batch
UserOperation** (approve → createAccount → allowOrderForwarding):
userOp `0xe1e2c1b2…98239`, `success = true` in the UserOperation receipt, bundle
tx `0x10943e82b8631689bac13a7da3d6fb7aa1c34e2cdc4e7d245ea79d23486aa1d0`. So
batching works on chain — it just produces an account nobody can ever trade
through the API. Its 100 AUSD is still there and can come back out through a
Kernel UserOperation calling `withdrawCollateral`.

Consequence for onboarding: the EOA needs MON for **three plain transactions**.
Measured, and cheaper than the UserOperation anyway (~0.035 MON against 0.078):

| Call                         | Gas used |
| ---------------------------- | -------- |
| `approve(Exchange, 100e6)`   | 71,099   |
| `createAccount(100e6)`       | 202,237  |
| `allowOrderForwarding(true)` | 71,363   |

After that the EOA needs no more MON for trading: API orders are forwarded, and
the exchange pays their gas.

### Two more things the docs get wrong or leave out

- **The signed request-target omits `/api`.** The REST base is
  `https://testnet.perpl.xyz/api`, but the proxy strips that prefix before it
  checks the signature. Signing `/v1/trading/account-history?count=5` → 200;
  signing `/api/v1/…` for the same URL → 401.
- **No `Origin` on `/enroll` either.** The enrollment above was made with no
  Origin header; the key records `origin: ""`.

### Gas limits that are too low for AUSD

An AUSD `transfer` to a fresh recipient uses **72,918** gas.
`MONAD_GAS_LIMITS.erc20Transfer = 65_000n` runs out of gas, and Monad charges
the full limit for the failure (two such reverts on 2026-09-10:
`0x9a0bd10d…`, `0x16a7c0e6…`). A MON transfer **into a Kernel account** uses
40,995, not 21,000: it runs the account's `receive()`.

## The gotcha that nearly produced a wrong answer

Reading the **proxy's** bytecode shows three selectors and `requestFunds` is not
among them. That reads as "wrong contract" and sends you chasing a problem that
does not exist.

Two things follow, and both generalise beyond this contract:

1. **A dispatch table lives in the implementation, not the proxy.** Read the
   EIP-1967 slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
   and scan _that_ contract's bytecode.
2. **An `eth_call` that returns `0x` against a proxy proves nothing on its own.**
   A fallback can swallow an unknown selector and return empty without reverting.
   Confirm the selector exists in the implementation before believing a
   non-reverting call.

## Useful RPC recipes

```bash
RPC=https://testnet-rpc.monad.xyz

# Is a contract deployed?
curl -s -X POST $RPC -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["<addr>","latest"]}'

# Read the EIP-1967 implementation slot
curl -s -X POST $RPC -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["<proxy>","0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc","latest"]}'

# Extract the selector table from bytecode: the dispatch is PUSH4 (0x63) + 4 bytes
#   grep -oP '63\K[0-9a-f]{8}' <<< "$code" | sort -u
```

**`eth_getLogs` on the public RPC is capped at a 100-block range**, so history
scans need an indexer (Envio HyperSync, `https://monad.hypersync.xyz`) rather
than raw RPC.

---

## Perpl mainnet is open — and it is the fallback if the faucet dries up

The UI says "gated beta" and asks for an access code. **The contract does not.**

The mainnet Exchange implementation does contain the gate — scanning all 320
selectors in its 126,672-byte implementation found `whitelistingEnabled()`
(`0x5b0c29eb`), `whitelisted(address)` (`0xd936547e`) and
`setWhitelistingEnabled(bool)` (`0x5f40c1f7`). Read live:

```
whitelistingEnabled()   -> false
whitelisted(<random>)   -> false
```

The mechanism exists and **the switch is currently off**. Testnet returns false
for the same flag.

**Proven end to end, not just inferred.** Reaching `transferFrom` only shows the
path gets that far; a whitelist check could have sat after it. That was closed
by overriding AUSD's bytecode with a stub returning `1` for every call
(`0x60015f5260205ff3`) and calling `createAccount(10 AUSD)` from a random,
non-whitelisted address. It **succeeds**, returning account ID `0x147f` = 5247.
No revert anywhere. Insufficient allowance was the only thing ever in the way.

That ID is itself informative: mainnet has ~5,247 accounts. The "gated beta" is
not keeping people out at any meaningful scale.

| Layer    | Gated?  | Evidence                                                           |
| -------- | ------- | ------------------------------------------------------------------ |
| Web UI   | **yes** | "gated beta phase", access codes, waitlist                         |
| API      | **no**  | `/api-key/payload` returns a valid payload for a random address    |
| Contract | **no**  | `whitelistingEnabled() == false`; stubbed `createAccount` succeeds |

The access-code wall is a front-end product decision, not a protocol
restriction. An app talking to the contracts and REST API never meets it.

### Why this matters strategically

**A mainnet demo costs 10 AUSD plus gas.** Mainnet's
`min_account_open_amount` is 10 AUSD — a tenth of testnet's 100 — and mainnet
has no faucet dependency at all. So if the testnet faucet runs dry mid-hackathon
(see the burn-rate table above), the fallback is roughly ten dollars of real
money, not a lost bounty.

Real AUSD: native on Monad mainnet at `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`
(6 decimals), Agora bridge at `0x9CaB7Ede13dc56652E44D2404E969C212f22689b`.
Agora deploys AUSD on 9 EVM mainnets plus Solana, so buy on whichever chain your
exchange supports and bridge in. Perpl ships `funBridgeEnabled: "on"` in mainnet
config, so Fun.xyz bridging is live in their UI — **mainnet only**, absent from
testnet.

### Two caveats

1. **`setWhitelistingEnabled(bool)` is owner-flippable.** Today's answer is a
   snapshot. Re-read `whitelistingEnabled()` before committing to a mainnet
   demo — one `eth_call`.
2. **`POST /api/v1/api-key/enroll` was never exercised** — it needs a real
   wallet signature. A server-side whitelist _there_ remains possible and is the
   only thing that could still block a mainnet demo. One signed request from a
   funded wallet settles it.

Mainnet also returns `getMinimumPostCNS()` = 0 and `getMinimumSettleCNS()` = 0 —
no per-order floor today. Exchange `owner()` is
`0xd0a0205e9188998e0be7f2600a715ad3cd289cb1`.
