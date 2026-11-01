// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("restore icon contract", () => {
  test("trash restore controls use the restore glyph instead of reset", () => {
    for (const path of [
      "client/libs/core/src/components/page-list/components/list-floating-toolbar.tsx",
      "client/libs/core/src/components/pure/trash-page-footer/index.tsx",
      "client/libs/core/src/components/explorer/docs-view/quick-actions.tsx",
    ]) {
      const source = readRepoFile(path);

      expect(source, path).toContain("ArchiveRestoreIcon");
      expect(source, path).not.toContain("ResetIcon");
    }
  });
});
