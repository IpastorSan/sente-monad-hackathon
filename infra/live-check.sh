#!/usr/bin/env bash
# Post-deploy live check, stage A (SEN-186; docs/testing/test-audit-2026-10-09.md,
# tier 3). Every check is a READ: no transaction, no wallet, no key enrolled,
# so it is safe against production after every deploy. One line per check,
# `PASS|WARN|FAIL name — detail`, a summary, and a non-zero exit on any FAIL.
#
#   ./live-check.sh [--box] [site-host]          default host sente.lol
#
#   1. verify.sh, then smoke.sh, keeping smoke's throwaway session token;
#   2. with it, GET /markets: both venues ok, Kuru's symbols equal the pins in
#      packages/venues/src/kuru/constants.ts, Perpl lists BTC-PERP;
#   3. each pinned Kuru ticker and BTC-PERP's: stale:false, asOf under 60 s;
#   4. GET /trade/capabilities shows the trading flags this deploy should have;
#   5. GET /leaderboard reads a configured, reachable indexer;
#   6. the drift check (packages/venues/scripts/drift-check.ts).
#
#   --box  also, over `gcloud compute ssh` on the box itself:
#          Perpl's trading WebSocket answers the box with 101 (451 = Perpl
#          geoblocks the box's region, which is why it moved to Madrid), Perpl's
#          REST context and Kuru's API answer 200, the API container is healthy,
#          its STATE_DIR lock is held by a live pid, and the variable NAMES in
#          /opt/sente/api.env equal the names in the laptop .env that
#          api-env.allowlist lets through. Names only, never values.
#
# Environment:
#   API_BASE=…              the API's URL outright (default https://api.<host>)
#   EXPECT_TRADING=true     /trade/capabilities `enabled` (USER_TRADING)
#   EXPECT_TRADING_PERPL=true   `venues.perpl` (USER_TRADING_PERPL)
#   ENV_FILE=…              the laptop .env (default <repo>/.env): the box's
#                           expected names, and ENVIO_GRAPHQL_URL for the drift check
#   SKIP_API=1 SKIP_WEB=1   passed to verify.sh; SKIP_API=1 also skips every API check
#   SKIP_DRIFT=1            leave the drift check out
#   PROJECT ZONE NAME       the box (default plenary-anvil-491607-s6,
#                           europe-southwest1-a, sente-eu)
set -uo pipefail

BOX=0
HOST=sente.lol
for arg in "$@"; do
  case "$arg" in
    --box) BOX=1 ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    -*) echo "unknown option $arg" >&2; exit 2 ;;
    *) HOST="$arg" ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
API="${API_BASE:-https://api.$HOST}"
API="${API%/}"
SITE="https://$HOST"
EXPECT_TRADING="${EXPECT_TRADING:-true}"
EXPECT_TRADING_PERPL="${EXPECT_TRADING_PERPL:-true}"
export EXPECT_TRADING EXPECT_TRADING_PERPL
ENV_FILE="${ENV_FILE:-$REPO/.env}"
SKIP_API="${SKIP_API:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
SKIP_DRIFT="${SKIP_DRIFT:-0}"
PROJECT="${PROJECT:-plenary-anvil-491607-s6}"
ZONE="${ZONE:-europe-southwest1-a}"
NAME="${NAME:-sente-eu}"
NODE_BIN="${NODE_BIN:-$(cd "$REPO" && mise which node 2>/dev/null || command -v node)}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npass=0; nwarn=0; nfail=0
line () { # $1=PASS|WARN|FAIL  $2=name  $3=detail
  case "$1" in PASS) npass=$((npass + 1)) ;; WARN) nwarn=$((nwarn + 1)) ;; *) nfail=$((nfail + 1)) ;; esac
  printf '%s %s — %s\n' "$1" "$2" "$3"
}

# $1=name  $2…=command. PASS or FAIL on the exit code; on FAIL the command's
# own failure lines (✗, FAIL) are printed under it, so the reason is on screen.
run_script () {
  local name="$1"; shift
  local log="$TMP/$name.log" rc=0
  "$@" >"$log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    line PASS "$name" "$(grep -c '✓' "$log") checks passed"
  else
    line FAIL "$name" "exit $rc — $(grep -cE '✗|^FAIL' "$log") failing; see below"
    grep -E '✗|^FAIL' "$log" | sed 's/^/      /'
  fi
}

