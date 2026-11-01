// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  createDatabaseFieldMutation,
  DatabaseFieldKind,
  DatabaseFileMimeCategory,
  DatabaseFilesPreviewPolicy,
  DatabaseStatusGroup,
  deleteDatabaseFieldMutation,
  deleteDatabaseViewMutation,
  updateDatabaseFieldMutation,
  updateDatabaseViewMutation,
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
  field,
  notesField,
  p9gRecord,
  p9gRows,
  record,
  rows,
  tableView,
  titleField,
} from "../test-fixtures";
import { renderDatabaseViewHost, selectFacadeOption } from "../test-harness";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

async function statusSettingsFixture(remote = false) {
  const status = {
    ...field("field-status-settings", DatabaseFieldKind.Status, "Workflow", 1),
    config: {
      ...field("field-status-settings", DatabaseFieldKind.Status, "Workflow", 1)
        .config,
      status: {
        defaultOptionId: "todo",
        options: [
          {
            id: "todo",
            name: "Todo",
            group: DatabaseStatusGroup.NotStarted,
            colorRole: "tag.green",
            position: 0,
          },
          {
            id: "active",
            name: "Doing",
            group: DatabaseStatusGroup.Active,
            colorRole: "tag.blue",
            position: 1,
          },
          {
            id: "done",
            name: "Done",
            group: DatabaseStatusGroup.Complete,
            colorRole: "tag.grey",
            position: 2,
          },
        ],
      },
    },
  };
  const gql = vi.fn(
    ({
      query,
    }: {
      query?: unknown;
      mutation?: unknown;
      variables?: { input?: { force?: boolean } };
    }) => {
      if (query === updateDatabaseFieldMutation)
        throw Object.assign(new Error("Status configuration is in use"), {
          extensions: { code: "MIX_DATABASE_PROJECT_STATUS_IN_USE" },
        });
      return {};
    },
  );
  const native = {
    ...record,
    fields: [titleField, status],
    views: record.views.map((view) => ({
      ...view,
      config: {
        ...view.config,
        table: view.config.table
          ? {
              ...view.config.table,
              visibleFieldIds: [titleField.id, status.id],
            }
          : null,
      },
    })),
  };
  const { rerender } = renderDatabaseViewHost({ gql, record: native });
  fireEvent.click(
    screen.getByRole("button", { name: "Configure field: Workflow" }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: "Configure field",
    }),
  );
  const dialog = within(
    await screen.findByTestId("database-field-settings-modal"),
  );
  fireEvent.click(
    await dialog.findByRole("button", { name: /Todo.*Not started/ }),
  );
  const name = dialog.getAllByRole("textbox", {
    name: "Status name",
    hidden: true,
  })[0]!;
  fireEvent.change(name, { target: { value: "Ready to deliver" } });
  if (remote) {
    rerender(
      {
        ...native,
        fields: [
          titleField,
          {
            ...status,
            editRevision: 9,
            config: {
              ...status.config,
              status: {
                ...status.config.status,
                options: status.config.status.options.map((option) => ({
                  ...option,
                  name: "Remote label",
                })),
              },
            },
          },
        ],
      },
      rows,
    );
  }
  return { status, gql };
}

async function statusSettingsConflictFixture() {
  const { status, gql } = await statusSettingsFixture(true);
  const conflict = Object.assign(new Error("Field changed"), {
    extensions: {
      code: "MIX_DATABASE_FIELD_CONFLICT",
      latestState: JSON.stringify({
        kind: "field",
        editRevision: 9,
        field: { ...status, editRevision: 9 },
      }),
    },
  });
  gql.mockImplementation(
    ({
      query,
      variables,
    }: {
      query?: unknown;
      mutation?: unknown;
      variables?: { input?: { force?: boolean } };
    }) => {
      if (query === updateDatabaseFieldMutation) {
        if (variables?.input?.force)
          throw Object.assign(new Error("Status used"), {
            extensions: { code: "MIX_DATABASE_PROJECT_STATUS_IN_USE" },
          });
        throw conflict;
      }
      return {};
    },
  );
  return gql;
}

