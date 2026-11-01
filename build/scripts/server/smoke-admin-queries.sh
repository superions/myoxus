#!/usr/bin/env bash
# Fast admin smoke test — runs in < 5 seconds.
# Checks health, GraphQL introspection, and one authenticated admin query.
# Designed for automatic use after stack-rebuild-api.sh.
# For the full 11-query admin smoke, use smoke-admin.sh instead.
#
# Usage:
#   build/scripts/server/smoke-admin-queries.sh
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib-auth-smoke.sh"

API="${API_URL:-http://localhost:3001}"
ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-admin@myoxus.local}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-AdminMyoxus2026}"

PASS=0
FAIL=0

RED='\033[0;31m'
GRN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GRN}PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL+1)); }

echo "=== Admin Smoke Queries (fast) ==="

# 1. Health endpoint
if curl -sf "$API/health" | grep -q '"status":"ok"'; then
  pass "health endpoint"
else
  fail "health endpoint not responding"
  echo "    Aborting — API not healthy."
  exit 1
fi

# 2. GraphQL introspection (schema is queryable)
INTRO=$(curl -sf "$API/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { queryType { name } } }"}' 2>&1)
if echo "$INTRO" | grep -q '"queryType"'; then
  pass "GraphQL introspection"
else
  fail "GraphQL introspection failed"
fi

# 3. Authenticated admin query (adminDashboard)
SIGN_IN_ERR="$(mktemp)"
SESSION="$(smoke_admin_sign_in "$API" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" 2>"$SIGN_IN_ERR" || true)"

if [ -z "$SESSION" ]; then
  fail "admin sign-in ($(cat "$SIGN_IN_ERR"))"
  echo ""
  echo "=== Results: $PASS passed, $FAIL failed ==="
  rm -f "$SIGN_IN_ERR"
  exit 1
fi
rm -f "$SIGN_IN_ERR"
pass "admin sign-in"

DASH=$(curl -sf "$API/graphql" \
  -H 'Content-Type: application/json' \
  -H "Cookie: affine_session=$SESSION" \
  -d '{"query":"query { admin { adminDashboard { generatedAt } } }"}' 2>&1)
if echo "$DASH" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('data') is not None and 'errors' not in d else 1)" 2>/dev/null; then
  pass "adminDashboard query"
else
  fail "adminDashboard query"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
