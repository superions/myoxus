// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  DatabaseTaskLifecycle,
  DatabaseTaskScope,
  DatabaseTaskReferenceState,
  databaseTaskReferencesQuery,
  type DatabaseTaskSummaryFragment,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  owner: undefined as unknown,
  rows: [] as DatabaseTaskSummaryFragment[],
  inventory: vi.fn(),
  cacheRead: undefined as
    | (() => Promise<{ rows: DatabaseTaskSummaryFragment[]; nextCursor: null }>)
    | undefined,
}));
vi.mock("./use-workspace-tasks", async () => {
  const { default: useSWR } = await import("swr");
  return {
    useTaskIdentity: () => fixture.owner,
    useTaskDestinations: () => ({
      readyDestinations: [],
      projects: [],
      defaultDestination: null,
      unavailableProjects: [],
      coverageComplete: true,
      nextCursor: null,
      destinationError: null,
    }),
    useWorkspaceTasks: (
      input: unknown,
      first: number,
      after: string | undefined,
    ) => {
      fixture.inventory(input, first, after);
      // Exercise the real SWR boundary with the same key across separate openings.
      const query = useSWR(
        fixture.cacheRead ? "same-owner-inventory" : null,
        () => fixture.cacheRead!(),
        { shouldRetryOnError: false },
      );
      return fixture.cacheRead
        ? {
            ...query,
            page: query.data
              ? {
                  ...query.data,
                  coverageComplete: true,
                  unavailableProjects: [],
                }
              : undefined,
          }
        : {
            page: {
              rows: fixture.rows,
              nextCursor: null,
              coverageComplete: true,
              unavailableProjects: [],
            },
            isLoading: false,
            error: null,
          };
    },
  };
});
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({ timezone: "UTC" }),
}));
vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});
import { TaskReferencePicker } from "./task-reference-picker";
const source = {
  sourceDocumentId: "immutable-doc",
  sourceExternalId: "source-key",
  blockId: "checkbox",
};
function setup() {
  const task: DatabaseTaskSummaryFragment = {
    workspaceId: "workspace",
    databaseId: "project",
    rowId: "task",
    title: "Closed canonical Task",
    projectTitle: "Private canonical Project",
    descriptionPreview: null,
    editRevision: 1,
    updatedAt: "2026-10-15T00:00:00Z",
    deletedAt: null,
    status: null,
    assignees: [],
    due: null,
    priority: null,
    canEdit: false,
    hasAssignees: false,
    hasDue: false,
    hasPriority: false,
    isSubtask: null,
    hasDependencies: null,
  };
  fixture.rows = [task];
  fixture.inventory.mockClear();
  fixture.cacheRead = undefined;
  const projection = {
    ...task,
    state: DatabaseTaskReferenceState.Available,
    task,
  };
  const gql = vi
    .fn()
    .mockResolvedValue({ workspace: { databaseTaskReferences: [projection] } });
  const server = {
    gql,
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: "actor" } },
  };
  const identity = JSON.stringify([
    server.id,
    server.baseUrl,
    "actor",
    "workspace",
  ]);
  const owner = {
    server,
    account: server.account$.value,
    identity,
    workspace: { id: "workspace" },
    availability: { status: "available" },
  };
  fixture.owner = owner;
  return { task, projection, gql, server, owner, identity };
}
afterEach(cleanup);

