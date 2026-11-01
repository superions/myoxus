#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

STATIC_ROOT="${1:-}"

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

[ -n "$STATIC_ROOT" ] || fail "static root argument is required"
[ -d "$STATIC_ROOT" ] || fail "static root does not exist: $STATIC_ROOT"

map_file="$(find "$STATIC_ROOT" -type f -name '*.map' -print -quit)"
[ -z "$map_file" ] || fail "public static root contains a source map: $map_file"

reference_file="$(
  grep -R -I -l -E \
    --include='*.js' \
    --include='*.mjs' \
    --include='*.cjs' \
    --include='*.css' \
    '/(/|\*)[#@][[:space:]]*sourceMappingURL[[:space:]]*=' \
    "$STATIC_ROOT" 2>/dev/null | head -n 1 || true
)"
[ -z "$reference_file" ] ||
  fail "public bundle contains a dangling sourceMappingURL reference: $reference_file"

echo "[PASS] public static root has no source maps or public map references: $STATIC_ROOT"
