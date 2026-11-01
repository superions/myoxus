// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { assistantQueryFixture } from "../presentation/test-fixtures";
import "../test-editor-boundary";

import {
  databaseRowQuery,
  databaseRowsQuery,
  databaseSchemaQuery,
  databaseTaskReferencesQuery,
  DatabaseManagedSchemaReadiness,
  ProjectOptionPreset,
  ProjectStructurePreset,
  DatabaseProfileKind,
  DatabaseTaskReferenceState,
  moveDatabaseTasksMutation,
  prepareDatabaseTaskMoveQuery,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { SWRConfig } from "swr";
import { afterEach, expect, test, vi } from "vitest";
import { record, rows, relationField } from "../test-fixtures";
import type { DatabaseRecord } from "../types";

const owner = vi.hoisted(() => ({
  gql: vi.fn(),
  open: vi.fn(),
  destinations: [] as unknown[],
}));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: () => ({ workbench: { open: owner.open } }),
}));
vi.mock("@myoxus/i18n", async (original) => ({
  ...(await original<typeof import("@myoxus/i18n")>()),
  ...(await import("../test-i18n-mock").then((module) =>
    module.createDatabaseTestI18nModule(),
  )),
}));
vi.mock("./use-workspace-tasks", () => ({
  useTaskIdentity: () => ({
    identity: "actor/workspace",
    availability: { status: "available" },
    server: { gql: owner.gql },
    workspace: { id: "workspace-1" },
  }),
  useTaskDestinations: () => ({
    projects: owner.destinations,
    isLoading: false,
    mutate: vi.fn(),
    nextCursor: null,
  }),
}));
import { TaskMoveModal } from "./task-move-modal";

afterEach(cleanup);

function fixture(
  loseAcknowledgement = false,
  membershipTotal = 0,
  previewCase?: "limit" | "mixed" | "import",
) {
  const source: DatabaseRecord = {
    ...record,
    database: { ...record.database, profileKind: DatabaseProfileKind.Project },
    managedSchema: {
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
      schemaRevision: 3,
      canEditStructure: false,
      canEditMetadata: false,
      canManageLifecycle: false,
      taskBindings: [],
    },
  };
  const target = {
    ...source,
    database: {
      ...source.database,
      id: "target",
      title: "Existing Project",
      editRevision: 7,
    },
    managedSchema: { ...source.managedSchema!, schemaRevision: 8 },
  };
  if (membershipTotal) {
    target.fields = [...target.fields, relationField];
    target.managedSchema.taskBindings = [
      { roleKey: "task.phase", fieldId: relationField.id },
    ];
    target.managedSchema.variant = {
      ...target.managedSchema.variant,
      structure: ProjectStructurePreset.Phases,
    };
  }
  const row = {
    ...rows[0]!,
    row: { ...rows[0]!.row, rowKind: "task", editRevision: 11 },
  };
  const changed = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  let committed = false;
  let plan: unknown;
  owner.open.mockReset();
  owner.destinations = [
    {
      id: "target",
      title: "Existing Project",
      managedSchema: target.managedSchema,
    },
  ];
  owner.gql.mockReset().mockImplementation(async ({ query, variables }) => {
    const assistant = assistantQueryFixture(query, variables, source, row);
    if (assistant) return assistant;
    if (query === databaseSchemaQuery)
      return {
        workspace: {
          database: variables.databaseId === "target" ? target : source,
        },
      };
    if (query === databaseRowsQuery) {
      const offset = variables.after ? 100 : 0;
      const members = Array.from(
        { length: Math.min(100, Math.max(0, membershipTotal - offset)) },
        (_, index) => ({
          ...row,
          row: {
            ...row.row,
            id: `phase-${offset + index}`,
            databaseId: "target",
            rowKind: "phase",
            title: `Phase ${offset + index}`,
          },
          cells: [],
          cellRevisions: [],
        }),
      );
      return {
        workspace: {
          databaseRows: {
            rows: members,
            totalCount: membershipTotal,
            endCursor: members.length
              ? `page-${offset + members.length}`
              : null,
          },
        },
      };
    }
    if (query === databaseRowQuery) {
      if (previewCase === "mixed" && variables.rowId === "foreign")
        throw new Error("MIX_DATABASE_FORBIDDEN");
      if (previewCase === "mixed" && variables.rowId === "broken")
        throw new Error("Storage unavailable");
      return {
        workspace: {
          databaseRow:
            variables.rowId === "related"
              ? {
                  ...row,
                  row: { ...row.row, id: "related", title: "Related readable" },
                }
              : row,
        },
      };
    }
    if (query === prepareDatabaseTaskMoveQuery) {
      plan = variables.input;
      return {
        workspace: {
          prepareDatabaseTaskMove: {
            input: plan,
            eligible: !previewCase,
            reasons:
              previewCase === "import" ? ["TASK_IMPORT_IN_PROGRESS"] : [],
            requiredRelatedTasks:
              previewCase === "limit"
                ? Array.from({ length: 101 }, (_, index) => `related-${index}`)
                : previewCase === "mixed"
                  ? ["related", "broken"]
                  : [],
            boundaries:
              previewCase === "mixed"
                ? [
                    {
                      rowId: row.row.id,
                      fieldId: relationField.id,
                      relatedRowId: "foreign",
                      inbound: true,
                      recoverableTrash: false,
                    },
                  ]
                : [],
            allocatesDisplayIds: true,
          },
        },
      };
    }
    if (query === moveDatabaseTasksMutation) {
      expect(variables.input).toBe(plan);
      committed = true;
      if (loseAcknowledgement) throw new TypeError("Acknowledgement lost");
      return {
        moveDatabaseTasks: {
          sourceDatabaseId: source.database.id,
          targetDatabaseId: "target",
          rows: [{ ...row, row: { ...row.row, databaseId: "target" } }],
        },
      };
    }
    if (query === databaseTaskReferencesQuery)
      return {
        workspace: {
          databaseTaskReferences: variables.targets.map(
            (hint: { rowId: string }) => ({
              ...hint,
              workspaceId: "workspace-1",
              databaseId: committed ? "target" : source.database.id,
              state: DatabaseTaskReferenceState.Available,
              task: {
                workspaceId: "workspace-1",
                databaseId: committed ? "target" : source.database.id,
                rowId: hint.rowId,
              },
            }),
          ),
        },
      };
    throw new Error("Unexpected operation");
  });
  render(
    <MyoxusUIProvider env="test">
      <SWRConfig
        value={{ provider: () => new Map(), shouldRetryOnError: false }}
      >
        <TaskMoveModal
          record={source}
          row={row}
          onChanged={changed}
          onClose={close}
          returnFocusRef={createRef<HTMLButtonElement>()}
        />
      </SWRConfig>
    </MyoxusUIProvider>,
  );
  return { source, target, row, close, changed };
}

