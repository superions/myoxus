#!/usr/bin/env bash
# Writes SHA256SUMS for all files in an artifact directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <artifact-dir>" >&2
  exit 2
fi

artifact_dir="$1"
checksums_path="$artifact_dir/SHA256SUMS"

test -d "$artifact_dir"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

(
  cd "$artifact_dir"
  bash "$SCRIPT_DIR/list-artifact-files.sh" . \
    | while IFS= read -r file; do
      if [ "${file##*/}" != SHA256SUMS ]; then
        printf '%s\n' "${file#./}"
      fi
    done \
    | while IFS= read -r file; do
      hash_file "$file"
    done
) >"$checksums_path"

test -s "$checksums_path"
