import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const sourcePath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/page.tsx",
);
const generalPath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/general.tsx",
);

const edgelessPath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/edgeless/edgeless.tsx",
);
const edgelessSnapshotPath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/edgeless/snapshot.tsx",
);
const edgelessUtilsPath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/utils.ts",
);
const edgelessDocsPath = join(
  process.cwd(),
  "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/edgeless/docs/index.ts",
);

const edgelessSectionPaths = [
  "note.tsx",
  "text.tsx",
  "shape.tsx",
  "frame.tsx",
  "connector.tsx",
  "pen.tsx",
  "mind-map.tsx",
].map((fileName) =>
  join(
    process.cwd(),
    "client/libs/core/src/desktop/dialogs/setting/general-setting/editor/edgeless",
    fileName,
  ),
);

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
        /<SettingsSection[\s\S]*title=\{title\}[\s\S]*testId="editor-settings-section-edgeless-[^"]+"[\s\S]*<EdgelessSnapshot[\s\S]*title=\{title\}/,
      );
      expect(source, sectionPath).not.toMatch(
        /return \(\s*<>[\s\S]*<EdgelessSnapshot/,
      );
    }
  });

  test("edgeless preview snapshots do not repeat the section title as visible chrome", () => {
    const source = readFileSync(edgelessSnapshotPath, "utf8");

    expect(source).toContain("EditorPreviewFrame");
    expect(source).toContain("EditorPreviewViewport");
    expect(source).toContain("EditorPreviewSkeleton");
    expect(source).toContain(
      'ViewportElementExtension(".setting-editor-snapshot")',
    );
    expect(source).toContain('previewSize = "default"');
    expect(source).not.toContain("snapshotTitle");
    expect(source).not.toContain("snapshotLabel");
    expect(source).not.toMatch(/<div[^>]*>\{title\}<\/div>/);
    expect(source).not.toMatch(/className=.*setting-editor-snapshot/);
  });

  test("edgeless settings localize visible palette labels and preview text without mutating fixture markers", () => {
    const utils = readFileSync(edgelessUtilsPath, "utf8");
    const snapshot = readFileSync(edgelessSnapshotPath, "utf8");
    const docs = readFileSync(edgelessDocsPath, "utf8");

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

    expect(snapshot).toContain("usePreviewTextReplacements");
    expect(snapshot).toContain(
      "com.myoxus.settings.editorSettings.edgeless.preview.note.headline",
    );
    expect(docs).toContain("applySnapshotTextReplacements");
    expect(docs).toContain("JSON.parse(JSON.stringify(snapshot))");
  });
});