# JSON verdicts in python3 (verify.sh already needs it). Each prints
# `PASS|WARN|FAIL<TAB>detail`.
judge () { # $1=python body reading `d` (parsed stdin) and env; prints the verdict
  python3 -c "import json,os,sys,time
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('FAIL\tnot JSON: %s' % e); sys.exit()
$1"
}
emit () { # $1=name  $2=verdict. Not a pipe: `line` must count in this shell.
  local verdict="$2" status detail
  status="${verdict%%$'\t'*}"; detail="${verdict#*$'\t'}"
  line "$status" "$1" "$detail"
}

# $1=name  $2=path  $3=judge body. GET with smoke's token into $TMP/get.json;
# FAIL on a non-200, else the judge's verdict. Returns 1 on a non-200.
check_get () {
  local code
  code="$(curl -sS -m 20 -o "$TMP/get.json" -w '%{http_code}' \
    -H "authorization: Bearer $TOKEN" "$API$2" 2>/dev/null)"
  if [ "$code" != 200 ]; then
    line FAIL "$1" "HTTP ${code:-000} $(head -c 160 "$TMP/get.json" 2>/dev/null)"
    return 1
  fi
  emit "$1" "$(judge "$3" <"$TMP/get.json")"
}

echo "Live check: site $SITE, API $API$([ "$BOX" = 1 ] && echo ", box $NAME")"
echo

# ---------------------------------------------------------------------------
# 1. verify.sh and smoke.sh
# ---------------------------------------------------------------------------
run_script verify.sh env SKIP_API="$SKIP_API" SKIP_WEB="$SKIP_WEB" API_BASE="$API" \
  SITE_BASE="$SITE" "$HERE/verify.sh" "$HOST"

TOKEN=''
if [ "$SKIP_API" != 1 ]; then
  run_script smoke.sh env SITE="$SITE" NODE_BIN="$NODE_BIN" SMOKE_TOKEN_FILE="$TMP/token" \
    "$HERE/smoke.sh" "$API"
  TOKEN="$(cat "$TMP/token" 2>/dev/null || true)"
fi

# ---------------------------------------------------------------------------
# 2-5. Authenticated reads with smoke's session
# ---------------------------------------------------------------------------
if [ "$SKIP_API" = 1 ]; then
  line WARN "api reads" "skipped (SKIP_API=1)"
elif [ -z "$TOKEN" ]; then
  line FAIL "api reads" "smoke.sh minted no session token, so nothing authenticated can be checked"
else
  # The pinned Kuru symbols, from the constants themselves.
  PINS="$(cd "$REPO/packages/venues" && "$NODE_BIN" --no-warnings --input-type=module -e \
    "const m = await import('./src/kuru/constants.ts'); console.log(m.KURU_TESTNET_MARKETS.map((x) => x.symbol).join(' '))" 2>"$TMP/pins.err")"
  if [ -z "$PINS" ]; then
    line FAIL "kuru pins" "could not read KURU_TESTNET_MARKETS: $(head -c 200 "$TMP/pins.err")"
  fi
  export PINS

  if check_get "/markets venues" /markets '
bad=[v for v in d.get("venues",[]) if not v.get("ok")]
names={v.get("venue") for v in d.get("venues",[])}
missing=sorted({"kuru","perpl"}-names)
if missing or bad:
    print("FAIL\tvenues not ok: %s" % ", ".join(missing+["%s (%s)" % (v["venue"], v.get("error","")) for v in bad]))
else:
    print("PASS\tkuru and perpl ok")'; then
    emit "/markets kuru = pins" "$(judge '
pins=set(os.environ["PINS"].split())
kuru={m["symbol"] for m in d.get("markets",[]) if m.get("venue")=="kuru"}
if kuru==pins:
    print("PASS\t%s" % " ".join(sorted(kuru)))
else:
    print("FAIL\tserved [%s], pinned [%s]" % (" ".join(sorted(kuru)) or "none", " ".join(sorted(pins))))' <"$TMP/get.json")"
    emit "/markets perpl BTC-PERP" "$(judge '
