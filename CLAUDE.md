# Sente

Sente is a mobile trading app on **Monad** where users hire **AI agents** to trade on their
behalf, and the authority of each agent is bounded by an **enclave-enforced mandate** — a signed
policy (instruments, size, leverage, drawdown, time window) that the execution enclave checks
before it will sign anything, so an agent physically cannot exceed the mandate its owner granted,
however it is prompted. Users fund a smart account, write a mandate, hire an agent, and watch it
work; they can revoke or amend the mandate at any time. Venue coverage is **Kuru for spot** and
**Perpl for perps**, behind one shared `Venue` interface so strategies are written once and the
adapter decides where the order lands.

---

## Toolchain — mise

Node and pnpm are pinned in `mise.toml` (node 26, pnpm 12). **Run every node/pnpm/npx command
through `mise exec --` from inside this repo**, or you get whatever the ambient shims resolve to:

```bash
mise exec -- pnpm install
mise exec -- pnpm run typecheck
mise exec -- node scripts/whatever.ts
```

Never modify mise config outside this repo (`~/Work/.mise.toml` in particular).

## Workspace layout

pnpm workspaces. Globs are in `pnpm-workspace.yaml` (`apps/*`, `services/*`, `packages/*`).

```
apps/mobile        Expo / React Native, expo-router. DEV BUILD, not Expo Go.
services/api       NestJS. Auth, wallet, venues, agents, credits, gas.
packages/venues    Venue interface + Kuru (./kuru) and Perpl (./perpl) adapters
```

`apps/mobile/src/auth/` is the passkey wallet, and the split inside it is deliberate:

```
derive.ts          PRF bytes -> BIP-39 -> BIP-44 -> secp256k1. No RN, no mera imports,
                   so `derive.test.ts` runs under plain node with no device.
mera.ts            The WebAuthn ceremonies and the WalletSession lifetime.
credentialStore.ts expo-secure-store. Holds only sign-in HINTS, never key material.
useAccount.ts      React binding; owns exactly one live session and ends it.
```

Mera is a **client-side TS library, not a smart-account system**, and it does not touch Monad's
P256 precompile. The account it produces is an ordinary secp256k1 EOA with no seed phrase, because
the key is re-derived from the passkey every session rather than stored. Nothing about it is
on-chain or server-side.

`@sente/venues` is consumed by both `apps/mobile` and `services/api`. Its `types` entry points at
`src/index.ts`, so typecheck works without a build; its runtime entry points at `dist/`, so it must
be built before the API runs or the app bundles (`pnpm run build` handles the ordering).

## Commands

All from the repo root:

```bash
mise exec -- pnpm install          # clean install
mise exec -- pnpm run typecheck    # tsc --noEmit across every package
mise exec -- pnpm run lint         # eslint across every package
mise exec -- pnpm run build        # topological build (venues -> api)
mise exec -- pnpm run test         # per-package test scripts
mise exec -- pnpm run format       # prettier --write .
```

Per package: `mise exec -- pnpm --filter @sente/api run start:dev`,
`mise exec -- pnpm --filter @sente/mobile run start`, etc.

`GET /health` on the API returns `{"status":"ok"}` — the cheapest way to confirm the API is up.

---

## Permanent, unchangeable values

### rpId: `sente.lol`

The WebAuthn relying-party ID is **`sente.lol`** (the apex, not a subdomain). This can never
change.

It is not just an auth setting. Mera derives the user's wallet from
`PRF(credential, rpId, salt)` → BIP-39 entropy → BIP-44 key → address. **The rpId is an input to
every user's wallet address.** Change it and the same passkey on the same device derives a
different key: accounts are not migrated, they become unreachable, and every secret vault
encrypted under a PRF-derived key becomes undecryptable.

The apex was chosen because a passkey is scoped to its rpId _and everything below it_. `sente.lol`
works from any subdomain; `accounts.sente.lol` would not work from `sente.lol`. That scope can
never be widened afterwards, so it was picked as wide as it will ever need to be.

Two things that follow:

- `https://sente.lol/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
  must return **200 with no redirect**. Apple and Google both refuse to follow one, and a
  registrar's default apex → `www` redirect fails silently with an unhelpful passkey error.
  Check with `curl -sSI https://sente.lol/.well-known/assetlinks.json`.
- `assetlinks.json` needs **both** the debug and release SHA-256 signing fingerprints. They
  differ, and shipping only debug works throughout development and breaks on demo day.

### Android package: `lol.sente.app`

Permanent for the same reason, one step removed. `assetlinks.json` associates `sente.lol` with a
`(package_name, signing fingerprint)` pair; change the package and the association breaks, so the
platform stops offering the passkey to the app, so the wallet is gone — not "the user has to log
in again".

