// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  getAccountColorMode,
  setAccountColorMode,
} from "../../../shared/user-preferences-helper";
import {
  smokeGql,
  waitForWorkspaceReady,
  waitForWorkspaceDocSync,
} from "../../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${API}/graphql`;
type Project = {
  database: { id: string };
  fields: Array<{
    id: string;
    name: string;
    editRevision: number;
    config: {
      select?: { options: Array<{ id: string; name: string }> };
      status?: {
        defaultOptionId: string;
        options: Array<{ id: string; name: string }>;
      };
    };
  }>;
  fieldRoles: Array<{ roleKey: string; fieldId: string }>;
};
type Row = {
  row: {
    id: string;
    title: string;
    editRevision: number;
    deletedAt: string | null;
  };
  cells: Array<{
    fieldId: string;
    editRevision: number;
    value: {
      text?: string;
      users?: string[];
      status?: string;
      percent?: number | null;
      relation?: string[] | null;
      dateTime?: {
        start: string;
        end: string | null;
        allDay: boolean;
        timeZone: string | null;
      } | null;
    };
  }>;
};
type Inventory = {
  totalCount: number;
  rows: Array<{ rowId: string; databaseId: string; title: string }>;
};
const role = (project: Project, key: string) => {
  const field = project.fieldRoles.find((field) => field.roleKey === key);
  if (!field) throw new Error(`Fixture Project lacks ${key}`);
  return field.fieldId;
};

