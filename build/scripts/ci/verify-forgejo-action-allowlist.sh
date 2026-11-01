#!/usr/bin/env bash
# Verifies that Forgejo workflows only use reviewed external actions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

violations="$(mktemp)"
trap 'rm -f "$violations"' EXIT

if command -v rg >/dev/null 2>&1; then
  grep_uses() {
    rg -n '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*' .forgejo
  }
else
  grep_uses() {
    grep -RInE '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*' .forgejo
  }
fi

grep_uses \
  | while IFS= read -r line; do
    file="${line%%:*}"
    rest="${line#*:}"
    line_no="${rest%%:*}"
    action="${line##*uses:}"
    action="${action%%#*}"
    action="$(printf '%s' "$action" | xargs)"
    case "$action" in
      actions/checkout@v7)
        checkout_block="$(
          sed -n "${line_no},$((line_no + 8))p" "$file"
        )"
        if ! printf '%s\n' "$checkout_block" \
          | grep -qE '^[[:space:]]+set-safe-directory:[[:space:]]*false[[:space:]]*$'; then
          printf '%s\n' "$line"
          printf '  actions/checkout@v7 must set set-safe-directory: false\n'
        fi
        ;;
      https://data.forgejo.org/forgejo/upload-artifact@cb8afe72b42edc798abfb8fcb556cf660d894245|https://data.forgejo.org/forgejo/download-artifact@8d4e9521a5f7e5f8b6351f341f719f9f45a92a3a)
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done >"$violations"

if [ -s "$violations" ]; then
  echo "Unreviewed Forgejo action reference(s):" >&2
  cat "$violations" >&2
  exit 1
fi
