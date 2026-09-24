#!/usr/bin/env bash
# Copies infra/ to the box, ships the API image, and brings both containers up.
# Safe to re-run. SEN-51 added the API half.
#
#   PROJECT=… ZONE=… ./deploy.sh
#
#   SKIP_API=1        Caddy and the site only — the pre-SEN-51 behaviour. Use it
#                     to get certificates issued before the API has secrets.
#   ALLOW_NO_DNS=1    deploy even though api.sente.lol does not resolve to the
#                     box. Read the rate-limit note below before you do.
#   SENTE_API_TAG=…   deploy an image that is already on the box instead of
#                     building one. THIS IS THE ROLLBACK: pass a tag from
#                     `docker image ls sente-api` on the box.
#
# ORDER, and it is not arbitrary:
#
#   1. provision.sh          (once)
#   2. DNS: A @, A www, A api -> the box's IP
#   3. push-secrets.sh       the API refuses to start without /opt/sente/api.env
#   4. deploy.sh             this
#   5. verify.sh             deploy.sh runs it for you at the end
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-sente-web}"
SITE_HOST="${SITE_HOST:-sente.lol}"
API_HOST="${API_HOST:-api.$SITE_HOST}"
SKIP_API="${SKIP_API:-0}"
ALLOW_NO_DNS="${ALLOW_NO_DNS:-0}"
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
    docker build \
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

gcloud compute scp --recurse Caddyfile docker-compose.yml site \
  "$NAME:~/sente-deploy/" --project "$PROJECT" --zone "$ZONE"

# /opt/sente/.env is compose's VARIABLE INTERPOLATION file — it is how
# ${SENTE_API_TAG} in docker-compose.yml resolves, including for a `docker
# compose up` someone runs by hand on the box later. It is NOT the secrets file;
# that is /opt/sente/api.env, 0600 root:root, and nothing here writes it.
say "Installing to /opt/sente and starting"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  "sudo mkdir -p /opt/sente \
   && sudo cp -r ~/sente-deploy/. /opt/sente/ \
   && printf '# compose interpolation only. Secrets are in api.env (0600 root:root).\nSENTE_API_TAG=%s\n' '${SENTE_API_TAG:-latest}' | sudo tee /opt/sente/.env >/dev/null \
   && sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/sente/state \
   && cd /opt/sente \
   && sudo docker compose up -d \
   && sudo docker compose ps \
   && sudo docker image prune -f >/dev/null"

# STATE_DIR lives on the host at /var/lib/sente/state, owned by uid 1000 — the
# image's `node` user. Root-owned would make every wallet registration EACCES,
# and `install -d` is idempotent, so this runs on every deploy and cannot drift.
# `image prune -f` removes DANGLING images only: every sente-api:<sha> stays, so
# the rollback tags survive while the disk does not fill.

if [ "$SKIP_API" != 1 ]; then
  say "Waiting for the API's health check to pass"
  for _ in $(seq 1 30); do
    state="$(gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet \
      --command "sudo docker inspect -f '{{.State.Health.Status}}' sente-api" 2>/dev/null || true)"
    echo "    $state"
    [ "$state" = healthy ] && break
    [ "$state" = unhealthy ] && break
    sleep 5
  done
  if [ "${state:-}" != healthy ]; then
    echo
    echo "    The API is not healthy. Its boot log says why — a bad environment is"
    echo "    a failed boot here by design, and it names the variable:"
    echo "      gcloud compute ssh $NAME --project $PROJECT --zone $ZONE --command 'sudo docker logs --tail 50 sente-api'"
  fi
fi

say "Verifying"
sleep 5
SKIP_API="$SKIP_API" API_HOST="$API_HOST" ./verify.sh "$SITE_HOST"
