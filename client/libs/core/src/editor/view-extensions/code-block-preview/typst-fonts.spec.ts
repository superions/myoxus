import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { TYPST_FONT_URLS, TYPST_PREVIEW_FONT_FILES } from "./typst-fonts";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..", "..");
const FONT_DIR = join(REPO_ROOT, "server/static/fonts");
const FONT_MANIFEST = join(FONT_DIR, "manifest.json");

function manifestFontFiles(): Set<string> {
  const raw = JSON.parse(readFileSync(FONT_MANIFEST, "utf-8")) as {
    typst_preview_fonts?: Array<{ file: string }>;
    families?: Array<{
      ttf?: {
        vf?: { all?: Array<{ file?: string }> };
        static?: Array<{ file?: string }>;
      };
      woff2_subsets?: Array<{ file?: string }>;
    }>;
  };
  const files = new Set<string>();
  for (const font of raw.typst_preview_fonts ?? []) files.add(font.file);
  for (const family of raw.families ?? []) {
    for (const item of family.woff2_subsets ?? []) {
      if (item.file) files.add(item.file);
    }
    for (const item of family.ttf?.vf?.all ?? []) {
      if (item.file) files.add(item.file);
    }
    for (const item of family.ttf?.static ?? []) {
      if (item.file) files.add(item.file);
    }
  }
  return files;
}

describe("Typst code-block preview font loading", () => {
  test("uses server-owned font URLs instead of remote CDN URLs", () => {
    expect(TYPST_FONT_URLS.length).toBeGreaterThan(0);
    for (const url of TYPST_FONT_URLS) {
      expect(url).toMatch(/^\/api\/fonts\/[^/]+$/);
      expect(url).not.toMatch(/^https?:\/\//);
      expect(url).not.toContain("cdn.");
    }
  });

  test("references only bundled server font assets", () => {
    const manifestFiles = manifestFontFiles();

    const missingFromManifest = TYPST_PREVIEW_FONT_FILES.filter(
      (file) => !manifestFiles.has(file),
    );
    const missingFromDisk = TYPST_PREVIEW_FONT_FILES.filter(
      (file) => !existsSync(join(FONT_DIR, file)),
    );

    expect(
      missingFromManifest,
      "Typst preview must load fonts from the server font manifest",
    ).toEqual([]);
    expect(
      missingFromDisk,
      "Typst preview font files must be present in server/static/fonts",
    ).toEqual([]);
  });
});
