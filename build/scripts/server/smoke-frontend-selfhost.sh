#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FRONTEND_BASE_URL="${MYOXUS_FRONTEND_BASE_URL:-http://127.0.0.1:${MYOXUS_FRONTEND_PORT:-3010}}"
API_BASE_URL="${MYOXUS_API_BASE_URL:-http://127.0.0.1:${MYOXUS_PUBLIC_PORT:-3001}}"
SMOKE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/myoxus-frontend-smoke.XXXXXX")"
cleanup() {
  rm -rf -- "$SMOKE_TMP_DIR"
}
trap cleanup EXIT
font_sample="$(
  cd "$ROOT_DIR/server/static/fonts" &&
    find . -type f \( -name '*.woff2' -o -name '*.ttf' -o -name '*.otf' \) |
    sed 's#^\./##' |
    sort |
    sed -n '1p'
)"

check_status() {
  local name="$1"
  local code="$2"
  shift 2
  local ok="false"
  for allowed in "$@"; do
    if [[ "$code" == "$allowed" ]]; then
      ok="true"
      break
    fi
  done

  if [[ "$ok" != "true" ]]; then
    echo "[FAIL] $name returned HTTP $code (allowed: $*)" >&2
    exit 1
  fi

  echo "[PASS] $name returned HTTP $code"
}

check_hover_token_pairs() {
  local name="$1"
  local file="$2"
  for token in \
    --myoxus-sem-button-primary-bg \
    --myoxus-sem-button-primary-fg \
    --myoxus-sem-button-secondary-bg \
    --myoxus-sem-button-secondary-fg; do
    if ! grep -q -- "$token" "$file"; then
      echo "[FAIL] $name missing $token (required by INV-THEME-HOVER-01)" >&2
      exit 1
    fi
  done
  echo "[PASS] $name hover token pairs (INV-THEME-HOVER-01)"
}

html_check() {
  local name="$1"
  local url="$2"
  local body
  body="$(curl -fsS "$url")"

  if [[ "$body" != *"<html"* ]]; then
    echo "[FAIL] $name does not look like HTML shell" >&2
    exit 1
  fi

  echo "[PASS] $name HTML shell detected"
}

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"
echo "[INFO] API base: $API_BASE_URL"

curl -fsS "$FRONTEND_BASE_URL/health" | grep -q '^ok$'
echo "[PASS] frontend health endpoint"

html_check "web shell" "$FRONTEND_BASE_URL/"
html_check "admin shell" "$FRONTEND_BASE_URL/adminfrontend/"
node "$ROOT_DIR/build/scripts/admin/verify-icon-signatures.mjs" --url "$FRONTEND_BASE_URL"
node "$ROOT_DIR/build/scripts/admin/verify-documents-audit-bundle.mjs" --url "$FRONTEND_BASE_URL"

graphql_code="$(curl -sS -o "$SMOKE_TMP_DIR/graphql.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/graphql" \
  --data '{"query":"query { __typename }"}')"
check_status "frontend /graphql" "$graphql_code" 200 400 401

info_code="$(curl -sS -o "$SMOKE_TMP_DIR/info.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/info")"
check_status "frontend /info" "$info_code" 200
if grep -qi '<html' "$SMOKE_TMP_DIR/info.out"; then
  echo "[FAIL] frontend /info returned the web shell instead of API JSON" >&2
  exit 1
fi
node -e '
const fs = require("fs");
const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!info.version || info.version === "0.0.0") {
  throw new Error(`invalid /info version: ${info.version ?? "<missing>"}`);
}
if (info.flavor !== "myoxus-rust") {
  throw new Error(`unexpected /info flavor: ${info.flavor ?? "<missing>"}`);
}
' "$SMOKE_TMP_DIR/info.out"
echo "[PASS] frontend /info API JSON contract"

auth_code="$(curl -sS -o "$SMOKE_TMP_DIR/auth-session.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/auth/session")"
check_status "frontend /api/auth/session" "$auth_code" 200 401

setup_code="$(curl -sS -o "$SMOKE_TMP_DIR/setup.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/api/setup/create-admin-user" \
  --data '{"email":"smoke@example.invalid","password":"Sm0keTest!","name":"Smoke"}')"
check_status "frontend /api/setup/create-admin-user" "$setup_code" 200 201 400 403 409

signin_code="$(curl -sS -o "$SMOKE_TMP_DIR/signin.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/api/auth/sign-in" \
  --data '{"email":"smoke@example.invalid","password":"Sm0keTest!"}')"
check_status "frontend /api/auth/sign-in" "$signin_code" 200 400 401 403

questionnaire_get_code="$(curl -sS -o "$SMOKE_TMP_DIR/questionnaire-get.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/worker/questionnaire")"
check_status "frontend /api/worker/questionnaire (GET)" "$questionnaire_get_code" 200

questionnaire_post_code="$(curl -sS -o "$SMOKE_TMP_DIR/questionnaire-post.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/api/worker/questionnaire" \
  --data '{"form":"smoke","ask":"q","answer":["a"]}')"
check_status "frontend /api/worker/questionnaire (POST)" "$questionnaire_post_code" 200 204

oauth_preflight_code="$(curl -sS -o "$SMOKE_TMP_DIR/oauth-preflight.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "$FRONTEND_BASE_URL/api/oauth/preflight" \
  --data '{}')"
