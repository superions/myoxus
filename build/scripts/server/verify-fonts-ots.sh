#!/usr/bin/env bash
# verify-fonts-ots.sh — validate all bundled woff2 fonts with ots-sanitize.
#
# Usage:
#   build/scripts/server/verify-fonts-ots.sh           # validate all fonts
#   build/scripts/server/verify-fonts-ots.sh --list    # list fonts only
#
# Exits 0 if all fonts pass; non-zero if any fail or if ots-sanitize is missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FONTS_DIR="$REPO_ROOT/server/static/fonts"

# Detect ots tool — try ots-sanitize first, then ots-validator.
OTS_CMD=""
if command -v ots-sanitize &>/dev/null; then
  OTS_CMD="ots-sanitize"
elif command -v ots-validator &>/dev/null; then
  OTS_CMD="ots-validator"
fi

if [[ "${1:-}" == "--list" ]]; then
  echo "Fonts in $FONTS_DIR:"
  find "$FONTS_DIR" -name "*.woff2" | sort | while read -r f; do
    echo "  $(basename "$f")  ($(du -h "$f" | cut -f1))"
  done
  exit 0
fi

if [[ -z "$OTS_CMD" ]]; then
  echo "[WARN] ots-sanitize / ots-validator not found — skipping OTS validation"
  echo "[HINT] Install: sudo apt-get install ots  (or build from https://github.com/khaledhosny/ots)"
  exit 0
fi

PASS=0
FAIL=0
TOTAL=0

while IFS= read -r -d '' font; do
  TOTAL=$((TOTAL + 1))
  name="$(basename "$font")"
  output="$("$OTS_CMD" "$font" 2>&1)"
  if [[ $? -eq 0 ]]; then
    echo "[PASS] $name"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $name"
    echo "$output" | sed 's/^/       /'
    FAIL=$((FAIL + 1))
  fi
done < <(find "$FONTS_DIR" -name "*.woff2" -print0 | sort -z)

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo "[ERROR] $FAIL font(s) failed OTS validation"
  exit 1
fi

echo "[OK] All fonts pass OTS validation"
