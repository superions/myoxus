// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const root = process.cwd();
const core = "client/libs/core/src/modules/workbench";

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("Workbench Context Panel contract", () => {
  test("keeps the retired right-sidebar chrome deleted", () => {
    for (const path of [
      `${core}/entities/sidebar-tab.ts`,
      `${core}/view/sidebar/right-sidebar.tsx`,
      `${core}/view/sidebar/sidebar-chrome.tsx`,
      `${core}/view/sidebar/sidebar-container.tsx`,
      `${core}/view/sidebar/sidebar-content-host.tsx`,
      `${core}/view/sidebar/sidebar-tabs.tsx`,
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  test("uses one intrinsic Context Panel surface without resize chrome", () => {
    const panel = read(
      `${core}/view/context-panel/workbench-context-panel.tsx`,
    );
    const host = read(`${core}/view/context-panel/context-surface-host.tsx`);
    const entity = read(`${core}/entities/context-surface.ts`);
    const routeContainer = read(`${core}/view/route-container.tsx`);
    const workbenchRoot = read(`${core}/view/workbench-root.tsx`);

    expect(panel).toContain("<WorkbenchContextPanelSurface");
    expect(panel).not.toContain("ResponsiveSidePanel");
    expect(panel).not.toContain("contextPanelWidth$");
    expect(panel).not.toContain("desktopResize");
    expect(panel).not.toContain("setResizing");
    expect(host).toContain("ViewContextSurfaceBodyTarget");
    expect(host).toContain("WorkbenchToolCard");
    expect(host).toContain("<Card");
    expect(host).toContain("<Collapse");
    expect(host).toContain("<DragHandle");
    expect(host).toContain("<DropIndicator");
    expect(host).not.toContain("activeContextSurface");
    expect(entity).toContain("export class ContextSurface");
    expect(routeContainer).toContain("<WorkbenchContextPanel");
    expect(workbenchRoot).not.toContain("<WorkbenchContextPanel />");
    expect(`${panel}\n${host}\n${entity}`).not.toMatch(
      /WorkbenchRightSidebar|SidebarTabDescriptor|ViewSidebarTab/,
    );
    expect(panel).toContain('t["com.myoxus.workbench.contextPanel.title"]()');
  });

  test("keeps one persisted stack state and no singular compatibility path", () => {
    const view = read(`${core}/entities/view.ts`);
    const resolver = read(`${core}/entities/tool-layout.ts`);
    const menu = read(
      "client/libs/core/src/components/document-header-menu/index.tsx",
    );
    const sharedToolsMenu = read(
      "client/libs/core/src/components/workbench-tools-menu/index.tsx",
    );
    const litAdapter = read(
      "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
    );

    expect(view).toContain("showTool(id: WorkbenchToolId)");
    expect(view).toContain("hideTool(id: WorkbenchToolId)");
    expect(view).toContain("toggleToolCollapsed(id: WorkbenchToolId)");
    expect(view).toContain("moveTool(id: WorkbenchToolId");
    expect(resolver).toContain("collapsedToolIds");
    expect(menu).toContain("<WorkbenchToolsMenuSub");
    expect(sharedToolsMenu).toContain("<MenuSub");
    expect(sharedToolsMenu).toContain("view.showTool(surface.id)");
    expect(sharedToolsMenu).toContain("view.hideTool(surface.id)");
    expect(litAdapter).not.toContain("TagsValue");
    expect(`${view}\n${menu}\n${sharedToolsMenu}`).not.toMatch(
      /activeContextSurface|document-context|surfaceId="journal"|surfaceId="adapter"/,
    );
  });
});
