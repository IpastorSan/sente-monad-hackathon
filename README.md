# Sente

Sente is a mobile trading app on **Monad** where you hire an AI agent to trade for
you, and the authority you hand it is a **mandate** — instruments, per-trade size,
leverage, an expiry — that is enforced by a hardware enclave the agent does not
control. You fund a wallet, write a mandate, hire an agent, and read back every
decision it made on an Agent Ledger; you can amend or revoke the mandate from your
phone at any time.

> **The key that trades can never raise its own limit.**

That is a claim about key custody, not a slogan, and this repo is mostly the work
of making it literally true. Built for the Monad Metropolis hackathon; everything
below that says "live" happened on Monad testnet (chain **10143**) on the date
given. Everything that has not happened says so, in
[Status and limits](#status-and-limits).

---

## The mechanism behind the claim

A mandate is a plain object ([`packages/mandate/src/mandate.ts`](packages/mandate/src/mandate.ts)).
`compileMandate` ([`policy.ts`](packages/mandate/src/policy.ts)) turns it into a
**Privy policy**: ALLOW rules only, because Privy is deny-by-default — a policy
with zero rules signs nothing, so revocation is "replace the rules with `[]`".

Every rule reads only fields that are verbatim or locally decodable from the
payload being signed — `ethereum_transaction.{to,value,chain_id}`,
`ethereum_calldata.<fn>.<param>` against an inline ABI, typed-data domain and
message paths, and `system.current_unix_timestamp` for the expiry. None of those
needs an RPC, which is why they can be evaluated **inside** Privy's AWS Nitro
enclave at signing time. Anything that would need chain state — notably Privy's
capital-T `Transfer` wallet-action API — is evaluated outside it, so Sente never
uses that surface and drives everything through raw `eth_signTransaction`.
The full field-by-field split is in
[`docs/privy-policy-enforcement.md`](docs/privy-policy-enforcement.md).

Then three keys, with three different powers, on the agent's Privy server wallet:

| Key                                                   | Role at Privy                                               | What it can do                              |
| ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| the agent's key (`PRIVY_AGENT_AUTH_KEY`)              | **signer only**, `override_policy_ids` = the mandate policy | ask for signatures the mandate permits      |
| the user's **device** key, derived from their passkey | **owner** of the policy _and_ of the wallet                 | rewrite or empty the mandate — nothing else |
| Sente's `PRIVY_MANDATE_OWNER_KEY`                     | owner only in `AGENT_MANDATE_OWNER=server` (dev/demo) mode  | in the default `device` mode: **nothing**   |

A Privy _signer_ cannot `PATCH` the wallet or the policy. So the trading key can
neither widen the mandate nor detach it — verified live, not reasoned about:
[`scripts/sen31-signer-probe.ts`](services/api/scripts/sen31-signer-probe.ts)
tried `{policy_ids: []}`, `{owner_id: <attacker>}` and a permissive
`additional_signers` entry with the agent key and got **401 `invalid_data`** on
all three, with the wallet still refusing the not-allowed transaction afterwards.
Policy and wallet share one owner deliberately: an owner who could patch the
wallet but not the policy would simply detach the policy.

The device key is a P-256 key derived from the user's passkey PRF output under the
salt `sha256("sente.prf.v1.device")` ([`apps/mobile/src/auth/derive.ts`](apps/mobile/src/auth/derive.ts),
[`deviceKey.ts`](apps/mobile/src/auth/deviceKey.ts)). It is re-derived per session
and never stored — not on the device, and certainly not here. So Sente cannot
amend a mandate either:
[`scripts/sen43-device-owner-probe.ts`](services/api/scripts/sen43-device-owner-probe.ts)
showed `PRIVY_MANDATE_OWNER_KEY` getting **401** on both the policy and the wallet
while the device key got **200**. Amend and revoke are a prepare/commit pair
(`POST /agents/:id/mandate/prepare` → `PATCH /agents/:id/mandate`) in which the
phone **recompiles the mandate itself** and compares the rules against what the
server proposed before it signs ([`apps/mobile/src/agents/approval.ts`](apps/mobile/src/agents/approval.ts)) —
a device key that rubber-stamps a server-composed blob would prove nothing.

One honest bound. The enclave sees transactions, so it cannot see what is not one:
Perpl order size and leverage arrive as REST calls Perpl forwards, and the size
inside a Kuru `batch` is one argument among many. Those are checked by Sente's own
pre-check first ([`packages/mandate/src/enforce.ts`](packages/mandate/src/enforce.ts)),
which is layer 1 and is removable with `AGENT_PRECHECK=off` — the demo turns it off
precisely to show the enclave refusing on its own. The enclave bounds the capital
that can reach Perpl at all; it does not bound each Perpl order. Two further
measured limits: a per-transaction cap can be split across transactions, and
Privy records rolling-cap aggregations _after_ signing, so a second write ~0.1 s
later overshot the cap (the same write 5 s later was refused) — hence
`AGENT_WRITE_SPACING_MS`. Never claim an exact cumulative cap or instant
revocation.

---

## Architecture

```
apps/mobile         Expo + expo-router, React Native. A DEV CLIENT, not Expo Go:
                    react-native-passkey and Skia are native modules.
                    src/auth/      passkey → wallet key + device key (Mera, PRF)
                    src/agents/    hire, mandate form, approval, Agent Ledger
services/api        NestJS. auth, wallet, agents, venues, credits, gas, chain,
                    leaderboard, and an MCP endpoint so you can bring your own agent.
packages/mandate    the mandate type, the Privy policy compiler, the pre-check
packages/venues     one `Venue` interface; ./kuru (spot) and ./perpl (perps) adapters
services/indexer    Envio HyperIndex over Kuru + Perpl fills. Deliberately NOT a
                    pnpm workspace member (it vendors its own toolchain).
infra               Caddy serving sente.lol and the WebAuthn association files
```

`packages/venues` is the piece worth opening first if you came for the trading.
[`src/venue.ts`](packages/venues/src/venue.ts) is the whole contract: reads
(`getMarkets`, `getDepth`, `getKlines`, `quote`, `getOpenOrders`, `getBalances`)
never sign; writes (`placeLimit`, `placeMarket`, `cancel`) are the only methods
that do, one user intent each so every one is individually authorizable. Strategies
and agent tools are written against that interface, so a mandate routes to either
venue without the strategy knowing which.

The two venues have **different account owners, on purpose**. Perpl's API-key
enrollment is `ecrecover`-only — an ERC-1271 signature from a smart account gets
the same `400` as garbage, proven on chain — so the passkey EOA owns the Perpl
account. Kuru Spot V2 accepts a contract caller, so there a smart account is the
`AccountCore` root and deposit → order is one atomic ERC-7579 batch. Each is the
only arrangement that works for its venue.

API surface, all of it behind a session bearer token except `/health`:

```
POST /auth/challenge · POST /auth/session          sign a nonce, get a token
POST /wallet/register · GET /wallet                the user's device-owned Privy wallet
GET  /agents · POST /agents · GET /agents/:id      hire and read
GET  /agents/:id/events                            the Agent Ledger feed
POST /agents/:id/mandate/prepare · PATCH .../mandate
POST /agents/:id/revoke/prepare   · POST .../revoke
POST /agents/:id/run · POST /agents/:id/fork
GET  /leaderboard · GET /venues · GET /chain/blocks/:n/consensus
POST /credits/provision · POST /gas/drip · /mcp
```

---

## Run it

Node 26 and pnpm 12 are pinned in `mise.toml`. **Every node/pnpm command goes
through `mise exec --`** from the repo root, or you get whatever the ambient shims
resolve to.

```bash
mise install
mise exec -- pnpm install            # nodeLinker: hoisted — Metro needs it
mise exec -- pnpm run build          # topological: packages before the API
mise exec -- pnpm run typecheck      # tsc --noEmit everywhere
mise exec -- pnpm run lint           # eslint everywhere, then prettier --check
mise exec -- pnpm run test           # per-package test scripts
mise exec -- pnpm run check:indexer  # services/indexer, which the workspace scripts skip
```

Then copy [`.env.example`](.env.example) to `.env` at the repo root and fill in
what you have. It is long because it is the honest list, and each block says what
happens when you leave it blank — **every integration degrades to a named
`*_unconfigured` answer rather than a crash or an invented number.** With an empty
`.env` the API still boots, and `GET /health` returns `{"status":"ok"}`.

```bash
mise exec -- pnpm --filter @sente/api run start:dev     # :3000
mise exec -- pnpm --filter @sente/mobile run start      # Metro, for the dev client
```

The app needs a **custom dev client**, not Expo Go, and it is Android-only (iOS
needs a paid Apple account and a Mac; neither exists here). Building it:

```bash
cd apps/mobile
mise exec -- pnpm exec expo prebuild --platform android --clean
cd android && mise exec -- ./gradlew assembleDebug       # ~4 min
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Two things that will bite you if you skip [`CLAUDE.md`](CLAUDE.md): `android/` is
a generated artifact and is gitignored (put native changes in `app.json` config
plugins), and **every new native dependency invalidates the APK already on the
device** — Metro happily serves new JS to an old binary, which then throws at the
first call into the missing module.

Probes and live scripts, each of which prints what it did and needs the matching
key in `.env`:

```bash
mise exec -- pnpm --filter @sente/api run demo:refusal            # the five-act demo
mise exec -- pnpm --filter @sente/api run probe:privy             # policy enforcement, live
mise exec -- pnpm --filter @sente/api run probe:device-owner      # who can amend a mandate
mise exec -- pnpm --filter @sente/api run probe:privy-sponsor     # sponsored send from a 0-MON wallet
mise exec -- pnpm --filter @sente/api run agent:venues-live       # Kuru + Perpl from an agent wallet
mise exec -- pnpm --filter @sente/api run agent:run-live          # a model drives the gated tools
mise exec -- pnpm --filter @sente/api run erc8004:live            # identity + reputation registries
mise exec -- pnpm --filter @sente/venues run kuru:live
mise exec -- pnpm --filter @sente/venues run live:perpl
```

---

## What is verified live on Monad testnet

Transaction hashes and addresses in this repo are **not** redacted — they are
public on 10143 and they are the evidence. Privy object ids **are** placeholders:
they are internal identifiers of a shared app and prove nothing to a reader.

**The refusal, end to end.** An agent tries to exceed its mandate, the enclave
refuses to sign, Sente's pre-check refuses the same thing before Privy is even
asked, the owner — and only the owner — raises the cap, and the identical deposit
then lands. 2026-09-11, **all 24 checks passed**; re-run 2026-09-13 with
`anthropic/claude-sonnet-5` actually deciding, **all 23 checks passed**. Full
transcripts committed: [`docs/demo-refusal.output.txt`](docs/demo-refusal.output.txt),
[`docs/demo-refusal.model.output.txt`](docs/demo-refusal.model.output.txt). The
deposit that landed after the owner's amend, in the model-driven run:
`0xa77c32edf6f56c56ef0b8cc5cb4c04bc8996945d91602aafdbce81a96c7e4123`. The enclave
started honouring the raised cap 892 ms after the PATCH returned.

**The trading key cannot widen its own mandate** (2026-09-13). Agent-key `PATCH`
of `policy_ids`, `owner_id` and `additional_signers`: 401, 401, 401. The owner's
`PATCH` of the same policy: 200. Two live wallets were migrated to that shape and
the demo re-passed 24/24.
[`docs/privy-policy-enforcement.md`](docs/privy-policy-enforcement.md).

**Nor can Sente** (2026-09-18). Server mandate key on a device-owned agent: 401 on
the policy, 401 on the wallet. Device key: 200. Phone-signed amend and revoke:
amend 200, replay 404, wrong key 403, revoke 200 with `"rules": []` read straight
back out of Privy.

**Kuru spot, from an agent's Privy wallet** (2026-09-11). Over-cap deposit refused
with nonce unchanged and nothing sent; then `approve`
`0xb716556681863c8843b6bd41b60368a94221f58bd6e0b16faaaaee15c433342b`, `deposit`
`0x90a5453e5f8642a7a5c1b78f2b7d6deb18b74934ba6ceec03c1b9214c3fe5a40` registering
AccountCore id **64**, a resting GTC order `0:3918`, and a cancel. Earlier the same
flow landed as a single **ERC-7579 UserOperation** — userOp
`0x1c46d2646aeecee64a4c3f0c7384431074c0e5d5ed9759f58d414847e859857a`,
`UserOperationEvent success = true`. [`docs/kuru.md`](docs/kuru.md),
[`docs/agents.md`](docs/agents.md).

**Perpl perps, from the same agent** (2026-09-11). Account **505** created and
order forwarding enabled; a POST_ONLY bid opened and cancelled; a 5x market buy of
0.001 BTC filled at 76,982.4
(`0xa5f47f261c7697b56da1d557865ee27e0dd2fcd5a782fb7f07da1b27c8a97f49`) and closed
at 76,945.5 (`0x3fe6eb6bc204e88508334ff477633106dffe70bba8e2926309f39a53e12979b0`),
zero positions afterwards. Perpl forwards orders, so the agent spent **0 MON** on
those.

**A model running the loop for real** (2026-09-13, `run-2747e22a`, 6 iterations,
33 s, $0.114): deposit
`0x484ab888f4ef1514e8058293ccce4cffc527903c0bb68dde13461ff86fd0f281`, limit order
`0xcbb45e0255bdddba10dbc37d8169c43e770cb070ec8f3718f474b153b373813b`, cancel
`0xf3a29c8f2d1bdc907ba0ff64de75a969c28a8fbe04dd5a7cf6956c4bc266a1e2`.

**Money can always come home** (SEN-15, **21/21 live**). Two recovery rules that
carry no expiry, because a rule that can only move funds toward the owner must
outlive the mandate: a Kuru `withdraw` that pays `msg.sender` and nothing else
(`0x6b12d44db57c0655e3c415596848c4e04913035ac10e5963e31755032a068c7b`), and an
ERC-20 `transfer` pinned to one recipient
(`0xc9e1cb5f383c28088f967fbf40c44c16151eb99dc6d0ab02e564a5739d25d048`). Revocation
still stops them — it empties the whole policy.

**Privy gas sponsorship** (2026-09-24). After the app's dashboard gas-sponsorship
step, `probe:privy-sponsor` re-ran with 13 checks and a **sponsored ERC-20 transfer
landed from a wallet holding 0 MON**, in 587 ms; the same send with `sponsor`
omitted still fails for insufficient gas, so sponsorship is demonstrably doing the
work. Two things the probe answered that are worth knowing before you build on it:
the response carries a **user-operation hash, not a transaction hash**, and the
wallet afterwards carries an **EIP-7702 delegation** (`eth_getCode` went from `0x`
to a delegation designator) while keeping its address. A second sponsored send
fired immediately after the first was refused `transaction_broadcast_failure` and
that is unresolved. Note that
[`docs/privy-sponsorship.md`](docs/privy-sponsorship.md) and
[`docs/user-wallet.md`](docs/user-wallet.md) were written on 2026-09-18, before the
dashboard step, and still describe sponsorship as off; every other check in them
stands.

**Monad's own behaviour, measured because it changes how you write code.** Blocks
are 300 ms and the consensus states are reachable over plain RPC: watching 5 blocks
gave Voted at +205–297 ms, Finalized at +495–593 ms, Verified at +891–1108 ms —
and 2 of those 5 reorged, which is why the app shows the ramp rather than a tick.
Monad charges on the gas **limit**, not gas used, so every limit in this repo is a
measured number (`AccountCore.withdraw` 150,407; a USDC `transfer` 46,525; a MON
transfer into a deployed smart account 40,995 — 21,000 reverts). And an account
under Monad's 10 MON reserve can only send again after ~3 blocks, so every gas drip
goes through a reserve-aware dispatcher. [`docs/monad-testnet-assets.md`](docs/monad-testnet-assets.md),
[`CLAUDE.md`](CLAUDE.md) gotchas 4 and 12.

**Checks at this commit.** Root `typecheck`, `lint` (eslint plus `prettier --check`),
`build` and `test` all pass — 701 API, 167 mobile, 80 `@sente/venues`, 46
`@sente/mandate` — and `check:indexer` runs the Envio indexer's own 42 tests from a
clean `npm ci`. The Android bundle exports and the debug dev-client APK builds; see
the caveat below about what that does and does not prove.

---

## Bounty integrations

| Track                      | What is actually built                                                                                                                                                        | State                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Privy**                  | Four features, not one: server wallets, the policy engine as the mandate, key quorums for the owner/signer split, and native gas sponsorship                                  | Enforcement, ownership and sponsorship all verified live; sponsorship is not yet wired into the app                                                                                                    |
| **Mera — One Passkey**     | One passkey, two namespaced PRF salts, two independent keys: a secp256k1 wallet key and a P-256 **capability** key that owns the user's wallet and every agent mandate policy | Derivation, namespacing and "nothing is persisted" are pinned by tests; no cross-device test has been run                                                                                              |
| **Agora — mobile trading** | Passkey sign-in, an AUSD balance leading the home screen, and perps executed on Perpl                                                                                         | API and app code done; the screen has never been seen on a physical phone, and the live Perpl fills were an agent's, not a user tap                                                                    |
| **Kuru — spot**            | `@sente/venues/kuru`: Spot V2 `AccountCore` + `OrderBook.batch`, atomic deposit-and-place as one ERC-7579 batch, recipient-pinned withdraw                                    | Real settlement on 10143, hashes above                                                                                                                                                                 |
| **Perpl — API**            | `@sente/venues/perpl`: onboarding, Ed25519 API-key enrollment, POST_ONLY and market orders, leverage, close                                                                   | A 5x position opened and closed by an autonomous agent                                                                                                                                                 |
| **Envio — HyperIndex**     | `services/indexer`: packed-calldata decoders, per-account stats, VWAP, account-id → address contract reads, feeding `GET /leaderboard`                                        | 42 tests, both venues replayed against real chain blocks with the real handlers; **not deployed** — no `ENVIO_API_TOKEN`                                                                               |
| **ERC-8004**               | Identity minted on hire, each settled verdict written to the Reputation Registry as realised PnL in basis points; registrar and reviewer are deliberately different EOAs      | Registries read live (Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`), gas measured against the real calldata; **no transaction sent** |
| **Nansen**                 | `smart_money_signals` as a gated agent **read** tool plus a per-run snapshot, cached because the free plan is small                                                           | Built and specced; no key, and Nansen covers Monad **mainnet** only                                                                                                                                    |
| **OpenRouter / Kimi**      | Credits _are_ OpenRouter keys: one per user with a hard monthly USD limit. Two allowlisted models, `moonshotai/kimi-k2.6` and `anthropic/claude-sonnet-5`                     | Tool round trips verified live for both; per-user minting needs a management key, so it runs in shared-key dev mode                                                                                    |

