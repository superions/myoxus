// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
} from "../../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${API}/graphql`;

async function activateDatabaseView(page: Page, viewId: string) {
  const tab = page.getByTestId(`database-view-tab-${viewId}`);
  if (await tab.isVisible()) {
    await tab.click();
    return;
  }
  const more = page.locator(
    '[data-myoxus-ui-role="overflow-tabs-more-trigger"]',
  );
  await more.click();
  await page.getByTestId(`overflow-tab-item-${viewId}`).click();
}

async function runAndExpectMutation(
  page: Page,
  operation: string,
  action: () => Promise<unknown>,
  expectedErrorCode?: string,
) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === "/graphql" &&
      request.method() === "POST" &&
      request.headers()["x-operation-name"] === operation
    );
  });
  await action();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ extensions?: { code?: string } }>;
  };
  if (expectedErrorCode) {
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors![0]!.extensions?.code).toBe(expectedErrorCode);
  } else {
    expect(payload.errors).toBeUndefined();
  }
  return {
    payload,
    variables: response.request().postDataJSON().variables as Record<
      string,
      unknown
    >,
  };
}

test.describe("Database temporal views", () => {
  test.describe.configure({ timeout: 90_000 });

  test("preserves atomic Timeline conflicts and Gantt edits across cold reload", async ({
    context,
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectSessionCookies(context, cookies);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    const gql = <T>(query: string, variables: Record<string, unknown>) =>
      smokeGql<T>(request, GQL, cookies, query, variables);
    const created = await gql<{
      createDatabase: {
        database: { id: string };
        fields: Array<{ id: string; fieldType: string }>;
      };
    }>(
      `mutation($input: CreateDatabaseInput!) { createDatabase(input: $input) { database { id } fields { id fieldType } } }`,
      {
        input: {
          workspaceId,
          title: "Temporal flow isolated fixture",
          initialViewKind: "Table",
        },
      },
    );
    const databaseId = created.createDatabase.database.id;
    const titleFieldId = created.createDatabase.fields.find(
      (field) => field.fieldType === "Title",
    )!.id;
    // The whole fixture is test-owned. Cleanup never force-clears a seed relation
    // or restores a stale value over another consumer's edit.
    try {
      const field = async (
        name: string,
        fieldType: string,
        config?: Record<string, unknown>,
      ) => {
        const response = await gql<{ createDatabaseField: { id: string } }>(
          `mutation($input: CreateDatabaseFieldInput!) { createDatabaseField(input: $input) { id } }`,
          {
            input: {
              databaseId,
              name,
              fieldType,
              ...(config ? { config } : {}),
            },
          },
        );
        return response.createDatabaseField.id;
      };
      const startId = await field("Start", "Date");
      const endId = await field("End", "Date");
      const laneId = await field("Lane", "Select", {
        select: {
          options: [
            {
              id: "todo",
              name: "Todo",
              position: 0,
              colorRole: "database.status.todo",
            },
            {
              id: "done",
              name: "Done",
              position: 1,
              colorRole: "database.status.done",
            },
          ],
        },
      });
      const dependencyId = await field("Depends on", "Relation", {
        relation: { targetDatabaseId: databaseId, allowMultiple: true },
      });
      const view = async (
        name: string,
        viewKind: string,
        config: Record<string, unknown>,
      ) => {
        const response = await gql<{ createDatabaseView: { id: string } }>(
          `mutation($input: CreateDatabaseViewInput!) { createDatabaseView(input: $input) { id } }`,
          { input: { databaseId, name, viewKind, config } },
        );
        return response.createDatabaseView.id;
      };
      const timelineId = await view("Timeline", "Timeline", {
        timeline: {
          titleFieldId,
          startFieldId: startId,
          endFieldId: endId,
          visibleFieldIds: [titleFieldId, startId, endId],
          zoom: "Month",
        },
      });
      const ganttId = await view("Gantt", "Gantt", {
        gantt: {
          titleFieldId,
          startFieldId: startId,
          endFieldId: endId,
          visibleFieldIds: [titleFieldId, startId, endId, laneId, dependencyId],
          group: { fieldId: laneId, showEmptyGroups: true },
          dependencyFieldId: dependencyId,
          zoom: "Month",
        },
      });
      const prerequisites: string[] = [];
      for (const title of ["First prerequisite", "Second prerequisite"]) {
        const response = await gql<{
          createDatabaseRow: { row: { id: string } };
        }>(
          `mutation($input: CreateDatabaseRowInput!) { createDatabaseRow(input: $input) { row { id } } }`,
          {
            input: {
              databaseId,
              title,
              cells: [
                { fieldId: startId, value: { date: { start: "2026-07-02" } } },
                { fieldId: endId, value: { date: { start: "2026-07-03" } } },
              ],
            },
          },
        );
        prerequisites.push(response.createDatabaseRow.row.id);
      }
      const route = `${FRONTEND}/workspace/${workspaceId}/databases/${databaseId}`;
      await page.goto(`${route}?viewId=${timelineId}`, { waitUntil: "load" });
      const timeline = page.getByTestId("database-timeline-view");
      await expect(timeline).toBeVisible();
      // Browser locale does not override persisted user language preferences.
      // Read the consuming UI language without changing the seed user's profile.
      const locale = (await page.locator("html").getAttribute("lang")) ?? "en";
      expect(locale).toMatch(/^[a-z]{2}(?:-[A-Za-z]+)?$/);
      const resources = JSON.parse(
        await readFile(`client/libs/i18n/src/resources/${locale}.json`, "utf8"),
      ) as Record<string, string>;
      const label = (key: string): string => {
        const value = resources[key];
        if (!value) throw new Error(`Missing ${locale} test label: ${key}`);
        const reference = /^\$t\(([^)]+)\)$/.exec(value);
        return reference ? label(reference[1]!) : value;
      };
      await page
        .getByTestId("database-view-toolbar")
        .getByRole("button", {
          name: new RegExp(
            `^${label("com.myoxus.database.view.timeline-group")}:`,
          ),
        })
        .click();
      const settings = page.getByTestId("database-workbench-context");
      const display = settings.getByTestId("database-view-settings-display");
      await display
        .getByRole("combobox", {
          name: label("com.myoxus.database.schedule.zoom"),
        })
        .click();
      await page
        .getByRole("option", {
          name: label("com.myoxus.database.view.period.quarter"),
          exact: true,
        })
        .click();
      await runAndExpectMutation(page, "updateDatabaseView", () =>
        display
          .getByRole("button", { name: label("Save"), exact: true })
          .click(),
      );
      await page.reload({ waitUntil: "load" });
      const date = page.getByRole("textbox", {
        name: label("Date"),
        exact: true,
      });
      const chooseDate = async () => {
        await date.fill(
          new Intl.DateTimeFormat(locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }).format(new Date("2026-07-15T00:00:00Z")),
        );
        await date.press("Enter");
        await date.press("Tab");
      };
      await chooseDate();
      await expect(
        page.getByRole("combobox", {
          name: label("com.myoxus.database.schedule.zoom"),
          exact: true,
        }),
      ).toHaveValue(label("com.myoxus.database.view.period.quarter"));
      const timelineRowId = prerequisites[0]!;
      const entry = timeline.locator(`[data-time-entry-id="${timelineRowId}"]`);
      await expect(entry).toBeVisible();
      await entry.press("Space");
      const moveHandle = timeline.locator(
        `[data-time-handle-id="${timelineRowId}"][data-time-handle-mode="move"]`,
      );
      await expect(moveHandle).toBeEnabled();
      await moveHandle.press("Space");
      await expect(moveHandle).toHaveAttribute("aria-grabbed", "true");
      await moveHandle.press("ArrowRight");
      const timelineMove = await runAndExpectMutation(
        page,
        "bulkApplyDatabaseCellPatches",
        () => moveHandle.press("Enter"),
      );
      expect(timelineMove.variables.input).toMatchObject({
        databaseId,
        force: false,
        patches: [
          {
            rowId: timelineRowId,
            cells: [
              {
                fieldId: startId,
                expectedEditRevision: 1,
                value: { date: { start: "2026-07-03", end: null } },
              },
              {
                fieldId: endId,
                expectedEditRevision: 1,
                value: { date: { start: "2026-07-04", end: null } },
              },
            ],
          },
        ],
      });
      const readTimelineRow = async () => {
        const result = await gql<{
          workspace: {
            databaseRow: {
              row: { title: string };
              cells: Array<{
                fieldId: string;
                editRevision: number;
                value: { date: { start: string; end: string | null } | null };
              }>;
            };
          };
        }>(
          `query($workspaceId: String!, $databaseId: ID!, $rowId: ID!) {
            workspace(id: $workspaceId) { databaseRow(databaseId: $databaseId, rowId: $rowId) {
              row { title } cells { fieldId editRevision value { date { start end } } }
            } } }`,
          { workspaceId, databaseId, rowId: timelineRowId },
        );
        return new Map(
          result.workspace.databaseRow.cells.map((cell) => [
            cell.fieldId,
            cell,
          ]),
        );
      };
      const moved = await readTimelineRow();
      expect(moved.get(startId)).toMatchObject({
        editRevision: 2,
        value: { date: { start: "2026-07-03", end: null } },
      });
      expect(moved.get(endId)).toMatchObject({
        editRevision: 2,
        value: { date: { start: "2026-07-04", end: null } },
      });
      await expect(moveHandle).toHaveAttribute("aria-grabbed", "false");
      await expect(moveHandle).toBeEnabled();
      await moveHandle.press("Space");
      await expect(moveHandle).toHaveAttribute("aria-grabbed", "true");
      await moveHandle.press("ArrowRight");
      // A competing end change must roll back the stale start patch as well.
      const competing = await gql<{
        bulkApplyDatabaseCellPatches: { transactionCommitted: boolean };
      }>(
        `mutation($input: BulkApplyDatabaseCellPatchesInput!) {
          bulkApplyDatabaseCellPatches(input: $input) { transactionCommitted }
        }`,
        {
          input: {
            databaseId,
            force: false,
            patches: [
              {
                rowId: timelineRowId,
                cells: [
                  {
                    fieldId: endId,
                    expectedEditRevision: 2,
                    value: { date: { start: "2026-07-06" } },
                  },
                ],
              },
            ],
          },
        },
      );
      expect(competing.bulkApplyDatabaseCellPatches.transactionCommitted).toBe(
        true,
      );
      // Remote conflict freezes further dragging; the explicit draft Apply
      // still submits the captured revisions to the canonical conflict owner.
      await expect(moveHandle).toBeDisabled();
      await runAndExpectMutation(
        page,
        "bulkApplyDatabaseCellPatches",
        () =>
          timeline
            .locator(`[data-time-card-id="${timelineRowId}"]`)
            .getByRole("button", { name: label("Apply"), exact: true })
            .click(),
        "MIX_DATABASE_BULK_CONFLICT",
      );
      const conflict = page.getByRole("dialog");
      await expect(conflict).toContainText(
        label("com.myoxus.database.conflict.title"),
      );
      await expect(conflict).toContainText(
        label("com.myoxus.database.conflict.local-value"),
      );
      await expect(conflict).toContainText(
        label("com.myoxus.database.conflict.server-value"),
      );
      const preserved = await readTimelineRow();
      expect(preserved.get(startId)).toEqual(moved.get(startId));
      expect(preserved.get(endId)).toMatchObject({
        editRevision: 3,
        value: { date: { start: "2026-07-06", end: null } },
      });
      await conflict
        .getByRole("button", {
          name: label("com.myoxus.database.conflict.reload"),
          exact: true,
        })
        .click();
      await expect(conflict).toHaveCount(0);
      await expect(entry).toBeVisible();
      await page.reload({ waitUntil: "load" });
      await chooseDate();
      await expect(entry).toBeVisible();
      await expect(entry).toContainText("First prerequisite");
      expect(await readTimelineRow()).toEqual(preserved);
      await activateDatabaseView(page, ganttId);
      const gantt = page.locator('[data-testid="database-gantt-view"]:visible');
      await chooseDate();
      await expect(
        gantt.getByTestId(
          `gantt-bar-${JSON.stringify([prerequisites[0], "__empty__"])}`,
        ),
      ).toBeVisible();
      const region = gantt.getByLabel("Gantt", { exact: true });
      await page
        .getByRole("button", {
          name: label("com.myoxus.database.row.add"),
          exact: true,
        })
        .click();
      await region.focus();
      // Configured select options precede the server's Empty bucket. Choose it
      // deliberately before placing, rather than assuming it is the first lane.
      await region.press("ArrowDown");
      await region.press("ArrowDown");
      await region.press("ArrowRight");
      await region.press("Shift+ArrowRight");
      await region.press("Shift+ArrowRight");
      await region.press("Enter");
      const titleInput = page.getByRole("textbox", {
        name: label("Title"),
        exact: true,
      });
      await titleInput.fill("Placed task");
      const placement = page
        .locator(".mantine-Popover-dropdown")
        .filter({ has: titleInput });
      const creation = await runAndExpectMutation(
        page,
        "createDatabaseRow",
        () =>
          placement
            .getByRole("button", {
              name: label("com.myoxus.database.row.add"),
              exact: true,
            })
            .click(),
      );
      const rowId = (
        creation.payload.data!.createDatabaseRow as { row: { id: string } }
      ).row.id;
      const bar = (id: string, lane: string) =>
        gantt.getByTestId(`gantt-bar-${JSON.stringify([id, lane])}`);
      let task = bar(rowId, "__empty__");
      await expect(task).toBeVisible();
      await task.press("F2");
      await titleInput.fill("Renamed task");
      await runAndExpectMutation(page, "updateDatabaseRowTitle", () =>
        titleInput.press("Enter"),
      );
      await expect(
        gantt.getByTestId(
          `gantt-label-${JSON.stringify([rowId, "__empty__"])}`,
        ),
      ).toContainText("Renamed task");
      await expect(task).toHaveAttribute("data-readonly", "false");
      await task.press("Alt+ArrowRight");
      await task.press("Alt+ArrowUp");
      await task.press("Alt+ArrowUp");
      const move = await runAndExpectMutation(
        page,
        "bulkApplyDatabaseCellPatches",
        () => task.press("Enter"),
      );
      expect(move.variables.input).toMatchObject({
        databaseId,
        force: false,
        patches: [
          {
            rowId,
            cells: [
              {
                fieldId: startId,
                expectedEditRevision: 1,
                value: { date: { start: "2026-07-03", end: null } },
              },
              {
                fieldId: endId,
                expectedEditRevision: 1,
                value: { date: { start: "2026-07-05", end: null } },
              },
              {
                fieldId: laneId,
                expectedEditRevision: 0,
                value: { select: "todo" },
              },
            ],
          },
        ],
      });
      task = bar(rowId, "todo");
      await expect(task).toBeVisible();
      await expect(task).toHaveAttribute("data-readonly", "false");
      await task.press("Alt+Shift+ArrowRight");
      const resize = await runAndExpectMutation(
        page,
        "bulkApplyDatabaseCellPatches",
        () => task.press("Enter"),
      );
      expect(resize.variables.input).toMatchObject({
        patches: [
          {
            rowId,
            cells: [
              {
                fieldId: endId,
                expectedEditRevision: 2,
                value: { date: { start: "2026-07-06", end: null } },
              },
            ],
          },
        ],
      });
      await expect(task).toHaveAttribute("data-readonly", "false");
      // Precise-range endpoint controls belong to the selected source row.
      await bar(prerequisites[0]!, "__empty__").press("Space");
      await gantt
        .getByTestId(
          `gantt-connect-${JSON.stringify([prerequisites[0], "__empty__"])}`,
        )
        .click();
      await task.press("Enter");
      await runAndExpectMutation(page, "bulkApplyDatabaseCellPatches", () =>
        page
          .getByRole("dialog")
          .getByRole("button", { name: label("Apply"), exact: true })
          .click(),
      );
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const edge = gantt.getByRole("button", {
        name: "First prerequisite → Renamed task",
        exact: true,
      });
      await edge.press("ArrowLeft");
      await bar(prerequisites[1]!, "__empty__").press("Enter");
      await runAndExpectMutation(page, "bulkApplyDatabaseCellPatches", () =>
        page
          .getByRole("dialog")
          .getByRole("button", { name: label("Apply"), exact: true })
          .click(),
      );
      await expect(
        gantt.getByRole("button", {
          name: "Second prerequisite → Renamed task",
          exact: true,
        }),
      ).toBeVisible();
      await expect(edge).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await task.press("Enter");
      // Mantine portals the visible Drawer dialog outside its zero-area root.
      const detail = page.getByRole("dialog").filter({
        has: page.getByText("Renamed task", { exact: true }),
      });
      await expect(detail).toBeVisible();
      await expect(
        detail.getByText("Renamed task", { exact: true }),
      ).toBeVisible();
      await detail
        .getByRole("button", {
          name: label("com.myoxus.peek-view-controls.close"),
          exact: true,
        })
        .click();
      const readback = await gql<{
        workspace: {
          databaseRow: {
            row: { title: string };
            cells: Array<{
              fieldId: string;
              value: {
                date?: { start: string };
                select?: string;
                relation?: string[];
              };
            }>;
          };
        };
      }>(
        `query($workspaceId: String!, $databaseId: ID!, $rowId: ID!) { workspace(id: $workspaceId) { databaseRow(databaseId: $databaseId, rowId: $rowId) { row { title } cells { fieldId value { date { start } select relation } } } } }`,
        { workspaceId, databaseId, rowId },
      );
      expect(readback.workspace.databaseRow.row.title).toBe("Renamed task");
      const cells = new Map(
        readback.workspace.databaseRow.cells.map((cell) => [
          cell.fieldId,
          cell.value,
        ]),
      );
      expect(cells.get(startId)?.date?.start).toBe("2026-07-03");
      expect(cells.get(endId)?.date?.start).toBe("2026-07-06");
      expect(cells.get(laneId)?.select).toBe("todo");
      expect(cells.get(dependencyId)?.relation).toEqual([prerequisites[1]]);
      await page.reload({ waitUntil: "load" });
      await chooseDate();
      await expect(bar(rowId, "todo")).toBeVisible();
      await expect(
        gantt.getByTestId(`gantt-label-${JSON.stringify([rowId, "todo"])}`),
      ).toContainText("Renamed task");
      await expect(
        gantt.getByRole("button", {
          name: "Second prerequisite → Renamed task",
          exact: true,
        }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await gql(
        `mutation($input: DatabaseLifecycleInput!) { trashDatabase(input: $input) { database { id } } }`,
        { input: { databaseId } },
      );
      await gql(
        `mutation($input: DatabaseLifecycleInput!) { deleteDatabasePermanently(input: $input) }`,
        { input: { databaseId } },
      );
    }
  });
});
