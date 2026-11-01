#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Single-entry workstep for the long-running Mantine/Facade/CSS/Typography
# migration. It keeps the common agent loop container-free and slice-based:
# choose a reviewed slice, run the reviewed audit/check/visual path, and
# optionally commit only the files owned by that slice plus migration docs and
# wrapper scripts. This avoids reconstructing long command lines by hand.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

SLICE=""
MODE="cycle"
TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT:-30}"
LOOPS="${MYOXUS_FRONTEND_MIGRATION_REVIEW_LOOPS:-3}"
COMMIT_MESSAGE=""
PUSH=1
DRY_RUN_COMMIT=0
INCLUDE_SUPPORT_PATHS=1
EXTRA_STAGE_PATHS=()
EXTRA_SLICE_ARGS=()

SUPPORT_STAGE_PATHS=(
  "package.json"
  "build/scripts/server/frontend-migration-commit-push.sh"
  "build/scripts/server/frontend-migration-context.sh"
  "build/scripts/server/frontend-migration-cycle.sh"
  "build/scripts/server/frontend-migration-gates.sh"
  "build/scripts/server/frontend-migration-scope-audit.sh"
  "build/scripts/server/frontend-migration-slice-check.sh"
  "build/scripts/server/frontend-migration-slice-review.sh"
  "build/scripts/server/frontend-migration-slice.sh"
  "build/scripts/server/frontend-migration-status.sh"
  "build/scripts/server/frontend-migration-visual.sh"
  "build/scripts/server/frontend-migration-workstep.sh"
  "docs/dev/clients/webfrontend/mantine-facade-foundation.md"
  "docs/dev/clients/webfrontend/myoxus-ui-facade-rollout.md"
  "docs/dev/clients/webfrontend/ui-framework-inventory.md"
  "docs/dev/clients/adminfrontend/ui-framework-inventory.md"
  "todo/adminfrontend.md"
  "todo/webfrontend.md"
)

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-workstep.sh --slice <name> [options]

Default:
  Runs the named slice cycle: status -> focused checks -> stable visual evidence
  when configured -> status. It uses local dev frontend helpers only; it never
  rebuilds containers.

Modes:
  --audit-only       Run the named slice audit.
  --context-only     Print bounded context for the named slice.
  --check-only       Run focused tests and shared gates for the named slice.
  --visual-only      Run the stable visual harness for the named slice.
  --cycle            Run the named slice cycle. Default.
  --review           Run the standard critical review loop for the named slice.
  --all              Run audit, then cycle.
  --commit-only      Skip checks and only run the scoped commit helper.

Options:
  --slice <name>         Named slice from frontend-migration-slice.sh --list.
  --top-limit <n>        Audit/status top row limit. Default: 30.
  --loops <n>            Review loop count for --review. Default: 3.
  -m, --message <text>   Commit message. When set, a scoped commit/push runs
                         after the workstep action.
  --stage <path>         Add an extra path to the scoped commit candidate set.
                         Repeatable. Use for a deliberately touched local doc.
  --no-support-paths     Do not auto-include migration docs/wrapper scripts in
                         the scoped commit candidate set.
  --no-push              Commit but do not push.
  --dry-run-commit       Print the scoped commit candidate paths without
                         staging, committing or pushing.
  --                     Forward remaining arguments to frontend-migration-slice.sh
                         after the named slice metadata is applied.

Examples:
  yarn frontend:migration:workstep --slice legacy-header --review \
    -m "frontend: retire legacy document header wrappers"

  yarn frontend:migration:workstep --slice page-list-residual --check-only

  yarn frontend:migration:workstep --slice properties --commit-only \
    -m "frontend: migrate workspace properties to facade"
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

changed_files() {
  {
    git diff --name-only --diff-filter=ACMRTD HEAD --
    git ls-files --others --exclude-standard
  } | sort -u
}

path_matches_scope() {
  local file="$1"
  local scope
  shift

  for scope in "$@"; do
    scope="${scope%/}"
    [[ -z "$scope" ]] && continue
    if [[ "$file" == "$scope" || "$file" == "$scope/"* ]]; then
      return 0
    fi
  done

  return 1
}

add_unique_path() {
  local value="$1"
  local existing
  for existing in "${COMMIT_PATHS[@]}"; do
    [[ "$existing" == "$value" ]] && return 0
  done
  COMMIT_PATHS+=("$value")
}

run_slice_action() {
  local action="$1"
  local cmd=(
    "$SCRIPT_DIR/frontend-migration-slice.sh"
    --slice "$SLICE"
    --action "$action"
    --top-limit "$TOP_LIMIT"
  )

  if [[ "$action" == "review" ]]; then
    cmd+=(--loops "$LOOPS")
  fi

  if [[ "${#EXTRA_SLICE_ARGS[@]}" -gt 0 ]]; then
    cmd+=(-- "${EXTRA_SLICE_ARGS[@]}")
  fi

  "${cmd[@]}"
}

