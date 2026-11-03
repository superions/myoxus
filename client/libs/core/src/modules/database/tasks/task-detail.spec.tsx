// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import "../test-editor-boundary";

import {
  assistantQueryFixture,
  assistantPackagesFixture,
} from "../presentation/test-fixtures";
import { PublicUserService } from "@myoxus/core/modules/server";
import { notify } from "@myoxus/ui-facade";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { GuardService } from "@myoxus/core/modules/permissions";
import { GlobalState } from "@myoxus/core/modules/storage";
import {
  assistantPresentationQuery,
  AssistantContext,
  AssistantInputTarget,
  databaseRowRemindersQuery,
  setDatabaseRowReminderMutation,
  databaseSchemaQuery,
  databaseTaskParentQuery,
  databaseTaskBlockedByQuery,
  databaseTaskBlocksQuery,
  DatabaseTaskBlockingState,
  databaseTaskChildrenQuery,
  databaseTaskReferencesQuery,
  createDatabaseRowMutation,
  DatabaseTaskReferenceState,
  DatabaseStatusGroup,
  DatabaseManagedSchemaReadiness,
  ProjectOptionPreset,
  ProjectStructurePreset,
  type DatabaseTaskSummaryFragment,
  databaseTasksQuery,
  DatabaseTaskRelationReason,
  updateDatabaseCellValueMutation,
  clearDatabaseCellValueMutation,
  databaseViewsQuery,
  databaseRowQuery,
  documentReviewForTaskQuery,
  taskRecurrenceQuery,
  recurrencePreviewQuery,
  configureTaskRecurrenceMutation,
  databaseRowActivityQuery,
  bulkRestoreDatabaseRowsMutation,
  DatabaseProfileKind,
  DatabaseFieldKind,
  updateDatabaseRowTitleMutation,
} from "@myoxus/graphql";
import { FrameworkRoot, LiveData, type FrameworkProvider } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import {
  TaskDetailNavigationContext,
  useTaskDetailNavigation,
} from "../row-detail/task-navigation";
import { SWRConfig, useSWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  record,
  rows,
  titleField,
  relationField,
  field,
} from "../test-fixtures";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { TaskDetail } from "./task-detail";

afterEach(() => {
  cleanup();
  // The native notification store outlives its mounted provider.
  notify.dismiss();
});

const subtaskTitleLabel = assistantPackagesFixture(
  AssistantContext.TaskSubtask,
)[0].inputs.find((input) => input.target === AssistantInputTarget.Title)!.label
  .en;

const owner = vi.hoisted(() => ({
  gql: vi.fn(),
  identity: JSON.stringify([
    "server",
    "https://example.test",
    "actor",
    "workspace-1",
  ]),
  acknowledge: null as null | ((value: unknown) => void),
  socket: {
    id: "detail-socket",
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));
const account$ = new LiveData({ id: "actor" });

vi.mock("@myoxus/storage/cloud", async (original) => {
  const actual = await original<typeof import("@myoxus/storage/cloud")>();
  return {
    ...actual,
    SocketConnection: class {
      status = "connected";
      maybeConnection = { socket: owner.socket };
      onStatusChanged() {
        return () => {};
      }
      connect() {}
      disconnect() {}
    },
  };
});
vi.mock("./use-workspace-tasks", () => ({
  useTaskDestinations: () => ({
    readyDestinations: [
      { id: "database-1", title: "Tasks", workspaceTasks: true },
    ],
    isLoading: false,
    destinationError: false,
    nextCursor: null,
  }),
  useTaskIdentity: () => ({
    server: {
      gql: owner.gql,
      id: "server",
      baseUrl: "https://example.test",
      config$: { value: { type: "Standalone" } },
      account$,
    },
    account: account$.value,
    workspace: { id: "workspace-1" },
    identity: owner.identity,
    availability: { status: "available" },
  }),
}));
vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (date: string | Date) => new Date(date).toISOString(),
  }),
  useRegionalPreferences: () => ({
    locale: "en",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
  }),
}));
vi.mock("../presence", async (original) => ({
  ...(await original<typeof import("../presence")>()),
  useDatabaseSocket: () => null,
  useDatabasePresence: () => ({
    collaborators: [],
    localSocketId: null,
    updateFocus: vi.fn(),
  }),
}));
vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: () => null,
}));

