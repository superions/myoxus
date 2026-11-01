#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

node build/scripts/ci/verify-vite-vitest4-config.mjs
node build/scripts/ci/verify-vite8-integration.mjs
bash build/scripts/ci/verify-vitest4-coverage.sh

for package_root in \
  virgultum/framework/std \
  virgultum/editor/blocks/bookmark \
  virgultum/editor/inlines/footnote \
  virgultum/editor/shared
do
  yarn vitest run \
    --config "$REPO_ROOT/$package_root/vitest.config.ts" \
    --root "$REPO_ROOT/$package_root"
done

# Vitest 4 imports all files of a non-isolated browser project into one module
# session. These integration files intentionally own module-level editor
# extensions, so execute each file in a fresh process while retaining both
# declared browser instances and every test.
while IFS= read -r test_file; do
  yarn vitest run \
    "$test_file" \
    --config "$REPO_ROOT/virgultum/integration-test/vitest.config.ts" \
    --root "$REPO_ROOT/virgultum/integration-test"
done < <(
  cd "$REPO_ROOT/virgultum/integration-test"
  find src/__tests__ -type f -name '*.spec.ts' -print | LC_ALL=C sort
)
