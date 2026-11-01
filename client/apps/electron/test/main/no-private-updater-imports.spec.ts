// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(root, entry.name);
      return entry.isDirectory()
        ? sourceFiles(entryPath)
        : Promise.resolve(
            /\.[cm]?[jt]sx?$/.test(entry.name) ? [entryPath] : [],
          );
    }),
  );
  return nested.flat();
}

describe("electron-updater public API boundary", () => {
  it("contains no private electron-updater imports in production or tests", async () => {
    const roots = [
      path.resolve(import.meta.dirname, "../../src"),
      path.resolve(import.meta.dirname, ".."),
    ];
    const forbidden = ["electron-updater", "out"].join("/");
    const offenders: string[] = [];

    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      const source = await readFile(file, "utf8");
      if (source.includes(forbidden)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