function fixture(
  failFirstReadback = false,
  trashed = false,
  parentBinding?: {
    scope: string | null;
    titleAlias?: boolean;
    compatible?: boolean;
  },
  childrenJourney: boolean | { initialChildren: number } = false,
  blockingJourney = false,
  watchers?: {
    users: string[];
    required?: boolean;
    conflict?: boolean;
    alias?: boolean;
  },
  reminder?: {
    focusDue?: number;
    allDay?: boolean;
    missingDueRole?: boolean;
    deferPresentation?: boolean;
  },
) {
  owner.socket.id += "-next";
  owner.socket.on.mockClear();
  owner.socket.off.mockClear();
  owner.socket.emitWithAck.mockImplementation(
    () =>
      new Promise((resolve) => {
        owner.acknowledge = resolve;
      }),
  );
  let dueFocus = reminder?.focusDue;
  const dueFocused = vi.fn();
  let activityVersion = 0;
  let activityFailure = false;
  let restoreAttempts = 0;
  let writes = 0;
  account$.setValue({ id: "actor" });
  owner.identity = JSON.stringify([
    "server",
    "https://example.test",
    account$.value.id,
    "workspace-1",
  ]);
  let canonical: DatabaseRowRecord = {
    ...rows[0]!,
    cells: [...rows[0]!.cells],
    cellRevisions: rows[0]!.cellRevisions.map((revision) => ({ ...revision })),
    row: {
      ...rows[0]!.row,
      rowKind: "task",
      contentDocument: null,
      deletedAt: trashed ? "2026-10-14T09:00:00Z" : null,
    },
  };
  const project = {
    ...record,
    database: { ...record.database, profileKind: DatabaseProfileKind.Project },
    fields:
      parentBinding && !parentBinding.titleAlias
        ? [
            titleField,
            {
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
            },
          ]
        : [titleField],
    managedSchema: null as DatabaseRecord["managedSchema"],
    fieldRoles: parentBinding
      ? [
          {
            databaseId: "database-1",
            profileKind: DatabaseProfileKind.Project,
            roleKey: "task.parent",
            rowKindScope: parentBinding.scope,
            fieldId: parentBinding.titleAlias
              ? titleField.id
              : relationField.id,
            required: false,
            config: {},
            createdAt: "2026-10-15T00:00:00Z",
            updatedAt: "2026-10-15T00:00:00Z",
          },
          ...(parentBinding.titleAlias
            ? [
                {
                  databaseId: "database-1",
                  profileKind: DatabaseProfileKind.Project,
                  roleKey: "task.title",
                  rowKindScope: "task",
                  fieldId: titleField.id,
                  required: true,
                  config: {},
                  createdAt: "2026-10-15T00:00:00Z",
                  updatedAt: "2026-10-15T00:00:00Z",
                },
              ]
            : []),
        ]
      : [],
  };
  const watchersField = field(
    "watchers",
    DatabaseFieldKind.Users,
    "Watchers",
    8,
  );
  watchersField.required = watchers?.required ?? false;
  if (watchers) {
    project.fields.push(watchersField);
    project.fieldRoles.push({
      databaseId: project.database.id,
      profileKind: DatabaseProfileKind.Project,
      roleKey: "task.watchers",
      rowKindScope: "task",
      fieldId: watchersField.id,
      required: false,
      config: {},
      createdAt: watchersField.createdAt,
      updatedAt: watchersField.updatedAt,
    });
    if (watchers.alias)
      project.fieldRoles.push({
        ...project.fieldRoles.at(-1)!,
        roleKey: "task.assignees",
      });
    canonical.cells.push({
      ...rows[0]!.cells[0]!,
      fieldId: watchersField.id,
      fieldType: DatabaseFieldKind.Users,
      editRevision: 7,
      value: {
        ...rows[0]!.cells[0]!.value,
        kind: DatabaseFieldKind.Users,
        text: null,
        richText: null,
        users: watchers.users,
      },
    });
    canonical.cellRevisions.push({
      rowId: canonical.row.id,
      fieldId: watchersField.id,
      editRevision: 7,
      hasValue: true,
    });
  }
  const dueField = {
    ...field("task-due", DatabaseFieldKind.DateTime, "Due", 9),
    config: {
      ...titleField.config,
      kind: DatabaseFieldKind.DateTime,
      dateTime: { allowReminders: true, defaultTimeZone: "Europe/Berlin" },
    },
  };
  if (reminder) {
    const status = {
      ...field("task-status", DatabaseFieldKind.Status, "Workflow", 8),
      config: {
        ...titleField.config,
        kind: DatabaseFieldKind.Status,
        status: {
          defaultOptionId: "status.todo",
          options: [
            {
              id: "status.todo",
              name: "Todo",
              colorRole: "database.status.todo",
              group: DatabaseStatusGroup.NotStarted,
              position: 0,
            },
            {
              id: "status.in_progress",
              name: "Active",
              colorRole: "database.status.inProgress",
              group: DatabaseStatusGroup.Active,
              position: 1,
            },
            {
              id: "status.done",
              name: "Done",
              colorRole: "database.status.done",
              group: DatabaseStatusGroup.Complete,
              position: 2,
            },
          ],
        },
      },
    };
    project.fields.push(dueField, status);
    for (const [roleKey, fieldId] of [
      ["task.status", status.id],
      ...(!reminder.missingDueRole ? [["task.dueDate", dueField.id]] : []),
    ])
      project.fieldRoles.push({
        databaseId: "database-1",
        profileKind: DatabaseProfileKind.Project,
        roleKey: roleKey!,
        rowKindScope: "task",
        fieldId: fieldId!,
        required: false,
        config: {},
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T00:00:00Z",
      });
    canonical.cells.push({
      ...rows[0]!.cells[0]!,
      fieldId: dueField.id,
      fieldType: DatabaseFieldKind.DateTime,
      value: {
        ...rows[0]!.cells[0]!.value,
        kind: DatabaseFieldKind.DateTime,
        text: null,
        dateTime: {
          start: "2030-07-10T22:00:00Z",
          end: null,
          allDay: reminder.allDay ?? false,
          timeZone: "Europe/Berlin",
        },
      },
    });
  }
  const childRows = new Map<string, DatabaseRowRecord>();
  const blockerField = {
    ...relationField,
    id: "blocker-field",
    name: "Prerequisites",
    config: {
      ...relationField.config,
      relation: {
        targetDatabaseId: "database-1",
        allowMultiple: true,
        maxTargets: null,
        reciprocalFieldId: null,
      },
    },
  };
  if (blockingJourney) {
    project.fields.push(blockerField);
    project.fieldRoles.push({
      ...project.fieldRoles[0]!,
      roleKey: "task.blockedBy",
      rowKindScope: "task",
      fieldId: blockerField.id,
    });
    canonical.cells.push({
      ...rows[0]!.cells[0]!,
      fieldId: blockerField.id,
      fieldType: DatabaseFieldKind.Relation,
      value: {
        ...rows[0]!.cells[0]!.value,
        kind: DatabaseFieldKind.Relation,
        text: null,
        richText: null,
        relation: ["child-01"],
        relationTargets: [],
      },
    });
    canonical.cellRevisions.push({
      rowId: canonical.row.id,
      fieldId: blockerField.id,
      editRevision: 1,
      hasValue: true,
    });
  }
  const summary = (child: DatabaseRowRecord): DatabaseTaskSummaryFragment => ({
    workspaceId: "workspace-1",
    databaseId: "database-1",
    rowId: child.row.id,
    title: child.row.title,
    projectTitle: "Project",
    descriptionPreview: null,
    editRevision: child.row.editRevision,
    updatedAt: child.row.updatedAt,
    deletedAt: null,
    canEdit: true,
    status:
      blockingJourney && child.row.id === "child-01"
        ? {
            id: "prerequisite-status",
            name:
              blockerState === DatabaseTaskBlockingState.Inactive
                ? "Done"
                : "Todo",
            position: 0,
            colorRole: "tag.grey",
            group:
              blockerState === DatabaseTaskBlockingState.Inactive
                ? DatabaseStatusGroup.Complete
                : DatabaseStatusGroup.NotStarted,
          }
        : /^child-0[1-7]$/.test(child.row.id)
          ? {
              id: "done",
              name: "Done",
              position: 0,
              colorRole: "tag.green",
              group: DatabaseStatusGroup.Complete,
            }
          : /^child-(08|09|10)$/.test(child.row.id)
            ? {
                id: "archived",
                name: "Archived",
                position: 1,
                colorRole: "tag.grey",
                group: DatabaseStatusGroup.Archived,
              }
            : null,
    assignees: [],
    due: null,
    priority: null,
    hasAssignees: false,
    hasDue: false,
    hasPriority: false,
    isSubtask: null,
    hasDependencies: null,
  });
  const childRow = (id: string, title: string): DatabaseRowRecord => ({
    ...canonical,
    row: { ...canonical.row, id, title },
    cells: [
      {
        ...canonical.cells[0]!,
        fieldId: relationField.id,
        fieldType: DatabaseFieldKind.Relation,
        value: {
          ...canonical.cells[0]!.value,
          kind: DatabaseFieldKind.Relation,
          text: null,
          richText: null,
          relation: [canonical.row.id],
          relationTargets: [
            {
              rowId: canonical.row.id,
              title: canonical.row.title,
              deleted: false,
              redacted: false,
              contentDocument: null,
            },
          ],
        },
      },
    ],
    cellRevisions: [
      { rowId: id, fieldId: relationField.id, editRevision: 1, hasValue: true },
    ],
  });
  const initialChildren =
    typeof childrenJourney === "object" ? childrenJourney.initialChildren : 21;
  if (childrenJourney)
    for (let index = 1; index <= initialChildren; index++) {
      const id = `child-${String(index).padStart(2, "0")}`;
      childRows.set(
        id,
        childRow(id, `Subtask ${String(index).padStart(2, "0")}`),
      );
    }
  project.managedSchema = {
    readiness: DatabaseManagedSchemaReadiness.Ready,
    reasonCode: null,
    templateId: "simple_project",
    templateVersion: "1.0.0",
    templateDigest: "fixture",
    variant: {
      priority: ProjectOptionPreset.ThreeStep,
      complexity: ProjectOptionPreset.ThreeStep,
      structure: ProjectStructurePreset.TasksOnly,
      currency: "EUR",
    },
    schemaRevision: 1,
    canEditStructure: false,
    canEditMetadata: true,
    canManageLifecycle: true,
    taskBindings: [
      { roleKey: "task.title", fieldId: titleField.id },
      ...project.fieldRoles
        .filter(
          (role) =>
            role.rowKindScope === "task" && role.roleKey !== "task.title",
        )
        .map(({ roleKey, fieldId }) => ({ roleKey, fieldId })),
    ],
  };
  if ((parentBinding && !parentBinding.compatible) || watchers?.alias)
    project.managedSchema = {
      ...project.managedSchema!,
      readiness: DatabaseManagedSchemaReadiness.Unavailable,
      reasonCode: "MANAGED_STRUCTURE_MISMATCH",
      taskBindings: [],
    };
  let parentUnavailable = false;
  let blockerState = DatabaseTaskBlockingState.Active;
  let createFailure: unknown;
  let loseCreateResponse = false;
  let childrenFailure = false;
  let expiredCursor = false;
  let deferChildren = false;
  let releaseChildren: (() => void) | undefined;
  let createCount = 0;
  let failure: unknown = null;
  let presentationRequested = false;
  let releasePresentation = () => {};
  const presentationRead = new Promise<void>((resolve) => {
    releasePresentation = resolve;
  });
  owner.gql.mockReset().mockImplementation(async ({ query, variables }) => {
    if (query === taskRecurrenceQuery)
      return { workspace: { id: "workspace-1", taskRecurrence: null } };
    if (query === recurrencePreviewQuery)
      return {
        workspace: {
          recurrencePreview: [
            {
              occurrence: {
                nominal: { date: "2030-07-11", localDateTime: null },
                dueAt: "2030-07-10T22:00:00Z",
              },
              completionReference: null,
            },
          ],
        },
      };
    if (query === configureTaskRecurrenceMutation)
      throw { extensions: { code: "MIX_DATABASE_CONFLICT" } };
    if (query === documentReviewForTaskQuery)
      return {
        currentUser: { id: account$.value.id },
        workspace: { id: "workspace-1", documentReviewForTask: null },
      };
    if (query === assistantPresentationQuery && reminder?.deferPresentation) {
      presentationRequested = true;
      await presentationRead;
    }
    const selected = childRows.get(variables?.rowId) ?? canonical;
    const assistant = assistantQueryFixture(
      query,
      variables,
      project,
      selected,
    );
    if (assistant) return assistant;
    if (
      query === databaseTaskBlockedByQuery ||
      query === databaseTaskBlocksQuery
    ) {
      const outgoing = query === databaseTaskBlockedByQuery;
      const targets =
        selected.cells.find((cell) => cell.fieldId === blockerField.id)?.value
          .relation ?? [];
      const entries = blockingJourney
        ? outgoing
          ? targets.map((rowId) => ({
              rowId,
              state: blockerState,
              task:
                blockerState === DatabaseTaskBlockingState.Unavailable
                  ? null
                  : summary(childRows.get(rowId)!),
            }))
          : [
              {
                rowId: variables.after ? "child-21" : "child-02",
                state: DatabaseTaskBlockingState.Active,
                task: summary(
                  childRows.get(variables.after ? "child-21" : "child-02")!,
                ),
              },
            ]
        : [];
      return {
        workspace: {
          id: "workspace-1",
          databaseRow: {
            row: {
              id: selected.row.id,
              databaseId: "database-1",
              [outgoing ? "taskBlockedBy" : "taskBlocks"]: {
                available: blockingJourney,
                fieldId: blockingJourney ? blockerField.id : null,
                diagnostics: blockingJourney
                  ? blockerState === DatabaseTaskBlockingState.Unavailable
                    ? [DatabaseTaskRelationReason.UnavailableTarget]
                    : []
                  : [DatabaseTaskRelationReason.MissingRole],
                ...(outgoing ? { retainedRowIds: targets } : {}),
                rows: entries,
                nextCursor:
                  !outgoing && blockingJourney && !variables.after
                    ? "blocks-page-2"
                    : null,
              },
            },
          },
        },
      };
    }
    if (query === databaseTaskChildrenQuery) {
      if (childrenFailure) throw new Error("Children canonical read denied");
      if (expiredCursor && variables.after)
        throw { extensions: { code: "MIX_DATABASE_QUERY_INVALID" } };
      const all =
        childrenJourney && selected.row.id === canonical.row.id
          ? [...childRows.values()]
          : [];
      const summaries = all.map(summary);
      const result = {
        workspace: {
          id: "workspace-1",
          databaseRow: {
            row: {
              id: selected.row.id,
              databaseId: "database-1",
              taskChildren: {
                available: Boolean(parentBinding?.compatible),
                fieldId: parentBinding ? relationField.id : null,
                diagnostics: parentBinding?.compatible
                  ? []
                  : [DatabaseTaskRelationReason.MissingRole],
                rows: summaries.slice(
                  variables.after ? 20 : 0,
                  variables.after ? 40 : 20,
                ),
                totalCount: all.length,
                completeCount: summaries.filter(
                  (child) =>
                    child.status?.group === DatabaseStatusGroup.Complete,
                ).length,
                archivedCount: summaries.filter(
                  (child) =>
                    child.status?.group === DatabaseStatusGroup.Archived,
                ).length,
                nextCursor:
                  !variables.after && all.length > 20
                    ? "cursor-after-20"
                    : null,
              },
            },
          },
        },
      };
      if (deferChildren) {
        deferChildren = false;
        return new Promise((resolve) => {
          releaseChildren = () => resolve(result);
        });
      }
      return result;
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
            }) => {
              const child =
                childRows.get(target.rowId) ??
                (target.rowId === canonical.row.id ? canonical : null);
              return {
                ...target,
                state:
                  child &&
                  !(parentUnavailable && target.rowId === canonical.row.id)
                    ? DatabaseTaskReferenceState.Available
                    : DatabaseTaskReferenceState.Unavailable,
                task:
                  child &&
                  !(parentUnavailable && target.rowId === canonical.row.id)
                    ? summary(child)
                    : null,
              };
            },
          ),
        },
      };
    if (query === createDatabaseRowMutation) {
      createCount += 1;
      if (createFailure) throw createFailure;
      expect(variables.input).toEqual({
        databaseId: "database-1",
        title: variables.input.title.trim(),
        cells: [
          {
            fieldId: relationField.id,
            value: { relation: [canonical.row.id] },
          },
        ],
      });
      const child = childRow("new-child", variables.input.title);
      childRows.set(child.row.id, child);
      if (loseCreateResponse) throw new TypeError("Committed response lost");
      return { createDatabaseRow: { row: { id: child.row.id } } };
    }
    if (query === databaseSchemaQuery || query === databaseViewsQuery)
      return { workspace: { database: project } };
    if (query === databaseTaskParentQuery)
      return {
        workspace: {
          id: "workspace-1",
          databaseRow: {
            row: {
              id: selected.row.id,
              databaseId: "database-1",
              taskParent: {
                available: Boolean(parentBinding?.compatible),
                fieldId: parentBinding
                  ? parentBinding.titleAlias
                    ? titleField.id
                    : relationField.id
                  : null,
                parentRowIds:
                  selected.cells.find(
                    (cell) => cell.fieldId === relationField.id,
                  )?.value.relation ?? [],
                diagnostics: parentBinding?.compatible
                  ? parentUnavailable && selected.row.id !== canonical.row.id
                    ? [DatabaseTaskRelationReason.UnavailableTarget]
                    : []
                  : [
                      parentBinding
                        ? DatabaseTaskRelationReason.IncompatibleRoleConfiguration
                        : DatabaseTaskRelationReason.MissingRole,
                    ],
              },
            },
          },
        },
      };
    if (query === databaseTasksQuery && childrenJourney) {
      const matches =
        variables.input.lifecycle === "Closed"
          ? []
          : [...childRows.values()].filter((child) =>
              child.row.title
                .toLowerCase()
                .includes((variables.input.search ?? "").toLowerCase()),
            );
      return {
        workspace: {
          databaseTasks: {
            rows: matches.map(summary),
            totalCount: matches.length,
            projectCount: 1,
            coverageComplete: true,
            unavailableProjects: [],
            nextCursor: null,
          },
        },
      };
    }
    if (query === databaseTasksQuery)
      return {
        workspace: {
          databaseTasks: {
            rows: [
              {
                workspaceId: "workspace-1",
                databaseId: "database-1",
                rowId: "parent-row",
                title: "Chosen parent",
                projectTitle: "Project",
                descriptionPreview: null,
                editRevision: 1,
                updatedAt: "2026-10-15T00:00:00Z",
                deletedAt: null,
                status: null,
                assignees: [],
                due: null,
                priority: null,
                hasAssignees: false,
                hasDue: false,
                hasPriority: false,
                canEdit: true,
              },
            ],
            totalCount: 1,
            projectCount: 1,
            coverageComplete: true,
            unavailableProjects: [],
            nextCursor: null,
          },
        },
      };
    if (
      query === updateDatabaseCellValueMutation ||
      query === clearDatabaseCellValueMutation
    ) {
      if (watchers && variables.input.fieldId === watchersField.id) {
        const previous = canonical.cellRevisions.find(
          (cell) => cell.fieldId === watchersField.id,
        )!;
        expect(variables.input.expectedEditRevision).toBe(
          previous.editRevision,
        );
        if (watchers.conflict)
          throw {
            extensions: {
              code: "MIX_DATABASE_CELL_CONFLICT",
              latestState: "{}",
            },
          };
        const users =
          query === clearDatabaseCellValueMutation
            ? []
            : variables.input.value.users;
        const editRevision = previous.editRevision + 1;
        canonical = {
          ...canonical,
          cells: [
            ...canonical.cells.filter(
              (cell) => cell.fieldId !== watchersField.id,
            ),
            ...(query === clearDatabaseCellValueMutation
              ? []
              : [
                  {
                    ...rows[0]!.cells[0]!,
                    fieldId: watchersField.id,
                    fieldType: DatabaseFieldKind.Users,
                    editRevision,
                    value: {
                      ...rows[0]!.cells[0]!.value,
                      kind: DatabaseFieldKind.Users,
                      text: null,
                      richText: null,
                      users,
                    },
                  },
                ]),
          ],
          cellRevisions: [
            ...canonical.cellRevisions.filter(
              (cell) => cell.fieldId !== watchersField.id,
            ),
            {
              rowId: canonical.row.id,
              fieldId: watchersField.id,
              editRevision,
              hasValue: query !== clearDatabaseCellValueMutation,
            },
          ],
        };
        const result = {
          rowId: canonical.row.id,
          fieldId: watchersField.id,
          editRevision,
          hasValue: query !== clearDatabaseCellValueMutation,
        };
        return query === clearDatabaseCellValueMutation
          ? { clearDatabaseCellValue: result }
          : { updateDatabaseCellValue: result };
      }
      if (
        !parentBinding?.compatible ||
        variables.input.fieldId !== relationField.id
      )
        throw new Error("Unexpected Parent Cell mutation");
      const previousRevision =
        canonical.cellRevisions.find(
          (cell) => cell.fieldId === relationField.id,
        )?.editRevision ?? 0;
      expect(variables.input.expectedEditRevision).toBe(previousRevision);
      const targets =
        query === clearDatabaseCellValueMutation
          ? []
          : variables.input.value.relation;
      const editRevision = previousRevision + 1;
      canonical = {
        ...canonical,
        cells: [
          ...canonical.cells.filter(
            (cell) => cell.fieldId !== relationField.id,
          ),
          ...(targets.length
            ? [
                {
                  ...rows[0]!.cells[0]!,
                  fieldId: relationField.id,
                  fieldType: DatabaseFieldKind.Relation,
                  editRevision,
                  value: {
                    ...rows[0]!.cells[0]!.value,
                    kind: DatabaseFieldKind.Relation,
                    richText: null,
                    text: null,
                    relation: targets,
                    relationTargets: [
                      {
                        rowId: "parent-row",
                        title: "Chosen parent",
                        deleted: false,
                        redacted: false,
                        contentDocument: null,
                      },
                    ],
                  },
                },
              ]
            : []),
        ],
        cellRevisions: [
          ...canonical.cellRevisions.filter(
            (cell) => cell.fieldId !== relationField.id,
          ),
          {
            rowId: canonical.row.id,
            fieldId: relationField.id,
            editRevision,
            hasValue: targets.length > 0,
          },
        ],
      };
      const result = {
        rowId: canonical.row.id,
        fieldId: relationField.id,
        editRevision,
        hasValue: targets.length > 0,
      };
      return query === clearDatabaseCellValueMutation
        ? { clearDatabaseCellValue: result }
        : { updateDatabaseCellValue: result };
    }
    if (query === databaseRowQuery) {
      if (failure) throw failure;
      return { workspace: { databaseRow: selected } };
    }
    if (query === databaseRowActivityQuery) {
      if (activityFailure) throw new Error("Activity read unavailable");
      return {
        workspace: {
          databaseRowActivity: [
            {
              id: `activity-${activityVersion}`,
              actorDisplayName: `server/${account$.value.id}/workspace-1`,
              actorUserId: account$.value.id,
              createdAt: "2026-10-14T09:00:00Z",
              eventType: activityVersion ? "cell.changed" : "row.updated",
              payload: activityVersion
                ? { fieldName: `Remote status ${activityVersion}` }
                : {},
            },
          ],
        },
      };
    }
    if (query === bulkRestoreDatabaseRowsMutation) {
      restoreAttempts += 1;
      if (restoreAttempts === 1) {
        canonical = {
          ...canonical,
          row: { ...canonical.row, editRevision: 2 },
        };
        return {
          bulkRestoreDatabaseRows: {
            transactionCommitted: true,
            succeeded: [],
            successCount: 0,
            failureCount: 1,
            total: 1,
            failed: [
              {
                rowId: canonical.row.id,
                success: false,
                errorCode: "MIX_DATABASE_CONFLICT",
                errorMessage: "stale",
              },
            ],
          },
        };
      }
      expect(variables.input.expectedEditRevisions).toEqual([
        { rowId: canonical.row.id, expectedEditRevision: 2 },
      ]);
      canonical = {
        ...canonical,
        row: { ...canonical.row, deletedAt: null, editRevision: 3 },
      };
      return {
        bulkRestoreDatabaseRows: {
          transactionCommitted: true,
          succeeded: [canonical.row.id],
          successCount: 1,
          failureCount: 0,
          total: 1,
          failed: [],
        },
      };
    }
    if (query === updateDatabaseRowTitleMutation) {
      expect(variables.input.expectedEditRevision).toBe(
        canonical.row.editRevision,
      );
      canonical = {
        ...canonical,
        row: {
          ...canonical.row,
          title: variables.input.title,
          editRevision: canonical.row.editRevision + 1,
        },
      };
      writes += 1;
      failure =
        failFirstReadback && writes === 1
          ? new Error("confirmed write readback unavailable")
          : null;
      return {
        updateDatabaseRowTitle: {
          rowId: canonical.row.id,
          editRevision: canonical.row.editRevision,
        },
      };
    }
    if (query === databaseRowRemindersQuery)
      return {
        workspace: {
          databaseRowReminders:
            reminder &&
            !canonical.cells.some((cell) => cell.fieldId === "task-status") &&
            !canonical.cellRevisions.some(
              (revision) => revision.fieldId === "task-status",
            )
              ? [
                  {
                    id: "old-reminder",
                    offsetMinutes: 10,
                    triggerAt: "2030-07-11T06:50:00Z",
                  },
                ]
              : [],
        },
      };
    if (query === setDatabaseRowReminderMutation)
      return { setDatabaseRowReminder: { id: "personal-reminder" } };
    return {};
  });
  const server$ = new LiveData({
    id: "server",
    baseUrl: "https://example.test",
    account$,
    gql: owner.gql,
  });
  const workspaceServer = { server$ };
  const workspaceService = {
    workspace: { id: "workspace-1", flavour: "myoxus-cloud" },
  };
  const canWrite$ = new LiveData(true);
  const guardService = { can$: () => canWrite$ };
  const profiles = new Map<
    string,
    LiveData<{ id: string; name: string; avatarUrl: string }>
  >();
  const usersLoading$ = new LiveData(false);
  const publicUsers = {
    publicUser$: (id: string) => {
      let profile = profiles.get(id);
      if (!profile) {
        profile = new LiveData({
          id,
          name: id === "other-watcher" ? "Other watcher" : "Current actor",
          avatarUrl: "",
        });
        profiles.set(id, profile);
      }
      return profile;
    },
    isLoading$: () => usersLoading$,
    revalidate: vi.fn(),
  };
  const confirmedAttempts = new Map<string, unknown>();
  const globalState = {
    getConfirmed: async (key: string) => confirmedAttempts.get(key),
    setConfirmed: async (key: string, value: unknown) => {
      if (value === undefined) confirmedAttempts.delete(key);
      else confirmedAttempts.set(key, value);
    },
  };
  const framework = {
    get: (token: unknown) => {
      if (token === GlobalState) return globalState;
      if (token === WorkspaceServerService) return workspaceServer;
      if (token === WorkspaceService) return workspaceService;
      if (token === GraphQLService) return { gql: owner.gql };
      if (token === GuardService) return guardService;
      if (token === PublicUserService) return publicUsers;
      throw new Error(`Unexpected service ${String(token)}`);
    },
    getOptional: () => undefined,
  } as unknown as FrameworkProvider;
  let refresh!: () => Promise<unknown>;
  function Refresh() {
    const { mutate } = useSWRConfig();
    refresh = () =>
      mutate((key) => Array.isArray(key) && key[0] === "task-canonical-detail");
    return null;
  }
  function SelectedDetail() {
    const [selected, select] = useState(canonical.row.id);
    const { navigation } = useTaskDetailNavigation(
      owner.identity,
      selected,
      select,
    );
    return (
      <TaskDetailNavigationContext.Provider value={navigation}>
        <TaskDetail
          key={`${owner.identity}:${selected}`}
          databaseId="database-1"
          rowId={selected}
          onChanged={vi.fn()}
          onOpenDoc={vi.fn()}
          onOpenProject={vi.fn()}
        />
      </TaskDetailNavigationContext.Provider>
    );
  }
  let detailMount = 0;
  const surface = () => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      <FrameworkRoot framework={framework}>
        <MyoxusUIProvider env="test">
          <Refresh />
          {childrenJourney ? (
            <SelectedDetail />
          ) : (
            <TaskDetail
              key={`${owner.identity}:${detailMount}`}
              databaseId="database-1"
              rowId={canonical.row.id}
              focusDue={dueFocus}
              onDueFocused={dueFocused}
              onChanged={vi.fn()}
              onOpenDoc={vi.fn()}
              onOpenProject={vi.fn()}
            />
          )}
        </MyoxusUIProvider>
      </FrameworkRoot>
    </SWRConfig>
  );
  const rendered = render(surface());
  return {
    remountDetail: () => {
      detailMount++;
      rendered.rerender(surface());
    },
    updateActivity: (fail = false) => {
      activityVersion += 1;
      activityFailure = fail;
    },
    dueFocused,
    presentationRequested: () => presentationRequested,
    releasePresentation: () => releasePresentation(),
    focusDue: (request: number | undefined) => {
      dueFocus = request;
      rendered.rerender(surface());
    },
    switchIdentity: (actorId: string) => {
      account$.setValue({ id: actorId });
      owner.identity = JSON.stringify([
        "server",
        "https://example.test",
        actorId,
        "workspace-1",
      ]);
      rendered.rerender(surface());
    },
    rejectCreate: (reason: string) => {
      createFailure = {
        extensions: { code: "MIX_DATABASE_TASK_RELATION_INVALID", reason },
      };
    },
    deferNextChildren: () => {
      deferChildren = true;
    },
    childrenPending: () => Boolean(releaseChildren),
    releaseChildren: () => {
      if (!releaseChildren) throw new Error("No pending child read");
      releaseChildren();
    },
    expireCursor: () => {
      expiredCursor = true;
    },
    loseCreateResponse: () => {
      loseCreateResponse = true;
    },
    failChildren: (failed: boolean) => {
      childrenFailure = failed;
    },
    setParentUnavailable: (value: boolean) => {
      parentUnavailable = value;
    },
    setBlockerState: (state: DatabaseTaskBlockingState) => {
      blockerState = state;
    },
    setReminderTaskStatus: (status: string | null, revision: number) => {
      canonical = {
        ...canonical,
        cells: canonical.cells.filter((cell) => cell.fieldId !== "task-status"),
        cellRevisions: canonical.cellRevisions.filter(
          (cell) => cell.fieldId !== "task-status",
        ),
      };
      if (status)
        canonical.cells.push({
          ...rows[0]!.cells[0]!,
          fieldId: "task-status",
          fieldType: DatabaseFieldKind.Status,
          editRevision: revision,
          value: {
            ...rows[0]!.cells[0]!.value,
            kind: DatabaseFieldKind.Status,
            text: null,
            status,
          },
        });
      canonical.cellRevisions.push({
        rowId: canonical.row.id,
        fieldId: "task-status",
        editRevision: revision,
        hasValue: Boolean(status),
      });
    },
    canonical: () => structuredClone(canonical),
    makeReadonly: () => canWrite$.setValue(false),
    canonicalChild: (id: string) => childRows.get(id),
    createCount: () => createCount,
    createdChild: () => childRows.get("new-child"),
    refresh: () => refresh(),
    title: () => canonical.row.title,
    parentIds: () =>
      canonical.cells.find((cell) => cell.fieldId === relationField.id)?.value
        .relation ?? [],
    remoteTitle: (title: string) => {
      canonical = {
        ...canonical,
        row: {
          ...canonical.row,
          title,
          editRevision: canonical.row.editRevision + 1,
        },
      };
    },
    fail: (error: unknown) => {
      failure = error;
    },
  };
}