async function openIndexedProjectBrief(
  page: Page,
  goal: string,
  expectedBriefId: string | null,
) {
  expect(expectedBriefId).toMatch(
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  );
  await page.getByTestId("slider-bar-quick-search-button").click();
  const input = page.locator('[data-myoxus-ui-role="command-palette-input"]');
  const brief = page
    .getByRole("dialog")
    .getByText("Project brief", { exact: true });
  let searchFailure: unknown;
  // Deferred indexing may finish after reload. Requery through the actual UI;
  // recent documents alone must never satisfy this content-search assertion.
  await expect
    .poll(
      async () => {
        try {
          await input.fill("");
          const searched = page.waitForResponse(
            (response) =>
              response.request().headers()["x-operation-name"] ===
                "indexerSearchDocs" &&
              response.request().postDataJSON().variables.input.keyword ===
                goal,
          );
          const [response] = await Promise.all([searched, input.fill(goal)]);
          expect(response.ok()).toBe(true);
          const payload = await response.json();
          expect(payload.errors).toBeUndefined();
          expect(Array.isArray(payload.data?.workspace?.searchDocs)).toBe(true);
          return (
            payload.data.workspace.searchDocs.some(
              (document: { externalId: string }) =>
                document.externalId === expectedBriefId,
            ) && (await brief.isVisible())
          );
        } catch (error) {
          // Stop polling on transport/protocol/UI failures and propagate them;
          // only a successful search without the indexed copy is retryable.
          searchFailure = error;
          return true;
        }
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe(true);
  if (searchFailure) throw searchFailure;
  await brief.click();
}

async function fixture(request: APIRequestContext) {
  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const gql = <T>(query: string, variables: Record<string, unknown> = {}) =>
    smokeGql<T>(request, GQL, cookies, query, variables);
  const owner = await gql<{
    currentUser: {
      id: string;
      name: string;
      preferences: { values: { locale: string | null } };
    };
    workspaces: Array<{
      id: string;
      initialized: boolean;
      workspaceType: string;
    }>;
  }>(
    `query {currentUser{id name preferences{values{locale}}} workspaces{id initialized workspaceType}}`,
  );
  const workspace = owner.workspaces.find(
    (workspace) =>
      workspace.initialized && workspace.workspaceType === "Personal",
  );
  if (!workspace)
    throw new Error(
      "Task flow requires the seeded admin's initialized personal workspace",
    );
  const workspaceId = workspace.id;
  const projects: Project[] = [];
  const read = async (project: Project, rowId: string) =>
    (
      await gql<{ workspace: { databaseRow: Row } }>(
        `query($workspaceId:String!,$databaseId:ID!,$rowId:ID!){workspace(id:$workspaceId){databaseRow(databaseId:$databaseId,rowId:$rowId,includeTrashed:true){row{id title editRevision deletedAt}cells{fieldId editRevision value{text users status percent relation dateTime{start end allDay timeZone}}}}}}`,
        { workspaceId, databaseId: project.database.id, rowId },
      )
    ).workspace.databaseRow;
  const inventory = async () =>
    (
      await gql<{ workspace: { databaseTasks: Inventory } }>(
        `query($workspaceId:String!){workspace(id:$workspaceId){databaseTasks(input:{scope:Mine,lifecycle:Open,timeZone:"UTC"},first:100){totalCount rows{rowId databaseId title}}}}`,
        { workspaceId },
      )
    ).workspace.databaseTasks;
  const cleanup = async () => {
    // Purge only the two Projects created by this fixture, even after a failed journey.
    const failures: unknown[] = [];
    for (const project of projects) {
      try {
        await gql(
          `mutation($input:DatabaseLifecycleInput!){trashDatabase(input:$input){database{id}}}`,
          { input: { databaseId: project.database.id } },
        );
        await gql(
          `mutation($input:DatabaseLifecycleInput!){deleteDatabasePermanently(input:$input)}`,
          { input: { databaseId: project.database.id } },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await gql(
        `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}`,
        { input: { locale: owner.currentUser.preferences.values.locale } },
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "Task Project cleanup failed");
  };
  try {
    await gql(
      `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}`,
      { input: { locale: "en" } },
    );
    for (const [index, priorityPreset] of ["ThreeStep", "FiveStep"].entries()) {
      const created = await gql<{ createProject: Project }>(
        `mutation($input:CreateProjectInput!){createProject(input:$input){database{id}fields{id name editRevision config{select{options{id name}}status{defaultOptionId options{id name}}}}fieldRoles{roleKey fieldId}}}`,
        {
          input: {
            workspaceId,
            title: `Task flow ${index + 1} · International release coordination ${Date.now()}`,
            structurePreset: "TasksOnly",
            priorityPreset,
          },
        },
      );
      projects.push(created.createProject);
    }
    return {
      cookies,
      gql,
      workspaceId,
      projects,
      actorId: owner.currentUser.id,
      actorName: owner.currentUser.name,
      read,
      inventory,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function openRow(
  page: Page,
  workspaceId: string,
  project: Project,
  rowId: string,
) {
  await page.goto(
    `${FRONTEND}/workspace/${workspaceId}/tasks?scope=Mine&lifecycle=Open&databaseId=${project.database.id}&rowId=${rowId}`,
  );
  const detail = page.getByTestId("context-surface-task-details");
  await expect(detail).toBeVisible();
  return detail;
}

async function createRow(
  f: Awaited<ReturnType<typeof fixture>>,
  project: Project,
  title: string,
  due?: string,
  assigneeId = f.actorId,
) {
  return (
    await f.gql<{ createDatabaseRow: Row }>(
      `mutation($input:CreateDatabaseRowInput!){createDatabaseRow(input:$input){row{id title editRevision deletedAt}cells{fieldId editRevision value{text users status}}}}`,
      {
        input: {
          databaseId: project.database.id,
          title,
          cells: [
            {
              fieldId: role(project, "task.assignees"),
              value: { users: [assigneeId] },
            },
            ...(due
              ? [
                  {
                    fieldId: role(project, "task.dueDate"),
                    value: {
                      dateTime: { start: due, allDay: true, timeZone: "UTC" },
                    },
                  },
                ]
              : []),
          ],
        },
      },
    )
  ).createDatabaseRow;
}

test("creates the original Task, edits it across two Projects and preserves closed/trash/restore identity", async ({
  page,
  context,
  request,
}) => {
  const errors = observeErrors(page);
  const f = await fixture(request);
  try {
    await injectSessionCookies(context, f.cookies);
    const [first, second] = f.projects as [Project, Project];
    expect(
      first.fields.find((field) => field.id === role(first, "task.priority"))
        ?.config.select?.options,
    ).toHaveLength(3);
    expect(
      second.fields.find((field) => field.id === role(second, "task.priority"))
        ?.config.select?.options,
    ).toHaveLength(5);
    const renamed = second.fields.find(
      (field) => field.id === role(second, "task.title"),
    )!;
    await expect(
      f.gql(
        `mutation($input:UpdateDatabaseFieldInput!){updateDatabaseField(input:$input){id name editRevision}}`,
        {
          input: {
            databaseId: second.database.id,
            fieldId: renamed.id,
            expectedEditRevision: renamed.editRevision,
            name: "Delivery item",
            force: true,
          },
        },
      ),
    ).rejects.toThrow(/MIX_DATABASE_/);
    const control = await createRow(
      f,
      first,
      "First Project control",
      "2026-10-12T00:00:00Z",
    );
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=Mine&lifecycle=Open`,
    );
    await waitForWorkspaceReady(page);
    await page.getByTestId("tasks-new-task").click();
    const modal = page.getByTestId("task-creation-modal");
    const title = "Native creation · reviewed regional rollout";
    await modal
      .getByRole("button", { name: "Destination", exact: true })
      .click();
    await modal.getByTestId("task-destination-select").click();
    const projectName = (
      await f.gql<{ workspace: { database: { database: { title: string } } } }>(
        `query($w:String!,$d:ID!){workspace(id:$w){database(databaseId:$d){database{title}}}}`,
        { w: f.workspaceId, d: second.database.id },
      )
    ).workspace.database.database.title;
    await page.getByRole("option", { name: projectName, exact: true }).click();
    await modal
      .getByRole("textbox", { name: "Title", exact: true })
      .fill(title);
    await expect(modal.getByText("Assignees", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "Assignees", exact: true }).click();
    await modal.getByRole("textbox", { name: "Title", exact: true }).click();
    const committed = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseRow",
    );
    await modal.getByRole("button", { name: "Create", exact: true }).click();
    const payload = await (await committed).json();
    expect(payload.errors).toBeUndefined();
    const rowId = payload.data.createDatabaseRow.row.id as string;
    const detail = page.getByTestId("context-surface-task-details");
    await detail.getByText(title, { exact: true }).click();
    const titleField = second.fields.find(
      (field) => field.id === role(second, "task.title"),
    )!.name;
    const input = detail.getByRole("textbox", {
      name: titleField,
      exact: true,
    });
    await input.fill(`${title} · confirmed`);
    await input.press("Enter");
    await expect
      .poll(async () => (await f.read(second, rowId)).row.title)
      .toBe(`${title} · confirmed`);
    await expect(page.getByTestId(`task-row-${control.row.id}`)).toBeVisible();

    // Decomposition stays in the existing cockpit detail. Its derived counts
    // must never overwrite this parent's ordinary Status or manual Progress.
    const originalTaskURL = page.url();
    const progressField = second.fields.find(
      (field) => field.id === role(second, "task.progress"),
    )!;
    const openProgress = async () => {
      const edit = detail.getByRole("button", {
        name: progressField.name,
        exact: true,
      });
      if (await edit.isVisible()) {
        await edit.click();
      } else {
        await detail
          .getByRole("button", { name: "Add property", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: progressField.name, exact: true })
          .click();
      }
      return detail.getByTestId("task-property-editor").getByRole("slider", {
        name: progressField.name,
        exact: true,
      });
    };
    const slider = await openProgress();
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await slider.press("ArrowRight");
    await expect
      .poll(
        async () =>
          (await f.read(second, rowId)).cells.find(
            (cell) => cell.fieldId === progressField.id,
          )?.value.percent,
      )
      .toBe(1);
    const beforeDecomposition = await f.read(second, rowId);
    const parentWorkflow = (row: Row) =>
      row.cells.filter(
        (cell) =>
          cell.fieldId === progressField.id ||
          cell.fieldId === role(second, "task.status"),
      );
    const invoking = new URL(originalTaskURL);
    invoking.searchParams.set("scope", "All");
    invoking.searchParams.set("projectId", second.database.id);
    invoking.searchParams.set("search", `${title} · confirmed`);
    invoking.hash = "task-decomposition-context";
    await page.goto(invoking.toString());
    await expect(detail).toBeVisible();
    await detail
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Add subtask", exact: true })
      .click();
    const section = detail.getByTestId("database-task-relations");
    await expect(
      section.getByText("0 of 0 complete", { exact: true }),
    ).toHaveCount(0);
    const subtaskTitle = "Unassigned child · independent follow-up";
    const subtaskInput = section.getByRole("textbox", {
      name: "Title",
      exact: true,
    });
    await subtaskInput.fill(subtaskTitle);
    const childCommit = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseRow",
    );
    await subtaskInput.press("Enter");
    const childResponse = await childCommit;
    const childPayload = await childResponse.json();
    expect(childPayload.errors).toBeUndefined();
    const childId = childPayload.data.createDatabaseRow.row.id as string;
    expect(childResponse.request().postDataJSON().variables.input).toEqual({
      databaseId: second.database.id,
      title: subtaskTitle,
      cells: [
        { fieldId: role(second, "task.parent"), value: { relation: [rowId] } },
      ],
    });
    const child = await f.read(second, childId);
    expect(
      child.cells.find((cell) => cell.fieldId === role(second, "task.parent"))
        ?.value.relation,
    ).toEqual([rowId]);
    expect(
      child.cells.find(
        (cell) => cell.fieldId === role(second, "task.assignees"),
      )?.value.users ?? [],
    ).toEqual([]);
    await expect(
      section.getByText("0 of 1 complete", { exact: true }),
    ).toBeVisible();
    const childOpen = section.getByRole("button", {
      name: subtaskTitle,
      exact: true,
    });
    await expect(childOpen).toBeFocused();
    await childOpen.press("Enter");
    const childURL = new URL(invoking);
    childURL.searchParams.set("rowId", childId);
    await expect.poll(() => page.url()).toBe(childURL.toString());
    await expect(page.getByTestId("context-surface-task-details")).toHaveCount(
      1,
    );
    await expect(
      detail.getByRole("textbox", { name: "Title", exact: true }),
    ).toHaveCount(0);
    await expect(
      detail.getByRole("button", { name: titleField, exact: true }),
    ).toContainText(subtaskTitle);
    await expect(
      section.getByRole("button", {
        name: `${title} · confirmed`,
        exact: true,
      }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Status", exact: true }).click();
    await detail
      .getByTestId("task-property-editor")
      .getByRole("combobox", { name: "Status", exact: true })
      .click();
    const childStatusCommit = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page.getByRole("option", { name: "Completed", exact: true }).click();
    const childStatusResponse = await childStatusCommit;
    expect((await childStatusResponse.json()).errors).toBeUndefined();
    const completedStatus = childStatusResponse.request().postDataJSON()
      .variables.input.value.status;
    await expect
      .poll(
        async () =>
          (await f.read(second, childId)).cells.find(
            (cell) => cell.fieldId === role(second, "task.status"),
          )?.value.status,
      )
      .toBe(completedStatus);
    await detail
      .getByRole("button", { name: "Back", exact: true })
      .press("Enter");
    await expect.poll(() => page.url()).toBe(invoking.toString());
    await expect(page.getByTestId("context-surface-task-details")).toHaveCount(
      1,
    );
    await expect(
      section.getByText("1 of 1 complete", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("0 archived", { exact: true })).toHaveCount(
      0,
    );
    await expect(childOpen).toBeFocused();
    expect(parentWorkflow(await f.read(second, rowId))).toEqual(
      parentWorkflow(beforeDecomposition),
    );
    await expect(await openProgress()).toHaveAttribute("aria-valuenow", "1");
    await detail
      .getByTestId("task-property-editor")
      .getByRole("button", { name: "Close", exact: true })
      .click();

    // Blocking is a separate graph: completing a prerequisite changes only
    // derived activity, never a dependent's Status, dates or manual Progress.
    const dependentB = await createRow(
      f,
      second,
      "Blocker flow B · owned dependent",
      "2026-10-20T00:00:00Z",
    );
    const dependentC = await createRow(
      f,
      second,
      "Blocker flow C · owned dependent",
      "2026-10-21T00:00:00Z",
    );
    const blockerField = second.fields.find(
      (field) => field.id === role(second, "task.blockedBy"),
    )!;
    const dependencyContext = new URL(invoking);
    dependencyContext.searchParams.set("search", "Blocker flow");
    dependencyContext.hash = "task-blocking-context";
    const blocking = detail.getByTestId("database-task-blocking");
    const currentTitle = detail.getByRole("button", {
      name: titleField,
      exact: true,
    });
    const blockingURL = (id: string) => {
      const url = new URL(dependencyContext);
      url.searchParams.set("rowId", id);
      return url;
    };
    const stableDependentCells = (row: Row) =>
      row.cells.filter((cell) =>
        [
          role(second, "task.status"),
          role(second, "task.startDate"),
          role(second, "task.dueDate"),
          role(second, "task.progress"),
        ].includes(cell.fieldId),
      );
    const baselineB = stableDependentCells(
      await f.read(second, dependentB.row.id),
    );
    const baselineC = stableDependentCells(
      await f.read(second, dependentC.row.id),
    );
    for (const dependent of [dependentB, dependentC]) {
      await page.goto(blockingURL(dependent.row.id).toString());
      await expect(currentTitle).toContainText(dependent.row.title);
      await detail
        .getByRole("button", { name: "Task actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Blocked by", exact: true })
        .click();
      const picker = blocking.getByRole("combobox", {
        name: blockerField.name,
        exact: true,
      });
      await picker.click();
      await picker.fill(`${title} · confirmed`);
      await page
        .getByRole("option", { name: `${title} · confirmed`, exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await f.read(second, dependent.row.id)).cells.find(
              (cell) => cell.fieldId === blockerField.id,
            )?.value.relation,
        )
        .toEqual([rowId]);
      await expect(
        blocking.getByText("Active prerequisite", { exact: true }),
      ).toBeVisible();
    }
    const blockerCounts = async () =>
      (
        await f.gql<{
          workspace: {
            databaseTasks: {
              rows: Array<{
                rowId: string;
                blockers: {
                  available: boolean;
                  activeCount: number | null;
                  unresolvedCount: number | null;
                };
              }>;
            };
          };
        }>(
          `query($w:String!,$d:ID!){workspace(id:$w){databaseTasks(input:{scope:All,lifecycle:Open,projectIds:[$d],search:"Blocker flow",timeZone:"UTC"},first:100){rows{rowId blockers{available activeCount unresolvedCount}}}}}`,
          { w: f.workspaceId, d: second.database.id },
        )
      ).workspace.databaseTasks.rows.sort((a, b) =>
        a.rowId.localeCompare(b.rowId),
      );
    const expectedCounts = (activeCount: number) =>
      [dependentB, dependentC]
        .map((dependent) => ({
          rowId: dependent.row.id,
          blockers: { available: true, activeCount, unresolvedCount: 0 },
        }))
        .sort((a, b) => a.rowId.localeCompare(b.rowId));
    await expect.poll(blockerCounts).toEqual(expectedCounts(1));
    const filter = page.getByRole("combobox", {
      name: "Blocking",
      exact: true,
    });
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await filter.click();
    await page.getByRole("option", { name: "Blocked", exact: true }).click();
    await page.keyboard.press("Escape");
    dependencyContext.searchParams.set("blockedOnly", "true");
    await expect
      .poll(() => page.url())
      .toBe(blockingURL(dependentC.row.id).toString());
    for (const dependent of [dependentB, dependentC])
      await expect(
        page
          .getByTestId(`task-row-${dependent.row.id}`)
          .getByText("1 active", { exact: true }),
      ).toBeVisible();
    const prerequisiteOpen = blocking.getByRole("button", {
      name: `${title} · confirmed`,
      exact: true,
    });
    await prerequisiteOpen.press("Enter");
    await expect.poll(() => page.url()).toBe(blockingURL(rowId).toString());
    await expect(currentTitle).toContainText(`${title} · confirmed`);
    await expect(page.getByTestId("context-surface-task-details")).toHaveCount(
      1,
    );
    for (const dependent of [dependentB, dependentC])
      await expect(
        blocking.getByRole("button", {
          name: dependent.row.title,
          exact: true,
        }),
      ).toBeVisible();
    await detail
      .getByRole("button", { name: "Back", exact: true })
      .press("Enter");
    await expect
      .poll(() => page.url())
      .toBe(blockingURL(dependentC.row.id).toString());
    await expect(currentTitle).toContainText(dependentC.row.title);
    await expect(prerequisiteOpen).toBeFocused();
    await prerequisiteOpen.press("Enter");
    await expect(currentTitle).toContainText(`${title} · confirmed`);
    await detail.getByRole("button", { name: "Status", exact: true }).click();
    await detail
      .getByTestId("task-property-editor")
      .getByRole("combobox", { name: "Status", exact: true })
      .click();
    await page.getByRole("option", { name: "Completed", exact: true }).click();
    await expect.poll(blockerCounts).toEqual(expectedCounts(0));
    for (const dependent of [dependentB, dependentC])
      await expect(
        page.getByTestId(`task-row-${dependent.row.id}`),
      ).toHaveCount(0);
    const statusConfig = second.fields.find(
      (field) => field.id === role(second, "task.status"),
    )!.config.status!;
    const openStatus = statusConfig.options.find(
      (option) => option.id === statusConfig.defaultOptionId,
    )!.name;
    await detail.getByRole("button", { name: "Status", exact: true }).click();
    await detail
      .getByTestId("task-property-editor")
      .getByRole("combobox", { name: "Status", exact: true })
      .click();
    await page.getByRole("option", { name: openStatus, exact: true }).click();
    await expect.poll(blockerCounts).toEqual(expectedCounts(1));
    for (const dependent of [dependentB, dependentC])
      await expect(
        page
          .getByTestId(`task-row-${dependent.row.id}`)
          .getByText("1 active", { exact: true }),
      ).toBeVisible();
    expect(
      stableDependentCells(await f.read(second, dependentB.row.id)),
    ).toEqual(baselineB);
    expect(
      stableDependentCells(await f.read(second, dependentC.row.id)),
    ).toEqual(baselineC);
    await detail
      .getByRole("button", { name: "Back", exact: true })
      .press("Enter");
    await expect
      .poll(() => page.url())
      .toBe(blockingURL(dependentC.row.id).toString());
    await expect(currentTitle).toContainText(dependentC.row.title);
    await expect(prerequisiteOpen).toBeFocused();
    await detail
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Blocked by", exact: true })
      .click();
    const unlink = blocking.getByRole("combobox", {
      name: blockerField.name,
      exact: true,
    });
    await unlink.click();
    await unlink.press("Backspace");
    await expect
      .poll(
        async () =>
          (await f.read(second, dependentC.row.id)).cells.find(
            (cell) => cell.fieldId === blockerField.id,
          )?.value.relation ?? [],
      )
      .toEqual([]);
    await expect(page.getByTestId(`task-row-${dependentC.row.id}`)).toHaveCount(
      0,
    );
    await expect(
      page
        .getByTestId(`task-row-${dependentB.row.id}`)
        .getByText("1 active", { exact: true }),
    ).toBeVisible();
    expect(
      stableDependentCells(await f.read(second, dependentC.row.id)),
    ).toEqual(baselineC);
    // Resume the original decomposition/closed/trash journey with its own context.
    await page.goto(invoking.toString());
    await expect(currentTitle).toContainText(`${title} · confirmed`);

    // Unassigned children use the normal All/Closed inventory, rather than a
    // hidden subtask-only store or inherited parent assignment.
    await page.getByLabel("Search tasks", { exact: true }).fill("");
    await page
      .getByRole("combobox", { name: "Task lifecycle", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Closed work", exact: true })
      .click();
    await expect(page.getByTestId(`task-row-${childId}`)).toBeVisible();
    await page.getByTestId("tasks-scope-mine").click();
    await expect(
      page.getByText("No tasks match these filters", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId(`task-row-${childId}`)).toHaveCount(0);
    await page.goto(originalTaskURL);
    await expect(detail).toBeVisible();
    await page.getByTestId(`task-row-${rowId}`).getByRole("checkbox").click();
    await expect(page.getByTestId(`task-row-${rowId}`)).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Task lifecycle", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Closed work", exact: true })
      .click();
    await expect(page.getByTestId(`task-row-${rowId}`)).toBeVisible();
    await detail
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Remove row", exact: true })
      .click();
    await expect(
      detail.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await f.read(second, rowId)).row.deletedAt)
      .not.toBeNull();
    await detail.getByRole("button", { name: "Restore", exact: true }).click();
    await detail
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Remove row", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await f.read(second, rowId)).row.id).toBe(rowId);
    expect((await f.read(second, rowId)).row.deletedAt).toBeNull();
    await detail
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Open project", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/databases/${second.database.id}`),
    );
    await expect(
      page.getByText(`${title} · confirmed`, { exact: true }).first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    try {
      await page.goto("about:blank");
    } finally {
      await f.cleanup();
    }
  }
});

for (const colorMode of ["light"] as const) {
  test(`retains a stale native draft and enforces an actual Reader after account transition · ${colorMode}`, async ({
    page,
    context,
    request,
  }) => {
    const errors = observeErrors(page);
    const f = await fixture(request);
    let addedCollaborator = false;
    let collaboratorId = "";
    let restoreThemes: (() => Promise<void>) | undefined;
    try {
      // Membership events belong to an owned actor and disappear with its account.
      const suffix = `${Date.now()}-${colorMode}`;
      const password = `TaskFlow-${suffix}!`;
      const account = await f.gql<{
        admin: { createUser: { id: string; email: string } };
      }>(
        `mutation($input:CreateUserInput!){admin{createUser(input:$input){id email}}}`,
        {
          input: {
            name: "Task flow Reader",
            email: `task-flow-${suffix}@myoxus.local`,
            password,
          },
        },
      );
      collaboratorId = account.admin.createUser.id;
      const collaboratorCookies = await signInViaApi(
        request,
        API,
        account.admin.createUser.email,
        password,
      );
      const adminPreferences = {
        request,
        gqlEndpoint: GQL,
        cookies: f.cookies,
      };
      const collaboratorPreferences = {
        request,
        gqlEndpoint: GQL,
        cookies: collaboratorCookies,
      };
      const originalThemes = await Promise.all([
        getAccountColorMode(adminPreferences),
        getAccountColorMode(collaboratorPreferences),
      ]);
      restoreThemes = async () => {
        const restored = await Promise.allSettled([
          setAccountColorMode(adminPreferences, originalThemes[0]!),
          setAccountColorMode(collaboratorPreferences, originalThemes[1]!),
        ]);
        const failures = restored
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError(failures, "Task flow theme restore failed");
      };
      await setAccountColorMode(adminPreferences, colorMode);
      await setAccountColorMode(collaboratorPreferences, colorMode);
      await page.emulateMedia({ colorScheme: "dark" });
      const collaboratorGql = <T>(
        query: string,
        variables: Record<string, unknown> = {},
      ) => smokeGql<T>(request, GQL, collaboratorCookies, query, variables);
      const members = await f.gql<{
        workspace: { members: Array<{ id: string }> };
      }>("query($w:String!){workspace(id:$w){members{id}}}", {
        w: f.workspaceId,
      });
      expect(
        members.workspace.members.some(
          (member) => member.id === collaboratorId,
        ),
        "owned temporary membership must not overwrite an existing grant",
      ).toBe(false);
      await f.gql(
        `mutation($w:ID!,$u:ID!){admin{addWorkspaceMember(workspaceId:$w,userId:$u,role:"Collaborator"){id}}}`,
        { w: f.workspaceId, u: collaboratorId },
      );
      addedCollaborator = true;
      const project = f.projects[0]!;
      const row = await createRow(
        f,
        project,
        "Shared Task before concurrent edit",
      );
      await injectSessionCookies(context, f.cookies);
      const assignedToAlice = await createRow(
        f,
        project,
        "Collaborator-only assignment",
        undefined,
        collaboratorId,
      );
      const detail = await openRow(page, f.workspaceId, project, row.row.id);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(colorMode === "light" ? "light" : "dark");
      await expect(
        page.getByTestId(`task-row-${assignedToAlice.row.id}`),
      ).toHaveCount(0);
      await page.getByTestId("tasks-scope-all").click();
      await expect(
        page.getByTestId(`task-row-${assignedToAlice.row.id}`),
      ).toBeVisible();
      await page.getByTestId("tasks-scope-mine").click();
      await expect(
        page.getByTestId(`task-row-${assignedToAlice.row.id}`),
      ).toHaveCount(0);
      await detail.getByText(row.row.title, { exact: true }).click();
      const input = detail.getByRole("textbox", { name: "Task", exact: true });
      await input.fill("My unsaved local title");
      const before = await f.read(project, row.row.id);
      const titleFieldId = role(project, "task.title");
      // Title writes use the canonical Row revision, not an optional Cell revision.
      const titleRevision = before.row.editRevision;
      await collaboratorGql(
        `mutation($input:UpdateDatabaseRowTitleInput!){updateDatabaseRowTitle(input:$input){editRevision}}`,
        {
          input: {
            databaseId: project.database.id,
            rowId: row.row.id,
            titleFieldId: titleFieldId,
            expectedEditRevision: titleRevision,
            title: "Confirmed collaborator title",
          },
        },
      );
      await expect(page.getByTestId(`task-row-${row.row.id}`)).toContainText(
        "Confirmed collaborator title",
      );
      await expect(input).toHaveValue("My unsaved local title");
      await input.press("Enter");
      const conflict = page.getByTestId("database-conflict-modal");
      await expect(conflict).toBeVisible();
      await expect(conflict).toContainText("My unsaved local title");
      await expect
        .poll(() =>
          conflict.evaluate((node) => {
            let opacity = 1;
            for (
              let parent: Element | null = node;
              parent;
              parent = parent.parentElement
            )
              opacity *= Number(getComputedStyle(parent).opacity);
            return opacity;
          }),
        )
        .toBe(1);
      const conflictCapture = test
        .info()
        .outputPath(`stale-conflict-${colorMode}.png`);
      await page.screenshot({ path: conflictCapture, fullPage: true });
      await test.info().attach("stale-conflict", {
        path: conflictCapture,
        contentType: "image/png",
      });

      await conflict
        .getByRole("button", { name: "Use latest version", exact: true })
        .click();
      await expect(
        detail.getByText("Confirmed collaborator title", { exact: true }),
      ).toBeVisible();
      await f.gql(
        `mutation($w:ID!,$u:ID!){admin{adminUpdateWorkspaceMemberRole(workspaceId:$w,userId:$u,role:Reader)}}`,
        { w: f.workspaceId, u: collaboratorId },
      );
      await context.clearCookies();
      await injectSessionCookies(context, collaboratorCookies);
      const readonly = await openRow(page, f.workspaceId, project, row.row.id);
      await expect(
        readonly.getByText("Confirmed collaborator title", { exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("tasks-new-task")).toHaveCount(0);
      await expect(
        readonly.getByRole("button", { name: "Remove row", exact: true }),
      ).toHaveCount(0);
      await readonly
        .getByText("Confirmed collaborator title", { exact: true })
        .click();
      await expect(
        readonly.getByRole("textbox", { name: "Task", exact: true }),
      ).toHaveCount(0);
      await expect(readonly.getByTestId("database-task-relations")).toHaveCount(
        0,
      );
      await expect(
        readonly.getByRole("textbox", {
          name: "Title",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        readonly.getByRole("button", {
          name: "Add subtask",
          exact: true,
        }),
      ).toHaveCount(0);
      const beforeRejected = await f.read(project, row.row.id);
      const rejected = await request.post(GQL, {
        headers: {
          Cookie: collaboratorCookies
            .map((cookie) => cookie.split(";")[0])
            .join("; "),
        },
        data: {
          query: `mutation($input:UpdateDatabaseRowTitleInput!){updateDatabaseRowTitle(input:$input){editRevision}}`,
          variables: {
            input: {
              databaseId: project.database.id,
              rowId: row.row.id,
              titleFieldId: titleFieldId,
              expectedEditRevision: beforeRejected.row.editRevision,
              title: "Forbidden overwrite",
            },
          },
        },
      });
      const rejection = await rejected.json();
      expect(JSON.stringify(rejection.errors)).toContain(
        "MIX_DATABASE_FORBIDDEN",
      );
      const after = await f.read(project, row.row.id);
      expect(after).toEqual(beforeRejected);
      expect(after.row.title).toBe("Confirmed collaborator title");
      expect(after.row.editRevision).toBe(titleRevision + 1);
      await readonly.scrollIntoViewIfNeeded();
      const readerCapture = test
        .info()
        .outputPath(`reader-detail-${colorMode}.png`);
      await page.screenshot({ path: readerCapture, fullPage: true });
      await test.info().attach("reader-detail", {
        path: readerCapture,
        contentType: "image/png",
      });
      await test.info().attach("reader-and-conflict-report", {
        body: JSON.stringify({
          workspaceId: f.workspaceId,
          databaseId: project.database.id,
          rowId: row.row.id,
          readerId: collaboratorId,
          url: page.url(),
          errors,
          viewport: page.viewportSize(),
          requestedColorMode: colorMode,
          theme: await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            mantine: document.documentElement.dataset.mantineColorScheme,
            system: matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light",
          })),
        }),
        contentType: "application/json",
      });
      await f.gql(
        `mutation($w:ID!,$u:ID!){admin{adminRemoveWorkspaceMember(workspaceId:$w,userId:$u)}}`,
        { w: f.workspaceId, u: collaboratorId },
      );
      addedCollaborator = false;
      // A visible return revalidates canonical ACL even if its access hint was missed.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        readonly.getByText("Confirmed collaborator title", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("alert")
          .getByText("Live updates unavailable", { exact: true }),
      ).toBeVisible();
      const deniedCapture = test
        .info()
        .outputPath(`permission-loss-${colorMode}.png`);
      await page.screenshot({ path: deniedCapture, fullPage: true });
      await test.info().attach("permission-loss", {
        path: deniedCapture,
        contentType: "image/png",
      });
      expect(errors).toEqual([]);
    } finally {
      const cleanupErrors: unknown[] = [];
      const clean = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      await clean(() => page.goto("about:blank"));
      if (addedCollaborator)
        await clean(() =>
          f.gql(
            `mutation($w:ID!,$u:ID!){admin{adminRemoveWorkspaceMember(workspaceId:$w,userId:$u)}}`,
            { w: f.workspaceId, u: collaboratorId },
          ),
        );
      await clean(async () => {
        await restoreThemes?.();
      });
      await clean(() => f.cleanup());
      if (collaboratorId)
        await clean(async () => {
          const result = await f.gql<{
            admin: { deleteUser: { success: boolean } };
          }>(`mutation($id:String!){admin{deleteUser(id:$id){success}}}`, {
            id: collaboratorId,
          });
          expect(result.admin.deleteUser.success).toBe(true);
        });
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, "Task flow cleanup failed");
    }
  });
}

// Legacy createWorkspace schedules its initial root publication asynchronously. A root
// CAS preflight must start after that exact owned workspace's delivery finishes.
async function captureWorkspaceReady(
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  workspaceId: string,
) {
  await expect
    .poll(
      async () => {
        const jobs = (
          await gql<{
            admin: {
              templateJobs: Array<{
                id: string;
                jobType: string;
                state: string;
                workspaceId: string | null;
              }>;
            };
          }>(
            "query{admin{templateJobs(skip:0,take:100){id jobType state workspaceId}}}",
          )
        ).admin.templateJobs.filter(
          (job) =>
            job.workspaceId === workspaceId && job.jobType === "Reconcile",
        );
        for (const job of jobs)
          if (["Failed", "Cancelled"].includes(job.state))
            throw new Error(
              `Owned workspace delivery failed: ${job.id} ${job.state}`,
            );
        return (
          jobs.length > 0 && jobs.every((job) => job.state === "Completed")
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

// Capture receipts intentionally survive Project purge. Every Phase2 journey
// owns an entire cloud workspace, whose lifecycle also removes those receipts.
// Exercise the admitted file package without encoding its offering ID or input
// IDs. This is the same Empty allocation used by the interactive client.
async function createEmptyWorkspace(
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  onAllocated: (workspaceId: string) => void,
) {
  type Value = { kind: string; text: string | null; choice: string | null };
  const catalog = await gql<{
    currentUser: {
      assistantPackages: Array<{
        identity: { id: string; version: string; digest: string };
        defaultFor: string[];
        inputs: Array<{
          id: string;
          target: string;
          defaultValue: Value | null;
          choices: Array<{ id: string; value: Value }>;
        }>;
      }>;
    };
  }>(
    `query{currentUser{assistantPackages(context:WorkspaceCreation){identity{id version digest}defaultFor inputs{id target defaultValue{kind text choice}choices{id value{kind text choice}}}}}}`,
  );
  const source = catalog.currentUser.assistantPackages.find((source) =>
    source.defaultFor.includes("WorkspaceCreation"),
  );
  if (!source)
    throw new Error("No admitted default Workspace creation package");
  const answers: Record<string, { kind: string; value: string }> = {};
  for (const input of source.inputs) {
    if (input.target === "WorkspaceName") {
      answers[input.id] = {
        kind: "text",
        value: `Empty first-use ${randomUUID()}`,
      };
    } else if (
      input.target === "InitialContent" ||
      input.target === "AssistanceMode"
    ) {
      const expected = input.target === "InitialContent" ? "empty" : "manual";
      const choice = input.choices.find(
        (choice) => (choice.value.text ?? choice.value.choice) === expected,
      );
      if (!choice) throw new Error(`Package lacks native ${expected} choice`);
      answers[input.id] = { kind: "choice", value: choice.id };
    } else if (input.defaultValue?.kind === "Text") {
      answers[input.id] = { kind: "text", value: input.defaultValue.text! };
    } else if (input.defaultValue?.kind === "Choice") {
      answers[input.id] = { kind: "choice", value: input.defaultValue.choice! };
    }
  }
  const prepared = (
    await gql<{
      currentUser: {
        prepareWorkspaceAssistant: {
          name: string;
          initialContent: string;
          assistanceMode: string;
          planDigest: string;
        };
      };
    }>(
      `query($input:PrepareWorkspaceAssistantInput!){currentUser{prepareWorkspaceAssistant(input:$input){name initialContent assistanceMode planDigest}}}`,
      { input: { identity: source.identity, answers } },
    )
  ).currentUser.prepareWorkspaceAssistant;
  const creationInput = {
    name: prepared.name,
    initialContent: prepared.initialContent,
    assistanceMode: prepared.assistanceMode,
    requestId: randomUUID(),
    assistantConfirmation: {
      identity: source.identity,
      answers,
      planDigest: prepared.planDigest,
    },
  };
  const operation = `mutation($input:CreateWorkspaceInput!){createWorkspace(input:$input){id initialContentPolicy creation{status rootReady tasksReady assistanceSaved}}}`;
  type Result = {
    createWorkspace: {
      id: string;
      initialContentPolicy: string;
      creation: {
        status: string;
        rootReady: boolean;
        tasksReady: boolean;
        assistanceSaved: boolean;
      };
    };
  };
  const created = (await gql<Result>(operation, { input: creationInput }))
    .createWorkspace;
  onAllocated(created.id);
  expect(created.initialContentPolicy).toBe("Empty");
  expect(created.creation).toMatchObject({
    status: "Ready",
    rootReady: true,
    tasksReady: true,
    assistanceSaved: true,
  });
  expect(
    (await gql<Result>(operation, { input: creationInput })).createWorkspace.id,
  ).toBe(created.id);
  return created.id;
}

async function captureFixture(request: APIRequestContext, useDefault = false) {
  let cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const adminCookies = cookies;
  const adminGql = <T>(
    query: string,
    variables: Record<string, unknown> = {},
  ) => smokeGql<T>(request, GQL, adminCookies, query, variables);
  const gql = <T>(query: string, variables: Record<string, unknown> = {}) =>
    smokeGql<T>(request, GQL, cookies, query, variables);
  let workspaceId = "";
  let originalLocale: string | null | undefined;
  let localeChanged = false;
  const actors: string[] = [];
  const ownedWorkspaces: string[] = [];
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const id of ownedWorkspaces) {
      try {
        const deleted = await adminGql<{ admin: { deleteWorkspace: boolean } }>(
          "mutation($id:ID!){admin{deleteWorkspace(id:$id)}}",
          { id },
        );
        expect(deleted.admin.deleteWorkspace).toBe(true);
      } catch (error) {
        failures.push(error);
      }
    }
    if (localeChanged) {
      try {
        await gql(
          "mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}",
          { input: { locale: originalLocale } },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    for (const id of actors) {
      try {
        const deleted = await adminGql<{
          admin: { deleteUser: { success: boolean } };
        }>("mutation($id:String!){admin{deleteUser(id:$id){success}}}", { id });
        expect(deleted.admin.deleteUser.success).toBe(true);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Isolated capture workspace cleanup failed",
      );
  };
  try {
    if (useDefault) {
      // Account deletion owns terminal receipt cleanup; do not leave a retained
      // test key or personal overrides on the seeded operational account.
      const password = randomUUID();
      const actor = (
        await adminGql<{
          admin: { createUser: { id: string; email: string } };
        }>(
          "mutation($input:CreateUserInput!){admin{createUser(input:$input){id email}}}",
          {
            input: {
              name: "Empty first-use owner",
              email: `empty-${randomUUID()}@myoxus.local`,
              password,
            },
          },
        )
      ).admin.createUser;
      actors.push(actor.id);
      cookies = await signInViaApi(request, API, actor.email, password);
    }
    workspaceId = useDefault
      ? await createEmptyWorkspace(gql, (id) => ownedWorkspaces.push(id))
      : (
          await gql<{ createWorkspace: { id: string } }>(
            "mutation{createWorkspace{id}}",
          )
        ).createWorkspace.id;
    if (!useDefault) ownedWorkspaces.push(workspaceId);
    // Empty's receipt already confirms root/Tasks readiness and deliberately
    // schedules no content-provisioning job. Only legacy fixtures await one.
    if (!useDefault) await captureWorkspaceReady(gql, workspaceId);
    originalLocale = (
      await gql<{
        currentUser: { preferences: { values: { locale: string | null } } };
      }>("query{currentUser{preferences{values{locale}}}} ")
    ).currentUser.preferences.values.locale;
    await gql(
      "mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}",
      { input: { locale: "en" } },
    );
    localeChanged = true;
    await adminGql(
      "mutation($input:AdminUpdateWorkspaceInput!){admin{adminUpdateWorkspace(input:$input){id}}}",
      {
        input: { id: workspaceId, name: `Owned capture journey ${Date.now()}` },
      },
    );
    const project = useDefault
      ? (
          await gql<{ workspace: { database: Project } }>(
            `query($w:String!,$d:ID!){workspace(id:$w){database(databaseId:$d){database{id} fields{id name editRevision} fieldRoles{roleKey fieldId}}}}`,
            {
              w: workspaceId,
              d: (
                await gql<{
                  workspace: {
                    databaseTaskDestinations: {
                      defaultDestination: { databaseId: string };
                    };
                  };
                }>(
                  `query($w:String!){workspace(id:$w){databaseTaskDestinations{defaultDestination{databaseId}}}}`,
                  { w: workspaceId },
                )
              ).workspace.databaseTaskDestinations.defaultDestination
                .databaseId,
            },
          )
        ).workspace.database
      : (
          await gql<{ createProject: Project }>(
            `mutation($input:CreateProjectInput!){createProject(input:$input){database{id}fields{id name editRevision}fieldRoles{roleKey fieldId}}}`,
            {
              input: {
                workspaceId,
                title: "Capture journey Project",
                structurePreset: "TasksOnly",
                priorityPreset: "ThreeStep",
              },
            },
          )
        ).createProject;
    const rows = async () =>
      (
        await gql<{ workspace: { databaseTasks: Inventory } }>(
          `query($w:String!,$p:ID!){workspace(id:$w){databaseTasks(input:{scope:All,lifecycle:Open,timeZone:"UTC",projectIds:[$p]},first:100){totalCount rows{rowId databaseId title}}}}`,
          { w: workspaceId, p: project.database.id },
        )
      ).workspace.databaseTasks;
    return {
      cookies,
      gql,
      workspaceId,
      project,
      actors,
      ownedWorkspaces,
      rows,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
type CaptureFixture = Awaited<ReturnType<typeof captureFixture>>;

// The existing Organizer stores its technical root in the document transport.
// Empty permits that exact infrastructure key, while every user Page must be absent.
function expectEmptyUserDocuments(
  inventory: { totalCount: number; edges: { node: { id: string } }[] },
  workspaceId: string,
) {
  expect(inventory.totalCount).toBe(inventory.edges.length);
  expect(inventory.edges.length).toBeLessThanOrEqual(1);
  expect(
    inventory.edges.every(
      ({ node }) => node.id === `db$${workspaceId}$folders`,
    ),
  ).toBe(true);
}

test("Empty creation cancels without writes and resumes its persisted request after a lost response", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request, true);
  const errors = observeErrors(page);
  let lostInput: { requestId: string } | undefined;
  let createCalls = 0;
  let resultId = "";
  const openCreate = async (recovery = false) => {
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("new-workspace").click();
    await expect(
      page.getByTestId(
        recovery ? "create-workspace-check-button" : "create-workspace-input",
      ),
    ).toBeVisible();
  };
  const state = () =>
    f.gql<{
      workspaces: { id: string }[];
      currentUser: {
        preferences: { values: { assistanceMode: string | null } };
      };
    }>("query{workspaces{id}currentUser{preferences{values{assistanceMode}}}}");
  try {
    await injectSessionCookies(context, f.cookies);
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/home`);
    await waitForWorkspaceReady(page);
    const before = await state();
    await openCreate();
    const dialog = page.getByRole("dialog");
    await page.getByTestId("create-workspace-input").fill("Cancelled Empty");
    await expect(
      dialog.getByRole("radio", { name: "Guided", exact: true }),
    ).toBeChecked();
    await dialog.getByRole("radio", { name: "Manual", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await state()).toEqual(before);
    await expect(page.getByTestId("sidebar-workspaces-section")).toBeFocused();

    await openCreate();
    const name = `Recovered Empty ${randomUUID()}`;
    await page.getByTestId("create-workspace-input").fill(name);
    await dialog.getByRole("radio", { name: "Automatic", exact: true }).click();
    // The real server commits; only its response is lost. Recovery must use the
    // stored exact request rather than allocate with a newly prepared identity.
    await page.route("**/graphql", async (route) => {
      if (route.request().headers()["x-operation-name"] === "createWorkspace")
        createCalls++;
      if (
        route.request().headers()["x-operation-name"] !== "createWorkspace" ||
        resultId
      ) {
        await route.continue();
        return;
      }
      lostInput = route.request().postDataJSON().variables.input;
      const response = await route.fetch();
      const payload = await response.json();
      expect(payload.errors).toBeUndefined();
      resultId = payload.data.createWorkspace.id;
      f.ownedWorkspaces.push(resultId);
      await route.abort("failed");
    });
    await page.getByTestId("create-workspace-create-button").click();
    await expect(
      page.getByTestId("create-workspace-check-button"),
    ).toBeEnabled();
    expect(resultId).not.toBe("");
    await page.reload();
    await waitForWorkspaceReady(page);
    await openCreate(true);
    await expect(dialog.getByRole("textbox").first()).toHaveValue(name);
    await expect(dialog.getByRole("textbox").first()).toBeDisabled();
    const readback = page.waitForRequest(
      (request) =>
        request.headers()["x-operation-name"] === "workspaceCreation",
    );
    await page.getByTestId("create-workspace-check-button").click();
    if (!lostInput)
      throw new Error("The real server never received a confirmed request");
    expect((await readback).postDataJSON().variables).toEqual({
      requestId: lostInput.requestId,
    });
    await expect(page).toHaveURL(new RegExp(`/workspace/${resultId}/home`));
    await waitForWorkspaceReady(page);
    expect(createCalls).toBe(1);
    const after = await state();
    expect(after.workspaces.map((workspace) => workspace.id).sort()).toEqual(
      [...before.workspaces.map((workspace) => workspace.id), resultId].sort(),
    );
    expect(after.currentUser.preferences).toEqual(
      before.currentUser.preferences,
    );
    const saved = await f.gql<{
      currentUser: {
        preferences: { assistance: { mode: string; source: string } };
      };
      workspace: {
        initialContentPolicy: string;
        docs: { totalCount: number; edges: { node: { id: string } }[] };
        databases: unknown[];
        automations: unknown[];
        databaseTasks: { totalCount: number };
      };
    }>(
      `query($w:String!,$id:ID!){currentUser{preferences{assistance(workspaceId:$id){mode source}}}workspace(id:$w){initialContentPolicy docs(pagination:{first:100}){totalCount edges{node{id}}}databases(first:100){id}automations(first:100){id}databaseTasks(input:{scope:All,lifecycle:Open,timeZone:"UTC"},first:1){totalCount}}}`,
      { w: resultId, id: resultId },
    );
    expect(saved.currentUser.preferences.assistance).toEqual({
      mode: "Automatic",
      source: "Workspace",
    });
    expectEmptyUserDocuments(saved.workspace.docs, resultId);
    expect(saved.workspace).toMatchObject({
      initialContentPolicy: "Empty",
      databases: [],
      automations: [],
      databaseTasks: { totalCount: 0 },
    });
    expect(
      errors.filter((error) => !error.includes("net::ERR_FAILED")),
    ).toEqual([]);
  } finally {
    await page.unroute("**/graphql");
    await page.goto("about:blank");
    await f.cleanup();
  }
});

test("Workspace Project purpose publishes its selected native brief once and recovers a lost response without allocation", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request, true);
  const errors = observeErrors(page);
  let resultId = "";
  let projectId = "";
  let briefId = "";
  let createCalls = 0;
  const workspaceName = `Purpose workspace ${randomUUID()}`;
  const projectName = `Separate Project ${randomUUID()}`;
  const goal = `First unopened brief ${randomUUID()}`;
  try {
    const owner = (
      await f.gql<{ currentUser: { name: string } }>("query{currentUser{name}}")
    ).currentUser;
    await injectSessionCookies(context, f.cookies);
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/home`);
    await waitForWorkspaceReady(page);
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("new-workspace").click();
    const dialog = page.getByRole("dialog");
    await page.getByTestId("create-workspace-input").fill(workspaceName);
    await dialog.getByRole("radio", { name: "Manual", exact: true }).click();
    await dialog
      .getByRole("radio", { name: "Simple Project", exact: true })
      .click();
    await dialog.getByTestId("database-assistant-next").click();
    await dialog.getByTestId("database-assistant-title").fill(projectName);
    await dialog.getByRole("textbox", { name: "Goal", exact: true }).fill(goal);
    await dialog
      .getByRole("textbox", { name: "Folder", exact: true })
      .fill("Explicit purpose documents");
    await dialog
      .getByRole("checkbox", { name: owner.name, exact: true })
      .check();
    await dialog.getByTestId("database-assistant-next").click();
    await dialog
      .getByRole("radio", { name: "Tasks only", exact: true })
      .click();
    await dialog
      .getByRole("switch", { name: "Create a project brief", exact: true })
      .check();
    await dialog.getByTestId("database-assistant-next").click();
    await expect(dialog.getByTestId("database-assistant-review")).toContainText(
      projectName,
    );
    await expect(
      dialog.getByTestId("database-assistant-phase-count"),
    ).toHaveText("0");
    await page.route("**/graphql", async (route) => {
      if (route.request().headers()["x-operation-name"] !== "createWorkspace") {
        await route.continue();
        return;
      }
      createCalls++;
      if (resultId) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const payload = await response.json();
      expect(payload.errors).toBeUndefined();
      const created = payload.data.createWorkspace;
      resultId = created.id;
      f.ownedWorkspaces.push(resultId);
      expect(created.creation.projectSetup.status).toBe("Ready");
      projectId = created.creation.projectSetup.reservedDatabaseId;
      expect(created.creation.projectSetup.documents).toHaveLength(1);
      const brief = created.creation.projectSetup.documents[0];
      expect(brief).toMatchObject({ created: true, placed: true });
      briefId = brief.externalId;
      await route.abort("failed");
    });
    await dialog.getByTestId("database-assistant-create").click();
    await expect(
      page.getByTestId("create-workspace-check-button"),
    ).toBeEnabled();
    expect(resultId).not.toBe("");
    await page.reload();
    await waitForWorkspaceReady(page);
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("new-workspace").click();
    await expect(
      page.getByTestId("create-workspace-open-button"),
    ).toBeEnabled();
    await page.getByTestId("create-workspace-check-button").click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${resultId}/home`));
    await waitForWorkspaceReady(page);
    expect(createCalls).toBe(1);
    const persisted = (
      await f.gql<{
        workspace: {
          name: string;
          databases: { id: string; title: string }[];
          databaseTasks: { totalCount: number };
          automations: unknown[];
        };
      }>(
        `query($w:String!){workspace(id:$w){name databases(first:100){id title}databaseTasks(input:{scope:All,lifecycle:Open,timeZone:"UTC"},first:1){totalCount}automations(first:100){id}}}`,
        { w: resultId },
      )
    ).workspace;
    expect(persisted).toEqual({
      name: workspaceName,
      databases: [{ id: projectId, title: projectName }],
      databaseTasks: { totalCount: 0 },
      automations: [],
    });
    await openIndexedProjectBrief(page, goal, briefId);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/workspace/${resultId}/${briefId}`);
    await expect(page.locator("editor-host")).toContainText(goal);
    await expect(page.locator("editor-host")).toContainText("Open questions");
    await page.reload();
    await expect(page.locator("editor-host")).toContainText(goal);
    await expect(page.locator("editor-host")).toContainText("Open questions");
    expect(
      errors.filter((error) => !error.includes("net::ERR_FAILED")),
    ).toEqual([]);
  } finally {
    await page.unroute("**/graphql");
    await page.goto("about:blank");
    await f.cleanup();
  }
});

test("Empty Workspace Tasks starts from Home, Tasks and a note, then explicitly moves the captured original", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request, true);
  const errors = observeErrors(page);
  try {
    await injectSessionCookies(context, f.cookies);
    const inventory = async () =>
      (
        await f.gql<{ workspace: { databases: { id: string }[] } }>(
          "query($w:String!){workspace(id:$w){databases(first:100){id}}}",
          { w: f.workspaceId },
        )
      ).workspace.databases;
    expect(await inventory()).toEqual([]);
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/home`);
    await waitForWorkspaceReady(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    const empty = await f.gql<{
      workspace: {
        databases: unknown[];
        automations: unknown[];
        databaseTasks: { totalCount: number };
        docs: { totalCount: number; edges: { node: { id: string } }[] };
      };
    }>(
      `query($w:String!){workspace(id:$w){databases(first:100){id}automations(first:100){id}databaseTasks(input:{scope:All,lifecycle:Open,timeZone:"UTC"},first:1){totalCount}docs(pagination:{first:100}){totalCount edges{node{id}}}}}`,
      { w: f.workspaceId },
    );
    expectEmptyUserDocuments(empty.workspace.docs, f.workspaceId);
    expect(empty.workspace).toMatchObject({
      databases: [],
      automations: [],
      databaseTasks: { totalCount: 0 },
    });
    const reconcile = await f.gql<{
      workspaceTemplateReconcileSlugs: unknown[];
    }>(
      `mutation($w:String!){workspaceTemplateReconcileSlugs(workspaceId:$w,locale:"en"){slug}}`,
      { w: f.workspaceId },
    );
    expect(reconcile.workspaceTemplateReconcileSlugs).toEqual([]);
    await page
      .locator('[data-myoxus-ui-role="workspace-home-tasks"]')
      .getByRole("button", { name: "New task", exact: true })
      .click();
    let modal = page.getByTestId("task-creation-modal");
    await modal
      .getByRole("button", { name: "Destination", exact: true })
      .click();
    await expect(modal.getByTestId("task-destination-select")).toHaveValue(
      "Workspace Tasks",
    );
    await modal
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Home without a Project");
    let committed = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseRow",
    );
    await modal.getByRole("button", { name: "Create", exact: true }).click();
    let payload = await (await committed).json();
    expect(payload.errors).toBeUndefined();
    const homeRow = payload.data.createDatabaseRow.row.id as string;
    await expect(
      page.getByTestId("context-surface-task-details"),
    ).toContainText("Home without a Project");
    const firstDetail = page.getByTestId("context-surface-task-details");
    await firstDetail
      .getByText("Home without a Project", { exact: true })
      .click();
    const titleName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.title"),
    )!.name;
    const firstTitle = firstDetail.getByRole("textbox", {
      name: titleName,
      exact: true,
    });
    await firstTitle.fill("Home without a Project · edited");
    await firstTitle.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await f.gql<{ workspace: { databaseRow: Row } }>(
              "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id title editRevision deletedAt}cells{fieldId editRevision value{users}}}}}",
              { w: f.workspaceId, d: f.project.database.id, r: homeRow },
            )
          ).workspace.databaseRow.row.title,
      )
      .toBe("Home without a Project · edited");
    await page.reload();
    await expect(
      page.getByTestId("context-surface-task-details"),
    ).toContainText("Home without a Project · edited");
    // Home uses the editable Mine default; All below keeps unassigned creation.
    const homeRead = await f.gql<{ workspace: { databaseRow: Row } }>(
      "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id title editRevision deletedAt} cells{fieldId editRevision value{users}}}}}",
      { w: f.workspaceId, d: f.project.database.id, r: homeRow },
    );
    expect(
      homeRead.workspace.databaseRow.cells.find(
        (cell) => cell.fieldId === role(f.project, "task.assignees"),
      )?.value.users ?? [],
    ).toEqual([f.actors[0]]);
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=All&lifecycle=Open`,
    );
    await expect(page.getByTestId(`task-row-${homeRow}`)).toBeVisible();
    await page.getByTestId("tasks-new-task").click();
    modal = page.getByTestId("task-creation-modal");
    await modal
      .getByRole("button", { name: "Destination", exact: true })
      .click();
    await expect(modal.getByTestId("task-destination-select")).toHaveValue(
      "Workspace Tasks",
    );
    await modal
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Tasks without a Project");
    committed = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseRow",
    );
    await modal.getByRole("button", { name: "Create", exact: true }).click();
    payload = await (await committed).json();
    expect(payload.errors).toBeUndefined();
    await expect(
      page.getByTestId("context-surface-task-details"),
    ).toContainText("Tasks without a Project");

    const docId = await captureDocument(page, f, "No Project capture source");
    const editable = page
      .locator('myoxus-paragraph rich-text [contenteditable="true"]')
      .last();
    await editable.fill("Review this original captured work");
    const paragraph = (await captureTree(page)).find(
      (block) => block.text === "Review this original captured work",
    )!;
    await waitForWorkspaceDocSync(page, docId);
    const capture = await selectCaptureText(page, paragraph.id);
    await expect(capture.getByTestId("task-destination-select")).toHaveValue(
      "Workspace Tasks",
    );
    await capture
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Captured original to move");
    const receipt = await commitCapture(page, capture);
    await closeCapture(capture);
    expect((await referenceFor(page, receipt.rowId)).databaseId).toBe(
      f.project.database.id,
    );
    expect(await inventory()).toEqual([]);

    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/databases`);
    await page.getByTestId("database-menu-trigger").click();
    await page.getByTestId("database-create-project").click();
    const assistant = page.getByTestId("database-creation-assistant");
    await assistant.getByTestId("database-assistant-next").click();
    await assistant
      .getByTestId("database-assistant-title")
      .fill("Optional destination");
    await assistant
      .getByTestId("database-assistant-description")
      .fill("An explicitly selected destination for the captured original");
    const briefGoal = `Capture review ${randomUUID()}`;
    await assistant
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill(briefGoal);
    await assistant
      .getByRole("combobox", { name: "Folder destination type", exact: true })
      .click();
    await page.getByRole("option", { name: "New folder", exact: true }).click();
    await assistant
      .getByRole("textbox", { name: "New folder name", exact: true })
      .fill("Capture review documents");
    await assistant.getByTestId("database-assistant-next").click();
    await assistant
      .getByRole("radio", { name: "Tasks only", exact: true })
      .click();
    await assistant
      .getByRole("switch", { name: "Create a project brief", exact: true })
      .check();
    await assistant.getByTestId("database-assistant-next").click();
    await expect(
      assistant.getByTestId("database-assistant-review"),
    ).toContainText("Optional destination");
    const projectCreated = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseFromTemplate",
    );
    await assistant.getByTestId("database-assistant-create").click();
    const projectResponse = await projectCreated;
    const targetPayload = await projectResponse.json();
    expect(targetPayload.errors).toBeUndefined();
    const target = targetPayload.data.createDatabaseFromTemplate.database
      .id as string;
    const setupRequest = projectResponse.request().postDataJSON().variables
      .input.assistantConfirmation.requestId as string;
    const setup = (
      await f.gql<{
        workspace: {
          projectSetup: {
            status: string;
            documents: {
              externalId: string | null;
              created: boolean;
              placed: boolean;
            }[];
          };
        };
      }>(
        `query($w:String!,$request:ID!){workspace(id:$w){projectSetup(requestId:$request){status documents{externalId created placed}}}}`,
        { w: f.workspaceId, request: setupRequest },
      )
    ).workspace.projectSetup;
    expect(setup.status).toBe("Ready");
    expect(setup.documents).toHaveLength(1);
    const brief = setup.documents[0];
    expect(brief).toMatchObject({ created: true, placed: true });
    // No document is opened or edited before reload and ordinary search. The
    // server must have published the complete native copy, not an empty shell.
    await expect(page).toHaveURL(new RegExp(`/databases/${target}`));
    await page.reload();
    await waitForWorkspaceReady(page);
    await openIndexedProjectBrief(page, briefGoal, brief.externalId);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/workspace/${f.workspaceId}/${brief.externalId}`);
    await expect(page.locator("editor-host")).toBeVisible();
    await expect(page.locator("editor-host")).toContainText(briefGoal);
    await expect(page.locator("editor-host")).toContainText("Open questions");
    await page.reload();
    await expect(page.locator("editor-host")).toContainText(briefGoal);
    await expect(page.locator("editor-host")).toContainText("Open questions");
    const oldURL = `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=All&databaseId=${f.project.database.id}&rowId=${receipt.rowId}`;
    await page.goto(oldURL);
    const detail = page.getByTestId("context-surface-task-details");
    await expect(detail).toContainText("Captured original to move");
    await detail.getByTestId("database-row-action-menu").click();
    await page.getByTestId("task-move-to-project").click();
    const move = page.getByTestId("task-move-modal");
    await move.getByTestId("task-move-destination").click();
    await page
      .getByRole("option", { name: "Optional destination", exact: true })
      .click();
    await move.getByTestId("task-move-preview").click();
    await expect(move.getByTestId("task-move-confirm")).toBeEnabled();
    const moved = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "moveDatabaseTasks",
    );
    await move.getByTestId("task-move-confirm").click();
    const result = await (await moved).json();
    expect(result.errors).toBeUndefined();
    expect(result.data.moveDatabaseTasks.rows[0].row.id).toBe(receipt.rowId);
    expect(result.data.moveDatabaseTasks.rows[0].row.databaseId).toBe(target);
    await expect(move).not.toBeVisible();
    await page.goto(oldURL);
    await expect(
      page.getByTestId("context-surface-task-details"),
    ).toContainText("Captured original to move");
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/${docId}`);
    await expect(page.locator("editor-host")).toBeVisible();
    const retained = await referenceFor(page, receipt.rowId);
    expect(retained.rowId).toBe(receipt.rowId);
    await referenceCardReady(
      page,
      retained.parent!,
      "Captured original to move",
    );
    expect((await inventory()).map((database) => database.id)).toEqual([
      target,
    ]);
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

type CaptureReceipt = {
  requestId: string;
  rowId: string;
  databaseId: string;
  source: { documentId: string };
};

// Use the admitted operation's revision; never replace UUIDs or mutate Yjs locally.
async function moveCaptureResource(
  f: CaptureFixture,
  from: string,
  to: string,
  resource: { kind: "Document" | "Database"; id: string },
) {
  const preview = (
    await f.gql<{
      workspaceContentPreflight: {
        operation: { id: string };
        revision: string;
        blockers: unknown[];
        requiredConfirmations: unknown[];
      };
    }>(
      "mutation($input:WorkspaceContentPreflightInput!){workspaceContentPreflight(input:$input){operation{id}revision blockers requiredConfirmations{kind}}}",
      {
        input: {
          idempotencyId: randomUUID(),
          kind: "Move",
          sourceWorkspaceId: from,
          targetWorkspaceId: to,
          resources: [resource],
          copyDocumentAcl: false,
        },
      },
    )
  ).workspaceContentPreflight;
  expect(preview.blockers).toEqual([]);
  expect(preview.requiredConfirmations).toEqual([]);
  await f.gql(
    "mutation($input:WorkspaceContentExecuteInput!){executeWorkspaceContentOperation(input:$input){id status}}",
    {
      input: {
        operationId: preview.operation.id,
        revision: preview.revision,
        confirmations: [],
      },
    },
  );
  await expect
    .poll(
      async () => {
        const operation = (
          await f.gql<{
            workspaceContentOperation: {
              status: string;
              errorCode: string | null;
            };
          }>(
            "query($id:UUID!){workspaceContentOperation(operationId:$id){status errorCode}}",
            { id: preview.operation.id },
          )
        ).workspaceContentOperation;
        if (
          ["Failed", "CleanupRequired", "Cancelled"].includes(operation.status)
        )
          throw new Error(
            `Resource move failed: ${operation.status} ${operation.errorCode}`,
          );
        return operation.status;
      },
      { timeout: 20_000 },
    )
    .toBe("Succeeded");
}

async function captureDocument(page: Page, f: CaptureFixture, title: string) {
  await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/all`);
  await waitForWorkspaceReady(page, { allDocs: true });
  await page.getByTestId("sidebar-new-page-button").click();
  await expect(page.locator("editor-host")).toBeVisible();
  await page.locator("doc-title .inline-editor").fill(title);
  await page.keyboard.press("Enter");
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

// Passive model reads verify identity/placement; all edits below use native UI.
async function captureTree(page: Page) {
  return page.evaluate(() => {
    type Model = {
      id: string;
      flavour: string;
      props: Record<string, unknown>;
      text?: { toString(): string };
      children: Model[];
    };
    const host = document.querySelector("editor-host") as HTMLElement & {
      std: { store: { root: Model } };
    };
    const visit = (
      model: Model,
      parent: string | null,
    ): {
      id: string;
      parent: string | null;
      flavour: string;
      text: string;
      xywh: unknown;
      checked: unknown;
      displayMode: unknown;
      workspaceId: unknown;
      databaseId: unknown;
      rowId: unknown;
    }[] => [
      {
        id: model.id,
        parent,
        flavour: model.flavour,
        text: model.text?.toString() ?? "",
        xywh: model.props.xywh,
        checked: model.props.checked,
        displayMode: model.props.displayMode,
        workspaceId: model.props.serverWorkspaceId,
        databaseId: model.props.serverDatabaseId,
        rowId: model.props.serverRowId,
      },
      ...model.children.flatMap((child) => visit(child, model.id)),
    ];
    return visit(host.std.store.root, null);
  });
}
async function selectCaptureText(page: Page, blockId: string) {
  const editable = page
    .locator(`[data-block-id="${blockId}"] rich-text .inline-editor:visible`)
    .first();
  await editable.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString() ?? ""))
    .toMatch(/\S/);
  await page
    .locator('editor-icon-button[aria-label="More"]:visible')
    .last()
    .click();
  await page.getByTestId("capture-as-task").click();
  const modal = page.getByTestId("task-capture-modal");
  await expect(modal).toBeVisible();
  return modal;
}
async function prepareCapture(page: Page, blockId: string, title: string) {
  const modal = await selectCaptureText(page, blockId);
  await modal.getByTestId("task-destination-select").click();
  await page
    .getByRole("option", { name: "Capture journey Project", exact: true })
    .click();
  await modal.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await expect(
    modal.getByRole("textbox", { name: "Description (optional)", exact: true }),
  ).toBeVisible();
  await expect(modal).toContainText(
    "People with access to the selected destination",
  );
  return modal;
}
async function commitCapture(
  page: Page,
  modal: ReturnType<Page["getByTestId"]>,
) {
  const response = page.waitForResponse(
    (response) =>
      response.request().headers()["x-operation-name"] ===
      "createDatabaseTaskFromSource",
  );
  await modal.getByRole("button", { name: "Create", exact: true }).click();
  const body = await (await response).json();
  expect(body.errors).toBeUndefined();
  await expect(modal.getByTestId("task-capture-confirmed")).toBeVisible();
  return body.data.createDatabaseTaskFromSource as CaptureReceipt;
}
async function closeCapture(modal: ReturnType<Page["getByTestId"]>) {
  await modal
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(modal).toBeHidden();
}
async function referenceFor(page: Page, rowId: string) {
  await expect
    .poll(
      async () =>
        (await captureTree(page)).filter((block) => block.rowId === rowId)
          .length,
    )
    .toBe(1);
  return (await captureTree(page)).find((block) => block.rowId === rowId)!;
}

async function referenceCardReady(page: Page, noteId: string, title: string) {
  const note = page.locator(`[data-block-id="${noteId}"]`).first();
  await expect(
    note.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await note.evaluate(async (element) => {
    const lit = element as HTMLElement & { updateComplete: Promise<boolean> };
    await lit.updateComplete;
    // Native Note ResizeObserver coalesces its measurement into the next frame;
    // then Lit applies the resulting model geometry before we read the baseline.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await lit.updateComplete;
  });
}

// Both failures cross real HTTP boundaries. The mutation is committed before
// its response is lost; permission failure occurs before any editor append.
test("checkbox capture recovers one Task/reference through trash and integrates subtask blocking, Following and typed Inbox Open", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request);
  let committed: CaptureReceipt | undefined;
  let loseResponse = true;
  let denyInsertRead = false;
  let permissionFailures = 0;
  let sourceDocId = "";
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const intercept = async (route: import("@playwright/test").Route) => {
    const operation = route.request().headers()["x-operation-name"];
    if (loseResponse && operation === "createDatabaseTaskFromSource") {
      loseResponse = false;
      const response = await route.fetch();
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      committed = body.data.createDatabaseTaskFromSource;
      await route.abort("failed");
    } else if (
      denyInsertRead &&
      operation === "getDocRolePermissions" &&
      route.request().postDataJSON().variables.docId === sourceDocId
    ) {
      denyInsertRead = false;
      permissionFailures += 1;
      await route.abort("failed");
    } else await route.continue();
  };
  try {
    await injectSessionCookies(context, f.cookies);
    const docId = await captureDocument(page, f, "Owned meeting source");
    sourceDocId = docId;
    const body = page
      .locator('myoxus-paragraph rich-text [contenteditable="true"]')
      .last();
    await body.click();
    await page.keyboard.type("[ ] Confirm the release owner");
    // Markdown checkbox conversion is an ordinary editor typing operation.
    await expect(page.locator("myoxus-list")).toBeVisible();
    const source = (await captureTree(page)).find(
      (block) => block.flavour === "myoxus:list",
    )!;
    await waitForWorkspaceDocSync(page, docId);
    await page.route("**/graphql", intercept);
    const modal = await prepareCapture(page, source.id, "Meeting follow-up");
    await expect(
      modal.getByRole("textbox", {
        name: "Description (optional)",
        exact: true,
      }),
    ).toHaveValue("Confirm the release owner");
    await modal.getByRole("button", { name: "Create", exact: true }).click();
    await expect(modal.getByTestId("task-capture-uncertain")).toBeVisible();
    expect(committed?.requestId).toEqual(expect.any(String));
    expect((await f.rows()).rows.map((row) => row.rowId)).toEqual([
      committed!.rowId,
    ]);
    denyInsertRead = true;
    await modal
      .getByRole("button", { name: "Check tasks", exact: true })
      .click();
    await expect(modal.getByTestId("task-capture-confirmed")).toContainText(
      "Meeting follow-up",
    );
    const retry = modal.getByRole("button", {
      name: "Insert reference",
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(permissionFailures).toBe(1);
    expect(
      (await captureTree(page)).filter(
        (block) => block.rowId === committed!.rowId,
      ),
    ).toHaveLength(0);
    await retry.click();
    const ref = await referenceFor(page, committed!.rowId);
    expect(ref.parent).toBe(source.parent);
    expect(
      (await captureTree(page)).find((block) => block.id === source.id),
    ).toEqual(source);
    expect((await f.rows()).rows.map((row) => row.rowId)).toEqual([
      committed!.rowId,
    ]);
    await closeCapture(modal);
    await waitForWorkspaceDocSync(page, docId);
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=All&lifecycle=Open`,
    );
    await page
      .getByTestId(`task-row-${committed!.rowId}`)
      .getByRole("link", { name: "Meeting follow-up", exact: true })
      .click();
    const detail = page.getByTestId("context-surface-task-details");
    await expect(detail).toContainText("Meeting follow-up");
    await detail.getByRole("combobox", { name: "Status", exact: true }).click();
    const statusSaved = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page.getByRole("option", { name: "Completed", exact: true }).click();
    expect((await (await statusSaved).json()).errors).toBeUndefined();
    await expect(
      detail.getByRole("combobox", { name: "Status", exact: true }),
    ).toHaveValue("Completed");
    await detail
      .getByRole("button", { name: "Owned meeting source", exact: true })
      .click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return {
          pathname: url.pathname,
          blockIds: url.searchParams.get("blockIds"),
          mode: url.searchParams.get("mode"),
        };
      })
      .toEqual({
        pathname: `/workspace/${f.workspaceId}/${docId}`,
        blockIds: source.id,
        mode: "page",
      });
    await referenceFor(page, committed!.rowId);
    await page
      .getByRole("button", { name: "Meeting follow-up", exact: true })
      .click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return { pathname: url.pathname, rowId: url.searchParams.get("rowId") };
      })
      .toEqual({
        pathname: `/workspace/${f.workspaceId}/databases/${f.project.database.id}`,
        rowId: committed!.rowId,
      });
    await expect(
      page.getByRole("dialog", { name: /Task details/ }),
    ).toContainText("Meeting follow-up");
    // Lifecycle controls belong to the existing Tasks detail surface, while
    // opening a reference above still proves the canonical Project Row route.
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=All&lifecycle=Closed&databaseId=${f.project.database.id}&rowId=${committed!.rowId}`,
    );
    const rowDetail = page.getByTestId("context-surface-task-details");
    await expect(rowDetail).toBeVisible();
    await rowDetail
      .getByRole("button", { name: "Remove row", exact: true })
      .click();
    await rowDetail
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(rowDetail).toContainText("Meeting follow-up");
    await expect
      .poll(
        async () =>
          (
            await f.gql<{ workspace: { databaseRow: Row } }>(
              `query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r,includeTrashed:true){row{id title editRevision deletedAt}cells{fieldId editRevision value{status}}}}}`,
              {
                w: f.workspaceId,
                d: f.project.database.id,
                r: committed!.rowId,
              },
            )
          ).workspace.databaseRow.row,
      )
      .toMatchObject({ id: committed!.rowId, deletedAt: null });
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/all`);
    await page
      .getByRole("radio", { name: "List", exact: true })
      .locator("..")
      .click();
    const sourceItem = page.locator(
      `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
    );
    await sourceItem.hover();
    await sourceItem.getByTestId("doc-list-operation-button").click();
    await page.getByTestId("doc-list-operation-trash").click();
    await page.getByTestId("confirm-modal-confirm").click();
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/databases/${f.project.database.id}?rowId=${committed!.rowId}`,
    );
    await expect(
      page.getByRole("dialog", { name: /Task details/ }),
    ).toContainText("Meeting follow-up");
    await expect(
      page.getByRole("button", { name: "Owned meeting source", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/${docId}`);
    await page.getByTestId("page-restore-button").click();
    await referenceFor(page, committed!.rowId);
    expect(
      (await captureTree(page)).find((block) => block.id === ref.id)?.rowId,
    ).toBe(committed!.rowId);
    // Restore changes root metadata, not the already-acknowledged leaf. Read
    // that exact intent back from SQL before rematerializing its native blocks.
    await expect
      .poll(
        async () =>
          (
            await f.gql<{
              workspace: {
                databaseRow: {
                  row: {
                    source: {
                      documentId: string;
                      externalId: string;
                      state: string;
                    };
                  };
                };
              };
            }>(
              "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{source{documentId externalId state}}}}}",
              {
                w: f.workspaceId,
                d: f.project.database.id,
                r: committed!.rowId,
              },
            )
          ).workspace.databaseRow.row.source,
      )
      .toEqual({
        documentId: committed!.source.documentId,
        externalId: docId,
        state: "Available",
      });
    await page.reload();
    await expect(page.locator("editor-host")).toBeVisible();
    expect((await referenceFor(page, committed!.rowId)).id).toBe(ref.id);
    expect(
      (await captureTree(page)).find((block) => block.id === source.id),
    ).toEqual(source);
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/databases/${f.project.database.id}?rowId=${committed!.rowId}`,
    );
    await expect(
      page
        .getByRole("dialog", { name: /Task details/ })
        .getByRole("button", { name: "Owned meeting source", exact: true }),
    ).toBeVisible();
    // Continue the same persisted capture, not a second synthetic Task. Actor
    // views are serial and every receipt/recipient belongs to this owned WP.
    const taskId = committed!.rowId;
    const taskURL = `${FRONTEND}/workspace/${f.workspaceId}/tasks?scope=All&projectId=${f.project.database.id}&databaseId=${f.project.database.id}&rowId=${taskId}#inbox-capture-context`;
    const taskDetail = page.getByTestId("context-surface-task-details");
    const titleName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.title"),
    )!.name;
    const statusName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.status"),
    )!.name;
    const dueName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.dueDate"),
    )!.name;
    const readTask = async () =>
      (
        await f.gql<{ workspace: { databaseRow: Row } }>(
          "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id title editRevision deletedAt}cells{fieldId editRevision value{users status relation dateTime{start end allDay timeZone}}}}}}",
          { w: f.workspaceId, d: f.project.database.id, r: taskId },
        )
      ).workspace.databaseRow;
    const switchActor = async (cookies: typeof f.cookies, url: string) => {
      await page.goto("about:blank");
      await context.clearCookies();
      await injectSessionCookies(context, cookies);
      await page.goto(url);
    };
    await page.goto(taskURL);
    await expect(
      taskDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    const setStatus = async (name: string) => {
      await taskDetail
        .getByRole("combobox", { name: statusName, exact: true })
        .click();
      const saved = page.waitForResponse(
        (response) =>
          response.request().headers()["x-operation-name"] ===
          "updateDatabaseCellValue",
      );
      await page.getByRole("option", { name, exact: true }).click();
      expect((await (await saved).json()).errors).toBeUndefined();
      await expect(
        taskDetail.getByRole("combobox", { name: statusName, exact: true }),
      ).toHaveValue(name);
    };
    await setStatus("To do");
    const relations = taskDetail.getByTestId("database-task-relations");
    const childTitle = "Inbox journey prerequisite";
    const add = relations.getByRole("textbox", {
      name: "Title",
      exact: true,
    });
    await add.fill(childTitle);
    const createdChild = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "createDatabaseRow",
    );
    await add.press("Enter");
    const childResult = await (await createdChild).json();
    expect(childResult.errors).toBeUndefined();
    const childId = childResult.data.createDatabaseRow.row.id as string;
    const blockingSection = taskDetail.getByTestId("database-task-blocking");
    const blockerName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.blockedBy"),
    )!.name;
    const blocker = blockingSection.getByRole("combobox", {
      name: blockerName,
      exact: true,
    });
    await blocker.click();
    await blocker.fill(childTitle);
    const blockedSave = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page.getByRole("option", { name: childTitle, exact: true }).click();
    expect((await (await blockedSave).json()).errors).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect
      .poll(
        async () =>
          (await readTask()).cells.find(
            (cell) => cell.fieldId === role(f.project, "task.blockedBy"),
          )?.value.relation,
      )
      .toEqual([childId]);

    await expect(
      blockingSection.getByRole("button", { name: childTitle, exact: true }),
    ).toContainText("Active prerequisite");
    const suffix = randomUUID();
    const password = `OwnedInbox-${suffix}!`;
    const recipient = (
      await f.gql<{ admin: { createUser: { id: string; email: string } } }>(
        "mutation($input:CreateUserInput!){admin{createUser(input:$input){id email}}}",
        {
          input: {
            name: "Owned Inbox recipient",
            email: `task-inbox-${suffix}@myoxus.local`,
            password,
          },
        },
      )
    ).admin.createUser;
    f.actors.push(recipient.id);
    await f.gql(
      'mutation($w:ID!,$u:ID!){admin{addWorkspaceMember(workspaceId:$w,userId:$u,role:"Collaborator"){id}}}',
      { w: f.workspaceId, u: recipient.id },
    );
    const recipientCookies = await signInViaApi(
      request,
      API,
      recipient.email,
      password,
    );
    const recipientGql = <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ) => smokeGql<T>(request, GQL, recipientCookies, query, variables);
    await recipientGql(
      "mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}",
      { input: { locale: "en" } },
    );
    await switchActor(recipientCookies, taskURL);
    await expect(
      taskDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    await taskDetail.getByTestId("database-row-action-menu").click();
    await page
      .getByRole("menuitem", { name: "Follow task", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readTask()).cells.find(
            (cell) => cell.fieldId === role(f.project, "task.watchers"),
          )?.value.users,
      )
      .toEqual([recipient.id]);

    await switchActor(f.cookies, taskURL);
    await expect(
      taskDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    const assigneesName = f.project.fields.find(
      (field) => field.id === role(f.project, "task.assignees"),
    )!.name;
    const assignees = taskDetail
      .getByText(assigneesName, { exact: true })
      .locator("..");
    await assignees.getByRole("button").click();
    const assigned = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page
      .getByRole("menuitem", { name: /Owned Inbox recipient$/ })
      .click();
    expect((await (await assigned).json()).errors).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect
      .poll(
        async () =>
          (await readTask()).cells.find(
            (cell) => cell.fieldId === role(f.project, "task.assignees"),
          )?.value.users,
      )
      .toEqual([recipient.id]);
    await setStatus("In progress");
    await taskDetail
      .getByRole("button", { name: dueName, exact: true })
      .click();
    // Native Mantine's current-month day labels use D MMMM YYYY.
    const todayLabel = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    await page.getByRole("button", { name: todayLabel, exact: true }).click();
    const dueSaved = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    expect((await (await dueSaved).json()).errors).toBeUndefined();
    const baseline = await readTask();
    expect(
      baseline.cells.find(
        (cell) => cell.fieldId === role(f.project, "task.dueDate"),
      )?.value.dateTime?.start,
    ).toEqual(expect.any(String));

    type InboxEntry = {
      id: string;
      type: string;
      read: boolean;
      body: {
        rowId?: string;
        databaseId?: string;
        state?: string;
        targetKind?: string;
      };
    };
    const inbox = async () =>
      (
        await recipientGql<{
          currentUser: {
            notifications: { edges: Array<{ node: InboxEntry }> };
          };
        }>(
          "query{currentUser{notifications(pagination:{first:20},filter:{includeRead:true,types:[DatabaseRowAssigned,DatabaseTaskChanged]}){edges{node{id type read body}}}}}",
        )
      ).currentUser.notifications.edges.map((edge) => edge.node);
    await switchActor(
      recipientCookies,
      `${FRONTEND}/workspace/${f.workspaceId}/inbox`,
    );
    const cards = page.getByRole("button", { name: "Open task", exact: true });
    const assignmentCard = cards.filter({
      hasText: "You were assigned to the task “Meeting follow-up”.",
    });
    const changedCards = cards.filter({
      hasText: "The task “Meeting follow-up” was updated.",
    });
    await expect(assignmentCard).toHaveCount(1);
    await expect(changedCards).toHaveCount(2);
    await assignmentCard.click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return [url.pathname, url.searchParams.get("rowId")];
      })
      .toEqual([
        `/workspace/${f.workspaceId}/databases/${f.project.database.id}`,
        taskId,
      ]);
    const inboxDetail = page.getByRole("dialog", { name: /Task details/ });
    await expect(
      inboxDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    await expect
      .poll(
        async () =>
          (await inbox()).find((entry) => entry.type === "DatabaseRowAssigned")
            ?.read,
      )
      .toBe(true);
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/inbox`);
    await expect(changedCards).toHaveCount(2);
    // The two changes deliberately share the safe generic copy and target.
    // Open the newest native card after proving both status/due deliveries.
    await changedCards.nth(0).click();
    await expect(
      inboxDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    await expect
      .poll(
        async () =>
          (await inbox()).filter(
            (entry) => entry.type === "DatabaseTaskChanged" && entry.read,
          ).length,
      )
      .toBe(1);
    expect(
      (await inbox()).every(
        (entry) =>
          entry.body.rowId === taskId &&
          entry.body.databaseId === f.project.database.id &&
          entry.body.state === "Available" &&
          entry.body.targetKind === "Task",
      ),
    ).toBe(true);

    await inboxDetail
      .getByTestId("database-task-relations")
      .getByRole("button", { name: childTitle, exact: true })
      .click();
    await expect(
      inboxDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText(childTitle);
    await expect(
      inboxDetail
        .getByTestId("database-task-blocking")
        .getByRole("button", { name: "Meeting follow-up", exact: true }),
    ).toContainText("Active prerequisite");
    await inboxDetail
      .getByRole("combobox", { name: statusName, exact: true })
      .click();
    const childDone = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
        "updateDatabaseCellValue",
    );
    await page.getByRole("option", { name: "Completed", exact: true }).click();
    expect((await (await childDone).json()).errors).toBeUndefined();
    await expect(
      inboxDetail.getByRole("combobox", { name: statusName, exact: true }),
    ).toHaveValue("Completed");
    await inboxDetail
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(
      inboxDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    await expect(
      inboxDetail.getByTestId("database-task-relations"),
    ).toContainText("1 of 1 complete");
    await expect(
      inboxDetail
        .getByTestId("database-task-blocking")
        .getByRole("button", { name: childTitle, exact: true }),
    ).toContainText("Inactive prerequisite");
    const protectedFields = [
      role(f.project, "task.status"),
      role(f.project, "task.startDate"),
      role(f.project, "task.dueDate"),
    ];
    expect(
      (await readTask()).cells.filter((cell) =>
        protectedFields.includes(cell.fieldId),
      ),
    ).toEqual(
      baseline.cells.filter((cell) => protectedFields.includes(cell.fieldId)),
    );
    await inboxDetail
      .getByRole("button", { name: "Owned meeting source", exact: true })
      .click();
    await expect(page.locator("editor-host")).toBeVisible();
    expect((await referenceFor(page, taskId)).id).toBe(ref.id);
    await referenceCardReady(page, ref.parent!, "Meeting follow-up");
    await page
      .getByRole("button", { name: "Meeting follow-up", exact: true })
      .click();
    await expect(
      inboxDetail.getByRole("button", { name: titleName, exact: true }),
    ).toContainText("Meeting follow-up");
    await inboxDetail.getByTestId("database-row-action-menu").click();
    await page
      .getByRole("menuitem", { name: "Unfollow task", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readTask()).cells.find(
            (cell) => cell.fieldId === role(f.project, "task.watchers"),
          )?.value.users ?? [],
      )
      .toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.unroute("**/graphql", intercept);
    } finally {
      try {
        await page.goto("about:blank");
      } finally {
        await f.cleanup();
      }
    }
  }
});

test("Edgeless sticky capture inserts a separate ordinary Note and native Undo/Redo preserves source geometry and SQL identity", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request);
  const errors = observeErrors(page);
  try {
    await injectSessionCookies(context, f.cookies);
    const docId = await captureDocument(page, f, "Owned sticky meeting");
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/${docId}?mode=edgeless`,
    );
    await expect(page.locator("myoxus-edgeless-root")).toBeVisible();
    // N is the native Note tool shortcut. Place the new sticky with a pointer,
    // then enter its editor through the same double-click used by a person.
    const oldNoteIds = (await captureTree(page))
      .filter((block) => block.flavour === "myoxus:note")
      .map((block) => block.id);
    await page.keyboard.press("Escape");
    await page.keyboard.press("n");
    const canvas = page.locator("myoxus-edgeless-root");
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Edgeless canvas has no pointer bounds");
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 3,
    );
    await expect
      .poll(
        async () =>
          (await captureTree(page)).filter(
            (block) =>
              block.flavour === "myoxus:note" && !oldNoteIds.includes(block.id),
          ).length,
      )
      .toBe(1);
    const addedNote = (await captureTree(page)).find(
      (block) =>
        block.flavour === "myoxus:note" && !oldNoteIds.includes(block.id),
    )!;
    await page.locator(`[data-block-id="${addedNote.id}"]`).first().dblclick();
    const stickyInput = page
      .locator(
        `[data-block-id="${addedNote.id}"] rich-text [contenteditable="true"]:visible`,
      )
      .first();
    await stickyInput.click();
    await page.keyboard.type("Prepare the meeting follow-up");
    const before = await captureTree(page);
    const source = before.find(
      (block) => block.text === "Prepare the meeting follow-up",
    )!;
    const sticky = before.find((block) => block.id === source.parent)!;
    expect(sticky.flavour).toBe("myoxus:note");
    expect(sticky.displayMode).toBe("edgeless");
    const noteElement = page.locator(`[data-block-id="${sticky.id}"]`).first();
    await noteElement.dblclick();
    await waitForWorkspaceDocSync(page, docId);
    const rect = await noteElement.boundingBox();
    const modal = await prepareCapture(page, source.id, "Sticky follow-up");
    const description = modal.getByRole("textbox", {
      name: "Description (optional)",
      exact: true,
    });
    await description.fill("Review the copied sticky details");
    await description.press("Enter");
    await description.pressSequentially("Keep the source unchanged");
    const receipt = await commitCapture(page, modal);
    const saved = await f.gql<{
      workspace: {
        databaseRow: {
          cells: {
            fieldId: string;
            value: { richText: { plainText: string } | null };
          }[];
        };
      };
    }>(
      "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){cells{fieldId value{richText{plainText}}}}}}",
      { w: f.workspaceId, d: f.project.database.id, r: receipt.rowId },
    );
    expect(
      saved.workspace.databaseRow.cells.find(
        (cell) => cell.fieldId === role(f.project, "task.description"),
      )?.value.richText?.plainText,
    ).toBe("Review the copied sticky details\nKeep the source unchanged");
    const ref = await referenceFor(page, receipt.rowId);
    expect(ref.parent).not.toBe(sticky.id);
    await referenceCardReady(page, ref.parent!, "Sticky follow-up");
    const referenceNote = (await captureTree(page)).find(
      (block) => block.id === ref.parent,
    )!;
    expect(referenceNote.flavour).toBe("myoxus:note");
    expect(referenceNote.displayMode).toBe("both");
    expect(
      (await captureTree(page)).find((block) => block.id === sticky.id),
    ).toEqual(sticky);
    expect(
      (await captureTree(page)).find((block) => block.id === source.id),
    ).toEqual(source);
    await closeCapture(modal);
    expect(await noteElement.boundingBox()).toEqual(rect);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () =>
        (await captureTree(page)).some((block) => block.id === ref.id),
      )
      .toBe(false);
    expect(
      (await captureTree(page)).some((block) => block.id === referenceNote.id),
    ).toBe(false);
    expect((await f.rows()).rows.map((row) => row.rowId)).toEqual([
      receipt.rowId,
    ]);
    await page.keyboard.press("Control+Shift+z");
    expect((await referenceFor(page, receipt.rowId)).id).toBe(ref.id);
    await referenceCardReady(page, referenceNote.id, "Sticky follow-up");
    await expect
      .poll(async () =>
        (await captureTree(page)).find(
          (block) => block.id === referenceNote.id,
        ),
      )
      .toEqual(referenceNote);
    expect(
      (await captureTree(page)).find((block) => block.id === sticky.id),
    ).toEqual(sticky);
    expect(
      (await captureTree(page)).find((block) => block.id === source.id),
    ).toEqual(source);
    await waitForWorkspaceDocSync(page, docId);
    await page
      .locator(`[data-block-id="${referenceNote.id}"]`)
      .first()
      .dblclick();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return { pathname: url.pathname, rowId: url.searchParams.get("rowId") };
      })
      .toEqual({
        pathname: `/workspace/${f.workspaceId}/databases/${f.project.database.id}`,
        rowId: receipt.rowId,
      });
    const detail = page.getByRole("dialog", { name: /Task details/ });
    await detail
      .getByRole("button", { name: "Owned sticky meeting", exact: true })
      .click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return {
          pathname: url.pathname,
          blockIds: url.searchParams.get("blockIds"),
          mode: url.searchParams.get("mode"),
        };
      })
      .toEqual({
        pathname: `/workspace/${f.workspaceId}/${docId}`,
        blockIds: source.id,
        mode: "edgeless",
      });
    expect((await referenceFor(page, receipt.rowId)).id).toBe(ref.id);
    await referenceCardReady(page, referenceNote.id, "Sticky follow-up");
    await page.screenshot({
      path: test.info().outputPath("sticky-reference.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    try {
      await page.goto("about:blank");
    } finally {
      await f.cleanup();
    }
  }
});

