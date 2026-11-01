#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Compact status helper for the long-running Mantine/Facade/CSS/Typography
# migration. Keep repeated inventory and debt scans here instead of retyping
# fragile ad-hoc command lines while product work is in flight.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TODO_LIMIT="${MYOXUS_FRONTEND_MIGRATION_TODO_LIMIT:-80}"
TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT:-12}"

echo "==> git"
git status --short --branch

echo
echo "==> local dev stack"
bash build/scripts/server/dev-status.sh

echo
echo "==> css / typography inventory"
node build/scripts/ci/report-frontend-css-typography-inventory.mjs \
  --mode=both \
  --json |
  MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT="$TOP_LIMIT" node --input-type=module -e '
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const report = JSON.parse(input);
      const topLimit = Number.parseInt(
        process.env.MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT ?? "12",
        10,
      );
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
      for (const [category, values] of Object.entries(report.summary.byCategory)) {
        console.log(`${category}: ${pick(values)}`);
      }

      const productCategories = new Set(["admin-product", "web-core-product"]);
      const productRecords = report.records.filter((record) =>
        productCategories.has(record.category),
      );
      const counterValue = (record, counter) => record.counters[counter] ?? 0;
      const printTop = (title, records, countersForLine) => {
        console.log("");
        console.log(title);
        for (const record of records.slice(0, topLimit)) {
          const counterSummary = countersForLine
            .map((counter) => `${counter}=${counterValue(record, counter)}`)
            .join(", ");
          console.log(`${counterSummary} ${record.file}`);
        }
      };
      printTop(
        `top ${topLimit} product CSS files by declarations`,
        productRecords
          .filter((record) => counterValue(record, "cssFiles") > 0)
          .sort(
            (a, b) =>
              counterValue(b, "declarations") -
                counterValue(a, "declarations") ||
              a.file.localeCompare(b.file),
          ),
        ["declarations", "selectors", "typographyDeclarations"],
      );
      printTop(
        `top ${topLimit} product typography fallback files`,
        productRecords
          .filter(
            (record) =>
              counterValue(record, "typographyDeclarations") > 0 ||
              counterValue(record, "inlineTypographyProps") > 0 ||
              counterValue(record, "inlineStyleBlocks") > 0,
          )
          .sort((a, b) => {
            const aScore =
              counterValue(a, "typographyDeclarations") +
              counterValue(a, "inlineTypographyProps") +
              counterValue(a, "inlineStyleBlocks");
            const bScore =
              counterValue(b, "typographyDeclarations") +
              counterValue(b, "inlineTypographyProps") +
              counterValue(b, "inlineStyleBlocks");
            return bScore - aScore || a.file.localeCompare(b.file);
          }),
        ["typographyDeclarations", "inlineTypographyProps", "inlineStyleBlocks"],
      );
    });
  '

echo
echo "==> product debt scan"
PRODUCT_ROOTS=(
  client/admin/workspaces/admin/src
  client/libs/core/src
  client/web/workspaces/web/src
)

count_rg() {
  local pattern="$1"
  shift
  rg -n "$pattern" "${PRODUCT_ROOTS[@]}" \
    "$@" \
    -g '!**/*.spec.*' \
    -g '!**/*.test.*' \
    -g '!**/__tests__/**' \
    -g '!**/__fixtures__/**' 2>/dev/null | wc -l | tr -d " "
}

printf "direct Mantine imports in product paths: %s\n" \
  "$(count_rg "from[[:space:]]+[\"']@mantine/" -g '*.ts' -g '*.tsx')"
printf "product responsive API lines: %s\n" \
  "$(count_rg "useResponsive(Sm)?Query|matchMedia|window\\.innerWidth|ResizeObserver|data-compact" -g '*.ts' -g '*.tsx')"
printf "product CSS files: %s\n" \
  "$(find client/admin/workspaces/admin/src client/libs/core/src client/web/workspaces/web/src -name '*.css' -type f | wc -l | tr -d ' ')"
printf "visible hard-pixel candidate lines in product sources: %s\n" \
  "$(count_rg "\\b[0-9]+px\\b" -g '*.ts' -g '*.tsx' -g '*.css')"

echo
echo "==> open migration todo focus"
rg -n \
  "Offene Folgefunde|Offener Folgefund|\\[ \\]|Status\\*\\*: aktiv|P-WEB-UI-UX|P-FE-THEME|muss|soll" \
  todo/webfrontend.md \
  todo/adminfrontend.md \
  | head -n "$TODO_LIMIT" || true