describe("canonical Task detail consuming native Row editors", () => {
  test("recurrence keeps the open draft and native edit basis across canonical delivery", async () => {
    const f = fixture(false, false, undefined, false, false, undefined, {
      allDay: true,
    });
    const originalRevision = f.canonical().row.editRevision;
    await userEvent.click(
      await screen.findByRole("button", { name: "Repeat" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Repeat",
    });
    const title = within(dialog).getByRole("textbox", {
      name: "Title",
    });
    fireEvent.change(title, {
      target: { value: "Deliberate future Task recipe" },
    });
    act(() => {
      f.remoteTitle("Changed elsewhere");
      f.setReminderTaskStatus("status.in_progress", 2);
    });
    await act(async () => {
      await f.refresh();
    });
    expect(
      within(dialog).getByRole<HTMLInputElement>("textbox", {
        name: "Title",
      }).value,
    ).toBe("Deliberate future Task recipe");
    const save = within(dialog).getByRole("button", {
      name: "Save",
    });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(save);
    await within(dialog).findByText(/Repetition could not be saved/);
    const submitted = owner.gql.mock.calls.find(
      ([request]) => request.query === configureTaskRecurrenceMutation,
    )?.[0].variables.input;
    expect(submitted).toMatchObject({
      expectedRowRevision: originalRevision,
      recipe: { title: "Deliberate future Task recipe" },
    });
    expect(
      within(dialog).getByRole<HTMLInputElement>("textbox", {
        name: "Title",
      }).value,
    ).toBe("Deliberate future Task recipe");
  });
  test.each([true])(
    "Due focuses the canonical control and readonly Tasks retain personal reminder writes (allDay=%s)",
    async (allDay) => {
      const f = fixture(false, false, undefined, false, false, undefined, {
        focusDue: 1,
        allDay,
        deferPresentation: true,
      });
      await waitFor(() => expect(f.presentationRequested()).toBe(true));
      expect(f.dueFocused).not.toHaveBeenCalled();
      expect(
        screen.queryByRole(allDay ? "textbox" : "button", { name: "Due date" }),
      ).toBeNull();
      await act(async () => f.releasePresentation());
      const editor = await screen.findByTestId("task-property-editor");
      const due = await within(editor).findByRole<HTMLInputElement>(
        allDay ? "textbox" : "button",
        {
          name: "Due date",
        },
      );
      await waitFor(() => expect(document.activeElement).toBe(due));
      expect(due.dataset.databaseFieldId).toBe("task-due");
      expect(f.dueFocused).toHaveBeenLastCalledWith(1);
      act(() => f.focusDue(undefined));
      screen.getByRole("button", { name: "Title" }).focus();
      expect(document.activeElement).not.toBe(due);
      act(() => f.focusDue(2));
      await waitFor(() => expect(document.activeElement).toBe(due));
      expect(f.dueFocused.mock.calls).toEqual([[1], [2]]);
      act(() => f.makeReadonly());
      await waitFor(() =>
        allDay
          ? expect(due.readOnly).toBe(true)
          : expect(due.getAttribute("data-read-only")).toBe("true"),
      );
      // Read access permits personal reminders, never a shared date/clear write.
      if (allDay) {
        fireEvent.change(due, { target: { value: "07/12/2030" } });
        fireEvent.blur(due);
      } else {
        fireEvent.click(due);
        expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
      }
      fireEvent.click(screen.getByTestId("database-reminder-trigger"));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: allDay ? /On this date at 09:00/ : /At time/,
        }),
      );
      await waitFor(() =>
        expect(owner.gql).toHaveBeenCalledWith(
          expect.objectContaining({
            query: setDatabaseRowReminderMutation,
            variables: {
              input: {
                databaseId: "database-1",
                rowId: rows[0]!.row.id,
                fieldId: "task-due",
                offsetMinutes: 0,
              },
            },
          }),
        ),
      );
      expect(
        owner.gql.mock.calls.filter(
          ([request]) =>
            request.query === updateDatabaseCellValueMutation ||
            request.query === clearDatabaseCellValueMutation,
        ),
      ).toHaveLength(0);
      expect(
        f.canonical().cells.find((cell) => cell.fieldId === "task-due")?.value
          .dateTime,
      ).toMatchObject({
        start: "2030-07-10T22:00:00Z",
        allDay,
        timeZone: "Europe/Berlin",
      });
    },
  );

  test("retains a dirty title through remote readback and transient failure, but removes denied actions", async () => {
    const f = fixture();
    await screen.findByRole("button", { name: "Title" });
    const rowReads = () =>
      owner.gql.mock.calls.filter(
        ([request]) => request.query === databaseRowQuery,
      ).length;
    const beforeJoin = rowReads();
    await act(async () =>
      owner.acknowledge?.({
        data: { clientId: owner.socket.id, success: true },
      }),
    );
    await waitFor(() => expect(rowReads()).toBe(beforeJoin + 1));
    fireEvent.click(await screen.findByRole("button", { name: "Title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Owned unsaved title" } });
    f.remoteTitle("Another actor title");
    const beforeHint = rowReads();
    const hint = owner.socket.on.mock.calls.find(
      ([name]) => name === "database:tasks-changed",
    )![1];
    act(() =>
      hint({
        workspaceId: "workspace-1",
        databaseId: "database-1",
        eventId: "committed-other-actor",
      }),
    );
    await waitFor(() => expect(rowReads()).toBe(beforeHint + 1));
    expect((input as HTMLInputElement).value).toBe("Owned unsaved title");
    f.fail(new Error("temporary transport failure"));
    await act(async () => {
      await f.refresh();
    });
    expect(
      (
        screen.getByRole("textbox", {
          name: "Title",
        }) as HTMLInputElement
      ).value,
    ).toBe("Owned unsaved title");
    f.fail({ extensions: { code: "MIX_DATABASE_FORBIDDEN" } });
    await act(async () => {
      await f.refresh();
    });
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
  });
});

