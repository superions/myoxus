#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
SUFFIX="$$-$RANDOM"
WEB_IMAGE="myoxus-web-packaged-test-$SUFFIX"
ADMIN_IMAGE="myoxus-admin-packaged-test-$SUFFIX"
TMP_DIR="$(mktemp -d)"

cleanup() {
  docker image rm "$WEB_IMAGE" "$ADMIN_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# These are intentionally the source Dockerfiles used by the release workflow.
# Each role is built once and its emitted bundle, release.json and OCI labels are
# consumed by test-static-artifact-image.sh.
"$REPO_ROOT/build/scripts/frontends/test-static-artifact-image.sh" \
  --role web \
  --dockerfile build/web/Dockerfile \
  --image-name "$WEB_IMAGE" \
  --keep-image
"$REPO_ROOT/build/scripts/frontends/test-static-artifact-image.sh" \
  --role admin \
  --dockerfile build/admin/Dockerfile \
  --image-name "$ADMIN_IMAGE" \
  --keep-image

"$REPO_ROOT/build/scripts/frontends/materialize-static-artifacts.sh" \
  --web-image "$WEB_IMAGE" \
  --admin-image "$ADMIN_IMAGE" \
  --output "$TMP_DIR/current"
[ -f "$TMP_DIR/current/web/selfhost.html" ]
[ -f "$TMP_DIR/current/admin/selfhost.html" ]
[ -f "$TMP_DIR/current/deployment/release-identities/web.json" ]
[ -f "$TMP_DIR/current/deployment/release-identities/admin.json" ]

"$REPO_ROOT/build/scripts/frontends/test-materialize-release-identity.sh"

echo "[PASS] packaged Web/Admin release identity"
