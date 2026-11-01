// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { PublicUserService } from "@myoxus/core/modules/server";
import { MemberSearchService } from "@myoxus/core/modules/permissions";
import {
  clearDatabaseCellValueMutation,
  DatabaseFieldKind,
  ServerDeploymentType,
  DatabaseProfileKind,
  DatabaseManagedSchemaReadiness,
  DatabaseTaskLifecycle,
  DatabaseTaskScope,
  databaseTasksQuery,
  databaseTaskParentQuery,
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  DatabaseTaskRelationReason,
  type DatabaseTaskParentQuery,
  type DatabaseTaskSummaryFragment,
  DatabaseFormulaStaleState,
  DatabaseRollupStaleState,
  DatabaseRowContentDocumentState,
  databaseRowRemindersQuery,
  databaseRowsQuery,
  deleteDatabaseRowReminderMutation,
  indexerSearchDocsQuery,
  setDatabaseRowReminderMutation,
  updateDatabaseCellValueMutation,
  updateDatabaseRowTitleMutation,
} from "@myoxus/graphql";
import { type FrameworkProvider, FrameworkRoot, LiveData } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import {
  DatabaseCellEditor,
  databaseKanbanTagAccentRoles,
  updateDatabaseDateTimeWallTime,
} from "../cells";
import { DatabaseConflictProvider } from "../presence";
import {
  field,
  formulaField,
  record,
  readyManagedRecord,
  relationField,
  rollupField,
  rows,
  TIMESTAMP,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import {
  type DatabaseField,
  type DatabaseRecord,
  type DatabaseRowRecord,
} from "../types";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalPreferences: () => ({
      dateFormat: "locale" as const,
      locale: "en",
      timeFormat: "locale" as const,
      timezone: "UTC",
    }),
  }),
);

// Cell tests control query completion; socket delivery is exercised by the
// full Task-detail fixture rather than opening a real network connection here.
vi.mock("@myoxus/storage/cloud", async (original) => ({
  ...(await original<typeof import("@myoxus/storage/cloud")>()),
  SocketConnection: class {
    status = "disconnected";
    onStatusChanged() {
      return () => {};
    }
    connect() {}
    disconnect() {}
  },
}));

