#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify-build
OUTPUT_DIR="${MYOXUS_FRONTEND_ASSET_ROOT:-$REPO_ROOT/build/server/runtime-frontends/current}"
WEB_IMAGE="${MYOXUS_LOCAL_WEB_IMAGE:-myoxus-web-frontend:local}"
ADMIN_IMAGE="${MYOXUS_LOCAL_ADMIN_IMAGE:-myoxus-admin-frontend:local}"
REVISION=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf localdev)"
fi
CLIENT_VERSION="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role web \
    --revision "$REVISION" \
    --print-version
)"
BUILD_FLAGS=()

if [ "${1:-}" = "--no-cache" ]; then
  BUILD_FLAGS+=(--no-cache)
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--no-cache]" >&2
  exit 2
fi

build_artifact() {
  local dockerfile="$1"
  local image="$2"
  echo "[INFO] building static OCI artifact $image"
  if [ "${#BUILD_FLAGS[@]}" -gt 0 ]; then
    docker build \
      "${BUILD_FLAGS[@]}" \
      --build-arg "GITHUB_SHA=$REVISION" \
      --build-arg "MYOXUS_CLIENT_VERSION=$CLIENT_VERSION" \
      --file "$REPO_ROOT/$dockerfile" \
      --tag "$image" \
      "$REPO_ROOT"
  else
    docker build \
      --build-arg "GITHUB_SHA=$REVISION" \
      --build-arg "MYOXUS_CLIENT_VERSION=$CLIENT_VERSION" \
      --file "$REPO_ROOT/$dockerfile" \
      --tag "$image" \
      "$REPO_ROOT"
  fi
}

build_artifact build/web/Dockerfile "$WEB_IMAGE"
build_artifact build/admin/Dockerfile "$ADMIN_IMAGE"

"$REPO_ROOT/build/scripts/frontends/materialize-static-artifacts.sh" \
  --web-image "$WEB_IMAGE" \
  --admin-image "$ADMIN_IMAGE" \
  --output "$OUTPUT_DIR" \
  --runtime-style-dir "$MYOXUS_STYLE_HOST_DIR"

echo "[PASS] local frontend artifacts are ready at $OUTPUT_DIR"
