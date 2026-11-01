#!/usr/bin/env bash
set -euo pipefail

FRONTEND_BASE_URL="${FRONTEND_BASE_URL:-http://127.0.0.1:3010}"
BASE_PATH="${MYOXUS_FRONTEND_BASE_PATH:-}"

prefix_url() {
  local path="$1"
  if [[ -n "$BASE_PATH" && "$BASE_PATH" != "/" ]]; then
    printf '%s%s%s\n' "$FRONTEND_BASE_URL" "$BASE_PATH" "$path"
  else
    printf '%s%s\n' "$FRONTEND_BASE_URL" "$path"
  fi
}

check_redirect() {
  local name="$1"
  local url="$2"
  local expected_location_suffix="$3"

  local headers
  headers="$(curl -sS -D - -o /dev/null "$url")"
  local code
  code="$(printf '%s\n' "$headers" | awk 'NR==1{print $2}')"
  if [[ "$code" != "301" && "$code" != "302" && "$code" != "308" ]]; then
    echo "[FAIL] $name returned HTTP $code (expected redirect)" >&2
    exit 1
  fi

  local location
  location="$(printf '%s\n' "$headers" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r' | tail -n 1)"
  if [[ "$location" != *"$expected_location_suffix" ]]; then
    echo "[FAIL] $name redirect location '$location' does not end with '$expected_location_suffix'" >&2
    exit 1
  fi
  echo "[PASS] $name redirected to $location"
}

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"
if [[ -n "$BASE_PATH" ]]; then
  echo "[INFO] Prefix path: $BASE_PATH"
fi

check_redirect "billing root" "$(prefix_url '/billing')" "${BASE_PATH}/"
check_redirect "pricing root" "$(prefix_url '/pricing')" "${BASE_PATH}/"
check_redirect "upgrade root" "$(prefix_url '/upgrade')" "${BASE_PATH}/"
check_redirect "admin about" "$(prefix_url '/adminfrontend/about')" "${BASE_PATH}/adminfrontend/system"
check_redirect "admin billing" "$(prefix_url '/adminfrontend/billing')" "${BASE_PATH}/adminfrontend/"
check_redirect "admin subscription" "$(prefix_url '/adminfrontend/subscription')" "${BASE_PATH}/adminfrontend/"

echo "[PASS] frontend scope-cut smoke suite"
