// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  assistantPackagesFixture,
  assistantQueryFixture,
} from "../presentation/test-fixtures";
import { readyManagedRecord } from "../test-fixtures";
import {
  AssistantContext,
  AssistantInputTarget,
  createDatabaseViewMutation,
  databaseRowQuery,
  databaseTaskParentQuery,
  databaseTaskChildrenQuery,
  databaseTaskReferencesQuery,
  createDatabaseRowMutation,
  DatabaseProfileKind,
  DatabaseSortDirection,
  DatabaseViewKind,
  deleteDatabaseViewMutation,
  reorderDatabaseViewsMutation,
  resetDatabaseViewUserStateMutation,
  saveDatabaseViewUserStateMutation,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  listView,
  notesField,
  relationField,
  p9gRecord,
  p9gRows,
  record,
  rows,
  tableView,
  TIMESTAMP,
  titleField,
} from "../test-fixtures";
import {
  emitDatabasePresenceChange,
  renderDatabaseViewHost,
} from "../test-harness";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

vi.mock("../tasks/use-task-freshness", () => ({
  useTaskFreshness: () => ({ live: true, retryLive: vi.fn() }),
}));

afterEach(cleanup);

function activeViewActions() {
  return screen.getByTestId("database-active-view-menu-trigger");
}

function orderedTabNames() {
  return screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());
}

