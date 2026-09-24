# The user's wallet (SEN-40)

Every signed-in user gets **one Privy server wallet whose owner is their phone's
`device` P-256 key** (SEN-38). The API creates it, reads it, and **cannot sign
for it** — the owner key never leaves the device, and Privy enforces the owner's
signature on its side (SEN-39 measured all three cases live:
`docs/privy-sponsorship.md`, checks 4a–4c).

This replaces the Kernel smart account as the user's account (decision of
2026-09-13). `GET /wallet` and `POST /wallet/register` serve the Privy wallet;
the Kernel routes (`prepare`, `execute`, `operations`, plus `GET /wallet/kernel`
and `POST /wallet/kernel/register`) stay until SEN-45 retires them.

## The two routes

Both are behind `SessionAuthGuard`: identity is the session token's subject —
the caller's lowercase EOA address — never a body field.

```
POST /wallet/register       {"devicePublicKey": "<base64 SPKI DER, P-256>"}
GET  /wallet
```

Both answer with the same object:

```json
{
  "userId": "0x1111111111111111111111111111111111111111",
  "walletId": "<sen40-user-wallet-id>",
  "address": "0x95206CCBE0735bf436b39226DCaA5DF536FA6d5e",
  "ownerQuorumId": "<sen40-owner-quorum-id>",
  "devicePublicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…",
  "chainId": 10143,
  "createdAt": "2026-09-18T11:55:17.869Z",
  "balances": [
    { "symbol": "MON", "address": "0x0000…0000", "decimals": 18, "raw": "0", "amount": "0" },
    {
      "symbol": "USDC",
      "address": "0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E",
      "decimals": 6,
      "raw": "0",
      "amount": "0"
    },
    {
      "symbol": "AUSD",
      "address": "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
      "decimals": 6,
      "raw": "0",
      "amount": "0"
    }
  ]
}
```

Every number crosses as a string, twice: `raw` in atoms and `amount`
decimal-shifted, so a client never has to know a token's decimals to render it.
The addresses come from `@sente/venues` (`KURU_TESTNET_TOKENS.USDC`,
`PERPL_TESTNET_CONTRACTS.collateral`) rather than a second copy — **Kuru's USDC
and Agora's AUSD are different tokens** and a drifted constant shows a confident
`0.00`. AUSD is on this screen because the Agora bounty requires it.

Refusals carry a stable `reason`:

| reason                        | status | when                                                 |
| ----------------------------- | ------ | ---------------------------------------------------- |
| `account_not_registered`      | 404    | `GET /wallet` before any register                    |
| `invalid_device_key`          | 400    | not the base64 SPKI DER of a P-256 public key        |
| `device_key_mismatch`         | 409    | this user already has a wallet under a DIFFERENT key |
| `user_wallets_unconfigured`   | 503    | no `PRIVY_APP_ID` / `PRIVY_APP_SECRET`               |
| `user_wallet_provider_failed` | 502    | Privy refused or was unreachable                     |

## Why the owner is an explicit 1-key quorum

SEN-39 verified live that Privy takes both `owner: {public_key}` and
`owner_id: <quorum>`, and that the first is **sugar for the second** — it
auto-creates a 1-key quorum and answers with its `owner_id`. We create the
quorum ourselves (`createKeyQuorum`, threshold 1) because we want its id in
hand: recovery — adding a second device key — is a PATCH to _that_ quorum, and
only the existing device key can authorize it. Having the id without a second
round trip is the difference between a recovery path and an archaeology
exercise. `ownerQuorumId` is in the response for the same reason.

## Why there is no signing helper

`agents/privy/user-wallet.ts` creates the wallet and reads it back, and that is
all it will ever do.

|          | agent wallet         | user wallet                  |
| -------- | -------------------- | ---------------------------- |
| owner    | our mandate quorum   | the user's DEVICE key quorum |
| signers  | our agent quorum     | **none**                     |
| policies | the compiled mandate | **none**                     |

