#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
ROLE=""
DOCKERFILE=""
IMAGE=""
KEEP_IMAGE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --dockerfile) DOCKERFILE="${2:-}"; shift 2 ;;
    --image-name) IMAGE="${2:-}"; shift 2 ;;
    --keep-image) KEEP_IMAGE=true; shift ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$ROLE" in web|admin) ;; *) echo "[FAIL] --role must be web or admin" >&2; exit 2 ;; esac
[ -n "$DOCKERFILE" ] || { echo "[FAIL] --dockerfile is required" >&2; exit 2; }

IMAGE="${IMAGE:-myoxus-${ROLE}-artifact-test-$$}"
CONTAINER=""
TMP_DIR="$(mktemp -d)"
REVISION=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf localdev)"
fi
CLIENT_VERSION="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role "$ROLE" \
    --revision "$REVISION" \
    --print-version
)"
cleanup() {
  [ -z "$CONTAINER" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$KEEP_IMAGE" = false ]; then
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

docker build \
  --build-arg "GITHUB_SHA=$REVISION" \
  --build-arg "MYOXUS_CLIENT_VERSION=$CLIENT_VERSION" \
  --file "$REPO_ROOT/$DOCKERFILE" \
  --tag "$IMAGE" \
  "$REPO_ROOT"
CONTAINER="$(docker create "$IMAGE" /__myoxus_static_artifact_only__)"
docker cp "$CONTAINER:/myoxus-artifact/." - |
  tar --extract --file - --directory "$TMP_DIR" --no-same-owner

[ -f "$TMP_DIR/$ROLE/selfhost.html" ] || {
  echo "[FAIL] $ROLE artifact has no selfhost.html" >&2
  exit 1
}
[ -f "$TMP_DIR/release.json" ] || {
  echo "[FAIL] $ROLE artifact has no release.json" >&2
  exit 1
}
"$REPO_ROOT/build/scripts/frontends/verify-public-static-root.sh" "$TMP_DIR/$ROLE"
if [ "$ROLE" = web ]; then
  [ ! -e "$TMP_DIR/admin" ] || { echo "[FAIL] Web artifact contains Admin" >&2; exit 1; }
  [ -f "$TMP_DIR/deployment/nginx/myoxus.conf" ] || { echo "[FAIL] Web artifact lacks the read-only Nginx template" >&2; exit 1; }
  [ -f "$TMP_DIR/deployment/prepare-swarm-state.sh" ] || { echo "[FAIL] Web artifact lacks Swarm state preflight" >&2; exit 1; }
  [ -f "$TMP_DIR/deployment/prepare-templates.sh" ] || { echo "[FAIL] Web artifact lacks mail template preparation" >&2; exit 1; }
  [ -f "$TMP_DIR/deployment/docker-stack.registry.yml" ] || { echo "[FAIL] Web artifact lacks Swarm stack" >&2; exit 1; }
  [ -f "$TMP_DIR/deployment/docker-compose.selfhost.yml" ] || { echo "[FAIL] Web artifact lacks Compose stack" >&2; exit 1; }
  [ -f "$TMP_DIR/style/theme-fallback.css" ] || { echo "[FAIL] Frontend artifact lacks the Electron offline theme catalog" >&2; exit 1; }
else
  [ ! -e "$TMP_DIR/web" ] || { echo "[FAIL] Admin artifact contains Web" >&2; exit 1; }
  [ ! -e "$TMP_DIR/deployment" ] || { echo "[FAIL] Admin artifact contains deployment topology" >&2; exit 1; }
  [ ! -e "$TMP_DIR/style" ] || { echo "[FAIL] Admin artifact contains shared style assets" >&2; exit 1; }
fi

inspect="$(docker image inspect "$IMAGE")"
printf '%s\n' "$inspect" >"$TMP_DIR/image-inspect.json"
node "$REPO_ROOT/build/scripts/ci/verify-built-release-identity.mjs" \
  --role "$ROLE" \
  --revision "$REVISION" \
  --build-dir "$TMP_DIR/$ROLE" \
  --root-manifest "$REPO_ROOT/package.json" \
  --release-json "$TMP_DIR/release.json" \
  --image-inspect "$TMP_DIR/image-inspect.json" \
  --worker-source "$REPO_ROOT/client/libs/env/src/worker.ts"
node -e '
const image = JSON.parse(process.argv[1])[0];
const config = image.Config ?? {};
if (config.Entrypoint?.length) throw new Error("static artifact must not have an entrypoint");
if (config.Cmd?.length) throw new Error("static artifact must not have a command");
if (config.ExposedPorts && Object.keys(config.ExposedPorts).length) {
  throw new Error("static artifact must not expose ports");
}
' "$inspect"

echo "[PASS] $ROLE is a non-runnable static OCI artifact"
