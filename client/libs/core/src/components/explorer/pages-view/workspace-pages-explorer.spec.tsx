// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { LiveData } from "@myoxus/infra";
import { MyoxusSettingsMantineProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

let nonTrashDocsIds$ = new LiveData<string[]>([]);

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({ list: { nonTrashDocsIds$ } }),
}));

vi.mock("../explorer-items-view", () => ({
  ExplorerItemsView: ({
    empty,
    groups,
  }: {
    empty: ReactNode;
    groups: Array<{ items: string[] }>;
  }) => {
    const items = groups.flatMap((group) => group.items);
    return items.length > 0 ? (
      <div data-testid="mixed-page-items">{items.join(",")}</div>
    ) : (
      <div data-testid="mixed-page-empty">{empty}</div>
    );
  },
}));

vi.mock("./workspace-pages-selection-toolbar", () => ({
  WorkspacePagesSelectionToolbar: () => null,
}));

vi.mock("../docs-view/doc-list-item", () => ({
  DocListItem: ({
    docId,
    groupId,
    dragSelectionDocIds,
  }: {
    docId: string;
    groupId: string;
    dragSelectionDocIds?: string[];
  }) => (
    <div
      data-testid="document-page-item"
      data-group-id={groupId}
      data-drag-selection={dragSelectionDocIds?.join(",")}
    >
      {docId}
    </div>
  ),
}));

vi.mock("./database-page-item", () => ({
  DatabasePageItem: ({
    itemId,
    groupId,
  }: {
    itemId: string;
    groupId: string;
  }) => (
    <div data-testid="database-page-item" data-group-id={groupId}>
      {itemId}
    </div>
  ),
}));

import { createDocExplorerContext, DocExplorerContext } from "../context";
import { WorkspacePagesExplorer } from "./workspace-pages-explorer";
import { WorkspacePageItem } from "./workspace-page-item";

afterEach(() => {
  cleanup();
  nonTrashDocsIds$ = new LiveData<string[]>([]);
});

describe("WorkspacePageItem", () => {
  test("dispatches two documents and two Databases with an overlapping raw ID", () => {
    const explorerContext = createDocExplorerContext();
    explorerContext.selectedItemKeys$.next([
      "document:shared-id",
      "database:shared-id",
      "document:document-2",
    ]);
    render(
      <DocExplorerContext.Provider value={explorerContext}>
        <WorkspacePageItem groupId="mixed" itemId="document:shared-id" />
        <WorkspacePageItem groupId="mixed" itemId="document:document-2" />
        <WorkspacePageItem groupId="mixed" itemId="database:shared-id" />
        <WorkspacePageItem groupId="mixed" itemId="database:database-2" />
      </DocExplorerContext.Provider>,
    );

    expect(
      screen
        .getAllByTestId("document-page-item")
        .map((item) => item.textContent),
    ).toEqual(["shared-id", "document-2"]);
    expect(
      screen
        .getAllByTestId("database-page-item")
        .map((item) => item.textContent),
    ).toEqual(["database:shared-id", "database:database-2"]);
    expect(
      screen
        .getAllByTestId(/^(document|database)-page-item$/)
        .every((item) => item.getAttribute("data-group-id") === "mixed"),
    ).toBe(true);
    expect(
      screen
        .getAllByTestId("document-page-item")
        .map((item) => item.getAttribute("data-drag-selection")),
    ).toEqual(["shared-id,document-2", "shared-id,document-2"]);
  });
});

describe("WorkspacePagesExplorer inventory states", () => {
  function renderExplorer(
    loadState:
      | { status: "loading"; records: []; failedOffset: null }
      | { status: "error"; records: []; failedOffset: number },
    retry = vi.fn(),
  ) {
    const explorerContext = createDocExplorerContext();
    return render(
      <MyoxusSettingsMantineProvider>
        <DocExplorerContext.Provider value={explorerContext}>
          <WorkspacePagesExplorer
            databases={[]}
            groups={[{ key: "all", items: ["document:doc-1"] }]}
            loadState={loadState}
            reload={vi.fn()}
            retry={retry}
            workspaceId="workspace-1"
          />
        </DocExplorerContext.Provider>
      </MyoxusSettingsMantineProvider>,
    );
  }

  test("renders confirmed documents while the Database inventory is loading", () => {
    nonTrashDocsIds$.setValue(["doc-1"]);
    renderExplorer({ status: "loading", records: [], failedOffset: null });

    expect(screen.getByTestId("mixed-page-items").textContent).toBe(
      "document:doc-1",
    );
    expect(screen.queryByTestId("workspace-pages-database-loading")).toBeNull();
  });

  test("shows a failed Database load with an operable retry and no false empty state", () => {
    const retry = vi.fn();
    renderExplorer({ status: "error", records: [], failedOffset: 0 }, retry);

    expect(
      screen.queryByTestId("workspace-pages-database-error"),
    ).not.toBeNull();
    expect(screen.getByTestId("mixed-page-empty").children).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
