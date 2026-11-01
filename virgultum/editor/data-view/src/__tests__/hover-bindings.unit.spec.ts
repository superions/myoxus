/**
 * Source-level invariant tests for hover style bindings (INV-THEME-HOVER-01).
 *
 * Virgultum uses Lit CSS templates; generated CSS is validated by checking
 * that the source files bind through the canonical theme helper rather than
 * the removed raw --myoxus-hover-color variable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const EDITOR_ROOT = join(__dirname, "../../..");

describe("hover-bindings", () => {
  test("inv_hover_39_kanban_card_uses_the_theme_hover_role", () => {
    const src = readFileSync(
      join(EDITOR_ROOT, "data-view/src/view-presets/kanban/pc/card.ts"),
      "utf-8",
    );
    expect(src).toContain('cssVar("hoverColor")');
    expect(src).not.toContain("var(--myoxus-hover-color)");
  });

  test("inv_hover_40_table_row_op_uses_the_theme_hover_role", () => {
    const src = readFileSync(
      join(EDITOR_ROOT, "data-view/src/view-presets/table/pc/row/row.ts"),
      "utf-8",
    );
    expect(src).toContain('cssVar("hoverColor")');
    expect(src).not.toContain("var(--myoxus-hover-color)");
  });
});