collect_commit_paths() {
  local scopes=()
  local file
  local changed=()

  mapfile -t scopes < <(
    "$SCRIPT_DIR/frontend-migration-slice.sh" --slice "$SLICE" --action paths
  )

  if [[ "$INCLUDE_SUPPORT_PATHS" -eq 1 ]]; then
    scopes+=("${SUPPORT_STAGE_PATHS[@]}")
  fi
  scopes+=("${EXTRA_STAGE_PATHS[@]}")

  mapfile -t changed < <(changed_files)
  COMMIT_PATHS=()
  OUT_OF_SCOPE_CHANGED=()

  for file in "${changed[@]}"; do
    if path_matches_scope "$file" "${scopes[@]}"; then
      add_unique_path "$file"
    else
      OUT_OF_SCOPE_CHANGED+=("$file")
    fi
  done
}

run_scoped_commit() {
  collect_commit_paths

  echo
  echo "==> scoped commit candidates"
  if [[ "${#COMMIT_PATHS[@]}" -eq 0 ]]; then
    fail "no changed files matched slice '$SLICE' or the configured support paths"
  fi
  printf '%s\n' "${COMMIT_PATHS[@]}"

  if [[ "${#OUT_OF_SCOPE_CHANGED[@]}" -gt 0 ]]; then
    echo
    echo "==> changed files intentionally not staged by this workstep"
    printf '%s\n' "${OUT_OF_SCOPE_CHANGED[@]}"
  fi

  local commit_args=(-m "$COMMIT_MESSAGE")
  [[ "$PUSH" -eq 0 ]] && commit_args+=(--no-push)
  [[ "$DRY_RUN_COMMIT" -eq 1 ]] && commit_args+=(--dry-run)
  commit_args+=(-- "${COMMIT_PATHS[@]}")

  "$SCRIPT_DIR/frontend-migration-commit-push.sh" "${commit_args[@]}"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --slice)
      require_value "$1" "${2:-}"
      SLICE="$2"
      shift
      ;;
    --slice=*)
      SLICE="${1#*=}"
      ;;
    --audit-only)
      MODE="audit"
      ;;
    --context-only)
      MODE="context"
      ;;
    --check-only)
      MODE="check"
      ;;
    --visual-only)
      MODE="visual"
      ;;
    --cycle)
      MODE="cycle"
      ;;
    --review)
      MODE="review"
      ;;
    --all)
      MODE="all"
      ;;
    --commit-only)
      MODE="commit"
      ;;
    --top-limit)
      require_value "$1" "${2:-}"
      TOP_LIMIT="$2"
      shift
      ;;
    --top-limit=*)
      TOP_LIMIT="${1#*=}"
      ;;
    --loops)
      require_value "$1" "${2:-}"
      LOOPS="$2"
      shift
      ;;
    --loops=*)
      LOOPS="${1#*=}"
      ;;
    --message|-m)
      require_value "$1" "${2:-}"
      COMMIT_MESSAGE="$2"
      shift
      ;;
    --message=*)
      COMMIT_MESSAGE="${1#*=}"
      ;;
    --stage)
      require_value "$1" "${2:-}"
      EXTRA_STAGE_PATHS+=("$2")
      shift
      ;;
    --stage=*)
      EXTRA_STAGE_PATHS+=("${1#*=}")
      ;;
    --no-support-paths)
      INCLUDE_SUPPORT_PATHS=0
      ;;
    --no-push)
      PUSH=0
      ;;
    --dry-run-commit)
      DRY_RUN_COMMIT=1
      ;;
    --)
      shift
      EXTRA_SLICE_ARGS+=("$@")
      break
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

[[ -n "$SLICE" ]] || fail "--slice is required"
[[ "$TOP_LIMIT" =~ ^[0-9]+$ ]] || fail "--top-limit must be a non-negative integer"
[[ "$LOOPS" =~ ^[1-9][0-9]*$ ]] || fail "--loops must be a positive integer"

echo "==> frontend migration workstep"
echo "slice: $SLICE"
echo "mode: $MODE"

case "$MODE" in
  audit|context|check|visual|cycle|review|all)
    run_slice_action "$MODE"
    ;;
  commit)
    [[ -n "$COMMIT_MESSAGE" ]] || fail "--commit-only requires -m/--message"
    ;;
  *)
    fail "unsupported mode: $MODE"
    ;;
esac

if [[ -n "$COMMIT_MESSAGE" ]]; then
  run_scoped_commit
elif [[ "$DRY_RUN_COMMIT" -eq 1 ]]; then
  fail "--dry-run-commit requires -m/--message so the commit helper can validate the full call"
fi

echo
echo "Frontend migration workstep passed."