describe("Database field settings", () => {
  test("keeps a Status draft and original revision through revalidation and typed rejection", async () => {
    const { status, gql } = await statusSettingsFixture(true);
    expect(
      (
        screen.getAllByRole("textbox", {
          name: "Status name",
          hidden: true,
        })[0]! as HTMLInputElement
      ).value,
    ).toBe("Ready to deliver");
    fireEvent.click(screen.getByRole("button", { name: "Save", hidden: true }));
    await screen.findByText(
      "A status used by Tasks cannot be removed or moved to another group. Update those Tasks first, including Trash.",
    );
    expect(
      (
        screen.getAllByRole("textbox", {
          name: "Status name",
          hidden: true,
        })[0]! as HTMLInputElement
      ).value,
    ).toBe("Ready to deliver");
    const writes = gql.mock.calls.filter(
      ([request]) => request.query === updateDatabaseFieldMutation,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            expectedEditRevision: 1,
            config: {
              status: {
                defaultOptionId: "todo",
                options: [
                  {
                    ...status.config.status.options[0],
                    name: "Ready to deliver",
                  },
                  status.config.status.options[1],
                  status.config.status.options[2],
                ],
              },
            },
          }),
        },
      }),
    );
  });

  test("keeps typed Force rejection feedback and the owned Status draft", async () => {
    await statusSettingsConflictFixture();
    fireEvent.click(screen.getByRole("button", { name: "Save", hidden: true }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Overwrite with my value",
        hidden: true,
      }),
    );
    await screen.findByText(
      "A status used by Tasks cannot be removed or moved to another group. Update those Tasks first, including Trash.",
    );
    expect(
      (
        screen.getAllByRole("textbox", {
          name: "Status name",
          hidden: true,
        })[0]! as HTMLInputElement
      ).value,
    ).toBe("Ready to deliver");
  });

  test("explicitly reloads a deduped Status revision and saves against revision nine", async () => {
    const gql = await statusSettingsConflictFixture();
    const dialog = within(screen.getByTestId("database-field-settings-modal"));
    fireEvent.click(dialog.getByRole("button", { name: "Save", hidden: true }));
    const conflict = within(
      await screen.findByTestId("database-conflict-modal"),
    );
    fireEvent.click(
      conflict.getByRole("button", {
        name: "Use latest version",
        hidden: true,
      }),
    );
    fireEvent.click(
      await dialog.findByRole("button", { name: /Remote label.*Not started/ }),
    );
    await waitFor(() =>
      expect(
        (
          dialog.getAllByRole("textbox", {
            name: "Status name",
            hidden: true,
          })[0]! as HTMLInputElement
        ).value,
      ).toBe("Remote label"),
    );
    gql.mockImplementation(({ query }) => {
      if (query === updateDatabaseFieldMutation)
        throw Object.assign(new Error("Status used"), {
          extensions: { code: "MIX_DATABASE_PROJECT_STATUS_IN_USE" },
        });
      return {};
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save", hidden: true }));
    await waitFor(() =>
      expect(
        gql.mock.calls
          .filter(([request]) => request.query === updateDatabaseFieldMutation)
          .at(-1)?.[0],
      ).toEqual(
        expect.objectContaining({
          variables: {
            input: expect.objectContaining({ expectedEditRevision: 9 }),
          },
        }),
      ),
    );
    await dialog.findByText(
      "A status used by Tasks cannot be removed or moved to another group. Update those Tasks first, including Trash.",
    );
  });

  test("protects a pending Status save from edits and dismissal", async () => {
    const { status, gql } = await statusSettingsFixture();
    let finishPending: (() => void) | undefined;
    const pending = new Promise<{ updateDatabaseField: typeof status }>(
      (resolve) => {
        finishPending = () => resolve({ updateDatabaseField: status });
      },
    );
    gql.mockImplementation(({ query }) =>
      query === updateDatabaseFieldMutation ? pending : {},
    );
    fireEvent.click(screen.getByRole("button", { name: "Save", hidden: true }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Cancel",
            hidden: true,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(
      (
        screen.getAllByRole("textbox", {
          name: "Status name",
          hidden: true,
        })[0]! as HTMLInputElement
      ).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByTestId("database-field-settings-modal"), {
      key: "Escape",
    });
    expect(screen.getByTestId("database-field-settings-modal")).toBeDefined();
    await act(async () => {
      finishPending!();
      await pending;
    });
    await waitFor(() =>
      expect(screen.queryByTestId("database-field-settings-modal")).toBeNull(),
    );
  });

  test("sends revision baselines for field rename and delete actions", async () => {
    const { gql, rerender } = renderDatabaseViewHost();
    let notesHeader = screen
      .getByText("Notes")
      .closest("[role='columnheader']") as HTMLElement;

    fireEvent.doubleClick(within(notesHeader).getByText("Notes"));
    const renameInput = within(notesHeader).getByLabelText("Rename Notes");
    fireEvent.change(renameInput, { target: { value: "Details" } });
    fireEvent.blur(renameInput);

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseFieldMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: notesField.id,
              force: false,
              name: "Details",
            },
          },
        }),
      ),
    );

    rerender(
      {
        ...record,
        fields: record.fields.map((field) =>
          field.id === notesField.id
            ? { ...field, editRevision: 2, name: "Details" }
            : field,
        ),
      },
      rows,
    );
    notesHeader = screen
      .getByText("Details")
      .closest("[role='columnheader']") as HTMLElement;
    fireEvent.click(
      within(notesHeader).getByTestId("database-table-field-menu-trigger"),
    );
    expect(
      await screen.findAllByRole("menuitem", { name: "Move field left" }),
    ).toHaveLength(1);
    expect(
      await screen.findAllByRole("menuitem", { name: "Move field right" }),
    ).toHaveLength(1);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete field" }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: deleteDatabaseFieldMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 2,
              fieldId: notesField.id,
              force: false,
            },
          },
        }),
      ),
    );
  });

  test("sends the active view revision when deleting a view", async () => {
    const { gql } = renderDatabaseViewHost({
      activeViewId: tableView.id,
      layout: "page",
      record: p9gRecord,
      rows: p9gRows,
    });

    fireEvent.focus(screen.getByTestId(`database-view-tab-${tableView.id}`));
    fireEvent.click(
      screen.getByRole("button", { name: `View actions: ${tableView.name}` }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete view" }),
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: deleteDatabaseViewMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              force: false,
              viewId: tableView.id,
            },
          },
        }),
      ),
    );
  });

  test("creates fields through the database-specific field-plus control", async () => {
    const user = userEvent.setup();
    const createdField = field(
      "field-status",
      DatabaseFieldKind.Text,
      "Status",
      2,
    );
    const gql = vi.fn(async ({ query }) =>
      query === createDatabaseFieldMutation
        ? { createDatabaseField: createdField }
        : {},
    );
    const { onChanged } = renderDatabaseViewHost({ gql });

    expect(screen.queryByRole("combobox", { name: "Field type" })).toBeNull();
    const fieldPlus = screen.getByTestId("database-field-plus");
    const fieldPlusHeader = fieldPlus.closest("[role='columnheader']");
    expect(fieldPlusHeader).not.toBeNull();
    expect(
      fieldPlusHeader?.previousElementSibling?.getAttribute("data-field-id"),
    ).toBe(notesField.id);

    fireEvent.click(fieldPlus);
    expect(await screen.findByRole("dialog")).not.toBeNull();
    fireEvent.change(await screen.findByLabelText("Field name"), {
      target: { value: "Status" },
    });
    const fieldType = screen.getByRole("combobox", { name: "Field type" });
    await user.click(fieldType);
    expect(
      await screen.findByRole("option", { name: "Rich text" }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Create field", hidden: true }),
    );

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseFieldMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              fieldType: DatabaseFieldKind.Text,
              name: "Status",
            }),
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
              databaseId: "database-1",
              viewId: "view-table",
              config: expect.objectContaining({
                table: expect.objectContaining({
                  visibleFieldIds: [
                    titleField.id,
                    notesField.id,
                    createdField.id,
                  ],
                }),
              }),
            }),
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("opens field settings from the table field header menu", async () => {
    renderDatabaseViewHost();

    const notesHeader = screen
      .getByText("Notes")
      .closest("[role='columnheader']")!;
    expect(notesHeader).toBeInstanceOf(HTMLElement);
    const fieldMenuTrigger = within(notesHeader as HTMLElement).getByTestId(
      "database-table-field-menu-trigger",
    );
    expect(fieldMenuTrigger.getAttribute("aria-label")).toBe(
      "Configure field: Notes",
    );
    fireEvent.click(fieldMenuTrigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Configure field" }),
    );

    expect(await screen.findByText("Field settings: Notes")).not.toBeNull();
    expect(
      await screen.findByTestId("database-field-settings-modal"),
    ).not.toBeNull();
    expect(screen.getByText("Allow multiple lines")).not.toBeNull();
  });

  test("confirms and persists disabling personal DateTime reminders", async () => {
    const dateTimeField = {
      ...field("field-starts", DatabaseFieldKind.DateTime, "Starts", 2),
      config: {
        ...field("field-starts", DatabaseFieldKind.DateTime, "Starts", 2)
          .config,
        dateTime: { allowReminders: true, defaultTimeZone: "UTC" },
      },
    };
    const dateTimeRecord = {
      ...record,
      fields: [...record.fields, dateTimeField],
      views: record.views.map((view) => ({
        ...view,
        config: {
          ...view.config,
          table: view.config.table
            ? {
                ...view.config.table,
                visibleFieldIds: [
                  ...view.config.table.visibleFieldIds,
                  dateTimeField.id,
                ],
              }
            : null,
        },
      })),
    };
    const { gql } = renderDatabaseViewHost({ record: dateTimeRecord });
    const header = screen
      .getByText("Starts")
      .closest("[role='columnheader']") as HTMLElement;
    fireEvent.click(
      within(header).getByTestId("database-table-field-menu-trigger"),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Configure field" }),
    );
    expect(await screen.findByText("Field settings: Starts")).not.toBeNull();
    fireEvent.click(await screen.findByLabelText("Allow personal reminders"));
    expect(
      await screen.findByText("Disable personal reminders?"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disable reminders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseFieldMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              fieldId: dateTimeField.id,
              config: {
                dateTime: {
                  allowReminders: false,
                  defaultTimeZone: "UTC",
                },
              },
            }),
          },
        }),
      ),
    );
  });

  test("edits the canonical Files limits and preview policy", async () => {
    const filesField = {
      ...field("field-files", DatabaseFieldKind.Files, "Attachments", 2),
      config: {
        ...field("field-files", DatabaseFieldKind.Files, "Attachments", 2)
          .config,
        files: {
          allowedMimeCategories: [DatabaseFileMimeCategory.Any],
          maxItemCount: null,
          maxItemSize: null,
          previewPolicy: DatabaseFilesPreviewPolicy.Auto,
        },
      },
    };
    const filesRecord = {
      ...record,
      fields: [...record.fields, filesField],
      views: record.views.map((view) => ({
        ...view,
        config: {
          ...view.config,
          table: view.config.table
            ? {
                ...view.config.table,
                visibleFieldIds: [
                  ...view.config.table.visibleFieldIds,
                  filesField.id,
                ],
              }
            : null,
        },
      })),
    };
    const { gql } = renderDatabaseViewHost({ record: filesRecord });
    const header = screen
      .getByText("Attachments")
      .closest("[role='columnheader']") as HTMLElement;

    fireEvent.click(
      within(header).getByTestId("database-table-field-menu-trigger"),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Configure field" }),
    );
    const modal = await screen.findByTestId("database-field-settings-modal");
    const maximumFiles = within(modal).getByRole("textbox", {
      name: "Maximum files",
    });
    const maximumSize = within(modal).getByRole("textbox", {
      name: "Maximum size per file",
    });
    fireEvent.change(maximumFiles, { target: { value: "4" } });
    fireEvent.change(maximumSize, { target: { value: "5242880" } });
    await selectFacadeOption(modal, "Image previews", "Disabled");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseFieldMutation,
          variables: {
            input: expect.objectContaining({
              databaseId: "database-1",
              fieldId: filesField.id,
              config: {
                files: {
                  allowedMimeCategories: [DatabaseFileMimeCategory.Any],
                  maxItemCount: 4,
                  maxItemSize: 5242880,
                  previewPolicy: DatabaseFilesPreviewPolicy.Disabled,
                },
              },
            }),
          },
        }),
      ),
    );
  });

  test("keeps title-field settings disabled instead of opening an empty dialog", async () => {
    renderDatabaseViewHost();

    const titleHeader = screen
      .getByText("Name")
      .closest("[role='columnheader']")!;
    fireEvent.click(
      within(titleHeader as HTMLElement).getByTestId(
        "database-table-field-menu-trigger",
      ),
    );

    const configureItem = await screen.findByRole("menuitem", {
      name: "Configure field",
    });
    fireEvent.click(configureItem);

    expect(screen.queryByText("Field settings: Name")).toBeNull();
    expect(screen.queryByTestId("database-field-settings-modal")).toBeNull();
  });
});
