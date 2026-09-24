#!/usr/bin/env bash
# Delivers the API's secrets to the box, out of band. SEN-51.
#
#   PROJECT=… ZONE=… ./push-secrets.sh [path-to-env-file]      (default ../.env)
#   DRY_RUN=1 ./push-secrets.sh [path]     filter and pre-flight only, no SSH,
#                                          no PROJECT needed. Run this first.
#
# WHAT "OUT OF BAND" MEANS HERE, and why each half of it matters:
#
#   - never committed        `.env` is gitignored and this script reads it, it
#                            does not write one;
#   - never in an image      services/api/Dockerfile has no ARG and copies no
#                            env file, so no layer can hold a secret and no
#                            `docker history` can print one;
#   - never a build arg      same reason — a build arg is recorded in the image;
#   - never on a shell line  the values go through a file and scp, so they never
#                            appear in an argv anyone can read in `ps`, and
#                            never in your shell history;
#   - never echoed           this script prints key names and "set"/"empty",
#                            never a value. Nor does it log one on failure.
#
# The file lands at /opt/sente/api.env, 0600 root:root. `docker compose` reads it
# as root at `up` time (infra/docker-compose.yml, `env_file`), so the container
# gets the values in its environment and nothing else on the box can read them.
#
# WHY NOT SECRET MANAGER: it is the better answer for anything long-lived and
# it is written up in docs/deploy.md, "Decisions still open". It needs an API
# enabled, a service account binding and a fetch-on-boot shim; this is one file
# with one owner and one mode, it is reviewable in full, and it is what a single
# demo box needs. The upgrade path does not change anything above.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" = 1 ]; then PROJECT="${PROJECT:-dry-run}"; else PROJECT="${PROJECT:?set PROJECT}"; fi
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-sente-web}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$HERE/../.env}"
ALLOWLIST="$HERE/api-env.allowlist"
REMOTE_PATH=/opt/sente/api.env

say () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die () { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -r "$SRC" ] || die "no readable env file at $SRC (pass one as \$1)"
[ -r "$ALLOWLIST" ] || die "missing $ALLOWLIST"

# The staging file. 0600 from the moment it exists — created by `install`, not by
# a redirect, because `> file` opens at the umask and only then would a chmod
# narrow it. Removed on every exit path, including a failure or a Ctrl-C.
STAGE="$(mktemp -t sente-api-env.XXXXXX)"
chmod 600 "$STAGE"
cleanup () {
  # `shred` if the coreutils build has it, otherwise overwrite then unlink. The
  # file is small and on whatever /tmp is; on a journalled or COW filesystem
  # neither is a guarantee, which is why the staging copy is short-lived rather
  # than trusted to be unrecoverable.
  if command -v shred >/dev/null 2>&1; then shred -u "$STAGE" 2>/dev/null || rm -f "$STAGE"
  else rm -f "$STAGE"; fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Read the allowlist
# ---------------------------------------------------------------------------
ALLOW=()
DENY_KEYS=()
DENY_WHY=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
    'DENY '*)
      rest="${line#DENY }"
      key="${rest%%[[:space:]]*}"
      why="${rest#"$key"}"
      why="${why#"${why%%[![:space:]]*}"}"
      DENY_KEYS+=("$key"); DENY_WHY+=("$why")
      ;;
    *) ALLOW+=("${line%%[[:space:]]*}") ;;
  esac
done < "$ALLOWLIST"

allowed () { local k="$1" a; for a in "${ALLOW[@]}"; do [ "$a" = "$k" ] && return 0; done; return 1; }

# Returns the reason when $1 is denied, empty when it is not.
denied_why () {
  local k="$1" i pat
  for i in "${!DENY_KEYS[@]}"; do
    pat="${DENY_KEYS[$i]}"
    if [ "${pat%\*}" != "$pat" ]; then
      case "$k" in "${pat%\*}"*) printf '%s' "${DENY_WHY[$i]}"; return ;; esac
    elif [ "$pat" = "$k" ]; then
      printf '%s' "${DENY_WHY[$i]}"; return
    fi
  done
}

# ---------------------------------------------------------------------------
# Filter. Values are never printed, only key names and whether they are set.
# ---------------------------------------------------------------------------
say "Reading $SRC against api-env.allowlist"
{
  echo "# services/api production environment. Written by infra/push-secrets.sh."
  echo "# 0600 root:root. NOT a backup — the source of truth is your local .env."
  echo "# NODE_ENV, PORT and STATE_DIR are pinned in docker-compose.yml and"
  echo "# deliberately absent here: \`environment\` outranks \`env_file\`."
} >> "$STAGE"