describe("Database page view navigation", () => {
  test("renders View navigation once in its Workbench header and mounts only the active View", () => {
    renderDatabaseViewHost({
      activeViewId: tableView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
      renderPageHeader: (navigation) => (
        <div data-testid="database-page-header-navigation">{navigation}</div>
      ),
    });

    expect(screen.getAllByTestId("database-view-navigation")).toEqual([
      within(screen.getByTestId("database-page-header-navigation")).getByTestId(
        "database-view-navigation",
      ),
    ]);
    expect(
      screen
        .getAllByRole("tabpanel", { hidden: true })
        .filter((panel) => panel.hasChildNodes()),
    ).toEqual([screen.getByRole("tabpanel")]);
  });

  test("owns page settings in one persistent Workbench context surface", async () => {
    const { gql, rerender } = renderDatabaseViewHost({
      activeViewId: tableView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });

    const toolbar = within(screen.getByTestId("database-view-toolbar"));
    expect(
      toolbar.getAllByRole("button", { name: "View settings" }),
    ).toHaveLength(1);
    expect(toolbar.queryByRole("button", { name: "Filter" })).toBeNull();
    expect(toolbar.queryByRole("button", { name: "Sort field" })).toBeNull();
    expect(toolbar.queryByRole("button", { name: "Grouping" })).toBeNull();
    expect(toolbar.queryByRole("button", { name: "Properties" })).toBeNull();

    fireEvent.click(toolbar.getByRole("button", { name: "View settings" }));
    const context = await screen.findByTestId("database-workbench-context");
    expect(screen.queryByTestId("database-view-settings-modal")).toBeNull();
    expect(context.querySelectorAll(".mantine-Card-root")).toHaveLength(0);
    expect(
      within(context).getByRole("button", {
        name: `Rename: ${tableView.name}`,
      }),
    ).not.toBeNull();

    rerender(p9gRecord, p9gRows, listView.id);
    await waitFor(() =>
      expect(
        within(context).getByRole("button", {
          name: `Rename: ${listView.name}`,
        }),
      ).not.toBeNull(),
    );
    expect(screen.getByTestId("database-workbench-context")).toBe(context);

    fireEvent.click(
      within(context).getByRole("button", {
        name: `Rename: ${listView.name}`,
      }),
    );
    const nameInput = within(context).getByRole("textbox", {
      name: `Rename: ${listView.name}`,
    });
    fireEvent.change(nameInput, { target: { value: "Planning" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: {
              databaseId: p9gRecord.database.id,
              expectedEditRevision: listView.editRevision,
              force: false,
              name: "Planning",
              viewId: listView.id,
            },
          },
        }),
      ),
    );
  });

  test("keeps settings and Row details independent and restores focus", async () => {
    const onCopyRowLink = vi.fn(async () => true);
    const onRowDetailChange = vi.fn();
    const { workbench } = renderDatabaseViewHost({
      activeViewId: listView.id,
      contextPanelOpen: true,
      layout: "page",
      onCopyRowLink,
      onRowDetailChange,
      record: p9gRecord,
      rows: p9gRows,
    });
    const surface = await screen.findByTestId(
      "context-surface-database-settings",
    );
    expect(
      within(surface).getByTestId("database-workbench-context"),
    ).not.toBeNull();

    const listRow = within(
      within(screen.getByTestId("database-list-view")).getAllByTestId(
        "database-list-row",
      )[0]!,
    );
    const trigger = listRow.getByRole("button", {
      name: "Initial task: Open details",
    });
    trigger.focus();
    fireEvent.click(trigger);

    expect(
      within(surface).getByTestId("database-workbench-context"),
    ).not.toBeNull();
    const detail = await screen.findByTestId("database-row-detail-content");
    expect(screen.getByTestId("database-row-detail-peek")).not.toBeNull();
    expect(
      document.querySelectorAll(
        '[data-testid="context-surface-database-settings"]',
      ),
    ).toHaveLength(1);
    expect(detail.querySelectorAll(".mantine-Card-root")).toHaveLength(0);
    expect(onRowDetailChange).toHaveBeenCalledWith(p9gRows[0]!.row.id);

    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByTestId(
        "database-row-action-menu",
      ),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() =>
      expect(onCopyRowLink).toHaveBeenCalledWith(
        p9gRows[0]!.row.id,
        listView.id,
      ),
    );

    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByRole(
        "button",
        { name: "Close" },
      ),
    );

    await waitFor(() =>
      expect(
        within(surface).getByTestId("database-workbench-context"),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(workbench.contextPanelOpen$.value).toBe(true);
    expect(onRowDetailChange).toHaveBeenLastCalledWith(null);
  });

  test("shows localized required-field feedback for an incomplete draft Row", async () => {
    const requiredNotes = { ...notesField, required: true };
    const incompleteRow = {
      ...p9gRows[0]!,
      cells: p9gRows[0]!.cells.filter((cell) => cell.fieldId !== notesField.id),
      cellRevisions: p9gRows[0]!.cellRevisions.filter(
        (cell) => cell.fieldId !== notesField.id,
      ),
    };
    renderDatabaseViewHost({
      activeViewId: listView.id,
      layout: "page",
      record: {
        ...p9gRecord,
        fields: p9gRecord.fields.map((field) =>
          field.id === notesField.id ? requiredNotes : field,
        ),
      },
      rows: [incompleteRow],
    });

    fireEvent.click(
      within(screen.getByTestId("database-list-view")).getByRole("button", {
        name: "Initial task: Open details",
      }),
    );
    const detail = await screen.findByTestId("database-row-detail-content");
    fireEvent.click(
      within(detail).getByRole("button", { name: "1 more property" }),
    );
    expect(
      within(detail).getByTestId("database-required-field-error").textContent,
    ).toBe("Required");
  });

  test("returns a Row opened from a closed Card to the closed state", async () => {
    const { workbench } = renderDatabaseViewHost({
      activeViewId: listView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });
    expect(workbench.contextPanelOpen$.value).toBe(false);
    const trigger = within(
      within(screen.getByTestId("database-list-view")).getAllByTestId(
        "database-list-row",
      )[0]!,
    ).getByRole("button", { name: "Initial task: Open details" });
    fireEvent.click(trigger);
    fireEvent.click(
      within(await screen.findByTestId("database-row-detail-peek")).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await waitFor(() => expect(workbench.contextPanelOpen$.value).toBe(false));
    expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
    expect(screen.queryByTestId("database-workbench-context")).toBeNull();
  });

  test("keeps Row detail active across View changes without changing the active View on close", async () => {
    const onActiveViewChange = vi.fn();
    const { rerender } = renderDatabaseViewHost({
      activeViewId: listView.id,
      contextPanelOpen: true,
      layout: "page",
      onActiveViewChange,
      record: p9gRecord,
      rows: p9gRows,
    });
    const origin = within(
      within(screen.getByTestId("database-list-view")).getAllByTestId(
        "database-list-row",
      )[0]!,
    ).getByRole("button", { name: "Initial task: Open details" });
    origin.focus();
    fireEvent.click(origin);
    await screen.findByTestId("database-row-detail-content");

    const gallery = p9gRecord.views.find(
      (view) => view.viewKind === DatabaseViewKind.Gallery,
    )!;
    rerender(p9gRecord, p9gRows, gallery.id);
    expect(screen.getByTestId("database-row-detail-content")).not.toBeNull();
    const close = within(
      screen.getByTestId("database-row-detail-peek"),
    ).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);

    expect(onActiveViewChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("database-active-view-menu-trigger"),
      ),
    );
  });

  test.each(["missing", "forbidden", "unavailable"] as const)(
    "renders an explicit %s deep-linked Row state in the Workbench Card",
    async (initialRowLoadState) => {
      renderDatabaseViewHost({
        initialRowId: "unavailable-row",
        initialRowLoadState,
        // The outside-window query is authoritative once it completes.
        gql: ({ query }) => {
          if (query !== databaseRowQuery) return {};
          if (initialRowLoadState === "missing")
            return { workspace: { databaseRow: null } };
          throw new Error(
            initialRowLoadState === "forbidden"
              ? "MIX_DATABASE_FORBIDDEN"
              : "Row service unavailable",
          );
        },
        layout: "page",
        record: p9gRecord,
        rows: p9gRows,
      });
      expect(
        await screen.findByTestId(`database-row-detail-${initialRowLoadState}`),
      ).not.toBeNull();
      expect(screen.getByTestId("database-row-detail-peek")).not.toBeNull();
    },
  );

  test.each(["forbidden"] as const)(
    "a current %s route answer hides the warm window Row instead of keeping its editable body",
    async (state) => {
      const options: NonNullable<Parameters<typeof renderDatabaseViewHost>[0]> =
        {
          activeViewId: listView.id,
          initialRowId: p9gRows[0]!.row.id,
          initialRowLoadState: null,
          record: p9gRecord,
          rows: p9gRows,
          layout: "page",
        };
      const { rerender } = renderDatabaseViewHost(options);
      const detail = await screen.findByTestId("database-row-detail-content");
      expect(detail.textContent).toContain("Initial task");
      expect(
        within(detail).getByRole("button", { name: titleField.name })
          .textContent,
      ).toContain("Initial task");
      options.initialRowLoadState = state;
      rerender(p9gRecord, p9gRows);
      await screen.findByTestId(`database-row-detail-${state}`);
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
      const peek = within(screen.getByTestId("database-row-detail-peek"));
      expect(peek.queryByText("Initial task")).toBeNull();
      expect(peek.queryByRole("textbox", { name: titleField.name })).toBeNull();
    },
  );

  test.each(["forbidden"] as const)(
    "a warm canonical Row read becoming %s wins before a delayed stale page arrives",
    async (state) => {
      let readAgain = false;
      let reject!: (error: Error) => void;
      const options: NonNullable<Parameters<typeof renderDatabaseViewHost>[0]> =
        {
          activeViewId: listView.id,
          initialRowId: p9gRows[0]!.row.id,
          initialRowLoadState: "loading",
          record: p9gRecord,
          rows: [],
          layout: "embedded",
          gql: ({ query }) => {
            if (query !== databaseRowQuery) return {};
            if (!readAgain) return { workspace: { databaseRow: p9gRows[0]! } };
            return new Promise((_resolve, fail) => {
              reject = fail;
            });
          },
        };
      const { gql, rerender } = renderDatabaseViewHost(options);
      const detail = await screen.findByTestId("database-row-detail-content");
      expect(detail.textContent).toContain("Initial task");
      readAgain = true;
      act(() =>
        emitDatabasePresenceChange({
          kind: "row_deleted",
          target: { rowId: p9gRows[0]!.row.id },
        }),
      );
      await waitFor(() =>
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === databaseRowQuery,
          ),
        ).toHaveLength(2),
      );
      expect(screen.getByTestId("database-row-detail-content")).toBe(detail);
      await act(async () => {
        reject(new Error("MIX_DATABASE_FORBIDDEN"));
      });
      await screen.findByTestId(`database-row-detail-${state}`);
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
      // Page's canonical linked-Row result arrives before its older inventory read.
      options.initialRowLoadState = state;
      rerender(p9gRecord, p9gRows);
      expect(screen.getByTestId(`database-row-detail-${state}`)).not.toBeNull();
      expect(
        within(screen.getByTestId("database-row-detail-peek")).queryByText(
          "Initial task",
        ),
      ).toBeNull();
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
    },
  );

  test("keeps the same dirty Row control across a transient canonical read failure", async () => {
    let failing = false;
    const { gql } = renderDatabaseViewHost({
      activeViewId: listView.id,
      initialRowId: p9gRows[0]!.row.id,
      initialRowLoadState: "loading",
      record: p9gRecord,
      rows: [],
      layout: "embedded",
      gql: ({ query }) => {
        if (query !== databaseRowQuery) return {};
        if (failing) throw new Error("Row transport unavailable");
        return { workspace: { databaseRow: p9gRows[0]! } };
      },
    });
    const detail = await screen.findByTestId("database-row-detail-content");
    fireEvent.click(
      within(detail).getByRole("button", { name: titleField.name }),
    );
    const input = within(detail).getByRole("textbox", {
      name: titleField.name,
    });
    fireEvent.change(input, {
      target: { value: "Unsaved current-owner title" },
    });
    input.focus();
    failing = true;
    await act(async () =>
      emitDatabasePresenceChange({
        kind: "row_updated",
        target: { rowId: p9gRows[0]!.row.id },
      }),
    );
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === databaseRowQuery,
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByTestId("database-row-detail-content")).toBe(detail);
    expect(within(detail).getByRole("textbox", { name: titleField.name })).toBe(
      input,
    );
    expect((input as HTMLInputElement).value).toBe(
      "Unsaved current-owner title",
    );
    expect(document.activeElement).toBe(input);
  });

  test("keeps shared Database settings read-only for row editors without manager rights", async () => {
    renderDatabaseViewHost({
      effectiveState: { canEditShared: false, canEditRows: true },
      layout: "page",
      record,
      rows,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View settings",
      }),
    );
    const context = await screen.findByTestId("database-workbench-context");
    expect(
      within(context)
        .getByRole("button", { name: "Save" })
        .hasAttribute("disabled"),
    ).toBe(true);
    const databaseSettings = within(context).getByTestId(
      "database-context-database-settings",
    );
    fireEvent.click(
      within(databaseSettings).getByRole("button", { name: "Fields" }),
    );
    const fieldSettings = await within(databaseSettings).findByRole("button", {
      name: "Field settings: Name",
    });
    expect(fieldSettings.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(fieldSettings);
    expect(screen.queryByTestId("database-field-settings-modal")).toBeNull();
    expect(
      within(context).queryByRole("button", { name: "Save · View" }),
    ).toBeNull();
  });

  test("keeps personal reset and save-to-shared on their authoritative mutations", async () => {
    const personalState = {
      collapsedGroupKeys: ["status:todo"],
      editRevision: 4,
      fieldWidthOverrides: [{ fieldId: notesField.id, width: 280 }],
      filterTree: null,
      searchText: "private search",
      sort: [
        {
          direction: DatabaseSortDirection.Desc,
          fieldId: titleField.id,
        },
      ],
      updatedAt: TIMESTAMP,
      viewId: tableView.id,
    };
    const { gql } = renderDatabaseViewHost({
      effectiveState: {
        effectiveFieldWidths: personalState.fieldWidthOverrides,
        effectiveSort: personalState.sort,
        personalState,
        searchText: personalState.searchText,
      },
      layout: "page",
      record,
      rows,
    });

    fireEvent.click(screen.getByRole("button", { name: "View settings" }));
    const context = await screen.findByTestId("database-workbench-context");
    expect(
      within(context).getByText("Personal · View settings").textContent,
    ).toBe("Personal · View settings");

    fireEvent.click(
      within(context).getByRole("button", { name: "Save · View" }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          mutation: saveDatabaseViewUserStateMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              expectedViewEditRevision: tableView.editRevision,
              viewId: tableView.id,
            },
          },
        }),
      ),
    );
    expect(within(context).getByText("Saved").textContent).toBe("Saved");

    fireEvent.click(
      within(context).getByRole("button", { name: "Reset · Personal" }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          mutation: resetDatabaseViewUserStateMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              expectedEditRevision: personalState.editRevision,
              viewId: tableView.id,
            },
          },
        }),
      ),
    );
  });

  test("keeps a single view protected and exposes exactly its implemented commands", async () => {
    const user = userEvent.setup();
    const onCopyViewLink = vi.fn(async () => true);
    renderDatabaseViewHost({
      layout: "page",
      onCopyViewLink,
      record,
      rows,
    });

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(
      screen
        .getByTestId("database-view-create-trigger")
        .getAttribute("aria-label"),
    ).toBe("Add view");
    expect(screen.queryByText("Automations")).toBeNull();
    expect(screen.queryByTestId("database-view-actions-trigger")).toBeNull();

    const tab = screen.getByRole("tab", { name: tableView.name });
    tab.focus();
    await user.tab();
    const actions = screen.getByRole("button", {
      name: `View actions: ${tableView.name}`,
    });
    expect(document.activeElement).toBe(actions);
    await user.keyboard(" ");
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Copy link", "Delete view"]);
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Delete view" })
        .getAttribute("data-disabled"),
    ).not.toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    await waitFor(() =>
      expect(onCopyViewLink).toHaveBeenCalledWith(tableView.id),
    );
    await waitFor(() => expect(document.activeElement).toBe(actions));

    await user.tab();
    const create = screen.getByTestId("database-view-create-trigger");
    expect(document.activeElement).toBe(create);
    await user.keyboard("[Enter]");
    expect(
      (await screen.findByRole("menuitem", { name: "Add table view" }))
        .textContent,
    ).toBe("Add table view");
  });

  test("creates and activates a view from the plus control", async () => {
    const createdView = {
      ...listView,
      id: "view-created-list",
      position: 1,
    };
    const gql = vi.fn(async ({ query }) =>
      query === createDatabaseViewMutation
        ? { createDatabaseView: createdView }
        : {},
    );
    const { onActiveViewChange, onChanged } = renderDatabaseViewHost({
      gql,
      layout: "page",
      record,
      rows,
    });

    fireEvent.click(screen.getByTestId("database-view-create-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add list view" }),
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: record.database.id,
              viewKind: DatabaseViewKind.List,
            }),
          },
        }),
      ),
    );
    expect(onActiveViewChange).toHaveBeenCalledWith(createdView.id);
    expect(onChanged).toHaveBeenCalled();
  });

  test("renames and deletes the active View with revision preconditions", async () => {
    const { gql, onActiveViewChange, onChanged } = renderDatabaseViewHost({
      activeViewId: tableView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });

    let actions = activeViewActions();
    fireEvent.click(actions);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const renameDialog = await screen.findByTestId(
      "database-view-rename-modal",
    );
    const renameInput = within(renameDialog).getByRole("textbox", {
      name: "Rename",
    });
    fireEvent.change(renameInput, { target: { value: "Planning" } });
    fireEvent.click(
      within(renameDialog).getByTestId("database-view-rename-submit"),
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              expectedEditRevision: tableView.editRevision,
              force: false,
              name: "Planning",
              viewId: tableView.id,
            },
          },
        }),
      ),
    );
    await waitFor(() => expect(renameDialog.isConnected).toBe(false));

    actions = activeViewActions();
    fireEvent.click(actions);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete view" }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: deleteDatabaseViewMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              expectedEditRevision: tableView.editRevision,
              force: false,
              viewId: tableView.id,
            },
          },
        }),
      ),
    );
    expect(onActiveViewChange).toHaveBeenCalledWith(listView.id);
    expect(onChanged).toHaveBeenCalled();
  });

  test("sends the complete ordered list with every revision baseline", async () => {
    const user = userEvent.setup();
    const { gql } = renderDatabaseViewHost({
      activeViewId: tableView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });
    const tableTab = screen.getByTestId(`database-view-tab-${tableView.id}`);

    await user.click(tableTab);
    fireEvent.keyDown(tableTab, {
      altKey: true,
      key: "ArrowRight",
      shiftKey: true,
    });
    const expectedOrder = [
      listView.id,
      tableView.id,
      ...p9gRecord.views.slice(2).map((view) => view.id),
    ];
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: reorderDatabaseViewsMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              expectedEditRevisions: p9gRecord.views.map((view) => ({
                expectedEditRevision: view.editRevision,
                viewId: view.id,
              })),
              force: false,
              viewIds: expectedOrder,
            },
          },
        }),
      ),
    );
  });

  test("shows the optimistic order while the reorder mutation is pending", async () => {
    let resolveReorder!: (value: {
      reorderDatabaseViews: typeof p9gRecord.views;
    }) => void;
    const reorderResponse = new Promise<{
      reorderDatabaseViews: typeof p9gRecord.views;
    }>((resolve) => {
      resolveReorder = resolve;
    });
    const gql = vi.fn(async ({ query }) => {
      if (query === reorderDatabaseViewsMutation) return reorderResponse;
      return {};
    });
    renderDatabaseViewHost({
      activeViewId: tableView.id,
      gql,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });
    const expectedOrder = [
      listView.name,
      tableView.name,
      ...p9gRecord.views.slice(2).map((view) => view.name),
    ];

    fireEvent.keyDown(screen.getByTestId(`database-view-tab-${tableView.id}`), {
      altKey: true,
      key: "ArrowRight",
      shiftKey: true,
    });

    await waitFor(() => expect(orderedTabNames()).toEqual(expectedOrder));
    resolveReorder({ reorderDatabaseViews: p9gRecord.views });
    await waitFor(() =>
      expect(orderedTabNames()).toEqual(
        p9gRecord.views.map((view) => view.name),
      ),
    );
  });

  test("restores server order after a failed reorder", async () => {
    const failure = new Error("reorder unavailable");
    const failingGql = vi.fn(async ({ query }) => {
      if (query === reorderDatabaseViewsMutation) throw failure;
      return {};
    });
    renderDatabaseViewHost({
      activeViewId: tableView.id,
      gql: failingGql,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });
    const initialOrder = orderedTabNames();
    const failingTableTab = screen.getByTestId(
      `database-view-tab-${tableView.id}`,
    );
    fireEvent.keyDown(failingTableTab, {
      altKey: true,
      key: "ArrowRight",
      shiftKey: true,
    });
    await waitFor(() =>
      expect(failingGql).toHaveBeenCalledWith(
        expect.objectContaining({ query: reorderDatabaseViewsMutation }),
      ),
    );
    await waitFor(() => expect(orderedTabNames()).toEqual(initialOrder));
  });
});

