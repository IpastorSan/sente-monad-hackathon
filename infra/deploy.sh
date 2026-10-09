#!/usr/bin/env bash
# Copies infra/ to the box, ships the API image and the web export, and brings
# both containers up. Safe to re-run. SEN-51 added the API half, SEN-168 the web.
#
#   PROJECT=… ZONE=… ./deploy.sh
#
#   SKIP_API=1        Caddy, the site and the web app only — no API image. Use it
#                     to get certificates issued before the API has secrets, and
#                     to redeploy just the web app.
#   SKIP_WEB=1        do not build or ship the web export; whatever the box
#                     already serves at https://sente.lol stays as it is.
#   DRY_RUN=1         LOCAL ONLY: build the web export into infra/web, run its
#                     checks, and exit before the first gcloud call. Needs no
#                     PROJECT and touches neither the box nor DNS.
#   ALLOW_NO_DNS=1    deploy even though api.sente.lol does not resolve to the
#                     box. Read the rate-limit note below before you do.
#   SENTE_API_TAG=…   deploy an image that is already on the box instead of
#                     building one. THIS IS THE ROLLBACK: pass a tag from
#                     `docker image ls sente-api` on the box.
#   HEALTH_TIMEOUT=…  seconds to wait for the API container to report healthy
#                     (default 120: an e2-small booting the API takes longer
#                     than a minute). Never healthy in time = exit non-zero.
#   SKIP_BOX_CHECK=1  run live-check.sh without --box (no SSH checks on the box).
#
# ORDER, and it is not arbitrary:
#
#   1. provision.sh          (once)
#   2. DNS: A @, A www, A api -> the box's IP
#   3. push-secrets.sh       the API refuses to start without /opt/sente/api.env
#   4. deploy.sh             this
#   5. live-check.sh --box   deploy.sh runs it for you at the end: verify.sh,
#                            smoke.sh, authenticated reads, the drift check and
#                            the box's own view (SEN-186). Non-zero on any FAIL.
set -euo pipefail

