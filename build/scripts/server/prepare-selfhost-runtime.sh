#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prepare bind mounts and Compose secret files before rendering the selfhost stack.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify
SERVER_DIR="$REPO_ROOT/build/server"
POSTGRES_SECRET_EXPLICIT="${MYOXUS_POSTGRES_PASSWORD_FILE+x}"
CRYPTO_SECRET_EXPLICIT="${MYOXUS_CRYPTO_PRIVATE_KEY_FILE+x}"

export MYOXUS_RUNTIME_CONFIG_DIR="${MYOXUS_RUNTIME_CONFIG_DIR:-$SERVER_DIR/runtime-config}"
export MYOXUS_STYLE_HOST_DIR="${MYOXUS_STYLE_HOST_DIR:-$REPO_ROOT/client/branding}"
export MYOXUS_TEMPLATE_HOST_DIR="${MYOXUS_TEMPLATE_HOST_DIR:-$SERVER_DIR/templates}"
export MYOXUS_POSTGRES_PASSWORD_FILE="${MYOXUS_POSTGRES_PASSWORD_FILE:-$SERVER_DIR/runtime-secrets/postgres_password}"
export MYOXUS_CRYPTO_PRIVATE_KEY_FILE="${MYOXUS_CRYPTO_PRIVATE_KEY_FILE:-$SERVER_DIR/runtime-secrets/crypto_private_key}"
export MYOXUS_API_USER="${MYOXUS_API_USER:-1000:1000}"

API_UID="${MYOXUS_API_USER%%:*}"
API_GID="${MYOXUS_API_USER#*:}"
if [[ ! "$API_UID" =~ ^[0-9]+$ || ! "$API_GID" =~ ^[0-9]+$ ]]; then
  echo "[FAIL] MYOXUS_API_USER must be numeric UID:GID" >&2
  return 1 2>/dev/null || exit 1
fi


mkdir -p \
  "$MYOXUS_RUNTIME_CONFIG_DIR" \
  "$MYOXUS_STYLE_HOST_DIR" \
  "$(dirname "$MYOXUS_POSTGRES_PASSWORD_FILE")" \
  "$(dirname "$MYOXUS_CRYPTO_PRIVATE_KEY_FILE")"

if [[ ! -e "$MYOXUS_RUNTIME_CONFIG_DIR/local.yaml" ]]; then
  printf '{}\n' >"$MYOXUS_RUNTIME_CONFIG_DIR/local.yaml"
fi
if [[ ! -e "$MYOXUS_POSTGRES_PASSWORD_FILE" ]]; then
  if [[ -n "$POSTGRES_SECRET_EXPLICIT" || "${RUN_MODE:-development}" == "production" ]]; then
    echo "[FAIL] configured PostgreSQL password secret file is missing" >&2
    return 1 2>/dev/null || exit 1
  fi
  umask 077
  printf '%s' "${POSTGRES_PASSWORD:-myoxus}" >"$MYOXUS_POSTGRES_PASSWORD_FILE"
fi
if [[ ! -e "$MYOXUS_CRYPTO_PRIVATE_KEY_FILE" ]]; then
  if [[ -n "$CRYPTO_SECRET_EXPLICIT" || "${RUN_MODE:-development}" == "production" ]]; then
    echo "[FAIL] configured crypto private-key secret file is missing" >&2
    return 1 2>/dev/null || exit 1
  fi
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 >"$MYOXUS_CRYPTO_PRIVATE_KEY_FILE"
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$MYOXUS_CRYPTO_PRIVATE_KEY_FILE"
  fi
fi
chmod 600 "$MYOXUS_POSTGRES_PASSWORD_FILE" "$MYOXUS_CRYPTO_PRIVATE_KEY_FILE"

repair_mount_owner() {
  local path="$1"
  local path_owner
  if stat -c '%u:%g' "$path" >/dev/null 2>&1; then
    path_owner="$(stat -c '%u:%g' "$path")"
  else
    path_owner="$(stat -f '%u:%g' "$path")"
  fi
  if [[ "$API_UID:$API_GID" == "$path_owner" && -w "$path" ]]; then
    return
  fi
  command -v docker >/dev/null 2>&1 || {
    echo "[FAIL] $path is not writable by API UID:GID $API_UID:$API_GID and Docker is unavailable to repair it" >&2
    return 1
  }
  docker run --rm -v "$path:/target" alpine:3.20 sh -ec \
    "chown $API_UID:$API_GID /target && chmod u+rwX /target" >/dev/null
}

repair_mount_owner "$MYOXUS_RUNTIME_CONFIG_DIR"
repair_mount_owner "$MYOXUS_STYLE_HOST_DIR"

