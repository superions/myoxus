#!/usr/bin/env bash
set -euo pipefail

BASE_PATH="${MYOXUS_FRONTEND_BASE_PATH:-/myoxus}"
FRONTEND_BASE_URL="${FRONTEND_BASE_URL:-http://127.0.0.1:3010}"
PREFIX_URL="${FRONTEND_BASE_URL}${BASE_PATH}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
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

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"
echo "[INFO] Prefix path: $BASE_PATH"

health_code="$(curl -sS -o /tmp/myoxus-prefix-health.out -w '%{http_code}' "$PREFIX_URL/health")"
check_status "prefixed health" "$health_code" 200

web_code="$(curl -sS -o /tmp/myoxus-prefix-web.out -w '%{http_code}' "$PREFIX_URL/")"
check_status "prefixed web shell" "$web_code" 200
if ! grep -qi '<!doctype html>' /tmp/myoxus-prefix-web.out; then
  echo "[FAIL] prefixed web shell did not return HTML" >&2
  exit 1
fi

admin_code="$(curl -sS -o /tmp/myoxus-prefix-admin.out -w '%{http_code}' "$PREFIX_URL/adminfrontend/")"
check_status "prefixed admin shell" "$admin_code" 200
if ! grep -qi '<!doctype html>' /tmp/myoxus-prefix-admin.out; then
  echo "[FAIL] prefixed admin shell did not return HTML" >&2
  exit 1
fi

graphql_code="$(curl -sS -o /tmp/myoxus-prefix-graphql.out -w '%{http_code}' \
  -X POST "$PREFIX_URL/graphql" \
  -H 'content-type: application/json' \
  --data '{"query":"query { __typename }"}')"
check_status "prefixed graphql" "$graphql_code" 200

socketio_code="$(curl -sS -o /tmp/myoxus-prefix-socketio.out -w '%{http_code}' \
  "$PREFIX_URL/socket.io/?EIO=4&transport=polling")"
check_status "prefixed socket.io polling" "$socketio_code" 200

theme_css_code="$(curl -sS -o /tmp/myoxus-prefix-theme-css.out -w '%{http_code}' \
  "$PREFIX_URL/api/branding/theme.css")"
check_status "prefixed runtime theme css" "$theme_css_code" 200
if ! grep -q -- '--myoxus-accent-primary' /tmp/myoxus-prefix-theme-css.out; then
  echo "[FAIL] prefixed runtime theme css endpoint missing accent token output" >&2
  exit 1
fi
if ! grep -q -- '--myoxus-sem-surface-elevated' /tmp/myoxus-prefix-theme-css.out ||
  ! grep -q -- '--myoxus-background-overlay-panel-color' /tmp/myoxus-prefix-theme-css.out; then
  echo "[FAIL] prefixed runtime theme css endpoint missing elevated/overlay surface tokens" >&2
  exit 1
fi
check_hover_token_pairs "prefixed runtime theme css" /tmp/myoxus-prefix-theme-css.out

if [[ -n "$font_sample" ]]; then
  root_font_code="$(curl -sS -o /tmp/myoxus-root-font.out -w '%{http_code}' \
    "$FRONTEND_BASE_URL/api/fonts/$font_sample")"
  check_status "root static font for prefixed CSS" "$root_font_code" 200

  prefixed_font_code="$(curl -sS -o /tmp/myoxus-prefix-font.out -w '%{http_code}' \
    "$PREFIX_URL/api/fonts/$font_sample")"
  check_status "prefixed static font" "$prefixed_font_code" 200
else
  echo "[WARN] no server/static/fonts sample found; skipping prefixed /api/fonts smoke"
fi

theme_fallback_code="$(curl -sS -o /tmp/myoxus-prefix-theme-fallback.out -w '%{http_code}' \
  "$PREFIX_URL/style/theme-fallback.css")"
check_status "prefixed Electron theme fallback css" "$theme_fallback_code" 200
if ! grep -q -- '--myoxus-sem-surface-page' /tmp/myoxus-prefix-theme-fallback.out; then
  echo "[FAIL] prefixed /style/theme-fallback.css missing generated semantic theme output" >&2
  exit 1
fi
if ! grep -q -- '--myoxus-sem-surface-elevated' /tmp/myoxus-prefix-theme-fallback.out ||
  ! grep -q -- '--myoxus-background-overlay-panel-color' /tmp/myoxus-prefix-theme-fallback.out; then
  echo "[FAIL] prefixed /style/theme-fallback.css missing elevated/overlay surface tokens" >&2
  exit 1
fi
expected_theme_count="$(node -e 'console.log(require(process.argv[1]).themes.length)' \
  "$ROOT_DIR/server/static/branding/theme-catalog.json")"
actual_theme_count="$(grep -c 'Electron offline theme:' /tmp/myoxus-prefix-theme-fallback.out)"
if [[ "$actual_theme_count" != "$expected_theme_count" ]]; then
  echo "[FAIL] prefixed Electron fallback has $actual_theme_count themes, expected $expected_theme_count" >&2
  exit 1
fi
check_hover_token_pairs "prefixed Electron theme fallback css" /tmp/myoxus-prefix-theme-fallback.out

brand_fallback_code="$(curl -sS -o /tmp/myoxus-prefix-brand-identity-fallback.out -w '%{http_code}' \
  "$PREFIX_URL/style/brand-identity-fallback.json")"
check_status "prefixed static brand identity fallback json" "$brand_fallback_code" 200
if ! grep -q '"appServerBranding"' /tmp/myoxus-prefix-brand-identity-fallback.out; then
  echo "[FAIL] prefixed /style/brand-identity-fallback.json missing appServerBranding contract" >&2
  exit 1
fi

echo "[PASS] frontend basepath smoke suite"
