#!/usr/bin/env bash
# Verifies that Forgejo workflow references to build/scripts/ci/*.sh exist.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

missing=0
while IFS= read -r script; do
  [ -n "$script" ] || continue
  if [ ! -f "$script" ]; then
    echo "Workflow references missing CI script: $script" >&2
    missing=1
  fi
done < <(
  if command -v rg >/dev/null 2>&1; then
    rg -o 'build/scripts/ci/[A-Za-z0-9_.-]+\.sh' .forgejo
  else
    grep -RhoE 'build/scripts/ci/[A-Za-z0-9_.-]+\.sh' .forgejo
  fi | sed 's/^.*:build/build/' | sort -u
)

if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "Workflow CI script references verified."
