#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
OUTPUT_DIR="$TMP_DIR/current"
REVISION_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REVISION_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
IMAGES=()

cleanup() {
  if [ "${#IMAGES[@]}" -gt 0 ]; then
    docker image rm "${IMAGES[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

build_fixture() {
  local name="$1"
  local role="$2"
  local version="$3"
  local revision="$4"
  local json_revision="$5"
  local title context
  context="$TMP_DIR/$name"
  case "$role" in
    web) title="Myoxus Web static artifact" ;;
    admin) title="Myoxus Admin static artifact" ;;
    *) echo "unsupported fixture role: $role" >&2; exit 2 ;;
  esac
  mkdir -p "$context/payload"
  printf 'fixture\n' >"$context/payload/marker"
  printf '{\n  "schemaVersion": 1,\n  "role": "%s",\n  "clientVersion": "%s",\n  "editorVersion": "%s",\n  "revision": "%s"\n}\n' \
    "$role" "$version" "$version" "$json_revision" >"$context/release.json"
  printf '%s\n' \
    'FROM scratch' \
    "LABEL org.opencontainers.image.title=\"$title\" \\" \
    "      org.opencontainers.image.version=\"$version\" \\" \
    "      org.opencontainers.image.revision=\"$revision\" \\" \
    '      org.opencontainers.image.source="https://github.com/superions/myoxus"' \
    'COPY release.json /myoxus-artifact/release.json' \
    "COPY payload/ /myoxus-artifact/$role/" >"$context/Dockerfile"
  docker build --quiet --tag "$name" "$context" >/dev/null
  IMAGES+=("$name")
}

assert_target_unchanged() {
  [ "$(cat "$OUTPUT_DIR/preserved")" = preserved ] || {
    echo "[FAIL] failed materialization changed the existing target" >&2
    exit 1
  }
  [ "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] || {
    echo "[FAIL] failed materialization added files to the existing target" >&2
    exit 1
  }
  if find "$TMP_DIR" -maxdepth 1 -name '.myoxus-frontends.*' -print -quit |
    grep -q .; then
    echo "[FAIL] failed materialization leaked a staging directory" >&2
    exit 1
  fi
}

expect_failure() {
  local label="$1"
  local web_image="$2"
  local admin_image="$3"
  local expected="$4"
  if "$REPO_ROOT/build/scripts/frontends/materialize-static-artifacts.sh" \
    --web-image "$web_image" \
    --admin-image "$admin_image" \
    --output "$OUTPUT_DIR" >"$TMP_DIR/$label.log" 2>&1; then
    echo "[FAIL] materializer accepted $label" >&2
    exit 1
  fi
  grep -q "$expected" "$TMP_DIR/$label.log" || {
    echo "[FAIL] materializer rejected $label for the wrong reason" >&2
    cat "$TMP_DIR/$label.log" >&2
    exit 1
  }
  assert_target_unchanged
}

mkdir -p "$OUTPUT_DIR"
printf 'preserved\n' >"$OUTPUT_DIR/preserved"

prefix="myoxus-release-identity-test-$$"
build_fixture "$prefix-web" web 9.8.7 "$REVISION_A" "$REVISION_A"
build_fixture "$prefix-admin-version" admin 9.8.6 "$REVISION_A" "$REVISION_A"
build_fixture "$prefix-admin-revision" admin 9.8.7 "$REVISION_B" "$REVISION_B"
build_fixture "$prefix-admin-json" admin 9.8.7 "$REVISION_A" "$REVISION_B"

expect_failure version-mismatch "$prefix-web" "$prefix-admin-version" \
  "OCI release identity mismatch"
expect_failure revision-mismatch "$prefix-web" "$prefix-admin-revision" \
  "OCI release identity mismatch"
expect_failure release-json-mismatch "$prefix-web" "$prefix-admin-json" \
  "release.json does not match"

echo "[PASS] materializer rejects mixed release identity without target mutation"
