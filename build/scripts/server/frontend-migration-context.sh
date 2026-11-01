#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Safe context reader for the Mantine/Facade/CSS/Typography migration.
# This script deliberately centralizes repeated slice exploration so agents do
# not rebuild fragile rg/sed/find pipelines by hand. It prints bounded output,
# uses reviewed slice paths when available and can show focused file excerpts
# without ad-hoc shell globs.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

SLICE=""
TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_CONTEXT_TOP_LIMIT:-24}"
MAX_FILES="${MYOXUS_FRONTEND_MIGRATION_CONTEXT_MAX_FILES:-80}"
RUN_AUDIT=0
RUN_PATTERNS=1
INCLUDE_TESTS=0
PATHS=()
SHOW_SPECS=()

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-context.sh [options] --slice <name>
  build/scripts/server/frontend-migration-context.sh [options] <path>...

Options:
  --slice <name>       Load reviewed paths from frontend-migration-slice.sh.
  --path <path>        Add an explicit path. Repeatable.
  --show <spec>        Print a bounded file excerpt. Repeatable.
                       Format: path, path:start or path:start:end.
                       Default range is 1:180; maximum range length is 260.
  --top-limit <n>      Limit match lines per pattern section. Default: 24.
  --max-files <n>      Limit printed source file list. Default: 80.
  --audit              Also run the full focused scope audit wrapper.
  --no-patterns        Skip the quick debt pattern sections.
  --include-tests      Include *.spec/test files in quick pattern sections.
  --help, -h           Show this help.

Examples:
  yarn frontend:migration:context --slice mobile-navigation
  yarn frontend:migration:context --slice peek-view-modal \
    --show client/libs/core/src/modules/peek-view/view/modal-container.tsx:1:220
  yarn frontend:migration:context client/libs/core/src/modules/peek-view/view \
    --audit

Use this before reading/editing a repeated migration cluster. If a cluster is
revisited often, add it as a named slice first and call this helper by slice
name so paths, tests and visual harnesses stay centralized.
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

add_path() {
  local value="$1"
  local existing
  [[ -n "$value" ]] || fail "empty path is not valid"
  for existing in "${PATHS[@]}"; do
    [[ "$existing" == "$value" ]] && return 0
  done
  PATHS+=("$value")
}

print_limited_file() {
  local file="$1"
  local start="${2:-1}"
  local end="${3:-180}"

  [[ -f "$file" ]] || fail "cannot show non-file path: $file"
  [[ "$start" =~ ^[1-9][0-9]*$ ]] || fail "invalid start line in --show: $start"
  [[ "$end" =~ ^[1-9][0-9]*$ ]] || fail "invalid end line in --show: $end"
  [[ "$end" -ge "$start" ]] || fail "--show end line must be >= start line"

  local span=$((end - start + 1))
  [[ "$span" -le 260 ]] || fail "--show range is too large: $span lines; max 260"

  echo
  echo "==> file excerpt: $file:$start-$end"
  nl -ba "$file" | sed -n "${start},${end}p"
}

print_show_spec() {
  local spec="$1"
  local file="$spec"
  local start="1"
  local end="180"

  if [[ "$spec" =~ ^(.+):([0-9]+):([0-9]+)$ ]]; then
    file="${BASH_REMATCH[1]}"
    start="${BASH_REMATCH[2]}"
    end="${BASH_REMATCH[3]}"
  elif [[ "$spec" =~ ^(.+):([0-9]+)$ ]]; then
    file="${BASH_REMATCH[1]}"
    start="${BASH_REMATCH[2]}"
    end=$((start + 179))
  fi

  print_limited_file "$file" "$start" "$end"
}

print_rg_section() {
  local title="$1"
  local pattern="$2"
  local file_pattern="$3"
  shift 3
  local candidate_files=()
  local test_filter_args=()
  local tmp

  if [[ "$INCLUDE_TESTS" -eq 0 ]]; then
    test_filter_args=(
      -g '!*.spec.ts'
      -g '!*.spec.tsx'
      -g '!*.test.ts'
      -g '!*.test.tsx'
    )
  fi

  mapfile -t candidate_files < <(
    {
      git ls-files -- "${PATHS[@]}"
      git ls-files --others --exclude-standard -- "${PATHS[@]}"
    } |
      sort -u |
      while IFS= read -r file; do
        [[ -f "$file" ]] && printf '%s\n' "$file"
      done |
      rg "$file_pattern" |
      if [[ "$INCLUDE_TESTS" -eq 0 ]]; then
        rg -v '\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$'
      else
        cat
      fi
  )

  if [[ "${#candidate_files[@]}" -eq 0 ]]; then
    echo
    echo "==> $title (0)"
    return 0
  fi

  tmp="$(mktemp)"
  if rg -n "$pattern" "${candidate_files[@]}" "${test_filter_args[@]}" >"$tmp" 2>/dev/null; then
    local count
    count="$(wc -l <"$tmp" | tr -d " ")"
    echo
    echo "==> $title ($count)"
    if [[ "$TOP_LIMIT" -gt 0 ]]; then
      sed -n "1,${TOP_LIMIT}p" "$tmp"
      if [[ "$count" -gt "$TOP_LIMIT" ]]; then
        echo "... truncated $((count - TOP_LIMIT)) more match(es)"
      fi
    fi
  else
    echo
    echo "==> $title (0)"
  fi
  rm -f "$tmp"
}