perpl=[m["symbol"] for m in d.get("markets",[]) if m.get("venue")=="perpl"]
print(("PASS\tBTC-PERP among %d" if "BTC-PERP" in perpl else "FAIL\tBTC-PERP missing from %d") % len(perpl))' <"$TMP/get.json")"
  fi

  # 3. Tickers: every pinned Kuru market, and BTC-PERP.
  for pair in $(for s in $PINS; do echo "kuru/$s"; done) perpl/BTC-PERP; do
    check_get "ticker $pair" "/markets/$pair/ticker" '
age=time.time()-d.get("asOf",0)/1000
if d.get("stale") is not False:
    print("FAIL\tstale=%s" % d.get("stale"))
elif age>=60:
    print("FAIL\tasOf %.0f s old" % age)
elif all(d.get(k) is None for k in ("last","mid","bid","ask","mark")):
    print("WARN\tfresh (%.0f s) but no price at all: an empty book or an unlisted market" % age)
else:
    print("PASS\tfresh (%.0f s), mid %s" % (age, d.get("mid") or d.get("last")))'
  done

  # 4. Trading flags.
  check_get /trade/capabilities /trade/capabilities '
want_on=os.environ["EXPECT_TRADING"]=="true"
want_perpl=os.environ["EXPECT_TRADING_PERPL"]=="true" and want_on
got_on=d.get("enabled"); got_perpl=d.get("venues",{}).get("perpl")
if got_on==want_on and got_perpl==want_perpl:
    print("PASS\tenabled=%s perpl=%s" % (got_on, got_perpl))
else:
    print("FAIL\tenabled=%s perpl=%s, expected enabled=%s perpl=%s" % (got_on, got_perpl, want_on, want_perpl))'

  # 5. Leaderboard source.
  check_get "/leaderboard source" /leaderboard '
s=d.get("source",{})
if s.get("kind")=="ok":
    print("PASS\tsource ok, %d ranked, %d below the bar" % (len(d.get("ranked",[])), len(d.get("tooFewTrades",[]))))
else:
    print("FAIL\tsource %s: %s" % (s.get("kind"), s.get("message","")))'
fi

# ---------------------------------------------------------------------------
# 6. Drift check (it also measures the Envio lag)
# ---------------------------------------------------------------------------
if [ "$SKIP_DRIFT" = 1 ]; then
  line WARN "drift-check" "skipped (SKIP_DRIFT=1)"
else
  if (cd "$REPO/packages/venues" &&
      "$NODE_BIN" --no-warnings --env-file-if-exists="$ENV_FILE" scripts/drift-check.ts) \
      >"$TMP/drift.log" 2>&1; then
    line PASS drift-check "$(tail -n 1 "$TMP/drift.log")"
    grep -E '^WARN' "$TMP/drift.log" | sed 's/^/      /'
  else
    line FAIL drift-check "$(tail -n 1 "$TMP/drift.log")"
    grep -vE '^PASS|^$' "$TMP/drift.log" | grep -v '^DRIFT' | sed 's/^/      /'
  fi
fi

# ---------------------------------------------------------------------------
# --box: from the box's own network and disk
# ---------------------------------------------------------------------------
if [ "$BOX" = 1 ]; then
  # Read-only. Prints key=value lines; the env file contributes NAMES only.
  if ! gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --quiet --command 'bash -s' \
      >"$TMP/box.out" 2>"$TMP/box.err" <<'REMOTE'
code () { curl -sS -m "${2:-15}" -o /dev/null -w '%{http_code}' "${@:3}" "$1" 2>/dev/null; }
# No Origin header: that is how the API's own agents connect.
echo "ws=$(code https://testnet.perpl.xyz/ws/v1/trading 5 --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')"
echo "perpl_rest=$(code https://testnet.perpl.xyz/api/v1/pub/context)"
echo "kuru_api=$(code 'https://api.testnet.kuru.io/api/v1/markets?status=active&limit=1')"
echo "health=$(sudo docker inspect -f '{{.State.Health.Status}}' sente-api 2>/dev/null)"
lock=$(sudo cat /var/lib/sente/state/api.lock 2>/dev/null)
pid=$(printf '%s' "$lock" | sed -n 's/.*"pid":[[:space:]]*\([0-9]*\).*/\1/p')
host=$(printf '%s' "$lock" | sed -n 's/.*"hostname":[[:space:]]*"\([^"]*\)".*/\1/p')
echo "lock_pid=$pid"
echo "lock_host=$host"
echo "container_host=$(sudo docker inspect -f '{{.Config.Hostname}}' sente-api 2>/dev/null)"
if [ -n "$pid" ] && sudo docker exec sente-api node -e "process.kill($pid, 0)" 2>/dev/null; then
  echo "lock_alive=yes"