test("a reused Cell editor fences a late confirmed revision across A→B→A ownership", async () => {
  const { DatabaseCellEditor } = await import("../cells");
  const { DatabaseConflictProvider } = await import("../presence");
  let resolveOld!: (result: unknown) => void;
  const gql = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ updateDatabaseRowTitle: { editRevision: 2 } });
  const framework = {
    get: (token: unknown) => {
      if (token === GraphQLService) return { gql };
      throw new Error(`Unexpected service ${String(token)}`);
    },
    getOptional: () => undefined,
  } as unknown as FrameworkProvider;
  const cache = new Map();
  const onChanged = vi.fn();
  const surface = (id: string) => (
    <SWRConfig value={{ provider: () => cache }}>
      <FrameworkRoot framework={framework}>
        <MyoxusUIProvider env="test">
          <DatabaseConflictProvider>
            <DatabaseCellEditor
              databaseId="database-1"
              field={titleField}
              record={record}
              row={{
                ...rows[0]!,
                row: { ...rows[0]!.row, id, title: id, editRevision: 1 },
              }}
              rows={[]}
              onChanged={onChanged}
            />
          </DatabaseConflictProvider>
        </MyoxusUIProvider>
      </FrameworkRoot>
    </SWRConfig>
  );
  const rendered = render(surface("A"));
  fireEvent.doubleClick(screen.getByRole("button", { name: titleField.name }));
  fireEvent.change(screen.getByRole("textbox", { name: titleField.name }), {
    target: { value: "Old A write" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: titleField.name }), {
    key: "Enter",
  });
  await waitFor(() => expect(gql).toHaveBeenCalledTimes(1));
  rendered.rerender(surface("B"));
  rendered.rerender(surface("A"));
  await act(async () => {
    resolveOld({ updateDatabaseRowTitle: { editRevision: 99 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByRole("button", { name: titleField.name }));
  fireEvent.change(screen.getByRole("textbox", { name: titleField.name }), {
    target: { value: "Current A write" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: titleField.name }), {
    key: "Enter",
  });
  await waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
  expect(gql.mock.calls[1]![0].variables.input.expectedEditRevision).toBe(1);
});

test("native Activity projections do not reuse the prior selected actor cache", async () => {
  const f = fixture();
  const activity = () =>
    within(screen.getByTestId("database-row-activity-section")).getByRole(
      "button",
    );
  await screen.findByTestId("database-row-detail-content");
  fireEvent.click(activity());
  expect(
    (await screen.findByTestId("database-row-activity-message")).textContent,
  ).toContain("server/actor/workspace-1");
  f.switchIdentity("other-actor");
  await screen.findByTestId("database-row-detail-content");
  fireEvent.click(activity());
  expect(
    screen.queryByTestId("database-row-activity-message")?.textContent ?? "",
  ).not.toContain("server/actor/workspace-1");
  expect(
    (await screen.findByTestId("database-row-activity-message")).textContent,
  ).toContain("server/other-actor/workspace-1");
});

test("one shared section pages server counts and opens/backtracks children and an off-page atomic Add with focus", async () => {
  const f = fixture(false, false, { scope: "task", compatible: true }, true);
  const user = userEvent.setup({ skipHover: true });
  let section = await screen.findByTestId("database-task-relations");
  await within(section).findByText("7 of 21 complete");
  expect(within(section).getByText("3 archived").textContent).toBe(
    "3 archived",
  );
  expect(screen.queryByRole("combobox", { name: "Parent Task" })).toBeNull();
  const list = within(section).getByRole("group", { name: "Subtasks" });
  expect(within(list).getAllByRole("button")).toHaveLength(20);
  fireEvent.click(
    within(
      within(section).getByRole("navigation", { name: "Subtasks" }),
    ).getByRole("button", { name: "Go to next page" }),
  );
  let child = await within(section).findByRole("button", {
    name: "Subtask 21",
  });
  child.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Title" }).textContent).toContain(
      "Subtask 21",
    ),
  );
  expect(screen.getAllByTestId("database-row-detail-content")).toHaveLength(1);
  // Parent navigation uses a fresh authorized Task summary in the same surface.
  const parent = await screen.findByRole("button", {
    name: rows[0]!.row.title,
  });
  await user.click(parent);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Title" }).textContent).toContain(
      rows[0]!.row.title,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Back" }));
  const restoredParent = await screen.findByRole("button", {
    name: rows[0]!.row.title,
  });
  await waitFor(() => expect(document.activeElement).toBe(restoredParent));
  await user.click(screen.getByRole("button", { name: "Back" }));
  section = await screen.findByTestId("database-task-relations");
  child = await within(section).findByRole("button", { name: "Subtask 21" });
  await waitFor(() => expect(document.activeElement).toBe(child));
  expect(
    owner.gql.mock.calls
      .filter(([request]) => request.query === databaseTaskChildrenQuery)
      .at(-1)?.[0].variables,
  ).toEqual({
    workspaceId: "workspace-1",
    databaseId: "database-1",
    rowId: rows[0]!.row.id,
    first: 20,
    after: "cursor-after-20",
  });
  fireEvent.click(
    within(
      within(section).getByRole("navigation", { name: "Subtasks" }),
    ).getByRole("button", { name: "Go to previous page" }),
  );
  await within(section).findByRole("button", { name: "Subtask 01" });
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Add subtask" }));
  const title = await within(section).findByRole("textbox", {
    name: subtaskTitleLabel,
  });
  title.focus();
  fireEvent.change(title, {
    target: { value: "New independently actionable child" },
  });
  await user.keyboard("{Enter}");
  await within(section).findByText("7 of 22 complete");
  const created = await within(section).findByRole("button", {
    name: "New independently actionable child",
  });
  await waitFor(() => expect(document.activeElement).toBe(created));
  // A confirmed Add closes its editor; another draft requires a fresh intent.
  expect(
    within(section).queryByRole("textbox", { name: subtaskTitleLabel }),
  ).toBeNull();
  expect(
    within(section).queryByText(`${subtaskTitleLabel} is required.`),
  ).toBeNull();
  expect(
    f.createdChild()?.cells.find((cell) => cell.fieldId === relationField.id)
      ?.value.relation,
  ).toEqual([rows[0]!.row.id]);
  expect(f.createCount()).toBe(1);
  expect(
    owner.gql.mock.calls.filter(([request]) =>
      [
        updateDatabaseCellValueMutation,
        clearDatabaseCellValueMutation,
      ].includes(request.query),
    ),
  ).toHaveLength(0);
  await user.click(created);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Title" }).textContent).toContain(
      "New independently actionable child",
    ),
  );
  expect(screen.getAllByTestId("database-row-detail-content")).toHaveLength(1);
  expect(f.createCount()).toBe(1);
});