function parentEditorFixture(
  gql = vi.fn(),
  roleKey: "task.parent" | "task.blockedBy" = "task.parent",
) {
  const parentField: DatabaseField = {
    ...relationField,
    name: roleKey === "task.parent" ? "Parent Task" : "Blocked by",
    config: {
      ...relationField.config,
      relation: {
        targetDatabaseId: "database-1",
        allowMultiple: roleKey === "task.blockedBy",
        maxTargets: roleKey === "task.parent" ? 1 : 8,
        reciprocalFieldId: null,
      },
    },
  };
  const parentRow: DatabaseRowRecord = {
    ...rows[0]!,
    row: { ...rows[0]!.row, rowKind: "task" },
    cellRevisions: [
      {
        rowId: "row-1",
        fieldId: parentField.id,
        editRevision: 7,
        hasValue: false,
      },
    ],
    cells: [],
  };
  const project: DatabaseRecord = readyManagedRecord({
    ...record,
    database: { ...record.database, profileKind: DatabaseProfileKind.Project },
    fields: [...record.fields, parentField],
    fieldRoles: [
      {
        databaseId: "database-1",
        profileKind: DatabaseProfileKind.Project,
        roleKey,
        rowKindScope: "task",
        fieldId: parentField.id,
        required: false,
        config: {},
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
  });
  const account$ = new LiveData({ id: "parent-actor" });
  const server = {
    id: "parent-server",
    config$: new LiveData({ type: ServerDeploymentType.Standalone }),
    baseUrl: "https://myoxus.test",
    account$,
    gql,
  };
  const server$ = new LiveData(server);
  const onChanged = vi.fn();
  const onBlockedProjection = vi.fn();
  const workspaceServer = { server$ };
  const workspaceService = {
    workspace: { id: "workspace-1", flavour: "myoxus-cloud" },
  };
  const graphQLService = { gql };
  const framework = {
    get(token: unknown) {
      if (token === GraphQLService) return graphQLService;
      if (token === WorkspaceServerService) return workspaceServer;
      if (token === WorkspaceService) return workspaceService;
      throw new Error(`Unexpected parent editor service ${String(token)}`);
    },
  } as unknown as FrameworkProvider;
  const surface = (row = parentRow, field = parentField) => (
    <FrameworkRoot framework={framework}>
      <SWRConfigProvider>
        <MyoxusUIProvider env="test">
          <DatabaseConflictProvider>
            <DatabaseCellEditor
              databaseId="database-1"
              field={field}
              record={project}
              row={row}
              rows={[
                row,
                {
                  ...row,
                  row: {
                    ...row.row,
                    id: "phase-row",
                    rowKind: "phase",
                    title: "Phase",
                  },
                },
              ]}
              onChanged={onChanged}
              onTaskBlockedByProjection={onBlockedProjection}
            />
          </DatabaseConflictProvider>
        </MyoxusUIProvider>
      </SWRConfigProvider>
    </FrameworkRoot>
  );
  return {
    gql,
    account$,
    server$,
    onChanged,
    onBlockedProjection,
    parentField,
    parentRow,
    project,
    surface,
  };
}

function parentRead(
  capability: Partial<
    NonNullable<
      NonNullable<DatabaseTaskParentQuery["workspace"]>["databaseRow"]
    >["row"]["taskParent"]
  > = {},
): DatabaseTaskParentQuery {
  return {
    workspace: {
      id: "workspace-1",
      databaseRow: {
        row: {
          id: "row-1",
          databaseId: "database-1",
          taskParent: {
            available: true,
            fieldId: relationField.id,
            parentRowIds: [],
            diagnostics: [],
            ...capability,
          },
        },
      },
    },
  };
}
function parentTask(rowId: string, title: string): DatabaseTaskSummaryFragment {
  return {
    workspaceId: "workspace-1",
    databaseId: "database-1",
    rowId,
    title,
    projectTitle: "Project",
    descriptionPreview: null,
    editRevision: 1,
    updatedAt: TIMESTAMP,
    deletedAt: null,
    status: null,
    priority: null,
    assignees: [],
    due: null,
    hasPriority: false,
    isSubtask: null,
    hasDependencies: null,
    hasAssignees: false,
    hasDue: false,
    canEdit: true,
  };
}
function parentConflict(label = "Private latest parent") {
  return {
    extensions: {
      code: "MIX_DATABASE_CELL_CONFLICT",
      latestState: JSON.stringify({
        kind: "cell",
        databaseId: "database-1",
        rowId: "row-1",
        fieldId: relationField.id,
        editRevision: 8,
        fieldKind: "Relation",
        value: { relation: ["existing-parent"] },
        displayValue: label,
      }),
    },
  };
}

function reminderFixture({
  allDay = false,
  allowReminders = true,
  idSuffix = "",
}: {
  allDay?: boolean;
  allowReminders?: boolean;
  idSuffix?: string;
} = {}) {
  const dateTimeField: DatabaseField = {
    ...field(`field-start${idSuffix}`, DatabaseFieldKind.DateTime, "Starts", 2),
    config: {
      ...field(
        `field-start${idSuffix}`,
        DatabaseFieldKind.DateTime,
        "Starts",
        2,
      ).config,
      dateTime: { allowReminders, defaultTimeZone: "UTC" },
    },
  };
  const dateTimeRow: DatabaseRowRecord = {
    ...rows[0]!,
    row: { ...rows[0]!.row, id: `${rows[0]!.row.id}${idSuffix}` },
    cells: [
      ...rows[0]!.cells,
      {
        ...rows[0]!.cells[0]!,
        fieldId: dateTimeField.id,
        fieldType: DatabaseFieldKind.DateTime,
        value: {
          ...rows[0]!.cells[0]!.value,
          dateTime: {
            allDay,
            end: null,
            start: "2030-07-11T09:00:00Z",
            timeZone: "UTC",
          },
          kind: DatabaseFieldKind.DateTime,
          text: null,
        },
      },
    ],
  };
  const dateTimeRecord: DatabaseRecord = {
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
  return { dateTimeField, dateTimeRecord, dateTimeRow };
}

describe("Database Cells", () => {
  test("creates personal DateTime reminder presets without mutating shared Cell JSON", async () => {
    const { dateTimeField, dateTimeRecord, dateTimeRow } = reminderFixture();
    const gql = vi.fn((request: { mutation?: unknown; query?: unknown }) => {
      const operation = request.query ?? request.mutation;
      if (operation === databaseRowRemindersQuery) {
        return { workspace: { databaseRowReminders: [] } };
      }
      if (operation === setDatabaseRowReminderMutation) {
        return {
          setDatabaseRowReminder: {
            id: "reminder-1",
            offsetMinutes: 10,
            scheduleRevision: 1,
            status: "Scheduled",
            triggerAt: "2030-07-11T08:50:00Z",
          },
        };
      }
      return {};
    });
    renderDatabaseViewHost({
      gql,
      record: dateTimeRecord,
      rows: [dateTimeRow],
    });

    fireEvent.click(screen.getByTestId("database-reminder-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /10 minutes before/ }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: setDatabaseRowReminderMutation,
          variables: {
            input: {
              databaseId: "database-1",
              fieldId: dateTimeField.id,
              offsetMinutes: 10,
              rowId: dateTimeRow.row.id,
            },
          },
        }),
      ),
    );
    expect(gql).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: updateDatabaseCellValueMutation }),
    );
  });

  test("lists and removes all-day reminders and creates a custom offset", async () => {
    const { dateTimeField, dateTimeRecord, dateTimeRow } = reminderFixture({
      allDay: true,
      idSuffix: "-all-day",
    });
    const gql = vi.fn((request: { mutation?: unknown; query?: unknown }) => {
      const operation = request.query ?? request.mutation;
      if (operation === databaseRowRemindersQuery) {
        return {
          workspace: {
            databaseRowReminders: [
              {
                id: "reminder-on-date",
                offsetMinutes: 0,
                scheduleRevision: 1,
                status: "Scheduled",
                triggerAt: "2030-07-11T09:00:00Z",
              },
            ],
          },
        };
      }
      if (operation === deleteDatabaseRowReminderMutation) {
        return { deleteDatabaseRowReminder: true };
      }
      if (operation === setDatabaseRowReminderMutation) {
        return {
          setDatabaseRowReminder: {
            id: "reminder-custom",
            offsetMinutes: 90,
            scheduleRevision: 1,
            status: "Scheduled",
            triggerAt: "2030-07-11T07:30:00Z",
          },
        };
      }
      return {};
    });
    renderDatabaseViewHost({
      gql,
      record: dateTimeRecord,
      rows: [dateTimeRow],
    });

    fireEvent.click(screen.getByTestId("database-reminder-trigger"));
    const onDateReminder = await screen.findByRole("menuitem", {
      name: /On this date at 09:00/,
    });
    await waitFor(() =>
      expect(onDateReminder.getAttribute("data-checked")).toBe("true"),
    );
    fireEvent.click(onDateReminder);
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: deleteDatabaseRowReminderMutation,
          variables: {
            input: {
              databaseId: "database-1",
              reminderId: "reminder-on-date",
            },
          },
        }),
      ),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Custom offset" }), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: setDatabaseRowReminderMutation,
          variables: {
            input: {
              databaseId: "database-1",
              fieldId: dateTimeField.id,
              offsetMinutes: 90,
              rowId: dateTimeRow.row.id,
            },
          },
        }),
      ),
    );
  });

  test("disables personal reminders when the field contract disallows them", () => {
    const { dateTimeRecord, dateTimeRow } = reminderFixture({
      allowReminders: false,
      idSuffix: "-disabled",
    });
    renderDatabaseViewHost({ record: dateTimeRecord, rows: [dateTimeRow] });

    expect(
      (screen.getByTestId("database-reminder-trigger") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("disables personal reminders when the DateTime Cell has no date", () => {
    const { dateTimeRecord, dateTimeRow } = reminderFixture({
      idSuffix: "-empty",
    });
    dateTimeRow.cells.at(-1)!.value.dateTime = null;
    renderDatabaseViewHost({ record: dateTimeRecord, rows: [dateTimeRow] });

    expect(
      (screen.getByTestId("database-reminder-trigger") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test.each(["Confirm"])(
    "commits timed day and time together only on native %s",
    async (submit) => {
      const { dateTimeField, dateTimeRecord, dateTimeRow } = reminderFixture({
        idSuffix: "-confirm",
      });
      const gql = vi.fn(({ query }) => {
        if (query === databaseRowRemindersQuery)
          return { workspace: { databaseRowReminders: [] } };
        if (query === updateDatabaseCellValueMutation)
          return { updateDatabaseCellValue: { editRevision: 1 } };
        return {};
      });
      const framework = {
        get(token: unknown) {
          if (token === GraphQLService) return { gql };
          if (token === WorkspaceServerService) return { server$: undefined };
          throw new Error(`Unexpected framework token: ${String(token)}`);
        },
      } as unknown as FrameworkProvider;
      render(
        <FrameworkRoot framework={framework}>
          <SWRConfigProvider>
            <MyoxusUIProvider>
              <DatabaseConflictProvider>
                <DatabaseCellEditor
                  databaseId="database-1"
                  field={dateTimeField}
                  record={dateTimeRecord}
                  row={dateTimeRow}
                  rows={[dateTimeRow]}
                  onChanged={vi.fn()}
                />
              </DatabaseConflictProvider>
            </MyoxusUIProvider>
          </SWRConfigProvider>
        </FrameworkRoot>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Starts" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "12 July 2030",
          hidden: true,
        }),
      );
      fireEvent.change(
        await screen.findByRole("spinbutton", { name: "Hour", hidden: true }),
        { target: { value: "10" } },
      );
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === updateDatabaseCellValueMutation,
        ),
      ).toHaveLength(0);
      if (submit === "Confirm")
        fireEvent.click(
          screen.getByRole("button", { name: "Confirm", hidden: true }),
        );
      else
        fireEvent.keyDown(
          screen.getByRole("spinbutton", { name: "Hour", hidden: true }),
          { key: "Enter" },
        );
      await waitFor(() =>
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === updateDatabaseCellValueMutation,
          ),
        ).toHaveLength(1),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              expectedEditRevision: 0,
              value: expect.objectContaining({
                dateTime: {
                  start: "2030-07-12T10:00:00.000Z",
                  end: null,
                  allDay: false,
                  timeZone: "UTC",
                },
              }),
            }),
          }),
        }),
      );
      if (submit === "Confirm") {
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Starts" })
              .getAttribute("aria-expanded"),
          ).toBe("false"),
        );
        gql.mockImplementation(({ query }) => {
          if (query === updateDatabaseCellValueMutation)
            throw new Error("MIX_DATABASE_CELL_VALUE_INVALID");
          return { workspace: { databaseRowReminders: [] } };
        });
        fireEvent.click(screen.getByRole("button", { name: "Starts" }));
        fireEvent.click(
          await screen.findByRole("button", {
            name: "13 July 2030",
            hidden: true,
          }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "Confirm", hidden: true }),
        );
        await screen.findByText("Operation failed");
        expect(
          screen.getByRole("button", { name: "Starts" }).textContent,
        ).toContain("07/13/2030");
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === updateDatabaseCellValueMutation,
          ),
        ).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Starts" }));
        expect(
          gql.mock.calls.filter(
            ([request]) => request.query === updateDatabaseCellValueMutation,
          ),
        ).toHaveLength(2);
      }
    },
  );

  test("edits DateTime wall time without dropping range or timezone semantics", () => {
    expect(
      updateDatabaseDateTimeWallTime(
        {
          allDay: false,
          end: "2030-07-11T10:30:00Z",
          start: "2030-07-11T09:00:00Z",
          timeZone: "UTC",
        },
        "2030-07-11 12:00:00",
        "UTC",
      ),
    ).toEqual({
      allDay: false,
      end: "2030-07-11T13:30:00.000Z",
      start: "2030-07-11T12:00:00.000Z",
      timeZone: "UTC",
    });
  });

  test("reports Reminder mutation failures through the global notification system", async () => {
    const { dateTimeRecord, dateTimeRow } = reminderFixture({
      idSuffix: "-error",
    });
    const errorNotification = vi.spyOn(notify, "error");
    const gql = vi.fn((request: { mutation?: unknown; query?: unknown }) => {
      const operation = request.query ?? request.mutation;
      if (operation === databaseRowRemindersQuery) {
        return { workspace: { databaseRowReminders: [] } };
      }
      if (operation === setDatabaseRowReminderMutation) {
        throw new Error("Reminder limit reached");
      }
      return {};
    });
    renderDatabaseViewHost({
      gql,
      record: dateTimeRecord,
      rows: [dateTimeRow],
    });

    fireEvent.click(screen.getByTestId("database-reminder-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /10 minutes before/ }),
    );
    await waitFor(() =>
      expect(errorNotification).toHaveBeenCalledWith({
        title: "Reminder could not be updated",
        message: "Reminder limit reached",
      }),
    );
  });

  test("derives Kanban card accents only from normalized workspace tag roles", () => {
    const tags = [
      { id: "a", color: "tag.red" },
      { id: "b", color: "tag.blue" },
      { id: "invalid", color: "red" },
    ];
    expect(databaseKanbanTagAccentRoles([], tags)).toEqual([]);
    expect(databaseKanbanTagAccentRoles(["a"], tags)).toEqual(["tag.red"]);
    expect(databaseKanbanTagAccentRoles(["a", "a"], tags)).toEqual([
      "tag.red",
      "tag.red",
    ]);
    expect(databaseKanbanTagAccentRoles(["b", "a"], tags)).toEqual([
      "tag.blue",
      "tag.red",
    ]);
    expect(databaseKanbanTagAccentRoles(["invalid", "missing"], tags)).toEqual(
      [],
    );
  });

  test("renders authoritative tag names and archived state instead of UUIDs", () => {
    const tagField: DatabaseField = {
      ...field("field-tags", DatabaseFieldKind.Tags, "Tags", 2),
      config: {
        ...field("field-tags", DatabaseFieldKind.Tags, "Tags", 2).config,
        tags: { maxCount: null },
      },
    };
    const tagIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ];
    const tagRow: DatabaseRowRecord = {
      ...rows[0],
      cells: [
        ...rows[0].cells,
        {
          ...rows[0].cells[0],
          fieldId: tagField.id,
          fieldType: DatabaseFieldKind.Tags,
          value: {
            ...rows[0].cells[0].value,
            kind: DatabaseFieldKind.Tags,
            number: null,
            tags: tagIds,
          },
        },
      ],
    };
    const tagRecord: DatabaseRecord = {
      ...record,
      fields: [...record.fields, tagField],
      views: record.views.map((view) => ({
        ...view,
        config: {
          ...view.config,
          table: view.config.table
            ? {
                ...view.config.table,
                visibleFieldIds: [
                  ...view.config.table.visibleFieldIds,
                  tagField.id,
                ],
              }
            : null,
        },
      })),
    };
    const tagMetas$ = new LiveData([
      { id: tagIds[0], name: "Project", color: "tag.blue" as const },
      {
        id: tagIds[1],
        name: "Historical",
        color: "tag.grey" as const,
        archived: true,
      },
    ]);

    renderDatabaseViewHost({
      record: tagRecord,
      rows: [tagRow],
      tagService: {
        tagColors: [["tag.blue", "tag.blue"]],
        tagList: {
          catalogState$: new LiveData({
            status: "ready",
            tags: tagMetas$.value.map((tag) => ({
              id: tag.id,
              value: tag.name,
              color: tag.color,
              archived: tag.archived,
            })),
            error: null,
          }),
          tagMetas$,
          archiveTag: vi.fn(),
          createTag: vi.fn(),
          deleteTag: vi.fn(),
          restoreTag: vi.fn(),
          retryCatalog: vi.fn(),
          tagByTagId$: vi.fn(() => new LiveData(undefined)),
        },
      },
    });

    expect(screen.getByText("Project")).not.toBeNull();
    expect(screen.getByText("Historical")).not.toBeNull();
    expect(screen.queryByText(tagIds[0])).toBeNull();
    expect(screen.getByLabelText("Historical, Archived")).not.toBeNull();
  });

  test("coalesces fast tag edits into confirmed full-value revision writes", async () => {
    const tagField: DatabaseField = {
      ...field("field-tags", DatabaseFieldKind.Tags, "Tags", 2),
      config: {
        ...field("field-tags", DatabaseFieldKind.Tags, "Tags", 2).config,
        tags: { maxCount: null },
      },
    };
    const tagRow: DatabaseRowRecord = {
      ...rows[0],
      cells: [
        ...rows[0].cells,
        {
          ...rows[0].cells[0],
          editRevision: 1,
          fieldId: tagField.id,
          fieldType: DatabaseFieldKind.Tags,
          value: {
            ...rows[0].cells[0].value,
            kind: DatabaseFieldKind.Tags,
            number: null,
            tags: ["tag-a"],
          },
        },
      ],
      cellRevisions: [
        ...rows[0].cellRevisions,
        {
          editRevision: 1,
          fieldId: tagField.id,
          hasValue: true,
          rowId: rows[0].row.id,
        },
      ],
    };
    const tagRecord: DatabaseRecord = {
      ...record,
      fields: [...record.fields, tagField],
      views: record.views.map((view) => ({
        ...view,
        config: {
          ...view.config,
          table: view.config.table
            ? {
                ...view.config.table,
                visibleFieldIds: [
                  ...view.config.table.visibleFieldIds,
                  tagField.id,
                ],
              }
            : null,
        },
      })),
    };
    const tagMetas$ = new LiveData([
      { id: "tag-a", name: "Alpha", color: "tag.blue" as const },
      { id: "tag-b", name: "Beta", color: "tag.green" as const },
    ]);
    let editRevision = 1;
    const mutate = vi.fn(async ({ query, variables }) => {
      if (query !== updateDatabaseCellValueMutation) return {};
      editRevision += 1;
      return {
        updateDatabaseCellValue: {
          editRevision,
          value: { tags: variables.input.value.tags },
        },
      };
    });

    renderDatabaseViewHost({
      gql: mutate,
      record: tagRecord,
      rows: [tagRow],
      tagService: {
        tagColors: [],
        tagList: {
          catalogState$: new LiveData({
            status: "ready",
            tags: tagMetas$.value.map((tag) => ({
              id: tag.id,
              value: tag.name,
              color: tag.color,
            })),
            error: null,
          }),
          tagMetas$,
          archiveTag: vi.fn(),
          createTag: vi.fn(),
          deleteTag: vi.fn(),
          restoreTag: vi.fn(),
          retryCatalog: vi.fn(),
          tagByTagId$: vi.fn(() => new LiveData(undefined)),
        },
      },
    });

    fireEvent.click(screen.getByText("Alpha"));
    await screen.findAllByTestId("tag-selector-item");
    const option = (id: string) =>
      screen
        .getAllByTestId("tag-selector-item")
        .find((item) => item.dataset.tagId === id)!;
    fireEvent.click(option("tag-b"));
    fireEvent.click(option("tag-a"));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      query: updateDatabaseCellValueMutation,
      variables: {
        input: {
          expectedEditRevision: 1,
          value: { tags: ["tag-b"] },
        },
      },
    });

    fireEvent.click(option("tag-a"));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      query: updateDatabaseCellValueMutation,
      variables: {
        input: {
          expectedEditRevision: 2,
          value: { tags: ["tag-b", "tag-a"] },
        },
      },
    });
  });

  test("writes embedded title edits through the P3 row-title mutation", async () => {
    const { gql, onChanged } = renderDatabaseViewHost();

    fireEvent.doubleClick(screen.getByText("Initial task"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Edited task" } });
    fireEvent.blur(input);

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
              title: "Edited task",
              titleFieldId: "field-title",
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalledWith({
      kind: "row_updated",
      target: { fieldId: "field-title", rowId: "row-1" },
    });
  });

  test("writes embedded cell edits through the P3 cell-value mutation", async () => {
    const { gql, onChanged } = renderDatabaseViewHost();

    fireEvent.doubleClick(screen.getByText("Initial note"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Edited note" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              fieldId: "field-notes",
              force: false,
              rowId: "row-1",
              value: { text: "Edited note" },
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalledWith({
      kind: "cell_updated",
      target: { fieldId: "field-notes", rowId: "row-1" },
    });
  });

  test.each([DatabaseFieldKind.Text, DatabaseFieldKind.RichText])(
    "clears embedded empty %s cell edits through the P3 clear mutation",
    async (kind) => {
      const richText = kind === DatabaseFieldKind.RichText;
      const richDocument = (text: string) => ({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      });
      const editedDocument = richDocument("Edited note");
      const richRecord = structuredClone(record);
      const richField = richRecord.fields.find(
        (field) => field.id === "field-notes",
      )!;
      richField.fieldType = DatabaseFieldKind.RichText;
      richField.config = {
        ...richField.config,
        kind: DatabaseFieldKind.RichText,
        text: null,
        richText: { maxPlainTextBytes: null },
      };
      const richRows = structuredClone(rows.slice(0, 1));
      const richCell = richRows[0]!.cells.find(
        (cell) => cell.fieldId === richField.id,
      )!;
      richCell.fieldType = DatabaseFieldKind.RichText;
      richCell.value = {
        ...richCell.value,
        kind: DatabaseFieldKind.RichText,
        text: null,
        richText: {
          plainText: "Initial note",
          document: richDocument("Initial note"),
        },
      };
      const { gql, onChanged } = renderDatabaseViewHost(
        richText
          ? {
              record: richRecord,
              rows: richRows,
              gql: ({ query }) =>
                query === updateDatabaseCellValueMutation
                  ? { updateDatabaseCellValue: { editRevision: 2 } }
                  : query === clearDatabaseCellValueMutation
                    ? {
                        clearDatabaseCellValue: {
                          editRevision: 3,
                          hasValue: false,
                        },
                      }
                    : {},
            }
          : undefined,
      );
      const user = userEvent.setup();
      if (richText) {
        await user.click(screen.getByText("Initial note"));
        const editor = await waitFor(() => {
          const editor = document.querySelector<HTMLElement>(".ProseMirror");
          if (!editor) throw new Error("RichText editor is not mounted");
          return editor;
        });
        await user.click(editor);
        await user.keyboard("{Control>}a{/Control}");
        fireEvent.paste(editor, {
          clipboardData: {
            files: [],
            getData: () => "Edited note",
            items: [],
            types: ["text/plain"],
          },
        });
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
          expect(gql).toHaveBeenCalledWith(
            expect.objectContaining({
              query: updateDatabaseCellValueMutation,
              variables: {
                input: {
                  databaseId: "database-1",
                  expectedEditRevision: 1,
                  fieldId: "field-notes",
                  force: false,
                  rowId: "row-1",
                  value: { richText: { document: editedDocument } },
                },
              },
            }),
          ),
        );
        await waitFor(() =>
          expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
        );
        await user.click(screen.getByText("Initial note"));
        const nextEditor = await waitFor(() => {
          const editor = document.querySelector<HTMLElement>(".ProseMirror");
          if (!editor) throw new Error("RichText editor is not mounted");
          return editor;
        });
        await user.click(nextEditor);
        await user.keyboard("{Control>}a{/Control}{Backspace}");
        await user.click(screen.getByRole("button", { name: "Save" }));
      } else {
        fireEvent.doubleClick(screen.getByText("Initial note"));
        const input = screen.getByRole("textbox") as HTMLInputElement;
        fireEvent.change(input, { target: { value: "" } });
        fireEvent.blur(input);
      }

      await waitFor(() => {
        expect(gql).toHaveBeenCalledWith(
          expect.objectContaining({
            query: clearDatabaseCellValueMutation,
            variables: {
              input: {
                databaseId: "database-1",
                expectedEditRevision: richText ? 2 : 1,
                fieldId: "field-notes",
                force: false,
                rowId: "row-1",
              },
            },
          }),
        );
      });
      expect(gql).not.toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              value: richText
                ? {
                    richText: {
                      document: {
                        type: "doc",
                        content: [{ type: "paragraph" }],
                      },
                    },
                  }
                : { text: "" },
            }),
          }),
        }),
      );
      expect(onChanged).toHaveBeenCalledWith({
        kind: "cell_updated",
        target: { fieldId: "field-notes", rowId: "row-1" },
      });
    },
  );

  test("edits DocumentLink through the shared permission-filtered picker", async () => {
    const documentLinkField = field(
      "field-document-link",
      DatabaseFieldKind.DocumentLink,
      "Reference",
      2,
    );
    const documentLinkRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: [
        ...rows[0]!.cells,
        {
          ...rows[0]!.cells[0]!,
          fieldId: documentLinkField.id,
          fieldType: DatabaseFieldKind.DocumentLink,
          value: {
            ...rows[0]!.cells[0]!.value,
            documentLink: {
              workspaceId: null,
              docId: "doc-current",
              target: {
                documentId: "doc-current",
                externalId: "doc-current",
                workspaceId: null,
                state: DatabaseRowContentDocumentState.Available,
                title: "Current reference",
              },
            },
            kind: DatabaseFieldKind.DocumentLink,
            text: null,
          },
        },
      ],
    };
    const gql = vi.fn(({ query }) => {
      if (query === indexerSearchDocsQuery) {
        return {
          workspace: {
            searchDocs: [
              {
                docId: "516b8d16-b1e2-4ceb-9490-311b3c8d410c",
                externalId: "doc-next",
                workspaceId: null,
                title: "Next reference",
              },
            ],
          },
        };
      }
      if (query === updateDatabaseCellValueMutation) {
        return { updateDatabaseCellValue: documentLinkRow };
      }
      return {};
    });
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return { gql };
        if (token === WorkspaceServerService) return { server$: undefined };
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseConflictProvider>
              <DatabaseCellEditor
                databaseId="database-1"
                field={documentLinkField}
                record={{
                  ...record,
                  fields: [...record.fields, documentLinkField],
                }}
                row={documentLinkRow}
                rows={[documentLinkRow]}
                onChanged={vi.fn()}
              />
            </DatabaseConflictProvider>
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    fireEvent.click(screen.getByTestId("database-document-link-editor"));
    fireEvent.click(
      await screen.findByTestId("database-document-picker-select-doc-next"),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 0,
              fieldId: documentLinkField.id,
              force: false,
              rowId: "row-1",
              value: {
                documentLink: {
                  docId: "516b8d16-b1e2-4ceb-9490-311b3c8d410c",
                },
              },
            },
          },
        }),
      ),
    );
    expect(screen.queryByTestId("database-row-content-attach")).toBeNull();
  });

  test("loads relation targets through the server rows query and keeps selected pills visible", async () => {
    const sourceRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: [
        {
          editRevision: 1,
          fieldId: relationField.id,
          fieldType: DatabaseFieldKind.Relation,
          rowId: "row-1",
          updatedAt: TIMESTAMP,
          updatedBy: "user-1",
          value: {
            checkbox: null,
            date: null,
            dateTime: null,
            files: null,
            richText: null,
            uniqueId: null,
            kind: DatabaseFieldKind.Relation,
            multiSelect: null,
            tags: null,
            status: null,
            number: null,
            percent: null,
            currency: null,
            duration: null,
            relation: ["row-2", "row-redacted", "row-deleted"],
            relationTargets: [
              {
                deleted: false,
                contentDocument: {
                  documentId: "doc-2",
                  externalId: "doc-2",
                  workspaceId: null,
                  state: DatabaseRowContentDocumentState.Available,
                  title: "Target task content",
                },
                redacted: false,
                rowId: "row-2",
                title: "Target task",
              },
              {
                deleted: false,
                contentDocument: null,
                redacted: true,
                rowId: "row-redacted",
                title: null,
              },
              {
                deleted: true,
                contentDocument: null,
                redacted: true,
                rowId: "row-deleted",
                title: null,
              },
            ],
            rollup: null,
            formula: null,
            select: null,
            text: null,
            user: null,
            users: null,
            documentLink: null,
            url: null,
            email: null,
            phone: null,
            createdTime: null,
            createdBy: null,
            updatedTime: null,
            updatedBy: null,
          },
        },
      ],
    };
    const targetRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: [],
      row: {
        ...rows[0]!.row,
        contentDocument: {
          documentId: "doc-3",
          externalId: "doc-3",
          workspaceId: null,
          state: DatabaseRowContentDocumentState.Available,
          title: "Backlog task content",
        },
        id: "row-3",
        title: "Backlog task",
      },
    };
    const gql = vi.fn().mockResolvedValue({
      workspace: {
        databaseRows: {
          rows: [sourceRow, targetRow],
          totalCount: 2,
        },
      },
    });
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return { gql };
        if (token === WorkspaceServerService) return { server$: undefined };
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseConflictProvider>
              <DatabaseCellEditor
                databaseId="database-1"
                field={relationField}
                record={{
                  ...record,
                  fields: [...record.fields, relationField],
                }}
                row={sourceRow}
                rows={[sourceRow, targetRow]}
                onChanged={vi.fn()}
              />
            </DatabaseConflictProvider>
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    expect(screen.getAllByText("Target task").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("No access to this row document").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Deleted").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: databaseRowsQuery,
          variables: {
            databaseId: "database-1",
            first: 50,
            offset: 0,
            workspaceId: "workspace-1",
          },
        }),
      );
    });
    expect((await screen.findAllByText("Backlog task")).length).toBeGreaterThan(
      0,
    );
  });

  test("renders computed rollup and formula cells as read-only values with status", () => {
    const gql = vi.fn().mockResolvedValue({});
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return { gql };
        if (token === WorkspaceServerService) return { server$: undefined };
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;
    const computedRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: [
        {
          editRevision: 1,
          fieldId: rollupField.id,
          fieldType: DatabaseFieldKind.Rollup,
          rowId: "row-1",
          updatedAt: TIMESTAMP,
          updatedBy: "user-1",
          value: {
            checkbox: null,
            date: null,
            dateTime: null,
            files: null,
            richText: null,
            uniqueId: null,
            kind: DatabaseFieldKind.Rollup,
            multiSelect: null,
            tags: null,
            status: null,
            number: null,
            percent: null,
            currency: null,
            duration: null,
            relation: null,
            relationTargets: null,
            rollup: {
              computedAt: TIMESTAMP,
              errorCode: null,
              errorMessage: null,
              failedAt: null,
              staleState: DatabaseRollupStaleState.Current,
              value: {
                checkbox: null,
                currency: null,
                duration: null,
                date: null,
                kind: DatabaseFieldKind.Number,
                number: 3,
                text: null,
              },
            },
            formula: null,
            select: null,
            text: null,
            user: null,
            users: null,
            documentLink: null,
            url: null,
            email: null,
            phone: null,
            createdTime: null,
            createdBy: null,
            updatedTime: null,
            updatedBy: null,
          },
        },
        {
          editRevision: 1,
          fieldId: formulaField.id,
          fieldType: DatabaseFieldKind.Formula,
          rowId: "row-1",
          updatedAt: TIMESTAMP,
          updatedBy: "user-1",
          value: {
            checkbox: null,
            date: null,
            dateTime: null,
            files: null,
            richText: null,
            uniqueId: null,
            formula: {
              computedAt: TIMESTAMP,
              errorCode: null,
              errorMessage: null,
              failedAt: null,
              staleState: DatabaseFormulaStaleState.Current,
              value: {
                checkbox: null,
                date: null,
                kind: DatabaseFieldKind.Text,
                number: null,
                text: "Initial note ready",
              },
            },
            kind: DatabaseFieldKind.Formula,
            multiSelect: null,
            tags: null,
            status: null,
            number: null,
            percent: null,
            currency: null,
            duration: null,
            relation: null,
            relationTargets: null,
            rollup: null,
            select: null,
            text: null,
            user: null,
            users: null,
            documentLink: null,
            url: null,
            email: null,
            phone: null,
            createdTime: null,
            createdBy: null,
            updatedTime: null,
            updatedBy: null,
          },
        },
      ],
    };

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseConflictProvider>
              <DatabaseCellEditor
                databaseId="database-1"
                field={rollupField}
                record={{
                  ...record,
                  fields: [
                    ...record.fields,
                    relationField,
                    rollupField,
                    formulaField,
                  ],
                }}
                row={computedRow}
                rows={[computedRow]}
                onChanged={vi.fn()}
              />
              <DatabaseCellEditor
                databaseId="database-1"
                field={formulaField}
                record={{
                  ...record,
                  fields: [
                    ...record.fields,
                    relationField,
                    rollupField,
                    formulaField,
                  ],
                }}
                row={computedRow}
                rows={[computedRow]}
                onChanged={vi.fn()}
              />
            </DatabaseConflictProvider>
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    expect(screen.queryByTestId("database-rollup-cell")).not.toBeNull();
    expect(
      screen
        .getByTestId("database-rollup-status")
        .getAttribute("data-rollup-state"),
    ).toBe(DatabaseRollupStaleState.Current);
    expect(screen.getByText("3").textContent).toBe("3");
    expect(screen.queryByTestId("database-formula-cell")).not.toBeNull();
    expect(
      screen
        .getByTestId("database-formula-status")
        .getAttribute("data-formula-state"),
    ).toBe(DatabaseFormulaStaleState.Current);
    expect(screen.getByText("Initial note ready").textContent).toBe(
      "Initial note ready",
    );
    expect(screen.getAllByText("Current")).toHaveLength(2);
    fireEvent.doubleClick(screen.getByText("3"));
    fireEvent.doubleClick(screen.getByText("Initial note ready"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });

  test("commits Project progress and ordinal drafts once at the native slider boundary", async () => {
    const progress = {
      ...field(
        "field-project-progress",
        DatabaseFieldKind.Percent,
        "Progress",
        3,
      ),
      config: {
        ...field(
          "field-project-progress",
          DatabaseFieldKind.Percent,
          "Progress",
          3,
        ).config,
        percent: { minValue: 0, maxValue: 100 },
      },
    } as DatabaseField;
    const priority = {
      ...field(
        "field-project-priority",
        DatabaseFieldKind.Select,
        "Priority",
        4,
      ),
      config: {
        ...field(
          "field-project-priority",
          DatabaseFieldKind.Select,
          "Priority",
          4,
        ).config,
        select: {
          options: [
            { colorRole: "gray", id: "low", name: "Low", position: 0 },
            { colorRole: "blue", id: "normal", name: "Normal", position: 1 },
            { colorRole: "red", id: "high", name: "High", position: 2 },
          ],
        },
      },
    } as DatabaseField;
    const projectRow = {
      ...rows[0]!,
      cellRevisions: [
        {
          editRevision: 1,
          fieldId: progress.id,
          hasValue: true,
          rowId: "row-1",
        },
        {
          editRevision: 1,
          fieldId: priority.id,
          hasValue: true,
          rowId: "row-1",
        },
      ],
      cells: [
        {
          ...rows[0]!.cells[0]!,
          fieldId: progress.id,
          fieldType: DatabaseFieldKind.Percent,
          value: {
            ...rows[0]!.cells[0]!.value,
            kind: DatabaseFieldKind.Percent,
            percent: 40,
            text: null,
          },
        },
        {
          ...rows[0]!.cells[0]!,
          fieldId: priority.id,
          fieldType: DatabaseFieldKind.Select,
          value: {
            ...rows[0]!.cells[0]!.value,
            kind: DatabaseFieldKind.Select,
            select: "normal",
            text: null,
          },
        },
      ],
    } as DatabaseRowRecord;
    const gql = vi.fn(({ query }) =>
      query === updateDatabaseCellValueMutation
        ? { updateDatabaseCellValue: projectRow }
        : {},
    );
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return { gql };
        if (token === WorkspaceServerService) return { server$: undefined };
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseConflictProvider>
              <DatabaseCellEditor
                databaseId="database-1"
                field={progress}
                record={{ ...record, fields: [progress, priority] }}
                row={projectRow}
                rows={[projectRow]}
                onChanged={vi.fn()}
                semanticRoleKey="task.progress"
              />
              <DatabaseCellEditor
                databaseId="database-1"
                field={priority}
                record={{ ...record, fields: [progress, priority] }}
                row={projectRow}
                rows={[projectRow]}
                onChanged={vi.fn()}
                semanticRoleKey="task.priority"
              />
              <DatabaseCellEditor
                databaseId="database-1"
                field={{ ...priority, name: "Unset priority" }}
                record={{ ...record, fields: [progress, priority] }}
                row={{
                  ...projectRow,
                  cells: projectRow.cells.filter(
                    (cell) => cell.fieldId !== priority.id,
                  ),
                }}
                rows={[projectRow]}
                onChanged={vi.fn()}
                semanticRoleKey="task.priority"
              />
              <DatabaseCellEditor
                databaseId="database-1"
                field={priority}
                record={{ ...record, fields: [priority] }}
                row={{ ...projectRow, cells: [] }}
                rows={[]}
                onChanged={vi.fn()}
                semanticRoleKey="task.priority"
                readonly
              />
            </DatabaseConflictProvider>
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    expect(screen.getAllByText("Empty")).toHaveLength(2);
    expect(screen.getAllByText("Low")).toHaveLength(2);
    expect(
      screen.getByRole("slider", { name: "Unset priority" }),
    ).toBeDefined();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Progress" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Priority" }), {
      key: "End",
    });

    await waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
    expect(gql).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: updateDatabaseCellValueMutation,
        variables: {
          input: {
            databaseId: "database-1",
            expectedEditRevision: 1,
            fieldId: progress.id,
            force: false,
            rowId: "row-1",
            value: { percent: 41 },
          },
        },
      }),
    );
    expect(gql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: updateDatabaseCellValueMutation,
        variables: {
          input: {
            databaseId: "database-1",
            expectedEditRevision: 1,
            fieldId: priority.id,
            force: false,
            rowId: "row-1",
            value: { select: "high" },
          },
        },
      }),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("Project Parent property consuming the native Cell owner", () => {
  test("searches and pages same-Project Open and Closed Tasks, retaining a typed rejected draft", async () => {
    const gql = vi.fn(async ({ query, variables }) => {
      if (query === databaseTaskParentQuery) return parentRead();
      if (query === databaseTasksQuery) {
        const closed =
          variables.input.lifecycle === DatabaseTaskLifecycle.Closed;
        const searched = variables.input.search === "Deep parent";
        return {
          workspace: {
            databaseTasks: {
              rows: searched
                ? [parentTask("deep-task", "Deep parent")]
                : variables.after
                  ? [parentTask("older-task", "Older completed parent")]
                  : closed
                    ? [parentTask("closed-task", "Completed parent")]
                    : [
                        parentTask("row-1", "Self Task"),
                        parentTask("open-task", "Open parent"),
                      ],
              totalCount: 120,
              projectCount: 1,
              nextCursor:
                !searched && closed && !variables.after ? "closed-next" : null,
            },
          },
        };
      }
      if (query === updateDatabaseCellValueMutation)
        throw {
          extensions: {
            code: "MIX_DATABASE_TASK_RELATION_INVALID",
            reason: DatabaseTaskRelationReason.Cycle,
          },
        };
      throw new Error("Unexpected Parent request");
    });
    const f = parentEditorFixture(gql);
    render(f.surface());
    const picker = await screen.findByRole("combobox", { name: "Parent Task" });
    fireEvent.click(picker);
    await screen.findByRole("option", { name: "Completed parent" });
    expect(
      screen.getByRole("option", { name: "Open parent" }).textContent,
    ).toContain("Open parent");
    expect(screen.queryByRole("option", { name: "Self Task" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Phase" })).toBeNull();
    const viewport = screen
      .getByRole("option", { name: "Completed parent" })
      .closest<HTMLElement>("[data-scrollarea-viewport]")!;
    // HappyDOM has no layout; supply the native scroll extent, then exercise
    // ScrollArea's actual DOM onScroll/onBottomReached delivery.
    Object.defineProperties(viewport, {
      scrollHeight: { value: 800 },
      clientHeight: { value: 200 },
    });
    fireEvent.scroll(viewport, { target: { scrollTop: 600 } });
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
    fireEvent.scroll(viewport, { target: { scrollTop: 600 } });
    await screen.findByRole("option", { name: "Older completed parent" });
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: databaseTasksQuery,
        variables: {
          workspaceId: "workspace-1",
          input: {
            scope: DatabaseTaskScope.All,
            lifecycle: DatabaseTaskLifecycle.Closed,
            projectIds: ["database-1"],
            search: "",
            timeZone: "UTC",
          },
          first: 50,
          after: "closed-next",
        },
      }),
    );
    expect(
      gql.mock.calls.filter(
        ([request]) =>
          request.query === databaseTasksQuery &&
          request.variables.after === "closed-next",
      ),
    ).toHaveLength(1);
    fireEvent.change(picker, { target: { value: "Deep parent" } });
    fireEvent.click(await screen.findByRole("option", { name: "Deep parent" }));
    expect(
      (await screen.findByText("This parent would create a cycle."))
        .textContent,
    ).toBe("This parent would create a cycle.");
    expect(
      within(
        picker.closest<HTMLElement>(
          '[data-myoxus-ui-role="form-multi-select-root"]',
        )!,
      ).getByText("Deep parent").textContent,
    ).toBe("Deep parent");
    expect(
      gql.mock.calls.filter(([request]) => request.query === databaseRowsQuery),
    ).toHaveLength(0);
    const writes = gql.mock.calls.filter(
      ([request]) => request.query === updateDatabaseCellValueMutation,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]![0].variables).toEqual({
      input: {
        databaseId: "database-1",
        rowId: "row-1",
        fieldId: relationField.id,
        expectedEditRevision: 7,
        force: false,
        value: { relation: ["deep-task"] },
      },
    });
    expect(f.onChanged).not.toHaveBeenCalled();
  });

  test("clears an invalid edge canonically and bounds an unavailable managed schema without repair", async () => {
    let capability = parentRead({
      parentRowIds: ["legacy-parent"],
      diagnostics: [DatabaseTaskRelationReason.Cycle],
    });
    const gql = vi.fn(async ({ query }) => {
      if (query === databaseTaskParentQuery) return capability;
      if (query === clearDatabaseCellValueMutation) {
        capability = parentRead();
        return { clearDatabaseCellValue: { editRevision: 8, hasValue: false } };
      }
      throw new Error("No candidate read required to remove an invalid edge");
    });
    const f = parentEditorFixture(gql);
    f.parentRow.cells = [
      {
        ...rows[0]!.cells[0]!,
        fieldId: relationField.id,
        fieldType: DatabaseFieldKind.Relation,
        editRevision: 7,
        value: {
          ...rows[0]!.cells[0]!.value,
          kind: DatabaseFieldKind.Relation,
          text: null,
          richText: null,
          relation: ["legacy-parent"],
          relationTargets: [
            {
              rowId: "legacy-parent",
              title: null,
              deleted: false,
              redacted: true,
              contentDocument: null,
            },
          ],
        },
      },
    ];
    f.parentRow.cellRevisions = [
      {
        rowId: "row-1",
        fieldId: relationField.id,
        editRevision: 7,
        hasValue: true,
      },
    ];
    const mounted = render(f.surface());
    await screen.findByText("This parent would create a cycle.");
    const parentControl = screen
      .getByRole("combobox", { name: "Parent Task" })
      .closest<HTMLElement>('[data-myoxus-ui-role="form-multi-select-root"]')!;
    // Retained hidden dropdown options repeat this label; assert the selected
    // native Pill rather than treating option text as a committed selection.
    expect(
      parentControl.querySelector(".mantine-Pill-label")?.textContent,
    ).toBe("Unavailable");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Parent Task" }), {
      key: "Backspace",
    });
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: clearDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: "database-1",
              rowId: "row-1",
              fieldId: relationField.id,
              expectedEditRevision: 7,
              force: false,
            },
          },
        }),
      ),
    );
    await screen.findByRole("combobox", { name: "Parent Task" });
    await waitFor(() =>
      expect(
        screen.queryByText("This parent would create a cycle."),
      ).toBeNull(),
    );
    const reads = () =>
      gql.mock.calls.filter(
        ([request]) => request.query === databaseTaskParentQuery,
      ).length;
    const beforeField = reads();
    capability = parentRead({
      available: false,
      diagnostics: [DatabaseTaskRelationReason.IncompatibleRoleConfiguration],
    });
    const changedField = {
      ...f.parentField,
      editRevision: f.parentField.editRevision + 1,
    };
    f.project.fields = f.project.fields.map((field) =>
      field.id === changedField.id ? changedField : field,
    );
    mounted.rerender(f.surface(f.parentRow, changedField));
    await screen.findByText("This Project has no compatible parent field.");
    expect(reads()).toBeGreaterThan(beforeField);
    mounted.unmount();
    f.project.managedSchema = {
      ...f.project.managedSchema!,
      readiness: DatabaseManagedSchemaReadiness.Unavailable,
      reasonCode: "MANAGED_STRUCTURE_MISMATCH",
      canEditStructure: false,
      canEditMetadata: false,
      canManageLifecycle: false,
      taskBindings: [],
    };
    const unavailableHost = renderDatabaseViewHost({
      record: f.project,
      rows: [f.parentRow],
    });
    await screen.findByText(
      "This destination has changed. Reload its current state.",
    );
    expect(screen.queryByRole("combobox", { name: "Parent Task" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add property/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(unavailableHost.onChanged).toHaveBeenCalledTimes(1);
    expect(
      unavailableHost.gql.mock.calls.some(
        ([request]) =>
          request.query === updateDatabaseCellValueMutation ||
          request.query === clearDatabaseCellValueMutation,
      ),
    ).toBe(false);
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === updateDatabaseCellValueMutation,
      ),
    ).toHaveLength(0);
  });

  test("keeps a real Cell conflict open, then dismisses it on actor change and ignores a later disposed conflict", async () => {
    let rejectLate!: (reason: unknown) => void;
    let writes = 0;
    let latestReadUsed = false;
    const gql = vi.fn(async ({ query, variables }) => {
      if (query === databaseTaskParentQuery) {
        if (writes === 1 && !latestReadUsed) {
          latestReadUsed = true;
          return parentRead({ parentRowIds: ["existing-parent"] });
        }
        return parentRead();
      }
      if (query === databaseTaskReferencesQuery)
        return {
          workspace: {
            id: "workspace-1",
            databaseTaskReferences: variables.targets.map(
              (target: {
                workspaceId: string;
                databaseId: string;
                rowId: string;
              }) => ({
                ...target,
                state: DatabaseTaskReferenceState.Available,
                task: parentTask(target.rowId, "Authorized latest parent"),
              }),
            ),
          },
        };
      if (query === databaseTasksQuery)
        return {
          workspace: {
            databaseTasks: {
              rows: [parentTask("parent", "Canonical parent")],
              totalCount: 1,
              projectCount: 1,
              nextCursor: null,
            },
          },
        };
      if (query === updateDatabaseCellValueMutation) {
        if (++writes === 1) throw parentConflict();
        return new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      }
      throw new Error("Unexpected conflict request");
    });
    const f = parentEditorFixture(gql);
    render(f.surface());
    const choose = async () => {
      fireEvent.click(
        await screen.findByRole("combobox", { name: "Parent Task" }),
      );
      fireEvent.click(
        await screen.findByRole("option", { name: "Canonical parent" }),
      );
    };
    await choose();
    const modal = await screen.findByTestId("database-conflict-modal");
    expect(
      within(modal).getByTestId("database-conflict-latest").textContent,
    ).toBe("Authorized latest parent");
    expect(
      within(modal).getByTestId("database-conflict-local").textContent,
    ).toBe("Canonical parent");
    expect(
      within(modal).getByTestId("database-conflict-local").textContent,
    ).not.toContain('["');
    expect(within(modal).queryByText("Private latest parent")).toBeNull();
    expect(screen.getByTestId("database-conflict-modal")).toBe(modal);
    act(() => f.account$.setValue({ id: "second-actor" }));
    await waitFor(() =>
      expect(screen.queryByTestId("database-conflict-modal")).toBeNull(),
    );
    await choose();
    await waitFor(() => expect(writes).toBe(2));
    act(() => f.account$.setValue({ id: "third-actor" }));
    await act(async () => {
      rejectLate(parentConflict("Disposed actor latest parent"));
    });
    await screen.findByRole("combobox", { name: "Parent Task" });
    expect(screen.queryByTestId("database-conflict-modal")).toBeNull();
    expect(screen.queryByText("Disposed actor latest parent")).toBeNull();
    expect(writes).toBe(2);
  });

  test("drops late candidate titles when the current server identity changes", async () => {
    const oldReads: ((value: unknown) => void)[] = [];
    let oldReadSignal: AbortSignal | undefined;
    const gql = vi.fn(async ({ query, context }) => {
      if (query === databaseTaskParentQuery) return parentRead();
      if (query === databaseTasksQuery) {
        oldReadSignal = context.signal;
        return new Promise((resolve) => {
          oldReads.push(resolve);
        });
      }
      throw new Error("Unexpected candidate request");
    });
    const f = parentEditorFixture(gql);
    render(f.surface());
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Parent Task" }),
    );
    await waitFor(() => expect(oldReads).toHaveLength(2));
    act(() =>
      f.server$.setValue({
        ...f.server$.value,
        id: "new-server",
        baseUrl: "https://different.test",
      }),
    );
    await act(async () => {
      for (const resolve of oldReads)
        resolve({
          workspace: {
            databaseTasks: {
              rows: [parentTask("old-private", "Old server private title")],
              nextCursor: null,
              totalCount: 1,
              projectCount: 1,
            },
          },
        });
    });
    expect(oldReadSignal?.aborted).toBe(true);
    expect(screen.queryByText("Old server private title")).toBeNull();
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === updateDatabaseCellValueMutation,
      ),
    ).toHaveLength(0);
  });
});

