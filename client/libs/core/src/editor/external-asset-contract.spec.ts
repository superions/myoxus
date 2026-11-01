import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const PHANTOM_MYOXUS_CDN = ["cdn", "myoxus", "de"].join(".");
const LEGACY_AFFINE_CDN = ["cdn", "affine", "pro"].join(".");
const SCAN_TARGETS = [
  {
    path: "client/libs/core/src/editor/view-extensions/code-block-preview",
    markers: [PHANTOM_MYOXUS_CDN, LEGACY_AFFINE_CDN],
  },
  {
    path: "client/libs/core/src/editor/ai/slides",
    markers: [PHANTOM_MYOXUS_CDN, LEGACY_AFFINE_CDN],
  },
  {
    path: "docs/provenance-inventory.md",
    markers: [PHANTOM_MYOXUS_CDN],
  },
] as const;
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".md"]);

type Hit = {
  file: string;
  line: number;
  marker: string;
  text: string;
};

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

function listFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) {
    return SCANNED_EXTENSIONS.has(extensionOf(path)) ? [path] : [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    files.push(...listFiles(join(path, entry)));
  }
  return files;
}

function scanFile(file: string, markers: readonly string[]): Hit[] {
  const lines = readFileSync(file, "utf-8").split("\n");
  const hits: Hit[] = [];
  lines.forEach((line, index) => {
    for (const marker of markers) {
      if (line.includes(marker)) {
        hits.push({
          file: relative(REPO_ROOT, file),
          line: index + 1,
          marker,
          text: line.trim(),
        });
      }
    }
  });
  return hits;
}

describe("editor external asset contract", () => {
  test("active editor preview and AI slide paths do not reference phantom CDNs", () => {
    const scans = SCAN_TARGETS.flatMap((target) =>
      listFiles(join(REPO_ROOT, target.path)).map((file) => ({
        file,
        markers: target.markers,
      })),
    );
    expect(scans.length).toBeGreaterThan(0);

    const hits = scans.flatMap(({ file, markers }) => scanFile(file, markers));
    expect(
      hits,
      hits
        .map((hit) => `${hit.file}:${hit.line} ${hit.marker} ${hit.text}`)
        .join("\n"),
    ).toEqual([]);
  });
});
