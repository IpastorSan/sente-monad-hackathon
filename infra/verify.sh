#!/usr/bin/env bash
# Checks what breaks silently:
#
#   the site   a redirect on the apex, and the wrong content type on the AASA —
#              either one kills passkey association with no useful error;
#   the web    the SPA fallback answering /.well-known/* with index.html (200,
#              HTML — Android stops trusting the app, silently), or the app
#              itself not loading (SEN-168);
#   the API    session auth not enforced, placeholder auth left on, or the public
#              webhook accepting an unsigned body. Each of those looks like a
#              working deployment from the outside;
#   the Perpl proxy  the web build's only way to Perpl (SEN-175): a WebSocket
#              that stops upgrading for sente.lol, or CORS headers gone, and
#              web perps fail with a bare network error.
#
# Run against the live host once DNS points at the box:  ./verify.sh
#
#   API_HOST=…   default api.<host>
#   SKIP_API=1   site only (deploy.sh passes this when it skipped the API)
#   SKIP_WEB=1   no web-app checks (deploy.sh passes this when it skipped the web)
#   SITE_BASE=…  the apex's base URL outright, default https://<host>. For a
#                local Caddy on a high port with `local_certs`, e.g.
#                SITE_BASE=https://sente.lol:8443 with a $CURL_HOME/.curlrc
#                holding `insecure` and `resolve = sente.lol:8443:127.0.0.1`
#                (docs/deploy.md, "Web app").
#   API_BASE=…   the API's base URL outright, overriding API_HOST. For pointing
#                the API half of this script at a locally running API
#                (http://127.0.0.1:3399) while writing or changing it.
#
# Every check here is a read, or a write that MUST be refused. Nothing in this
# script needs a session, a key or a secret, so it runs from anywhere — and it
# should be run from somewhere that is not this LAN. See infra/smoke.sh for the
# flow that actually signs in.
set -uo pipefail

HOST="${1:-sente.lol}"
API_HOST="${API_HOST:-api.$HOST}"
SKIP_API="${SKIP_API:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
SITE="${SITE_BASE:-https://$HOST}"
fail=0

# The placeholder check reads `site/.well-known/*`, so anchor it to this script
# rather than to the caller's working directory.
cd "$(dirname "${BASH_SOURCE[0]}")"

check () { # $1=url  $2=expected content-type substring
  local url="$1" want="$2"
  local code ctype redirects
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null) || { echo "  ✗ $url — unreachable"; fail=1; return; }
  redirects=$(curl -sS -o /dev/null -w '%{num_redirects}' -L "$url" 2>/dev/null)
  ctype=$(curl -sS -o /dev/null -w '%{content_type}' "$url" 2>/dev/null)

  if [ "$code" != "200" ]; then
    echo "  ✗ $url — HTTP $code (want 200)"; fail=1
  elif [ "$redirects" != "0" ]; then
    echo "  ✗ $url — $redirects redirect(s); Apple and Google refuse to follow them"; fail=1
  elif [[ "$ctype" != *"$want"* ]]; then
    echo "  ✗ $url — Content-Type '$ctype' (want '$want')"; fail=1
  else
    echo "  ✓ $url — 200, no redirect, $ctype"
  fi
}

# $1=label  $2=url  $3=space-separated acceptable status codes  [$4=curl extra args…]
status () {
  local label="$1" url="$2" want="$3"; shift 3
  local code
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null) \
    || { echo "  ✗ $label — unreachable ($url)"; fail=1; return; }
  if [[ " $want " == *" $code "* ]]; then
    echo "  ✓ $label — HTTP $code"
  else
    echo "  ✗ $label — HTTP $code (want one of: $want)   $url"; fail=1
  fi
}

# $1=label  $2=url  $3=substring the body must contain
body_has () {
  local label="$1" url="$2" want="$3"
  local out
  out=$(curl -sS -m 15 "$url" 2>/dev/null) || { echo "  ✗ $label — unreachable ($url)"; fail=1; return; }
  if [[ "$out" == *"$want"* ]]; then
    echo "  ✓ $label — body contains $want"
  else
    echo "  ✗ $label — body does not contain $want; got: ${out:0:160}"; fail=1
  fi
}

