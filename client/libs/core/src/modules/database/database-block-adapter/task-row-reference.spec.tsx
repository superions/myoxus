// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  DatabaseTaskReferenceState,
  DatabaseStatusGroup,
  type DatabaseTaskReferenceFragment,
} from "@myoxus/graphql";
import type { FrameworkProvider } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
const fixture = vi.hoisted(() => ({ owner: undefined as unknown }));
vi.mock("../tasks/use-workspace-tasks", () => ({
  useTaskIdentity: () => fixture.owner,
}));
vi.mock("../tasks/use-task-freshness", () => ({
  subscribeTaskFreshness: () => () => {},
}));
vi.mock("../tasks/task-detail", async () => {
  const { record, rows } = await import("../test-fixtures");
  return {
    TaskDetail: ({
      embedded,
    }: import("react").ComponentProps<
      typeof import("../tasks/task-detail").TaskDetail
    >) =>
      embedded?.({
        record,
        row: rows[0]!,
        canEdit: false,
        onChanged: async () => {},
      }),
  };
});
vi.mock("../row-detail/task-navigation", async (original) => ({
  ...(await original<typeof import("../row-detail/task-navigation")>()),
  useTaskDetailNavigation: () => ({
    navigation: { requestLeave: (next: () => void) => next() },
  }),
}));
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({ timezone: "UTC" }),
}));
vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});
import { TaskRowReference } from "./task-row-reference";
import { taskReferenceBatch } from "./task-reference-batch";
const target = {
  workspaceId: "workspace",
  databaseId: "project",
  rowId: "canonical-row",
};
function projection(): DatabaseTaskReferenceFragment {
  return {
    ...target,
    state: DatabaseTaskReferenceState.Available,
    task: {
      ...target,
      title: "Current canonical Task",
      projectTitle: "Current Project",
      descriptionPreview: null,
      editRevision: 4,
      updatedAt: "2026-10-15T00:00:00Z",
      deletedAt: null,
      status: {
        id: "status.done",
        name: "Done",
        position: 1,
        colorRole: "tag.green",
        group: DatabaseStatusGroup.Complete,
      },
      assignees: [{ id: "member", name: "Assigned person" }],
      due: {
        start: "2030-01-03T00:00:00Z",
        end: null,
        allDay: true,
        timeZone: "UTC",
      },
      priority: null,
      canEdit: true,
      hasAssignees: true,
      hasDue: true,
      hasPriority: false,
      isSubtask: null,
      hasDependencies: null,
    },
  };
}
function setup() {
  const gql = vi.fn().mockResolvedValue({
    workspace: { databaseTaskReferences: [projection()] },
  });
  const server = {
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: "actor-a" } },
    gql,
  };
  const owner = {
    server,
    account: server.account$.value,
    identity: JSON.stringify([
      server.id,
      server.baseUrl,
      "actor-a",
      "workspace",
    ]),
    availability: {
      status: "available",
      reason: "server-backed",
      serverWorkspaceId: "workspace",
    },
    workspace: { id: "workspace" },
  };
  fixture.owner = owner;
  const open = vi.fn();
  const framework = {
    get: () => ({ workbench: { open } }),
  } as unknown as FrameworkProvider;
  return { gql, server, owner, open, framework };
}
afterEach(cleanup);

test("changing actor cannot reuse a cached reference title", async () => {
  const f = setup();
  const view = render(
    <MyoxusUIProvider env="test">
      <TaskRowReference framework={f.framework} target={target} />
    </MyoxusUIProvider>,
  );
  await screen.findByText("Current canonical Task");
  f.server.account$.value.id = "actor-b";
  fixture.owner = {
    ...f.owner,
    identity: JSON.stringify([
      f.server.id,
      f.server.baseUrl,
      "actor-b",
      "workspace",
    ]),
  };
  f.gql.mockResolvedValue({
    workspace: {
      databaseTaskReferences: [
        {
          ...target,
          state: DatabaseTaskReferenceState.Unavailable,
          task: null,
        },
      ],
    },
  });
  view.rerender(
    <MyoxusUIProvider env="test">
      <TaskRowReference framework={f.framework} target={target} />
    </MyoxusUIProvider>,
  );
  expect(screen.queryByText("Current canonical Task")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" }).textContent).toBe(
      "Retry",
    ),
  );
});

test("a stored reference opens the same Row in its current owner and loses private labels after revocation", async () => {
  const f = setup();
  const moved = projection();
  moved.databaseId = "current-project";
  moved.task = {
    ...moved.task!,
    databaseId: "current-project",
    projectTitle: "Current owner",
    descriptionPreview: null,
  };
  f.gql.mockResolvedValue({ workspace: { databaseTaskReferences: [moved] } });
  render(
    <MyoxusUIProvider env="test">
      <div contentEditable suppressContentEditableWarning>
        <TaskRowReference framework={f.framework} target={target} />
      </div>
    </MyoxusUIProvider>,
  );
  await userEvent
    .setup()
    .dblClick(await screen.findByText("Current canonical Task"));
  expect(f.open).toHaveBeenCalledWith(
    "/tasks?view=kanban&scope=All&lifecycle=Closed&databaseId=current-project&rowId=canonical-row&projectId=current-project",
    { at: "active" },
  );
  f.gql.mockResolvedValue({
    workspace: {
      databaseTaskReferences: [
        {
          ...target,
          state: DatabaseTaskReferenceState.Unavailable,
          task: null,
        },
      ],
    },
  });
  await act(async () => {
    await taskReferenceBatch(f.framework).refresh();
  });
  expect(screen.queryByText("Current canonical Task")).toBeNull();
});
