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

**Not one-shot — you can top up repeatedly.** The guard is a balance ceiling,
not a cooldown: it reads `balanceOf(recipient)` and reverts with `0x0949dab9`
if the recipient already holds too much. Verified by `eth_call` per address:
balances of 0, 100, 8,800 and 9,504 AUSD all succeed; 740,000 and 63.9M revert.
The exact cutoff is somewhere in (9,504, 740,000] and was not pinned further —
AUSD uses ERC-7201 namespaced storage, so a balance cannot be state-overridden
to bisect it. Practically irrelevant: 10,000 AUSD is far more than needed.

Live payouts were observed during investigation — two real claims of exactly
10,000 AUSD in a ~30 minute window, and the faucet balance dropping
750,000 → 740,000. It is in active use, not abandoned.

**Supply is finite.** 740,000 AUSD is ~74 remaining claims at time of writing,
and nothing tops it up. Do not burn claims casually.

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
