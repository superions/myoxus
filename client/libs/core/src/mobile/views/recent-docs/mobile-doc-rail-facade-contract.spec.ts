// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function repoFile(path: string) {
  return join(repoRoot, path);
}

function readRepoFile(path: string): string {
  return readFileSync(repoFile(path), "utf8");
}

describe("mobile document rail facade migration contract", () => {
  test("keeps recent docs and search doc rails on generic facade roles", () => {
    const recentDocs = readRepoFile(
      "client/libs/core/src/mobile/views/recent-docs/index.tsx",
    );
    const searchResults = readRepoFile(
      "client/libs/core/src/mobile/views/search/search-results.tsx",
    );
    const facade = readRepoFile(
      "client/libs/ui-facade/src/mobile-doc-rail.tsx",
    );

    for (const [label, source] of [
      ["recentDocs", recentDocs],
      ["searchResults", searchResults],
    ] as const) {
      expect(source, label).toContain("@myoxus/ui-facade");
      expect(source, label).toContain("MobileDocStripItem");
      expect(source, label).not.toMatch(/\.styles["']/);
      expect(source, label).not.toContain("styles.");
      expect(source, label).not.toMatch(/\b[0-9]+px\b/);
      expect(source, label).not.toMatch(/style=\{\{/);
    }

    for (const role of [
      "MobileDocScroller",
      "MobileDocStrip",
      "MobileDocStripItem",
    ]) {
      expect(recentDocs).toContain(role);
      expect(facade).toContain(`export function ${role}`);
    }

    expect(searchResults).not.toContain("MOBILE_SEARCH_CLASS_NAMES");
    expect(facade).not.toContain("MOBILE_SEARCH_CLASS_NAMES");
    expect(facade).toContain("<ScrollArea");
    expect(facade).toContain('scrollbars="x"');
    expect(facade).toContain('type="auto"');
    expect(facade).toContain("<Group");
    expect(facade).toContain("mobileDocStripItemWidth");
    expect(facade).not.toContain("44vw");
    expect(facade).not.toContain("myoxus-mobile-search-doc-card");
    expect(facade).not.toContain("myoxus-mobile-search-doc-scroller");
    expect(facade).not.toContain("myoxus-mobile-search-doc-strip");
    expect(
      existsSync(repoFile("client/libs/ui-facade/src/mobile-search.css")),
    ).toBe(false);
  });

  test("does not restore retired recent docs style modules", () => {
    for (const path of [
      "client/libs/core/src/mobile/views/recent-docs/styles.css",
      "client/libs/core/src/mobile/views/recent-docs/styles.styles.ts",
    ]) {
      expect(existsSync(repoFile(path)), path).toBe(false);
    }
  });
});
