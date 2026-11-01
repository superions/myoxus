#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

WEB_IMAGE=""
ADMIN_IMAGE=""
OUTPUT_DIR=""
RUNTIME_STYLE_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFY_PUBLIC_STATIC_ROOT="$SCRIPT_DIR/verify-public-static-root.sh"
OCI_SOURCE="https://github.com/superions/myoxus"
PULL=false
CONTAINERS=()
STAGE_DIR=""

usage() {
  cat <<'EOF'
Usage:
  build/scripts/frontends/materialize-static-artifacts.sh \
    --web-image <image:tag> \
    --admin-image <image:tag> \
    --output <absolute-directory> \
    [--runtime-style-dir <absolute-directory>] \
    [--pull]

Extracts immutable Web/Admin OCI artifacts into one version-bound directory
for an operator-provided Nginx. The images are never started.
EOF
}

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

cleanup() {
  local container
  if [ "${#CONTAINERS[@]}" -gt 0 ]; then
    for container in "${CONTAINERS[@]}"; do
      docker rm -f "$container" >/dev/null 2>&1 || true
    done
  fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --web-image)
      [ "$#" -ge 2 ] || fail "--web-image requires a value"
      WEB_IMAGE="$2"
      shift 2
      ;;
    --admin-image)
      [ "$#" -ge 2 ] || fail "--admin-image requires a value"
      ADMIN_IMAGE="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || fail "--output requires a value"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --runtime-style-dir)
      [ "$#" -ge 2 ] || fail "--runtime-style-dir requires a value"
      RUNTIME_STYLE_DIR="$2"
      shift 2
      ;;
    --pull)
      PULL=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$WEB_IMAGE" ] || fail "--web-image is required"