copied=0
unknown=()
secret_raw=''
precheck_raw='__unset__'
owner_raw='__unset__'

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"
  key="${key#export }"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  value="${line#*=}"

  why="$(denied_why "$key")"
  if [ -n "$why" ]; then
    printf '  · %-32s SKIPPED — %s\n' "$key" "$why"
    continue
  fi
  if ! allowed "$key"; then
    unknown+=("$key")
    continue
  fi

  # Remember three values for the pre-flight checks below, then forget them.
  case "$key" in
    AUTH_SESSION_SECRET) secret_raw="$value" ;;
    AGENT_PRECHECK) precheck_raw="$value" ;;
    AGENT_MANDATE_OWNER) owner_raw="$value" ;;
  esac

  if [ -z "$(printf '%s' "$value" | tr -d '[:space:]')" ]; then
    printf '  · %-32s empty — not written (the API treats absent and empty alike)\n' "$key"
    continue
  fi
  printf '%s=%s\n' "$key" "$value" >> "$STAGE"
  printf '  ✓ %-32s set\n' "$key"
  copied=$((copied + 1))
done < "$SRC"

if [ "${#unknown[@]}" -gt 0 ]; then
  echo
  echo "  NOT ON EITHER LIST, so not deployed. Add each to api-env.allowlist or to"
  echo "  its DENY section, with a reason — do not leave it undecided:"
  printf '    %s\n' "${unknown[@]}"
fi

# ---------------------------------------------------------------------------
# Pre-flight: the refusals the API would hit at boot, caught here instead, where
# the failure costs nothing. Verified against services/api on 2026-09-24 by
# booting it with each of these environments — see docs/deploy.md.
# ---------------------------------------------------------------------------
say "Pre-flight"
hex="${secret_raw#0x}"
hex="$(printf '%s' "$hex" | tr -d '[:space:]')"
if [ -z "$hex" ]; then
  die "AUTH_SESSION_SECRET is not set in $SRC. Under NODE_ENV=production the API
       refuses to boot without it, and AUTH_PLACEHOLDER is not an option there.
       Generate one:  openssl rand -hex 32"
fi
[[ "$hex" =~ ^[0-9a-fA-F]{64}$ ]] \
  || die "AUTH_SESSION_SECRET must be 32 bytes of hex (64 characters, optionally 0x-prefixed). Length seen: ${#hex}."
echo "  ✓ AUTH_SESSION_SECRET is 32 bytes of hex"
echo "  ✓ AUTH_PLACEHOLDER not written (it is on the DENY list)"

case "$precheck_raw" in
  __unset__|''|on) echo "  ✓ AGENT_PRECHECK is on or absent" ;;
  off) die "AGENT_PRECHECK=off leaves Perpl order size and leverage with no check
       outside the enclave, and the API refuses to boot with it under
       NODE_ENV=production. It exists for the local refusal demo only." ;;
  *) die "AGENT_PRECHECK='$precheck_raw' is neither on nor off; the API fails the boot on it rather than guessing." ;;
esac

case "$owner_raw" in
  server) die "AGENT_MANDATE_OWNER=server makes this server able to amend and revoke
       a user's mandate, and the API refuses to boot with it under
       NODE_ENV=production. Unset it (device is the default)." ;;
  *) echo "  ✓ AGENT_MANDATE_OWNER is not 'server'" ;;
esac

[ "$copied" -gt 0 ] || die "nothing to push"

if ! grep -q '^MONAD_WS_URL=' "$STAGE"; then
  echo "  ! MONAD_WS_URL is not set. The consensus service will fall back to"
  echo "    eth_getBlockByNumber over HTTP and can never report 'Verified'."
fi
if ! grep -q '^ALCHEMY_WEBHOOK_SIGNING_KEY=' "$STAGE"; then
  echo "  ! ALCHEMY_WEBHOOK_SIGNING_KEY is not set. POST /webhooks/alchemy will"
  echo "    answer 503 webhook_unconfigured to everything, including Alchemy."
fi

# ---------------------------------------------------------------------------
# Deliver
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN — nothing left this machine"
  echo "  would write $copied variables to $NAME:$REMOTE_PATH (0600 root:root):"
  grep -oE '^[A-Za-z_][A-Za-z0-9_]*' "$STAGE" | sed 's/^/    /'
  exit 0
fi

say "Copying $copied variables to $NAME:$REMOTE_PATH"
# Staged in $HOME because scp runs as the SSH user and /opt/sente is root-owned
# — the same reason deploy.sh stages there. `install` sets the mode as it
# copies, so the file is never briefly world-readable in /opt.
gcloud compute scp "$STAGE" "$NAME:~/api.env.incoming" \
  --project "$PROJECT" --zone "$ZONE"
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  "sudo mkdir -p /opt/sente \
   && sudo install -o root -g root -m 0600 ~/api.env.incoming $REMOTE_PATH \
   && (shred -u ~/api.env.incoming 2>/dev/null || rm -f ~/api.env.incoming) \
   && sudo ls -l $REMOTE_PATH \
   && echo \"variables: \$(sudo grep -c '^[A-Z]' $REMOTE_PATH)\""

cat <<'MSG'

------------------------------------------------------------------
Secrets are on the box. They are NOT live yet — the container reads
the file at `up` time:

    PROJECT=… ZONE=… ./deploy.sh

Rotating one later is this script again, then that. Rotating
AUTH_SESSION_SECRET invalidates every live session, which is the point.
------------------------------------------------------------------
MSG
