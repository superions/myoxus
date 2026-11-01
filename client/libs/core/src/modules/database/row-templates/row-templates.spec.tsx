// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { readyManagedRecord } from "../test-fixtures";
import { notify } from "@myoxus/ui-facade";
import {
  createDatabaseRowFromTemplateMutation,
  databaseTasksQuery,
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  databaseRowsQuery,
  DatabaseProfileKind,
  DatabaseManagedSchemaReadiness,
  DatabaseFieldKind,
  DatabaseTaskLifecycle,
  DatabaseTaskScope,
  createDatabaseRowMutation,
  updateDatabaseRowTemplateMutation,
  deleteDatabaseRowTemplateMutation,
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
import { describe, expect, test, vi } from "vitest";

import {
  record,
  rows,
  titleField,
  field,
  notesField,
  relationField,
  rowTemplates,
  TIMESTAMP,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";

const templateSocket = vi.hoisted(() => ({
  id: "template-parent-socket",
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  emitWithAck: vi.fn(async () => ({
    data: { clientId: "template-parent-socket", success: true },
  })),
}));
vi.mock("@myoxus/storage/cloud", async (original) => ({
  ...(await original<typeof import("@myoxus/storage/cloud")>()),
  SocketConnection: class {
    status = "connected";
    maybeConnection = { socket: templateSocket };
    onStatusChanged() {
      return () => {};
    }
    connect() {}
    disconnect() {}
  },
}));

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (original) => ({
    ...(await original<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalPreferences: () => ({
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    }),
  }),
);

describe("Database Row templates", () => {
  test("offers row template creation without hiding empty row creation", async () => {
    const { gql, onChanged } = renderDatabaseViewHost({ rowTemplates });

    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getByTestId("database-table-view")).toBeTruthy();
    const tableGrid = screen.getByTestId("database-table-grid");
    expect(tableGrid.tagName).toBe("TABLE");
    expect(tableGrid.getAttribute("data-myoxus-ui-role")).toBe("table");
    expect(screen.queryByTestId("database-new-row-action")).toBeNull();
    expect(
      screen
        .getByTestId("database-new-row")
        .closest("[data-testid='database-table-grid']"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("database-new-row-menu"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Task template/ }),
    );

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowFromTemplateMutation,
          variables: {
            input: {
              databaseId: "database-1",
              rowTemplateId: "row-template-default",
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();

    cleanup();
    const { gql: emptyGql } = renderDatabaseViewHost();
    fireEvent.click(screen.getByTestId("database-new-row"));

    await waitFor(() => {
      expect(emptyGql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: {
            input: {
              databaseId: "database-1",
              title: "Untitled row",
            },
          },
        }),
      );
    });
  });

  test("shows row template management and writes initial cell values through GraphQL", async () => {
    const { gql, onChanged } = renderDatabaseViewHost({ rowTemplates });

    fireEvent.click(screen.getByTestId("database-new-row-menu"));
    fireEvent.click(await screen.findByText("Row templates"));

    expect(await screen.findByText("Task template")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getAllByText("Needs reconcile").length).toBeGreaterThan(0);
    expect(screen.getByText("Reconcile required")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("Seed note"), {
      target: { value: "Updated seed" },
    });

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowTemplateMutation,
          variables: {
            input: {
              rowTemplateId: "row-template-default",
              expectedEditRevision: 1,
              initialCellValues: [
                {
                  fieldId: notesField.id,
                  value: { text: "Updated seed" },
                },
              ],
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  test("persists row template ordering through dense position updates", async () => {
    const { gql, onChanged } = renderDatabaseViewHost({ rowTemplates });

    fireEvent.click(screen.getByTestId("database-new-row-menu"));
    fireEvent.click(await screen.findByText("Row templates"));
    const moveUpButtons = await screen.findAllByRole("button", {
      name: "Move template up",
    });
    const enabledMoveUpButton = moveUpButtons.find(
      (button) => !(button as HTMLButtonElement).disabled,
    );
    expect(enabledMoveUpButton).toBeTruthy();
    fireEvent.click(enabledMoveUpButton!);

    await waitFor(() => {
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowTemplateMutation,
          variables: {
            input: {
              rowTemplateId: "row-template-reconcile",
              expectedEditRevision: 1,
              position: 0,
            },
          },
        }),
      );
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowTemplateMutation,
          variables: {
            input: {
              rowTemplateId: "row-template-default",
              expectedEditRevision: 1,
              position: 1,
            },
          },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });
});

test.each([["task.parent", "Cycle"]] as const)(
  "Template %s uses bounded Task pages and retains a rejected/uncertain %s draft",
  async (roleKey, reason) => {
    const parent = {
      ...relationField,
      name: "Template parent",
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
      ...record,
      database: {
        ...record.database,
        profileKind: DatabaseProfileKind.Project,
      },
      fields: [...record.fields, parent],
      fieldRoles: [
        {
          databaseId: record.database.id,
          profileKind: DatabaseProfileKind.Project,
          roleKey,
          rowKindScope: "task",
          fieldId: parent.id,
          required: false,
          config: {},
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    };
    const binding = structuredClone(rowTemplates[0]!);
    binding.rowTemplate.rowKind = "task";
    binding.rowTemplate.initialCellValues = [];
    let attempts = 0;
    const gql = vi.fn(
      async (request: {
        query?: unknown;
        variables?: {
          after?: string;
          targets?: {
            workspaceId: string;
            databaseId: string;
            rowId: string;
          }[];
          input?: { lifecycle?: DatabaseTaskLifecycle; search?: string };
        };
      }) => {
        if (request.query === databaseTaskReferencesQuery)
          return {
            workspace: {
              id: "workspace-1",
              databaseTaskReferences: request.variables!.targets!.map(
                (target) => ({
                  ...target,
                  state: DatabaseTaskReferenceState.Available,
                  task: {
                    ...target,
                    title: "Authorized retained prerequisite",
                  },
                }),
              ),
            },
          };
        if (request.query === databaseTasksQuery) {
          const input = request.variables!.input!;
          const closed = input.lifecycle === DatabaseTaskLifecycle.Closed;
          return {
            workspace: {
              databaseTasks: {
                rows: closed
                  ? request.variables?.after
                    ? [
                        {
                          workspaceId: "workspace-1",
                          databaseId: "database-1",
                          rowId: "offpage-task",
                          title: "Completed off-page parent",
                        },
                      ]
                    : [
                        {
                          workspaceId: "workspace-1",
                          databaseId: "database-1",
                          rowId: "completed-task",
                          title: "Completed candidate",
                        },
                      ]
                  : [],
                nextCursor:
                  closed && !request.variables?.after ? "closed-page-2" : null,
              },
            },
          };
        }
        if (request.query === updateDatabaseRowTemplateMutation) {
          attempts++;
          if (attempts === 1) {
            throw {
              extensions: {
                code: "MIX_DATABASE_TASK_RELATION_INVALID",
                reason,
              },
            };
          }
          return { updateDatabaseRowTemplate: binding };
        }
        return {};
      },
    );
    const f = renderDatabaseViewHost({
      record: readyManagedRecord(project),
      rows: [
        ...rows,
        {
          ...rows[0]!,
          row: {
            ...rows[0]!.row,
            id: "phase",
            rowKind: "phase",
            title: "Not a Task phase",
          },
        },
      ],
      rowTemplates: [binding],
      gql,
    });
    const user = userEvent.setup();
    const invokingRow = screen
      .getByRole("checkbox", {
        name: `Select row: ${rows[0]!.row.title}`,
      })
      .closest("tr")!;
    await user.click(within(invokingRow).getByTestId("database-new-row-menu"));
    await user.click(await screen.findByText("Row templates"));
    const picker = await screen.findByRole("combobox", {
      name: "Template parent",
    });
    await user.click(picker);
    const candidate = await screen.findByRole("option", {
      name: "Completed candidate",
    });
    expect(
      screen.queryByRole("option", { name: "Not a Task phase" }),
    ).toBeNull();
    const viewport = candidate.closest<HTMLElement>(
      "[data-scrollarea-viewport]",
    )!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 800 },
      clientHeight: { value: 200 },
    });
    fireEvent.scroll(viewport, { target: { scrollTop: 600 } });
    await user.click(
      await screen.findByRole("option", { name: "Completed off-page parent" }),
    );
    await screen.findByText("This parent would create a cycle.");
    const control = picker.closest<HTMLElement>(
      '[data-myoxus-ui-role="form-multi-select-root"]',
    )!;
    expect(
      [...control.querySelectorAll(".mantine-Pill-label")].map(
        (pill) => pill.textContent,
      ),
    ).toEqual(["Completed off-page parent"]);
    expect(document.activeElement).toBe(picker);
    expect(attempts).toBe(1);
    expect(f.onChanged).not.toHaveBeenCalled();
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
          after: "closed-page-2",
        },
      }),
    );
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: updateDatabaseRowTemplateMutation,
        variables: {
          input: {
            rowTemplateId: binding.rowTemplate.id,
            expectedEditRevision: 1,
            initialCellValues: [
              {
                fieldId: parent.id,
                value: {
                  relation: ["offpage-task"],
                },
              },
            ],
          },
        },
      }),
    );
    expect(
      gql.mock.calls.filter(([request]) => request.query === databaseRowsQuery),
    ).toHaveLength(0);
    // Only an explicit user removal produces the second write; rejected/unknown
    // completion itself never replays the attempted relation assignment.
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() =>
      expect(
        [...control.querySelectorAll(".mantine-Pill-label")].map(
          (pill) => pill.textContent,
        ),
      ).toEqual([]),
    );
    expect(gql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: updateDatabaseRowTemplateMutation,
        variables: {
          input: {
            rowTemplateId: binding.rowTemplate.id,
            expectedEditRevision: 1,
            initialCellValues: [],
          },
        },
      }),
    );
  },
);

