// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const oldLower = ["block", "suite"].join("");
const oldHyphen = ["block", "suite"].join("-");
const oldPascal = ["Block", "Suite"].join("");
const forbiddenMarkers = [oldHyphen, oldLower, oldPascal];

const sourceRoots = ["client/libs/core/src", "client/web/workspaces/web/src"];

const scannedExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
]);

function extensionOf(path: string) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function* walkFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === "dist" || entry === "node_modules") continue;
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (stat.isFile()) {
      yield fullPath;
    }
  }
}

describe("Virgultum active source naming contract", () => {
  test("active Core/Web source does not reintroduce old editor names", () => {
    const failures: string[] = [];

    for (const sourceRoot of sourceRoots) {
      for (const absolutePath of walkFiles(join(repoRoot, sourceRoot))) {
        const repoPath = relative(repoRoot, absolutePath);
        const pathMarker = forbiddenMarkers.find((marker) =>
          repoPath.includes(marker),
        );
        if (pathMarker) {
          failures.push(`${repoPath}: path contains '${pathMarker}'`);
          continue;
        }

        if (!scannedExtensions.has(extensionOf(repoPath))) continue;

        const source = readFileSync(absolutePath, "utf8");
        const contentMarker = forbiddenMarkers.find((marker) =>
          source.includes(marker),
        );
        if (contentMarker) {
          failures.push(`${repoPath}: source contains '${contentMarker}'`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
