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
  AssistantNativeActionKind,
  createDatabaseFieldMutation,
  createDatabaseRowFromTemplateMutation,
  createDatabaseRowMutation,
  createDatabaseViewMutation,
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseStatusGroup,
  DatabaseViewKind,
  deleteDatabaseRowMutation,
  updateDatabaseCellValueMutation,
  updateDatabaseRowPositionMutation,
  updateDatabaseViewMutation,
} from "@myoxus/graphql";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { LiveData } from "@myoxus/infra";

import {
  dueField,
  field,
  kanbanRecord,
  kanbanRichRecord,
  kanbanRichView,
  kanbanRows,
  kanbanRowsWithUnassigned,
  kanbanView,
  largeKanbanRows,
  notesField,
  p9gRecord,
  p9gRows,
  record,
  rowTemplates,
  scoreField,
  statusField,
  tableView,
  titleField,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import {
  type DatabaseField,
  type DatabaseRecord,
  type DatabaseView,
} from "../types";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

describe("Database Kanban view", () => {
  test("renders Users through the shared authorized public-user display instead of raw IDs", async () => {
    const assignees = field(
      "task-assignees",
      DatabaseFieldKind.Users,
      "Assignees",
      10,
    );
    const assigned = {
      ...kanbanRows[0]!,
      cells: [
        ...kanbanRows[0]!.cells,
        {
          ...kanbanRows[0]!.cells[0]!,
          fieldId: assignees.id,
          fieldType: DatabaseFieldKind.Users,
          value: {
            ...kanbanRows[0]!.cells[0]!.value,
            kind: DatabaseFieldKind.Users,
            users: ["private-user-id"],
          },
        },
      ],
    };
    const view = {
      ...kanbanView,
      config: {
        ...kanbanView.config,
        kanban: {
          ...kanbanView.config.kanban!,
          visibleFieldIds: [titleField.id, assignees.id],
        },
      },
    };
    renderDatabaseViewHost({
      activeViewId: view.id,
      rows: [assigned],
      record: {
        ...kanbanRecord,
        fields: [...kanbanRecord.fields, assignees],
        views: [view],
      },
      publicUserService: {
        publicUser$: () =>
          new LiveData({ name: "Myoxus Admin", avatarUrl: null }),
        isLoading$: () => new LiveData(false),
        revalidate: vi.fn(),
      },
    });
    expect(await screen.findByText("Myoxus Admin")).toBeTruthy();
    expect(screen.queryByText("private-user-id")).toBeNull();
  });

  test("moves a kanban card to the next column via keyboard arrow-right on the drag handle", async () => {
    const gql = vi.fn(async ({ query }) =>
      query === updateDatabaseCellValueMutation
        ? { updateDatabaseCellValue: {} }
        : query === updateDatabaseRowPositionMutation
          ? { updateDatabaseRowPosition: {} }
          : {},
    );
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      gql,
      record: kanbanRecord,
      rows: kanbanRows,
    });

    const todoFirstCard = screen
      .getByText("Todo first")
      .closest("[data-testid='database-kanban-card']") as HTMLElement;
    expect(todoFirstCard).not.toBeNull();
    const handle = within(todoFirstCard).getByRole("button", {
      name: "Drag row",
    });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.getAttribute("aria-label")).toBe("Drag row");

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: "field-status",
              force: false,
              rowId: "todo-1",
              value: { select: "doing" },
            },
          },
        }),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowPositionMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              force: false,
              position: 7,
              rowId: "todo-1",
            },
          },
        }),
      );
    });
  });

  test("clamps kanban keyboard move at the rightmost column", async () => {
    const { gql } = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRowsWithUnassigned,
    });

    const unassignedCard = screen
      .getByText("Unassigned first")
      .closest("[data-testid='database-kanban-card']") as HTMLElement;
    expect(unassignedCard).not.toBeNull();
    const handle = within(unassignedCard).getByRole("button", {
      name: "Drag row",
    });
    handle.focus();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(gql).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: updateDatabaseCellValueMutation,
      }),
    );
  });

  test("creates a row with the owning column status", async () => {
    const { gql } = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRows,
    });

    const buttons = await screen.findAllByTestId("database-kanban-column-new");
    const doing = buttons.find((node) =>
      node.getAttribute("aria-label")?.includes("Doing"),
    );
    expect(doing).toBeDefined();
    fireEvent.click(doing!);

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              databaseId: kanbanRecord.database.id,
              cells: expect.arrayContaining([
                expect.objectContaining({
                  fieldId: statusField.id,
                }),
              ]),
            }),
          }),
        }),
      ),
    );
  });

  test("exposes exactly one bottom add-task action per column", async () => {
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRows,
    });

    const columns = await screen.findAllByTestId("database-kanban-column");
    for (const column of columns) {
      expect(
        within(column).getAllByRole("button", { name: /Add task to/ }),
      ).toHaveLength(1);
    }
    expect(screen.queryByTestId("database-kanban-global-add-task")).toBeNull();
    expect(screen.queryByTestId("database-kanban-column-add-task")).toBeNull();
    expect(screen.getByRole("button", { name: "Add column" })).toBeInstanceOf(
      HTMLButtonElement,
    );
    fireEvent.click(screen.getAllByTestId("database-kanban-column-menu")[0]!);
    expect(screen.queryByRole("menuitem", { name: "Add task" })).toBeNull();
  });

  test("creates through the bottom action with the owning column status", async () => {
    const { gql } = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRows,
    });
    const buttons = await screen.findAllByTestId("database-kanban-column-new");
    const doing = buttons.find((node) =>
      node.getAttribute("aria-label")?.includes("Doing"),
    );
    fireEvent.click(doing!);

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              databaseId: kanbanRecord.database.id,
              cells: expect.arrayContaining([
                expect.objectContaining({ fieldId: statusField.id }),
              ]),
            }),
          }),
        }),
      ),
    );
  });

  test("applies the default row template with the owning column status", async () => {
    const { gql } = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rowTemplates,
      rows: kanbanRows,
    });

    const buttons = await screen.findAllByTestId("database-kanban-column-new");
    const doing = buttons.find((node) =>
      node.getAttribute("aria-label")?.includes("Doing"),
    );
    expect(doing).toBeDefined();
    fireEvent.click(doing!);

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowFromTemplateMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              databaseId: kanbanRecord.database.id,
              rowTemplateId: "row-template-default",
              overrideCellValues: expect.arrayContaining([
                expect.objectContaining({
                  fieldId: statusField.id,
                  value: { select: "doing" },
                }),
              ]),
            }),
          }),
        }),
      ),
    );
  });

  test("creates a draft directly when schema-required values are not populated yet", async () => {
    const requiredNotes = { ...notesField, required: true };
    const requiredRecord: DatabaseRecord = {
      ...kanbanRecord,
      fields: [titleField, requiredNotes, dueField, statusField, scoreField],
    };
    const { gql } = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: requiredRecord,
      rows: kanbanRows,
    });

    fireEvent.click(
      (await screen.findAllByTestId("database-kanban-column-new"))[0]!,
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              databaseId: kanbanRecord.database.id,
              cells: expect.arrayContaining([
                expect.objectContaining({
                  fieldId: statusField.id,
                  value: { select: "todo" },
                }),
              ]),
            }),
          }),
        }),
      ),
    );
    expect(screen.queryByText("Required")).toBeNull();
    expect(
      screen.queryByTestId("database-kanban-create-task-modal"),
    ).toBeNull();
  });

  test("uses the shared view toolbar instead of legacy Kanban diagnostics", async () => {
    renderDatabaseViewHost({
      activeViewId: kanbanRichView.id,
      record: kanbanRichRecord,
      rows: largeKanbanRows,
    });

    const sharedToolbar = await screen.findByTestId("database-view-toolbar");
    expect(
      within(sharedToolbar).getByRole("button", { name: "Filter" }),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      within(sharedToolbar).getByRole("button", {
        name: "Due · 1",
      }),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      within(sharedToolbar).getByRole("button", { name: "Grouping" }),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      within(sharedToolbar).getByRole("button", { name: "Fields" }),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      within(screen.getByTestId("database-kanban-toolbar")).queryByRole(
        "button",
        { name: "Add task" },
      ),
    ).toBeNull();
    const contextToolbar = screen.getByTestId("database-view-context-toolbar");
    expect(within(contextToolbar).queryByText("Only you")).toBeNull();
    expect(
      within(contextToolbar).queryByRole("button", { name: "View actions" }),
    ).toBeNull();
    expect(
      within(contextToolbar).queryByRole("button", { name: "Database menu" }),
    ).toBeNull();
    expect(
      within(sharedToolbar).queryByRole("button", { name: "View actions" }),
    ).toBeNull();
    expect(screen.queryByText("Kanban group field: Status")).toBeNull();
    expect(screen.queryByText("Sort field: Due")).toBeNull();
    expect(screen.queryByText("Visible fields: 5")).toBeNull();
    expect(screen.queryByText("View settings")).toBeNull();
    expect(screen.queryByText("Card display")).toBeNull();
  });

  test("opens Kanban task details from card click and keyboard with focus return", async () => {
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRows,
    });

    const card = (await screen.findAllByTestId("database-kanban-card"))[0]!;
    card.focus();
    fireEvent.click(card);
    let details = await screen.findByTestId("database-row-detail-content");
    fireEvent.click(within(details).getByRole("button", { name: "Details" }));
    expect(within(details).getByText("Status")).toBeInstanceOf(HTMLElement);
    expect(
      within(screen.getByTestId("database-row-detail-peek")).getAllByRole(
        "button",
        { name: "Name" },
      ),
    ).toHaveLength(1);

    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(card));

    fireEvent.keyDown(card, { key: "Enter" });
    details = await screen.findByTestId("database-row-detail-content");
    expect(details).toBeInstanceOf(HTMLElement);
    fireEvent.keyDown(details, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull(),
    );
  });

  test("keeps page View settings independent while opening the shared Detail Peek", async () => {
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      layout: "page",
      record: kanbanRecord,
      rows: kanbanRows,
    });

    fireEvent.click(screen.getByTestId("database-context-settings-trigger"));
    expect(
      await screen.findByTestId("database-workbench-context"),
    ).not.toBeNull();
    fireEvent.click((await screen.findAllByTestId("database-kanban-card"))[0]!);
    expect(
      await screen.findByTestId("database-row-detail-peek"),
    ).not.toBeNull();
    expect(screen.getByTestId("database-workbench-context")).not.toBeNull();
  });

  test("keeps every Kanban mutation unavailable for read-only actors", async () => {
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      effectiveState: { canEditShared: false, canEditRows: false },
      record: kanbanRecord,
      rows: kanbanRows,
    });

    expect(
      (await screen.findByTestId("database-kanban-read-only-notice"))
        .textContent,
    ).toContain("You don't have permission to add tasks to this database.");
    for (const button of screen.getAllByTestId("database-kanban-column-new")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.queryAllByLabelText("Drag row")).toHaveLength(0);
    const readonlyCard = screen.getAllByTestId("database-kanban-card")[0]!;
    expect(readonlyCard.getAttribute("role")).toBe("button");
    const readonlyTitle = readonlyCard.querySelector(
      '[data-myoxus-ui-role="inline-edit-display"]',
    );
    expect(readonlyTitle).toBeInstanceOf(HTMLElement);
    fireEvent.click(readonlyTitle!);
    expect(
      within(readonlyCard).queryByRole("textbox", { name: "Title" }),
    ).toBeNull();

    fireEvent.click(screen.getAllByTestId("database-row-action-menu")[0]!);
    expect(screen.queryByRole("menuitem", { name: "Remove row" })).toBeNull();
    expect(
      await screen.findByRole("menuitem", { name: "Open details" }),
    ).toBeInstanceOf(HTMLElement);
  });

  test("keeps row creation available in an empty column", async () => {
    const rowsWithoutDoing = kanbanRows.filter((row) => {
      const statusCell = row.cells.find((c) => c.fieldId === statusField.id);
      const optId =
        statusCell?.value && "optionId" in statusCell.value
          ? statusCell.value.optionId
          : undefined;
      return optId !== "doing";
    });

    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: rowsWithoutDoing,
    });

    const emptyCtas = await screen.findAllByTestId("database-kanban-empty-cta");
    expect(emptyCtas.length).toBeGreaterThan(0);
  });

  test("uses Project roles for direct card editing and the read-only progress meter", async () => {
    const descriptionField = {
      ...notesField,
      id: "field-project-description",
      name: "Description",
      fieldType: DatabaseFieldKind.RichText,
      config: {
        ...notesField.config,
        kind: DatabaseFieldKind.RichText,
        richText: { maxPlainTextBytes: null },
        text: null,
      },
    } as DatabaseField;
    const progressField = {
      ...scoreField,
      id: "field-project-progress",
      name: "Progress",
      fieldType: DatabaseFieldKind.Percent,
      config: {
        ...scoreField.config,
        kind: DatabaseFieldKind.Percent,
        number: null,
        percent: { minValue: 0, maxValue: 100 },
      },
    } as DatabaseField;
    const projectView = {
      ...kanbanView,
      config: {
        ...kanbanView.config,
        kanban: {
          ...kanbanView.config.kanban!,
          visibleFieldIds: [
            titleField.id,
            descriptionField.id,
            statusField.id,
            progressField.id,
          ],
        },
      },
    };
    const projectRecord = {
      ...kanbanRecord,
      database: {
        ...kanbanRecord.database,
        profileKind: DatabaseProfileKind.Project,
      },
      fields: [titleField, descriptionField, statusField, progressField],
      fieldRoles: [
        ["task.title", titleField.id],
        ["task.description", descriptionField.id],
        ["task.status", statusField.id],
        ["task.progress", progressField.id],
      ].map(([roleKey, fieldId]) => ({
        databaseId: "database-1",
        profileKind: DatabaseProfileKind.Project,
        roleKey: roleKey!,
        rowKindScope: "task",
        fieldId: fieldId!,
        required: true,
        config: {},
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      })),
      views: [projectView],
    } as DatabaseRecord;
    const projectRows = [
      {
        ...kanbanRows[0]!,
        row: { ...kanbanRows[0]!.row, rowKind: "task" },
        cells: [
          ...kanbanRows[0]!.cells,
          {
            ...kanbanRows[0]!.cells[0]!,
            fieldId: descriptionField.id,
            fieldType: DatabaseFieldKind.RichText,
            value: {
              ...kanbanRows[0]!.cells[0]!.value,
              kind: DatabaseFieldKind.RichText,
              richText: {
                document: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Project brief" }],
                    },
                  ],
                },
                plainText: "Project brief",
              },
              text: null,
            },
          },
          {
            ...kanbanRows[0]!.cells[0]!,
            fieldId: progressField.id,
            fieldType: DatabaseFieldKind.Percent,
            value: {
              ...kanbanRows[0]!.cells[0]!.value,
              kind: DatabaseFieldKind.Percent,
              percent: 65,
              text: null,
            },
          },
        ],
      },
      {
        ...kanbanRows[1]!,
        row: {
          ...kanbanRows[1]!.row,
          id: "phase-1",
          rowKind: "phase",
          title: "Planning phase",
        },
        cells: kanbanRows[1]!.cells.map((cell) =>
          cell.fieldId === titleField.id
            ? {
                ...cell,
                value: {
                  ...cell.value,
                  title: "Planning phase",
                },
              }
            : cell,
        ),
      },
    ];

    renderDatabaseViewHost({
      activeViewId: projectView.id,
      record: readyManagedRecord(projectRecord),
      rows: projectRows,
    });

    const card = await screen.findByTestId("database-kanban-card");
    expect(screen.queryByText("Planning phase")).toBeNull();
    expect(screen.queryByText("Unassigned")).toBeNull();
    expect(within(card).getByText("Description")).not.toBeNull();
    expect(
      within(card)
        .getByRole("progressbar", { name: "Progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("65");
    expect(within(card).queryByRole("slider")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Title" }));
    expect(within(card).getByRole("textbox", { name: "Title" })).not.toBeNull();
    expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
    fireEvent.keyDown(within(card).getByRole("textbox", { name: "Title" }), {
      key: "Escape",
    });

    fireEvent.click(
      within(card).getByRole("button", { name: "Project brief" }),
    );
    expect(
      await within(card).findByTestId("database-rich-text-inline-editor"),
    ).not.toBeNull();
    expect(within(card).queryByRole("button", { name: "Drag row" })).toBeNull();
    fireEvent.click(card);
    expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
  });

  test("opens a List row in Side Peek before the attached document", async () => {
    const { onOpenDoc } = renderDatabaseViewHost({
      activeViewId: "view-list",
      record: p9gRecord,
      rows: p9gRows,
    });

    const firstRow = within(screen.getAllByTestId("database-list-row")[0]!);
    fireEvent.click(
      firstRow.getByRole("button", { name: "Initial task: Open details" }),
    );
    expect(
      await screen.findByTestId("database-row-detail-content"),
    ).toBeInstanceOf(HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Page content" }));
    expect(screen.getByTestId("database-row-content-editor").textContent).toBe(
      "doc-1",
    );
    fireEvent.click(
      await within(screen.getByTestId("database-row-detail-peek")).findByRole(
        "button",
        { name: "Open full page" },
      ),
    );
    expect(onOpenDoc).toHaveBeenCalledWith("doc-1");
    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByRole(
        "button",
        { name: "Close" },
      ),
    );
  });

  test("opens List row actions in Side Peek and removes the row", async () => {
    const { gql, onChanged } = renderDatabaseViewHost({
      activeViewId: "view-list",
      record: p9gRecord,
      rows: p9gRows,
    });

    const firstRow = within(screen.getAllByTestId("database-list-row")[0]!);
    const rowActionMenu = firstRow.getByTestId("database-row-action-menu");

    fireEvent.click(rowActionMenu);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open details" }),
    );
    expect(
      await screen.findByTestId("database-row-detail-content"),
    ).toBeInstanceOf(HTMLElement);
    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("database-row-detail-content")).toBeNull(),
    );

    fireEvent.click(rowActionMenu);
    expect(
      screen.queryByRole("menuitem", { name: "Open row document" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove row" }),
    );

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: deleteDatabaseRowMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              force: false,
              rowId: "row-1",
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("renders kanban columns with three ordered cards per status without exposing score", () => {
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: kanbanRecord,
      rows: kanbanRows,
    });

    for (const [columnLabel, titles] of [
      ["Todo", ["Todo first", "Todo second", "Todo third"]],
      ["Doing", ["Doing first", "Doing second", "Doing third"]],
      ["Done", ["Done first", "Done second", "Done third"]],
      ["Unassigned", []],
    ] as const) {
      const column = screen
        .getByText(columnLabel)
        .closest("[data-testid='database-kanban-column']");
      const cards = within(column as HTMLElement).queryAllByTestId(
        "database-kanban-card",
      );
      expect(cards.map((card) => card.textContent)).toEqual(
        titles.map((title) => expect.stringContaining(title)),
      );
    }

    expect(screen.queryByText("Score")).toBeNull();
    const firstCard = screen
      .getByText("Todo first")
      .closest("[data-testid='database-kanban-card']");
    expect(firstCard?.textContent).toContain("NotesKanban note Todo first");
    expect(
      within(firstCard as HTMLElement).queryByRole("textbox", { name: "Due" }),
    ).toBeNull();
    expect(
      within(firstCard as HTMLElement).queryByRole("spinbutton", {
        name: "Score",
      }),
    ).toBeNull();
  });

  test("adds kanban views only after an explicit grouping field mapping", async () => {
    const createdView = {
      ...kanbanView,
      id: "view-created-kanban",
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
      record: {
        ...record,
        fields: [titleField, notesField, statusField],
        views: [tableView],
      },
    });

    fireEvent.click(screen.getByTestId("database-view-create-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add kanban view" }),
    );

    const modal = await screen.findByTestId("database-kanban-setup");
    expect(
      within(modal).getByText("Kanban view needs a select field"),
    ).toBeTruthy();
    expect(gql).not.toHaveBeenCalled();

    fireEvent.click(
      within(modal).getByRole("button", { name: "Add kanban view" }),
    );

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              viewKind: DatabaseViewKind.Kanban,
              config: expect.objectContaining({
                kanban: expect.objectContaining({
                  groupFieldId: statusField.id,
                }),
              }),
            }),
          },
        }),
      );
    });
    expect(onActiveViewChange).toHaveBeenCalledWith(createdView.id);
    expect(onChanged).toHaveBeenCalled();
  });

  test("creates a semantic status grouping field from the kanban setup modal", async () => {
    const createdField: DatabaseField = {
      ...statusField,
      id: "field-workflow",
      name: "Status",
      position: 2,
      fieldType: DatabaseFieldKind.Status,
      config: {
        ...statusField.config,
        kind: DatabaseFieldKind.Status,
        select: null,
        status: {
          defaultOptionId: "status.todo",
          options: [
            {
              colorRole: "database.status.todo",
              group: DatabaseStatusGroup.NotStarted,
              id: "status.todo",
              name: "Todo",
              position: 0,
            },
            {
              colorRole: "database.status.inProgress",
              group: DatabaseStatusGroup.Active,
              id: "status.in_progress",
              name: "In progress",
              position: 1,
            },
            {
              colorRole: "database.status.done",
              group: DatabaseStatusGroup.Complete,
              id: "status.done",
              name: "Done",
              position: 2,
            },
          ],
        },
      },
    };
    const createdView = {
      ...kanbanView,
      id: "view-created-kanban",
      config: {
        ...kanbanView.config,
        kanban: {
          ...kanbanView.config.kanban!,
          groupFieldId: createdField.id,
        },
      },
      position: 1,
    };
    const gql = vi.fn(async ({ query }) => {
      if (query === createDatabaseFieldMutation) {
        return { createDatabaseField: createdField };
      }
      if (query === createDatabaseViewMutation) {
        return { createDatabaseView: createdView };
      }
      return {};
    });
    renderDatabaseViewHost({ gql, layout: "page" });

    fireEvent.click(screen.getByTestId("database-view-create-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add kanban view" }),
    );
    const modal = await screen.findByTestId("database-kanban-setup");
    fireEvent.click(
      within(modal).getByRole("button", { name: "Add kanban view" }),
    );

    await waitFor(() => {
      const fieldCall = gql.mock.calls.find(
        ([call]) => call.query === createDatabaseFieldMutation,
      )?.[0];
      expect(fieldCall).toEqual(
        expect.objectContaining({
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              fieldType: DatabaseFieldKind.Status,
              name: "Status",
            }),
          },
        }),
      );
      expect(fieldCall!.variables.input.config.status).toMatchObject({
        defaultOptionId: "status.todo",
        options: [
          expect.objectContaining({
            group: DatabaseStatusGroup.NotStarted,
            id: "status.todo",
          }),
          expect.objectContaining({
            group: DatabaseStatusGroup.Active,
            id: "status.in_progress",
          }),
          expect.objectContaining({
            group: DatabaseStatusGroup.Complete,
            id: "status.done",
          }),
        ],
      });
    });
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: expect.objectContaining({
                kanban: expect.objectContaining({
                  groupFieldId: createdField.id,
                }),
              }),
            }),
          },
        }),
      );
    });
  });

  test("repairs invalid kanban views through the same grouping setup", async () => {
    const invalidKanbanView: DatabaseView = {
      ...kanbanView,
      config: {
        ...kanbanView.config,
        kanban: {
          ...kanbanView.config.kanban!,
          groupFieldId: "missing-field",
        },
      },
    };
    const gql = vi.fn(async ({ query }) =>
      query === updateDatabaseViewMutation
        ? { updateDatabaseView: kanbanView }
        : {},
    );
    renderDatabaseViewHost({
      activeViewId: invalidKanbanView.id,
      gql,
      record: { ...kanbanRecord, views: [invalidKanbanView] },
      rows: kanbanRows,
    });

    expect(
      screen.getAllByText("Kanban view needs a select field").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("database-kanban-configure"));
    const modal = await screen.findByTestId("database-kanban-setup");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              viewId: invalidKanbanView.id,
              config: expect.objectContaining({
                kanban: expect.objectContaining({
                  groupFieldId: statusField.id,
                }),
              }),
            }),
          },
        }),
      );
    });
  });
});

