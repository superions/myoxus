#!/usr/bin/env bash
# smoke-web-journeys.sh — End-to-end web journey verification (W1-04)
# Usage: ./smoke-web-journeys.sh [--api URL] [--frontend URL]
#
# Verifies 7 journeys: auth, workspaces, server config, docs, websocket, admin, REST.
# Exit code 0 = all pass, 1 = at least one failure.

set -euo pipefail

API_URL="${MYOXUS_API_URL:-http://localhost:3001}"
FRONTEND_URL="${MYOXUS_FRONTEND_URL:-http://localhost:3010}"
EMAIL="${E2E_ADMIN_EMAIL:-admin@myoxus.local}"
PASSWORD="${E2E_ADMIN_PASSWORD:-AdminMyoxus2026}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API_URL="$2"; shift 2 ;;
    --frontend) FRONTEND_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

COOKIE_JAR=$(mktemp /tmp/myoxus-cookies.XXXXXX)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0
FAIL=0
RESULTS=()

pass() { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1: $2"); echo "  FAIL  $1: $2"; }

gql() {
  curl -sf -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    "$API_URL/graphql" \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"$1\"}" 2>/dev/null || echo '{"errors":[{"message":"curl failed"}]}'
}

has_field() {
  echo "$1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
path = '$2'.split('.')
obj = data
for p in path:
    if isinstance(obj, dict) and p in obj:
        obj = obj[p]
    else:
        sys.exit(1)
if obj is None:
    sys.exit(1)
" 2>/dev/null
}

has_no_errors() {
  echo "$1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'errors' in data and data['errors']:
    sys.exit(1)
" 2>/dev/null
}

# ── Journey 1: Authentication ──────────────────────────────────────────
echo "Journey 1: Authentication"

SIGNIN=$(curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$API_URL/api/auth/sign-in" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>/dev/null || echo "")

if [ -n "$SIGNIN" ] && has_field "$SIGNIN" "data.id" 2>/dev/null || has_field "$SIGNIN" "id" 2>/dev/null; then
  pass "sign-in returns user object"
else
  fail "sign-in" "no user object returned"
fi

SESSION=$(curl -sf -b "$COOKIE_JAR" "$API_URL/api/auth/session" 2>/dev/null || echo "")
if [ -n "$SESSION" ] && has_field "$SESSION" "user.id"; then
  pass "session endpoint returns user"
else
  fail "session" "no user data"
fi

R=$(gql '{ currentUser { id name email } }')
if has_no_errors "$R" && has_field "$R" "data.currentUser.id" && has_field "$R" "data.currentUser.email"; then
  pass "GraphQL currentUser { id name email }"
else
  fail "GraphQL currentUser" "missing fields or errors"
fi

# ── Journey 2: Workspace Listing ──────────────────────────────────────
echo "Journey 2: Workspace Listing"

R=$(gql '{ workspaces { id name memberCount } }')
if has_no_errors "$R"; then
  WS_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['workspaces']))" 2>/dev/null || echo 0)
  if [ "$WS_COUNT" -gt 0 ]; then
    pass "workspaces query returns $WS_COUNT workspace(s)"
  else
    fail "workspaces" "empty list"
  fi
else
  fail "workspaces" "query error"
fi

# Extract first workspace ID for later use
WS_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['workspaces'][0]['id'])" 2>/dev/null || echo "")

# ── Journey 3: Server Config ─────────────────────────────────────────
echo "Journey 3: Server Config"

R=$(gql '{ serverConfig { version name features credentialsRequirement { password { minLength maxLength } } } }')
if has_no_errors "$R" && has_field "$R" "data.serverConfig.version" && has_field "$R" "data.serverConfig.name"; then
  VER=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['serverConfig']['version'])" 2>/dev/null)
  pass "serverConfig: version=$VER, name+features+credentials present"
else
  fail "serverConfig" "missing fields"
fi

R=$(gql '{ serverConfig { journal { firstDayOfWeek showCalendarWeeks } } }')
if has_no_errors "$R" && has_field "$R" "data.serverConfig.journal.firstDayOfWeek"; then
  pass "serverConfig.journal settings present"
else
  fail "serverConfig.journal" "missing journal fields"
