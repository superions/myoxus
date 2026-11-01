#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/dist/ci/dependency-health/electron-cargo}"
VALIDATOR="$REPO_ROOT/build/scripts/ci/verify-electron-cargo-audit.mjs"

cd "$REPO_ROOT"
mkdir -p "$OUTPUT_DIR"
# This directory is an owned report surface. Remove only files produced by
# this script so a target removed from the matrix cannot survive in summary.
rm -f "$OUTPUT_DIR"/*.reachable "$OUTPUT_DIR"/*.audit.json \
  "$OUTPUT_DIR"/*.result.json "$OUTPUT_DIR"/summary.json
node "$VALIDATOR" --self-test

targets=(
  "x86_64-unknown-linux-gnu:linux:x86_64"
  "aarch64-unknown-linux-gnu:linux:aarch64"
  "x86_64-apple-darwin:macos:x86_64"
  "aarch64-apple-darwin:macos:aarch64"
  "x86_64-pc-windows-msvc:windows:x86_64"
)

for target_spec in "${targets[@]}"; do
  IFS=: read -r target target_os target_arch <<<"$target_spec"
  reachable="$OUTPUT_DIR/$target.reachable"
  audit="$OUTPUT_DIR/$target.audit.json"
  result="$OUTPUT_DIR/$target.result.json"

  cargo tree --locked --target "$target" \
    -p myoxus-local-store-native \
    -p myoxus-media-capture-native \
    -p myoxus-crypto \
    --features myoxus-crypto/napi \
    --prefix none --format '{p}' \
    | sed -E 's/ \(\*\)$//; s/ \(proc-macro\)$//' \
    | sed -nE 's/^(.+) v([^ ]+)( .*)?$/\1@\2/p' \
    | sort -u >"$reachable"

  set +e
  cargo audit --file Cargo.lock --json \
    --target-os "$target_os" --target-arch "$target_arch" >"$audit"
  audit_status=$?
  set -e
  if ! jq -e '.vulnerabilities and .warnings' "$audit" >/dev/null; then
    echo "Electron Cargo audit did not produce valid JSON for $target (status $audit_status)" >&2
    exit 1
  fi

  node "$VALIDATOR" --audit-file "$audit" --reachable-file "$reachable" \
    --target "$target" --output "$result"
done

jq -s '{targets: ., blocked: ([.[].blocked[]] | length), reported: ([.[].reported[]] | length)}' \
  "$OUTPUT_DIR"/*.result.json >"$OUTPUT_DIR/summary.json"
jq -e '.blocked == 0' "$OUTPUT_DIR/summary.json" >/dev/null
echo "Electron Cargo target audit passed: $OUTPUT_DIR/summary.json"