Not claimed: **Alchemy**. Privy's paymaster happens to report
`sponsorship_provider: alchemy`, but that is Privy's plumbing, not an integration
of ours, and nothing here calls an Alchemy service.

---

## Status and limits

Read this section before the demo video.

- **Nothing has been verified on a physical phone.** A green `expo export` and a
  green `gradlew assembleDebug` prove the bundle builds, not that it runs on
  Hermes. The passkey ceremony, the two biometric prompts, the PRF output and the
  "clear app storage, sign in, same address" check are all still pending on a real
  device.
- **Gas sponsorship is proven in a probe, not in the product.** Funding an agent
  from the app still goes through the older Kernel smart account, which pays its
  own gas and lives at a different address from the Privy wallet the home screen
  shows. Unifying that is the next piece of work, not a finished one.
- **Return-to-owner is proven at the enclave and absent from the product.** The two
  recovery rules work live (21/21), but nothing in the app or the API sets
  `returnTo` yet and there is no "send it back" button.
- **Five unset credentials each degrade a feature to a named "unconfigured"
  answer**, and four of them gate integrations above: the Envio API token and
  GraphQL URL (the leaderboard has no live indexed data), the two ERC-8004 EOAs
  (no agent is ever registered on chain), the Nansen key, and the OpenRouter
  management key (credits run in shared-key dev mode, which refuses to boot under
  `NODE_ENV=production`). Nothing invents a number to fill the gap.
