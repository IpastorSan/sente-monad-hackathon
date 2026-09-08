#!/usr/bin/env bash
# Copies infra/ to the box and brings Caddy up. Safe to re-run.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-sente-web}"

if grep -rq 'REPLACE_' site/.well-known/; then
  echo "Refusing to deploy: site/.well-known/ still contains REPLACE_ placeholders." >&2
  echo "Fill in the Apple team ID and both Android SHA-256 fingerprints first." >&2
  exit 1
fi

echo "==> Copying to $NAME:/opt/sente"
gcloud compute scp --recurse Caddyfile docker-compose.yml site \
  "$NAME:/opt/sente/" --project "$PROJECT" --zone "$ZONE"

echo "==> docker compose up -d"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --command \
  'cd /opt/sente && sudo docker compose up -d && sudo docker compose ps'

echo "==> Verifying"
sleep 5
./verify.sh
