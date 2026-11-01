#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FRONTEND_BASE_URL="${MYOXUS_FRONTEND_BASE_URL:-http://127.0.0.1:${MYOXUS_DEV_GATEWAY_PORT:-3011}}"

check_status() {
  local name="$1"
  local code="$2"
  shift 2
  for allowed in "$@"; do
    if [[ "$code" == "$allowed" ]]; then
      echo "[PASS] $name returned HTTP $code"
      return 0
    fi
  done
  echo "[FAIL] $name returned HTTP $code (allowed: $*)" >&2
  exit 1
}

html_check() {
  local name="$1"
  local url="$2"
  local body
  body="$(curl -fsS "$url")"
  if [[ "$body" != *"<html"* ]]; then
    echo "[FAIL] $name does not look like an HTML shell" >&2
    exit 1
  fi
  echo "[PASS] $name HTML shell detected"
}

require_token() {
  local name="$1"
  local file="$2"
  local token="$3"
  if ! grep -q -- "$token" "$file"; then
    echo "[FAIL] $name missing $token" >&2
    exit 1
  fi
}

reject_frontend_shell() {
  local name="$1"
  local file="$2"
  if grep -Eqi '<title>Myoxus</title>|manifest\.json|emotion-insertion-point' "$file"; then
    echo "[FAIL] $name returned a frontend HTML shell instead of backend response" >&2
    exit 1
  fi
}

font_sample="$(
  cd "$REPO_ROOT/server/static/fonts" &&
    find . -type f \( -name '*.woff2' -o -name '*.ttf' -o -name '*.otf' \) |
    sed 's#^\./##' |
    sort |
    sed -n '1p'
)"

curl -fsS "$FRONTEND_BASE_URL/health" | grep -qx ok
echo "[PASS] dev frontend health endpoint"

html_check "dev web shell" "$FRONTEND_BASE_URL/"
html_check "dev admin shell" "$FRONTEND_BASE_URL/adminfrontend/"
html_check "dev admin dashboard SPA shell" "$FRONTEND_BASE_URL/adminfrontend/dashboard"
html_check "dev admin documents SPA shell" "$FRONTEND_BASE_URL/adminfrontend/documents"

api_root_code="$(curl -sS -o /tmp/myoxus-dev-api-root-smoke.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api")"
check_status "dev /api" "$api_root_code" 200 301 302 404 405
reject_frontend_shell "dev /api" /tmp/myoxus-dev-api-root-smoke.out

admin_api_root_code="$(curl -sS -o /tmp/myoxus-dev-admin-api-root-smoke.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/adminfrontend/api")"
check_status "dev /adminfrontend/api" "$admin_api_root_code" 200 301 302 404 405
reject_frontend_shell "dev /adminfrontend/api" /tmp/myoxus-dev-admin-api-root-smoke.out

graphql_code="$(curl -sS -o /tmp/myoxus-dev-graphql-smoke.out -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/graphql" \
  --data '{"query":"query { __typename }"}')"
check_status "dev /graphql" "$graphql_code" 200 400 401

info_code="$(curl -sS -o /tmp/myoxus-dev-info-smoke.out -w '%{http_code}' "$FRONTEND_BASE_URL/info")"
check_status "dev /info" "$info_code" 200
if grep -qi '<html' /tmp/myoxus-dev-info-smoke.out; then
  echo "[FAIL] dev /info returned an HTML shell instead of API JSON" >&2
  exit 1
fi

socketio_code="$(curl -sS -o /tmp/myoxus-dev-socketio-smoke.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/socket.io/?EIO=4&transport=polling")"
check_status "dev /socket.io polling" "$socketio_code" 200

theme_css_code="$(curl -sS -o /tmp/myoxus-dev-theme-css-smoke.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/branding/theme.css")"
check_status "dev /api/branding/theme.css" "$theme_css_code" 200
require_token "dev /api/branding/theme.css" /tmp/myoxus-dev-theme-css-smoke.out --myoxus-accent-primary
require_token "dev /api/branding/theme.css" /tmp/myoxus-dev-theme-css-smoke.out --myoxus-sem-surface-elevated

style_code="$(curl -sS -o /tmp/myoxus-dev-style-smoke.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/style/theme-fallback.css")"
check_status "dev Electron /style/theme-fallback.css" "$style_code" 200
require_token "dev /style/theme-fallback.css" /tmp/myoxus-dev-style-smoke.out --myoxus-sem-surface-page

if [[ -n "$font_sample" ]]; then
  font_code="$(curl -sS -o /tmp/myoxus-dev-font-smoke.out -w '%{http_code}' \
    "$FRONTEND_BASE_URL/api/fonts/$font_sample")"
  check_status "dev /api/fonts/$font_sample" "$font_code" 200
else
  echo "[WARN] no server/static/fonts sample found; skipping /api/fonts smoke"
fi

echo "[PASS] frontend dev smoke suite"
