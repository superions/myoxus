// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { GraphQLError } from "@myoxus/error";
import {
  DatabaseFieldKind,
  deleteDatabaseRowMutation,
  updateDatabaseCellValueMutation,
} from "@myoxus/graphql";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import {
  notesField,
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
import { type DatabaseRowRecord } from "../types";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

describe("Database view host conflicts", () => {
  test("keeps Row detail open when delete detects a revision conflict", async () => {
    const gql = vi.fn(async ({ query }) => {
      if (query === deleteDatabaseRowMutation) {
        throw new GraphQLError("stale row", {
          extensions: {
            code: "MIX_DATABASE_ROW_CONFLICT",
            latestState: JSON.stringify({
              kind: "row",
              databaseId: "database-1",
              rowId: "row-1",
              editRevision: 2,
              title: "Remote title",
            }),
          },
        });
      }
      return {};
    });
    const { onChanged } = renderDatabaseViewHost({ gql, layout: "page" });

    fireEvent.click(screen.getAllByTestId("database-new-row-menu")[0]!);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open details" }),
    );
    const detail = await screen.findByTestId("database-row-detail-content");
    fireEvent.click(
      within(screen.getByTestId("database-row-detail-peek")).getByTestId(
        "database-row-action-menu",
      ),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove row" }),
    );

    expect(await screen.findByTestId("database-conflict-modal")).not.toBeNull();
    expect(screen.getByTestId("database-row-detail-content")).toBe(detail);
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

    fireEvent.click(screen.getByRole("button", { name: "Use latest version" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onChanged).toHaveBeenCalledWith();
    expect(screen.getByTestId("database-row-detail-content")).toBe(detail);
  });

  test("keeps a local draft across remote revalidation until reload latest is explicit", async () => {
    const latestState = JSON.stringify({
      kind: "cell",
      databaseId: "database-1",
      rowId: "row-1",
      fieldId: notesField.id,
      fieldType: DatabaseFieldKind.Text,
      editRevision: 2,
      value: { text: "Remote note" },
      displayValue: "Remote note",
    });
    const gql = vi.fn(async ({ query }) => {
      if (query === updateDatabaseCellValueMutation) {
        throw new GraphQLError("stale cell", {
          extensions: {
            code: "MIX_DATABASE_CELL_CONFLICT",
            latestState,
          },
        });
      }
      return {};
    });
    const { onChanged, rerender } = renderDatabaseViewHost({ gql });

    fireEvent.doubleClick(screen.getByText("Initial note"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Local draft" } });

    await act(async () => {
      emitDatabasePresenceChange({
        workspaceId: "workspace-1",
        databaseId: "database-1",
        actorUserId: "remote-user",
        eventId: "remote-event-1",
        committedAt: TIMESTAMP,
        kind: "cell_updated",
        target: { rowId: "row-1", fieldId: notesField.id },
      });
    });
    expect(onChanged).toHaveBeenCalledOnce();

    const remoteRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: rows[0]!.cells.map((cell) =>
        cell.fieldId === notesField.id
          ? {
              ...cell,
              editRevision: 2,
              value: { ...cell.value, text: "Remote note" },
            }
          : cell,
      ),
      cellRevisions: rows[0]!.cellRevisions.map((revision) =>
        revision.fieldId === notesField.id
          ? { ...revision, editRevision: 2 }
          : revision,
      ),
    };
    rerender(record, [remoteRow]);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Local draft",
    );

    fireEvent.blur(screen.getByRole("textbox"));
    expect(await screen.findByTestId("database-conflict-modal")).not.toBeNull();
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
            value: { text: "Local draft" },
          },
        },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Use latest version",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Remote note")).toBeTruthy();
    expect(gql).toHaveBeenCalledTimes(1);
  });

  test("retries the exact conflicting cell mutation only after explicit overwrite", async () => {
    const latestState = JSON.stringify({
      kind: "cell",
      databaseId: "database-1",
      rowId: "row-1",
      fieldId: notesField.id,
      fieldType: DatabaseFieldKind.Text,
      editRevision: 2,
      value: { text: "Remote note" },
      displayValue: "Remote note",
    });
    const gql = vi
      .fn()
      .mockRejectedValueOnce(
        new GraphQLError("stale cell", {
          extensions: {
            code: "MIX_DATABASE_CELL_CONFLICT",
            latestState,
          },
        }),
      )
      .mockResolvedValueOnce({ updateDatabaseCellValue: {} });
    const { onChanged } = renderDatabaseViewHost({ gql });

    fireEvent.doubleClick(screen.getByText("Initial note"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Local winner" },
    });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(await screen.findByTestId("database-conflict-modal")).not.toBeNull();
    expect(gql).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Overwrite with my value",
      }),
    );
    await waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
    const expectedInput = {
      databaseId: "database-1",
      expectedEditRevision: 1,
      fieldId: notesField.id,
      rowId: "row-1",
      value: { text: "Local winner" },
    };
    expect(gql).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: updateDatabaseCellValueMutation,
        variables: { input: { ...expectedInput, force: false } },
      }),
    );
    expect(gql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: updateDatabaseCellValueMutation,
        variables: { input: { ...expectedInput, force: true } },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  test.each([
    ["Table", null],
    ["Row Side Peek", "row-1"],
  ])(
    "retains the RichText draft and opening revision on stale writes in %s",
    async (_surface, initialRowId) => {
      const user = userEvent.setup();
      const richTextField = {
        ...notesField,
        id: "field-rich-text",
        name: "Description",
        fieldType: DatabaseFieldKind.RichText,
        config: {
          ...notesField.config,
          kind: DatabaseFieldKind.RichText,
          richText: { maxPlainTextBytes: null },
          text: null,
        },
      };
      const richTextDocument = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Initial brief" }],
          },
        ],
      };
      const richTextRecord = {
        ...record,
        fields: [titleField, richTextField],
        views: [
          {
            ...tableView,
            config: {
              ...tableView.config,
              table: {
                ...tableView.config.table!,
                visibleFieldIds: [titleField.id, richTextField.id],
              },
            },
          },
        ],
      };
      const richTextRows: DatabaseRowRecord[] = [
        {
          ...rows[0]!,
          cells: [
            {
              ...rows[0]!.cells[0]!,
              fieldId: richTextField.id,
              fieldType: DatabaseFieldKind.RichText,
              value: {
                ...rows[0]!.cells[0]!.value,
                kind: DatabaseFieldKind.RichText,
                richText: {
                  document: richTextDocument,
                  plainText: "Initial brief",
                },
                text: null,
              },
            },
          ],
          cellRevisions: [
            {
              editRevision: 1,
              fieldId: richTextField.id,
              hasValue: true,
              rowId: "row-1",
            },
          ],
        },
      ];
      const latestState = JSON.stringify({
        kind: "cell",
        databaseId: "database-1",
        rowId: "row-1",
        fieldId: richTextField.id,
        fieldType: DatabaseFieldKind.RichText,
        editRevision: 2,
        value: {
          richText: {
            plainText: "Remote brief",
            document: richTextDocument,
          },
        },
        displayValue: "Remote brief",
      });
      let writeCount = 0;
      const gql = vi.fn(async ({ query }) => {
        if (query === updateDatabaseCellValueMutation && writeCount++ === 0) {
          throw new GraphQLError("stale rich text", {
            extensions: {
              code: "MIX_DATABASE_CELL_CONFLICT",
              latestState,
            },
          });
        }
        return {};
      });
      const { onChanged } = renderDatabaseViewHost({
        gql,
        initialRowId,
        record: richTextRecord,
        rows: richTextRows,
      });

      const richTextTrigger = initialRowId
        ? within(
            await screen.findByTestId("database-row-detail-peek"),
          ).getByRole("button", { name: "Initial brief" })
        : screen.getByRole("button", { name: "Initial brief" });
      await user.click(richTextTrigger);
      const editor = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(".ProseMirror");
        expect(element).not.toBeNull();
        return element!;
      });
      await user.click(editor);
      fireEvent.paste(editor, {
        clipboardData: {
          files: [],
          getData: () => " 123456",
          items: [],
          types: ["text/plain"],
        },
      });
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(
        await screen.findByTestId("database-conflict-modal"),
      ).not.toBeNull();
      expect(editor.textContent).toContain("123456");
      if (!initialRowId) {
        expect(
          screen.getByRole("dialog", { name: "Description" }),
        ).not.toBeNull();
      }
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: richTextField.id,
              force: false,
              rowId: "row-1",
              value: {
                richText: {
                  document: expect.objectContaining({ type: "doc" }),
                },
              },
            }),
          },
        }),
      );
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === updateDatabaseCellValueMutation,
        ),
      ).toHaveLength(1);
      const changedBeforeResolution = onChanged.mock.calls.length;

      if (!initialRowId) {
        await user.click(
          screen.getByRole("button", { name: "Use latest version" }),
        );
        await waitFor(() =>
          expect(onChanged.mock.calls.length).toBeGreaterThan(
            changedBeforeResolution,
          ),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("database-conflict-modal")).toBeNull(),
        );
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Description" }),
          ).toBeNull(),
        );
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === updateDatabaseCellValueMutation,
          ),
        ).toHaveLength(1);
      } else {
        await user.click(
          screen.getByRole("button", { name: "Overwrite with my value" }),
        );
        await waitFor(() =>
          expect(
            gql.mock.calls.filter(
              ([request]) => request.query === updateDatabaseCellValueMutation,
            ),
          ).toHaveLength(2),
        );
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === updateDatabaseCellValueMutation,
          )[1]?.[0],
        ).toEqual(
          expect.objectContaining({
            query: updateDatabaseCellValueMutation,
            variables: {
              input: expect.objectContaining({
                expectedEditRevision: 1,
                force: true,
              }),
            },
          }),
        );
        await waitFor(() =>
          expect(onChanged.mock.calls.length).toBeGreaterThan(
            changedBeforeResolution,
          ),
        );
        await waitFor(() =>
          expect(screen.queryByTestId("database-conflict-modal")).toBeNull(),
        );
        expect(editor.textContent).toContain("123456");
      }
    },
  );
});
