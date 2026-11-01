// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  createDatabaseRowMutation,
  DatabaseFieldKind,
  bulkApplyDatabaseCellPatchesMutation,
} from "@myoxus/graphql";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  dueField,
  ganttRecord,
  ganttView,
  p9gRows,
  plannedField,
  relationField,
  statusField,
} from "../test-fixtures";
import { projectDatabaseGantt } from "./projection";

import { renderDatabaseViewHost } from "../test-harness";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

// Catalog order and opaque membership keys are supplied by the server.
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeAll(() => {
  // Happy-DOM omits the FontFaceSet event boundary used by Gantt measurement.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: new EventTarget(),
  });
});
afterAll(() => {
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

const ganttGroups = [
  { key: "__empty__", label: "Ungrouped", rowCount: 0, groups: [] },
  { key: "todo", label: "Todo", rowCount: 2, groups: [] },
  { key: "doing", label: "Doing", rowCount: 0, groups: [] },
  { key: "done", label: "Done", rowCount: 0, groups: [] },
];

function recordWithSchedule() {
  const startCell = p9gRows[0]!.cells.find(
    (cell) => cell.fieldId === dueField.id,
  )!;
  const scheduledRow = (
    id: string,
    title: string,
    start: string,
    end: string,
  ) => {
    const row = {
      ...p9gRows[0]!,
      groupKeys: ["todo"],
      cells: [
        ...p9gRows[0]!.cells.map((cell) => ({ ...cell, rowId: id })),
        {
          ...startCell,
          fieldId: plannedField.id,
          rowId: id,
          value: {
            ...startCell.value,
            date: { end: null, start: end },
          },
        },
        {
          ...startCell,
          fieldId: statusField.id,
          fieldType: statusField.fieldType,
          rowId: id,
          value: {
            ...startCell.value,
            date: null,
            kind: statusField.fieldType,
            select: "todo",
          },
        },
        {
          ...startCell,
          fieldId: relationField.id,
          fieldType: relationField.fieldType,
          rowId: id,
          value: {
            ...startCell.value,
            date: null,
            kind: relationField.fieldType,
            relationTargets: [],
          },
        },
      ].map((cell) =>
        cell.fieldId === dueField.id
          ? {
              ...cell,
              value: {
                ...cell.value,
                date: { end: null, start },
              },
            }
          : cell,
      ),
      row: { ...p9gRows[0]!.row, id, title },
    };
    return {
      ...row,
      cellRevisions: row.cells.map((cell) => ({
        fieldId: cell.fieldId,
        rowId: id,
        editRevision: cell.editRevision,
        hasValue: true,
      })),
    };
  };
  return {
    record: ganttRecord,
    rowGroups: ganttGroups,
    rows: [
      scheduledRow("row-1", "Initial task", "2026-07-15", "2026-07-18"),
      scheduledRow("row-2", "Follow-up", "2026-07-20", "2026-07-22"),
    ],
  };
}

describe("Database Gantt", () => {
  test("metadata boundaries preserve editable actions and block point creation", () => {
    const fixture = recordWithSchedule();
    const rows = fixture.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({
        ...cell,
        value: {
          ...cell.value,
          createdTime: "2026-07-15T00:00:00Z",
          updatedTime: "2026-07-18T00:00:00Z",
        },
      })),
    }));
    const project = (fieldId: string, fieldType: DatabaseFieldKind) => {
      const record = {
        ...fixture.record,
        fields: fixture.record.fields.map((field) =>
          field.id === fieldId ? { ...field, fieldType } : field,
        ),
      };
      return {
        record,
        projection: projectDatabaseGantt({
          ...fixture,
          record,
          rows,
          view: ganttView,
          date: "2026-07-15",
          locale: "en",
          canEdit: true,
          selectedRowId: null,
          ungroupedLabel: "Ungrouped",
          readonlyReason: "Readonly",
          unavailableLabel: "Unavailable",
        }),
      };
    };
    const readonlyStart = project(dueField.id, DatabaseFieldKind.CreatedTime);
    expect(readonlyStart.projection.tasks[0]).toMatchObject({
      move: { enabled: false },
      resize: { enabled: true, edges: ["end"] },
      laneMove: { enabled: true },
      connect: { enabled: true },
    });
    const readonlyEnd = project(plannedField.id, DatabaseFieldKind.UpdatedTime);
    expect(readonlyEnd.projection.tasks[0]).toMatchObject({
      move: { enabled: false },
      resize: { enabled: true, edges: ["start"] },
      laneMove: { enabled: true },
      connect: { enabled: true },
    });
    renderDatabaseViewHost({
      ...fixture,
      record: readonlyEnd.record,
      rows,
      activeViewId: ganttView.id,
      scheduleDate: "2026-07-15",
    });
    expect(
      screen.getByRole("button", { name: "Add row" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("preserves configured Gantt option order, descending order and empty groups", () => {
    const project = (rowGroups: typeof ganttGroups, descending: boolean) =>
      projectDatabaseGantt({
        ...recordWithSchedule(),
        rowGroups,
        view: {
          ...ganttView,
          config: {
            ...ganttView.config,
            gantt: {
              ...ganttView.config.gantt!,
              group: { ...ganttView.config.gantt!.group!, descending },
            },
          },
        },
        date: "2026-07-15",
        locale: "en",
        canEdit: true,
        selectedRowId: null,
        ungroupedLabel: "Ungrouped",
        readonlyReason: "Readonly",
        unavailableLabel: "Unavailable",
      });
    const ascending = project(ganttGroups, false);
    const descending = project([...ganttGroups].reverse(), true);
    expect(ascending.sections.map((section) => section.label)).toEqual([
      "Ungrouped",
      "Todo",
      "Doing",
      "Done",
    ]);
    expect(descending.sections.map((section) => section.label)).toEqual([
      "Done",
      "Doing",
      "Todo",
      "Ungrouped",
    ]);
    expect(ascending.tasks.map((task) => task.sectionId)).toEqual([
      "todo",
      "todo",
    ]);
    expect(
      ascending.sections.find((section) => section.id === "done")?.count,
    ).toBe(0);
  });

  test("renders the horizontal shared Facade and preserves ordered empty groups", () => {
    const fixture = recordWithSchedule();
    renderDatabaseViewHost({
      activeViewId: ganttView.id,
      ...fixture,
      scheduleDate: "2026-07-15",
    });
    const surface = within(screen.getByTestId("database-gantt-view"));
    expect(
      surface.getByTestId(`gantt-bar-${JSON.stringify(["row-1", "todo"])}`),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-myoxus-ui-role="gantt-axis-scroll"]'),
    ).not.toBeNull();
    const rowLane = surface.getByTestId(
      `gantt-label-${JSON.stringify(["row-1", "todo"])}`,
    );
    expect(
      rowLane.closest('[data-myoxus-ui-role="gantt-labels"]'),
    ).not.toBeNull();
    const sections = screen
      .getByTestId("database-gantt-view")
      .querySelectorAll('[data-myoxus-ui-role="gantt-section-header"]');
    expect(
      [...sections].map((section) => section.getAttribute("data-section-id")),
    ).toEqual(["__empty__", "todo", "doing", "done"]);
    for (const [index, label] of [
      "Ungrouped",
      "Todo",
      "Doing",
      "Done",
    ].entries()) {
      expect(
        within(sections[index] as HTMLElement).getByText(label),
      ).not.toBeNull();
    }
  });

  test("commits resize, atomic two-field move with lane clear, dependency, and creation", async () => {
    const gql = vi.fn(async (request: { query?: unknown; variables?: any }) =>
      request.query === bulkApplyDatabaseCellPatchesMutation
        ? {
            bulkApplyDatabaseCellPatches: {
              transactionCommitted: true,
              successCount: request.variables.input.patches.length,
              failureCount: 0,
            },
          }
        : request.query === createDatabaseRowMutation
          ? { createDatabaseRow: { row: { id: "row-created" } } }
          : {},
    );
    const fixture = recordWithSchedule();
    renderDatabaseViewHost({
      activeViewId: ganttView.id,
      gql,
      ...fixture,
      scheduleDate: "2026-07-15",
    });
    const surface = within(screen.getByTestId("database-gantt-view"));
    const item = surface.getByTestId(
      `gantt-bar-${JSON.stringify(["row-1", "todo"])}`,
    );

    fireEvent.keyDown(item, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === bulkApplyDatabaseCellPatchesMutation,
      ),
    ).toHaveLength(0);
    fireEvent.keyDown(item, { key: "Enter" });
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkApplyDatabaseCellPatchesMutation,
          variables: {
            input: {
              databaseId: "database-1",
              force: false,
              patches: [
                {
                  rowId: "row-1",
                  cells: [
                    {
                      fieldId: plannedField.id,
                      expectedEditRevision: 1,
                      value: { date: { start: "2026-07-19", end: null } },
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    });
    await waitFor(() => expect(document.activeElement).toBe(item));
    gql.mockClear();
    fireEvent.keyDown(item, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(item, { key: "ArrowUp", altKey: true });
    expect(gql).not.toHaveBeenCalled();
    fireEvent.keyDown(item, { key: "Enter" });
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkApplyDatabaseCellPatchesMutation,
          variables: {
            input: {
              databaseId: "database-1",
              force: false,
              patches: [
                {
                  rowId: "row-1",
                  cells: [
                    {
                      fieldId: dueField.id,
                      expectedEditRevision: 1,
                      value: { date: { start: "2026-07-16", end: null } },
                    },
                    {
                      fieldId: plannedField.id,
                      expectedEditRevision: 1,
                      value: { date: { start: "2026-07-19", end: null } },
                    },
                    {
                      fieldId: statusField.id,
                      expectedEditRevision: 1,
                      clear: true,
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    });
    gql.mockClear();
    fireEvent.click(
      surface.getByTestId(`gantt-connect-${JSON.stringify(["row-1", "todo"])}`),
    );
    fireEvent.keyDown(
      surface.getByTestId(`gantt-bar-${JSON.stringify(["row-2", "todo"])}`),
      { key: "Enter" },
    );
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === bulkApplyDatabaseCellPatchesMutation,
      ),
    ).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkApplyDatabaseCellPatchesMutation,
          variables: {
            input: {
              databaseId: "database-1",
              force: false,
              patches: [
                {
                  rowId: "row-2",
                  cells: [
                    {
                      fieldId: relationField.id,
                      expectedEditRevision: 1,
                      value: { relation: ["row-1"] },
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
    });
    gql.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.keyDown(surface.getByLabelText("Gantt"), { key: "Enter" });
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Created task" },
    });
    fireEvent.click(
      within(
        screen
          .getByRole("textbox", { name: "Title" })
          .parentElement!.closest(".mantine-Popover-dropdown")!,
      ).getByRole("button", { name: "Add row" }),
    );
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              title: "Created task",
              viewId: ganttView.id,
              expectedViewEditRevision: ganttView.editRevision,
            }),
          }),
        }),
      );
    });
  });

  test("removes mutation affordances when the view is readonly", () => {
    const fixture = recordWithSchedule();
    const gql = vi.fn(async (_request: { query?: unknown }) => ({}));
    renderDatabaseViewHost({
      activeViewId: ganttView.id,
      gql,
      effectiveState: { canEditShared: false, canEditRows: false },
      ...fixture,
      scheduleDate: "2026-07-15",
    });
    const surface = within(screen.getByTestId("database-gantt-view"));
    const item = surface.getByTestId(
      `gantt-bar-${JSON.stringify(["row-1", "todo"])}`,
    );
    expect(item.getAttribute("data-readonly")).toBe("true");
    expect(
      document.querySelectorAll(".myoxus-gantt-resize-handle"),
    ).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.keyDown(item, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(item, { key: "Enter" });
    expect(
      gql.mock.calls.filter(
        ([request]) =>
          request.query === bulkApplyDatabaseCellPatchesMutation ||
          request.query === createDatabaseRowMutation,
      ),
    ).toHaveLength(0);
  });
});
