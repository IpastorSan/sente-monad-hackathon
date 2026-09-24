#!/usr/bin/env bash
# The smoke test for a DEPLOYED Sente API. SEN-51.
#
#   ./smoke.sh [https://api.sente.lol]
#
# RUN IT FROM A NETWORK THAT IS NOT THE LAN THE API WAS DEVELOPED ON. A phone
# hotspot is enough. Every failure this catches — a certificate the box serves
# but nothing trusts, a firewall rule that only ever allowed the office, DNS that
# resolves on one resolver and not the public one, a webhook URL Alchemy cannot
# reach — looks like success from inside.
#
# What it does, and does not, prove:
#
#   proves    TLS is trusted by a stranger's trust store; the API is up; session
#             auth is enforced and placeholder auth is off; the full
#             challenge -> signature -> token -> guarded route flow works; the
#             public webhook refuses an unsigned body; and the apex still serves
#             assetlinks.json with no redirect.
#   does NOT  prove a real Alchemy delivery lands a deposit on an agent's Ledger.
#             That needs a hire, a transfer and Alchemy's own dashboard — the
#             last section prints what to do, and docs/alchemy.md §5-6 is the
#             runbook. It also does not touch a phone: the APK is its own check
#             (docs/deploy.md, "The release APK").
#
# It writes nothing, funds nothing and needs no secret. The one key involved is
# generated and discarded by smoke-sign.mjs. Safe to run repeatedly, including
# against a live demo.
set -uo pipefail

API="${1:-${API:-https://api.sente.lol}}"
API="${API%/}"
SITE="${SITE:-https://sente.lol}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
fail=0

pass () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad  () { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }

# $1=label $2=method $3=url $4=acceptable codes  [$5…=curl args]
# Leaves the status it saw in $LAST_CODE, so a caller that wants to say something
# about WHICH acceptable code came back does not have to make the request twice.
LAST_CODE=''
expect () {
  local label="$1" method="$2" url="$3" want="$4"; shift 4
  LAST_CODE=''
  local code
  code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X "$method" "$@" "$url" 2>/dev/null) \
    || { bad "$label — unreachable ($url)"; return; }
  LAST_CODE="$code"
  if [[ " $want " == *" $code "* ]]; then pass "$label — HTTP $code"
  else bad "$label — HTTP $code, wanted one of: $want   ($url)"; fi
}

say "1. TLS, from this network's point of view"
# ssl_verify_result is curl's own verdict using the local trust store. 0 means a
# stranger's phone will trust it too; anything else means the Let's Encrypt
# certificate is missing, expired, or for the wrong name — and a phone gives no
# useful error when that happens, it just fails to sign in.
if [[ "$API" != https://* ]]; then
  # curl reports ssl_verify_result=0 for a plain http URL too, so asserting on it
  # there would be a check that can never fail. Say so instead.
  bad "$API is not https, so there is nothing to verify. A deployed API must be
      https — that is how Alchemy reaches it and the only way a phone will."
else
  verdict=$(curl -sS -m 20 -o /dev/null -w '%{ssl_verify_result}' "$API/health" 2>/dev/null)
  if [ "$verdict" = 0 ]; then pass "$API presents a trusted certificate"
  else bad "$API certificate not trusted (curl ssl_verify_result=$verdict)"; fi
fi

say "2. The API is up"
health=$(curl -sS -m 20 "$API/health" 2>/dev/null)
if [ "$health" = '{"status":"ok"}' ]; then pass "GET /health -> $health"
else bad "GET /health -> '${health:-nothing}' (want {\"status\":\"ok\"})"; fi

say "3. Auth is real auth"
mode=$(curl -sS -m 20 "$API/auth" 2>/dev/null)
case "$mode" in
  *'"mode":"session"'*) pass "GET /auth -> mode=session" ;;
  *'"mode":"placeholder"'*)
    bad "GET /auth -> mode=PLACEHOLDER. The x-sente-user-id header authenticates
      anyone who knows an address. This box is not running as production — the
      API refuses to boot this way under NODE_ENV=production, so something is
      setting NODE_ENV to something else." ;;
  *) bad "GET /auth -> '${mode:-nothing}'" ;;
esac
expect "GET /wallet with no token is refused" GET "$API/wallet" "401"
expect "GET /wallet with a junk token is refused" GET "$API/wallet" "401" \
  -H 'authorization: Bearer not-a-token'
expect "the legacy x-sente-user-id header does not authenticate" GET "$API/wallet" "401" \
  -H 'x-sente-user-id: 0x0000000000000000000000000000000000000001'
expect "POST /auth/session with a junk signature is refused" POST "$API/auth/session" "400 401" \
  -H 'content-type: application/json' \
  --data '{"address":"0x0000000000000000000000000000000000000001","signature":"0xdeadbeef"}'

