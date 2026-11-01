#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Safe high-level cycle wrapper for the long-running Mantine/Facade/CSS/
# Typography migration. This script intentionally composes the lower-level
# migration helpers instead of duplicating their checks, so repeated agent
# cycles use one reviewed command path and do not rebuild fragile ad-hoc
# invocations by hand.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

MODE="cycle"
RUN_STATUS_BEFORE=1
RUN_STATUS_AFTER=1
VISUAL_DISABLED=0
HAS_VISUAL_ARGS=0
STATUS_TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT:-}"
STATUS_TODO_LIMIT="${MYOXUS_FRONTEND_MIGRATION_TODO_LIMIT:-}"
SLICE_ARGS=()
VISUAL_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-cycle.sh [mode] [slice options] [visual options]

Modes:
  --status-only          Print the migration snapshot and exit.
  --check-only           Run status + slice checks only. Visual options are rejected.
  --visual-only          Run visual evidence through the standard local-dev matrix only.

Status controls:
  --no-status-before     Do not print the migration snapshot before the cycle.
  --no-status-after      Do not print the migration snapshot after checks.
  --top-limit <n>        Limit ranked CSS/typography debt rows in status output.
  --todo-limit <n>       Limit open TODO rows in status output.

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
  --route <route>        Alias for --url.
  --visual-url <route>   Alias for --url.
  --name <slug> | --name=<slug>
  --visual-name <slug>   Alias for --name.
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
  --                        Pass all remaining arguments to the visual wrapper.

Default cycle:
  status before -> slice-review -> optional visual evidence -> status after.

Use this wrapper for normal frontend migration iterations. It deliberately uses
the local dev frontend helpers and never rebuilds containers.
EOF
}

fail() {
  echo "[FAIL] $*" >&2
  exit 2
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value"
}

add_slice_flag() {
  SLICE_ARGS+=("$1")
}

add_slice_value() {
  require_value "$1" "${2:-}"
  SLICE_ARGS+=("$1" "$2")
}

add_visual_flag() {
  if [[ "$VISUAL_DISABLED" -eq 1 ]]; then
    fail "$1 cannot be used with --check-only"
  fi
  HAS_VISUAL_ARGS=1
  VISUAL_ARGS+=("$1")
}

add_visual_value() {
  require_value "$1" "${2:-}"
  if [[ "$VISUAL_DISABLED" -eq 1 ]]; then
    fail "$1 cannot be used with --check-only"
  fi
  HAS_VISUAL_ARGS=1
  VISUAL_ARGS+=("$1" "$2")
}

run_status() {
  if [[ -n "$STATUS_TOP_LIMIT" ]]; then
    export MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT="$STATUS_TOP_LIMIT"
  fi
  if [[ -n "$STATUS_TODO_LIMIT" ]]; then
    export MYOXUS_FRONTEND_MIGRATION_TODO_LIMIT="$STATUS_TODO_LIMIT"
  fi
  "$SCRIPT_DIR/frontend-migration-status.sh"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --status-only)
      MODE="status"
      RUN_STATUS_BEFORE=1
      RUN_STATUS_AFTER=0
      ;;
    --check-only)
      MODE="check"
      VISUAL_DISABLED=1
      ;;
    --visual-only)
      MODE="visual"
      RUN_STATUS_BEFORE=0
      RUN_STATUS_AFTER=0
      ;;
    --no-status-before)
      RUN_STATUS_BEFORE=0
      ;;
    --no-status-after)
      RUN_STATUS_AFTER=0
      ;;
    --top-limit)
      require_value "$1" "${2:-}"
      STATUS_TOP_LIMIT="$2"
      shift
      ;;
    --top-limit=*)
      STATUS_TOP_LIMIT="${1#*=}"
      ;;
    --todo-limit)
      require_value "$1" "${2:-}"
      STATUS_TODO_LIMIT="$2"
      shift
      ;;
    --todo-limit=*)
      STATUS_TODO_LIMIT="${1#*=}"
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
    --route|--visual-url)
      add_visual_value "--url" "${2:-}"
      shift
      ;;
    --route=*|--visual-url=*)
      add_visual_flag "--url=${1#*=}"
      ;;
    --visual-name)
      add_visual_value "--name" "${2:-}"
      shift
      ;;
    --visual-name=*)
      add_visual_flag "--name=${1#*=}"
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
    --)
      shift
      if [[ "$VISUAL_DISABLED" -eq 1 ]]; then
        fail "-- cannot pass visual arguments with --check-only"
      fi
      HAS_VISUAL_ARGS=1
      VISUAL_ARGS+=("$@")
      break
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

if [[ "$MODE" == "status" &&
  ("${#SLICE_ARGS[@]}" -gt 0 || "${#VISUAL_ARGS[@]}" -gt 0) ]]; then
  fail "--status-only cannot be combined with slice or visual options"
fi

if [[ "$MODE" == "check" && "$HAS_VISUAL_ARGS" -eq 1 ]]; then
  fail "--check-only cannot be combined with visual options"
fi

if [[ "$RUN_STATUS_BEFORE" -eq 1 ]]; then
  run_status
fi

case "$MODE" in
  status)
    ;;
  check)
    "$SCRIPT_DIR/frontend-migration-slice-check.sh" "${SLICE_ARGS[@]}"
    ;;
  visual)
    "$SCRIPT_DIR/frontend-migration-slice-review.sh" \
      --no-slice-check \
      --visual \
      "${VISUAL_ARGS[@]}"
    ;;
  cycle)
    REVIEW_ARGS=("${SLICE_ARGS[@]}")
    if [[ "$HAS_VISUAL_ARGS" -eq 1 ]]; then
      REVIEW_ARGS+=("${VISUAL_ARGS[@]}")
    fi
    if [[ "$RUN_STATUS_AFTER" -eq 1 ]]; then
      REVIEW_ARGS+=("--status")
    fi
    "$SCRIPT_DIR/frontend-migration-slice-review.sh" "${REVIEW_ARGS[@]}"
    ;;
  *)
    fail "unsupported mode: $MODE"
    ;;
esac

if [[ "$MODE" != "cycle" && "$MODE" != "status" && "$RUN_STATUS_AFTER" -eq 1 ]]; then
  run_status
fi

echo
echo "Frontend migration cycle passed."
