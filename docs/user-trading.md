# User trading, run live (SEN-81, SEN-82)

The user's own Kuru trades and Perpl onboarding, enrollment and orders, run end
to end against Monad testnet on 2026-10-09 through the code the app ships:
`TradeApi`, `runTrade` (which runs `verifyKuruTrade` before anything is
signed), `signPrivyAuthorization`, `perplTradeKey` and `createPerplTrader`, all
imported from `apps/mobile/src`. Nothing in the script imports the API.

## How to run it

`apps/mobile/scripts/trade-live.ts` is the phone: a throwaway secp256k1 key signs
in (`POST /auth/challenge`, `POST /auth/session`), a throwaway P-256 device key
registers the Privy wallet (`POST /wallet/register`), and the modes below trade
through a **local** API. Never point it at production.

```bash
# 1. A local API with trading on, its own state dir, and the two server-side
#    senders OFF: production uses the same STARTER_DRIP and GAS_DRIP keys, and a
#    second sender on one key collides on nonces. Command-line values outrank
#    --env-file; the boot log must say "starter kit is off" and
#    "GAS_DRIP_PRIVATE_KEYS is empty".
cd services/api && mise exec -- pnpm run build
USER_TRADING=1 PORT=3100 STATE_DIR=$(mktemp -d) \
  STARTER_DRIP_PRIVATE_KEY= GAS_DRIP_PRIVATE_KEYS= AGENT_TICK_SECONDS= \
  mise exec -- node --env-file=../../.env dist/main.js

# 2. The phone (from apps/mobile; trade:live loads ../../.env).
K="--keys /path/outside/the/repo/keys.json"   # created 0600 on first run, reused after
mise exec -- pnpm run trade:live fund --usdc 60 --ausd 150 $K   # treasury → the user's wallet
mise exec -- pnpm run trade:live kuru $K --out kuru.json        # runs 1-5 and P2
mise exec -- pnpm run trade:live perpl $K --out perpl.json      # P5
```

