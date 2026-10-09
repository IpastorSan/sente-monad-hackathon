# Sente

Sente is a trading app on **Monad**, for Android and the desktop web, where you
hire an AI agent to trade for you, and the authority you hand it is a
**mandate** — venues and markets, per-transaction size, leverage, an expiry —
enforced by a hardware enclave the agent does not control. You sign in with a
passkey, get a wallet only your device can move money from, write a mandate,
hire an agent, and read back every decision it made on an Agent Ledger; you can
amend or revoke the mandate at any time. You can also trade Kuru spot and Perpl
perps yourself from the same wallet.

> **The key that trades can never raise its own limit.**

That is a claim about key custody, not a slogan, and this repo is mostly the work
of making it literally true. Built for the Monad Metropolis hackathon; everything
below that says "live" happened on Monad testnet (chain **10143**) on the date
given. Everything that has not happened says so, in
[Status and limits](#status-and-limits).

## Try it

- **Web app: <https://sente.lol>**, in **Google Chrome** on a desktop or laptop,
  with the passkey saved to **Google Password Manager**. Chromium has no Google
  Password Manager passkeys, and the Bitwarden extension takes over the prompt
  without the PRF extension the wallet is derived from (pick "Use your device"
  in its popup). Other providers are not measured
  ([`docs/web.md`](docs/web.md#provider-matrix)).
- **Android APK: <https://sente.lol/download/sente.apk>** (Android 9 or later,
  sideloading allowed). Same domain and same derivation as the web app.
- **How it works: <https://sente.lol/how-it-works>**, readable without signing in.
- **Judging walkthrough: [`docs/judges.md`](docs/judges.md).**

Everything runs on Monad testnet; the tokens have no value.

## What is live

- **Passkey sign-in, no seed phrase.** One passkey, two keys derived from its PRF
  output: a secp256k1 key that identifies you to the API, and a P-256 **device
  key** that owns your wallet and your agents' mandates. Both salts ride one
  WebAuthn prompt where the provider evaluates both. On the web, a sealed,
  tab-scoped copy keeps you signed in across reloads for up to 8 hours.
- **A Privy wallet owned by your device key.** Sente's API creates it and cannot
  sign for it, which was measured live (`docs/user-wallet.md`). Privy sponsors its
  gas, so it needs no MON.
- **A starter kit.** Each new wallet is sent 250 AUSD and 100 USDC once, under a
  daily cap: enough to open a Perpl account (100 AUSD) and to clear Kuru's
  10 USDC minimum order.
- **Trading yourself.** Kuru spot (limit and market orders, cancel, withdraw)
  and Perpl perps (account setup, trade-key enrollment, market and limit orders,
  close, cancel). Sente's server plans each step; the app checks every one
  against what it computes itself and refuses anything it does not recognise
  **before** the device key signs ([`verifyKuru.ts`](apps/mobile/src/trade/verifyKuru.ts),
  [`verifyPerpl.ts`](apps/mobile/src/trade/verifyPerpl.ts)).
- **Agents.** Six presets (Guardian, Range Trader, Mean Reverter, Trend Rider,
  DCA Stacker, Funding Harvester) or your own prompt. Each agent gets its own
  Privy wallet under a mandate compiled to a Privy policy, and is funded while
  you hire it. **Run now** streams the run into a live terminal (tool calls,
  refusals and who refused, tokens, cost); a schedule (one minute to seven days)
  runs it unattended, and **watchers** wake a scheduled agent only when a price
  or indicator condition fires, checked without the model. Its tools read
  candles, quotes, indicators, depth, funding, balances and Nansen signals, and
  place, cancel, deposit and withdraw. Amend and revoke are signed by your
  device key; "Return funds" can only pay your own wallet, because that address
  is compiled into the policy, and it works on a revoked agent too. An MCP
  endpoint lets your own AI client drive one agent under the same checks. Any
  agent can be forked under your own mandate (its prompt only if its owner
  published it), and a Top board ranks agents from an Envio index of Kuru fills
  (not yet served by a live index, see below).
- **AI credits.** Each user gets their own OpenRouter key with a one-off 10 USD
  free tier; the Credits screen shows what each agent and run spent.
- **Profiles.** A generated avatar and name per wallet, editable on Account.
- **How it works**, an in-app page that says what is enforced where and what is
  not proven yet ([`content.ts`](apps/mobile/src/howItWorks/content.ts)).

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
and never stored in plaintext — on the web a sealed, tab-scoped copy survives a reload
([`docs/web.md`](docs/web.md#staying-signed-in-across-a-reload)) — and never on the
server. So Sente cannot
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
apps/mobile         Expo + expo-router, React Native, for Android and (exported) the
                    web app at sente.lol. On Android a DEV CLIENT or the release APK,
                    not Expo Go: react-native-passkey and Skia are native modules.
                    src/auth/      passkey → wallet key + device key (Mera, PRF)
                    src/trade/     tickets, and the verifiers that gate every signature
                    src/agents/    hire, mandate form, approval, Ledger, run terminal
services/api        NestJS. auth, wallet, trade, markets, agents (runner, scheduler,
                    watchers), credits, gas, starter kit, profile, leaderboard, and
                    an MCP endpoint so you can bring your own agent.
packages/mandate    the mandate type, the Privy policy compiler, the pre-check
packages/venues     one `Venue` interface; ./kuru (spot) and ./perpl (perps) adapters
packages/presets    the six preset strategies the app hires from
services/indexer    Envio HyperIndex over Kuru fills (Perpl's volume does not fit
                    Envio's event cap). Deliberately NOT a pnpm workspace member
                    (it vendors its own toolchain).
infra               Caddy (sente.lol, api.sente.lol, the Perpl relay, the APK),
                    deploy, and the post-deploy live checks
```

`packages/venues` is the piece worth opening first if you came for the trading.
[`src/venue.ts`](packages/venues/src/venue.ts) is the whole contract: reads
(`getMarkets`, `getDepth`, `getKlines`, `quote`, `getOpenOrders`, `getBalances`)
never sign; writes (`placeLimit`, `placeMarket`, `cancel`) are the only methods
that do, one user intent each so every one is individually authorizable. Strategies
and agent tools are written against that interface, so a mandate routes to either
venue without the strategy knowing which.

**One Privy wallet owns the account on both venues.** Perpl's API-key
enrollment is `ecrecover`-only — an ERC-1271 signature from a smart account gets
the same `400` as garbage, proven on chain — and a Privy wallet signs with plain
ECDSA, even after its EIP-7702 delegation. So the user's device-owned wallet (or
an agent's own wallet) opens the Perpl account, enrolls its keys and is the Kuru
`AccountCore` root. An earlier Kernel smart account is no longer on any trade
path; its routes remain until they are removed (SEN-45).

API surface, all of it behind a session bearer token except `/health`, `/auth`,
`/presets`, `/mcp` (its own per-agent token) and the Alchemy webhook (its own
signature):

```
POST /auth/challenge · POST /auth/session          sign a nonce, get a token
POST /wallet/register · GET /wallet                the user's device-owned Privy wallet
POST /wallet/send/prepare · .../send/execute       a sponsored send the phone signs
GET  /trade/capabilities · POST /trade/prepare     the user's own trades:
POST /trade/:id/commit · GET /trade/:id            planned here, verified and signed on the phone
POST /trade/perpl/enroll/prepare · .../commit      Perpl trade-key enrollment
GET  /markets · /markets/tickers · .../depth · .../klines · .../quote
GET  /portfolio · /portfolio/fills · /portfolio/history
GET  /agents · POST /agents · GET /agents/:id      hire and read
GET  /agents/:id/events · /agents/:id/runs         the Agent Ledger and run transcripts
POST /agents/:id/mandate/prepare · PATCH .../mandate
POST /agents/:id/revoke/prepare   · POST .../revoke · POST .../return
POST /agents/:id/run · PATCH .../schedule · PUT .../watchers · POST .../fork
GET  /presets · GET /leaderboard · GET /chain/blocks/:n/consensus
GET  /credits · POST /credits/provision · GET/PATCH /profile · POST /gas/drip
GET  /creators/me/fees                             what forks of your agents owe you
/mcp                                               bring your own agent
```

---

## Business model

**Sente earns on spot volume, through Kuru's builder fee: every Kuru order Sente
composes — yours and your agents' — pays Sente 0.10% (10 bps) of its notional**,
on top of Kuru's own fee, into the treasury. **Perpl trades carry no Sente fee.**

- **Bounded on both signing paths.** Your phone signs a fee only to the builder and
  rate the app was built with, and approves it for at most a year. An agent can
  approve only Sente's builder, at no more than 10 bps and never past its mandate,
  because that is the one approval rule its enclave policy holds; Kuru refuses an
  order to any builder the account did not approve.
- **Creators share it.** When someone forks your published agent, 3 of the 10 bps
  (0.03%) on each of that fork's Kuru fills are owed to you. Sente records them as
  they happen and pays them from the treasury periodically
  (`GET /creators/me/fees`, `docs/agents.md`).
- **Shown before you confirm.** A prepared Kuru trade carries the fee and its
  estimate ("Sente fee 0.10%, ≈ 0.02 USDC"), and a completed one what was actually
  charged.
- **AI is the user's own cost.** Agent runs are billed to the user's own
  OpenRouter key. Sente pays a one-off 10 USD free tier per user; paid credit
  packs are built behind `CREDITS_PURCHASES_ENABLED` and are off: no payment is
  implemented ([`docs/openrouter.md`](docs/openrouter.md)).

The fee is off unless `KURU_BUILDER_ADDRESS` is set; the details are in
`docs/kuru.md` ("Builder fee"), `docs/user-trading.md` and
`docs/privy-policy-enforcement.md`.

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

The web build is `mise exec -- pnpm --filter @sente/mobile run export:web -- --clear`
(`--clear`, because Metro's cache can keep an earlier build's API URL; see
`CLAUDE.md`). It renders anywhere, but a passkey
ceremony only completes on `https://sente.lol` or a subdomain, because `sente.lol`
is the rpId (`docs/web.md`).

On Android the app needs a **custom dev client**, not Expo Go (iOS needs a paid
Apple account and a Mac; neither exists here). Building it:

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

### Tests and live checks

`pnpm run test` runs every package's unit suite. The suites
that carry the security claims are cross-checks rather than mocks:
`apps/mobile/src/trade/contract.test.ts` runs the server's real trade planners
against the phone's real verifiers, and
`services/api/src/agents/demo/policy.property.spec.ts` checks the policy compiler
against a model of the enclave with generated mandates and calls. [`docs/testing/test-audit-2026-10-09.md`](docs/testing/test-audit-2026-10-09.md)
is the latest audit of every tier, including what the unit tests cannot catch:
an external service changing under a pinned constant.

Two read-only checks run against the live services, after every deploy:

```bash
mise exec -- pnpm run drift:check   # every pinned Kuru/Perpl/OpenRouter/Envio value vs the live service
infra/live-check.sh [--box]         # PASS/FAIL per line: health, smoke sign-in, markets, tickers,
                                    # drift, leaderboard, trading flags; --box adds the box's own view
```

Browser and e2e tests never touch production: they refuse an API under
`sente.lol` before launching anything (`CLAUDE.md`, "Tests never touch
production").

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
(`0xc9e1cb5f383c28088f967fbf40c44c16151eb99dc6d0ab02e564a5739d25d048`). Since
SEN-17 a revoke replaces the policy with exactly these two rules
(`compileRevocationRules`), so a revoked agent's funds can still come home.

**Privy gas sponsorship** (2026-09-24). After the app's dashboard gas-sponsorship
step, `probe:privy-sponsor` re-ran with 13 checks and a **sponsored ERC-20 transfer
landed from a wallet holding 0 MON**, in 587 ms; the same send with `sponsor`
omitted still fails for insufficient gas, so sponsorship is demonstrably doing the
work. Two things the probe answered that are worth knowing before you build on it:
the response carries a **user-operation hash, not a transaction hash**, and the
wallet afterwards carries an **EIP-7702 delegation** (`eth_getCode` went from `0x`
to a delegation designator) while keeping its address. A second sponsored send
fired immediately after the first was refused `transaction_broadcast_failure`:
SEN-42 traced it to the first send's EIP-7702 delegation bumping the nonce, and
sends from the user's wallet are now spaced 4 s apart (`CLAUDE.md` gotcha 12).
[`docs/privy-sponsorship.md`](docs/privy-sponsorship.md),
[`docs/user-wallet.md`](docs/user-wallet.md).

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

**Checks.** On 2026-10-09 root `typecheck` and `test` passed — 1,741 API,
1,270 mobile (1 skipped), 137 `@sente/venues`, 72 `@sente/presets`, 57
`@sente/mandate` — and `check:indexer` runs the Envio indexer's own 29 tests from
a clean `npm ci`. Passing unit tests say nothing about drift in the live services;
that is what `drift:check` and `live-check.sh` are for (above).

---

## Bounty integrations

| Track                      | What is actually built                                                                                                                                                                                                                                | State                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Privy**                  | Four features, not one: server wallets, the policy engine as the mandate, key quorums for the owner/signer split, and native gas sponsorship                                                                                                          | Enforcement, ownership and sponsorship verified live; sponsored sends from the user's wallet are in the app (funding an agent, returning its funds)                                                                                                                                                                                                                                                                   |
| **Mera — One Passkey**     | One passkey, two namespaced PRF salts in one WebAuthn prompt (a committed patch to mera adds the second salt), two independent keys: a secp256k1 wallet key and a P-256 **capability** key that owns the user's wallet and every agent mandate policy | Derivation, namespacing and "nothing is persisted in plaintext" are pinned by tests and passed on a physical phone; one-prompt and two-prompt paths proven byte-identical on Chrome's virtual authenticator; Chrome + Google Password Manager signed in on production; no cross-device test has been run                                                                                                              |
| **Agora — mobile trading** | Passkey sign-in, an AUSD balance leading the home screen, a Kuru spot ticket and a Perpl perp ticket (setup, market and limit orders, close) from the user's own wallet, each step verified on the device before it signs                             | Sign-in, hire and funding passed on a physical Android phone (2026-09-25); the live Perpl fills above are an agent's, under the user's mandate. The user's own Kuru trades and a perp round trip ran live through the app's trade code (2026-10-09, `docs/user-trading.md`), not yet through the app's screens on production                                                                                          |
| **Kuru — spot**            | `@sente/venues/kuru`: Spot V2 `AccountCore` + `OrderBook.batch`, atomic deposit-and-place as one ERC-7579 batch, recipient-pinned withdraw                                                                                                            | Real settlement on 10143, hashes above                                                                                                                                                                                                                                                                                                                                                                                |
| **Perpl — API**            | `@sente/venues/perpl`: onboarding, Ed25519 API-key enrollment, POST_ONLY and market orders, leverage, close                                                                                                                                           | A 5x position opened and closed by an autonomous agent                                                                                                                                                                                                                                                                                                                                                                |
| **Envio — HyperIndex**     | `services/indexer`, Kuru Spot V2 fills: packed-calldata decoder, per-account and per-market stats with moving-average realised PnL, daily VWAP, account-id → address contract reads, feeding `GET /leaderboard`                                       | 29 tests; the handlers replayed against a real Kuru fill (2026-10-09). Kuru only since SEN-171: the first Envio Cloud deployment (2026-10-09) also indexed Perpl and hit the free plan's 100k-event cap within minutes — Perpl alone emits ~216k events an hour. The Kuru-only config is sized at ~70k events through 2026-11-08 and is not redeployed yet; Perpl on the leaderboard comes from the agents' own trail |
| **ERC-8004**               | Identity minted on hire, each settled verdict written to the Reputation Registry as realised PnL in basis points; registrar and reviewer are deliberately different EOAs                                                                              | Registries read live (Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`), gas measured against the real calldata; **no transaction sent**                                                                                                                                                                                                                |
| **Nansen**                 | `smart_money_signals` as a gated agent **read** tool plus a per-run snapshot, cached because the free plan is small                                                                                                                                   | Live against the real API; Nansen covers Monad **mainnet** only and its coverage there is near empty, so the tool answers `no_data` truthfully rather than inventing a signal                                                                                                                                                                                                                                         |
| **OpenRouter / Kimi**      | Credits _are_ OpenRouter keys: one per user, with a one-off 10 USD free tier as a hard limit OpenRouter enforces. Two allowlisted models, `moonshotai/kimi-k2.6` and `anthropic/claude-sonnet-5`                                                      | Tool round trips verified live for both models                                                                                                                                                                                                                                                                                                                                                                        |

Not claimed: **Alchemy**. Privy's paymaster happens to report
`sponsorship_provider: alchemy`, but that is Privy's plumbing, not an integration
of ours. The Alchemy Notify webhook is built (`POST /webhooks/alchemy`) and is not
claimed until a real delivery has been seen.

---

## Status and limits

- **Testnet only.** Monad testnet (chain 10143), Kuru and Perpl testnet
  deployments. Android and desktop web; iOS is out of scope. One API process on
  one server (Madrid, `europe-southwest1`), with no failover. It moved from the
  US on 2026-10-09 because Perpl testnet's trading socket refuses US addresses.
- **Kuru changed its testnet market set on 2026-10-09.** <!-- SEN-185: what
  Sente now pins, which markets the app lists, and what an agent hired before
  the change must do (amend), once the migration is merged. -->
- **Passkey providers.** Measured to work: Google Chrome on desktop with Google
  Password Manager (2026-10-09, on production: sign-in, wallet registered,
  starter kit sent). Measured not to: Chromium (no Google Password Manager
  passkeys) and the Bitwarden extension (takes over the ceremony without PRF).
  Not measured: 1Password, Chrome's profile-local passkeys, Windows Hello,
  iCloud Keychain, and signing in on the desktop through a phone's QR code.
  Google Password Manager's prompt count has not been recorded: one is expected
  when it evaluates both salts at creation.
- **Same wallet on phone and web is expected, not checked.** Same rpId, same
  salts, same derivation; nobody has yet compared the address from a passkey the
  Android app made with the one the web app derives from it.
- **Verified on a physical phone** (Xiaomi, HyperOS, Android 16, 2026-09-25):
  passkey sign-in with PRF on both salts, the same wallet after a reinstall, hire,
  sponsored funding, an agent run, a phone-signed amend and return-to-owner.
  Revoke was not tapped on the device.
- **Signed in across a reload on the web, for up to 8 hours.** Nothing is stored
  in plaintext: a reloaded tab reopens the session from a copy encrypted under a
  non-extractable browser key. Script running in the page could use that copy
  while the tab is open; closing the tab or signing out ends it
  ([`docs/web.md`](docs/web.md#staying-signed-in-across-a-reload)).
- **Manual trading.** Kuru runs 1-5 and the Perpl onboarding, enrollment and a
  2x round trip were run live on 2026-10-09 through the app's own trade code,
  driven from Node against a local API ([`docs/user-trading.md`](docs/user-trading.md)).
  The perp ticket's limit orders and cancels (SEN-179) have not been run live,
  and neither venue's ticket has a recorded run through the production web app
  yet. <!-- MEASURE: replace with the dry run's Kuru order and perp round trip
  from https://sente.lol, with tx hashes. -->
- **On the web, Perpl orders go through Sente's relay.** Perpl testnet refuses
  browser origins (its trading socket answers `sente.lol` with 403 and its API
  sends no CORS headers), so the web build reaches it through `api.sente.lol/perpl`.
  Perpl authenticates a socket once, with a sign-in frame the user's trade key
  signs, and every later order frame on it is unsigned: whoever runs the relay
  could inject orders into an open socket. It can never withdraw, which is an
  on-chain transaction the user's wallet signs. The Android app connects to Perpl
  directly. The live perp round trip above connected directly, not through the
  relay.
- **No stop-loss or take-profit orders.** Neither venue offers them on testnet.
  The Guardian preset and the other presets' stops are price lines an agent
  checks when it runs, so the price can pass a line between runs.
- **The Sente fee has not landed on chain yet.** The builder-fee legs are built,
  verified by the phone and compiled into agents' policies, and off until
  `KURU_BUILDER_ADDRESS` is set. Which side Kuru charges, in which token, and
  whether Privy matches the builder overloads are confirmed only by the first live
  taker fill (`docs/agents.md`, "Live probe").
- **Credits stop at the free tier.** A user who spends the 10 USD has no way to
  buy more on this deployment; their key stays exhausted until raised by hand.
- **Nansen has nothing to say about Monad testnet.** Nansen covers Monad mainnet
  only, and its coverage there is near empty, so the agents' tool answers
  `no_data` rather than inventing a signal.
- **ERC-8004 is built and simulated, not sent.** The registries are read live and
  the registration and feedback calldata is gas-measured against them, but the
  registrar and reviewer keys are not configured, so no agent has been registered
  on chain ([`docs/erc8004.md`](docs/erc8004.md)).
- **The leaderboard has not been answered by a live index.** The Kuru-only Envio
  config is not redeployed yet ([`docs/indexer.md`](docs/indexer.md)); Perpl
  results come from the agents' own event logs, labelled and unranked.
- **Some state is still in memory, and there is one writer.** Wallets, agents,
  event logs, run transcripts, watchers, venue keys and the rest persist under
  `STATE_DIR`; auth challenges and prepared operations do not survive a restart,
  and only one API process may hold the directory.
- **`AGENT_PRECHECK=off` and `AGENT_MANDATE_OWNER=server` are demo switches.** The
  first removes layer 1 so the enclave can be seen refusing alone; the second
  restores the weaker pre-Phase-3 ownership so the scripted demo can act as the
  owner. Both refuse to boot under `NODE_ENV=production`.
- **The enclave does not bound every Perpl order.** It bounds the capital that
  reaches Perpl. Per-order size and leverage are layer 1.
- **Rolling caps are not real-time and revocation is not instant.** Measured, not
  assumed: aggregation values are recorded after signing, and a PATCH took 336 ms
  to ~1.4 s to propagate.
- **Revoke leaves the recovery rules armed.** A revoked agent cannot trade, but
  its funds can still go back to the owner's wallet and nowhere else.
- **Test vectors use published keys.** Anvil/Hardhat defaults appear in tests and
  two live scripts, on purpose. Anything derived from them is controllable by
  anyone — never send it something of value.

Every one of these is tracked, and the docs that record the measurements are
indexed in [`docs/README.md`](docs/README.md). [`CLAUDE.md`](CLAUDE.md) is the
toolchain, the permanent values (`rpId: sente.lol` is an input to every user's
wallet address and can never change) and the gotchas that cost real time to
find.
