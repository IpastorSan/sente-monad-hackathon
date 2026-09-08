#!/usr/bin/env bash
# One-time provisioning of the Sente host on GCE.
#
# Creates: a static external IP, firewall rules for 80/443, and an e2-micro
# running Debian 12 with Docker + the compose plugin.
#
# Idempotent-ish: every step tolerates the resource already existing, so a
# partial run can be re-run.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=your-gcp-project}"
ZONE="${ZONE:?set ZONE, e.g. us-central1-a (free tier) or europe-southwest1-a (Madrid)}"
REGION="${ZONE%-*}"
NAME="${NAME:-sente-web}"
MACHINE="${MACHINE:-e2-micro}"

say () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Project $PROJECT, zone $ZONE, machine $MACHINE"

say "Enabling compute API (no-op if already on)"
gcloud services enable compute.googleapis.com --project "$PROJECT"

say "Reserving static IP ${NAME}-ip in $REGION"
gcloud compute addresses create "${NAME}-ip" \
  --project "$PROJECT" --region "$REGION" 2>/dev/null \
  || echo "    (already exists)"

IP=$(gcloud compute addresses describe "${NAME}-ip" \
  --project "$PROJECT" --region "$REGION" --format='value(address)')

say "Firewall: allow 80/443 to tag http-server,https-server"
gcloud compute firewall-rules create "${NAME}-allow-web" \
  --project "$PROJECT" --allow tcp:80,tcp:443 \
  --target-tags http-server,https-server \
  --description "Caddy on ${NAME}" 2>/dev/null \
  || echo "    (already exists)"

say "Creating $NAME"
gcloud compute instances create "$NAME" \
  --project "$PROJECT" --zone "$ZONE" \
  --machine-type "$MACHINE" \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --address "$IP" \
  --tags http-server,https-server \
  --metadata-from-file startup-script=startup.sh 2>/dev/null \
  || echo "    (already exists)"

cat <<MSG

------------------------------------------------------------------
Static IP: $IP

NEXT, and nothing works until you do it:

  1. Point DNS at the box. At your registrar for sente.lol:
         A   @     $IP
         A   www   $IP
     Caddy cannot obtain a certificate until these resolve — ACME
     validates by being reached over the public name.

  2. Wait for propagation, then check:
         dig +short sente.lol

  3. Deploy:  ./deploy.sh

Let's Encrypt rate-limits failed authorisations, so do NOT run deploy
in a loop while DNS is still propagating.
------------------------------------------------------------------
MSG