test.each([{ layout: "page" as const, managed: true, commands: true }])(
  "Kanban real row menu receives its managed record in $layout (managed=$managed) without creating an embedded assistance owner",
  async ({ layout, managed, commands }) => {
    const selectedRecord = managed
      ? readyManagedRecord({
          ...kanbanRecord,
          database: {
            ...kanbanRecord.database,
            profileKind: DatabaseProfileKind.Project,
          },
        })
      : kanbanRecord;
    const selectedRow = managed
      ? { ...kanbanRows[0]!, row: { ...kanbanRows[0]!.row, rowKind: "task" } }
      : kanbanRows[0]!;
    const gql = vi.fn(
      async ({ query, variables }) =>
        assistantQueryFixture(
          query,
          variables ?? {},
          selectedRecord,
          selectedRow,
        ) ?? {},
    );
    renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      layout,
      record: selectedRecord,
      rows: [selectedRow],
      gql,
    });
    const card = await screen.findByTestId("database-kanban-card");
    fireEvent.click(within(card).getByTestId("database-row-action-menu"));
    const sources = assistantPackagesFixture(
      AssistantContext.TaskContainerAssistance,
    ).filter(
      (source) =>
        !source.components.some(
          (component) =>
            component.action.kind ===
            AssistantNativeActionKind.ConfigureTaskPreparation,
        ),
    );
    if (commands) {
      for (const source of sources)
        expect(
          await screen.findByRole("menuitem", { name: source.name.en }),
        ).toBeTruthy();
    } else {
      await screen.findByRole("menuitem", { name: "Open details" });
      for (const source of sources)
        expect(
          screen.queryByRole("menuitem", { name: source.name.en }),
        ).toBeNull();
    }
    expect(screen.queryByTestId("context-document-assistance")).toBeNull();
  },
);
