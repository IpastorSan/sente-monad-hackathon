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

**Agora deployed their faucet on Monad testnet and never documented it.** Their
docs describe this contract only for Sepolia, under the separate Instant
Settlement product. It is the same address on Monad testnet — they reuse
addresses across chains.

```solidity
// 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
function requestFunds(address recipient) external;   // selector 0x544c7cf9
```

Confirmed: `token()` on the faucet returns exactly the AUSD address above, so it
dispenses the right asset. At time of writing the faucet held **750,000 AUSD**.

`eth_call` from a fresh zero-history address does not revert. **This is not the
same as a successful broadcast** — the first real call still has to be made from
a MON-funded key.

**Unresolved:** whether `requestFunds` has a per-address cooldown or a one-shot
guard. The implementation exposes `0x14bc2fd7`, `0x48645704`, `0x905467f6`,
`0xd9772a25` (all zero on a no-arg call) and `0x8be6392f` (non-zero), none of
them yet named. This decides whether one address can top up across demo runs or
whether each run needs a fresh address.

MON for gas comes from `https://faucet.monad.xyz` (0.5–10 MON per address per
24h, depending on whether the address holds mainnet ETH).

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
