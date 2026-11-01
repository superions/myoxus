// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const globalLoadingRoot =
  "client/libs/core/src/desktop/pages/root/global-loading";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("global loading facade contract", () => {
  test("does not reintroduce manual sizing, style modules or responsiveness", () => {
    const source = readRepoFile(`${globalLoadingRoot}/index.tsx`);

    for (const forbidden of [
      "index.styles",
      "styles.",
      "className=",
      "data-loading",
      "style={{",
      "matchMedia",
      "innerWidth",
      "innerHeight",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    expect(source).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
    expect(source).not.toMatch(/\b(size|width|height)=\{[0-9]/);
  });
});
