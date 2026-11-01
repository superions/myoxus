/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Doc } from "yjs";
import { LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import type { DropTargetDropEvent } from "@myoxus/ui-facade";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  home: vi.fn(),
  rootDrop: undefined as
    ((data: DropTargetDropEvent<MyoxusDNDData>) => void) | undefined,
  moveHere: vi.fn(),
  createFolder: vi.fn(),
}));
vi.mock("../../tree", async (original) => {
  const real = await original<typeof import("../../tree")>();
  const TreeNode = real.StructureTreeNode;
  return {
    ...real,
    StructureTreeNode: (props: Parameters<typeof TreeNode>[0]) => {
      if (props.dndData?.dropTarget?.at === "structure-tree:organize:root") {
        mocks.rootDrop = props.onDrop;
      }
      return <TreeNode {...props} />;
    },
  };
});
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useServices: () => mocks.services,
  useService: () => ({}),
}));
vi.mock("@myoxus/core/modules/organize", () => ({ OrganizeService: class {} }));
vi.mock("@myoxus/core/modules/server", () => ({
  WorkspaceServerService: class {},
}));
vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class {},
}));
vi.mock("@myoxus/core/modules/structure-tree", () => ({
  StructureTreeStateService: class {},
}));
vi.mock("@myoxus/core/modules/app-sidebar", () => ({
  AppSidebarService: class {},
}));
vi.mock("@myoxus/core/modules/explorer-icon/services/explorer-icon", () => ({
  ExplorerIconService: class {},
}));
vi.mock("@myoxus/core/modules/share-setting", async () => ({
  ...(await import("@myoxus/core/modules/share-setting/public-url")),
  WorkspaceShareSettingService: class {},
}));
vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => ({ jumpToWorkspaceOverview: mocks.home }),
}));
vi.mock("@myoxus/core/components/guard", () => ({
  useGuard: () => true,
  Guard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@myoxus/core/modules/workbench", () => ({
  ViewBody: ({ children }: { children: ReactNode }) => children,
  ViewHeader: ({ children }: { children: ReactNode }) => children,
  ViewTitle: () => null,
  ViewIcon: () => null,
  WorkbenchLink: () => null,
  WorkbenchService: class {},
}));
vi.mock("../../nodes/doc", () => ({ StructureTreeDocNode: () => null }));
vi.mock("../../nodes/folder", () => ({ StructureTreeFolderNode: () => null }));
vi.mock("../../layouts/collapsible-section", () => ({
  CollapsibleSection: () => null,
}));
vi.mock("./empty", () => ({ RootEmpty: () => null }));
vi.mock("../../../../desktop/pages/workspace/overview/introduction", () => ({
  WorkspaceIntroduction: () => null,
}));
vi.mock("swr", () => ({
  default: () => ({
    data: {
      workspace: {
        overview: {
          folder: null,
          breadcrumbs: [],
          children: [],
          introduction: null,
          introductionUnavailable: false,
          documents: [],
        },
        overviewSettings: {},
      },
    },
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      { get: (_, key) => (key === "language" ? "en" : () => String(key)) },
    ),
}));

import { StructureTreeOrganizeTree } from "./index";
import { WorkspaceOverview } from "../../../../desktop/pages/workspace/overview";

const label = "com.myoxus.workspace-overview.";
let state: ReturnType<typeof makeState>;
let folders: Doc;
let root: Doc;
function makeState() {
  return {
    publiclyAccessible$: new LiveData<boolean | null>(true),
    isLoading$: new LiveData(false),
    error$: new LiveData<Error | null>(null),
    name$: new LiveData("Workspace A"),
    description$: new LiveData("Description"),
    public$: new LiveData(false),
    enableSharing$: new LiveData(true),
    setDescription: vi.fn(),
  };
}
beforeEach(() => {
  folders = new Doc({ guid: "db$folders" });
  root = new Doc({ guid: "workspace-a" });
  state = makeState();
  mocks.home.mockClear();
  mocks.moveHere.mockClear();
  mocks.createFolder.mockClear();
  mocks.rootDrop = undefined;
  mocks.services = {
    workspaceService: {
      workspace: {
        id: "workspace-a",
        meta: { name: "Workspace A" },
        rootYDoc: root,
      },
    },
    documentMetadataCacheService: {
      watchIndexState: () => new LiveData({ generation: 0 }),
    },
    tagService: {
      tagList: {
        inventoryRevision$: new LiveData(0),
        catalogState$: new LiveData({ tags: [] }),
      },
    },
    workspaceDBService: { getWorkspaceDbDoc: () => folders },
    workspaceServerService: {
      server: { baseUrl: "https://example.test" },
      server$: new LiveData({
        id: "server",
        baseUrl: "https://example.test",
        account$: new LiveData({ id: "actor" }),
      }),
    },
    workbenchService: { workbench: { open: vi.fn() } },
    workspaceShareSettingService: { sharePreview: state },
    structureTreeStateService: {
      collapsed$: () => new LiveData(false),
      setCollapsed: vi.fn(),
    },
    organizeService: {
      folderTree: {
        rootFolder: {
          sortedChildren$: new LiveData([]),
          indexAt: () => "a0",
          moveHere: mocks.moveHere,
          createFolder: mocks.createFolder,
        },
        isLoading$: new LiveData(false),
      },
    },
  };
});
afterEach(() => {
  cleanup();
  folders.destroy();
  root.destroy();
});
const tree = () => (
  <MyoxusUIProvider>
    <StructureTreeOrganizeTree chrome="folders" />
  </MyoxusUIProvider>
);

describe("workspace root navigation", () => {
  test("dropping an existing folder on Home moves its identity without creating a folder", () => {
    render(tree());
    if (!mocks.rootDrop)
      throw new Error("Workspace Home drop target was not rendered");
    act(() =>
      mocks.rootDrop!({
        source: { data: { entity: { type: "folder", id: "existing-folder" } } },
      } as DropTargetDropEvent<MyoxusDNDData>),
    );
    expect(mocks.moveHere).toHaveBeenCalledExactlyOnceWith(
      "existing-folder",
      "a0",
    );
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  test("keeps Home internal and the public link independent for mouse and keyboard", () => {
    render(tree());
    const home = screen.getByRole("treeitem");
    const globe = screen.getByRole("link", {
      name: label + "public-status.globe",
    });
    expect(globe.getAttribute("href")).toBe(
      "https://example.test/public/workspace-a",
    );
    expect(globe.getAttribute("target")).toBe("_blank");
    expect(globe.getAttribute("rel")).toBe("noopener noreferrer");
    // Suppress browser navigation without stopping propagation through the real tree.
    globe.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(globe);
    fireEvent.keyDown(globe, { key: "Enter" });
    expect(mocks.home).not.toHaveBeenCalled();
    fireEvent.click(home);
    fireEvent.keyDown(home, { key: "Enter" });
    expect(mocks.home).toHaveBeenCalledTimes(2);
    expect(mocks.home).toHaveBeenLastCalledWith("workspace-a");
  });

  test("withdraws stale public links during revalidation and errors, then follows the fresh result", () => {
    render(tree());
    const link = () =>
      screen.queryByRole("link", { name: label + "public-status.globe" });
    expect(link()).not.toBeNull();
    act(() => state.isLoading$.next(true));
    expect(link()).toBeNull();
    act(() => {
      state.error$.next(new Error("Unavailable"));
      state.isLoading$.next(false);
    });
    expect(link()).toBeNull();
    act(() => {
      state.publiclyAccessible$.next(false);
      state.error$.next(null);
    });
    expect(link()).toBeNull();
    act(() => state.publiclyAccessible$.next(null));
    expect(link()).toBeNull();
    act(() => state.publiclyAccessible$.next(true));
    expect(link()).not.toBeNull();
  });

  test("switches both destinations with the workspace", () => {
    const view = render(tree());
    mocks.services.workspaceService = {
      workspace: { id: "workspace-b", meta: { name: "Workspace B" } },
    };
    view.rerender(tree());
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://example.test/public/workspace-b",
    );
    fireEvent.click(screen.getByRole("treeitem"));
    expect(mocks.home).toHaveBeenLastCalledWith("workspace-b");
  });
});

test("description editor exposes its name and instructions to assistive technology", async () => {
  render(
    <MemoryRouter>
      <MyoxusUIProvider>
        <WorkspaceOverview />
      </MyoxusUIProvider>
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: label + "description.edit" }),
  );
  const input = await screen.findByRole("textbox", {
    name: label + "description.heading",
  });
  expect((input as HTMLTextAreaElement).value).toBe("Description");
  const descriptions = input
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent);
  expect(descriptions).toEqual([label + "modal.consequence"]);
  fireEvent.change(input, { target: { value: "a".repeat(2001) } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(
    input
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent),
  ).toContain(label + "modal.limit");
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.setDescription).not.toHaveBeenCalled();
});