fi

# ── Journey 4: Document Operations ────────────────────────────────────
echo "Journey 4: Document Operations"

if [ -n "$WS_ID" ]; then
  R=$(gql "{ workspace(id: \\\"$WS_ID\\\") { docs(pagination: {first: 5}) { edges { node { id } } } } }")
  if has_no_errors "$R" && has_field "$R" "data.workspace.docs.edges"; then
    DOC_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['workspace']['docs']['edges']))" 2>/dev/null || echo 0)
    pass "workspace docs: $DOC_COUNT doc(s) in $WS_ID"
  else
    fail "workspace docs" "query failed"
  fi
else
  fail "workspace docs" "no workspace ID available"
fi

# ── Journey 5: WebSocket Connectivity ─────────────────────────────────
echo "Journey 5: WebSocket Connectivity"

for LABEL_URL in "frontend:$FRONTEND_URL" "api:$API_URL"; do
  LABEL="${LABEL_URL%%:*}"
  URL="${LABEL_URL#*:}"
  WS_RESP=$(curl -sf "$URL/socket.io/?EIO=4&transport=polling" 2>/dev/null || echo "")
  if echo "$WS_RESP" | grep -q '"maxPayload":104857600'; then
    pass "WebSocket handshake ($LABEL): maxPayload=100MB"
  elif [ -n "$WS_RESP" ] && echo "$WS_RESP" | grep -q '"sid"'; then
    PAYLOAD=$(echo "$WS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin[1:])['maxPayload'])" 2>/dev/null || echo "unknown")
    fail "WebSocket ($LABEL)" "maxPayload=$PAYLOAD, expected 104857600"
  else
    fail "WebSocket ($LABEL)" "handshake failed"
  fi
done

# ── Journey 6: Admin-specific Queries ─────────────────────────────────
echo "Journey 6: Admin Queries"

R=$(gql '{ admin { adminDashboard { syncActiveUsers workspaceStorageBytes blobStorageBytes generatedAt } } }')
if has_no_errors "$R" && has_field "$R" "data.admin.adminDashboard.syncActiveUsers"; then
  USERS=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['admin']['adminDashboard']['syncActiveUsers'])" 2>/dev/null)
  pass "adminDashboard: syncActiveUsers=$USERS"
else
  fail "adminDashboard" "query error or missing fields"
fi

R=$(gql '{ admin { adminConfigValues { revision modules { module } } } }')
if has_no_errors "$R" && has_field "$R" "data.admin.adminConfigValues.modules"; then
  pass "structured Admin configuration is available"
else
  fail "adminConfigValues" "missing or error"
fi

R=$(gql '{ admin { loggingConfig { modules { group displayName level } } } }')
if has_no_errors "$R" && has_field "$R" "data.admin.loggingConfig.modules"; then
  MOD_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['admin']['loggingConfig']['modules']))" 2>/dev/null || echo 0)
  pass "loggingConfig: $MOD_COUNT module(s)"
else
  fail "loggingConfig" "query error"
fi

# ── Journey 7: REST API Endpoints ─────────────────────────────────────
echo "Journey 7: REST API Endpoints"

for EP in health ready live; do
  CODE=$(curl -sf -o /dev/null -w '%{http_code}' "$API_URL/$EP" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    pass "GET /$EP -> 200"
  else
    fail "GET /$EP" "HTTP $CODE"
  fi
done

CODE=$(curl -sf -o /dev/null -w '%{http_code}' "$API_URL/api/worker/questionnaire" 2>/dev/null || echo "000")
if [ "$CODE" = "200" ]; then
  pass "GET /api/worker/questionnaire -> 200"
else
  fail "/api/worker/questionnaire" "HTTP $CODE"
fi

CSS=$(curl -sf "$API_URL/api/branding/theme.css" 2>/dev/null || echo "")
if echo "$CSS" | grep -q 'font-family'; then
  pass "GET /api/branding/theme.css returns CSS"
else
  fail "/api/branding/theme.css" "no CSS content"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════"
for R in "${RESULTS[@]}"; do
  echo "  $R"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "OVERALL: FAIL"
  exit 1
else
  echo "OVERALL: PASS"
  exit 0
fi