repair_secret_owner() {
  local path="$1"
  local path_owner
  if stat -c '%u:%g' "$path" >/dev/null 2>&1; then
    path_owner="$(stat -c '%u:%g' "$path")"
  else
    path_owner="$(stat -f '%u:%g' "$path")"
  fi
  if [[ "$API_UID:$API_GID" == "$path_owner" ]]; then
    return
  fi
  command -v docker >/dev/null 2>&1 || {
    echo "[FAIL] $path is not readable by API UID:GID $API_UID:$API_GID and Docker is unavailable to repair it" >&2
    return 1
  }
  docker run --rm -v "$path:/target" alpine:3.20 sh -ec \
    "chown $API_UID:$API_GID /target && chmod 600 /target" >/dev/null
}

repair_secret_owner "$MYOXUS_POSTGRES_PASSWORD_FILE"
repair_secret_owner "$MYOXUS_CRYPTO_PRIVATE_KEY_FILE"

for path in "$MYOXUS_RUNTIME_CONFIG_DIR" "$MYOXUS_STYLE_HOST_DIR"; do
  if ! docker run --rm --user "$API_UID:$API_GID" -v "$path:/target" alpine:3.20 test -w /target; then
    echo "[FAIL] bind mount $path is not writable by API UID:GID $API_UID:$API_GID" >&2
    return 1 2>/dev/null || exit 1
  fi
done
if ! docker run --rm --user "$API_UID:$API_GID" \
  -v "$MYOXUS_RUNTIME_CONFIG_DIR:/target" alpine:3.20 \
  sh -ec 'test ! -e /target/local.yaml || test -r /target/local.yaml'; then
  echo "[FAIL] runtime overlay local.yaml is not readable by API UID:GID $API_UID:$API_GID" >&2
  return 1 2>/dev/null || exit 1
fi
for path in \
  "$MYOXUS_POSTGRES_PASSWORD_FILE" \
  "$MYOXUS_CRYPTO_PRIVATE_KEY_FILE"
do
  if ! docker run --rm --user "$API_UID:$API_GID" \
    -v "$path:/target:ro" alpine:3.20 test -r /target; then
    echo "[FAIL] secret file $path is not readable by API UID:GID $API_UID:$API_GID" >&2
    return 1 2>/dev/null || exit 1
  fi
done
# Preparation uses an already-built matching distribution. Authoring inputs
# must be packed explicitly; this lifecycle helper never builds product binaries.
prepare_myoxus_templates() (
  set -euo pipefail
  local selected_image="${MYOXUS_TEMPLATE_VALIDATOR_IMAGE:-${MYOXUS_API_IMAGE:-}}"
  local packed_root=""
  trap 'if [[ -n "$packed_root" ]]; then rm -rf "$packed_root"; fi' EXIT
  if [[ -n "$selected_image" ]]; then
    bash "$REPO_ROOT/build/scripts/server/prepare-templates.sh" \
      --server-image "$selected_image" --output "$MYOXUS_TEMPLATE_HOST_DIR"
  elif [[ -n "${MYOXUS_TEMPLATE_VALIDATOR:-}" ]]; then
    packed_root="$(mktemp -d)"
    "$MYOXUS_TEMPLATE_VALIDATOR" templates feature-bundle pack \
      --root "$REPO_ROOT/server/templates" --manifest features/base/manifest.yaml \
      --release-base --output "$packed_root"
    # Non-feature families keep their existing independent preparation owner.
    for family in mail pdf html; do
      if [[ -d "$REPO_ROOT/server/templates/$family" ]]; then
        cp -a "$REPO_ROOT/server/templates/$family" "$packed_root/templates/$family"
      fi
    done
    bash "$REPO_ROOT/build/scripts/server/prepare-templates.sh" \
      --source-dir "$packed_root/templates" --validator "$MYOXUS_TEMPLATE_VALIDATOR" \
      --release-manifest "$packed_root/static/features/release.yaml" --output "$MYOXUS_TEMPLATE_HOST_DIR"
  else
    echo "[FAIL] provide the matching MYOXUS_API_IMAGE, MYOXUS_TEMPLATE_VALIDATOR_IMAGE or already-built MYOXUS_TEMPLATE_VALIDATOR" >&2
    return 1
  fi
  if ! docker run --rm --user "$API_UID:$API_GID" \
    -v "$MYOXUS_TEMPLATE_HOST_DIR:/templates:ro" alpine:3.20 \
    sh -ec 'test -d /templates/mail && test -f /templates/features/catalog.yaml; unreadable=$(find -L /templates ! -type d ! -exec test -r {} \; -print); test -z "$unreadable" || { printf "Unreadable template paths: %s\n" "$unreadable" >&2; exit 1; }'; then
    echo "[FAIL] templates are not readable by API UID:GID $API_UID:$API_GID" >&2
    return 1
  fi
)
if [[ "${MYOXUS_DEFER_TEMPLATE_PREPARATION:-false}" != true ]]; then
  prepare_myoxus_templates
fi