[ -n "$ADMIN_IMAGE" ] || fail "--admin-image is required"
[ -n "$OUTPUT_DIR" ] || fail "--output is required"
case "$OUTPUT_DIR" in
  /*) ;;
  *) fail "--output must be an absolute directory" ;;
esac
case "$OUTPUT_DIR" in
  /|/usr|/var|/opt|/srv|/home|/Users) fail "refusing unsafe output directory: $OUTPUT_DIR" ;;
esac
if [ -n "$RUNTIME_STYLE_DIR" ]; then
  case "$RUNTIME_STYLE_DIR" in
    /*) ;;
    *) fail "--runtime-style-dir must be an absolute directory" ;;
  esac
  case "$RUNTIME_STYLE_DIR" in
    /|/usr|/var|/opt|/srv|/home|/Users) fail "refusing unsafe runtime style directory: $RUNTIME_STYLE_DIR" ;;
  esac
fi

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
[ -x "$VERIFY_PUBLIC_STATIC_ROOT" ] ||
  fail "public static root verifier is missing: $VERIFY_PUBLIC_STATIC_ROOT"

if [ "$PULL" = true ]; then
  echo "[INFO] pulling static OCI artifacts"
  docker pull "$WEB_IMAGE"
  docker pull "$ADMIN_IMAGE"
fi

image_label() {
  local image="$1"
  local key="$2"
  docker image inspect --format "{{ index .Config.Labels \"$key\" }}" "$image"
}

assert_oci_identity() {
  local image="$1"
  local role="$2"
  local expected_title="$3"
  local title version revision source labels
  title="$(image_label "$image" org.opencontainers.image.title)"
  version="$(image_label "$image" org.opencontainers.image.version)"
  revision="$(image_label "$image" org.opencontainers.image.revision)"
  source="$(image_label "$image" org.opencontainers.image.source)"
  labels="$(docker image inspect --format '{{json .Config.Labels}}' "$image")"

  [ "$title" = "$expected_title" ] ||
    fail "$role image title mismatch: expected '$expected_title', found '$title'"
  printf '%s' "$version" |
    grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
    fail "$role image has no complete semantic OCI version"
  case "$revision" in
    localdev) ;;
    *[!0-9a-f]*|'') fail "$role image has no valid OCI revision" ;;
    *)
      [ "${#revision}" -eq 40 ] || [ "${#revision}" -eq 64 ] ||
        fail "$role image OCI revision is not a full commit SHA"
      ;;
  esac
  [ "$source" = "$OCI_SOURCE" ] ||
    fail "$role image OCI source mismatch: $source"
  if printf '%s' "$labels" | grep -q '"org.opencontainers.image.licenses"'; then
    fail "$role image must not declare org.opencontainers.image.licenses"
  fi

  printf '%s|%s\n' "$version" "$revision"
}

# Reject mixed images from registry metadata before creating containers or
# extracting bytes. release.json is checked against the same values in the
# isolated staging directory before the existing target can be replaced.
WEB_OCI_IDENTITY="$(assert_oci_identity "$WEB_IMAGE" web "Myoxus Web static artifact")"
ADMIN_OCI_IDENTITY="$(assert_oci_identity "$ADMIN_IMAGE" admin "Myoxus Admin static artifact")"
[ "$WEB_OCI_IDENTITY" = "$ADMIN_OCI_IDENTITY" ] ||
  fail "Web/Admin OCI release identity mismatch: Web $WEB_OCI_IDENTITY, Admin $ADMIN_OCI_IDENTITY"
RELEASE_VERSION="${WEB_OCI_IDENTITY%%|*}"
RELEASE_REVISION="${WEB_OCI_IDENTITY#*|}"

parent_dir="$(dirname "$OUTPUT_DIR")"
mkdir -p "$parent_dir"
STAGE_DIR="$(mktemp -d "$parent_dir/.myoxus-frontends.XXXXXX")"

extract_artifact() {
  local image="$1"
  local destination="$2"
  local container
  mkdir -p "$destination"
  container="$(docker create "$image" /__myoxus_static_artifact_only__)"
  CONTAINERS+=("$container")
  # `docker cp` preserves the artifact's numeric owner. Extract its tar stream
  # as the invoking operator instead, otherwise a later atomic replacement can
  # install successfully and then fail while removing its root-owned backup.
  docker cp "$container:/myoxus-artifact/." - |
    tar --extract --file - --directory "$destination" --no-same-owner
  docker rm "$container" >/dev/null
  CONTAINERS=("${CONTAINERS[@]:1}")
}

WEB_STAGE="$STAGE_DIR/.web-artifact"
ADMIN_STAGE="$STAGE_DIR/.admin-artifact"
echo "[INFO] extracting Web artifact: $WEB_IMAGE"
extract_artifact "$WEB_IMAGE" "$WEB_STAGE"
echo "[INFO] extracting Admin artifact: $ADMIN_IMAGE"
extract_artifact "$ADMIN_IMAGE" "$ADMIN_STAGE"

assert_release_json() {
  local file="$1"
  local role="$2"
  local expected actual
  [ -f "$file" ] || fail "$role artifact is missing release.json"
  # The producer owns one canonical, deterministic serialization. Comparing it
  # exactly keeps the standalone materializer fail-closed without adding a
  # Node, Python or jq dependency to deployment hosts.
  expected="$(printf '{\n  "schemaVersion": 1,\n  "role": "%s",\n  "clientVersion": "%s",\n  "editorVersion": "%s",\n  "revision": "%s"\n}' \
    "$role" "$RELEASE_VERSION" "$RELEASE_VERSION" "$RELEASE_REVISION")"
  actual="$(cat "$file")"
  [ "$actual" = "$expected" ] ||
    fail "$role release.json does not match its OCI release identity"
}

assert_release_json "$WEB_STAGE/release.json" web
assert_release_json "$ADMIN_STAGE/release.json" admin

[ -d "$WEB_STAGE/web" ] || fail "Web artifact is missing its Web root"
[ ! -e "$WEB_STAGE/admin" ] || fail "Web artifact contains an Admin root"
[ -d "$ADMIN_STAGE/admin" ] || fail "Admin artifact is missing its Admin root"
[ ! -e "$ADMIN_STAGE/web" ] || fail "Admin artifact contains a Web root"
for path in "$ADMIN_STAGE"/*; do
  case "$(basename "$path")" in
    admin|release.json) ;;
    *) fail "Admin artifact contains unexpected top-level path: $(basename "$path")" ;;
  esac
done

for path in "$WEB_STAGE"/*; do
  case "$(basename "$path")" in
    web|api|style|canonical-style|deployment|release.json) ;;
    *) fail "Web artifact contains unexpected top-level path: $(basename "$path")" ;;
  esac
done

mkdir -p "$WEB_STAGE/deployment/release-identities"
mv "$WEB_STAGE/release.json" "$WEB_STAGE/deployment/release-identities/web.json"
mv "$ADMIN_STAGE/release.json" "$WEB_STAGE/deployment/release-identities/admin.json"
mv "$WEB_STAGE"/* "$STAGE_DIR/"
mv "$ADMIN_STAGE/admin" "$STAGE_DIR/admin"
rmdir "$WEB_STAGE" "$ADMIN_STAGE"

verify_shell() {
  local role="$1"
  local shell="$STAGE_DIR/$role/selfhost.html"
  [ -f "$shell" ] || fail "$role artifact is missing selfhost.html"
  grep -qi '<html' "$shell" || fail "$role selfhost.html is not an HTML shell"
  grep -qi 'myoxus' "$shell" || fail "$role selfhost.html is missing Myoxus identity"
  [ -d "$STAGE_DIR/$role/js" ] || fail "$role artifact is missing its js directory"
}

verify_shell web
verify_shell admin
[ ! -e "$STAGE_DIR/admin/adminfrontend" ] || fail "Admin artifact contains a nested Admin root"
"$VERIFY_PUBLIC_STATIC_ROOT" "$STAGE_DIR/web"
"$VERIFY_PUBLIC_STATIC_ROOT" "$STAGE_DIR/admin"
if find "$STAGE_DIR" -type f \( -name '*.spec.js' -o -name '*.d.ts' -o -name 'tsconfig.tsbuildinfo' \) | grep -q .; then
  fail "static artifacts contain compiler or test files"
fi
find "$STAGE_DIR/api/fonts" -type f \( -name '*.woff2' -o -name '*.ttf' -o -name '*.otf' \) -print -quit | grep -q . ||
  fail "Web artifact is missing font files"
for channel in stable beta internal canary; do
  [ -f "$STAGE_DIR/web/imgs/app-icon-$channel.ico" ] || fail "Web artifact is missing app-icon-$channel.ico"
done
[ -f "$STAGE_DIR/style/theme-fallback.css" ] || fail "Frontend artifact is missing the Electron offline theme catalog"
[ -f "$STAGE_DIR/style/artwork/auth-background.svg" ] || fail "Frontend artifact is missing the shared artwork catalog"
for vector in "$STAGE_DIR"/style/artwork/*.svg; do
  [ -f "${vector%.svg}.webp" ] || fail "Artwork vector is missing its WebP pair: $(basename "$vector")"
done
[ -f "$STAGE_DIR/canonical-style/logo.svg" ] || fail "Web artifact is missing canonical logo"
[ -f "$STAGE_DIR/canonical-style/product-mark.svg" ] || fail "Web artifact is missing canonical product mark"
[ -f "$STAGE_DIR/deployment/nginx/myoxus.conf" ] || fail "Web artifact is missing the read-only operator Nginx template"
[ -f "$STAGE_DIR/deployment/nginx/render-basepath-nginx.sh" ] || fail "Web artifact is missing the Nginx base-path renderer"
[ -f "$STAGE_DIR/deployment/verify-public-static-root.sh" ] || fail "Web artifact is missing the public bundle verifier"
[ -f "$STAGE_DIR/deployment/prepare-swarm-state.sh" ] || fail "Web artifact is missing the Swarm state preflight"
[ -f "$STAGE_DIR/deployment/docker-stack.registry.yml" ] || fail "Web artifact is missing the Swarm topology"
[ -f "$STAGE_DIR/deployment/docker-compose.selfhost.yml" ] || fail "Web artifact is missing the Compose topology"
[ -f "$STAGE_DIR/deployment/docker-compose.registry.yml" ] || fail "Web artifact is missing the Compose registry overlay"

# Extraction can inherit a restrictive caller umask. Normalize release assets
# before copying them to either public root, including external artwork mounts.
chmod -R a+rX "$STAGE_DIR"

if [ -n "$RUNTIME_STYLE_DIR" ]; then
  mkdir -p "$RUNTIME_STYLE_DIR"
  chmod a+rx "$RUNTIME_STYLE_DIR"
  # Artwork is release-owned. Refresh it even when operator theme files exist.
  if [ -d "$STAGE_DIR/style/artwork" ]; then
    mkdir -p "$RUNTIME_STYLE_DIR/artwork"
    cp -a "$STAGE_DIR/style/artwork/." "$RUNTIME_STYLE_DIR/artwork/"
  fi
  for source in "$STAGE_DIR"/style/*; do
    [ -f "$source" ] || continue
    target="$RUNTIME_STYLE_DIR/$(basename "$source")"
    [ -e "$target" ] || cp -a "$source" "$target"
  done
fi

backup_dir="${OUTPUT_DIR}.previous.$$"
rm -rf "$backup_dir"
if [ -e "$OUTPUT_DIR" ]; then
  mv "$OUTPUT_DIR" "$backup_dir"
fi
if ! mv "$STAGE_DIR" "$OUTPUT_DIR"; then
  if [ -e "$backup_dir" ]; then
    mv "$backup_dir" "$OUTPUT_DIR"
  fi
  fail "could not atomically install frontend assets"
fi
STAGE_DIR=""
rm -rf "$backup_dir"

echo "[PASS] materialized static frontend artifacts"
echo "       web:   $WEB_IMAGE"
echo "       admin: $ADMIN_IMAGE"
echo "       root:  $OUTPUT_DIR"
if [ -n "$RUNTIME_STYLE_DIR" ]; then
  echo "       style: $RUNTIME_STYLE_DIR"
fi
