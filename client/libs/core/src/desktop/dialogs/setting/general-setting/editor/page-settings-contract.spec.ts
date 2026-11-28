// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const editorRoot = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor",
);
const sourcePath = join(editorRoot, "page.tsx");
const generalPath = join(editorRoot, "general.tsx");
const edgelessPath = join(editorRoot, "edgeless/edgeless.tsx");
const edgelessPreviewPath = join(editorRoot, "edgeless/preview.tsx");
const edgelessUtilsPath = join(editorRoot, "utils.ts");

const edgelessSectionPaths = [
  "note.tsx",
  "text.tsx",
  "shape.tsx",
  "frame.tsx",
  "connector.tsx",
  "pen.tsx",
  "mind-map.tsx",
].map((fileName) => join(editorRoot, "edgeless", fileName));

describe("editor page settings structure", () => {
  test("full-width editing is a facade settings section, not a small row heading", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toMatch(
      /<SettingsSection[\s\S]*com\.myoxus\.settings\.editorSettings\.page\.full-width\.title/,
    );
    expect(source).toMatch(
      /<SettingsSection[\s\S]*com\.myoxus\.settings\.editorSettings\.page\.full-width\.description/,
    );
    expect(source).toContain('testId="editor-settings-section-page"');
    expect(source).not.toContain(
      '<SettingWrapper title={t["com.myoxus.settings.editorSettings.page"]()}>',
    );
  });

  test("edgeless settings use real settings sections for every tool group", () => {
    const generalSource = readFileSync(generalPath, "utf8");
    const rootSource = readFileSync(edgelessPath, "utf8");

    expect(generalSource).toContain('testId="editor-settings-section-general"');
    expect(rootSource).toMatch(
      /<SettingsSection[\s\S]*com\.myoxus\.settings\.editorSettings\.edgeless[\s\S]*<GeneralEdgelessSetting \/>[\s\S]*<\/SettingsSection>/,
    );
    expect(rootSource).toContain(
      'testId="editor-settings-section-edgeless-general"',
    );
    expect(rootSource).not.toMatch(
      /<SettingsSection[\s\S]*<GeneralEdgelessSetting \/>[\s\S]*<NoteSettings \/>[\s\S]*<MindMapSettings \/>[\s\S]*<\/SettingsSection>/,
    );

    for (const sectionPath of edgelessSectionPaths) {
      const source = readFileSync(sectionPath, "utf8");
      expect(source, sectionPath).toContain("SettingsSection");
      expect(source, sectionPath).toMatch(
        /<SettingsSection[\s\S]*title=\{title\}[\s\S]*testId="editor-settings-section-edgeless-[^"]+"[\s\S]*<EdgelessStylePreview/,
      );
      expect(source, sectionPath).not.toMatch(
        /return \(\s*<>[\s\S]*<EdgelessStylePreview/,
      );
    }
  });

  test("edgeless style previews stay lightweight without live editor hosts or raw chrome", () => {
    const source = readFileSync(edgelessPreviewPath, "utf8");

    expect(source).toContain("EditorPreviewFrame");
    expect(source).toContain("ColorDot");
    expect(source).toContain("Badge");
    expect(source).not.toContain("BlockStdScope");
    expect(source).not.toContain("EditorHost");
    expect(source).not.toContain("GfxController");
    expect(source).not.toContain("<svg");
  });

  test("edgeless settings localize visible palette labels without exposing raw keys", () => {
    const utils = readFileSync(edgelessUtilsPath, "utf8");

    expect(utils).toContain("translatePaletteLabel");
    expect(utils).toContain(
      "com.myoxus.settings.editorSettings.edgeless.palette.",
    );
    for (const sectionPath of edgelessSectionPaths) {
      const source = readFileSync(sectionPath, "utf8");
      expect(source, sectionPath).not.toMatch(
        /(?:currentColor|fillColor|strokeColor|textColor)\.key/,
      );
      expect(source, sectionPath).not.toMatch(/>\s*\{key\}\s*<\/MenuItem>/);
    }
  });
});
