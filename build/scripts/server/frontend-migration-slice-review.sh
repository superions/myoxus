#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One-command review harness for Mantine/Facade/CSS/Typography migration
# slices. It keeps the repeated "slice checks + optional visual evidence"
# workflow in one reviewed script so agents do not rebuild long command lines
# by hand for every frontend surface.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RUN_SLICE_CHECK=1
RUN_VISUAL=0
RUN_STATUS=0
SLICE_ARGS=()
VISUAL_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-slice-review.sh [slice options] [visual options]

This wrapper runs frontend-migration-slice-check.sh and, when a visual URL is
provided, frontend-migration-visual.sh with the standard local-dev
desktop/mobile and light/dark matrix.

Slice-check options forwarded unchanged:
  --preset <name> | --preset=<name>
  --vitest <path> | --vitest=<path>
  --no-changed-specs
  --no-prettier
  --no-gates
  --no-facade-typecheck
  --core-typecheck
  --full-typecheck

Visual options:
  --url <route> | --url=<route>
  --name <slug> | --name=<slug>
  --wait-selector <selector>
  --post-interaction-wait-selector <selector>
  --click-selector <selector>
  --hover-selector <selector>
  --probe <label=selector>
  --require-probe <label=selector>
  --require-exists <label=selector>
  --expect-zero <label=selector>
  --local-storage <key=value>
  --viewport <label:WxH>
  --theme <light|dark>
  --output-dir <dir>
  --base-url <url>
  --api-url <url>
  --storage-state <file>
  --auth
  --no-auth
  --no-fail-on-overflow
  --no-fail-on-console-error

Control options:
  --visual                  Require and run the visual step. Useful with args
                            passed after --.
  --no-slice-check          Run only the visual/status part.
  --status                  Print frontend migration status after checks.
  --                        Pass all remaining arguments to the visual wrapper.

Examples:
  yarn frontend:migration:slice-review \
    --vitest client/libs/core/src/components/page-list/explorer-page-list-facade-contract.spec.ts \
    --url=/ \
    --name=page-list-chrome-after \
    --wait-selector='[data-testid="doc-list-item"]' \
    --probe='docLink=[data-myoxus-ui-role="doc-list-row-link"]'

  yarn frontend:migration:slice-review --no-slice-check -- \
    --url=/ --name=focused-visual --wait-selector='main'
EOF
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "[FAIL] $option requires a value" >&2
    exit 2
  fi
}

has_visual_url() {
  local arg
  local expect_value=0
  for arg in "${VISUAL_ARGS[@]}"; do
    if [[ "$expect_value" -eq 1 ]]; then
      [[ -n "$arg" ]] && return 0
      expect_value=0
    fi
    case "$arg" in
      --url)
        expect_value=1
        ;;
      --url=*)
        [[ -n "${arg#*=}" ]] && return 0
        ;;
    esac
  done
  return 1
}

add_slice_flag() {
  SLICE_ARGS+=("$1")
}

add_slice_value() {
  require_value "$1" "${2:-}"
  SLICE_ARGS+=("$1" "$2")
}

add_visual_flag() {
  RUN_VISUAL=1
  VISUAL_ARGS+=("$1")
}

add_visual_value() {
  require_value "$1" "${2:-}"
  RUN_VISUAL=1
  VISUAL_ARGS+=("$1" "$2")
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --visual)
      RUN_VISUAL=1
      ;;
    --no-slice-check)
      RUN_SLICE_CHECK=0
      ;;
    --status)
      RUN_STATUS=1
      ;;
    --)
      shift
      RUN_VISUAL=1
      VISUAL_ARGS+=("$@")
      break
      ;;
    --vitest)
      add_slice_value "$1" "${2:-}"
      shift
      ;;
    --preset)
      add_slice_value "$1" "${2:-}"
      shift
      ;;
    --preset=*|--vitest=*|--no-changed-specs|--no-prettier|--no-gates|--no-facade-typecheck|--core-typecheck|--full-typecheck)
      add_slice_flag "$1"
      ;;
    --url|--name|--wait-selector|--post-interaction-wait-selector|--click-selector|--hover-selector|--probe|--require-probe|--require-exists|--expect-zero|--local-storage|--viewport|--theme|--output-dir|--base-url|--api-url|--storage-state)
      add_visual_value "$1" "${2:-}"
      shift
      ;;
    --url=*|--name=*|--wait-selector=*|--post-interaction-wait-selector=*|--click-selector=*|--hover-selector=*|--probe=*|--require-probe=*|--require-exists=*|--expect-zero=*|--local-storage=*|--viewport=*|--theme=*|--output-dir=*|--base-url=*|--api-url=*|--storage-state=*)
      add_visual_flag "$1"
      ;;
    --auth|--no-auth|--no-fail-on-overflow|--no-fail-on-console-error)
      add_visual_flag "$1"
      ;;
    *)
      echo "[FAIL] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$RUN_SLICE_CHECK" -eq 1 ]]; then
  "$SCRIPT_DIR/frontend-migration-slice-check.sh" "${SLICE_ARGS[@]}"
fi

if [[ "$RUN_VISUAL" -eq 1 ]]; then
  if ! has_visual_url; then
    echo "[FAIL] visual review requires --url or --url=<route>" >&2
    exit 2
  fi
  "$SCRIPT_DIR/frontend-migration-visual.sh" "${VISUAL_ARGS[@]}"
fi

if [[ "$RUN_STATUS" -eq 1 ]]; then
  "$SCRIPT_DIR/frontend-migration-status.sh"
fi

echo
echo "Frontend migration slice review passed."
