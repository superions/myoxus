/**
 * P100-WF-F-08: Verify theme editor is fully removed (static source analysis).
 *
 * Invariants:
 * INV-WF-F-08a: AppearanceSettings source contains no theme-editor reference
 * INV-WF-F-08b: feature-flag/constant.ts has no enable_theme_editor entry
 * INV-WF-F-08c: modules/index.ts does not export ThemeEditorModule
 * INV-WF-F-08d: desktop/router.tsx has no /theme-editor route segment
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = resolve(
  fileURLToPath(import.meta.url),
  "../..", // from __tests__/ → src/
);

const read = (rel: string) => readFileSync(resolve(srcRoot, rel), "utf8");

describe("P100-WF-F-08 theme-editor removal", () => {
  it("INV-WF-F-08a: appearance/index.tsx has no theme-editor references", () => {
    const src = read(
      "desktop/dialogs/setting/general-setting/appearance/index.tsx",
    );
    expect(src).not.toMatch(/theme.?editor/i);
    expect(src).not.toMatch(/ThemeEditor/);
  });

  it("INV-WF-F-08b: feature-flag/constant.ts has no enable_theme_editor", () => {
    const src = read("modules/feature-flag/constant.ts");
    expect(src).not.toMatch(/theme_editor/i);
    expect(src).not.toMatch(/ThemeEditor/);
  });

  it("INV-WF-F-08c: modules/index.ts does not export ThemeEditorModule", () => {
    const src = read("modules/index.ts");
    expect(src).not.toMatch(/ThemeEditor/);
    expect(src).not.toMatch(/theme-editor/i);
  });

  it("INV-WF-F-08d: desktop/router.tsx has no /theme-editor route", () => {
    const src = read("desktop/router.tsx");
    expect(src).not.toMatch(/theme-editor/i);
    expect(src).not.toMatch(/ThemeEditor/);
  });
});
