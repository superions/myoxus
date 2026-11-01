// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const OUTLINE_FILES = [
  "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/outline.tsx",
  "client/libs/core/src/editor/outline-viewer/index.tsx",
] as const;

describe("Virgultum outline parity", () => {
  test("keeps every outline consumer backed by the Virgultum outline model", () => {
    for (const removedPath of [
      "client/libs/core/src/editor/outline-viewer/outline-viewer.css",
      "client/libs/core/src/editor/outline-viewer/outline-viewer.styles.ts",
    ]) {
      expect(existsSync(resolve(process.cwd(), removedPath)), removedPath).toBe(
        false,
      );
    }

    const facadeSource = readSource(
      "client/libs/ui-facade/src/document-layout.tsx",
    );
    const facadeCss = readSource("client/libs/ui-facade/src/page-shell.css");

    expect(facadeSource).toContain("EditorOutlineFloatingFrame");
    expect(facadeCss).toContain(".myoxus-editor-outline-floating-frame");
    expect(facadeCss).toContain("@container viewport (width <= 48em)");
    expect(facadeCss).not.toContain("@container (width <= 640px)");

    for (const file of OUTLINE_FILES) {
      const source = readSource(file);
      expect(
        source,
        `${file} must keep the editor-model outline source`,
      ).toContain("@virgultum/editor/fragments/outline");
      expect(
        source,
        `${file} must not replace editor outline logic with DOM scroll-spy`,
      ).not.toContain("TableOfContents");
      expect(
        source,
        `${file} must not import raw Mantine into product outline code`,
      ).not.toContain("@mantine/core");
      expect(
        source,
        `${file} must not import local outline styles`,
      ).not.toMatch(/outline-viewer\.styles|outline-viewer\.css|styles\./);
      expect(
        source,
        `${file} must not keep hard-pixel outline geometry`,
      ).not.toMatch(/\b(?:204|76|22|640)px\b/);
    }
  });

  test("removes only the duplicate Workbench consumer and preserves Share and Peek", () => {
    const detailPage = readSource(
      "client/libs/core/src/desktop/pages/workspace/detail-page/detail-page.tsx",
    );
    const documentSidecards = readSource(
      "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/document-sidecards.tsx",
    );
    const sharePage = readSource(
      "client/libs/core/src/desktop/pages/workspace/share/share-page.tsx",
    );
    const peekView = readSource(
      "client/libs/core/src/modules/peek-view/view/doc-preview/doc-peek-view.tsx",
    );
    const viewer = readSource(
      "client/libs/core/src/editor/outline-viewer/index.tsx",
    );

    expect(detailPage).not.toContain("EditorOutlineViewer");
    expect(documentSidecards).toContain("DocumentOutlineToolBody");
    expect(sharePage).toContain("EditorOutlineViewer");
    expect(peekView).toContain("EditorOutlineViewer");
    expect(viewer).toContain("export const EditorOutlineViewer");
  });
});