test("Template Parent resolves stored off-page identity and retains confirmed edits until canonical props arrive", async () => {
  const parent = {
    ...relationField,
    name: "Stored parent",
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
    ...record,
    database: { ...record.database, profileKind: DatabaseProfileKind.Project },
    fields: [...record.fields, parent],
    fieldRoles: [
      {
        databaseId: record.database.id,
        profileKind: DatabaseProfileKind.Project,
        roleKey: "task.parent",
        rowKindScope: "task",
        fieldId: parent.id,
        required: false,
        config: {},
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
  };
  const binding = structuredClone(rowTemplates[0]!);
  binding.rowTemplate.rowKind = "task";
  const setCanonical = (ids: string[]) => {
    binding.rowTemplate.initialCellValues = ids.length
      ? [
          {
            ...rowTemplates[0]!.rowTemplate.initialCellValues[0]!,
            fieldId: parent.id,
            fieldType: DatabaseFieldKind.Relation,
            value: {
              ...rowTemplates[0]!.rowTemplate.initialCellValues[0]!.value,
              kind: DatabaseFieldKind.Relation,
              text: null,
              relation: ids,
            },
          },
        ]
      : [];
  };
  setCanonical(["saved-offpage"]);
  let unavailable = false;
  const gql = vi.fn(
    async (request: {
      query?: unknown;
      variables?: {
        targets?: { workspaceId: string; databaseId: string; rowId: string }[];
        input?: { lifecycle?: DatabaseTaskLifecycle };
      };
    }) => {
      if (request.query === databaseTaskReferencesQuery)
        return {
          workspace: {
            id: "workspace-1",
            databaseTaskReferences: request.variables!.targets!.map(
              (target) => ({
                ...target,
                state: unavailable
                  ? DatabaseTaskReferenceState.Trashed
                  : DatabaseTaskReferenceState.Available,
                task: unavailable
                  ? null
                  : {
                      ...target,
                      title:
                        target.rowId === "saved-offpage"
                          ? "Authorized off-page parent"
                          : "New authorized parent",
                    },
              }),
            ),
          },
        };
      if (request.query === databaseTasksQuery)
        return {
          workspace: {
            databaseTasks: {
              rows:
                request.variables?.input?.lifecycle ===
                DatabaseTaskLifecycle.Open
                  ? [
                      {
                        workspaceId: "workspace-1",
                        databaseId: "database-1",
                        rowId: "new-parent",
                        title: "New authorized parent",
                      },
                    ]
                  : [],
              nextCursor: null,
            },
          },
        };
      if (request.query === updateDatabaseRowTemplateMutation)
        return { updateDatabaseRowTemplate: binding };
      return {};
    },
  );
  const f = renderDatabaseViewHost({
    record: readyManagedRecord(project),
    rowTemplates: [binding],
    gql,
  });
  const user = userEvent.setup();
  await user.click(screen.getByTestId("database-new-row-menu"));
  await user.click(await screen.findByText("Row templates"));
  const picker = await screen.findByRole("combobox", { name: "Stored parent" });
  const control = picker.closest<HTMLElement>(
    '[data-myoxus-ui-role="form-multi-select-root"]',
  )!;
  const pill = () =>
    control.querySelector(".mantine-Pill-label")?.textContent ?? null;
  await waitFor(() => expect(pill()).toBe("Authorized off-page parent"));
  expect(gql).toHaveBeenCalledWith(
    expect.objectContaining({
      query: databaseTaskReferencesQuery,
      variables: {
        workspaceId: "workspace-1",
        targets: [
          {
            workspaceId: "workspace-1",
            databaseId: "database-1",
            rowId: "saved-offpage",
          },
        ],
      },
    }),
  );
  expect(
    gql.mock.calls.filter(([request]) => request.query === databaseTasksQuery),
  ).toHaveLength(0);
  picker.focus();
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledTimes(1));
  f.rerender(readyManagedRecord(project), rows);
  expect(pill()).toBeNull();
  // ACK precedes host canonical delivery: old props cannot roll back Clear.
  setCanonical([]);
  f.rerender(readyManagedRecord(project), rows);
  await user.click(picker);
  await user.click(
    await screen.findByRole("option", { name: "New authorized parent" }),
  );
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledTimes(2));
  f.rerender(readyManagedRecord(project), rows);
  expect(pill()).toBe("New authorized parent");
  expect(document.activeElement).toBe(picker);
  // Matching props release the local intent; subsequent lifecycle metadata is
  // still read from SQL rather than the remembered selection's display label.
  setCanonical(["new-parent"]);
  f.rerender(readyManagedRecord(project), rows);
  await waitFor(() => expect(pill()).toBe("New authorized parent"));
  unavailable = true;
  act(() => {
    for (const [event, listener] of templateSocket.on.mock.calls)
      if (event === "database:tasks-changed")
        listener({
          workspaceId: "workspace-1",
          databaseId: "database-1",
          eventId: "target-trashed",
        });
  });
  await waitFor(() => expect(pill()).toBe("Unavailable"));
  expect(screen.getByRole("combobox", { name: "Stored parent" })).toBe(picker);
  expect(
    gql.mock.calls.filter(
      ([request]) => request.query === updateDatabaseRowTemplateMutation,
    ),
  ).toHaveLength(2);
});

