// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const retiredStyleFiles = [
  "client/libs/core/src/mobile/components/doc-info/doc-info.css",
  "client/libs/core/src/mobile/components/doc-info/doc-info.styles.ts",
];
const inlineStyleAttribute = "style=" + "{{";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("mobile document info CSS reduction contract", () => {
  test("keeps the mobile DocInfo sheet on facade-owned chrome", () => {
    for (const file of retiredStyleFiles) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }

    const source = readRepoFile(
      "client/libs/core/src/mobile/components/doc-info/doc-info.tsx",
    );

    expect(source).toContain("MobileDocInfoSheetRoot");
    expect(source).toContain("MobileDocInfoSheetViewport");
    expect(source).toContain('<DocumentMetadataDetails layout="embedded" />');
    expect(source).not.toContain("Scrollable.");
    expect(source).not.toContain("className=");
    expect(source).not.toContain("styles.");
    expect(source).not.toContain(".styles");
    expect(source).not.toContain(".css");
    expect(source).not.toContain(inlineStyleAttribute);
    expect(source).not.toContain("useMediaQuery");
    expect(source).not.toContain("matchMedia");
    expect(source).not.toContain("innerWidth");
    expect(source).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
  });

  test("documents embedded metadata layout instead of descendant role overrides", () => {
    const metadata = readRepoFile(
      "client/libs/core/src/modules/document-metadata/index.tsx",
    );

    expect(metadata).toContain("DocumentMetadataDetailsLayout");
    expect(metadata).toContain('layout = "editor"');
    expect(metadata).toContain('layout === "embedded"');
    expect(metadata).toContain("data-document-metadata-layout={layout}");
    expect(metadata).not.toContain('[data-myoxus-ui-role="editor-panel"]');
    expect(metadata).not.toContain('[data-myoxus-ui-role="editor-card"]');
    expect(metadata).not.toContain(
      '[data-myoxus-ui-role="editor-card-header"]',
    );
  });
});