test.each([true])(
  "removing the last native Users selection preserves required empty-list vs optional Clear (required=%s)",
  async (required) => {
    const people: DatabaseField = {
      ...relationField,
      fieldType: DatabaseFieldKind.Users,
      required,
      name: "Assignees",
      config: {
        ...relationField.config,
        kind: DatabaseFieldKind.Users,
        relation: null,
      },
    };
    const member = {
      id: "assigned-person",
      name: "Assigned person",
      email: "assigned@myoxus.test",
      avatarUrl: "",
    };
    const member$ = new LiveData(member);
    const loading$ = new LiveData(false);
    const publicUsers = {
      publicUser$: () => member$,
      isLoading$: () => loading$,
      revalidate: vi.fn(),
    };
    const search = {
      result$: new LiveData([member]),
      reset: vi.fn(),
      loadMore: vi.fn(),
      search: vi.fn(),
    };
    const selectedRow: DatabaseRowRecord = {
      ...rows[0]!,
      cells: [
        {
          ...rows[0]!.cells[0]!,
          fieldId: people.id,
          fieldType: DatabaseFieldKind.Users,
          editRevision: 7,
          value: {
            ...rows[0]!.cells[0]!.value,
            kind: DatabaseFieldKind.Users,
            users: [member.id],
          },
        },
      ],
      cellRevisions: [
        {
          fieldId: people.id,
          rowId: rows[0]!.row.id,
          editRevision: 7,
          hasValue: true,
        },
      ],
    };
    const gql = vi.fn(async ({ query }) => {
      if (query === updateDatabaseCellValueMutation)
        return { updateDatabaseCellValue: { editRevision: 8 } };
      if (query === clearDatabaseCellValueMutation)
        return { clearDatabaseCellValue: { editRevision: 8, hasValue: false } };
      throw new Error("Unexpected Users mutation");
    });
    const graphql = { gql };
    const servers = { server$: undefined };
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return graphql;
        if (token === WorkspaceServerService) return servers;
        if (token === PublicUserService) return publicUsers;
        if (token === MemberSearchService) return search;
        throw new Error(`Unexpected Users service ${String(token)}`);
      },
    } as unknown as FrameworkProvider;
    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider env="test">
            <DatabaseConflictProvider>
              <DatabaseCellEditor
                databaseId={record.database.id}
                field={people}
                record={{ ...record, fields: [...record.fields, people] }}
                row={selectedRow}
                rows={[selectedRow]}
                onChanged={vi.fn()}
              />
            </DatabaseConflictProvider>
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "A Assigned person" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Remove Assigned person",
      }),
    );
    await waitFor(() =>
      expect(gql).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          query: required
            ? updateDatabaseCellValueMutation
            : clearDatabaseCellValueMutation,
          variables: {
            input: {
              databaseId: record.database.id,
              rowId: selectedRow.row.id,
              fieldId: people.id,
              expectedEditRevision: 7,
              force: false,
              ...(required ? { value: { users: [] } } : {}),
            },
          },
        }),
      ),
    );
  },
);
