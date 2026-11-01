#!/usr/bin/env bash
# Compose integration test — verify the full selfhost stack comes up healthy.
#
# This is a non-destructive test: if the stack is already running it checks
# health only.  If the stack is down it starts it, waits for healthy, checks,
# and leaves it running (caller may stop with stack-down.sh).
#
# Usage:
#   build/scripts/server/test-compose-integration.sh
#
# Exit codes:
#   0 — all services healthy
#   1 — one or more services failed health checks

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPTS="$REPO_ROOT/build/scripts/server"

API_PORT="${MYOXUS_PUBLIC_PORT:-3001}"
FRONTEND_PORT="${MYOXUS_FRONTEND_PORT:-3010}"

failures=0

check_endpoint() {
  local label="$1" url="$2"
  local code
  code=$(curl -o /dev/null -s -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo "ERR")
  if [[ "$code" == "200" ]]; then
    echo "  [PASS] $label → $code"
  else
    echo "  [FAIL] $label → $code"
    ((failures++)) || true
  fi
}

# 1. Check if stack is already running, start if needed
echo "=== Checking stack status ==="
api_up=$(curl -o /dev/null -s -w '%{http_code}' --max-time 3 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || echo "ERR")
fe_up=$(curl -o /dev/null -s -w '%{http_code}' --max-time 3 "http://127.0.0.1:${FRONTEND_PORT}/health" 2>/dev/null || echo "ERR")
if [[ "$api_up" == "200" && "$fe_up" == "200" ]]; then
  echo "  Stack already running and healthy"
else
  echo "  Stack not fully up — starting via stack-up.sh ..."
  "$SCRIPTS/stack-up.sh"
fi

echo
echo "=== Health probes ==="
check_endpoint "API /health"    "http://127.0.0.1:${API_PORT}/health"
check_endpoint "API /ready"     "http://127.0.0.1:${API_PORT}/ready"
check_endpoint "API /live"      "http://127.0.0.1:${API_PORT}/live"
check_endpoint "Frontend /"     "http://127.0.0.1:${FRONTEND_PORT}/"
check_endpoint "Frontend /health" "http://127.0.0.1:${FRONTEND_PORT}/health"

# 2. Verify frontend serves HTML with correct branding
echo
echo "=== Branding check ==="
html=$(curl -s "http://127.0.0.1:${FRONTEND_PORT}/")
if echo "$html" | grep -q '<title>Myoxus</title>'; then
  echo "  [PASS] Frontend title is Myoxus"
else
  echo "  [FAIL] Frontend title is NOT Myoxus"
  ((failures++)) || true
fi

# 3. Verify API GraphQL endpoint is reachable
echo
echo "=== API GraphQL ==="
gql_code=$(curl -o /dev/null -s -w '%{http_code}' --max-time 5 \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}' \
  "http://127.0.0.1:${API_PORT}/graphql" 2>/dev/null || echo "ERR")
if [[ "$gql_code" == "200" ]]; then
  echo "  [PASS] GraphQL endpoint responds → $gql_code"
else
  echo "  [FAIL] GraphQL endpoint → $gql_code"
  ((failures++)) || true
fi

echo
if [[ $failures -eq 0 ]]; then
  echo "=== ALL CHECKS PASSED ==="
  exit 0
else
  echo "=== $failures CHECK(S) FAILED ==="
  exit 1
fi