# $1=label  $2=url  $3=header line the response must carry (case-insensitive
# name, exact value)  [$4=curl extra args…]
header_has () {
  local label="$1" url="$2" want="$3"; shift 3
  local out
  out=$(curl -sS -m 15 -o /dev/null -D - "$@" "$url" 2>/dev/null | tr -d '\r') \
    || { echo "  ✗ $label — unreachable ($url)"; fail=1; return; }
  if grep -qix "$want" <<<"$out"; then
    echo "  ✓ $label — $want"
  else
    echo "  ✗ $label — no '$want' header   $url"; fail=1
  fi
}

# $1=label  $2=wss url  $3=Origin. A WebSocket handshake must be a 101. curl
# holds the upgraded connection open until -m expires, so its exit code is not
# the verdict: the status line it printed is.
ws_upgrade () {
  local label="$1" url="$2" origin="$3" code
  code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' --http1.1 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $origin" \
    "${url/#wss:/https:}" 2>/dev/null)
  if [ "$code" = "101" ]; then
    echo "  ✓ $label — 101 Switching Protocols"
  else
    echo "  ✗ $label — HTTP ${code:-none} (want 101)   $url"; fail=1
  fi
}

# $1=label  $2=url — the body must parse as JSON. Android reads the file, so a
# 200 with the right header around a truncated or HTML body is still a failure.
json_body () {
  local label="$1" url="$2" out
  out=$(curl -sS -m 15 "$url" 2>/dev/null) || { echo "  ✗ $label — unreachable ($url)"; fail=1; return; }
  if printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    echo "  ✓ $label — body parses as JSON"
  else
    echo "  ✗ $label — body is not JSON; got: ${out:0:160}"; fail=1
  fi
}

echo "Checking $SITE"
check "$SITE/.well-known/assetlinks.json" "json"
json_body "assetlinks.json" "$SITE/.well-known/assetlinks.json"
# THE ONE THAT PROTECTS PASSKEYS, and it runs even with SKIP_WEB=1 because the
# Caddyfile's fallback is live either way. The app's catch-all serves index.html
# for any path it does not know; if that ever reached /.well-known/, a missing
# association file would come back 200 text/html and this would be a 200.
status "/.well-known/does-not-exist is a 404, not the app" "$SITE/.well-known/does-not-exist" "404"

if [ "$SKIP_WEB" = 1 ]; then
  echo
  echo "Web-app checks skipped (SKIP_WEB=1)."
else
  echo
  echo "Checking the web app on $SITE"

  check "$SITE/" "text/html"
  body_has "/ is the app shell" "$SITE/" 'id="root"'
  body_has "/ loads the bundle" "$SITE/" '/_expo/static/js/'

  # The SPA fallback: a client-side route must be the very same index.html.
  shell=$(curl -sS -m 15 "$SITE/" 2>/dev/null)
  deep=$(curl -sS -m 15 "$SITE/agents/anything" 2>/dev/null)
  status "/agents/anything answers" "$SITE/agents/anything" "200"
  if [ -n "$shell" ] && [ "$shell" = "$deep" ]; then
    echo "  ✓ /agents/anything is the same index.html as /"
  else
    echo "  ✗ /agents/anything is not the same body as / — the SPA fallback is broken"; fail=1
  fi

  # Skia's CanvasKit (SEN-164): every icon needs it, and browsers refuse to
  # stream-compile wasm served under any other type.
  check "$SITE/canvaskit.wasm" "application/wasm"
fi

