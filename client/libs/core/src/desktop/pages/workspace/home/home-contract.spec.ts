// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("Workspace Home product boundary", () => {
  test("uses the Facade and existing authorities without local visual systems", () => {
    const homeRoot = "client/libs/core/src/desktop/pages/workspace/home";
    const sources = [
      "index.tsx",
      "section.tsx",
      "dashboard-edit-context.tsx",
      "dashboard-grid.tsx",
      "dashboard-layout.ts",
      "document-sections.tsx",
      "today-section.tsx",
      "notification-views.tsx",
    ].map((file) => read(`${homeRoot}/${file}`));

    expect(existsSync(join(repoRoot, `${homeRoot}/index.css`))).toBe(false);
    expect(existsSync(join(repoRoot, `${homeRoot}/index.module.css`))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, `${homeRoot}/dashboard-grid.css`))).toBe(
      false,
    );
    for (const source of sources) {
      expect(source).not.toContain("@mantine/");
      expect(source).not.toMatch(/\bstyle=\{/);
      expect(source).not.toContain("matchMedia");
      expect(source).not.toContain("ResizeObserver");
      expect(source).not.toContain("localStorage");
    }
    expect(sources.join("\n")).toContain("DocsService");
    expect(sources.join("\n")).toContain("IntegrationService");
    expect(sources.join("\n")).toContain("NotificationService");
    expect(sources.join("\n")).toContain("MyoxusCommandRegistry");
    expect(sources.join("\n")).toContain("useDraggable");
    expect(sources.join("\n")).toContain("useDropTarget");
    expect(sources.join("\n")).toContain("UserPreferencesService");
  });

  test("keeps explicit content routes while unqualified entries use home", () => {
    const rootIndex = read(
      "client/libs/core/src/desktop/pages/index/index.tsx",
    );
    const sidebar = read(
      "client/libs/core/src/components/root-app-sidebar/index.tsx",
    );
    const home = read(
      "client/libs/core/src/desktop/pages/workspace/home/index.tsx",
    );
    const authPages = read(
      "client/libs/core/src/desktop/pages/auth/auth-pages.tsx",
    );

    expect(rootIndex).toContain('defaultIndexRoute = "home"');
    expect(sidebar).toContain('jumpToPage(workspaceMetadata.id, "home")');
    expect(home).toContain('workbench.open("/all"');
    expect(home).toContain('"/inbox?read=all&type=reminders"');
    expect(home).toContain('"/inbox?read=unread&type=all"');
    expect(authPages).toContain("sanitizeAuthRedirectTarget");
    expect(authPages).not.toContain("new URL(url)");
  });
});