Both fingerprints are already in `infra/site/.well-known/assetlinks.json`. The release keystore
lives in `apps/mobile/keystores/` (gitignored — see the README committed there). **Losing it is
unrecoverable and costs every user their account.**

### PRF salt namespaces: `sente.prf.v1.*`

`apps/mobile/src/auth/derive.ts` derives each key domain's salt as
`sha256("sente.prf.v1." + namespace)` — `wallet` today, `agent-memory` reserved. One passkey, many
independent keys. These strings are inputs to the derivation exactly as `rpId` is, so they are
equally permanent. Add namespaces; never rename one.

## Gotchas that will burn you

### 1. `node-linker=hoisted` in `.npmrc` is load-bearing

Metro cannot resolve pnpm's default symlinked store layout. Without a hoisted `node_modules`,
`apps/mobile` fails with "Unable to resolve module ..." for transitive dependencies that plainly
exist on disk. Do not switch this to `isolated`, and do not delete `.npmrc`.

### 2. Metro package exports must stay off

`apps/mobile/metro.config.js` sets:

```js
config.resolver.unstable_enablePackageExports = false;
```

`isows` (a viem dependency) and `zustand@4` publish `exports` maps that Metro resolves to
browser/node builds React Native cannot run. This bites essentially every RN crypto stack.

**The trap: getting this wrong does not fail the build.** Measured on this repo — `expo export
--platform android` succeeds either way, it just picks different module variants (4.6MB bundle with
the flag `false`, 5.1MB with it `true`). A green CI bundle is therefore _not_ evidence the setting
is right; the damage only shows up on device, as `undefined is not a function` from somewhere deep
inside a bundled dependency. Leave it `false` unless you have re-verified the whole dependency
graph on a real device.

**Consequence, and it is not optional:** a dependency that ships _only_ an `exports` map — no
`main`, no root `index.js` — cannot be resolved at all with the flag off. `@category-labs/mera` is
one, so `metro.config.js` aliases its three entry points (`.`, `/viem`,
`/react-native-webauthn-client`) by hand through `resolver.resolveRequest`, locating `dist/` via
`require.resolve` rather than a hard-coded path. Verified both ways: with the alias the Android
bundle succeeds and `strings` finds `PRF_UNAVAILABLE` and `createPlatformKey` in the `.hbc`;
without it, `expo export --clear` fails with `the package … specifies a 'main' module field that
could not be resolved`. Any future exports-only dependency needs the same treatment — turning the
flag back on is not the fix.

### 3. Hermes has no `crypto.getRandomValues`

`apps/mobile/src/polyfills.ts` installs it from `expo-crypto` (plus `TextEncoder`/`TextDecoder`
from `fast-text-encoding`). It is imported as the **very first line** of `apps/mobile/index.ts`,
before `expo-router/entry`. viem, account-abstraction and anything that generates a key will throw
at import time if this ordering is disturbed. Never move that import, and never add an import above
it.

### 4. Monad charges on gas _limit_, not gas used

The fee is `value + gas_bid * gas_limit`. An overestimated `gas` is money actually spent, not
merely reserved. So **set an explicit `gas` on transactions instead of relying on estimation** —
see `MONAD_TX_DEFAULTS` in `apps/mobile/src/chain/client.ts`. When a call needs its own number,
measure it and hard-code that number; do not paste an `estimateGas` result with a safety multiplier
on top.

**This gets worse under ERC-4337, because the overestimate is charged twice over.** The EntryPoint
takes the prefund at the LIMIT — `(callGasLimit + verificationGasLimit + preVerificationGas +
paymaster limits) * maxFeePerGas` — and the unused remainder does **not** come back to the account's
balance. It stays as that account's **deposit inside the EntryPoint**, recoverable only by
`EntryPoint.withdrawTo`, which only the account itself may call, which needs another UserOperation,
which costs gas again. Measured on MOV-253: a 0.25 MON account was left holding 0.0091 MON with
0.0685 MON stranded in the EntryPoint, and sweeping it back netted 0.0316 MON — the rest went to
gas. **Size the limits from a real estimate, not from a round number.**

Numbers measured against Monad testnet for a Kernel v0.3.1 account, worth reusing rather than
rediscovering:

| Field                  | Deployed account  | First op (deploys the account) |
| ---------------------- | ----------------- | ------------------------------ |
| `verificationGasLimit` | **~220,000**      | ~607,000                       |
| `callGasLimit`         | ~42,000 (2 calls) | ~107,000                       |
| `preVerificationGas`   | ~206,000          | ~480,000                       |

