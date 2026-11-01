#!/usr/bin/env bash
# Verifies that an artifact manifest lists every staged artifact file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <artifact-dir> [manifest-name]" >&2
  exit 2
fi

artifact_dir="$1"
manifest_name="${2:-ARTIFACTS.md}"
manifest_path="$artifact_dir/$manifest_name"

test -d "$artifact_dir"
test -s "$manifest_path"

missing=0
while IFS= read -r file; do
  rel="${file#"$artifact_dir"/}"
  if ! grep -Fq "\`$rel\`" "$manifest_path"; then
    echo "Artifact manifest does not list: $rel" >&2
    missing=1
  fi
done < <(
  while IFS= read -r file; do
    name="${file##*/}"
    if [ "$name" != "$manifest_name" ] && [ "$name" != SHA256SUMS ]; then
      printf '%s\n' "$file"
    fi
  done < <(bash "$SCRIPT_DIR/list-artifact-files.sh" "$artifact_dir")
)

if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "Artifact manifest verification passed."
