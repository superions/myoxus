// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const languageMenuRoot = "client/libs/core/src/components/myoxus/language-menu";
const sourcePath = `${languageMenuRoot}/index.tsx`;
const deletedStylePaths = [
  `${languageMenuRoot}/style.css`,
  `${languageMenuRoot}/style.styles.ts`,
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("LanguageMenu facade contract", () => {
  test("keeps language menu chrome on shared Menu primitives", () => {
    const source = readRepoFile(sourcePath);

    for (const path of deletedStylePaths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }
    expect(source).toContain("MenuScrollableSection");
    expect(source).toContain("selected={selected}");
    expect(source).toContain('suffix={lang.completeness + "%"}');
    expect(source).toContain('panelWidth: "comfortable"');
    expect(source).not.toContain("DoneIcon");
    expect(source).not.toContain("style.styles");
    expect(source).not.toContain("className=");
    expect(source).not.toContain("fontSize");
    expect(source).not.toMatch(/\b(?:matchMedia|innerWidth|innerHeight)\b/);
    expect(source).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
  });
});
