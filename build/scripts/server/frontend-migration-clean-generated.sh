#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Generated-artifact cleanup for long Frontend Mantine/Facade migration runs.
# Keep recurring disk-pressure fixes behind one reviewed command instead of
# retyping ad-hoc `find` or Docker prune invocations during UI work.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

PLAYWRIGHT_DAYS="${MYOXUS_FRONTEND_MIGRATION_PLAYWRIGHT_KEEP_DAYS:-14}"
DRY_RUN=0
CLEAN_DOCKER_BUILDER=0
CLEAN_ALL_PLAYWRIGHT=0

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-clean-generated.sh [options]

Options:
  --playwright-days <n>    Remove output/playwright/* directories older than n
                           days. Default: 14.
  --all-playwright         Remove every output/playwright/* directory.
  --docker-builder-cache   Also run `docker builder prune -af`.
  --dry-run                Print what would be removed.
  --help, -h               Show this help.

This script only targets generated migration artifacts and Docker builder
cache. It does not remove source files, git-tracked files, node_modules,
server/target or running containers.
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

run_or_print() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[DRY-RUN]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

print_disk() {
  echo
  echo "==> disk usage"
  df -h .
}

clean_playwright_artifacts() {
  local output_dir="output/playwright"

  [[ -d "$output_dir" ]] || return 0

  echo
  if [[ "$CLEAN_ALL_PLAYWRIGHT" -eq 1 ]]; then
    echo "==> playwright artifacts: removing all generated directories"
    find "$output_dir" -mindepth 1 -maxdepth 1 -type d -print0 |
      while IFS= read -r -d '' dir; do
        run_or_print rm -rf -- "$dir"
      done
  else
    echo "==> playwright artifacts: removing directories older than ${PLAYWRIGHT_DAYS} day(s)"
    find "$output_dir" -mindepth 1 -maxdepth 1 -type d -mtime "+${PLAYWRIGHT_DAYS}" -print0 |
      while IFS= read -r -d '' dir; do
        run_or_print rm -rf -- "$dir"
      done
  fi
}

clean_docker_builder_cache() {
  [[ "$CLEAN_DOCKER_BUILDER" -eq 1 ]] || return 0

  if ! command -v docker >/dev/null 2>&1; then
    echo
    echo "[WARN] docker is not available; skipping Docker builder cache cleanup" >&2
    return 0
  fi

  echo
  echo "==> docker builder cache"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    docker system df || true
    echo "[DRY-RUN] docker builder prune -af"
  else
    docker builder prune -af
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --playwright-days)
      require_value "$1" "${2:-}"
      PLAYWRIGHT_DAYS="$2"
      shift
      ;;
    --playwright-days=*)
      PLAYWRIGHT_DAYS="${1#*=}"
      ;;
    --all-playwright)
      CLEAN_ALL_PLAYWRIGHT=1
      ;;
    --docker-builder-cache)
      CLEAN_DOCKER_BUILDER=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

[[ "$PLAYWRIGHT_DAYS" =~ ^[0-9]+$ ]] || fail "--playwright-days must be a non-negative integer"

print_disk
clean_playwright_artifacts
clean_docker_builder_cache
print_disk

echo
echo "Frontend migration generated-artifact cleanup passed."