test.each([["phase", "task.parent"]] as const)(
  "a %s template preserves its generic Relation owner despite a shared %s field",
  async (rowKind, roleKey) => {
    const parent = { ...relationField, name: "Shared relation" };
    const project = {
      ...record,
      database: {
        ...record.database,
        profileKind: DatabaseProfileKind.Project,
      },
      fields: [...record.fields, parent],
      fieldRoles: [
        {
          databaseId: record.database.id,
          profileKind: DatabaseProfileKind.Project,
          roleKey,
          rowKindScope: "task",
          fieldId: parent.id,
          required: false,
          config: {},
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        {
          databaseId: record.database.id,
          profileKind: DatabaseProfileKind.Project,
          roleKey: "milestone.phase",
          rowKindScope: "milestone",
          fieldId: parent.id,
          required: false,
          config: {},
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    };
    const binding = structuredClone(rowTemplates[0]!);
    binding.rowTemplate.rowKind = rowKind;
    binding.rowTemplate.initialCellValues = [];
    const target = {
      ...rows[0]!,
      row: {
        ...rows[0]!.row,
        rowKind: "phase",
        title: "Canonical phase target",
      },
    };
    const f = renderDatabaseViewHost({
      record: readyManagedRecord(project),
      rows: [target],
      rowTemplates: [binding],
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("database-new-row-menu"));
    await user.click(await screen.findByText("Row templates"));
    const dialog = await screen.findByRole("dialog", { name: "Row templates" });
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Canonical phase target" }),
    );
    await waitFor(() =>
      expect(f.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseRowTemplateMutation,
          variables: {
            input: {
              rowTemplateId: binding.rowTemplate.id,
              expectedEditRevision: 1,
              initialCellValues: [
                { fieldId: parent.id, value: { relation: [target.row.id] } },
              ],
            },
          },
        }),
      ),
    );
    expect(
      f.gql.mock.calls.filter(
        ([request]) =>
          request.query === databaseTasksQuery ||
          request.query === databaseTaskReferencesQuery,
      ),
    ).toHaveLength(0);
  },
);

test("an unavailable managed definition offers a scoped read instead of a template/schema repair", async () => {
  const project = readyManagedRecord({
    ...record,
    database: { ...record.database, profileKind: DatabaseProfileKind.Project },
  });
  project.managedSchema = {
    ...project.managedSchema!,
    readiness: DatabaseManagedSchemaReadiness.Unavailable,
    reasonCode: "MANAGED_STRUCTURE_MISMATCH",
    taskBindings: [],
  };
  const { gql, onChanged } = renderDatabaseViewHost({
    record: project,
    rowTemplates,
  });
  expect(
    await screen.findByText(
      "This destination has changed. Reload its current state.",
    ),
  ).not.toBeNull();
  expect(screen.queryByTestId("database-new-row-menu")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(onChanged).toHaveBeenCalledOnce();
  expect(
    gql.mock.calls.filter(
      ([request]) => request.query === updateDatabaseRowTemplateMutation,
    ),
  ).toHaveLength(0);
});

test("prompts once before publishing a template Row and cancellation writes nothing", async () => {
  const { gql, onChanged } = renderDatabaseViewHost({
    rowTemplates,
    gql: ({ query }) =>
      query === createDatabaseRowFromTemplateMutation
        ? {
            createDatabaseRowFromTemplate: { row: { id: "created-input-row" } },
          }
        : {},
    rowTemplateInputs: {
      requiredInputs: ["input.project"],
      sourceRevision: "captured-source",
    },
  });
  const trigger = screen.getByTestId("database-new-row");
  const open = async () => {
    trigger.focus();
    fireEvent.click(trigger);
    return screen.findByRole("textbox", { name: "project" });
  };
  await open();
  expect(
    gql.mock.calls.filter(
      ([call]) => call.query === createDatabaseRowFromTemplateMutation,
    ),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByTestId("template-input-dialog")).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(
    gql.mock.calls.filter(
      ([call]) => call.query === createDatabaseRowFromTemplateMutation,
    ),
  ).toHaveLength(0);
  const input = await open();
  fireEvent.change(input, { target: { value: "  Atlas {{date}}  " } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(
      gql.mock.calls.filter(
        ([call]) => call.query === createDatabaseRowFromTemplateMutation,
      ),
    ).toHaveLength(1),
  );
  expect(gql).toHaveBeenCalledWith(
    expect.objectContaining({
      query: createDatabaseRowFromTemplateMutation,
      variables: {
        input: {
          databaseId: "database-1",
          rowTemplateId: "row-template-default",
          title: "Untitled row",
          bodyInputs: { "input.project": "Atlas {{date}}" },
          sourceRevision: "captured-source",
        },
      },
    }),
  );
  await waitFor(() =>
    expect(onChanged).toHaveBeenCalledWith({
      kind: "row_created",
      target: { rowId: "created-input-row" },
    }),
  );
});

test.each(["MIX_DATABASE_TASK_RELATION_INVALID"])(
  "returns known %s rejection from the template prompt without replay",
  async (code) => {
    const failure = {
      extensions: { code, reason: "Cycle" },
    };
    const { gql, onChanged } = renderDatabaseViewHost({
      rowTemplates,
      rowTemplateInputs: {
        requiredInputs: ["input.project"],
        sourceRevision: "captured-source",
      },
      gql: ({ query }) => {
        if (query === createDatabaseRowFromTemplateMutation)
          return Promise.reject(failure);
        return {};
      },
    });
    fireEvent.click(screen.getByTestId("database-new-row-menu"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Task template/ }),
    );
    const input = await screen.findByRole("textbox", { name: "project" });
    fireEvent.change(input, { target: { value: "Atlas" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(screen.queryByTestId("template-input-dialog")).toBeNull(),
    );
    expect(
      gql.mock.calls.filter(
        ([call]) => call.query === createDatabaseRowFromTemplateMutation,
      ),
    ).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  },
);

function staleRowTemplate() {
  return {
    extensions: {
      code: "MIX_DATABASE_CONFLICT",
      latestState: JSON.stringify({
        kind: "rowTemplate",
        databaseId: record.database.id,
        rowTemplateId: rowTemplates[0]!.rowTemplate.id,
        editRevision: 2,
        name: "Task template",
        initialCellValues: {
          [notesField.id]: { kind: "text", value: "Converted seed" },
        },
      }),
    },
  };
}

async function openTemplateManagement() {
  fireEvent.click(screen.getByTestId("database-new-row-menu"));
  fireEvent.click(await screen.findByText("Row templates"));
  await screen.findByDisplayValue("Seed note");
}

test("stale template edits retain the draft on Cancel and discard it only on explicit Reload", async () => {
  const templates = structuredClone(rowTemplates);
  const { gql, onChanged, rerender } = renderDatabaseViewHost({
    rowTemplates: templates,
    gql: async ({ query }) => {
      if (query === updateDatabaseRowTemplateMutation) throw staleRowTemplate();
      return {};
    },
  });
  onChanged.mockImplementation(async () => {
    const template = templates[0]!.rowTemplate;
    const cell = template.initialCellValues.find(
      (cell) => cell.fieldId === notesField.id,
    )!;
    cell.value!.text = "Converted seed";
    template.editRevision = 2;
    rerender(record, rows);
  });
  await openTemplateManagement();
  fireEvent.change(screen.getByDisplayValue("Seed note"), {
    target: { value: "Private draft" },
  });
  const conflict = await screen.findByTestId("database-conflict-modal");
  expect(conflict.textContent).toContain("Converted seed");
  expect(
    within(conflict).queryByRole("button", { name: "Overwrite with my value" }),
  ).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByTestId("database-conflict-modal")).toBeNull(),
  );
  expect(
    (screen.getByDisplayValue("Private draft") as HTMLInputElement).value,
  ).toBe("Private draft");
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.change(screen.getByDisplayValue("Private draft"), {
    target: { value: "Revised draft" },
  });
  const next = await screen.findByTestId("database-conflict-modal");
  fireEvent.click(
    within(next).getByRole("button", { name: "Use latest version" }),
  );
  await waitFor(() =>
    expect(screen.queryByDisplayValue("Revised draft")).toBeNull(),
  );
  expect(
    (screen.getByDisplayValue("Converted seed") as HTMLInputElement).value,
  ).toBe("Converted seed");
  expect(onChanged).toHaveBeenCalledOnce();
  const writes = gql.mock.calls
    .map(([request]) => request)
    .filter((request) => request.query === updateDatabaseRowTemplateMutation);
  expect(writes).toHaveLength(2);
  for (const request of writes)
    expect(request).toEqual(
      expect.objectContaining({
        variables: {
          input: {
            rowTemplateId: rowTemplates[0]!.rowTemplate.id,
            expectedEditRevision: 1,
            initialCellValues: [
              { fieldId: notesField.id, value: { text: expect.any(String) } },
            ],
          },
        },
      }),
    );
});

test("stale template deletion sends its observed revision and cannot force removal", async () => {
  const { gql, onChanged } = renderDatabaseViewHost({
    rowTemplates,
    gql: async ({ query }) => {
      if (query === deleteDatabaseRowTemplateMutation) throw staleRowTemplate();
      return {};
    },
  });
  await openTemplateManagement();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Remove template" })[0]!,
  );
  const conflict = await screen.findByTestId("database-conflict-modal");
  expect(
    within(conflict).queryByRole("button", { name: "Overwrite with my value" }),
  ).toBeNull();
  expect(gql).toHaveBeenCalledWith(
    expect.objectContaining({
      query: deleteDatabaseRowTemplateMutation,
      variables: {
        input: {
          rowTemplateId: rowTemplates[0]!.rowTemplate.id,
          expectedEditRevision: 1,
        },
      },
    }),
  );
  expect(onChanged).not.toHaveBeenCalled();
});

test("dense template reorder stops at the first native revision conflict", async () => {
  const { gql, onChanged } = renderDatabaseViewHost({
    rowTemplates,
    gql: async ({ query }) => {
      if (query === updateDatabaseRowTemplateMutation) throw staleRowTemplate();
      return {};
    },
  });
  await openTemplateManagement();
  const up = screen
    .getAllByRole("button", { name: "Move template up" })
    .find((button) => !(button as HTMLButtonElement).disabled)!;
  fireEvent.click(up);
  await screen.findByTestId("database-conflict-modal");
  const writes = gql.mock.calls
    .map(([request]) => request)
    .filter((request) => request.query === updateDatabaseRowTemplateMutation);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual(
    expect.objectContaining({
      variables: {
        input: {
          rowTemplateId: rowTemplates[1]!.rowTemplate.id,
          expectedEditRevision: 1,
          position: 0,
        },
      },
    }),
  );
  expect(onChanged).not.toHaveBeenCalled();
});

test.each(["rejection"])(
  "primitive drafts belong to their account and a retired %s cannot affect the next owner",
  async (lateOutcome) => {
    const notification = vi.spyOn(notify, "error");
    const pending: Array<{ resolve: () => void; reject: () => void }> = [];
    let writes = 0;
    try {
      const f = renderDatabaseViewHost({
        rowTemplates,
        gql: async ({ query }) => {
          if (query !== updateDatabaseRowTemplateMutation) return {};
          writes++;
          if (writes === 1) throw new Error("initial rejected value");
          return await new Promise((resolve, reject) => {
            pending.push({
              resolve: () =>
                resolve({ updateDatabaseRowTemplate: rowTemplates[0] }),
              reject: () => reject(new Error("retired account rejection")),
            });
          });
        },
      });
      await openTemplateManagement();
      fireEvent.change(screen.getByDisplayValue("Seed note"), {
        target: { value: "Account A rejected draft" },
      });
      await waitFor(() => expect(notification).toHaveBeenCalledOnce());
      expect(
        screen.getByDisplayValue("Account A rejected draft"),
      ).not.toBeNull();
      fireEvent.change(screen.getByDisplayValue("Account A rejected draft"), {
        target: { value: "Account A pending draft" },
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      act(() => f.server.account$.next({ id: "second-template-actor" }));
      await waitFor(() =>
        expect(
          screen.queryByDisplayValue("Account A pending draft"),
        ).toBeNull(),
      );
      const canonical = screen.getByDisplayValue("Seed note");
      expect(canonical.closest("fieldset")?.hasAttribute("disabled")).toBe(
        false,
      );
      fireEvent.change(canonical, {
        target: { value: "Account B private draft" },
      });
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => {
        if (lateOutcome === "rejection") pending[0]!.reject();
        else pending[0]!.resolve();
      });
      expect(notification).toHaveBeenCalledOnce();
      expect(f.onChanged).not.toHaveBeenCalled();
      const current = screen.getByDisplayValue("Account B private draft");
      expect(current.closest("fieldset")?.hasAttribute("disabled")).toBe(true);
      expect(screen.queryByDisplayValue("Account A pending draft")).toBeNull();
      await act(async () => pending[1]!.resolve());
      await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
      expect(current.closest("fieldset")?.hasAttribute("disabled")).toBe(false);
      expect(notification).toHaveBeenCalledOnce();
    } finally {
      await act(async () => pending.forEach((reply) => reply.resolve()));
      notification.mockRestore();
    }
  },
);

test.each(["valid"])(
  "template content conflicts preview only the edited Select with labels (%s)",
  async (payloadCase) => {
    const releaseTrack = field(
      "82ce65e2-dd15-475c-971e-f47f91f8db14",
      DatabaseFieldKind.Select,
      "Release track",
      2,
    );
    releaseTrack.config.select = {
      options: [
        {
          id: "active",
          name: "Active",
          position: 0,
          colorRole: "database.priority.normal",
        },
        {
          id: "done",
          name: "Done",
          position: 1,
          colorRole: "database.priority.normal",
        },
      ],
    };
    const templates = structuredClone(rowTemplates.slice(0, 1));
    const seed = structuredClone(
      templates[0]!.rowTemplate.initialCellValues[0]!,
    );
    seed.fieldId = releaseTrack.id;
    seed.fieldType = DatabaseFieldKind.Select;
    seed.value = { ...seed.value!, text: null, select: "active" };
    templates[0]!.rowTemplate.initialCellValues.push(seed);
    const latest: Record<string, unknown> = {
      kind: "rowTemplate",
      databaseId: record.database.id,
      rowTemplateId: templates[0]!.rowTemplate.id,
      editRevision: 4,
      name: "Task template",
      initialCellValues: {
        "unaffected-complexity": {
          kind: "select",
          value: "unrelated value that must never displace the edited field",
        },
        [releaseTrack.id]: { kind: "select", value: "active" },
      },
    };
    if (payloadCase === "unknown option")
      latest.initialCellValues = {
        [releaseTrack.id]: { kind: "select", value: "retired-option-id" },
      };
    if (payloadCase === "wrong value kind")
      latest.initialCellValues = {
        [releaseTrack.id]: { kind: "user", value: "private-person-uuid" },
      };
    if (payloadCase === "missing slot") latest.initialCellValues = {};
    const { onChanged } = renderDatabaseViewHost({
      record: { ...record, fields: [titleField, notesField, releaseTrack] },
      rowTemplates: templates,
      gql: async ({ query }) => {
        if (query === updateDatabaseRowTemplateMutation)
          throw {
            extensions: {
              code: "MIX_DATABASE_CONFLICT",
              latestState:
                payloadCase === "malformed payload"
                  ? "not valid JSON"
                  : JSON.stringify(latest),
            },
          };
        return {};
      },
    });
    await openTemplateManagement();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Done" }));
    const modal = await screen.findByTestId("database-conflict-modal");
    expect(modal.textContent).toContain("Task template · Release track");
    expect(
      within(modal).getByTestId("database-conflict-local").textContent,
    ).toBe("Release track: Done");
    expect(
      within(modal).getByTestId("database-conflict-latest").textContent,
    ).toBe(
      payloadCase === "valid"
        ? "Release track: Active"
        : payloadCase === "missing slot"
          ? "Release track: Empty"
          : payloadCase === "unknown option"
            ? "Release track: Unavailable"
            : "Unavailable",
    );
    for (const privateValue of [
      releaseTrack.id,
      "initialCellValues",
      "unaffected-complexity",
      "retired-option-id",
      "private-person-uuid",
    ])
      expect(modal.textContent).not.toContain(privateValue);
    expect(
      within(modal).queryByRole("button", { name: "Overwrite with my value" }),
    ).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  },
);