echo
echo "Placeholder check:"
for f in site/.well-known/*; do
  if grep -q 'REPLACE_' "$f" 2>/dev/null; then
    echo "  ✗ $(basename "$f") still contains REPLACE_ placeholders"; fail=1
  else
    echo "  ✓ $(basename "$f") has no placeholders"
  fi
done

if [ "$SKIP_API" = 1 ]; then
  echo
  echo "API checks skipped (SKIP_API=1)."
else
  API="${API_BASE:-https://$API_HOST}"
  echo
  echo "Checking $API"

  # 1. Up at all, over TLS, on its own name.
  status "GET /health" "$API/health" "200"
  body_has "GET /health says ok" "$API/health" '"status":"ok"'

  # 2. THE ONE THAT MATTERS MOST. `mode` is `placeholder` when AUTH_PLACEHOLDER
  #    is set, and then the x-sente-user-id header authenticates anyone who knows
  #    an address. The API refuses to boot that way under NODE_ENV=production —
  #    so this check is really "is this box running as production at all".
  body_has "GET /auth mode is session, not placeholder" "$API/auth" '"mode":"session"'

  # 3. A guarded route with no credential, and with a forged one.
  status "GET /wallet without a token is refused" "$API/wallet" "401"
  status "GET /wallet with a junk token is refused" "$API/wallet" "401" \
    -H 'authorization: Bearer not-a-token'
  # The header the placeholder mode would have trusted. 401 here says it is off
  # even if something else about /auth ever changes shape.
  status "x-sente-user-id header does not authenticate" "$API/wallet" "401" \
    -H 'x-sente-user-id: 0x0000000000000000000000000000000000000001'

  # 4. The public route that writes. 401 = configured and rejecting a forged
  #    HMAC; 503 = ALCHEMY_WEBHOOK_SIGNING_KEY unset, which refuses everything
  #    including real deliveries. Anything else — a 200 above all — means an
  #    unsigned body was accepted on a route anyone on the internet can call.
  status "POST /webhooks/alchemy refuses a forged signature" "$API/webhooks/alchemy" "401 503" \
    -X POST -H 'content-type: application/json' \
    -H 'X-Alchemy-Signature: 0000000000000000000000000000000000000000000000000000000000000000' \
    --data '{"type":"ADDRESS_ACTIVITY","id":"forged","event":{"activity":[]}}'

  # 5. The API host must NOT serve association files. The rpId is the apex and a
  #    second copy of assetlinks.json on a subdomain is a second thing to keep in
  #    sync, for no benefit — a passkey scoped to sente.lol already works here.
  status "api host serves no assetlinks.json" "$API/.well-known/assetlinks.json" "404"

  # 6. The Perpl proxy (SEN-175). Perpl testnet refuses browser origins, so the
  #    web build trades through /perpl/*. Each of these fails silently in the
  #    app: a WebSocket 403 or a missing CORS header both surface as a vague
  #    network error on the ticket, never as a deploy problem.
  PERPL="$API/perpl"
  ws_upgrade "Perpl trading socket through the proxy, Origin sente.lol" \
    "${PERPL/#https:/wss:}/ws/v1/trading" "https://sente.lol"
  status "Perpl context through the proxy" "$PERPL/api/v1/pub/context" "200" \
    -H 'Origin: https://sente.lol'
  header_has "Perpl context is readable from sente.lol" "$PERPL/api/v1/pub/context" \
    'access-control-allow-origin: https://sente.lol' -H 'Origin: https://sente.lol'
  # The trader's clock sync reads Date; unexposed, the browser hides it.
  header_has "Perpl context exposes Date" "$PERPL/api/v1/pub/context" \
    'access-control-expose-headers: Date' -H 'Origin: https://sente.lol'
  status "Perpl preflight answered at the edge" "$PERPL/api/v1/pub/context" "204" \
    -X OPTIONS -H 'Origin: https://sente.lol' -H 'Access-Control-Request-Method: POST'
  # Tight: no other site may borrow the proxy, and nothing of Perpl's but its API.
  status "Perpl proxy refuses another origin" "$PERPL/api/v1/pub/context" "403" \
    -H 'Origin: https://example.com'
  status "Perpl proxy serves only /api and /ws" "$PERPL/" "404"

  # 7. And the apex must still be the apex. A misplaced proxy directive that sent
  #    /.well-known/* to Nest would show up as a 404 in the first check, but a
  #    whole-apex redirect would not — so assert the site root separately.
  status "apex still answers without a redirect" "$SITE/" "200"
fi

echo
[ "$fail" -eq 0 ] && echo "PASS" || echo "FAIL — see above"
exit "$fail"