test("offers Closed Tasks in bounded inventory and retries the same scoped reference intent after canonical readback", async () => {
  const f = setup();
  const insert = vi
    .fn()
    .mockResolvedValueOnce("uncertain")
    .mockResolvedValueOnce("inserted");
  render(
    <MyoxusUIProvider env="test">
      <TaskReferencePicker
        openingOwnerIdentity={f.identity}
        source={source}
        close={vi.fn()}
        onInsertReference={insert}
      />
    </MyoxusUIProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Task lifecycle" }));
  await user.click(await screen.findByRole("option", { name: "Closed work" }));
  expect(fixture.inventory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      lifecycle: DatabaseTaskLifecycle.Closed,
      scope: DatabaseTaskScope.All,
    }),
    25,
    undefined,
  );
  const choice = screen.getByRole("button", { name: f.task.title });
  expect(within(choice).queryByRole("group", { name: "Status" })).toBeNull();
  expect(within(choice).queryByRole("group", { name: "Assignees" })).toBeNull();
  expect(within(choice).queryByRole("group", { name: "Due date" })).toBeNull();
  choice.focus();
  await user.keyboard("{Enter}");
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(f.gql.mock.calls[0][0].query).toBe(databaseTaskReferencesQuery);
  expect(f.gql.mock.calls[0][0].variables.targets).toEqual([
    { workspaceId: "workspace", databaseId: "project", rowId: "task" },
  ]);
  const intent = insert.mock.calls[0][0];
  await user.click(retry);
  await waitFor(() => expect(insert).toHaveBeenCalledTimes(2));
  expect(insert.mock.calls[1]).toEqual([
    intent,
    { workspaceId: "workspace", databaseId: "project", rowId: "task" },
    source,
  ]);
  expect(await screen.findByText("Reference inserted")).toHaveProperty(
    "textContent",
    "Reference inserted",
  );
});

test("owner changes abort a pending picker read and prevent insertion from its late result", async () => {
  const f = setup();
  let resolve!: (response: unknown) => void;
  f.gql.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const insert = vi.fn();
  const close = vi.fn();
  const props = {
    openingOwnerIdentity: f.identity,
    source,
    close,
    onInsertReference: insert,
  };
  const view = render(
    <MyoxusUIProvider env="test">
      <TaskReferencePicker {...props} />
    </MyoxusUIProvider>,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: f.task.title }));
  await waitFor(() => expect(f.gql).toHaveBeenCalledOnce());
  const signal = f.gql.mock.calls[0][0].context.signal as AbortSignal;
  f.server.account$.value.id = "other-actor";
  fixture.owner = {
    ...f.owner,
    identity: JSON.stringify([
      f.server.id,
      f.server.baseUrl,
      "other-actor",
      "workspace",
    ]),
  };
  view.rerender(
    <MyoxusUIProvider env="test">
      <TaskReferencePicker {...props} />
    </MyoxusUIProvider>,
  );
  expect(screen.queryByRole("button", { name: f.task.title })).toBeNull();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolve({ workspace: { databaseTaskReferences: [f.projection] } });
    await Promise.resolve();
  });
  expect(insert).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test("a warm picker inventory is discarded on dismissal before the same actor reopens with denied access", async () => {
  const f = setup();
  fixture.cacheRead = vi
    .fn()
    .mockResolvedValue({ rows: [f.task], nextCursor: null });
  const props = {
    openingOwnerIdentity: f.identity,
    source,
    close: vi.fn(),
    onInsertReference: vi.fn(),
  };
  const first = render(
    <MyoxusUIProvider env="test">
      <TaskReferencePicker {...props} />
    </MyoxusUIProvider>,
  );
  const warmTask = await screen.findByRole("button", { name: f.task.title });
  expect(within(warmTask).getByText(f.task.title).textContent).toBe(
    f.task.title,
  );
  expect(within(warmTask).getByText(f.task.projectTitle).textContent).toBe(
    f.task.projectTitle,
  );
  first.unmount();
  const denied = vi.fn().mockRejectedValue(new Error("access denied"));
  fixture.cacheRead = denied;
  render(
    <MyoxusUIProvider env="test">
      <TaskReferencePicker {...props} />
    </MyoxusUIProvider>,
  );
  // Even the first render must not display the previous authorized title.
  expect(screen.queryByRole("button", { name: f.task.title })).toBeNull();
  await screen.findByRole("button", { name: "Retry" });
  expect(denied).toHaveBeenCalledOnce();
  expect(screen.queryByText(f.task.title)).toBeNull();
  expect(screen.queryByText(f.task.projectTitle)).toBeNull();
});
