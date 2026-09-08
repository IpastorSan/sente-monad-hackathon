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
packages/venues    Shared `Venue` interface + order/fill/depth types. Types only, no adapters.
```

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

### 5. Dev build, not Expo Go

`react-native-passkeys` and other native modules land in later issues, so `apps/mobile` targets a
custom dev client. `expo prebuild` and EAS builds are a **manual human step** — `ios/` and
`android/` are gitignored and need a device toolchain. Do not run `expo prebuild` from an agent.

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

---

## Conventions

- Strict TypeScript everywhere; every package extends `tsconfig.base.json`.
- ESLint flat config lives at the repo root; each package's `eslint.config.mjs` re-exports it.
- Prettier: single quotes, semicolons, trailing commas, 100 columns.
- Branch names: `{type}/{issue-id}-{short-description}`, e.g. `feat/MOV-251-privy-auth`.
- Secrets: see `.env.example`. `EXPO_PUBLIC_*` is compiled into the app bundle and is therefore
  public by construction — private keys and app secrets are server-side only.
