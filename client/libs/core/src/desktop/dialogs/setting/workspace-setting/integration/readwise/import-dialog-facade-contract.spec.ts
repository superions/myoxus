// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const readPeer = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("readwise import dialog facade contract", () => {
  test("uses shared dialog, list, typography and progress roles instead of local css", () => {
    const source = readPeer("./import-dialog.tsx");

    for (const required of [
      "Badge",
      "DialogFooterActions",
      "MyoxusText",
      "Progress",
      "SettingsControlEmpty",
      "SettingsPanelDescription",
      "Scrollable",
      "Stack",
      "SurfaceListCell",
      "SurfaceListHeaderCell",
      "SurfaceListHeaderSelectionSlot",
      "SurfaceListItem",
      "SurfaceListSelectionSlot",
      "SurfaceListTableHeader",
    ]) {
      expect(source).toContain(required);
    }

    expect(source).not.toContain("./import-dialog.styles");
    expect(source).not.toContain("styles.");
    expect(source).not.toContain("className=");
    expect(source).not.toContain("classNames");
    expect(source).not.toContain("<Scrollable.Root");
    expect(source).not.toContain("<Scrollable.Viewport");
    expect(source).not.toContain("width: 480px");
    expect(source).not.toContain("max-height: 508px");
    expect(source).toContain("<Scrollable.VirtualizedViewport");
    expect(source).toContain(
      'data-myoxus-ui-role="readwise-import-highlight-scroll"',
    );
    expect(source).not.toMatch(/<(?:div|span|h3|header|main|footer)\b/);
    expect(source).toContain('component="a"');
    expect(source).toContain('tone="link"');
    expect(source).toContain('width="lg"');
    expect(source).not.toContain("SettingsPanelTitle");

    for (const removed of [
      "./import-dialog.css",
      "./import-dialog.styles.ts",
    ]) {
      expect(existsSync(new URL(removed, import.meta.url)), removed).toBe(
        false,
      );
    }
  });
});
