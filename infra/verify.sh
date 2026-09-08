#!/usr/bin/env bash
# Checks the two things that silently break passkey association:
# a redirect on the apex, and the wrong content type on the AASA.
#
# Run against the live host once DNS points at the box:  ./verify.sh
set -uo pipefail

HOST="${1:-sente.lol}"
fail=0

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

echo "Checking https://$HOST"
check "https://$HOST/.well-known/apple-app-site-association" "application/json"
check "https://$HOST/.well-known/assetlinks.json" "json"

echo
echo "Placeholder check:"
for f in site/.well-known/*; do
  if grep -q 'REPLACE_' "$f" 2>/dev/null; then
    echo "  ✗ $(basename "$f") still contains REPLACE_ placeholders"; fail=1
  else
    echo "  ✓ $(basename "$f") has no placeholders"
  fi
done

echo
[ "$fail" -eq 0 ] && echo "PASS" || echo "FAIL — see above"
exit "$fail"
