// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

describe("Electron main event lifecycle", () => {
  test("keeps the tab-action subscription bound during quit cleanup", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/apps/electron/src/main/windows-manager/tab-views.ts",
      ),
      "utf8",
    );
    const onTabAction = source.slice(
      source.indexOf("export const onTabAction"),
      source.indexOf("export const onActiveTabChanged"),
    );

    expect(onTabAction).toContain("const subscription =");
    expect(onTabAction).toContain("subscription.unsubscribe()");
    expect(onTabAction).not.toMatch(/const\s*\{\s*unsubscribe\s*\}/);
    expect(onTabAction).not.toMatch(/return\s+unsubscribe/);
  });

  test("does not re-enter app quit while tab views are being destroyed", () => {
    const cleanupSource = readFileSync(
      join(process.cwd(), "client/apps/electron/src/main/cleanup.ts"),
      "utf8",
    );
    const tabViewsSource = readFileSync(
      join(
        process.cwd(),
        "client/apps/electron/src/main/windows-manager/tab-views.ts",
      ),
      "utf8",
    );
    const mainSource = readFileSync(
      join(process.cwd(), "client/apps/electron/src/main/index.ts"),
      "utf8",
    );

    expect(cleanupSource).toContain("appQuitInProgress = true");
    expect(tabViewsSource).toContain(
      "this.tabViewsMap.size === 0 && !isAppQuitInProgress()",
    );
    expect(mainSource).toMatch(
      /app\.on\("window-all-closed", \(\) => \{\s+if \(!isAppQuitInProgress\(\)\)/,
    );
  });

  test("closes child web contents before destroying their window", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/apps/electron/src/main/windows-manager/main-window.ts",
      ),
      "utf8",
    );
    const closeAllWindows = source.slice(
      source.indexOf("function closeAllWindows"),
      source.indexOf("export class MainWindowManager"),
    );

    expect(closeAllWindows.indexOf("removeChildView(view)")).toBeLessThan(
      closeAllWindows.indexOf("view.webContents.close"),
    );
    expect(closeAllWindows.indexOf("view.webContents.close")).toBeLessThan(
      closeAllWindows.indexOf("w.destroy()"),
    );
  });
});