test("private source capture has a wider Task audience; readonly creation is denied and reference ACL/public views redact Task data", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);
  const f = await captureFixture(request);
  const errors = observeErrors(page);
  try {
    await injectSessionCookies(context, f.cookies);
    const docId = await captureDocument(page, f, "Private meeting source");
    const paragraph = page
      .locator('myoxus-paragraph rich-text [contenteditable="true"]')
      .last();
    await paragraph.click();
    await page.keyboard.type("Private release instructions");
    const source = (await captureTree(page)).find(
      (block) => block.text === "Private release instructions",
    )!;
    await waitForWorkspaceDocSync(page, docId);
    const suffix = Date.now();
    const password = `OwnedCapture-${suffix}!`;
    const actor = (
      await f.gql<{ admin: { createUser: { id: string; email: string } } }>(
        "mutation($input:CreateUserInput!){admin{createUser(input:$input){id email}}}",
        {
          input: {
            name: "Capture destination Reader",
            email: `capture-flow-${suffix}@myoxus.local`,
            password,
          },
        },
      )
    ).admin.createUser;
    f.actors.push(actor.id);
    const collaborator = await signInViaApi(
      request,
      API,
      actor.email,
      password,
    );
    await smokeGql(
      request,
      GQL,
      collaborator,
      "mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{locale}}}",
      { input: { locale: "en" } },
    );
    const modal = await prepareCapture(
      page,
      source.id,
      "Shared release follow-up",
    );
    await modal
      .getByRole("textbox", { name: "Description (optional)", exact: true })
      .clear();
    const receipt = await commitCapture(page, modal);
    const ref = await referenceFor(page, receipt.rowId);
    await closeCapture(modal);
    await waitForWorkspaceDocSync(page, docId);
    // Move the source to an owner-only workspace: Task and source now have
    // genuinely different audiences without bypassing the document role floor.
    // Leave the live editor through normal navigation before taking a root CAS.
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/all`);
    await waitForWorkspaceReady(page, { allDocs: true });
    await page.goto("about:blank");
    const privateWorkspaceId = (
      await f.gql<{ createWorkspace: { id: string } }>(
        "mutation{createWorkspace{id}} ",
      )
    ).createWorkspace.id;
    f.ownedWorkspaces.push(privateWorkspaceId);
    await captureWorkspaceReady(f.gql, privateWorkspaceId);
    await f.gql(
      "mutation($input:AdminUpdateWorkspaceInput!){admin{adminUpdateWorkspace(input:$input){id}}}",
      {
        input: {
          id: privateWorkspaceId,
          name: `Owned private capture source ${Date.now()}`,
        },
      },
    );
    await moveCaptureResource(f, f.workspaceId, privateWorkspaceId, {
      kind: "Document",
      id: docId,
    });
    await f.gql(
      'mutation($w:ID!,$u:ID!){admin{addWorkspaceMember(workspaceId:$w,userId:$u,role:"Reader"){id}}}',
      { w: f.workspaceId, u: actor.id },
    );
    await context.clearCookies();
    await injectSessionCookies(context, collaborator);
    await page.goto(
      `${FRONTEND}/workspace/${f.workspaceId}/databases/${f.project.database.id}?rowId=${receipt.rowId}`,
    );
    const detail = page.getByRole("dialog", { name: /Task details/ });
    await expect(detail).toContainText("Shared release follow-up");
    await expect(
      detail.getByRole("button", {
        name: "Private meeting source",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(detail).not.toContainText("Private release instructions");
    await expect(detail).not.toContainText("Private meeting source");
    await expect(detail).toContainText("Unavailable");
    // Returning the same immutable Doc/key restores the original source.
    // Reader can read/copy but cannot CreateDoc; Collaborator has an Editor
    // floor, so successful readonly capture is not an assignable role state.
    await moveCaptureResource(f, privateWorkspaceId, f.workspaceId, {
      kind: "Document",
      id: docId,
    });
    const restoredSource = (
      await f.gql<{
        workspace: {
          databaseRow: {
            row: {
              source: { documentId: string; externalId: string; state: string };
            };
          };
        };
      }>(
        "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{source{documentId externalId state}}}}}",
        { w: f.workspaceId, d: f.project.database.id, r: receipt.rowId },
      )
    ).workspace.databaseRow.row.source;
    expect(restoredSource).toEqual({
      documentId: receipt.source.documentId,
      externalId: docId,
      state: "Available",
    });
    await page.goto(`${FRONTEND}/workspace/${f.workspaceId}/${docId}`);
    await expect(
      page.locator(`[data-block-id="${source.id}"] rich-text`),
    ).toContainText("Private release instructions");
    await expect(
      page.locator(`[data-block-id="${source.id}"] [contenteditable="true"]`),
    ).toHaveCount(0);
    await expect(
      page
        .locator(`[data-block-id="${ref.id}"]`)
        .getByRole("button", { name: "Shared release follow-up", exact: true }),
    ).toBeVisible();
    // Reader selection is a native browser range, with no capture toolbar.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .locator(`[data-block-id="${source.id}"] rich-text .inline-editor`)
      .first()
      .click({ clickCount: 3 });
    await expect
      .poll(() =>
        page.evaluate(() => document.getSelection()?.toString() ?? ""),
      )
      .toContain("Private release instructions");
    await expect(
      page.locator('editor-icon-button[aria-label="More"]:visible'),
    ).toHaveCount(0);
    await expect(page.getByTestId("capture-as-task")).toHaveCount(0);
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Private release instructions");
    // The same actor is denied by the real producer, independently of UI state.
    const rejectedResponse = await request.post(GQL, {
      headers: {
        Cookie: collaborator.map((cookie) => cookie.split(";")[0]).join("; "),
      },
      data: {
        query:
          "mutation($input:CreateDatabaseTaskFromSourceInput!){createDatabaseTaskFromSource(input:$input){rowId}}",
        variables: {
          input: {
            workspaceId: f.workspaceId,
            databaseId: f.project.database.id,
            requestId: randomUUID(),
            sourceDocumentId: receipt.source.documentId,
            sourceExternalId: docId,
            blockId: source.id,
            title: "Forbidden readonly capture",
            cells: [],
          },
        },
      },
    });
    expect(rejectedResponse.status()).toBe(200);
    const rejected = await rejectedResponse.json();
    expect(rejected.data).toBeNull();
    expect(rejected.errors?.[0]?.extensions?.code).toBe(
      "MIX_DATABASE_FORBIDDEN",
    );
    expect((await f.rows()).rows.map((row) => row.rowId)).toEqual([
      receipt.rowId,
    ]);
    expect(
      (await captureTree(page)).filter((block) => block.rowId),
    ).toHaveLength(1);
    expect(
      (await captureTree(page)).find((block) => block.id === ref.id)?.rowId,
    ).toBe(receipt.rowId);
    // Keep source Read intact while the original Project moves out of scope.
    // The persisted old-workspace tuple must neither retarget nor expose SQL data.
    await moveCaptureResource(f, f.workspaceId, privateWorkspaceId, {
      kind: "Database",
      id: f.project.database.id,
    });
    const movedTask = (
      await f.gql<{
        workspace: { databaseRow: { row: { id: string; title: string } } };
      }>(
        "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id title}}}}",
        { w: privateWorkspaceId, d: f.project.database.id, r: receipt.rowId },
      )
    ).workspace.databaseRow.row;
    expect(movedTask).toEqual({
      id: receipt.rowId,
      title: "Shared release follow-up",
    });
    await page.reload();
    await expect(page.locator("doc-title")).toContainText(
      "Private meeting source",
    );
    await expect(
      page.locator(`[data-block-id="${source.id}"] rich-text`),
    ).toContainText("Private release instructions");
    const retainedReference = (await captureTree(page)).find(
      (block) => block.id === ref.id,
    );
    expect(retainedReference).toMatchObject({
      workspaceId: f.workspaceId,
      databaseId: f.project.database.id,
      rowId: receipt.rowId,
    });

    const embed = page.locator(
      `[data-block-id="${ref.id}"] myoxus-database-embed`,
    );
    await expect(embed).not.toContainText("Shared release follow-up");
    await expect(
      embed.getByRole("button", {
        name: "Shared release follow-up",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(embed).toContainText("Row could not be loaded");
    await page.goto("about:blank");
    await f.gql(
      "mutation($input:AdminUpdateWorkspaceInput!){admin{adminUpdateWorkspace(input:$input){id}}}",
      { input: { id: f.workspaceId, public: true, enableSharing: true } },
    );
    await f.gql(
      "mutation($w:String!,$d:String!){publishDoc(workspaceId:$w,docId:$d,mode:Page){id}}",
      { w: f.workspaceId, d: docId },
    );
    await context.clearCookies();
    // The actual anonymous owner is server-rendered public HTML, delivered by
    // the normal frontend gateway; it does not mount a collaborative editor.
    await page.goto(`${FRONTEND}/public/${f.workspaceId}/${docId}`);
    await expect(page).toHaveTitle("Private meeting source");
    const publicDocument = page
      .getByRole("main")
      .locator('article[data-myoxus-role="public-document"]');
    await expect(publicDocument).toBeVisible();
    await expect(publicDocument).toContainText("Private release instructions");
    await expect(publicDocument).toContainText("Target unavailable");
    await expect(publicDocument).not.toContainText("Shared release follow-up");
    await expect(publicDocument).not.toContainText("Capture journey Project");
    await expect(
      publicDocument.getByRole("link", {
        name: "Shared release follow-up",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      publicDocument.getByRole("button", {
        name: "Shared release follow-up",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    try {
      await page.goto("about:blank");
    } finally {
      await f.cleanup();
    }
  }
});