check_status "frontend /api/oauth/preflight" "$oauth_preflight_code" 200 400 401 422

copilot_stream_code="$(curl -sS -o "$SMOKE_TMP_DIR/copilot-stream.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/copilot/chat/00000000-0000-0000-0000-000000000000/stream-object?messageId=00000000-0000-0000-0000-000000000000")"
check_status "frontend /api/copilot/chat/:session/stream-object" "$copilot_stream_code" 200
if ! grep -q 'event: error' "$SMOKE_TMP_DIR/copilot-stream.out"; then
  echo "[FAIL] copilot stream route did not return SSE error event payload" >&2
  exit 1
fi
echo "[PASS] frontend /api/copilot/chat/:session/stream-object SSE contract"

socketio_code="$(curl -sS -o "$SMOKE_TMP_DIR/socketio.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/socket.io/?EIO=4&transport=polling")"
check_status "frontend /socket.io polling" "$socketio_code" 200

api_health_code="$(curl -sS -o "$SMOKE_TMP_DIR/api-health.out" -w '%{http_code}' \
  "$API_BASE_URL/health")"
check_status "direct api /health" "$api_health_code" 200

theme_css_code="$(curl -sS -o "$SMOKE_TMP_DIR/theme-css.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/api/branding/theme.css")"
check_status "frontend /api/branding/theme.css" "$theme_css_code" 200
if ! grep -q -- '--myoxus-accent-primary' "$SMOKE_TMP_DIR/theme-css.out"; then
  echo "[FAIL] runtime theme css endpoint did not contain accent token output" >&2
  exit 1
fi
if ! grep -q -- '--myoxus-sem-surface-elevated' "$SMOKE_TMP_DIR/theme-css.out" ||
  ! grep -q -- '--myoxus-background-overlay-panel-color' "$SMOKE_TMP_DIR/theme-css.out"; then
  echo "[FAIL] runtime theme css endpoint is missing elevated/overlay surface tokens" >&2
  exit 1
fi
echo "[PASS] frontend /api/branding/theme.css runtime token contract"

if [[ -n "$font_sample" ]]; then
  font_code="$(curl -sS -o "$SMOKE_TMP_DIR/font.out" -w '%{http_code}' \
    "$FRONTEND_BASE_URL/api/fonts/$font_sample")"
  check_status "frontend /api/fonts/$font_sample" "$font_code" 200
  if [[ ! -s "$SMOKE_TMP_DIR/font.out" ]]; then
    echo "[FAIL] frontend /api/fonts/$font_sample returned an empty body" >&2
    exit 1
  fi
else
  echo "[WARN] no server/static/fonts sample found; skipping /api/fonts smoke"
fi

theme_fallback_code="$(curl -sS -o "$SMOKE_TMP_DIR/theme-fallback.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/style/theme-fallback.css")"
check_status "frontend Electron fallback /style/theme-fallback.css" "$theme_fallback_code" 200
if ! grep -q -- '--myoxus-sem-surface-page' "$SMOKE_TMP_DIR/theme-fallback.out"; then
  echo "[FAIL] /style/theme-fallback.css missing generated semantic theme output" >&2
  exit 1
fi
if ! grep -q -- '--myoxus-sem-surface-elevated' "$SMOKE_TMP_DIR/theme-fallback.out" ||
  ! grep -q -- '--myoxus-background-overlay-panel-color' "$SMOKE_TMP_DIR/theme-fallback.out"; then
  echo "[FAIL] /style/theme-fallback.css is missing elevated/overlay surface tokens" >&2
  exit 1
fi
expected_theme_count="$(node -e 'console.log(require(process.argv[1]).themes.length)' \
  "$ROOT_DIR/server/static/branding/theme-catalog.json")"
actual_theme_count="$(grep -c 'Electron offline theme:' "$SMOKE_TMP_DIR/theme-fallback.out")"
if [[ "$actual_theme_count" != "$expected_theme_count" ]]; then
  echo "[FAIL] Electron fallback has $actual_theme_count themes, expected $expected_theme_count" >&2
  exit 1
fi
echo "[PASS] frontend full-catalog Electron fallback contract"
check_hover_token_pairs "frontend Electron theme fallback" "$SMOKE_TMP_DIR/theme-fallback.out"

brand_fallback_code="$(curl -sS -o "$SMOKE_TMP_DIR/brand-identity-fallback.out" -w '%{http_code}' \
  "$FRONTEND_BASE_URL/style/brand-identity-fallback.json")"
check_status "frontend /style/brand-identity-fallback.json" "$brand_fallback_code" 200
if ! grep -q '"appServerBranding"' "$SMOKE_TMP_DIR/brand-identity-fallback.out"; then
  echo "[FAIL] /style/brand-identity-fallback.json missing appServerBranding contract" >&2
  exit 1
fi
echo "[PASS] frontend /style/brand-identity-fallback.json generated fallback contract"

# INV-THEME-HOVER-01: semantic token pairs must be emitted by the server.
# appendHoverVariables() derives hover pairs from these; if they're missing the
# derivation silently produces nothing and buttons lose their hover contrast guarantee.
check_hover_token_pairs "frontend /api/branding/theme.css" "$SMOKE_TMP_DIR/theme-css.out"

echo "[PASS] frontend selfhost smoke suite"
