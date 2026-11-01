// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("page content preview fallback contract", () => {
  test("desktop cards can use Virgultum page text as a local fallback", () => {
    const previewSource = readRepoFile(
      "client/libs/core/src/components/page-list/page-content-preview.tsx",
    );
    const cardSource = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/doc-list-item.tsx",
    );

    expect(previewSource).toContain("useVirgultumPagePreview");
    expect(previewSource).toContain("enableLocalTextFallback");
    expect(previewSource).toContain("docsService.open(pageId)");
    expect(previewSource).toContain("opened.release()");
    expect(previewSource).toContain('primaryMode === "page"');
    expect(previewSource).toContain('primaryMode === "edgeless"');

    expect(cardSource).toContain("enableLocalTextFallback");
    expect(cardSource).toContain("emptyFallback=");
    expect(cardSource).toContain("edgelessFallback=");
    expect(cardSource).toContain('kind === "preview" ? 6 : undefined');
    expect(cardSource).toContain('kind === "preview" ? false : undefined');
  });
});
