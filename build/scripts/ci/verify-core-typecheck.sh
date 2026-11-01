#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Hard CI gate for the generated GraphQL/core client boundary.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

bash build/scripts/ci/verify-user-preferences-source.sh
# Core's exports resolve to source files. Its project keeps full source and
# declaration checking while omitting JavaScript that no runtime consumes.
yarn tsc -b client/libs/core/tsconfig.json --pretty false