test("Project child Add/Open/Back uses the same Drawer and preserves its original list trigger and View", async () => {
  const parent = {
    ...p9gRows[0]!,
    row: { ...p9gRows[0]!.row, rowKind: "task", contentDocument: null },
  };
  const child = {
    ...parent,
    row: {
      ...parent.row,
      id: "outside-child",
      title: "Child outside the View window",
    },
  };
  const childRows = [child];
  const parentField = {
    ...relationField,
    name: "Parent Task",
    config: {
      ...relationField.config,
      relation: {
        targetDatabaseId: "database-1",
        allowMultiple: false,
        maxTargets: 1,
        reciprocalFieldId: null,
      },
    },
  };
  const project = {
    ...p9gRecord,
    database: {
      ...p9gRecord.database,
      profileKind: DatabaseProfileKind.Project,
    },
    fields: [titleField, parentField],
    fieldRoles: [
      {
        databaseId: "database-1",
        profileKind: DatabaseProfileKind.Project,
        roleKey: "task.parent",
        rowKindScope: "task",
        fieldId: parentField.id,
        required: false,
        config: {},
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
  };
  const onRowDetailChange = vi.fn();
  const { gql } = renderDatabaseViewHost({
    activeViewId: listView.id,
    layout: "page",
    record: readyManagedRecord(project),
    rows: [parent],
    onRowDetailChange,
    gql: (request) => {
      const { query, variables } = request as {
        query: unknown;
        variables: {
          rowId?: string;
          context?: AssistantContext;
          input?: { title: string; cells: unknown[] };
        };
      };
      const row =
        variables?.rowId === parent.row.id
          ? parent
          : childRows.find(
              (candidate) => candidate.row.id === variables?.rowId,
            );
      const assistant = assistantQueryFixture(
        query,
        variables,
        readyManagedRecord(project),
        row ?? parent,
      );
      if (assistant) return assistant;
      if (query === databaseRowQuery)
        return { workspace: { databaseRow: row } };
      if (query === databaseTaskParentQuery)
        return {
          workspace: {
            id: "workspace-1",
            databaseRow: {
              row: {
                id: row!.row.id,
                databaseId: "database-1",
                taskParent: {
                  available: true,
                  fieldId: parentField.id,
                  parentRowIds: [],
                  diagnostics: [],
                },
              },
            },
          },
        };
      if (query === databaseTaskChildrenQuery)
        return {
          workspace: {
            id: "workspace-1",
            databaseRow: {
              row: {
                id: row!.row.id,
                databaseId: "database-1",
                taskChildren: {
                  available: true,
                  fieldId: parentField.id,
                  diagnostics: [],
                  rows:
                    row === parent
                      ? childRows.map((item) => ({
                          workspaceId: "workspace-1",
                          databaseId: "database-1",
                          rowId: item.row.id,
                          title: item.row.title,
                          projectTitle: "Project",
                          editRevision: 1,
                          updatedAt: TIMESTAMP,
                          deletedAt: null,
                          status: null,
                          assignees: [],
                          due: null,
                          priority: null,
                          hasAssignees: false,
                          hasDue: false,
                          hasPriority: false,
                          canEdit: true,
                        }))
                      : [],
                  totalCount: row === parent ? childRows.length : 0,
                  completeCount: 0,
                  archivedCount: 0,
                  nextCursor: null,
                },
              },
            },
          },
        };
      if (query === databaseTaskReferencesQuery)
        return { workspace: { id: "workspace-1", databaseTaskReferences: [] } };
      if (query === createDatabaseRowMutation) {
        expect(variables.input!.cells).toEqual([
          { fieldId: parentField.id, value: { relation: [parent.row.id] } },
        ]);
        const created = {
          ...child,
          row: {
            ...child.row,
            id: "project-new-child",
            title: variables.input!.title,
          },
        };
        childRows.push(created);
        return { createDatabaseRow: { row: { id: created.row.id } } };
      }
      return {};
    },
  });
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", {
    name: "Initial task: Open details",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  const drawer = await screen.findByTestId("database-row-detail-peek");
  const section = await screen.findByTestId("database-task-relations");
  await user.click(
    within(drawer).getByRole("button", { name: "Task actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Add subtask" }));
  const title = await within(section).findByRole("textbox", {
    name: assistantPackagesFixture(AssistantContext.TaskSubtask)[0].inputs.find(
      (input) => input.target === AssistantInputTarget.Title,
    )!.label.en,
  });
  title.focus();
  fireEvent.change(title, { target: { value: "Project child via Enter" } });
  await user.keyboard("{Enter}");
  const created = await within(section).findByRole("button", {
    name: "Project child via Enter",
  });
  await waitFor(() => expect(document.activeElement).toBe(created));
  await user.click(created);
  await waitFor(() =>
    expect(onRowDetailChange).toHaveBeenLastCalledWith("project-new-child"),
  );
  await waitFor(() =>
    expect(
      within(drawer).getByRole("button", { name: "Title" }).textContent,
    ).toContain("Project child via Enter"),
  );
  expect(screen.getByTestId("database-row-detail-peek")).toBe(drawer);
  expect(screen.getAllByTestId("database-row-detail-content")).toHaveLength(1);
  await user.click(within(drawer).getByRole("button", { name: "Back" }));
  const returned = await screen.findByRole("button", {
    name: "Project child via Enter",
  });
  await waitFor(() => expect(document.activeElement).toBe(returned));
  expect(onRowDetailChange).toHaveBeenLastCalledWith(parent.row.id);
  expect(screen.getByTestId("database-row-detail-peek")).toBe(drawer);
  expect(
    gql.mock.calls.filter(
      ([request]) => request.query === createDatabaseRowMutation,
    ),
  ).toHaveLength(1);
  await user.click(within(drawer).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(onRowDetailChange).toHaveBeenLastCalledWith(null);
  expect(
    screen
      .getByRole("tab", { name: listView.name })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("two editors observing absent personal state both fence their first search with revision zero", async () => {
  const searchableRecord = {
    ...record,
    views: [
      {
        ...tableView,
        config: {
          ...tableView.config,
          table: {
            ...tableView.config.table!,
            searchFieldIds: [titleField.id],
          },
        },
      },
    ],
  };
  const first = renderDatabaseViewHost({ record: searchableRecord, rows });
  const second = renderDatabaseViewHost({ record: searchableRecord, rows });
  const searches = screen.getAllByTestId("database-table-search");
  expect(searches).toHaveLength(2);
  fireEvent.change(searches[0]!, { target: { value: "first private search" } });
  fireEvent.blur(searches[0]!);
  fireEvent.change(searches[1]!, {
    target: { value: "second private search" },
  });
  fireEvent.blur(searches[1]!);
  for (const owner of [first, second]) {
    await waitFor(() =>
      expect(owner.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: upsertDatabaseViewUserStateMutation,
          variables: {
            input: expect.objectContaining({ expectedEditRevision: 0 }),
          },
        }),
      ),
    );
  }
  expect(first.personalStateAcknowledgements).toHaveLength(1);
  const acknowledgedRevision = first.personalStateAcknowledgements[0]!;
  expect(acknowledgedRevision).toBeGreaterThan(0);
  fireEvent.change(searches[0]!, { target: { value: "next private search" } });
  fireEvent.blur(searches[0]!);
  await waitFor(() =>
    expect(first.gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: upsertDatabaseViewUserStateMutation,
        variables: {
          input: expect.objectContaining({
            expectedEditRevision: acknowledgedRevision,
          }),
        },
      }),
    ),
  );
});
