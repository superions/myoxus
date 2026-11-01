#!/usr/bin/env bash
# Verifies a SHA256SUMS file inside an artifact directory.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <artifact-dir>" >&2
  exit 2
fi

artifact_dir="$1"
checksums_path="$artifact_dir/SHA256SUMS"

test -d "$artifact_dir"
test -s "$checksums_path"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$artifact_dir"
    sha256sum -c SHA256SUMS
  )
else
  (
    cd "$artifact_dir"
    while IFS= read -r line; do
      expected="${line%%  *}"
      file="${line#*  }"
      test -n "$expected"
      test -s "$file"
      actual="$(shasum -a 256 "$file" | awk '{print $1}')"
      if [ "$actual" != "$expected" ]; then
        echo "SHA-256 mismatch for $file" >&2
        exit 1
      fi
    done <SHA256SUMS
  )
fi

echo "SHA256SUMS verification passed."