else
  echo "lock_alive=no"
fi
echo "env_names=$(sudo sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' /opt/sente/api.env 2>/dev/null | sort -u | tr '\n' ' ')"
REMOTE
  then
    line FAIL "box ssh" "gcloud compute ssh $NAME failed: $(tail -n 2 "$TMP/box.err" | tr '\n' ' ')"
  else
    declare -A box=()
    while IFS='=' read -r key value; do box[$key]="$value"; done <"$TMP/box.out"
    get () { printf '%s' "${box[$1]:-}"; }
    ws="$(get ws)"
    case "$ws" in
      101) line PASS "box perpl trading ws" "101 Switching Protocols, no Origin" ;;
      451) line FAIL "box perpl trading ws" "451: Perpl geoblocks this region" ;;
      *)   line FAIL "box perpl trading ws" "HTTP ${ws:-none} (want 101)" ;;
    esac
    [ "$(get perpl_rest)" = 200 ] && line PASS "box perpl rest" "context 200" \
      || line FAIL "box perpl rest" "context HTTP $(get perpl_rest)"
    [ "$(get kuru_api)" = 200 ] && line PASS "box kuru api" "markets 200" \
      || line FAIL "box kuru api" "markets HTTP $(get kuru_api)"
    [ "$(get health)" = healthy ] && line PASS "box container health" "sente-api healthy" \
      || line FAIL "box container health" "sente-api is '$(get health)'"
    if [ -z "$(get lock_pid)" ]; then
      line FAIL "box state lock" "no /var/lib/sente/state/api.lock, or no pid in it"
    elif [ "$(get lock_alive)" = yes ] && [ "$(get lock_host)" = "$(get container_host)" ]; then
      line PASS "box state lock" "held by pid $(get lock_pid) on $(get lock_host), alive"
    else
      line FAIL "box state lock" "pid $(get lock_pid) on '$(get lock_host)' (container '$(get container_host)'), alive=$(get lock_alive)"
    fi

    # The names push-secrets.sh would write from the laptop .env (its own
    # NAMES_ONLY mode, so one parser decides), against the names on the box.
    if ! expected="$(NAMES_ONLY=1 "$HERE/push-secrets.sh" "$ENV_FILE" 2>"$TMP/names.err")"; then
      line FAIL "box env names" "push-secrets.sh NAMES_ONLY failed on $ENV_FILE: $(head -c 200 "$TMP/names.err")"
    else
      box_names="$(get env_names)"
      sort -u <<<"$expected" >"$TMP/names.laptop"
      tr ' ' '\n' <<<"$box_names" | sed '/^$/d' | sort -u >"$TMP/names.box"
      missing="$(comm -23 "$TMP/names.laptop" "$TMP/names.box" | tr '\n' ' ')"
      extra="$(comm -13 "$TMP/names.laptop" "$TMP/names.box" | tr '\n' ' ')"
      if [ -z "$box_names" ]; then
        line FAIL "box env names" "could not read /opt/sente/api.env"
      elif [ -z "${missing// /}" ] && [ -z "${extra// /}" ]; then
        line PASS "box env names" "$(wc -w <<<"$box_names") names, equal to the allowlisted laptop names"
      else
        line FAIL "box env names" "missing on box: ${missing:-none}; only on box: ${extra:-none} (re-run push-secrets.sh)"
      fi
    fi
  fi
fi

echo
echo "LIVE CHECK $([ "$nfail" -eq 0 ] && echo PASS || echo FAIL): $npass pass, $nwarn warn, $nfail fail"
[ "$nfail" -eq 0 ]
