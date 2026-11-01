#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Compile the generated GraphQL package without pulling in the complete Core UI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

yarn tsc -b client/libs/graphql/tsconfig.json --pretty false
