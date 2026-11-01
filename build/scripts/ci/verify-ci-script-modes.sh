#!/usr/bin/env bash
# Verifies CI helper scripts are executable.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

bad=0
while IFS= read -r script; do
  if [ ! -x "$script" ]; then
    echo "CI script is not executable: $script" >&2
    bad=1
  fi
done < <(find build/scripts/ci -maxdepth 1 -type f -name '*.sh' | sort)

if [ "$bad" -ne 0 ]; then
  exit 1
fi

echo "CI script executable modes verified."
