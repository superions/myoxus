import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Menu: { getApplicationMenu: vi.fn() },
}));

vi.mock("../../src/main/windows-manager", () => ({
  getTabViewsMeta: vi.fn(() => ({
    activeWorkbenchId: undefined,
    workbenches: [],
  })),
}));

vi.mock("../../src/main/application-menu/subject", () => ({
  applicationMenuSubjects: {
    documentVersionAction$: { next: vi.fn() },
  },
}));

describe("document versions application menu", () => {
  it("INV-DOCVER-ELEC-01: disables version actions without an active document", async () => {
    const { createDocumentVersionSubmenu } =
      await import("../../src/main/application-menu/doc-versions");

    const submenu = createDocumentVersionSubmenu();
    const items = submenu.submenu as Electron.MenuItemConstructorOptions[];
    const actionableItems = items.filter((item) => item.type !== "separator");

    expect(actionableItems.length).toBe(4);
    expect(actionableItems.every((item) => item.enabled === false)).toBe(true);
  });

  it("INV-DOCVER-ELEC-02: detects active document path from active workbench view", async () => {
    const { getDocumentVersionMenuContextFromMeta } =
      await import("../../src/main/application-menu/doc-versions");

    expect(
      getDocumentVersionMenuContextFromMeta({
        activeWorkbenchId: "tab-1",
        workbenches: [
          {
            id: "tab-1",
            activeViewIndex: 0,
            basename: "/workspace/ws-1",
            views: [
              {
                id: "view-1",
                path: { pathname: "/doc-123", search: "", hash: "" },
                title: "Doc",
                iconName: "page",
              },
            ],
          },
        ],
      }),
    ).toEqual({ tabId: "tab-1", docId: "doc-123" });
  });

  it("INV-DOCVER-ELEC-03: reserved workspace routes are not treated as documents", async () => {
    const { getDocumentVersionMenuContextFromMeta } =
      await import("../../src/main/application-menu/doc-versions");

    expect(
      getDocumentVersionMenuContextFromMeta({
        activeWorkbenchId: "tab-1",
        workbenches: [
          {
            id: "tab-1",
            activeViewIndex: 0,
            basename: "/workspace/ws-1",
            views: [
              {
                id: "view-1",
                path: { pathname: "/collection", search: "", hash: "" },
                title: "Collection",
                iconName: "collection",
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});