test.each([true])(
  "moves the original Task with exact preview fences and readback after a lost acknowledgement (%s)",
  async (loseAcknowledgement) => {
    const user = userEvent.setup();
    const f = fixture(loseAcknowledgement);
    await user.click(await screen.findByTestId("task-move-destination"));
    await user.click(
      await screen.findByRole("option", { name: "Existing Project" }),
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("task-move-preview") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("task-move-preview"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("task-move-confirm") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const previewCall = owner.gql.mock.calls.find(
      ([request]) => request.query === prepareDatabaseTaskMoveQuery,
    )![0];
    expect(previewCall.variables.input).toMatchObject({
      sourceDatabaseId: f.source.database.id,
      targetDatabaseId: "target",
      sourceEditRevision: f.source.database.editRevision,
      targetEditRevision: 7,
      sourceSchemaRevision: 3,
      targetSchemaRevision: 8,
      selection: [{ rowId: f.row.row.id, expectedEditRevision: 11 }],
    });
    await user.click(screen.getByTestId("task-move-confirm"));
    if (loseAcknowledgement) {
      expect(await screen.findByTestId("task-move-check")).not.toBeNull();
      expect(f.close).not.toHaveBeenCalled();
      await user.click(screen.getByTestId("task-move-check"));
    }
    await waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(
      owner.gql.mock.calls.filter(
        ([request]) => request.query === moveDatabaseTasksMutation,
      ),
    ).toHaveLength(1);
    expect(owner.open).toHaveBeenCalledWith(
      `/databases/target?rowId=${f.row.row.id}`,
      { at: "active" },
    );
  },
);

test.each([101])(
  "membership pagination uses native continuation for %s Rows",
  async (total) => {
    const user = userEvent.setup();
    fixture(false, total);
    await user.click(await screen.findByTestId("task-move-destination"));
    await user.click(
      await screen.findByRole("option", { name: "Existing Project" }),
    );
    await waitFor(() =>
      expect(
        owner.gql.mock.calls.filter(
          ([request]) => request.query === databaseRowsQuery,
        ),
      ).toHaveLength(1),
    );
    await screen.findByTestId("task-move-phase");
    await user.click(screen.getByTestId("task-move-phase"));
    await user.click(await screen.findByRole("option", { name: "Phase 99" }));
    if (total === 100)
      expect(
        screen.queryByRole("button", { name: "Load more rows" }),
      ).toBeNull();
    else {
      await user.click(
        await screen.findByRole("button", { name: "Load more rows" }),
      );
      await waitFor(() =>
        expect(
          owner.gql.mock.calls.filter(
            ([request]) =>
              request.query === databaseRowsQuery &&
              request.variables.after === "page-100",
          ),
        ).toHaveLength(1),
      );
      await user.click(screen.getByTestId("task-move-phase"));
      await user.click(
        await screen.findByRole("option", { name: "Phase 100" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Load more rows" }),
        ).toBeNull(),
      );
    }
  },
);

async function reviewMove() {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("task-move-destination"));
  await user.click(
    await screen.findByRole("option", { name: "Existing Project" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByTestId("task-move-preview") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByTestId("task-move-preview"));
}

test("one denied or failed related endpoint preserves authorized native repair links and surfaces read failure", async () => {
  fixture(false, 0, "mixed");
  await reviewMove();
  expect(await screen.findByText("Related readable")).not.toBeNull();
  expect(
    await screen.findByTestId("task-move-related-read-error"),
  ).not.toBeNull();
  expect(
    screen.getAllByRole("button", { name: "Open details" }).length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("foreign")).toBeNull();
  expect(screen.queryByText("Storage unavailable")).toBeNull();
});
