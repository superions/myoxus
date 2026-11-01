#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# Build the declared Admin project-reference graph from source. Listing selected
# dependency packages here makes the gate depend on ignored declaration output
# left by earlier jobs whenever Admin adds or changes another project reference.
yarn tsc -b client/admin/workspaces/admin/tsconfig.json --force --pretty false
