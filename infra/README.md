# infra — the sente.lol host

A single GCE box running Caddy in Docker. Its first job is the two WebAuthn
association files; later it is where `apps/web` and `services/api` land.

## Why a VM rather than static hosting

Two JSON files would be happier on Cloudflare Pages. The VM exists because
`apps/web` (landing + the Perpl analytics dashboard) and `services/api` need a
home anyway, and one box with a reverse proxy is fewer moving parts than three
hosting accounts.

## Order of operations — DNS before deploy

Caddy obtains certificates via ACME, which validates by reaching the domain
over the public internet. **It cannot get a certificate until DNS resolves.**

1. `PROJECT=… ZONE=… ./provision.sh` — static IP, firewall, instance
2. Point DNS at the printed IP (`A @` and `A www`)
3. `dig +short sente.lol` until it answers
4. Fill in the placeholders in `site/.well-known/` (see below)
5. `PROJECT=… ZONE=… ./deploy.sh`

Let's Encrypt rate-limits failed authorisations — five per domain per week.
Do not loop `deploy.sh` while DNS is still propagating.

## The placeholders are deliberate

`deploy.sh` refuses to run while `site/.well-known/` contains `REPLACE_`. Two
values must come from elsewhere:

- **`REPLACE_APPLE_TEAM_ID`** — from the Apple Developer portal. Requires a paid
  Apple Developer account; there is no way around it for passkeys on a real
  device.
- **`REPLACE_DEBUG_SHA256_FINGERPRINT` / `REPLACE_RELEASE_SHA256_FINGERPRINT`** —
  ```
  keytool -list -v -keystore android/app/debug.keystore \
    -alias androiddebugkey -storepass android
  ```
  **Both are required.** They differ, and shipping only the debug fingerprint
  works throughout development and fails on demo day.

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
