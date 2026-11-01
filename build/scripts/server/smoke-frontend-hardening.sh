#!/usr/bin/env bash
set -euo pipefail

FRONTEND_BASE_URL="${FRONTEND_BASE_URL:-http://127.0.0.1:3010}"

require_header_contains() {
  local response="$1"
  local header_name="$2"
  local expected="$3"

  local actual
  actual="$(printf '%s\n' "$response" | awk -F': ' -v h="$header_name" 'tolower($1)==tolower(h){print $2}' | tr -d '\r' | tail -n 1)"
  if [[ -z "$actual" ]]; then
    echo "[FAIL] missing header '$header_name'" >&2
    exit 1
  fi
  if [[ "$actual" != *"$expected"* ]]; then
    echo "[FAIL] header '$header_name' value '$actual' does not include '$expected'" >&2
    exit 1
  fi
  echo "[PASS] $header_name contains '$expected'"
}

fetch_headers() {
  local url="$1"
  curl -sS -D - -o /dev/null "$url"
}

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"

root_headers="$(fetch_headers "$FRONTEND_BASE_URL/")"
require_header_contains "$root_headers" "Cache-Control" "no-store"
require_header_contains "$root_headers" "X-Frame-Options" "SAMEORIGIN"
require_header_contains "$root_headers" "X-Content-Type-Options" "nosniff"
require_header_contains "$root_headers" "Referrer-Policy" "strict-origin-when-cross-origin"
require_header_contains "$root_headers" "Permissions-Policy" "camera=(), microphone=(), geolocation=()"

admin_headers="$(fetch_headers "$FRONTEND_BASE_URL/adminfrontend/")"
require_header_contains "$admin_headers" "Cache-Control" "no-store"
require_header_contains "$admin_headers" "X-Frame-Options" "SAMEORIGIN"

asset_path="$(curl -sS "$FRONTEND_BASE_URL/" | grep -Eo '/(_plugin|assets|imgs|js|plugins|static)/[^"'\'' ]+' | head -n 1 || true)"
if [[ -z "$asset_path" ]]; then
  echo "[FAIL] no static asset path found in HTML shell" >&2
  exit 1
fi
asset_headers="$(fetch_headers "$FRONTEND_BASE_URL$asset_path")"
require_header_contains "$asset_headers" "Cache-Control" "immutable"
require_header_contains "$asset_headers" "X-Content-Type-Options" "nosniff"

api_headers="$(fetch_headers "$FRONTEND_BASE_URL/api/auth/session")"
require_header_contains "$api_headers" "X-Frame-Options" "SAMEORIGIN"
require_header_contains "$api_headers" "Referrer-Policy" "strict-origin-when-cross-origin"

echo "[PASS] frontend hardening smoke suite"