- **Most state is in memory.** Only the user-wallet registry and the agent store
  persist, and only when `STATE_DIR` is set. The agent event log, theses, verdicts,
  the gas ledger and venue credentials do not survive an API restart — so the
  Agent Ledger and the leaderboard are per-process today.
- **`AGENT_PRECHECK=off` and `AGENT_MANDATE_OWNER=server` are demo switches.** The
  first removes layer 1 so the enclave can be seen refusing alone; the second
  restores the weaker pre-Phase-3 ownership so the scripted demo can act as the
  owner. Both refuse to boot under `NODE_ENV=production`, and the demo says which
  it is using.
- **The enclave does not bound every Perpl order.** It bounds the capital that
  reaches Perpl. Per-order size and leverage are layer 1.
- **Rolling caps are not real-time and revocation is not instant.** Measured, not
  assumed: aggregation values are recorded after signing, and a PATCH took 336 ms
  to ~1.4 s to propagate.
- **Testnet only, Android only.** iOS is out of scope. There is no rate limit on
  `POST /auth/challenge` yet.
- **Test vectors use published keys.** Anvil/Hardhat defaults appear in tests and
  two live scripts, on purpose. Anything derived from them is controllable by
  anyone — never send it something of value.

Every one of these is tracked, and the docs that record the measurements are
indexed in [`docs/README.md`](docs/README.md). [`CLAUDE.md`](CLAUDE.md) is the
toolchain, the permanent values (`rpId: sente.lol` is an input to every user's
wallet address and can never change) and thirteen gotchas that cost real time to
find.
