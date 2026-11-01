import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const headerRoot = "client/libs/core/src/mobile/components/page-header";
const backButtonPath =
  "client/libs/core/src/mobile/components/navigation-back/index.tsx";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("mobile page header facade migration contract", () => {
  test("keeps the generic mobile page header off local CSS modules", () => {
    expect(existsSync(join(repoRoot, `${headerRoot}/styles.css`))).toBe(false);
    expect(existsSync(join(repoRoot, `${headerRoot}/styles.styles.ts`))).toBe(
      false,
    );

    const source = readRepoFile(`${headerRoot}/index.tsx`);
    expect(source).toContain("MobilePageHeaderRoot");
    expect(source).toContain("MobilePageHeaderBar");
    expect(source).toContain("MobilePageHeaderPrefix");
    expect(source).toContain("MobilePageHeaderContent");
    expect(source).toContain("MobilePageHeaderSuffix");
    expect(source).toContain("MobilePageHeaderSpacer");
    expect(source).toContain("SafeArea");

    for (const removed of [
      "styles.",
      "styles.styles",
      "classNames",
      "contentClassName",
      "bottomSpacer",
      "mobile-page-header-bar",
      "mobile-page-header-prefix",
      "mobile-page-header-content",
      "mobile-page-header-suffix",
      "mobile-page-header-spacer",
      "44px",
      "88px",
      "12px",
      "16px",
      "style.css",
      "style={{",
    ]) {
      expect(source).not.toContain(removed);
    }
  });

  test("keeps navigation back button sizing on the facade IconButton contract", () => {
    const source = readRepoFile(backButtonPath);

    expect(source).toContain("IconButton");
    expect(source).not.toContain("padding: 10");
    expect(source).not.toContain("size={24}");
    expect(source).not.toContain("useMemo");
  });
});
