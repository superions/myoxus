#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Focused audit helper for Mantine/Facade/CSS/Typography migration scopes.
# Use this before editing a route/component cluster so repeated debt scans,
# inventory filtering and import checks go through one reviewed command path
# instead of fragile ad-hoc rg/find pipelines.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT:-40}"
RUN_INVENTORY=1
INCLUDE_TESTS=0
PATHS=()

usage() {
  cat <<'EOF'
Usage: build/scripts/server/frontend-migration-scope-audit.sh [options] <path>...

Options:
  --top-limit <n>       Limit printed match lines per audit section.
  --top-limit=<n>       Same as --top-limit <n>.
  --no-inventory        Skip the CSS/typography inventory filter.
  --include-tests       Include *.spec/test source files in debt scans.
  --help, -h            Show this help.

Examples:
  yarn frontend:migration:scope-audit \
    client/libs/core/src/modules/workbench/view/split-view

  yarn frontend:migration:scope-audit --top-limit=20 \
    client/libs/core/src/components/myoxus/onboarding

The report intentionally separates technical layout/renderer candidates from
product styling debt. It does not decide what to migrate; it makes the next
slice reviewable without retyping long command sequences.
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

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --top-limit)
      require_value "$1" "${2:-}"
      TOP_LIMIT="$2"
      shift
      ;;
    --top-limit=*)
      TOP_LIMIT="${1#*=}"
      ;;
    --no-inventory)
      RUN_INVENTORY=0
      ;;
    --include-tests)
      INCLUDE_TESTS=1
      ;;
    --)
      shift
      PATHS+=("$@")
      break
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    *)
      PATHS+=("$1")
      ;;
  esac
  shift
done

[[ "${#PATHS[@]}" -gt 0 ]] || fail "at least one scope path is required"
[[ "$TOP_LIMIT" =~ ^[0-9]+$ ]] || fail "--top-limit must be a non-negative integer"

for path in "${PATHS[@]}"; do
  if [[ ! -e "$path" ]] && ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    fail "scope path does not exist and is not tracked: $path"
  fi
done

echo "==> scope"
printf '%s\n' "${PATHS[@]}"

echo
echo "==> git changes in scope"
git status --short -- "${PATHS[@]}" || true

print_rg_section() {
  local title="$1"
  local pattern="$2"
  local file_pattern="$3"
  shift 3
  local candidate_files=()
  local tmp
  tmp="$(mktemp)"
  local test_filter_args=()
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
    rm -f "$tmp"
    return 0
  fi

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

if [[ "$RUN_INVENTORY" -eq 1 ]]; then
  echo
  echo "==> css / typography inventory for scope"
  SCOPE_PATHS="$(printf '%s\n' "${PATHS[@]}")" \
    MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT="$TOP_LIMIT" \
    node build/scripts/ci/report-frontend-css-typography-inventory.mjs \
      --mode=both \
      --json |
    SCOPE_PATHS="$(printf '%s\n' "${PATHS[@]}")" \
      MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT="$TOP_LIMIT" \
      MYOXUS_FRONTEND_MIGRATION_INCLUDE_TESTS="$INCLUDE_TESTS" \
      node --input-type=module -e '
        let input = "";
        process.stdin.on("data", (chunk) => {
          input += chunk;
        });
        process.stdin.on("end", () => {
          const report = JSON.parse(input);
          const paths = (process.env.SCOPE_PATHS ?? "")
            .split("\n")
            .map((path) => path.replace(/\/+$/, ""))
            .filter(Boolean);
          const topLimit = Number.parseInt(
            process.env.MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT ?? "40",
            10,
          );
          const includeTests = process.env.MYOXUS_FRONTEND_MIGRATION_INCLUDE_TESTS === "1";
          const isTestFile = (file) =>
            /\.(?:spec|test)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file);
          const inScope = (file) =>
            paths.some((path) => file === path || file.startsWith(`${path}/`));
          const records = report.records.filter((record) =>
            inScope(record.file) && (includeTests || !isTestFile(record.file)),
          );
          const counters = [
            "cssFiles",
            "selectors",
            "declarations",
            "typographyDeclarations",
            "inlineStyleBlocks",
            "inlineTypographyProps",
          ];
          const sum = Object.fromEntries(counters.map((counter) => [counter, 0]));
          for (const record of records) {
            for (const counter of counters) {
              sum[counter] += record.counters[counter] ?? 0;
            }
          }
          const format = (source) =>
            counters
              .map((counter) => `${counter}=${source[counter] ?? 0}`)
              .join(", ");
          console.log(`summary: ${format(sum)}`);
          const sorted = [...records]
            .filter((record) =>
              counters.some((counter) => (record.counters[counter] ?? 0) > 0),
            )
            .sort((a, b) => {
              const score = (record) =>
                (record.counters.declarations ?? 0) +
                (record.counters.typographyDeclarations ?? 0) +
                (record.counters.inlineStyleBlocks ?? 0) +
                (record.counters.inlineTypographyProps ?? 0);
              return score(b) - score(a) || a.file.localeCompare(b.file);
            });
          for (const record of sorted.slice(0, topLimit)) {
            console.log(`${format(record.counters)} ${record.file}`);
          }
          if (sorted.length > topLimit) {
            console.log(`... truncated ${sorted.length - topLimit} more record(s)`);
          }
        });
      '
fi

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
  "local class/style usage" \
  '(classNames\(|className=|style=\{\{|style=)' \
  '\.(ts|tsx)$'

print_rg_section \
  "typography fallback candidates" \
  '(font(Size|Family|Weight|Style)?|lineHeight|letterSpacing|font-size|font-family|font-weight|font-style|line-height|letter-spacing)' \
  '\.(ts|tsx|css)$'

print_rg_section \
  "visible hard-pixel candidates" \
  '\b[0-9]+px\b' \
  '\.(ts|tsx|css)$'

print_rg_section \
  "manual responsiveness candidates" \
  '(useResponsive(Sm)?Query|matchMedia|window\.innerWidth|ResizeObserver|data-compact|@media)' \
  '\.(ts|tsx|css)$'

echo
echo "Frontend migration scope audit complete."
