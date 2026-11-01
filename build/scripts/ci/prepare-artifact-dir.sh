#!/usr/bin/env bash
# Recreates an artifact directory so stale files cannot satisfy later checks.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <artifact-dir>" >&2
  exit 2
fi

artifact_dir="$1"

case "$artifact_dir" in
  dist/* | ./dist/*) ;;
  *)
    echo "Refusing to clean artifact directory outside dist/: $artifact_dir" >&2
    exit 1
    ;;
esac

rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"