PROJECT="${PROJECT:-}"
ZONE="${ZONE:-europe-southwest1-a}"
NAME="${NAME:-sente-eu}"
SITE_HOST="${SITE_HOST:-sente.lol}"
API_HOST="${API_HOST:-api.$SITE_HOST}"
SKIP_API="${SKIP_API:-0}"
ALLOW_NO_DNS="${ALLOW_NO_DNS:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
DRY_RUN="${DRY_RUN:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SKIP_BOX_CHECK="${SKIP_BOX_CHECK:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

say () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die () { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# The `site/`, `Caddyfile` and `./verify.sh` paths below are relative, so make
# them relative to this script rather than to wherever it was invoked from.
cd "$HERE"

# A placeholder assetlinks.json is not dangerous — Android simply fails to
# verify the app, which is loud rather than silent. So warn, do not block:
# getting the certificate issued early is worth more than withholding a file
# that is inert until the app exists.
if grep -rq 'REPLACE_' site/.well-known/ 2>/dev/null; then
  echo "WARNING: site/.well-known/assetlinks.json still contains REPLACE_ placeholders." >&2
  echo "         Passkey association will NOT work until both Android SHA-256" >&2
  echo "         fingerprints are filled in. Deploying anyway." >&2
  echo >&2
fi

# ---------------------------------------------------------------------------
# The web export (SEN-168). Built HERE, before anything reaches the network, for
# the same reason as the API image: the box has 1 GB of RAM. It lands in
# infra/web (gitignored) and ships with the rest of infra/.
#
# EXPO_PUBLIC_* is INLINED into the JavaScript at bundle time, so these values
# are public by construction and fixed per build; changing one means rebuilding.
# Each is overridable from the environment except the API URL, which follows
# API_HOST.
#
# `--clear` IS NOT OPTIONAL. Metro's transform cache does not key on
# EXPO_PUBLIC_* values: measured on SEN-168, an export run with
# EXPO_PUBLIC_API_URL unset, straight after one with it set, still carried the
# old URL — and the reverse ships `http://localhost:3000`, the fallback literal,
# to every browser. The grep below catches the API URL; --clear is what makes
# the other values trustworthy too.
# ---------------------------------------------------------------------------
build_web () {
  command -v mise >/dev/null 2>&1 || die "mise is required to build the web export (../CLAUDE.md, Toolchain)"
  local api_url="https://$API_HOST"
  local out="$REPO/apps/mobile/dist-web"

  say "Building the web export (EXPO_PUBLIC_API_URL=$api_url)"
  rm -rf "$out"
  (
    cd "$REPO"
    EXPO_PUBLIC_API_URL="$api_url" \
    EXPO_PUBLIC_MONAD_NETWORK="${EXPO_PUBLIC_MONAD_NETWORK:-testnet}" \
    EXPO_PUBLIC_MONAD_RPC_URL="${EXPO_PUBLIC_MONAD_RPC_URL:-}" \
    EXPO_PUBLIC_BUNDLER_URL="${EXPO_PUBLIC_BUNDLER_URL:-https://public.pimlico.io/v2/10143/rpc}" \
    EXPO_PUBLIC_USER_TRADING="${EXPO_PUBLIC_USER_TRADING:-}" \
      mise exec -- pnpm --filter @sente/mobile run export:web --clear
  ) || die "the web export failed"

  # The same check as the APK's (docs/deploy.md, "The release APK"): the URL must
  # appear in the bundle. Do not check that localhost:3000 is ABSENT instead — it
  # is the fallback literal in src/wallet/api.ts and survives into every build.
  grep -rqF "$api_url" "$out/_expo/static/js/" 2>/dev/null \
    || die "$api_url is not in the web bundle, so the app would call http://localhost:3000.
       EXPO_PUBLIC_API_URL was not inlined; refusing to ship it."
  echo "    ✓ $api_url is inlined in the bundle"

  # Every icon is a Skia path, and on web Skia needs CanvasKit (SEN-164). Without
  # the wasm the app is a blank page, which verify.sh would only notice after the
  # deploy.
  [ -f "$out/canvaskit.wasm" ] \
    || die "canvaskit.wasm is not in the export, so every Skia icon throws and the page is blank.
       apps/mobile/public/canvaskit.wasm is SEN-164's; deploy with SKIP_WEB=1 until it lands."
  echo "    ✓ canvaskit.wasm is in the export"

  rm -rf "$HERE/web"
  cp -r "$out" "$HERE/web"
  echo "    → infra/web ($(du -sh "$HERE/web" | cut -f1))"
}

if [ "$SKIP_WEB" = 1 ]; then
  say "SKIP_WEB=1 — the box keeps the web app it already has"
else
  build_web
fi

if [ "$DRY_RUN" = 1 ]; then
  say "DRY_RUN=1 — stopping before anything reaches gcloud, DNS or the box"
  exit 0
fi

[ -n "$PROJECT" ] || die "set PROJECT"

# ---------------------------------------------------------------------------
# DNS, before anything touches Caddy's configuration
#
# The Caddyfile now carries an `api.sente.lol` block, and Caddy will try to get
# a certificate for it the moment it loads. ACME validates over the public name,
# so a name that does not resolve to this box is a FAILED AUTHORISATION, and
# Let's Encrypt rate-limits those (five per hostname per hour, and the limit is
# on the account). The existing sente.lol certificate is safe — it is already in
# the caddy_data volume — but the api one can be locked out for an hour by two
# careless re-runs. So: check, and refuse.
# ---------------------------------------------------------------------------
resolve () { # $1=name -> A records, one per line
  if command -v dig >/dev/null 2>&1; then dig +short A "$1" | grep -E '^[0-9.]+$' || true
  else getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u || true
  fi
}

say "Reading the box's external IP (read-only)"
IP="$(gcloud compute instances describe "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
[ -n "$IP" ] && echo "    $NAME is $IP" || die "could not read $NAME's external IP"

for host in "$SITE_HOST" "$API_HOST"; do
  got="$(resolve "$host" | tr '\n' ' ')"
  if [[ " $got " == *" $IP "* ]]; then
    echo "    ✓ $host -> $IP"
  else
    msg="$host resolves to '${got:-nothing}', not $IP.
       Add the record at the registrar and wait for it:  A ${host%%.*}  $IP
       Caddy cannot get a certificate for a name that does not reach this box,
       and each attempt burns a Let's Encrypt failed authorisation.
       Override with ALLOW_NO_DNS=1 only if you know why."
    [ "$ALLOW_NO_DNS" = 1 ] && echo "    ! $msg" || die "$msg"
  fi
done

# ---------------------------------------------------------------------------
# The API image. Built HERE, on a machine with RAM: the box is an e2-micro with
# 1 GB and a shared vCPU, and a workspace install plus two tsc passes plus
# `nest build` on it is somewhere between very slow and out-of-memory.
#
# Shipped as a tarball over the SSH connection we already have. No registry, so
# there is nothing to enable, nothing to authenticate, and no copy of the image
# sitting anywhere a leaked credential could pull it. The image holds no secret
# either way (services/api/Dockerfile has no ARG and copies no env file).
# ---------------------------------------------------------------------------
if [ "$SKIP_API" = 1 ]; then
  say "SKIP_API=1 — Caddy and the site only"
  echo "    api.$SITE_HOST will get a certificate and then 502 until the API lands."
else
  say "Checking the box has its secrets"
  if ! gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet \
      --command 'sudo test -f /opt/sente/api.env' 2>/dev/null; then
    die "/opt/sente/api.env is not on the box, so the API container would boot
       with no AUTH_SESSION_SECRET and die. Deliver the secrets first:

           PROJECT=$PROJECT ZONE=$ZONE ./push-secrets.sh

       Or run this with SKIP_API=1 to deploy only Caddy and the site."
  fi
  echo "    ✓ /opt/sente/api.env exists (contents never read by this script)"

  if [ -n "${SENTE_API_TAG:-}" ]; then
    say "SENTE_API_TAG=$SENTE_API_TAG — using an image already on the box, not building"
    gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
      "sudo docker image inspect sente-api:$SENTE_API_TAG >/dev/null" \
      || die "sente-api:$SENTE_API_TAG is not on the box. \`sudo docker image ls sente-api\` there lists what is."
  else
    # The tag is the commit, so `docker image ls sente-api` on the box reads as a
    # deploy history and a rollback is a tag. `-dirty` when the tree is not
    # clean, because an untagged local change deployed under a bare SHA is a
    # deploy nobody can reproduce.
    SENTE_API_TAG="$(git -C "$REPO" rev-parse --short HEAD)"
    git -C "$REPO" diff --quiet HEAD -- || SENTE_API_TAG="${SENTE_API_TAG}-dirty"

    say "Building sente-api:$SENTE_API_TAG (context: $REPO)"
    # The laptop's pnpm store seeds the install (see the Dockerfile's hoststore).
    HOST_STORE="$(cd "$REPO" && mise exec -- pnpm store path)"
    docker build \
      --build-context hoststore="$HOST_STORE" \
      --file "$REPO/services/api/Dockerfile" \
      --tag "sente-api:$SENTE_API_TAG" \
      --tag "sente-api:latest" \
      "$REPO"

    say "Shipping the image to $NAME (this is the slow part — hundreds of MB)"
    # Both refs in one tarball, so `latest` on the box means this build too.
    # gzip rather than zstd: it is on every Debian image without asking.
    docker save "sente-api:$SENTE_API_TAG" "sente-api:latest" \
      | gzip -1 \
      | gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet \
          --command 'gunzip | sudo docker load'
  fi
fi

# ---------------------------------------------------------------------------
# Install and start
# ---------------------------------------------------------------------------
# scp runs as the SSH user, and /opt/sente is root-owned, so stage in $HOME
# and move it into place with sudo rather than loosening permissions on /opt.
say "Staging to $NAME:~/sente-deploy"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  'rm -rf ~/sente-deploy && mkdir -p ~/sente-deploy'

ship=(Caddyfile docker-compose.yml site)
[ "$SKIP_WEB" = 1 ] || ship+=(web)
gcloud compute scp --recurse "${ship[@]}" \
  "$NAME:~/sente-deploy/" --project "$PROJECT" --zone "$ZONE"

# /opt/sente/.env is compose's VARIABLE INTERPOLATION file — it is how
# ${SENTE_API_TAG} in docker-compose.yml resolves, including for a `docker
# compose up` someone runs by hand on the box later. It is NOT the secrets file;
# that is /opt/sente/api.env, 0600 root:root, and nothing here writes it.
say "Installing to /opt/sente and starting"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  "sudo mkdir -p /opt/sente \
   && sudo mkdir -p /opt/sente/web \
   && if [ -d ~/sente-deploy/web ]; then sudo find /opt/sente/web -mindepth 1 -delete; fi \
   && sudo cp -r ~/sente-deploy/. /opt/sente/ \
   && printf '# compose interpolation only. Secrets are in api.env (0600 root:root).\nSENTE_API_TAG=%s\n' '${SENTE_API_TAG:-latest}' | sudo tee /opt/sente/.env >/dev/null \
   && sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/sente/state \
   && cd /opt/sente \
   && sudo docker compose up -d \
   && { sleep 2; sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile \
        || echo 'WARNING: caddy reload failed; Caddy keeps its previous config. sudo docker logs sente-caddy'; } \
   && sudo docker compose ps \
   && sudo docker image prune -f >/dev/null"

# /opt/sente/web is EMPTIED, never removed: it is bind mounted into the running
# Caddy container, and a directory that is deleted and recreated is a different
# inode — the container would keep serving the deleted, empty one. Emptied only
# when a new export arrived, so SKIP_WEB=1 leaves the live app alone. The old
# bundles go with it; a tab still open on the previous deploy gets a 404 for a
# lazily loaded chunk and recovers on reload, since index.html is no-cache.
#
# `caddy reload`: `compose up -d` recreates a container only when its compose
# definition changed. An edited Caddyfile is a bind-mounted file, not a
# definition change, so without the reload Caddy keeps the old config.
# A failed reload (a bad Caddyfile, or a container still starting after `up`
# recreated it) leaves the old config running, so it warns rather than aborting
# before verify.sh, which is what says whether the result is acceptable.
#
# STATE_DIR lives on the host at /var/lib/sente/state, owned by uid 1000 — the
# image's `node` user. Root-owned would make every wallet registration EACCES,
# and `install -d` is idempotent, so this runs on every deploy and cannot drift.
# `image prune -f` removes DANGLING images only: every sente-api:<sha> stays, so
# the rollback tags survive while the disk does not fill.

if [ "$SKIP_API" != 1 ]; then
  say "Waiting up to ${HEALTH_TIMEOUT}s for the API's health check to pass"
  start=$SECONDS
  state=''
  while :; do
    state="$(gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet \
      --command "sudo docker inspect -f '{{.State.Health.Status}}' sente-api" 2>/dev/null || true)"
    echo "    ${state:-no answer} ($((SECONDS - start))s)"
    [ "$state" = healthy ] || [ "$state" = unhealthy ] || [ $((SECONDS - start)) -ge "$HEALTH_TIMEOUT" ] && break
    sleep 5
  done
  # A deploy whose API never comes up is a failed deploy, not a warning: stop
  # here, before the checks below report on a box that is not serving.
  if [ "$state" != healthy ]; then
    die "the API is '${state:-unknown}' after ${HEALTH_TIMEOUT}s, not healthy. Its boot log
       says why — a bad environment is a failed boot here by design, and it names
       the variable:
         gcloud compute ssh $NAME --project $PROJECT --zone $ZONE --command 'sudo docker logs --tail 50 sente-api'
       Still booting? Re-run the checks alone: ./live-check.sh --box
       Roll back: SENTE_API_TAG=<previous tag> ./deploy.sh"
  fi
fi

# live-check.sh runs verify.sh and smoke.sh itself, then the reads that need a
# session, the drift check and (with --box) the box's own view. Every check is a
# read, so it is safe on a live deploy. Its exit code is this script's.
say "Live check"
# The health wait above already proved the API up; without it, give Caddy's
# reload a moment.
if [ "$SKIP_API" = 1 ]; then sleep 5; fi
box=(--box)
{ [ "$SKIP_API" = 1 ] || [ "$SKIP_BOX_CHECK" = 1 ]; } && box=()
SKIP_API="$SKIP_API" SKIP_WEB="$SKIP_WEB" API_BASE="https://$API_HOST" \
  PROJECT="$PROJECT" ZONE="$ZONE" NAME="$NAME" ./live-check.sh "${box[@]}" "$SITE_HOST"