test("an unknown Add keeps its private attempt through candidate Open/Back and clears it for another actor", async () => {
  const f = fixture(
    false,
    false,
    { scope: "task", compatible: true },
    {
      initialChildren: 1,
    },
  );
  const user = userEvent.setup();
  let section = await screen.findByTestId("database-task-relations");
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Add subtask" }));
  let title = await within(section).findByRole("textbox", {
    name: subtaskTitleLabel,
  });
  f.loseCreateResponse();
  title.focus();
  fireEvent.change(title, { target: { value: "Uncertain subtask draft" } });
  await user.keyboard("{Enter}");
  await within(section).findByText(/Creation could not be confirmed/);
  expect((title as HTMLInputElement).value).toBe("Uncertain subtask draft");
  await user.click(
    within(section).getByRole("button", { name: "Check tasks" }),
  );
  const candidate = await within(section).findByRole("button", {
    name: "Uncertain subtask draft",
  });
  await user.click(candidate);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Title" }).textContent).toContain(
      "Uncertain subtask draft",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Back" }));
  section = await screen.findByTestId("database-task-relations");
  title = await within(section).findByRole("textbox", {
    name: subtaskTitleLabel,
  });
  await within(section).findByText(/Creation could not be confirmed/);
  expect((title as HTMLInputElement).value).toBe("Uncertain subtask draft");
  expect((title as HTMLInputElement).readOnly).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.keyboard("{Enter}");
  expect(f.createCount()).toBe(1);
  expect(
    owner.gql.mock.calls.filter(
      ([request]) => request.query === databaseTasksQuery,
    ),
  ).toHaveLength(2);
  f.switchIdentity("another-actor");
  await screen.findByTestId("database-task-relations");
  await user.click(await screen.findByRole("button", { name: "Task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Add subtask" }));
  const nextTitle = await screen.findByRole("textbox", {
    name: subtaskTitleLabel,
  });
  expect((nextTitle as HTMLInputElement).value).toBe("");
  expect(screen.queryByText(/Creation could not be confirmed/)).toBeNull();
  expect(f.createCount()).toBe(1);
});