`verificationGasLimit` is the one that surprises: **120,000 is not enough** and fails with
`AA26 over verificationGasLimit`, which reads like a bug in the account rather than a budget.
`preVerificationGas` is large because Monad prices calldata high — it is bundler-overhead
reimbursement, so when you call `EntryPoint.handleOps` yourself you are the beneficiary and can set
it to ~21,000.

**Pimlico enforces its own `maxFeePerGas` floor**, and it is the `slow` tier from
`pimlico_getUserOperationGasPrice` — bidding below it is rejected outright
(`maxFeePerGas must be at least ...`). Since Monad charges on the reservation, bidding _above_ that
floor is pure waste. Read the floor, use it.

### 5. Dev build, not Expo Go

`react-native-passkey` (singular — see below) is a native module, so `apps/mobile` targets a custom
dev client, never Expo Go.

`android/` has been generated by `expo prebuild --platform android --clean` and is gitignored, so
it is a local artifact: regenerate it rather than hand-editing it, and put every native change in
`app.json` config plugins instead. `expo-build-properties` pins `minSdkVersion` to **28** because
`react-native-passkey` requires API 28+ and Expo SDK 57's default is 24.

**Building the APK is still a human step** — it needs an Android SDK, which this machine does not
have. `expo prebuild` itself is pure file generation and safe to run headless; `expo run:android`
and EAS builds are not.

The npm package is **`react-native-passkey`**, singular, and mera peer-depends on exactly `3.6.1`.
`react-native-passkeys` (plural) also exists on npm: its `1.0.0` is a deprecated 223-byte squat
from 2022 and its real line stops at `0.4.2`. Installing the plural one gets you a package that
does nothing.

### 5b. iOS is out of scope

No `associated-domains` entitlement (needs a paid Apple Developer account) and no Mac. `app.json`
still carries an `ios` block from the template with the old `xyz.moveseventyeight.sente` bundle id;
it is inert and deliberately untouched. If iOS is ever revived, that id and the Android package
must be reconciled and `apple-app-site-association` written.

### 6. NestJS 12 is ESM-only, but `services/api` compiles to CommonJS

`@nestjs/common`, `@nestjs/core` and `@nestjs/testing` v12 ship `"type": "module"` with no
CommonJS build. `services/api` still emits CommonJS (`nest build` defaults, and
`emitDecoratorMetadata` is happiest there); that works at runtime only because Node 22+ can
`require()` an ES module.

Jest's VM sandbox cannot, so `services/api`'s test script sets
`NODE_OPTIONS=--experimental-vm-modules`. Without it every suite dies at the first
`import { Test } from '@nestjs/testing'` with "Must use import to load ES Module". Keep the flag on
any new jest invocation. (That env-var prefix is POSIX shell syntax — it needs `cross-env` if
anyone ever runs this on Windows.)

### 7. TypeScript is pinned to `~6.0.3`

Expo SDK 57 and NestJS 12 both pin `~6.0.x`, and `typescript-eslint` supports `<6.1.0`. TypeScript
7 is released but nothing in this toolchain accepts it yet. Do not bump.

### 8. A UserOperation can fail inside a transaction that succeeded

**Never decide whether a UserOperation worked from the transaction receipt.** The bundler wraps
several UserOperations in one transaction; a UserOperation whose execution reverts is still
_included_, the EntryPoint still charges for it, and the carrying transaction still reports
`status: 0x1`. Read `eth_getUserOperationReceipt` and branch on **its** `success` field.

Observed on Monad testnet, not inferred — tx
`0x164e7b1c7d6152f7f374147a450007a1c49692129e11adcf5dc6b451d1e14ea0` carries a batch that reverted:

```
userOp success   = false   <- the UserOperation
bundle tx status = success <- the transaction carrying it
```

A confirmation view built on the transaction receipt calls that batch confirmed, and for a trading
app that means telling a user their order landed when it did not. This is exactly why
`apps/mobile/src/wallet/confirmation.ts` races the bundler's UserOperation receipt against our own
status view and lets the bundler win ties: our view can only be as fresh as its last poll, but the
bundler reports the per-operation flag. `services/api/src/wallet/confirmation/operation-tracker.ts`
sets `included` only from that flag.

The corollary, and the reason ERC-7579 `execType` is always `0x00` in
`apps/mobile/src/wallet/batch.ts`: when one leg of a batch reverts the whole batch must revert. Also
verified on chain in that same transaction — the first leg's approval did not persist. A batch that
half-applies is worse than no batching, and only a real transaction proves which one you have.

### 9. The two venues have different account owners, on purpose