print_source_files() {
  local tmp
  tmp="$(mktemp)"

  {
    git ls-files -- "${PATHS[@]}"
    git ls-files --others --exclude-standard -- "${PATHS[@]}"
  } |
    sort -u |
    while IFS= read -r file; do
      [[ -f "$file" ]] && printf '%s\n' "$file"
    done |
    rg '\.(css|ts|tsx|js|jsx|mjs|cjs|json|md|sh)$' |
    if [[ "$INCLUDE_TESTS" -eq 0 ]]; then
      rg -v '\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$'
    else
      cat
    fi >"$tmp" || true

  local count
  count="$(wc -l <"$tmp" | tr -d " ")"
  echo
  echo "==> source files in scope ($count)"
  if [[ "$MAX_FILES" -gt 0 ]]; then
    sed -n "1,${MAX_FILES}p" "$tmp"
    if [[ "$count" -gt "$MAX_FILES" ]]; then
      echo "... truncated $((count - MAX_FILES)) more file(s)"
    fi
  fi
  rm -f "$tmp"
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
    --path)
      require_value "$1" "${2:-}"
      add_path "$2"
      shift
      ;;
    --path=*)
      add_path "${1#*=}"
      ;;
    --show)
      require_value "$1" "${2:-}"
      SHOW_SPECS+=("$2")
      shift
      ;;
    --show=*)
      SHOW_SPECS+=("${1#*=}")
      ;;
    --top-limit)
      require_value "$1" "${2:-}"
      TOP_LIMIT="$2"
      shift
      ;;
    --top-limit=*)
      TOP_LIMIT="${1#*=}"
      ;;
    --max-files)
      require_value "$1" "${2:-}"
      MAX_FILES="$2"
      shift
      ;;
    --max-files=*)
      MAX_FILES="${1#*=}"
      ;;
    --audit)
      RUN_AUDIT=1
      ;;
    --no-patterns)
      RUN_PATTERNS=0
      ;;
    --include-tests)
      INCLUDE_TESTS=1
      ;;
    --)
      shift
      while [[ "$#" -gt 0 ]]; do
        add_path "$1"
        shift
      done
      break
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    *)
      add_path "$1"
      ;;
  esac
  shift
done

[[ "$TOP_LIMIT" =~ ^[0-9]+$ ]] || fail "--top-limit must be a non-negative integer"
[[ "$MAX_FILES" =~ ^[0-9]+$ ]] || fail "--max-files must be a non-negative integer"

if [[ -n "$SLICE" ]]; then
  mapfile -t SLICE_PATHS < <(
    "$SCRIPT_DIR/frontend-migration-slice.sh" --slice "$SLICE" --action paths
  )
  for path in "${SLICE_PATHS[@]}"; do
    add_path "$path"
  done
fi

[[ "${#PATHS[@]}" -gt 0 ]] || fail "provide --slice or at least one path"

for path in "${PATHS[@]}"; do
  if [[ ! -e "$path" ]] && ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    fail "scope path does not exist and is not tracked: $path"
  fi
done

echo "==> frontend migration context"
if [[ -n "$SLICE" ]]; then
  echo "slice: $SLICE"
fi
printf '%s\n' "${PATHS[@]}"

echo
echo "==> git changes in scope"
git status --short -- "${PATHS[@]}" || true

print_source_files

if [[ "$RUN_PATTERNS" -eq 1 ]]; then
  print_rg_section \
    "direct Mantine imports" \
    'from[[:space:]]+["'\'']@mantine/' \
    '\.(ts|tsx)$'

  print_rg_section \
    "Facade imports" \
    '@myoxus/ui-facade' \
    '\.(ts|tsx)$'

  print_rg_section \
    "local CSS/style module imports" \
    '(\.css["'\'']|\.styles["'\'']|from[[:space:]]+["'\''][^"'\'']*\.styles)' \
    '\.(ts|tsx)$'

  print_rg_section \
    "visible hard-pixel candidates" \
    '\b[0-9]+px\b' \
    '\.(ts|tsx|css)$'

  print_rg_section \
    "manual responsiveness candidates" \
    '(useResponsive(Sm)?Query|matchMedia|window\.innerWidth|ResizeObserver|data-compact|@media)' \
    '\.(ts|tsx|css)$'
fi

for spec in "${SHOW_SPECS[@]}"; do
  print_show_spec "$spec"
done

if [[ "$RUN_AUDIT" -eq 1 ]]; then
  echo
  echo "==> full scope audit"
  audit_args=(--top-limit "$TOP_LIMIT")
  [[ "$INCLUDE_TESTS" -eq 1 ]] && audit_args+=(--include-tests)
  "$SCRIPT_DIR/frontend-migration-scope-audit.sh" \
    "${audit_args[@]}" \
    "${PATHS[@]}"
fi

echo
echo "Frontend migration context complete."