An agent wallet names our agent quorum in `additional_signers`, so the server
can sign trades within the mandate. A user wallet has no signer at all: the
server holds the app secret and still cannot move a wei. Adding a
`signUserTransaction()` here would need an approval this process does not have,
and the day someone "fixes" that by putting a user's key in `.env` is the day
self-custody stops being true. Sending is SEN-42, from the device.

## Registration is idempotent, and it has to be

A Privy wallet's address is **not** derived from its owner — unlike a Kernel
account, registering twice does not land on the same address, it makes a second
wallet and hides whatever the first one holds. Two guards:

- the registry binds first-write-wins per user, and refuses a different device
  key (`device_key_mismatch`);
- `UserWalletService` collapses concurrent registers for one user into a single
  provision call, so a phone that retried on a slow network gets one wallet.

Recovery is deliberately out of scope (SEN-40's notes): the honest answer to a
new device key today is a refusal, not a silently-minted second wallet.

**The registry is in memory**, the repo's current standard — and the cost is
higher here than for the Kernel registry, which is worth saying out loud: a lost
binding means the next register creates a _second_ wallet and the funded one is
orphaned. The wallet itself survives in Privy, owned by the same device key, but
nothing remembers its id. Point `USER_WALLET_REGISTRY` at a real store before
anything of value lands in a user wallet.

## Configuration

`PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and nothing else — the two authorization
keys in `.env` belong to agent wallets. Set neither and `POST /wallet/register`
refuses with `user_wallets_unconfigured`; set one and boot fails naming the
other. Balances are read over `MONAD_TESTNET_RPC_URL` (viem's public default
when unset).

## Verified live, 2026-09-18

Against app `<privy-app-id>` on Monad testnet (10143), with a
throwaway device key generated by `generateAuthorizationKey()`:

```
$ curl -s -X GET http://localhost:3077/wallet -H 'x-sente-user-id: 0x1111…1111'
404 {"reason":"account_not_registered", …}

$ curl -s -X POST http://localhost:3077/wallet/register \
    -H 'x-sente-user-id: 0x1111…1111' -H 'content-type: application/json' \
    -d '{"devicePublicKey":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEP0q+QA4N/+G34m0GgUXFzRcBxLoHpHYYnGHDX2Fw2jb83/YWfwjuVNtYDPIGJNWLRnFjqg5qGaItIDd/Ndb0Qw=="}'
200 wallet <sen40-user-wallet-id> → 0x95206CCBE0735bf436b39226DCaA5DF536FA6d5e
    ownerQuorum <sen40-owner-quorum-id>, balances MON/USDC/AUSD all 0

$ …the same POST again        → 200, the SAME walletId and createdAt, no Privy write
$ …with a second P-256 key    → 409 device_key_mismatch
$ …with a base64 blob that is not a P-256 point → 400 invalid_device_key, before Privy is called
```

And read back from Privy itself, which is the part worth keeping:

```
GET /v1/wallets/<sen40-user-wallet-id>
  → policy_ids: [], additional_signers: [], owner_id: <sen40-owner-quorum-id>
GET /v1/key_quorums/<sen40-owner-quorum-id>
  → authorization_threshold: 1, authorization_keys: [ our device public key ]
```

No signer, no policy, and the only key that can authorize anything is the one
the phone holds. The balance reader was checked against a funded address in the
same run — the SEN-39 probe wallet `0xab91d510F02c5A4191Db61121904f208E31A7Af8`
reads `MON=0 USDC=1 AUSD=0`, matching what that doc recorded.

## Open, and deliberately so

- **Gas sponsorship is still off** for this app (SEN-39, check 6:
  `"Gas sponsorship is not enabled."`). Creating and reading a wallet does not
  need it; SEN-42's sends do.
- **The address under EIP-7702 delegation is unmeasured.** If Privy's sponsored
  path upgrades the EOA, re-check that the address `GET /wallet` reports still
  matches, and that `eth_signTypedData_v4` still returns an `ecrecover`-able
  signature (CLAUDE.md gotcha 9 depends on it for Perpl).
- **Recovery**: adding a second device key to the owner quorum, authorized by
  the first. Not implemented; `device_key_mismatch` is the current answer.
