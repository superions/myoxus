// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  bulkDeleteDatabaseRowsMutation,
  bulkRestoreDatabaseRowsMutation,
  bulkSetDatabaseCellValueMutation,
  clearDatabaseCellValueMutation,
  createDatabaseRowFromTemplateMutation,
  createDatabaseRowMutation,
  DatabaseFieldKind,
  DatabaseRowContentDocumentState,
  reorderDatabaseFieldsMutation,
  updateDatabaseCellValueMutation,
  updateDatabaseRowTitleMutation,
  updateDatabaseViewMutation,
} from "@myoxus/graphql";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  dueField,
  field,
  notesField,
  record,
  rows,
  rowTemplates,
  tableView,
  TIMESTAMP,
  titleField,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import {
  type DatabaseRecord,
  type DatabaseRowRecord,
  type DatabaseView,
} from "../types";
import { databaseBulkTagIntersection } from "./bulk-edit-modal";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

describe("Database Table view", () => {
  test("keeps the stable intersection of active and archived bulk tag values", () => {
    expect(
      databaseBulkTagIntersection([
        ["active", "archived", "row-one"],
        ["archived", "active", "row-two"],
        ["active", "archived"],
      ]),
    ).toEqual(["active", "archived"]);
  });

  test("uses the default Row template for the primary add-row action", async () => {
    const { gql } = renderDatabaseViewHost({ rowTemplates });

    fireEvent.click(screen.getByTestId("database-new-row"));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowFromTemplateMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              rowTemplateId: "row-template-default",
              title: "Untitled row",
            },
          },
        }),
      ),
    );
    expect(gql).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: createDatabaseRowMutation }),
    );
  });

  test("opens Row details with empty Page content subordinate and collapsed", async () => {
    renderDatabaseViewHost({
      layout: "page",
      rows: [
        {
          ...rows[0]!,
          row: { ...rows[0]!.row, contentDocument: null },
        },
      ],
    });

    fireEvent.click(screen.getAllByTestId("database-new-row-menu")[0]!);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open details" }),
    );

    expect(
      await screen.findByTestId("database-row-detail-content"),
    ).not.toBeNull();
    const peek = within(screen.getByTestId("database-row-detail-peek"));
    const pageContent = peek.getByRole("button", { name: "Page content" });
    expect(pageContent.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pageContent);
    expect(peek.getByText("No page content")).not.toBeNull();
  });

  test("keeps editable columns at their intrinsic width inside the scroll surface", () => {
    renderDatabaseViewHost();

    const table = screen.getByTestId("database-table-grid");
    expect(table.style.minWidth).toBe("100%");
    expect(table.style.width).toBe("max-content");
  });

  test("shows the bulk toolbar and exports selected table rows", async () => {
    const onExportCsvRows = vi.fn(async () => {});
    renderDatabaseViewHost({ onExportCsvRows });

    fireEvent.click(screen.getAllByTestId("database-table-select-row")[0]!);

    expect(
      await screen.findByTestId("database-bulk-selection-toolbar"),
    ).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("database-bulk-export-selected"));

    expect(onExportCsvRows).toHaveBeenCalledWith(["row-1"]);
  });

  test("bulk-edits the selected rows through the atomic server mutation", async () => {
    const gql = vi.fn(async ({ query }) =>
      query === bulkSetDatabaseCellValueMutation
        ? {
            bulkSetDatabaseCellValue: {
              failed: [],
              failureCount: 0,
              succeeded: ["row-1"],
              successCount: 1,
              total: 1,
              transactionCommitted: true,
            },
          }
        : {},
    );
    renderDatabaseViewHost({ gql });

    fireEvent.click(screen.getAllByTestId("database-table-select-row")[0]!);
    fireEvent.click(await screen.findByTestId("database-bulk-edit-selected"));
    fireEvent.change(await screen.findByTestId("database-bulk-edit-value"), {
      target: { value: "Reviewed" },
    });
    fireEvent.click(screen.getByTestId("database-bulk-apply-field"));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkSetDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              fieldId: notesField.id,
              force: false,
              rows: [
                {
                  expectedEditRevision: 1,
                  rowId: "row-1",
                  value: { text: "Reviewed" },
                },
              ],
            },
          },
        }),
      ),
    );
  });

  test("bulk-deletes and restores selected rows through server mutations", async () => {
    const gql = vi.fn(async ({ query }) =>
      query === bulkDeleteDatabaseRowsMutation
        ? {
            bulkDeleteDatabaseRows: {
              failed: [],
              failureCount: 0,
              succeeded: ["row-1"],
              successCount: 1,
              total: 1,
              transactionCommitted: true,
            },
          }
        : query === bulkRestoreDatabaseRowsMutation
          ? {
              bulkRestoreDatabaseRows: {
                failed: [],
                failureCount: 0,
                succeeded: ["row-1"],
                successCount: 1,
                total: 1,
                transactionCommitted: true,
              },
            }
          : {},
    );
    const { onChanged } = renderDatabaseViewHost({ gql });

    fireEvent.click(screen.getAllByTestId("database-table-select-row")[0]!);
    fireEvent.click(await screen.findByTestId("database-bulk-delete-selected"));
    fireEvent.click(await screen.findByTestId("database-bulk-confirm-delete"));

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkDeleteDatabaseRowsMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevisions: [
                { expectedEditRevision: 1, rowId: "row-1" },
              ],
              force: false,
              rowIds: ["row-1"],
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("database-bulk-restore"));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: bulkRestoreDatabaseRowsMutation,
          variables: {
            input: {
              databaseId: "database-1",
              force: false,
              rowIds: ["row-1"],
            },
          },
        }),
      ),
    );
  });

  test("copies and cuts multi-cell selections through the database table view", async () => {
    const { gql, onChanged } = renderDatabaseViewHost();
    const cells = screen.getAllByTestId("database-cell");
    fireEvent.click(cells[0]!);
    fireEvent.keyDown(cells[0]!, { key: "ArrowRight", shiftKey: true });

    const setData = vi.fn();
    fireEvent.copy(cells[1]!, {
      clipboardData: { setData },
    });
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "Initial task\tInitial note",
    );

    fireEvent.cut(cells[1]!, {
      clipboardData: { setData },
    });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowTitleMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              force: false,
              rowId: "row-1",
              title: "Untitled",
              titleFieldId: "field-title",
            },
          },
        }),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: clearDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: "field-notes",
              force: false,
              rowId: "row-1",
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("pastes TSV through cell mutations and creates missing target rows", async () => {
    const tableViewWithDue: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, notesField.id, dueField.id],
        },
      },
    };
    const recordWithDue: DatabaseRecord = {
      ...record,
      fields: [titleField, notesField, dueField],
      views: [tableViewWithDue],
    };
    const createdRow: DatabaseRowRecord = {
      cells: [],
      cellRevisions: [],
      groupKeys: [],
      redacted: false,
      row: {
        createdAt: TIMESTAMP,
        createdBy: "user-1",
        databaseId: "database-1",
        editRevision: 1,
        deletedAt: null,
        contentDocument: {
          documentId: "doc-2",
          externalId: "doc-2",
          workspaceId: null,
          state: DatabaseRowContentDocumentState.Available,
          title: "Second task content",
        },
        id: "row-2",
        position: 1,
        rowKind: "record",
        title: "Second task",
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
      },
    };
    const gql = vi.fn(async ({ query }) =>
      query === createDatabaseRowMutation
        ? { createDatabaseRow: createdRow }
        : {},
    );
    const { onChanged } = renderDatabaseViewHost({
      gql,
      record: recordWithDue,
      rows,
    });
    const noteCell = screen
      .getByText("Initial note")
      .closest("[data-testid='database-cell']")!;

    fireEvent.click(noteCell);
    fireEvent.paste(noteCell, {
      clipboardData: {
        getData: () => "Alpha\t2026-07-20\nBeta\t2026-07-21",
      },
    });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
        }),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: notesField.id,
              force: false,
              rowId: "row-1",
              value: { text: "Alpha" },
            },
          },
        }),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 0,
              fieldId: dueField.id,
              force: false,
              rowId: "row-2",
              value: { date: { start: "2026-07-21" } },
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("supports drag-to-fill, field drag-reorder and persisted field resize", async () => {
    const secondRow: DatabaseRowRecord = {
      cells: [],
      cellRevisions: [],
      groupKeys: [],
      redacted: false,
      row: {
        createdAt: TIMESTAMP,
        createdBy: "user-1",
        databaseId: "database-1",
        editRevision: 1,
        deletedAt: null,
        contentDocument: {
          documentId: "doc-2",
          externalId: "doc-2",
          workspaceId: null,
          state: DatabaseRowContentDocumentState.Available,
          title: "Second task content",
        },
        id: "row-2",
        position: 1,
        rowKind: "record",
        title: "Second task",
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
      },
    };
    const { gql, onChanged } = renderDatabaseViewHost({
      rows: [...rows, secondRow],
    });
    const notesCells = screen
      .getAllByTestId("database-cell")
      .filter((cell) => cell.getAttribute("data-field-id") === notesField.id);
    const dataTransfer = {
      dropEffect: "",
      effectAllowed: "",
      getData: vi.fn(() => notesField.id),
      setData: vi.fn(),
    };

    fireEvent.click(notesCells[0]!);
    fireEvent.dragStart(notesCells[0]!, { dataTransfer });
    fireEvent.dragOver(notesCells[1]!, { dataTransfer });
    fireEvent.drop(notesCells[1]!, { dataTransfer });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 0,
              fieldId: notesField.id,
              force: false,
              rowId: "row-2",
              value: { text: "Initial note" },
            },
          },
        }),
      );
    });

    const nameHeader = screen
      .getByText("Name")
      .closest("[role='columnheader']")!;
    const notesHeader = screen
      .getByText("Notes")
      .closest("[role='columnheader']")!;
    fireEvent.dragStart(notesHeader, { dataTransfer });
    fireEvent.dragOver(nameHeader, { dataTransfer });
    fireEvent.drop(nameHeader, { dataTransfer });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: reorderDatabaseFieldsMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevisions: [
                { expectedEditRevision: 1, fieldId: titleField.id },
                { expectedEditRevision: 1, fieldId: notesField.id },
              ],
              fieldIds: [notesField.id, titleField.id],
              force: false,
            },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: expect.objectContaining({
                table: expect.objectContaining({
                  visibleFieldIds: [notesField.id, titleField.id],
                }),
              }),
              databaseId: "database-1",
              viewId: "view-table",
            }),
          },
        }),
      );
    });

    const resizeHandles = screen.getAllByTestId("database-field-resize-handle");
    fireEvent.pointerDown(resizeHandles[1]!, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(resizeHandles[1]!, { clientX: 148, pointerId: 1 });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: expect.objectContaining({
                table: expect.objectContaining({
                  fieldWidths: [{ fieldId: notesField.id, width: 144 }],
                }),
              }),
              databaseId: "database-1",
              viewId: "view-table",
            }),
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("renders unknown future field kinds as unsupported instead of text", () => {
    const futureField = {
      ...field("field-future", "FutureKind" as DatabaseFieldKind, "Future", 2),
      fieldType: "FutureKind" as DatabaseFieldKind,
    };
    const futureView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, notesField.id, futureField.id],
        },
      },
    };
    renderDatabaseViewHost({
      record: {
        ...record,
        fields: [titleField, notesField, futureField],
        views: [futureView],
      },
    });

    expect(screen.getByText("Unsupported field")).toBeTruthy();
    expect(
      screen
        .getByText("Future")
        .closest("[data-testid='database-field-header']")
        ?.getAttribute("data-field-unsupported"),
    ).toBe("true");
  });
});
