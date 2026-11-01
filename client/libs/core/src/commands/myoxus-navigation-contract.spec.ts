// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("Myoxus navigation command contract", () => {
  test("uses the shared disclosure glyph and localized labels in Quick Search", () => {
    const source = readRepoFile(
      "client/libs/core/src/commands/myoxus-navigation.tsx",
    );

    expect(source).toContain("DisclosureTriangleIcon");
    expect(source).not.toContain("ArrowRightBigIcon");
    expect(source).not.toContain('"Go to Collection List"');
    expect(source).not.toContain('"Go to Tag List"');
    expect(source).toContain("com.myoxus.cmdk.navigation.goto-collections");
    expect(source).toContain("com.myoxus.cmdk.navigation.goto-tags");
  });
});
