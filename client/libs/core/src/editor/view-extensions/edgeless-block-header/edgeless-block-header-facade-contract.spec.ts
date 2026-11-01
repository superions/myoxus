// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const headerRoot =
  "client/libs/core/src/editor/view-extensions/edgeless-block-header";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("edgeless block header facade migration contract", () => {
  test("keeps edgeless header chrome out of product CSS", () => {
    for (const file of [
      `${headerRoot}/edgeless-block-header.css`,
      `${headerRoot}/edgeless-block-header.styles.ts`,
    ]) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }

    const common = readRepoFile(`${headerRoot}/common.tsx`);
    const noteHeader = readRepoFile(`${headerRoot}/edgeless-note-header.tsx`);
    const embedHeader = readRepoFile(
      `${headerRoot}/edgeless-embed-synced-doc-header.tsx`,
    );
    const geometry = readRepoFile(`${headerRoot}/geometry.ts`);
    const joined = [common, noteHeader, embedHeader].join("\n");

    for (const facadeRole of [
      "CanvasOverlayToolbar",
      "CanvasOverlayTitleSlot",
      "CanvasOverlayTitleIcon",
      "CanvasOverlayTitleText",
      "IconButton",
    ]) {
      expect(joined).toContain(facadeRole);
    }

    expect(joined).not.toContain("edgeless-block-header.styles");
    expect(joined).not.toContain("styles.");
    expect(joined).not.toContain("className={styles");
    expect(joined).not.toContain("prefixStyle");
    expect(joined).not.toContain("iconSize");
    expect(joined).not.toContain("headerHeight");
    expect(joined).not.toMatch(/\b[0-9]+px\b/);

    expect(geometry).toContain("canvas/model units");
    expect(geometry).toContain("EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT");
  });
});
