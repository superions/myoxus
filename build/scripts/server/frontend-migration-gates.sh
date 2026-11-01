#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Repeatable gates for Mantine/Facade/CSS/Typography migration checkpoints.
# Default mode is intentionally quick enough for frequent local use. Use
# --typecheck or --full only after a coherent implementation slice.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RUN_TYPECHECK=0
RUN_FULL=0
ARTIFACT_DIR="${MYOXUS_FRONTEND_MIGRATION_OUTPUT_DIR:-output/frontend-migration}"

usage() {
  cat <<'EOF'
Usage: build/scripts/server/frontend-migration-gates.sh [--quick|--typecheck|--full]

Modes:
  --quick       Run script syntax checks, framework/theme guards, inventory and git diff.
                This is the default for frequent CSS/facade checkpoints.
  --typecheck   Run --quick plus scoped ui-facade and core TypeScript checks.
  --full        Run --quick plus root yarn typecheck.

Use focused Vitest or Playwright visual commands next to this helper when a
slice changes behavior or visible UI states.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --quick)
      ;;
    --typecheck)
      RUN_TYPECHECK=1
      ;;
    --full)
      RUN_FULL=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

run_step() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  "$@"
}

run_step "script syntax" node --check build/scripts/server/capture-web-route-visual.mjs
run_step "shell syntax" bash -n build/scripts/server/capture-web-route-visual.sh
run_step "dev frontend shell syntax" bash -n build/scripts/server/frontend-dev-ensure.sh
run_step "migration cycle shell syntax" bash -n build/scripts/server/frontend-migration-cycle.sh
run_step "migration commit helper shell syntax" bash -n build/scripts/server/frontend-migration-commit-push.sh
run_step "migration context shell syntax" bash -n build/scripts/server/frontend-migration-context.sh
run_step "migration scope audit shell syntax" bash -n build/scripts/server/frontend-migration-scope-audit.sh
run_step "migration status shell syntax" bash -n build/scripts/server/frontend-migration-status.sh
run_step "migration slice shell syntax" bash -n build/scripts/server/frontend-migration-slice.sh
run_step "migration slice review shell syntax" bash -n build/scripts/server/frontend-migration-slice-review.sh
run_step "migration visual shell syntax" bash -n build/scripts/server/frontend-migration-visual.sh
run_step "migration workstep shell syntax" bash -n build/scripts/server/frontend-migration-workstep.sh

run_step "ui framework graph" yarn frontend:ui-framework-graph:check
run_step "admin ui dependency graph" yarn frontend:admin-ui-dependency-graph:check
run_step "vanilla extract guard" yarn frontend:no-vanilla-extract:check

echo
echo "==> theme boundary guard"
mkdir -p "$ARTIFACT_DIR"
THEME_BOUNDARY_LOG="$ARTIFACT_DIR/theme-boundary-guard.txt"
if yarn frontend:theme-boundary:guard >"$THEME_BOUNDARY_LOG"; then
  sed -n '1,8p' "$THEME_BOUNDARY_LOG"
  echo "full report: $THEME_BOUNDARY_LOG"
else
  cat "$THEME_BOUNDARY_LOG"
  exit 1
fi

echo
echo "==> css / typography inventory summary"
node build/scripts/ci/report-frontend-css-typography-inventory.mjs \
  --mode=both \
  --json |
  node --input-type=module -e '
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const report = JSON.parse(input);
      const counters = [
        "cssFiles",
        "selectors",
        "declarations",
        "typographyDeclarations",
        "inlineStyleBlocks",
        "inlineTypographyProps",
      ];
      const pick = (source) =>
        counters.map((key) => `${key}=${source[key] ?? 0}`).join(", ");
      console.log(`totals: ${pick(report.summary.totals)}`);
      for (const category of [
        "admin-product",
        "web-core-product",
        "facade-foundation",
        "theme-projection",
      ]) {
        console.log(`${category}: ${pick(report.summary.byCategory[category] ?? {})}`);
      }
    });
  '

if [[ "$RUN_TYPECHECK" -eq 1 ]]; then
  run_step "ui facade typecheck" \
    yarn tsc -p client/libs/ui-facade/tsconfig.json --pretty false
  run_step "core typecheck" \
    yarn tsc -p client/libs/core/tsconfig.json --noEmit --pretty false
fi

if [[ "$RUN_FULL" -eq 1 ]]; then
  run_step "root typecheck" yarn typecheck
fi

run_step "git diff whitespace" git diff --check

echo
echo "Frontend migration gates passed."
