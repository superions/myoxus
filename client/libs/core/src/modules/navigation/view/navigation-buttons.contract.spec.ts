// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("navigation buttons platform contract", () => {
  test("keeps back/forward chrome out of Browser Web and behind Facade primitives", () => {
    const source = readRepoFile(
      "client/libs/core/src/modules/navigation/view/navigation-buttons.tsx",
    );
    const appContainer = readRepoFile(
      "client/libs/core/src/desktop/components/app-container/index.tsx",
    );

    expect(appContainer).toContain("{isInWorkspace && <NavigationButtons />}");
    expect(source).toContain("if (!BUILD_CONFIG.isElectron)");
    expect(source).toContain("return null;");
    expect(source).toContain("HeaderActionGroup");
    expect(source).toContain("IconButton");
    expect(source).toContain('data-testid="app-navigation-button-back"');
    expect(source).toContain('data-testid="app-navigation-button-forward"');
    expect(source).not.toContain("@mantine/");
    expect(source).not.toContain("style={{");
    expect(source).not.toContain("className=");
  });
});