say "4. The challenge flow, end to end, with a key made up on the spot"
if signed=$("$NODE_BIN" "$HERE/smoke-sign.mjs" "$API" 2>&1); then
  eval "$signed"
  pass "POST /auth/challenge -> signed -> POST /auth/session minted a token for ${SMOKE_ADDRESS}"

  # 404 is the CORRECT answer here and the one to expect: the token is valid, the
  # guard let it through, and this brand-new address has no registered wallet
  # (`GET /wallet` is 404 until POST /wallet/register). A 401 would mean the
  # token the API just minted does not verify — the one failure mode that looks
  # like working auth until a real user hits it.
  expect "GET /wallet with that token passes the guard" GET "$API/wallet" "200 404" \
    -H "authorization: Bearer $SMOKE_TOKEN"
  expect "GET /agents with that token" GET "$API/agents" "200" \
    -H "authorization: Bearer $SMOKE_TOKEN"
  expect "GET /credits with that token" GET "$API/credits" "200 404 503" \
    -H "authorization: Bearer $SMOKE_TOKEN"
else
  bad "the challenge flow failed:"
  printf '      %s\n' "$signed"
  echo "      (needs a repo checkout with node_modules — \`mise exec -- pnpm install\` — because"
  echo "       smoke-sign.mjs imports viem from it.)"
fi

say "5. The Alchemy webhook path"
# 401 = configured and rejecting a forged HMAC. 503 = ALCHEMY_WEBHOOK_SIGNING_KEY
# unset, so it refuses EVERYTHING including real deliveries — which is safe but
# means no deposit will ever appear on a Ledger. Anything else, especially 200,
# means an unsigned body was accepted on the one public route that writes.
expect "POST /webhooks/alchemy refuses a forged signature" POST "$API/webhooks/alchemy" "401 503" \
  -H 'content-type: application/json' \
  -H 'X-Alchemy-Signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  --data '{"type":"ADDRESS_ACTIVITY","id":"forged","event":{"activity":[]}}'
expect "POST /webhooks/alchemy refuses a missing signature" POST "$API/webhooks/alchemy" "401 503" \
  -H 'content-type: application/json' \
  --data '{"type":"ADDRESS_ACTIVITY","id":"unsigned","event":{"activity":[]}}'
if [ "$LAST_CODE" = 503 ]; then
  echo "      NOTE: 503 means ALCHEMY_WEBHOOK_SIGNING_KEY is unset on the box, so"
  echo "      Alchemy's own deliveries are refused too and no deposit can land."
fi

say "6. The apex, which must not have regressed"
# The rpId is sente.lol and this file is how the platform associates the app with
# it. A redirect or a non-200 here breaks every user's passkey, and therefore
# every user's wallet (../CLAUDE.md, "Permanent, unchangeable values").
code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$SITE/.well-known/assetlinks.json" 2>/dev/null)
redirects=$(curl -sS -m 20 -o /dev/null -w '%{num_redirects}' -L "$SITE/.well-known/assetlinks.json" 2>/dev/null)
if [ "$code" = 200 ] && [ "$redirects" = 0 ]; then
  pass "$SITE/.well-known/assetlinks.json — 200, no redirect"
else
  bad "$SITE/.well-known/assetlinks.json — HTTP $code, $redirects redirect(s)"
fi
# And that the fingerprint the release APK must match is actually being served.
if curl -sS -m 20 "$SITE/.well-known/assetlinks.json" 2>/dev/null \
   | grep -q '15:FA:4B:41:D1:C8:44:C2:F7:9F:B7:B8:3A:5D:B6:6D:39:B8:1E:8C:D3:46:90:F8:C3:A1:6B:55:9F:AF:36:55'; then
  pass "the RELEASE fingerprint is in the served assetlinks.json"
else
  bad "the release fingerprint is NOT in the served assetlinks.json. A release APK
      will install and run and fail at the passkey, with no useful error.
      Fix: re-run deploy.sh so the box picks up infra/site/.well-known/."
fi

say "7. What this script cannot prove — do these by hand"
cat <<'MSG'
  a) A REAL Alchemy delivery landing a deposit. docs/alchemy.md §5-6:
       - dashboard -> the webhook -> Test Webhook, expect 200 {"received":true,…}
       - hire an agent, send its wallet MON or a token
       - GET /agents/:id/events?kind=deposit carries one `deposit`
  b) STATE SURVIVES A REDEPLOY. Register a wallet and hire an agent, redeploy,
     then confirm both are still there. That is what STATE_DIR is for and the
     only check that proves the bind mount is really mounted.
  c) The release APK on a phone that has never seen this repo: installs, signs in
     with a passkey, and reaches this API. docs/deploy.md has the recipe and the
     fingerprint check.
MSG

say "$([ "$fail" -eq 0 ] && echo 'SMOKE PASS' || echo 'SMOKE FAIL — see above')"
exit "$fail"
