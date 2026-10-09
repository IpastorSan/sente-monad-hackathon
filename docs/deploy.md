# deploy.md

How Sente gets somewhere a stranger can use it: the API on HTTPS at
`api.sente.lol`, a release APK a judge installs without a dev client or Metro
(SEN-51), and the same app in a browser at `https://sente.lol` (SEN-168).

> **NOTHING IN THIS FILE HAS BEEN EXECUTED.** The machinery is written and, where
> it could be, verified locally — see [What has and has not
> run](#what-has-and-has-not-run) at the bottom for the exact line. Read that
> section before you trust any sentence above it.

## The shape of it

One GCE box, `sente-web`, which already exists and already holds a Let's Encrypt
certificate for `sente.lol` in a named Docker volume. Do not rebuild it: losing
`caddy_data` means re-issuing certificates and burning rate limit.

```
                       ┌──────────────────────── sente-web (e2-micro, Debian 12)
  api.sente.lol ──TLS──┤  caddy  ──http──>  api  (sente-api:<git sha>)
  sente.lol     ──TLS──┤    │                │
  www.sente.lol ──TLS──┘    ├─ /srv/site     ├── env_file /opt/sente/api.env   0600 root
                            │  (.well-known)  └── bind mount /var/lib/sente/state
                            └─ /srv/web
                               (everything else on the apex: the web app)
```

- **`sente.lol`** — load-bearing, `/.well-known/assetlinks.json`: 200, no
  redirect, or every user's passkey stops being offered to the app and their
  wallet goes with it (`../CLAUDE.md`, "Permanent, unchangeable values").
  Every other path is the web app, a single-page Expo export with a fallback to
  `index.html` — see [The web app](#the-web-app) for how the two are kept apart.
- **`api.sente.lol`** — `services/api`, reverse-proxied. Its own hostname rather
  than a path under the apex so that a proxy directive can never end up in front
  of the association files. The rpId is unaffected: a passkey scoped to
  `sente.lol` works from every name below it, so this host needs no association
  file of its own and must never be given one.
- **`/var/lib/sente/state`** — `STATE_DIR` (SEN-48). A host directory, bind
  mounted, owned by uid 1000. It holds the user-wallet registry and the agent
  store. Losing it is not "register again": the next `POST /wallet/register`
  mints a **second** Privy wallet and whatever the first one holds becomes
  unreachable from the product.
- **`/opt/sente/api.env`** — the secrets, 0600 root:root, delivered by
  `infra/push-secrets.sh`. Never committed, never in an image layer, never a
  build arg.

Files: `infra/Caddyfile`, `infra/docker-compose.yml`, `infra/deploy.sh`,
`infra/push-secrets.sh`, `infra/api-env.allowlist`, `infra/verify.sh`,
`infra/smoke.sh`, `services/api/Dockerfile`.

## Secret versus public

The rule the repo already follows: **`EXPO_PUBLIC_*` is compiled into the app
bundle and is therefore public by construction.** Everything else that is a key
is server-side only. `.env.example` is the per-variable reference; this is the
deployment view.

| Value                                                                                                     | Where it lives                           | Public?                                                                    |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `AUTH_SESSION_SECRET`                                                                                     | `/opt/sente/api.env`                     | secret                                                                     |
| `PRIVY_APP_SECRET`, `PRIVY_AGENT_AUTH_KEY`, `PRIVY_MANDATE_OWNER_KEY`                                     | `/opt/sente/api.env`                     | secret — replacing one orphans every wallet or policy it owns              |
| `GAS_DRIP_PRIVATE_KEYS`, `ERC8004_REGISTRAR_KEY`, `ERC8004_REVIEWER_KEY`                                  | `/opt/sente/api.env`                     | secret — **real testnet money, unrecoverable**                             |
| `STARTER_DRIP_PRIVATE_KEY`                                                                                | `/opt/sente/api.env`                     | secret — **real testnet money**; its own key, never a `GAS_DRIP` one       |
| `PIMLICO_BUNDLER_URL`, `ALCHEMY_RPC_URL`, `MONAD_TESTNET_RPC_URL` if keyed                                | `/opt/sente/api.env`                     | secret — the API key is a **path segment**, so the whole URL is the secret |
| `ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_NOTIFY_AUTH_TOKEN`, `OPENROUTER_MANAGEMENT_KEY`, `NANSEN_API_KEY` | `/opt/sente/api.env`                     | secret                                                                     |
| `PRIVY_APP_ID`, `ALCHEMY_NOTIFY_WEBHOOK_ID`, quorum ids                                                   | `/opt/sente/api.env`                     | not secret, useless alone                                                  |
| `SENTE_API_TAG`                                                                                           | `/opt/sente/.env`                        | public — compose interpolation only, **never put a secret here**           |
| `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_MONAD_NETWORK`, `EXPO_PUBLIC_BUNDLER_URL`                             | inside the APK and the web bundle        | **public** — inlined at bundle time                                        |
| the release keystore + `credentials.json`                                                                 | `apps/mobile/keystores/`, gitignored     | secret — **unrecoverable**, back it up off this machine                    |
| both SHA-256 signing fingerprints                                                                         | `infra/site/.well-known/assetlinks.json` | public by design                                                           |
| the Let's Encrypt account key and certificates                                                            | the `caddy_data` volume                  | secret, and irreplaceable-ish (rate limits)                                |

Three ways a secret gets out that this setup closes by shape, not by discipline:

- **an image layer** — `services/api/Dockerfile` has no `ARG` and copies no env
  file, and the root `.dockerignore` keeps `.env` and `*.keystore` out of the
  build context entirely, so no future `COPY .` can pick one up;
- **a build arg** — same; build args are recorded in image history and there are
  none;
- **a shell line / your history** — `push-secrets.sh` moves values through a
  0600 file and `scp`, never an argv, and prints key names only.

## Deploying, in order

Every step is a command you run; nothing is implicit. `PROJECT` is the GCP
project id, `ZONE` defaults to `us-central1-a`.

### 0. Prerequisites, once

- The box exists (`infra/provision.sh` made it). **Do not re-run it to "make
  sure".**
- A local `.env` at the repo root with the real values, and
  `mise exec -- pnpm install` done.
- Docker running locally. The image is built **here**, not on the box: an
  e2-micro has 1 GB of RAM and a shared vCPU, and a workspace install plus two
  `tsc` passes plus `nest build` there is somewhere between very slow and
  out-of-memory.

### 1. DNS — before anything touches Caddy

At the registrar for `sente.lol`, add the API's name pointing at the box's
external IP — the same IP `@` and `www` already use, which as of 2026-09-24 is
**35.202.26.61** (resolved publicly; `gcloud` could not be reached to confirm it
against the instance, so check it rather than trust this line):

```
A   api   35.202.26.61
```

```bash
# Authoritative: ask the instance.
gcloud compute instances describe sente-web --project "$PROJECT" --zone "$ZONE" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'

# Then wait for the record. This machine has no `dig`, hence the second form —
# `deploy.sh` falls back to it for the same reason.
dig +short api.sente.lol
getent ahostsv4 api.sente.lol | awk '{print $1}' | sort -u
```

`api.sente.lol` does not resolve today; `sente.lol` and `www.sente.lol` both
answer 35.202.26.61.

Caddy asks for a certificate for `api.sente.lol` the moment it loads the new
Caddyfile, and ACME validates over the public name. A name that does not reach
the box is a **failed authorisation**, and Let's Encrypt rate-limits those.
`deploy.sh` checks this and refuses; `ALLOW_NO_DNS=1` overrides it, and you
should have a reason.

### 2. Check the secrets without sending them anywhere

```bash
cd infra
DRY_RUN=1 ./push-secrets.sh                 # reads ../.env, prints key names only
```

It refuses outright if `AUTH_SESSION_SECRET` is missing or malformed, if
`AGENT_PRECHECK=off`, or if `AGENT_MANDATE_OWNER=server` — the same three things
the API refuses to boot on under `NODE_ENV=production`, caught where the failure
is free. It skips everything on the DENY list (`AUTH_PLACEHOLDER`,
`OPENROUTER_API_KEY`, `GAS_DRIP_DRY_RUN`, every `EXPO_PUBLIC_*`) and **names any
variable in your `.env` that is on neither list** — decide about those before
continuing rather than discovering later that one was never deployed.

One `.env` gotcha: write values **unquoted**. `dotenv` strips surrounding quotes
and Docker Compose's `env_file` parser has changed its mind about them across
versions; an unquoted value means the same thing to both.

### 3. Deliver them

```bash
PROJECT=… ZONE=… ./push-secrets.sh
```

Lands at `/opt/sente/api.env`, 0600 root:root. Not live yet — the container reads
it at `up` time.

### 4. Build, ship, start, verify

```bash
PROJECT=… ZONE=… ./deploy.sh
```

What it does: builds the web export locally into `infra/web` and refuses it if
`https://api.sente.lol` is not inlined (`SKIP_WEB=1` skips this and leaves the
box's web app alone; see [The web app](#the-web-app)) → reads the box's IP and
checks DNS → checks `/opt/sente/api.env` exists (refuses otherwise; `SKIP_API=1`
deploys only Caddy, the site and the web app) →
`docker build` locally, tagged with the git short SHA → `docker save | gzip` piped
into `docker load` over the SSH connection it already has, so there is no
registry to enable, authenticate or leak → copies `Caddyfile`,
`docker-compose.yml`, `site/` and `web/` → writes `SENTE_API_TAG` into
`/opt/sente/.env` → `install -d -m 0700 -o 1000 -g 1000 /var/lib/sente/state` →
`docker compose up -d` → `caddy reload` (an edited Caddyfile is not a compose
change, so `up -d` alone would leave Caddy on the old config) → waits for the
container's health check → `verify.sh`.

The image ship is the slow part: hundreds of megabytes up a home uplink. It is
also why the tag is the commit — `sudo docker image ls sente-api` on the box
reads as a deploy history, and a rollback is a tag (step 7).

Two things about that ordering are load-bearing:

- **`install -d -m 0700 -o 1000 -g 1000` runs before `up`.** If the bind-mount
  source does not exist, Docker creates it **as root**, and then `json-file.ts`
  gets `EACCES` at the first wallet registration — the one moment you cannot
  afford it. Creating it first, owned by the image's `node` user (uid 1000), is
  idempotent and cannot drift.
- **`environment` in the compose file outranks `env_file`** (measured, see the
  table at the bottom), so `NODE_ENV=production`, `PORT` and `STATE_DIR` cannot be
  turned off by editing `api.env`. What `api.env` _can_ still do is add a variable
  the API refuses, `AUTH_PLACEHOLDER=1` above all — and then the API fails the
  boot loudly instead of serving with no auth. Two guards, in order:
  `push-secrets.sh` never writes it, and the API would refuse it anyway.

If the API comes up unhealthy, its boot log says which variable it refused:

```bash
gcloud compute ssh sente-web --project "$PROJECT" --zone "$ZONE" \
  --command 'sudo docker logs --tail 50 sente-api'
```

### 5. Verify, then smoke-test from somewhere else

`deploy.sh` runs `verify.sh` for you. Run `smoke.sh` yourself, **from a network
that is not the LAN this was developed on** — a phone hotspot is enough:

```bash
./verify.sh                          # site + API, all reads or refused writes
./smoke.sh https://api.sente.lol     # adds the real challenge -> token -> /wallet flow
```

`smoke.sh` generates a throwaway key, signs the server's challenge with it and
uses the resulting token — so it proves session auth end to end while creating no
wallet and spending nothing. It needs a checkout with `node_modules` because
`smoke-sign.mjs` imports viem from it.

What each script asserts and why is in its header. The two that matter most:
`GET /auth` must say `"mode":"session"` (`placeholder` means the
`x-sente-user-id` header authenticates anyone who knows an address), and
`POST /webhooks/alchemy` must answer 401 or 503 to a forged signature — it is the
only public route that writes.

### 6. The Alchemy webhook, which can only be done now

`POST /webhooks/alchemy` needs a public HTTPS URL, so this is the step that was
impossible before the deploy — and it takes a second pass through steps 3 and 4:

1. Dashboard → **Data → Webhooks** → Address Activity, URL
   `https://api.sente.lol/webhooks/alchemy`, network Monad Testnet.
2. Copy the webhook's **signing key**, its **id** (`wh_…`) and the app's **AUTH
   TOKEN** into your local `.env` as `ALCHEMY_WEBHOOK_SIGNING_KEY`,
   `ALCHEMY_NOTIFY_WEBHOOK_ID`, `ALCHEMY_NOTIFY_AUTH_TOKEN`. They are three
   different secrets; `docs/alchemy.md` §4 says which is which and what swapping
   two of them looks like.
3. `./push-secrets.sh` then `./deploy.sh` again.
4. Dashboard → **Test Webhook** → expect `200 {"received":true,"appended":0,…}`.
5. Then the live half: hire an agent, send its wallet MON or a token, and check
   `GET /agents/:id/events?kind=deposit`. `docs/alchemy.md` §5–6 is the runbook.

Until step 3, the route answers `503 webhook_unconfigured` to everything —
including Alchemy. That is safe (an unverified body is never accepted) but no
deposit will ever appear on a Ledger, and `smoke.sh` says so when it sees a 503.

### 7. Rolling back

```bash
gcloud compute ssh sente-web --project "$PROJECT" --zone "$ZONE" \
  --command 'sudo docker image ls sente-api'        # the deploy history
SENTE_API_TAG=<an older sha> PROJECT=… ZONE=… ./deploy.sh
```

`SENTE_API_TAG` makes `deploy.sh` skip the build and use an image already on the
box. `docker image prune -f` in the deploy removes **dangling** images only, so
every `sente-api:<sha>` stays and the rollback targets survive. If you have
rolled the Caddyfile or the site back too, check out the older commit first — the
Caddyfile, `site/` and the web export are copied or built from your working
tree, not from the image. A rollback that should keep the current web app is
`SKIP_WEB=1`.

Three things a rollback does **not** touch, deliberately:

- **`/var/lib/sente/state`.** A registered wallet and a hired agent survive. Back
  it up before anything risky, because nothing else can reconstruct it:
  ```bash
  gcloud compute ssh sente-web --project "$PROJECT" --zone "$ZONE" \
    --command 'sudo tar czf ~/sente-state-$(date +%F).tgz -C /var/lib/sente state && ls -l ~/sente-state-*.tgz'
  ```
  Lost it anyway? `pnpm --filter @sente/api run privy:recover` finds a user's
  wallet again from the device public key.
- **`/opt/sente/api.env`.** Rolling the code back does not roll the secrets back;
  re-run `push-secrets.sh` from the `.env` you want.
- **the `caddy_data` volume.** Never delete it. It holds the ACME account key and
  the certificates.

Rotating `AUTH_SESSION_SECRET` is `push-secrets.sh` then `deploy.sh`, and it
invalidates every live session — which is the point of rotating it. Do not do it
between recording two takes of a demo.

## The web app

The app's web build (SEN-163's `export:web`) is served on the apex, from the
same Caddy, as a single-page app. Chosen over `app.sente.lol` because it needs no
new DNS record and the link a judge gets is the bare domain — and `sente.lol`
and its subdomains are the only origins where the passkeys work at all.

### What is served where

| Path on `https://sente.lol` | From                                                                    | Cache-Control                                    |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| `/.well-known/*`            | `infra/site` → `/srv/site`, a plain file server; unknown file = **404** | `public, max-age=300`                            |
| `/_expo/static/*`           | `infra/web` → `/srv/web`; content-hashed names, missing = 404           | `public, max-age=31536000, immutable`            |
| `/canvaskit.wasm`           | `infra/web` (Skia's CanvasKit, SEN-164); `application/wasm`             | `public, max-age=86400` (its name is not hashed) |
| `/assets/*`, `/favicon.ico` | `infra/web`; missing = 404                                              | none (heuristic, revalidated by ETag)            |
| everything else             | `infra/web/index.html`, the SPA fallback                                | `no-cache` — it names the current bundles        |

**The one way this goes wrong silently** is the fallback reaching
`/.well-known/`: a missing or mistyped association path would come back 200
`text/html`, and Android would stop offering every user's passkey to the app with
no error anywhere. So the Caddyfile puts `/.well-known/*` in its own `handle`
with no `try_files`, and `verify.sh` asserts from outside that
`/.well-known/does-not-exist` is a 404 — it runs even with `SKIP_WEB=1`, because
the fallback is live either way. (Caddy sorts `handle` blocks by matcher
specificity, so the order in the file does not decide it; it is written first for
the reader.) The old `infra/site/index.html` landing page was deleted: nothing
routes to `/srv/site` outside `/.well-known/` any more, and the app's welcome
screen replaces it.

`verify.sh` also checks `/` is the app shell, `/agents/anything` is the very same
`index.html`, and `/canvaskit.wasm` is `application/wasm`.

### Building it

`deploy.sh` builds the export **on this machine** (the box has 1 GB of RAM),
copies `apps/mobile/dist-web` to `infra/web` (gitignored) and ships it with the
rest of `infra/`. On the box `/opt/sente/web` is emptied and refilled, never
removed and recreated — it is bind mounted into the running Caddy, and a new
directory would be a new inode the container never sees.

**`EXPO_PUBLIC_*` is baked in at build time.** Whatever the build saw is in the
JavaScript every browser downloads: public by construction, and fixed until the
next build. `deploy.sh` sets them explicitly rather than trusting whatever `.env`
the machine has:

| Variable                    | Value                                               |
| --------------------------- | --------------------------------------------------- |
| `EXPO_PUBLIC_API_URL`       | `https://$API_HOST` — always, not overridable       |
| `EXPO_PUBLIC_MONAD_NETWORK` | `testnet` unless set in the environment             |
| `EXPO_PUBLIC_MONAD_RPC_URL` | empty (viem's default public RPC) unless set        |
| `EXPO_PUBLIC_BUNDLER_URL`   | `https://public.pimlico.io/v2/10143/rpc` unless set |
| `EXPO_PUBLIC_USER_TRADING`  | empty (manual trading off) unless set               |

Two refusals before anything reaches the network: the bundle must contain
`https://api.sente.lol` (the APK's inlining check, same reasoning: do not test
for the absence of `localhost:3000`, the fallback literal is always there), and
the export must contain `canvaskit.wasm`, without which every Skia icon throws
and the page is blank.

**`--clear` is not optional, and this is the trap.** Metro's transform cache does
not key on `EXPO_PUBLIC_*` values. Measured on SEN-168: an `expo export
--platform web` with `EXPO_PUBLIC_API_URL=https://api.sente.lol` produced a bundle
with **no** `api.sente.lol` and a bare `http://localhost:3000`, because an earlier
export had cached `src/wallet/api.ts` without the variable; with `--clear` the URL
appeared. The reverse holds too — an export with the variable **unset** right
after a `--clear`ed one still carried `api.sente.lol`. `deploy.sh` always passes
`--clear`. The release APK's bundling goes through the same Metro cache; that
recipe has not been re-measured with this in mind.

### Redeploying just the web app

```bash
cd infra
DRY_RUN=1 ./deploy.sh                          # local only: build + checks into infra/web, then stop
SKIP_API=1 PROJECT=… ZONE=… ./deploy.sh        # ship it: Caddyfile, site/, web/, caddy reload, verify
```

`DRY_RUN=1` exits before the first `gcloud` call and needs no `PROJECT`; it never
touches the box or DNS. `SKIP_API=1` still runs the DNS check (the Caddyfile still
has an `api.sente.lol` block) and `verify.sh`.

### Testing the Caddyfile locally

No box needed — the real Caddyfile in a `caddy:2-alpine` container on high ports,
with Caddy's internal CA instead of ACME:

```bash
T=$(mktemp -d)
# Swap only the global options block: local CA, ports 8168/8443.
python3 -c "import sys;s=sys.stdin.read();print('{\n\tlocal_certs\n\tskip_install_trust\n\thttp_port 8168\n\thttps_port 8443\n}'+s[s.index('\n}\n')+2:])" \
  < infra/Caddyfile > "$T/Caddyfile"
docker run -d --rm --name sente-caddy-test -p 8168:8168 -p 8443:8443 \
  -v "$T/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/infra/site:/srv/site:ro" -v "$PWD/infra/web:/srv/web:ro" caddy:2-alpine
sleep 3                                        # let it issue its internal certs
printf 'insecure\nresolve = sente.lol:8443:127.0.0.1\n' > "$T/.curlrc"
CURL_HOME="$T" SITE_BASE=https://sente.lol:8443 SKIP_API=1 infra/verify.sh
docker stop sente-caddy-test
```

`SITE_BASE` points `verify.sh` at the local Caddy; the `.curlrc` makes every curl
in it trust the internal CA and resolve `sente.lol` to localhost.

## The release APK

Four facts, and each one is a way for a build that looks fine to fail:

1. **`EXPO_PUBLIC_API_URL` is inlined at bundle time.** `apps/mobile/src/wallet/api.ts`
   reads `process.env.EXPO_PUBLIC_API_URL` with `http://localhost:3000` as the
   fallback, and Expo substitutes the value when the bundle is built. A release
   APK built without it points every request at the phone's own localhost. It
   cannot be changed afterwards and there is no runtime override.
2. **`assembleRelease` signs with the DEBUG key.** Verified by reading the
   generated `android/app/build.gradle`: the template's `release` buildType says
   `signingConfig signingConfigs.debug`. So the "release" APK gradle produces
   carries the debug fingerprint — which _is_ in `assetlinks.json`, so passkeys
   work and nothing looks wrong. What is wrong is that the artifact is signed by
   a keystore whose password is `android` and which `expo prebuild --clean`
   regenerates on any machine: anyone can sign an update for it. The APK must be
   re-signed with the real keystore.
3. **The APK's SHA-256 must match the second entry in `assetlinks.json`**
   (`15:FA:4B:…:36:55`, the release fingerprint;
   `FA:C6:17:…:3B:9C` is debug). A mismatch breaks passkeys, and therefore
   wallets, on a build that installs and runs.
4. **Losing `apps/mobile/keystores/sente-release.keystore` is unrecoverable** and
   costs every user their account. `apps/mobile/keystores/README.md`.

### The recipe

```bash
export API=https://api.sente.lol

# The value is inlined, so it must be in the environment of the bundling step.
# Put it in apps/mobile/.env too (gitignored) if you would rather not rely on
# remembering the prefix: Expo reads .env from the app project root.
cd apps/mobile
EXPO_PUBLIC_API_URL=$API mise exec -- pnpm exec expo prebuild --platform android --clean
cd android
EXPO_PUBLIC_API_URL=$API mise exec -- ./gradlew assembleRelease
#  -> app/build/outputs/apk/release/app-release.apk   (signed with the DEBUG key)

# Prove the URL really got inlined BEFORE you sign anything.
unzip -p app/build/outputs/apk/release/app-release.apk assets/index.android.bundle \
  | strings | grep -c 'api\.sente\.lol'      # must be >= 1; 0 means it was NOT inlined
#
# Measured 2026-09-24 with `expo export --platform android` on this branch:
# `EXPO_PUBLIC_API_URL=https://api.sente.lol` -> 1 occurrence in the .hbc, and
# with the variable unset -> 0. So this grep does discriminate.
#
# Do NOT instead check that `localhost:3000` is absent. It is present either way:
# it is the `|| DEFAULT_API_URL` fallback literal in apps/mobile/src/wallet/api.ts
# and it survives into every bundle. Measured: 1 occurrence in both.

# Re-sign with the real key. `apksigner sign` replaces the existing signature.
BT="$ANDROID_HOME/build-tools/36.0.0"
"$BT/zipalign" -p -f 4 \
  app/build/outputs/apk/release/app-release.apk /tmp/sente-aligned.apk
"$BT/apksigner" sign \
  --ks ../keystores/sente-release.keystore --ks-key-alias sente-release \
  --out ../../../sente-release.apk /tmp/sente-aligned.apk
```

### The fingerprint check, which is not optional

```bash
BT="$ANDROID_HOME/build-tools/36.0.0"
APK=sente-release.apk

GOT=$("$BT/apksigner" verify --print-certs "$APK" \
      | awk '/Signer #1 certificate SHA-256 digest/ {print $NF}')
WANT=$(mise exec -- node -e "const a=require('./infra/site/.well-known/assetlinks.json');\
console.log(a[0].target.sha256_cert_fingerprints[1].replace(/:/g,'').toLowerCase())")

[ "$GOT" = "$WANT" ] && echo "MATCH $GOT" || echo "MISMATCH apk=$GOT assetlinks=$WANT"
```

`WANT` is `15fa4b41d1c844c2f79fb7b83a5db66d39b81e8cd34690f8c3a16b559faf3655` today
— `apksigner` prints the digest lowercase and without colons, `assetlinks.json`
stores it uppercase with them, which is why the comparison normalises rather than
eyeballs. If `GOT` is
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` you signed
nothing: that is the debug key and you are looking at gradle's output, not
`apksigner`'s.

Then check the served file still carries it, because the APK matching a file that
is not deployed proves nothing:

```bash
curl -sS https://sente.lol/.well-known/assetlinks.json | grep -o '15:FA:[^"]*'
```

`infra/smoke.sh` §6 does exactly this.

### Where judges get it

Undecided — see below. The box already serves `/srv/site`, so
`https://sente.lol/download/sente-release.apk` is one `gcloud compute scp` away;
what should not happen is committing a ~60 MB binary to the repo.

## Judge access

The submission asks for "credentials". Sente has no passwords — an account _is_ a
passkey, created on the judge's own device — so "credentials" has to mean
something else, and this is the shape of it (not yet written for the submission):

- the APK and its SHA-256, so they can check what they installed;
- `https://api.sente.lol/health` as the liveness link;
- a short written path: install → create a passkey → the gas drip funds the new
  account → register the wallet → hire an agent with a mandate → watch it trade;
- testnet funds ready, and enough left in the drip's daily cap
  (`GAS_DRIP_DAILY_CAP_MON`) that several judges can each be funded;
- the starter kit on (SEN-170): `STARTER_DRIP_PRIVATE_KEY` set, and that wallet
  holding AUSD and USDC for `STARTER_DRIP_DAILY_CAP_USERS` users plus MON for
  their gas. See "Starter kit" below;
- a funded demo agent to look at without waiting for one to warm up.

### Starter kit

`services/api/src/starter-kit/` (SEN-170) sends each user's wallet
`STARTER_DRIP_AUSD` AUSD (default 250) and `STARTER_DRIP_USDC` USDC (default
100), once, after a successful `POST /wallet/register`. Perpl needs 100 AUSD to
open an account and Kuru's minimum notional is 10 USDC, so a judge can hire an
agent straight away. `GET /wallet` reports it as
`starterKit: { status: 'none' | 'pending' | 'sent' | 'failed' | 'disabled', ausdTx?, usdcTx? }`.

- **Its own key.** Boot refuses a `STARTER_DRIP_PRIVATE_KEY` that is also in
  `GAS_DRIP_PRIVATE_KEYS` or is an `ERC8004_*` key: two senders on one key share
  a nonce sequence neither tracks. Unset, the kit is off (`disabled`) and
  registration is unchanged.
- **Once per user, across redeploys.** `<STATE_DIR>/starter-kits.json` records
  every kit. It is kicked off on every successful register, never awaited, and
  the record makes it once: a user the daily cap turned away (`none`) gets it on
  a later sign-in after 00:00 UTC.
- **No retries.** A short starter wallet fails the kit before anything is sent;
  a reverted or unconfirmed transfer fails it after. A kit a restart caught
  mid-send loads as `failed`. Re-sending is a manual decision: delete the user's
  record from the file with the API stopped.
- **Funding.** Per user: the two token amounts plus gas at the explicit limits,
  82,000 (AUSD) + 72,000 (USDC). Monad charges the limit, so at ~100 gwei that
  is about 0.016 MON per user, about 0.8 MON for a full day's cap of 50.

## Decisions still open

1. **The per-IP rate limit collapses behind the proxy.** `@Ip()` resolves to
   Express's `req.ip`, which without `app.set('trust proxy', …)` is the socket's
   peer — Caddy. So `GAS_DRIP_RATE_LIMIT_MAX` becomes one shared bucket for
   everyone instead of per caller. It fails **closed**: the per-address and
   per-user caps in the drip ledger are untouched, so nothing can be drained, but
   five judges in the same minute would see refusals. The fix is one line in
   `services/api/src/main.ts` and it is deliberately not in this branch (SEN-51
   is `infra/`, `docs/` and a Dockerfile). Decide before demo day.
2. **`/opt/sente/api.env` versus Secret Manager.** The file is reviewable in
   full, has one owner and one mode, and needs nothing enabled. Secret Manager
   gives rotation, audit and versioning, and needs an API enabled, a service
   account binding and a fetch-on-boot shim. For one demo box the file is the
   right size of answer; for anything long-lived it is not.
3. **e2-micro capacity.** 1 GB of RAM, shared vCPU, no swap by default, now
   running Caddy _and_ Node. It should fit — the API idles around 150–250 MB —
   but it is unmeasured on this box. Cheap insurance: a 1 GB swap file. Bumping
   to `e2-small` leaves the free tier.
4. **Where the APK is hosted**, above.
5. **`AGENT_TICK_SECONDS` on the box.** Unset means no scheduler, which is the
   default and the safe answer: with it set, every active agent runs on a timer
   and spends its owner's OpenRouter credits unprompted. If judges are meant to
   see an agent act on its own without pressing anything, it has to be set — and
   then the credit ceiling matters.
6. **Log retention and alerting.** The compose file caps container logs at
   5 × 10 MB, which stops the disk filling and is not monitoring. Nothing tells
   anyone the API died at 3 a.m.; `restart: unless-stopped` plus the health check
   is the whole story today.

## What has and has not run

Written and **verified locally**, 2026-09-24, on this branch:

| Verified                                                                                                                                                       | How                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PLACEHOLDER=1` + `NODE_ENV=production` refuses to boot                                                                                                   | booted `services/api/dist/main.js` with that environment; exit 1, "AUTH_PLACEHOLDER trusts the x-sente-user-id header and is refused under NODE_ENV=production"                                                      |
| no `AUTH_SESSION_SECRET` under production refuses to boot                                                                                                      | same, exit 1, "AUTH_SESSION_SECRET is required: 32 random bytes as hex"                                                                                                                                              |
| production + a real secret boots, `mode=session`, `/wallet` 401, webhook 503                                                                                   | same, then curl                                                                                                                                                                                                      |
| `verify.sh` passes against a production-mode API and **fails** against a placeholder-mode one                                                                  | ran both; the placeholder run failed on `"mode":"session"` and on the `x-sente-user-id` check (404 = it authenticated)                                                                                               |
| `smoke.sh` end to end, including challenge → signature → token → `GET /wallet` (404) and `GET /agents` (200)                                                   | ran it against a local production-mode API                                                                                                                                                                           |
| `push-secrets.sh` filtering and all four pre-flight refusals                                                                                                   | `DRY_RUN=1` against synthetic `.env` files                                                                                                                                                                           |
| `services/api/Dockerfile` builds                                                                                                                               | `docker build` locally (and that is how the missing `corepack` in node 26 was found)                                                                                                                                 |
| the image boots and serves: node 26.10.0, uid 1000, `NODE_ENV=production`, `mode=session`, `/wallet` 401, and both boot refusals fire **inside the container** | `docker run` with the environment `docker-compose.yml` sets; `smoke.sh` against it passed every check but the https one                                                                                              |
| the compose health check command works                                                                                                                         | ran `node -e "fetch('http://127.0.0.1:3000/health')…"` inside the running container; exit 0                                                                                                                          |
| `STATE_DIR` on a bind mount is writable by the image's user                                                                                                    | wrote a file to `/var/lib/sente/state` as uid 1000 and saw it on the host                                                                                                                                            |
| `docker history` carries no secret                                                                                                                             | grepped it for `AUTH_SESSION_SECRET`, `PRIVY`, `GAS_DRIP`, `.env` — zero matches                                                                                                                                     |
| `MONAD_WS_URL` defaults sanely                                                                                                                                 | the container logged `following wss://testnet-rpc.monad.xyz (512 blocks), falling back to eth_getBlockByNumber while the socket is down`                                                                             |
| `infra/docker-compose.yml` is valid and `${SENTE_API_TAG}` interpolates                                                                                        | `docker compose config` on a copy whose only edit was the `env_file` path                                                                                                                                            |
| **`environment` really does outrank `env_file`**                                                                                                               | put `NODE_ENV=development`, `STATE_DIR=/tmp/oops`, `PORT=9999` in the env file; the resolved config kept `production`, `/var/lib/sente/state`, `3000`                                                                |
| `infra/Caddyfile` is valid, including the new `api.sente.lol` block                                                                                            | `caddy validate` in a `caddy:2-alpine` container — "Valid configuration"                                                                                                                                             |
| **`EXPO_PUBLIC_API_URL` really is inlined at bundle time**, and the grep that checks it discriminates                                                          | `expo export --platform android` twice: with the variable set, `https://api.sente.lol` appears once in the 8.1 MB `.hbc`; with it unset, zero times. `localhost:3000` appears once either way (the fallback literal) |
| the release fingerprint is in the **served** `assetlinks.json`                                                                                                 | `curl https://sente.lol/.well-known/assetlinks.json` — 200, no redirect, and it contains `15:FA:…:36:55`                                                                                                             |
| `assembleRelease` signs with the debug key                                                                                                                     | read the generated `apps/mobile/android/app/build.gradle`                                                                                                                                                            |
| `deploy.sh`'s DNS check works on a machine with no `dig`                                                                                                       | ran its `resolve()` helper verbatim: `sente.lol` and `www.sente.lol` → 35.202.26.61 via `getent`, `api.sente.lol` → nothing, which is the refusal path                                                               |

Added 2026-10-01 (SEN-168), the web half, also **local only**:

| Verified                                                                 | How                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the new Caddyfile passes every `verify.sh` site and web check            | the real Caddyfile (global block swapped for `local_certs` on 8168/8443) in `caddy:2-alpine`, serving `infra/site` and a real `infra/web` from `DRY_RUN=1 ./deploy.sh`; `SITE_BASE=https://sente.lol:8443 SKIP_API=1 ./verify.sh` → PASS |
| `/.well-known/does-not-exist` is a 404 and the check catches the mistake | same container: 404. Then a copy of the Caddyfile with `try_files {path} /index.html` added to the `/.well-known/*` block: `verify.sh` failed on exactly that check (HTTP 200)                                                           |
| `assetlinks.json` bytes are unchanged by the new config                  | served by the old Caddyfile (`main`) and by the new one; `cmp` of the two bodies, and of each against `infra/site/.well-known/assetlinks.json` — identical                                                                               |
| cache headers and compression                                            | `/` and SPA routes `no-cache`; `/_expo/static/*` immutable and `zstd`-encoded; `/canvaskit.wasm` `application/wasm`, one day; a missing `/_expo/static/…` chunk or `/assets/…` file is a 404, not HTML; `www` → 301 to the apex          |
| `deploy.sh` refuses a bundle without `https://api.sente.lol`             | `DRY_RUN=1` with a `mise` shim that dropped `EXPO_PUBLIC_API_URL`: exit 1 at the grep, nothing copied to `infra/web`                                                                                                                     |
| `deploy.sh` refuses an export without `canvaskit.wasm`                   | `DRY_RUN=1` on this branch, where SEN-164's `public/canvaskit.wasm` has not landed: exit 1; with a temporary copy in `apps/mobile/public/` it passed and filled `infra/web` (15 MB)                                                      |
| Metro's cache ignores `EXPO_PUBLIC_*`                                    | see "Building it" above — the reason for `--clear`                                                                                                                                                                                       |

**NOT RUN. Nothing has been deployed, and nothing about the live box has
changed:**

- `provision.sh`, `deploy.sh`, `push-secrets.sh` (outside `DRY_RUN=1`) — never
  executed against `sente-web`. No `gcloud` command that changes state was run,
  and no read-only one either: `gcloud compute instances list` answered
  "Reauthentication failed. cannot prompt during non-interactive execution", so
  **the box was never contacted at all** and nothing here is a statement about its
  current contents. The project is `plenary-anvil-491607-s6`.
- The DNS record for `api.sente.lol` does not exist — checked publicly, it
  resolves to nothing — so there is no certificate for it. `sente.lol` and
  `www.sente.lol` both answer 35.202.26.61.
- No image has been shipped to the box; `/opt/sente/api.env` and
  `/var/lib/sente/state` do not exist there.
- The container has never run **on the box**, and never with the real secrets or
  through Caddy. It has been run locally from the same image with a synthetic
  environment (above), so what is unproven is the box: ACME for `api.sente.lol`,
  the reverse proxy, the bind mount at `/var/lib/sente/state`, and whether an
  e2-micro holds Caddy and Node at once.
- `docker compose up` itself has never run with this file. `config` validates it
  (above); starting it is what proves the bind mount and the proxy.
- **No release APK has been built and none has been signed.** The recipe above is
  derived from the generated gradle config and from `apps/mobile/keystores/README.md`;
  the `zipalign`/`apksigner` sequence has not been executed and the fingerprint
  comparison has been run only on the `assetlinks.json` side.
- No real Alchemy delivery. No state-survives-a-redeploy check. Nothing has been
  installed on a phone.
- **The web app has never been served from the box.** The `./web` bind mount,
  the empty-and-refill of `/opt/sente/web`, the `caddy reload` step and the
  web half of `verify.sh` against the live host are all unrun; the live deploy is
  the human half of SEN-51. The SPA fallback has been checked with `curl`, not
  in a browser.
- `docs/alchemy.md`'s webhook steps are unchanged and still unperformed.