Other modes: `kuru --steps gtc,cancel,buy,sell,withdraw,p2 [--order-id slot:id]`
runs a subset; `account` prints `/trade/perpl/account` and the Perpl portfolio
section; `userops --tx <hash> --userop <hash>` lists every user operation the
wallet landed since that one; `sigcheck` recovers the wallet's Privy EIP-712
signature over a live Perpl payload locally; `supersede [--scope trade]
[--count n] [--reverse]` enrolls throwaway keys to test Perpl's ordering rule
(each success uses one of the account's 16 key slots).

`fund` reads `TREASURY_PRIVATE_KEY` and sends with explicit gas limits (USDC
72,000, AUSD 82,000). P2, `sigcheck`, `supersede` and the read-key part of
`perpl` call Privy directly with `PRIVY_APP_ID` / `PRIVY_APP_SECRET`: that part
is test harness, not phone code. No key is ever printed.

## The run

- User wallet `0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF` (Privy
  `bb4xa8cfoxozqyf8p40j8dky`), owned by a throwaway device key; it held 0 MON
  throughout. Every step below is a Privy-sponsored send.
- Funding from the treasury: 60 USDC
  `0x8d72b5a304acb2e468d7678960d455c797735e9e11b444cd8c0531b4b732538d`, 150 AUSD
  `0x477a4c3500d2341c7b1af487ba47b7336e844d7cbf4b2cc020dcae824779be02`.
- The MON-USDC and WETH-USDC books were **empty** (`bestBidAsk` answered the
  empty sentinels on both sides), so the IOC legs ran on cbBTC-USDC (bid
  83,969.90, ask 84,348.32).

## Kuru: runs 1-5

Every trade `completed`; every step `included`, read from the user operation's
own `success` (gotcha 8). Slippage 1%.

| Run                                                                   | Step     | User operation                                                       | Transaction                                                          |
| --------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 GTC post-only buy MON-USDC, 1,020 MON at 0.01 (10.2 USDC), rests    | approve  | `0x110570630db251956bd289e162c49fb6c6cc23d8247196f74be7ba915452d253` | `0xa1db066e8207b900e2f5ec7e0c42c50cdc13c7ea7b86b1578f54234f22bf8f6b` |
|                                                                       | deposit  | `0xc27e885e11d159bb72018995d983a62f01576110a4554cf2d65723828deacb30` | `0x879dcbfa7ffac158a4c10b0b66c4504c66fd3ddbbeafdcddea397cb105b0ceb0` |
|                                                                       | place    | `0x33b904a7733a563747c40ff1c654f402e0317241030d49bf465b15d667d6b038` | `0x824b6f668020e8cae7c770f317177a4282a90f8b04cb893b38b899fec0ee4e68` |
| 2 cancel order `0:197548`                                             | cancel   | `0xcc8080ee3f2b1261ed62a969fad4ebdea26397dd27b899096350dba14e2c642e` | `0x294a55583434e5e38cfbfb1d587854a274696129620d116e7a44a6cc69125124` |
| 3 IOC buy 0.00014227 cbBTC, filled at 84,348.32, fee 0.0084 USDC      | approve  | `0x61e448edfb0badba8d51af5758b1ef39e17530a3eb1c689da88b9404ead8d6ab` | `0xad86ffc5df7da9edfdaec895e688c03b1f3edbf50ba4ed706b47592c608df5b3` |
|                                                                       | deposit  | `0x0456e191ad7652f1fb59095018658fe2207847ba26d0d29fdce9ed6328b561e3` | `0x3d54e3f7d27896c6bb8874d77008b2737a70ee0816c73187818d795323cb3305` |
|                                                                       | place    | `0xf91ee45c8ddf7e48d54e09233948746e19109762e03bcb257c3a5deab2faa159` | `0x231ad29a8daa76320b638fc1a3a245376a7cf7fa6937d8dc16f9963dad38a246` |
| 4 IOC sell 0.00014227 cbBTC from the Kuru balance, filled at 83,969.9 | place    | `0x51936c1c035f5dccab0ffa87bf64320b7846e61b591af7c4354076424804303a` | `0x2dc4d40debac5982a1724eaf1ac527f4975cdc9049c9a5f75ce9d44b9e03a55f` |
| 5 withdraw 12.051964 USDC from Kuru                                   | withdraw | `0x88c45c08e8be1517e61a1f2857dd9fe20fa1e838c7ce7e0788b8d685f3600cd4` | `0x1cee442e674a4f4892bf3597b57eaeb7b6fc1e11924e4f8b0294674d0bb0a1dd` |

What it shows:

- **Privy accepts `privy-idempotency-key` inside a device-signed payload.** The
  open question from the plan: the phone signs `{version, method, url, body,
headers: {privy-app-id, privy-idempotency-key}}`, the API forwards it with the
  same two headers, and Privy verified the signature on the first try for every
  step. The signature has to cover both `privy-` headers; nothing else is
  signed.
- The first send delegated the wallet (EIP-7702), and the next two steps of the
  same trade landed behind `WALLET_SEND_SPACING_MS` (4 s) with no nonce
  mismatch.
- Run 1 deposited 10.20408 USDC: notional plus the 0.04% maker-fee headroom.
  Run 3 deposited only the shortfall, because the cancelled order's 10.20408
  USDC was already free in the Kuru account. Run 4 needed no deposit at all.
- Fills decoded from the user-operation receipts into `result` (`orderId`
  `0:197548` resting; `filled` with prices and fees for 3 and 4).
- Round trip cost: the wallet went from 60 to 59.923242 USDC (two taker fees,
  0.016762 USDC, plus the spread).

### P2: one signed request, sent twice, lands once

After run 5, the harness re-committed the trade through the API and then sent
the withdraw's already-signed request, byte for byte, straight to Privy with
the same signature and idempotency key
`sente-trade:3b261972-497a-4a47-a919-c69147e99f3b:0`:

- the API's second commit answered with the trade as it was (`completed`) and
  sent nothing;
- Privy answered **200 with the original operation**: the same
  `user_operation_hash` (`0x88c45c08…`) the API's send had recorded, with
  `transaction_id` `05892b5b-a69e-4ce4-a0f9-3707887b78b1`;
- `UserOperationEvent` logs from the EntryPoint
  (`0x0000000071727de22e5e9d8baf0edac6f37da032`) for the wallet, from the
  withdraw's block (69575878) to minutes after the replay: **exactly one**, the
  original (`userops --tx 0x1cee44… --userop 0x88c45c…`).

Not run here: the same replay **without** a key (the risk the key closes), and
the plan's P1 (b)/(c) atomic batch, P3 nonce pinning and P4 reserve rule.
`USER_TRADE_ATOMIC_BATCH` stays off.

## P5: Perpl as a user

### Onboarding through `/trade`

`perpl.onboard` with 100 AUSD planned three steps; all `included`. Perpl account
**1028**.

| Step                    | User operation                                                       | Transaction                                                          |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `perpl.approve`         | `0x02bd8a4dacd7965341675d247c634e125a99abece853ebef8fb212523620c6df` | `0x194a4fde095bd3a493ff76f6199f60502c02c7e50360447a9bbaf30b81a1b773` |
| `perpl.createAccount`   | `0xa8a426c63628989c993ba610b485e346e53903c1187137aa7d71b9fa7559ee9c` | `0x5724a5f3e884d3627dc928420ee80156f09c6f47c9314d4f82e6d1bce86c24f1` |
| `perpl.allowForwarding` | `0x740f413db5062372296de2427fe0fe0cbf7ac9da1329fb61c61f78c6c6f92289` | `0xa3465ffb70d6c956dbf3151ff06b2cd7656b0217d1d83bef5a1888c82f06c92d` |

The phone has no `verifyPerplOnboard` yet (SEN-98); the script checked each
envelope with the real `verifyTradeEnvelope` and that every target was AUSD or
the Exchange.

### The live `/v1/api-key/payload` responses, verbatim

Trade scope. Request:
`{"chain_id":10143,"address":"0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF","public_key":"0x2be8e424ff7f6ed41da4af772874a880db8a8f78636784806c3fd2ccd6d4b31c","scope_mask":2,"label":"sente-trade-live"}`
(the HKDF trade key, `sente.perpl.trade-key.v1`). Response:

```json
{
  "typed_data": {
    "types": {
      "EIP712Domain": [
        { "name": "name", "type": "string" },
        { "name": "version", "type": "string" },
        { "name": "chainId", "type": "uint256" },
        { "name": "verifyingContract", "type": "address" },
        { "name": "salt", "type": "bytes32" }
      ],
      "PerplRegisterApiKey": [
        { "name": "signer", "type": "address" },
        { "name": "statement", "type": "string" },
        { "name": "publicKey", "type": "string" },
        { "name": "scope", "type": "string" },
        { "name": "label", "type": "string" },
        { "name": "expiresAt", "type": "string" },
        { "name": "ipCidrs", "type": "string" },
        { "name": "origin", "type": "string" },
        { "name": "builderId", "type": "string" },
        { "name": "maxBuilderFeePer100K", "type": "string" },
        { "name": "time", "type": "uint64" }
      ]
    },
    "primaryType": "PerplRegisterApiKey",
    "domain": {
      "name": "perpl.xyz",
      "version": "1",
      "chainId": "0x279f",
      "verifyingContract": "0x0000000000000000000000000000000000000000",
      "salt": "0x00000000000000000000000000000000000000006ac90ca3895a93c38d8e6b80"
    },
    "message": {
      "builderId": "0",
      "expiresAt": "0",
      "ipCidrs": "",
      "label": "sente-trade-live",
      "maxBuilderFeePer100K": "0",
      "origin": "",
      "publicKey": "K-jkJP9_btQdpK93KHSogNuKj3hjZ4SAbD_SzNbUsxw",
      "scope": "3",
      "signer": "0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF",
      "statement": "I authorize the creation of Perpl API key with the specified scope and parameters",
      "time": "0x1a121595e56"
    }
  },
  "mac": "0x281eaf5758e5f451034bbaaebfe05b0a232e9531507d27ab4b151ec944a03936"
}
```

Read scope. Request:
`{"chain_id":10143,"address":"0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF","public_key":"0xe0c46a563432ce866995226970d51bd3c6339e0b2815f2a2e3127c0e0c23fbd6","scope_mask":1,"label":"sente-trade-live-read"}`.
Response:

```json
{
  "typed_data": {
    "types": {
      "EIP712Domain": [
        { "name": "name", "type": "string" },
        { "name": "version", "type": "string" },
        { "name": "chainId", "type": "uint256" },
        { "name": "verifyingContract", "type": "address" },
        { "name": "salt", "type": "bytes32" }
      ],
      "PerplRegisterApiKey": [
        { "name": "signer", "type": "address" },
        { "name": "statement", "type": "string" },
        { "name": "publicKey", "type": "string" },
        { "name": "scope", "type": "string" },
        { "name": "label", "type": "string" },
        { "name": "expiresAt", "type": "string" },
        { "name": "ipCidrs", "type": "string" },
        { "name": "origin", "type": "string" },
        { "name": "builderId", "type": "string" },
        { "name": "maxBuilderFeePer100K", "type": "string" },
        { "name": "time", "type": "uint64" }
      ]
    },
    "primaryType": "PerplRegisterApiKey",
    "domain": {
      "name": "perpl.xyz",
      "version": "1",
      "chainId": "0x279f",
      "verifyingContract": "0x0000000000000000000000000000000000000000",
      "salt": "0x00000000000000000000000000000000000000006ac90ca3def173c38d4127dd"
    },
    "message": {
      "builderId": "0",
      "expiresAt": "0",
      "ipCidrs": "",
      "label": "sente-trade-live-read",
      "maxBuilderFeePer100K": "0",
      "origin": "",
      "publicKey": "4MRqVjQyzoZplSJpcNUb08YzngsoFfKi4xJ8Dgwj-9Y",
      "scope": "1",
      "signer": "0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF",
      "statement": "I authorize the creation of Perpl API key with the specified scope and parameters",
      "time": "0x1a121595f02"
    }
  },
  "mac": "0x5e0726572c27d84f6df80c1a1f1bacbbfc054996fc094d019221d4a9ce434afa"
}
```

An earlier pair from the same wallet (times `0x1a121515593` / `0x1a121515641`)
had the same shape; it is the fixture in
`services/api/src/trade/perpl-enroll-format.spec.ts`.

### The formats, now pinned (`perpl-enroll-format.ts`)

| Field                  | Live value                                                                             | Before P5 the server accepted     |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| `scope`                | the **effective** mask: `"3"` for a trade request (trade implies read), `"1"` for read | the requested mask, `"2"` / `"1"` |
| `publicKey`            | the 32 bytes as **unpadded base64url** (43 chars), not the `0x` hex sent               | hex, base64 or base64url          |
| `expiresAt`            | `"0"`                                                                                  | `""` or `"0"`                     |
| `builderId`            | `"0"`                                                                                  | `""` only                         |
| `maxBuilderFeePer100K` | `"0"`                                                                                  | `""` or `"0"`                     |
| `ipCidrs`, `origin`    | `""`                                                                                   | `""`                              |
| `time`                 | milliseconds as a hex string                                                           | unchanged                         |
| `types`                | the 5-field domain and the 11-field struct of `PERPL_API_KEY_TYPED_DATA`               | unchanged; no drift               |

Two of the old guesses (`scope`, `builderId`) refused every real payload, so
`POST /trade/perpl/enroll/prepare` answered 502 `perpl_format_changed` until
they were pinned. Each field now accepts exactly the recorded spelling.

### Perpl voids a payload older than its last enrollment

With the formats fixed, `/trade/perpl/enroll/commit` still failed: the read key
enrolled, then the trade key got a bare `400 Bad Request` — the same answer as a
bad wallet signature. It was not the signature (`sigcheck`: Privy's 65-byte
signature from the delegated wallet recovers to the wallet) and not the trade
scope (a random trade-scoped key enrolled directly). It was the order:
`prepare` fetched trade then read, and `commit` submitted read then trade.
`supersede` isolated it with two read payloads A then B: submitted A, B both
enrolled; submitted B, A → A refused with 400. `prepare` now fetches read
first, so the order Perpl serves is the order `commit` submits; the service spec
enforces the rule in its fake Perpl.

### Enrollment, read key, orders

| Check                                                                                                                                                               | Result                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/trade/perpl/enroll/prepare` + `commit`: the phone's HKDF trade key and the server's read key, one device signature each, PoP over the phone's own `hashTypedData` | enrolled; `readKey: linked`; `/portfolio` Perpl section `ok` through the server's read key                                                        |
| A read-scoped key of the harness's own: `positions` over the WebSocket                                                                                              | `[]`, signed in                                                                                                                                   |
| The same read key places a market order                                                                                                                             | **refused**: `403 api key lacks trade scope`                                                                                                      |
| The trade key, `createPerplTrader` from Node (no `Origin` header): 2x market buy 0.0005 BTC-PERP, 1% max slippage                                                   | filled at 82,947.4, tx `0xe0889756ce513021e4316be1b56d1c08e6b47f7cda52a2466d1d1586d192563d`; position long 0.0005, isolated 2x, margin 20.74 AUSD |
| `closePosition`, 1% max slippage                                                                                                                                    | filled at 82,924.7 reduce-only, tx `0x8292aaeba455b05f0387792f02ce75a6b2b452234ecb1ac06d486d9c25e0d8a5`; positions `[]`                           |

Direct works from Node, where no `Origin` is sent. The browser path (Origin
`https://sente.lol`, refused with 403 on the socket) needs the proxy, SEN-175,
and was not tested here.

Key slots: account 1028 now holds 9 of Perpl's 16 (three server read keys from
three `commit` attempts, the trade key, one harness read key and four
diagnostic keys from `supersede`). The server's read key was in memory only and
lost on restart; SEN-174 now persists it, sealed, in `user-venue-secrets.json`.