**Perpl's API-key enrollment is `ecrecover`-only.** An ERC-1271 signature from the Kernel smart
account — valid on chain, its own `isValidSignature` returns `0x1626ba7e` — gets the same `400` as
garbage. A Perpl account owned by a smart account can never obtain an API key, so **the passkey EOA
owns the Perpl account**, onboarding with three plain transactions (~0.035 MON, covered by the gas
drip). **Kuru Spot V2 accepts a contract caller**, so there **the Kernel account is the AccountCore
root** and deposit → order is one atomic ERC-7579 batch. Do not "unify" these: each is the only
arrangement that works for its venue. Evidence in `docs/monad-testnet-assets.md` and `docs/kuru.md`.

### 10. The workspace packages are TS sources, and each consumer loads them differently

`@sente/mandate` and `@sente/venues` (with its `./kuru` and `./perpl` subpaths) are ESM whose
`exports` map offers three conditions: `types` → `src/`, `source` → `src/`, `default` → `dist/`.
Their sources import each other as `./x.ts`. There is no single setting that makes every consumer
happy, so each one is wired on purpose — do not "simplify" one without re-checking the others.

**`services/api` (wired in SEN-3):**

| Consumer                   | Resolves to           | Because                                                                                                                                                                           |
| -------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc` / typecheck          | `src/` via `types`    | TS 6 defaults `moduleResolution` to `bundler` even with `module: CommonJS`, so `exports` subpaths resolve. `rewriteRelativeImportExtensions` accepts the `.ts` specifiers.        |
| `nest build` → `node dist` | `dist/` via `default` | CJS `require()` of an ESM `dist/index.js` works through Node's `require(esm)` (gotcha 6). **Build the packages first**: they are API dependencies, so `pnpm run build` orders it. |
| jest                       | `src/` via `source`   | `testEnvironmentOptions.customExportConditions: ["source", …]`; ts-jest compiles them. No build needed.                                                                           |
| `scripts/*.ts` (probes)    | `src/` via `source`   | `node --conditions=source`, native type stripping.                                                                                                                                |

Two choices that look optional and are not:

- **`rewriteRelativeImportExtensions`, not `allowImportingTsExtensions`.** The latter requires
  `noEmit`, and `nest build` emits. The former accepts `.ts` specifiers _and_ rewrites them to
  `.js` in the CJS output.
- **jest uses `services/api/tsconfig.spec.json`, which turns that rewriting OFF.** Jest's resolver
  loads `./x.ts` literally; rewritten to `./x.js` it finds nothing in `packages/mandate`, and in
  `packages/venues/src` it finds stale committed `.js` twins of the sources (`kuru/adapter.js` and
  friends) and silently loads those instead.

API files that a script imports (`src/agents/privy/*`, `agents.config.ts`, `agents.errors.ts`,
`agent-wallet.provider.ts`) use `.ts` specifiers and **erasable syntax only** — no Nest decorators,
no constructor parameter properties — because node's type stripping loads them as-is. Nest wiring
stays in the module files. `customExportConditions` applies to every package jest resolves; no
installed dependency exports a `source` condition today, so re-check that if jest ever starts
loading raw TypeScript out of `node_modules`.

**`apps/mobile` is still unwired.** Metro has package exports turned off (gotcha 2), so the app
needs a `resolver.resolveRequest` alias per subpath — the same pattern already used for
`@category-labs/mera` in `metro.config.js`. The first mobile consumer has to add it.

### 11. Test vectors use publicly known keys — never fund what they derive

Unit tests and some live runs use the Anvil/Hardhat default accounts (`0xf39Fd6e5…` is #0,
`0x70997970…` is #1). Their private keys are published. The Kernel test account
`0xEC4b217240f0292c65Bf136b341e400e2D28cA6F` is owned by Anvil #1, so **anyone can control it**.
Fine for worthless testnet tokens; never send anything of value to an address derived from these
keys. On mainnet, sweeper bots drain them within a block.

---

## Conventions

- Strict TypeScript everywhere; every package extends `tsconfig.base.json`.
- ESLint flat config lives at the repo root; each package's `eslint.config.mjs` re-exports it.
- Prettier: single quotes, semicolons, trailing commas, 100 columns.
- Branch names: `{type}/{issue-id}-{short-description}`, e.g. `feat/SEN-5-agents-api`. Issues live in the
  vault tracker (`~/Documents/Moveseventyeight/003-tracker/issues/sente/`, key `SEN`); older `MOV-*` ids are Linear history.
- Secrets: see `.env.example`. `EXPO_PUBLIC_*` is compiled into the app bundle and is therefore
  public by construction — private keys and app secrets are server-side only.
