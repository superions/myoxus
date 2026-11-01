// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function repoFileExists(path: string): boolean {
  return existsSync(join(repoRoot, path));
}

describe("app tabs header facade contract", () => {
  test("uses shared AppTabStrip facade chrome instead of local product CSS", () => {
    const source = readRepoFile(
      "client/libs/core/src/modules/app-tabs-header/views/app-tabs-header.tsx",
    );
    const deletedLocalChromeFiles = [
      "client/libs/core/src/modules/app-tabs-header/views/styles.css",
      "client/libs/core/src/modules/app-tabs-header/views/styles.styles.ts",
    ];

    for (const file of deletedLocalChromeFiles) {
      expect(repoFileExists(file), file).toBe(false);
    }

    for (const requiredPrimitive of [
      "AppTabStripRoot",
      "AppTabStripLeadingSlot",
      "AppTabStripList",
      "AppTabStripTabSlot",
      "AppTabStripTab",
      "AppTabStripViewButton",
      "AppTabStripViewIcon",
      "AppTabStripViewLabel",
      "AppTabStripCloseButton",
      "AppTabStripActionButton",
      "AppTabStripWindowsControlsPlaceholder",
    ]) {
      expect(source).toContain(requiredPrimitive);
    }

    expect(source).not.toContain("./styles.styles");
    expect(source).not.toContain("styles.");
    expect(source).not.toContain("IconButton");
    expect(source).not.toContain("<button");
    expect(source).not.toContain("style={{");
    expect(source).not.toContain("trafficLightOffset");
    expect(source).not.toMatch(/(?:52|64|120|200|22\.86|32)px?/);
  });

  test("keeps every rendered close affordance visible without hover reflow", () => {
    const facade = readRepoFile("client/libs/ui-facade/src/app-tab-strip.css");

    expect(facade).toMatch(
      /\.myoxus-app-tab-strip__close-slot\s*\{[^}]*width:\s*calc\(var\(--mantine-spacing-xl\) \+ var\(--mantine-spacing-xs\)\)/s,
    );
    expect(facade).toMatch(
      /\.myoxus-app-tab-strip__close-button\s*\{[^}]*display:\s*flex/s,
    );
    expect(facade).not.toMatch(
      /\.myoxus-app-tab-strip__tab:is\([^)]*\)[\s\S]*?\.myoxus-app-tab-strip__close-button\s*\{[^}]*display:\s*flex/s,
    );
  });

  test("keeps native tab chrome out of Browser Web layout", () => {
    const appContainer = readRepoFile(
      "client/libs/core/src/desktop/components/app-container/index.tsx",
    );
    const desktopLayout = appContainer.slice(
      appContainer.indexOf("const DesktopLayout"),
      appContainer.indexOf("const BrowserLayout"),
    );
    const browserLayout = appContainer.slice(
      appContainer.indexOf("const BrowserLayout"),
      appContainer.indexOf("const LayoutComponent"),
    );

    expect(desktopLayout).toContain("<AppTabsHeader");
    expect(browserLayout).not.toContain("AppTabsHeader");
    expect(appContainer).toContain(
      "BUILD_CONFIG.isElectron ? DesktopLayout : BrowserLayout",
    );
  });
});