test("Blocked by and Blocks share the native detail owner, page and Back focus without duplicate properties", async () => {
  const f = fixture(
    false,
    false,
    { scope: "task", compatible: true },
    true,
    true,
  );
  const user = userEvent.setup();
  let section = await screen.findByTestId("database-task-blocking");
  expect(screen.queryByRole("combobox", { name: "Prerequisites" })).toBeNull();
  const outgoing = await within(section).findByRole("group", {
    name: "Blocked by",
  });
  expect(
    (await within(outgoing).findByRole("button", { name: "Subtask 01" }))
      .textContent,
  ).toContain("Active prerequisite");
  const pagination = within(section).getByRole("navigation", {
    name: "Blocks",
  });
  await user.click(
    within(pagination).getByRole("button", { name: "Go to next page" }),
  );
  const incoming = within(section).getByRole("group", { name: "Blocks" });
  await user.click(
    await within(incoming).findByRole("button", { name: "Subtask 21" }),
  );
  await screen.findByRole("button", { name: "Back" });
  await user.click(screen.getByRole("button", { name: "Back" }));
  section = await screen.findByTestId("database-task-blocking");
  const returned = await within(
    within(section).getByRole("group", { name: "Blocks" }),
  ).findByRole("button", { name: "Subtask 21" });
  await waitFor(() => expect(document.activeElement).toBe(returned));
  expect(
    owner.gql.mock.calls
      .filter(([request]) => request.query === databaseTaskBlocksQuery)
      .at(-1)![0].variables.after,
  ).toBe("blocks-page-2");
  expect(f.createCount()).toBe(0);
  expect(f.parentIds()).toEqual([]);
});

