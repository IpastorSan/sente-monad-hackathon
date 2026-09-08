#!/usr/bin/env bash
# Copies infra/ to the box and brings Caddy up. Safe to re-run.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-sente-web}"

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

# scp runs as the SSH user, and /opt/sente is root-owned, so stage in $HOME
# and move it into place with sudo rather than loosening permissions on /opt.
echo "==> Staging to $NAME:~/sente-deploy"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  'rm -rf ~/sente-deploy && mkdir -p ~/sente-deploy'

gcloud compute scp --recurse Caddyfile docker-compose.yml site \
  "$NAME:~/sente-deploy/" --project "$PROJECT" --zone "$ZONE"

echo "==> Installing to /opt/sente and starting Caddy"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  'sudo mkdir -p /opt/sente \
   && sudo cp -r ~/sente-deploy/. /opt/sente/ \
   && cd /opt/sente \
   && sudo docker compose up -d \
   && sudo docker compose ps' 

echo "==> Verifying"
sleep 5
./verify.sh
