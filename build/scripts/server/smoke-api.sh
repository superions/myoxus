#!/usr/bin/env bash
# Post-deploy smoke test for the Myoxus API container.
#
# Verifies critical paths after a container rebuild:
# 1. Health endpoint
# 2. Readiness endpoint
# 3. Container start time is after last git commit
# 4. Bounded container logging without a forced global TRACE override
# 5. Auth sign-in flow
# 6. GraphQL introspection (schema loads)
# 7. Key resolvers respond
# 8. WebSocket endpoint responds
# 9. No recent GraphQL errors
#
# Usage:
#   build/scripts/server/smoke-api.sh          # run all checks
#   build/scripts/server/smoke-api.sh --quick   # health, readiness, freshness, and logging safety
#
# Exit code 0 = all checks passed, non-zero = failure with details.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
. "$SCRIPT_DIR/lib-auth-smoke.sh"
if [ -n "${MYOXUS_RUNTIME_PROFILE:-}" ]; then
  source "$SCRIPT_DIR/require-runtime-profile.sh"
fi

API_CONTAINER="$(docker compose -f "$REPO_ROOT/build/server/docker-compose.selfhost.yml" ps --status running --quiet api)"
if [ -z "$API_CONTAINER" ]; then
  echo "[FAIL] No running API container in the selected Compose project."
  exit 1
fi

API_URL="${API_URL:-http://localhost:${MYOXUS_PUBLIC_PORT:-3001}}"
ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-admin@myoxus.local}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-AdminMyoxus2026}"

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0

echo "=== Myoxus API Smoke Test ==="
echo "Target: $API_URL"
echo ""

# 1. Health
echo "1. Health endpoint"
if curl -sf "$API_URL/health" | grep -q '"status":"ok"'; then
  pass "health OK"
else
  fail "health endpoint not responding"
  echo "    Container may not be running. Aborting."
  exit 1
fi

# 2. Readiness must be both HTTP 200 and the explicit ready state. Curl
# transport failures and malformed payloads remain hard failures.
echo "2. Readiness endpoint"
READY_RESPONSE="$(curl -sS -w $'\n%{http_code}' "$API_URL/ready" 2>/dev/null || true)"
READY_STATUS="$(printf '%s\n' "$READY_RESPONSE" | tail -n 1)"
READY_BODY="$(printf '%s\n' "$READY_RESPONSE" | sed '$d')"
if [ "$READY_STATUS" = "200" ] && printf '%s' "$READY_BODY" | grep -q '"status":"ready"'; then
  pass "readiness OK (HTTP 200/ready)"
else
  fail "readiness endpoint did not return HTTP 200/ready (status=${READY_STATUS:-missing})"
fi

# 3. Container freshness — started after last git commit?
echo "3. Container freshness"
CONTAINER_START=$(docker inspect "$API_CONTAINER" --format='{{.State.StartedAt}}' 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git -C "$REPO_ROOT" log -1 --format='%cI' 2>/dev/null || echo "unknown")
if [ "$CONTAINER_START" != "unknown" ] && [ "$LAST_COMMIT" != "unknown" ]; then
  CS=$(date -d "$CONTAINER_START" +%s 2>/dev/null || echo 0)
  LC=$(date -d "$LAST_COMMIT" +%s 2>/dev/null || echo 0)
  if [ "$CS" -ge "$LC" ]; then
    pass "container started ($CONTAINER_START) after last commit ($LAST_COMMIT)"
  else
    fail "container started BEFORE last commit — rebuild needed!"
    echo "    Container: $CONTAINER_START"
    echo "    Last commit: $LAST_COMMIT"
  fi
else
  fail "container freshness unavailable (missing container or git info)"
fi

# 4. Logging safety. A smoke test must not require a noisy operational level in
# order to observe the service it tests. Docker stdout is a second log sink next
# to the server-owned file writer, so it must always be bounded.
echo "4. Logging safety"
LOG_DRIVER=$(docker inspect "$API_CONTAINER" --format='{{.HostConfig.LogConfig.Type}}' 2>/dev/null || echo "unknown")
LOG_MAX_SIZE=$(docker inspect "$API_CONTAINER" --format='{{with index .HostConfig.LogConfig.Config "max-size"}}{{.}}{{end}}' 2>/dev/null || true)
LOG_MAX_FILES=$(docker inspect "$API_CONTAINER" --format='{{with index .HostConfig.LogConfig.Config "max-file"}}{{.}}{{end}}' 2>/dev/null || true)
if [ "$LOG_DRIVER" = "json-file" ] && [ -n "$LOG_MAX_SIZE" ] && [ -n "$LOG_MAX_FILES" ]; then
  pass "Docker logs bounded (max-size=$LOG_MAX_SIZE, max-file=$LOG_MAX_FILES)"
