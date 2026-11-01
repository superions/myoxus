// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("all pages view icons contract", () => {
  test("view toggles use All content specific glyphs instead of generic layout or database icons", () => {
    const source = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/doc-list-item.tsx",
    );

    expect(source).toContain("AllDocsMasonryViewIcon");
    expect(source).toContain("AllDocsGridViewIcon");
    expect(source).toContain("AllDocsListViewIcon");
    expect(source).toContain("masonry: AllDocsMasonryViewIcon");
    expect(source).toContain("grid: AllDocsGridViewIcon");
    expect(source).toContain("list: AllDocsListViewIcon");
    expect(source).not.toContain("LayoutDashboardIcon");
    expect(source).not.toContain("GridIcon");
    expect(source).not.toContain("DatabaseListViewIcon");
  });
});