The phone's verifier (`PERPL_ENROLL_PINNED` in
`apps/mobile/src/trade/verifyPerpl.ts`) follows the same pins: scope `"3"` for
the trade key and `"1"` for the read key, `builderId`, `expiresAt` and
`maxBuilderFeePer100K` exactly `"0"`, `ipCidrs` and `origin` exactly `""`, and
the public key only as unpadded base64url. `contract.test.ts` fails if either
side drifts from the other.

## Known gaps

- **`/trade/perpl/account` reports `forwarding: false` after an API restart**
  for an account that is already onboarded. Order forwarding is not readable
  on chain, so `TradeService.knownForwarding` believes it only from a completed
  `perpl.onboard` trade, and that evidence does not outlive the process. The
  next onboarding plans the forwarding leg again (harmless, but it costs a
  sponsored user operation and the app shows the account as half set up). A
  fix reads forwarding from Perpl through the server's read key, which SEN-174
  now persists, or persists the evidence itself. The app (SEN-104) works
  around it: `perplSetupNeeds` treats a wallet with an api-key token as set up
  whatever `forwarding` says, and for an open account without one it signs
  only `allowOrderForwarding` (`runPerplOnboard` refuses any plan that would
  approve or open again).

## In the app (SEN-104, SEN-120)

The same flow as the P5 run, from the phone's own code:

- `WalletSession.perplTradeKey(wallet)` derives the HKDF trade key from the
  device key; a web session restored after a reload derives the same one.
- `runPerplOnboard` and `runPerplEnrollment` (`trade/flow.ts`) verify before
  the first signature; the enrollment's proof of possession signs the digest
  the phone computed. The api-key token is kept per wallet in `platform/kv`
  (`trade/perplApiKeys.ts`) as well as on the server.
- `app/trade/perpl-setup.tsx` runs onboarding then enrollment as one list of
  steps; the perp ticket (`trade/PerpTicket.tsx`) places market orders bounded
  at 1% of the mark through `createAppPerplTrader`, and a perp position closes
  from its screen with `closePosition`. All of it is gated on
  `capabilities().venues.perpl` (`USER_TRADING_PERPL`); off, perp markets keep
  pointing at an agent.

## Spend

- Treasury: 60 USDC and 150 AUSD sent, plus 0.015708 MON of gas (72,000 and
  82,000 gas at 102 gwei; Monad charges the limit).
- Trading cost: 0.076758 USDC on Kuru, a few cents of AUSD on Perpl.
- Everything else is still in the throwaway user: 59.923242 USDC and 50 AUSD
  in the wallet, about 100 AUSD in Perpl account 1028.
- Privy gas credits: 12 sponsored user operations (Kuru 9, Perpl onboarding 3;
  P2's replay was deduplicated, and enrollment signs rather than sends).