else
  fail "Docker log rotation missing (driver=$LOG_DRIVER, max-size=${LOG_MAX_SIZE:-unset}, max-file=${LOG_MAX_FILES:-unset})"
fi

FORCED_TRACE=$(docker inspect "$API_CONTAINER" --format='{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep -Ei '^(MYOXUS__LOGGING__LEVEL|RUST_LOG)=trace($|,)' || true)
if [ -n "$FORCED_TRACE" ] && [ "${SMOKE_ALLOW_TRACE_LOGGING:-0}" != "1" ]; then
  fail "global TRACE is forced by container environment; use a targeted runtime level with auto-revert"
else
  pass "no forced global TRACE override"
fi

[ "${1:-}" = "--quick" ] && { echo ""; echo "Quick mode — $FAILURES failures."; exit $FAILURES; }

# 5. Auth sign-in
echo "5. Auth sign-in"
SIGN_IN_ERR="$(mktemp)"
SESSION="$(smoke_admin_sign_in "$API_URL" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" 2>"$SIGN_IN_ERR" || true)"
if [ -n "$SESSION" ]; then
  pass "sign-in successful"
  rm -f "$SIGN_IN_ERR"
else
  fail "sign-in failed: $(cat "$SIGN_IN_ERR")"
  rm -f "$SIGN_IN_ERR"
  echo "    Remaining checks will be skipped (no session)."
  echo ""; echo "$FAILURES failures."; exit $FAILURES
fi

# 6. GraphQL schema — critical types exist
echo "6. GraphQL schema"
SCHEMA=$(curl -sf "$API_URL/graphql" \
  -H 'content-type: application/json' \
  -H "cookie: affine_session=$SESSION" \
  -d '{"query":"{ __schema { types { name } } }"}' 2>&1)
for TYPE in WorkspaceType UserType OrganizationUnitTypeOutput PaginationInput WorkspaceDocMeta DocHistoryType PaginatedDocType DocPageAnalytics; do
  if echo "$SCHEMA" | grep -q "\"$TYPE\""; then
    pass "type $TYPE exists"
  else
    fail "type $TYPE MISSING from schema"
  fi
done

# 7. Key resolvers respond (no Unknown field errors)
echo "7. Key resolvers"
for QUERY in \
  '{ workspaces { id } }' \
  '{ currentUser { id } }' \
  '{ serverConfig { version } }'; do
  RESP=$(curl -sf "$API_URL/graphql" \
    -H 'content-type: application/json' \
    -H "cookie: affine_session=$SESSION" \
    -d "{\"query\":\"$QUERY\"}" 2>&1)
  if echo "$RESP" | grep -q '"errors"'; then
    ERRMSG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['errors'][0]['message'])" 2>/dev/null || echo "unknown")
    fail "query failed: $QUERY → $ERRMSG"
  else
    pass "query OK: $QUERY"
  fi
done

# 8. WebSocket endpoint
echo "8. WebSocket endpoint"
WS_RESP=$(curl -sf "$API_URL/socket.io/?EIO=4&transport=polling" 2>&1)
if echo "$WS_RESP" | grep -q "sid"; then
  pass "socket.io polling endpoint responds"
else
  fail "socket.io endpoint not responding"
fi

# 9. No GraphQL errors in recent logs
echo "9. Recent GraphQL errors"
if RECENT_LOGS=$(docker logs "$API_CONTAINER" --since "60s" 2>&1); then
  ERROR_COUNT=$(printf '%s\n' "$RECENT_LOGS" | grep -c "graphql error" || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    pass "no GraphQL errors in last 60s"
  else
    fail "$ERROR_COUNT GraphQL errors in last 60s"
  fi
else
  fail "could not read API logs"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
else
  echo "=== $FAILURES CHECKS FAILED ==="
fi
exit $FAILURES
