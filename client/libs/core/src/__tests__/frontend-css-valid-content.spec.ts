// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const scanRoots = [
  "client/libs/core/src",
  "client/libs/ui-facade/src",
  "client/admin",
  "client/web",
] as const;

function collectCssFiles(root: string): string[] {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];

  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const absolute = join(current, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (/\.(?:css|scss)$/.test(entry)) {
        files.push(absolute);
      }
    }
  }
  return files;
}

describe("frontend CSS generated-content contract", () => {
  test("active frontend styles never emit invalid empty content declarations", () => {
    const offenders = scanRoots
      .flatMap((root) => collectCssFiles(root))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return Array.from(source.matchAll(/content:\s*;/g), (match) => ({
          column: match.index - source.lastIndexOf("\n", match.index) + 1,
          line: source.slice(0, match.index).split("\n").length,
          path: relative(repoRoot, file),
        }));
      });

    expect(offenders).toEqual([]);
  });
});
