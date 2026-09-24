# infra — the sente.lol host

A single GCE box running Caddy in Docker. Its first job is the two WebAuthn
association files; since SEN-51 it also runs `services/api` behind Caddy on
`api.sente.lol`.

**The runbook is `../docs/deploy.md`.** This file is about the host and the
association files; that one is about deploying the API, the secrets, the release
APK, and rolling back. Read it before running anything here.

## Why a VM rather than static hosting

Two JSON files would be happier on Cloudflare Pages. The VM exists because
`apps/web` (landing + the Perpl analytics dashboard) and `services/api` need a
home anyway, and one box with a reverse proxy is fewer moving parts than three
hosting accounts.

## Order of operations — DNS before deploy

Caddy obtains certificates via ACME, which validates by reaching the domain
over the public internet. **It cannot get a certificate until DNS resolves.**

1. `PROJECT=… ZONE=… ./provision.sh` — static IP, firewall, instance
2. Point DNS at the printed IP — `A @`, `A www` **and `A api`** (SEN-51)
3. `dig +short sente.lol` and `dig +short api.sente.lol` until both answer
4. Fill in the placeholders in `site/.well-known/` (see below)
5. `PROJECT=… ZONE=… ./push-secrets.sh` — the API's `.env`, out of band
6. `PROJECT=… ZONE=… ./deploy.sh`

Let's Encrypt rate-limits failed authorisations — five per domain per week.
Do not loop `deploy.sh` while DNS is still propagating. `deploy.sh` now refuses
to run at all while `api.sente.lol` does not resolve to the box, for exactly this
reason (`ALLOW_NO_DNS=1` overrides it).

`SKIP_API=1 ./deploy.sh` is the pre-SEN-51 behaviour: Caddy and the site only,
for getting certificates issued before the API has secrets.

## The placeholders are deliberate — and are now filled in

**Status: both fingerprints are in `site/.well-known/assetlinks.json` (MOV-251),
and the live host is serving them** — verified 2026-09-24 with
`curl -sS https://sente.lol/.well-known/assetlinks.json`, which returns 200 with
no redirect and contains the release fingerprint `15:FA:4B:…:36:55`. (An earlier
version of this file said the host still served the placeholders; it does not.)

The keys behind them: the debug keystore is the stock one `expo prebuild` writes
to `apps/mobile/android/app/debug.keystore`; the release keystore was generated
into `apps/mobile/keystores/` (gitignored, documented in the README committed
there). Package name is `lol.sente.app`.

`deploy.sh` refuses to run while `site/.well-known/` contains `REPLACE_`. Two
values must come from elsewhere:

**Android only. iOS is out of scope**, deliberately: the `associated-domains`
entitlement needs a paid Apple Developer Program membership, and building or
device-testing an iOS app needs a Mac. Nothing in the bounties requires iOS —
Agora's wording is "a mobile application", platform unspecified.

- **`REPLACE_DEBUG_SHA256_FINGERPRINT` / `REPLACE_RELEASE_SHA256_FINGERPRINT`** —
  ```
  keytool -list -v -keystore android/app/debug.keystore \
    -alias androiddebugkey -storepass android
  ```
  **Both are required.** They differ, and shipping only the debug fingerprint
  works throughout development and fails on demo day. The keystore appears
  after `expo prebuild`; generating one costs nothing. The $25 Play Store fee
  is for publishing only — judges install the APK directly.

`deploy.sh` warns but does not block on placeholders, so the certificate can be
issued before the app exists.

## Verifying

`./verify.sh [host]` checks the two things that break passkeys silently: a
redirect on the apex, and the wrong content type on the extensionless
`apple-app-site-association`. It also fails if placeholders remain.

Verified locally before first deploy: both files return 200, zero redirects,
`application/json`.

## Cert persistence

`caddy_data` is a named volume holding the Let's Encrypt account key and
certificates. Do not replace it with a bind mount to anything ephemeral —
losing it means re-issuing and burning rate limit.
