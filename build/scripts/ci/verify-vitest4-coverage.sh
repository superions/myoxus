#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FIXTURE_ROOT="$REPO_ROOT/build/scripts/ci/fixtures/vitest4-coverage"
REPORT_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$REPORT_ROOT" "$FIXTURE_ROOT/node_modules/.vite"
  rmdir "$FIXTURE_ROOT/node_modules" 2>/dev/null || true
}
trap cleanup EXIT

cd "$REPO_ROOT"
MYOXUS_VITEST4_COVERAGE_DIR="$REPORT_ROOT" \
  yarn vitest run \
    --config "$FIXTURE_ROOT/vitest.config.mts" \
    --root "$FIXTURE_ROOT" \
    --coverage.enabled

node - "$REPORT_ROOT/coverage-final.json" <<'NODE'
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const files = Object.keys(report).map(path => path.replaceAll("\\", "/"));
if (!files.some(path => path.endsWith("/loaded.ts"))) {
  throw new Error("coverage report omitted the loaded fixture module");
}
if (files.some(path => path.endsWith("/unloaded.ts"))) {
  throw new Error("coverage report included an unloaded fixture module");
}
console.log("Vitest 4 loaded-file coverage semantics verified.");
NODE
