#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

required_files=(
  "assets/branding/myoxus_text.svg"
  "client/libs/icons/src/assets/platform/browser-favicon.svg"
  "client/branding/brand-identity-fallback.json"
  "client/branding/theme-fallback.css"
)

missing=0
for rel in "${required_files[@]}"; do
  abs="$ROOT_DIR/$rel"
  if [[ ! -f "$abs" ]]; then
    echo "[FAIL] missing branding artifact: $rel"
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

node "$ROOT_DIR/build/scripts/artwork/generate-myoxus-artworks.mjs" --check

echo "[PASS] branding artifacts are complete"
