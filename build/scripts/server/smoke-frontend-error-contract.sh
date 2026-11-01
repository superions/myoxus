#!/usr/bin/env bash
set -euo pipefail

FRONTEND_BASE_URL="${FRONTEND_BASE_URL:-http://127.0.0.1:3010}"

check_status() {
  local name="$1"
  local code="$2"
  shift 2
  local allowed=("$@")
  for expected in "${allowed[@]}"; do
    if [[ "$code" == "$expected" ]]; then
      echo "[PASS] $name returned HTTP $code"
      return 0
    fi
  done
  echo "[FAIL] $name returned HTTP $code (allowed: ${allowed[*]})" >&2
  exit 1
}

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"

wrong_signin_code="$(curl -sS -o /tmp/myoxus-error-signin.out -w '%{http_code}' \
  -X POST "$FRONTEND_BASE_URL/api/auth/sign-in" \
  -H 'content-type: application/json' \
  --data '{"email":"invalid@example.com","password":"invalid"}')"
check_status "wrong sign-in" "$wrong_signin_code" 400
if ! grep -q 'WRONG_SIGN_IN_CREDENTIALS' /tmp/myoxus-error-signin.out; then
  echo "[FAIL] wrong sign-in payload missing WRONG_SIGN_IN_CREDENTIALS" >&2
  exit 1
fi

oauth_preflight_code="$(curl -sS -o /tmp/myoxus-error-oauth.out -w '%{http_code}' \
  -X POST "$FRONTEND_BASE_URL/api/oauth/preflight" \
  -H 'content-type: application/json' \
  --data '{}')"
check_status "oauth preflight validation" "$oauth_preflight_code" 400 401 422

mcp_code="$(curl -sS -o /tmp/myoxus-error-mcp.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/workspaces/00000000-0000-0000-0000-000000000000/mcp/")"
check_status "workspace mcp method gate" "$mcp_code" 405

unauth_doc_code="$(curl -sS -o /tmp/myoxus-error-doc.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/workspaces/00000000-0000-0000-0000-000000000000/docs/00000000-0000-0000-0000-000000000000")"
check_status "workspace docs unauth" "$unauth_doc_code" 401

copilot_unknown_code="$(curl -sS -o /tmp/myoxus-error-copilot.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/copilot/chat/00000000-0000-0000-0000-000000000000/unknown")"
check_status "copilot unknown stream endpoint" "$copilot_unknown_code" 404

echo "[PASS] frontend error contract smoke suite"
