import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const emptyRoot = "client/libs/core/src/components/myoxus/empty";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("core empty-state facade migration contract", () => {
  test("keeps product empty states on the shared Facade role", () => {
    const layout = readRepoFile(`${emptyRoot}/layout.tsx`);
    const actionButton = readRepoFile(`${emptyRoot}/action-button.tsx`);

    expect(layout).toContain("EmptyState");
    expect(layout).toContain("ThemedImg");
    expect(layout).toContain("fluid");
    expect(actionButton).toContain("Button");

    for (const removed of [
      "style.styles",
      "styles.",
      "classNames",
      "withUnit",
      "BUILD_CONFIG.isMobileEdition",
      "contentClassName",
      "style=",
      "font-size",
      "line-height",
      "px",
    ]) {
      expect(layout).not.toContain(removed);
      expect(actionButton).not.toContain(removed);
    }
  });

  test("does not keep a local CSS island for empty-state layout or typography", () => {
    expect(existsSync(join(repoRoot, `${emptyRoot}/style.css`))).toBe(false);
    expect(existsSync(join(repoRoot, `${emptyRoot}/style.styles.ts`))).toBe(
      false,
    );
  });
});