describe("native Task following menu", () => {
  const followWrites = () =>
    owner.gql.mock.calls.filter(
      ([request]) =>
        (request.query === updateDatabaseCellValueMutation ||
          request.query === clearDatabaseCellValueMutation) &&
        request.variables.input.fieldId === "watchers",
    );
  async function openRowMenu() {
    await screen.findByRole("button", { name: "Title" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Task actions" }),
    );
  }
  async function selectAction(name: string) {
    const action = await screen.findByRole("menuitem", { name });
    await waitFor(() =>
      expect(action.getAttribute("data-disabled")).toBeNull(),
    );
    fireEvent.click(action);
  }
  test("preserves other watchers and uses the canonical Cell revision through follow/unfollow", async () => {
    const f = fixture(false, false, undefined, false, false, {
      users: ["other-watcher"],
    });
    await openRowMenu();
    await selectAction("Follow task");
    await waitFor(() =>
      expect(
        f.canonical().cells.find((cell) => cell.fieldId === "watchers")?.value
          .users,
      ).toEqual(["other-watcher", "actor"]),
    );
    await openRowMenu();
    await selectAction("Unfollow task");
    await waitFor(() =>
      expect(
        f.canonical().cells.find((cell) => cell.fieldId === "watchers")?.value
          .users,
      ).toEqual(["other-watcher"]),
    );
    expect(followWrites().map(([request]) => request.variables.input)).toEqual([
      {
        databaseId: "database-1",
        rowId: f.canonical().row.id,
        fieldId: "watchers",
        expectedEditRevision: 7,
        value: { users: ["other-watcher", "actor"] },
      },
      {
        databaseId: "database-1",
        rowId: f.canonical().row.id,
        fieldId: "watchers",
        expectedEditRevision: 8,
        value: { users: ["other-watcher"] },
      },
    ]);
  });

  test("keeps a real conflict after the dropdown closes, offers reload without Force, and dismisses it on actor change", async () => {
    const f = fixture(false, false, undefined, false, false, {
      users: ["other-watcher"],
      conflict: true,
    });
    await openRowMenu();
    await selectAction("Follow task");
    expect(
      (await screen.findByRole("button", { name: "Use latest version" }))
        .textContent,
    ).toBe("Use latest version");
    expect(
      screen.queryByRole("button", { name: "Overwrite with my value" }),
    ).toBeNull();
    expect(screen.getByTestId("database-conflict-latest").textContent).toBe(
      "Not following",
    );
    expect(followWrites()).toHaveLength(1);
    expect(
      f.canonical().cells.find((cell) => cell.fieldId === "watchers")?.value
        .users,
    ).toEqual(["other-watcher"]);
    act(() => f.switchIdentity("next-actor"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Use latest version" }),
      ).toBeNull(),
    );
    expect(followWrites()).toHaveLength(1);
  });
});

test("a reopened Task detail reauthorizes before rendering a warm private Row", async () => {
  const f = fixture();
  await screen.findByRole("button", { name: "Title" });
  f.fail(new Error("MIX_DATABASE_FORBIDDEN"));
  act(() => f.remountDetail());
  expect(screen.queryByRole("button", { name: "Title" })).toBeNull();
  expect(
    await screen.findByText("You do not have access to this row."),
  ).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Title" })).toBeNull();
});
