// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
  waitForWorkspaceReady,
} from "../../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;

type DashboardLayout = {
  workspaceId: string;
  orderedDashletIds: string[];
  dashletSizes: Array<{ dashletId: string; size: string }>;
};

let cookies: string[] = [];
let workspaceId = "";
let previousLocale: string | null = null;
let previousLayouts: DashboardLayout[] | null = null;

async function updatePreferences(
  request: Parameters<typeof smokeGql>[0],
  input: Record<string, unknown>,
) {
  return smokeGql<{
    updatePreferences: {
      values: { workspaceDashboardLayouts: DashboardLayout[] | null };
    };
  }>(
    request,
    GQL,
    cookies,
    `mutation WorkspaceHomeDashboardPreferences(
      $input: UpdateUserPreferencesInput!
    ) {
      updatePreferences(input: $input) {
        values {
          workspaceDashboardLayouts {
            workspaceId
            orderedDashletIds
            dashletSizes { dashletId size }
          }
        }
      }
    }`,
    { input },
  );
}

async function readLayouts(request: Parameters<typeof smokeGql>[0]) {
  const result = await smokeGql<{
    currentUser: {
      preferences: {
        values: {
          locale: string | null;
          workspaceDashboardLayouts: DashboardLayout[] | null;
        };
      };
    };
  }>(
    request,
    GQL,
    cookies,
    `query WorkspaceHomeDashboardPreferences {
      currentUser {
        preferences {
          values {
            locale
            workspaceDashboardLayouts {
              workspaceId
              orderedDashletIds
              dashletSizes { dashletId size }
            }
          }
        }
      }
    }`,
  );
  return result.currentUser.preferences.values;
}

test.describe("Workspace Home dashboard arrangement", () => {
  test.beforeAll(async ({ request }) => {
    cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    const previous = await readLayouts(request);
    previousLocale = previous.locale;
    previousLayouts = previous.workspaceDashboardLayouts;
    await updatePreferences(request, {
      locale: "en",
      workspaceDashboardLayouts: null,
    });
  });

  test.afterAll(async ({ request }) => {
    if (!cookies.length) return;
    await updatePreferences(request, {
      locale: previousLocale,
      workspaceDashboardLayouts: previousLayouts,
    });
  });

  test.beforeEach(async ({ context }) => {
    await injectSessionCookies(context, cookies);
  });

  test("reorders, resizes, persists, resets, and remains keyboard-operable on desktop", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${FRONTEND}/workspace/${workspaceId}/home`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page);

    const grid = page.locator('[data-myoxus-ui-role="workspace-home-grid"]');
    const dashlets = grid.locator(
      '[data-myoxus-ui-role="workspace-home-dashlet"]',
    );
    const order = () =>
      dashlets.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-dashlet-id")),
      );
    const visibleMenuItem = (name: string) =>
      page
        .locator('[role="menu"]:visible')
        .last()
        .getByRole("menuitem", { name, exact: true });

    await expect(grid).toBeVisible();
    await expect(dashlets).toHaveCount(6);
    await expect(
      grid
        .locator('[data-myoxus-ui-role="workspace-home-tasks"]')
        .getByText(/^[0-9]+ tasks?$/),
    ).toBeVisible();
    expect(await order()).toEqual([
      "today",
      "tasks",
      "new-documents",
      "reminders",
      "recently-edited",
      "activity",
    ]);
    await expect(
      grid.locator('[data-myoxus-ui-role="drag-handle"]'),
    ).toHaveCount(0);

    await page.getByRole("button", { name: /Customi[sz]e/ }).click();
    await expect(
      grid.locator('[data-myoxus-ui-role="drag-handle"]:visible'),
    ).toHaveCount(6);

    const activity = grid.locator('[data-dashlet-id="activity"]');
    const activityHandle = activity.locator(
      '[data-myoxus-ui-role="drag-handle"]:visible',
    );
    const recentlyEdited = grid.locator('[data-dashlet-id="recently-edited"]');
    await activityHandle.scrollIntoViewIfNeeded();
    const sourceBox = await activityHandle.boundingBox();
    const targetBox = await recentlyEdited.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(sourceBox!.x, sourceBox!.y, { steps: 4 });
    await page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + 4,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "reminders",
        "activity",
        "recently-edited",
      ]);

    await activityHandle.focus();
    await activityHandle.press("Space");
    await activityHandle.press("ArrowUp");
    await activityHandle.press("Space");
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "activity",
        "reminders",
        "recently-edited",
      ]);

    await activityHandle.focus();
    await activityHandle.press("Space");
    await activityHandle.press("ArrowUp");
    await activityHandle.press("Escape");
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "activity",
        "reminders",
        "recently-edited",
      ]);

    await activityHandle.press("Enter");
    await expect(visibleMenuItem("Move up")).toBeVisible();
    await page.keyboard.press("Escape");

    for (const dashletId of ["today", "tasks", "reminders"] as const) {
      const dashlet = grid.locator(`[data-dashlet-id="${dashletId}"]`);
      await dashlet.getByRole("button", { name: "Size", exact: true }).click();
      await expect(visibleMenuItem("Compact")).toBeDisabled();
      await page.keyboard.press("Escape");
    }

    await activity.getByRole("button", { name: "Size", exact: true }).click();
    await expect(visibleMenuItem("Compact")).toBeDisabled();
    await visibleMenuItem("Full width").click();
    await expect(activity).toHaveAttribute("data-dashlet-size", "wide");

    const newDocuments = grid.locator('[data-dashlet-id="new-documents"]');
    await newDocuments
      .getByRole("button", { name: "Size", exact: true })
      .click();
    await visibleMenuItem("Compact").click();
    await expect(newDocuments).toHaveAttribute("data-dashlet-size", "compact");

    await expect
      .poll(async () => {
        const layouts = (await readLayouts(request)).workspaceDashboardLayouts;
        return layouts?.find((layout) => layout.workspaceId === workspaceId);
      })
      .toMatchObject({
        orderedDashletIds: [
          "Today",
          "Tasks",
          "NewDocuments",
          "Activity",
          "Reminders",
          "RecentlyEdited",
        ],
        dashletSizes: expect.arrayContaining([
          { dashletId: "Activity", size: "Wide" },
          { dashletId: "NewDocuments", size: "Compact" },
        ]),
      });

    await page.reload({ waitUntil: "load" });
    await waitForWorkspaceReady(page);
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "activity",
        "reminders",
        "recently-edited",
      ]);
    await expect(newDocuments).toHaveAttribute("data-dashlet-size", "compact");

    await page.getByRole("button", { name: /Customi[sz]e/ }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await visibleMenuItem("Reset").click();
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "reminders",
        "recently-edited",
        "activity",
      ]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(order)
      .toEqual([
        "today",
        "tasks",
        "new-documents",
        "activity",
        "reminders",
        "recently-edited",
      ]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    const geometry = await grid.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        rows: [
          ...node.querySelectorAll(
            '[data-myoxus-ui-role="workspace-home-dashlet"]',
          ),
        ].map((child) => {
          const box = child.getBoundingClientRect();
          return { left: box.left, right: box.right };
        }),
      };
    });
    expect(
      new Set(geometry.rows.map((row) => Math.round(row.left))).size,
    ).toBeGreaterThan(1);
    for (const row of geometry.rows) {
      expect(row.left).toBeGreaterThanOrEqual(geometry.left);
      expect(row.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    await newDocuments
      .getByRole("button", { name: "Size", exact: true })
      .click();
    await expect(visibleMenuItem("Compact")).toBeEnabled();
    await page.keyboard.press("Escape");

    await activityHandle.focus();
    await activityHandle.press("Enter");
    await expect(visibleMenuItem("Move up")).toBeVisible();
    await page.keyboard.press("Escape");
    const desktopOrder = await order();
    await activityHandle.press("Space");
    await activityHandle.press("ArrowDown");
    await activityHandle.press("Escape");
    await expect.poll(order).toEqual(desktopOrder);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("connects Home, Command Center, and the persistent Inbox", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const inventory = await smokeGql<{
      workspace: { docs: { edges: Array<{ node: { id: string } }> } };
    }>(
      request,
      GQL,
      cookies,
      `query InboxFlowTarget($workspace:String!){workspace(id:$workspace){docs(pagination:{first:30}){edges{node{id}}}}}`,
      { workspace: workspaceId },
    );
    const target = inventory.workspace.docs.edges
      .map((edge) => edge.node.id)
      .find(
        (id) =>
          id !== workspaceId &&
          !id.startsWith("db$") &&
          !id.startsWith("userdata$"),
      );
    expect(
      target,
      "persisted readable desktop navigation target",
    ).toBeDefined();
    const fixtureId = "36fceef8-caf1-4dcd-a379-986496358aca";
    let read = false;
    const createdAt = new Date().toISOString();
    const filters: Array<{ types?: string[]; includeRead?: boolean }> = [];
    const readIds: string[] = [];
    // Only the notification projection is a UI fixture. Document inventory,
    // authorization and navigation continue through the served backend.
    await page.route("**/graphql", async (route) => {
      const input = route.request().postDataJSON();
      const query = typeof input?.query === "string" ? input.query : "";
      if (
        input?.operationName === "readNotification" ||
        /mutation readNotification\(/.test(query)
      ) {
        expect(input.variables.id).toBe(fixtureId);
        readIds.push(input.variables.id);
        read = true;
        await route.fulfill({ json: { data: { readNotification: true } } });
        return;
      }
      if (
        input?.operationName === "notificationCount" ||
        /query notificationCount\b/.test(query)
      ) {
        await route.fulfill({
          json: {
            data: {
              currentUser: { notifications: { totalCount: read ? 0 : 1 } },
            },
          },
        });
        return;
      }
      if (
        input?.operationName !== "listNotifications" &&
        !/query listNotifications\(/.test(query)
      ) {
        await route.continue();
        return;
      }
      const filter = input.variables.filter ?? {};
      filters.push(filter);
      const visible =
        (!filter.types || filter.types.includes("DocumentChanged")) &&
        (!read || filter.includeRead);
      const node = {
        id: fixtureId,
        type: "DocumentChanged",
        level: "Default",
        read,
        createdAt,
        updatedAt: createdAt,
        body: {
          workspace: { id: workspaceId },
          doc: { id: target, title: "DNOT desktop flow target", mode: "page" },
          createdByUser: {
            id: "73991990-e397-4f0c-a588-c288096a8f57",
            name: "Flow actor",
          },
          otherActorCount: 1,
        },
      };
      await route.fulfill({
        json: {
          data: {
            currentUser: {
              notifications: {
                totalCount: visible ? 1 : 0,
                edges: visible ? [{ cursor: fixtureId, node }] : [],
                pageInfo: {
                  startCursor: visible ? fixtureId : null,
                  endCursor: visible ? fixtureId : null,
                  hasNextPage: false,
                  hasPreviousPage: false,
                },
              },
            },
          },
        },
      });
    });

    await page.goto(`${FRONTEND}/workspace/${workspaceId}/home`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page);
    await expect(
      page.locator('[data-myoxus-ui-role="workspace-home-grid"]'),
    ).toBeVisible();

    await expect(
      page
        .locator('[data-myoxus-ui-role="workspace-home-grid"]')
        .getByText("DNOT desktop flow target", { exact: true }),
    ).toBeVisible();

    await page.getByTestId("slider-bar-quick-search-button").click();
    const commandInput = page.locator(
      '[data-myoxus-ui-role="command-palette-input"]',
    );
    await expect(commandInput).toBeFocused();
    await commandInput.fill("New page");
    await expect(
      page.getByText("New page", { exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(commandInput).toBeHidden();

    await page.getByTestId("notification-button").click();
    await page
      .locator('[role="menu"]:visible')
      .getByRole("button", { name: "Open inbox", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/workspace/${workspaceId}/inbox\\?read=unread&type=all$`),
    );
    await expect(
      page.getByText("Notifications", { exact: true }).first(),
    ).toBeVisible();

    const typeFilter = page.getByRole("combobox", {
      name: "Notification type",
      exact: true,
    });
    await typeFilter.click();
    await page
      .getByRole("option", { name: "Document changes", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/inbox\\?read=unread&type=document-changes$`),
    );
    await expect(
      page.getByText("DNOT desktop flow target", { exact: true }),
    ).toBeVisible();
    // Navigation updates the URL before the selected feed finishes refreshing.
    await expect(typeFilter).toHaveValue("Document changes");
    await expect
      .poll(() => filters.at(-1))
      .toEqual({
        types: ["DocumentChanged"],
        includeRead: false,
      });
    const row = page.getByRole("button", {
      name: /Flow actor.*DNOT desktop flow target/,
    });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/workspace/${workspaceId}/${target}(?:\\?|$)`),
    );
    await expect.poll(() => readIds).toEqual([fixtureId]);
    await page.goto(
      `${FRONTEND}/workspace/${workspaceId}/inbox?read=unread&type=document-changes`,
    );
    await waitForWorkspaceReady(page);
    await expect(
      page.getByText("No new notifications", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("DNOT desktop flow target", { exact: true }),
    ).toHaveCount(0);
    await page.getByText("History", { exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/inbox\\?read=all&type=document-changes$`),
    );
    await expect(
      page.getByText("DNOT desktop flow target", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(
      page.getByText("DNOT desktop flow target", { exact: true }),
    ).toBeVisible();
    await expect(typeFilter).toHaveValue("Document changes");
    await expect
      .poll(() => filters.at(-1))
      .toEqual({
        types: ["DocumentChanged"],
        includeRead: true,
      });
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/home`, {
      waitUntil: "load",
    });

    await waitForWorkspaceReady(page);
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}/home$`));
    await expect(
      page.locator('[data-myoxus-ui-role="workspace-home-grid"]'),
    ).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  // This journey extends the existing Home owner rather than introducing a
  // second dashboard harness. Every Project and Row below is fixture-owned.
  test("Home previews canonical Tasks and receives collaborator changes without losing its navigation context", async ({
    page,
    context,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const ownCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectSessionCookies(context, ownCookies);
    const gql = <T>(query: string, variables: Record<string, unknown> = {}) =>
      smokeGql<T>(request, GQL, ownCookies, query, variables);
    const current = await gql<{
      currentUser: { id: string };
      workspaces: Array<{ id: string; initialized: boolean; name: string }>;
    }>("query{currentUser{id}workspaces{id initialized name}}");
    const seed = await readFile(
      "build/scripts/test/seed-test-users.sh",
      "utf8",
    );
    const credentials = seed.match(/#   Alice:\s+(\S+)\s+\/\s+(\S+)/);
    if (!credentials)
      throw new Error("Seed script lacks collaborator credentials");
    const collaboratorCookies = await signInViaApi(
      request,
      API,
      credentials[1]!,
      credentials[2]!,
    );
    const collaboratorGql = <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ) => smokeGql<T>(request, GQL, collaboratorCookies, query, variables);
    const collaborator = await collaboratorGql<{
      currentUser: { id: string };
      workspaces: Array<{ id: string; initialized: boolean }>;
    }>("query{currentUser{id}workspaces{id initialized}}");
    const collaboratorId = collaborator.currentUser.id;
    // Select an existing shared writable scope from both real inventories,
    // never invite the seed actor into the admin's private fixture workspace.
    let sharedWorkspaceId: string | undefined;
    for (const candidate of current.workspaces.filter(
      (candidate) =>
        candidate.initialized &&
        collaborator.workspaces.some(
          (other) => other.initialized && other.id === candidate.id,
        ),
    )) {
      const query =
        "query($w:String!){workspace(id:$w){permissions{Workspace_CreateDoc}members{id}}}";
      type Access = {
        workspace: {
          permissions: { Workspace_CreateDoc: boolean };
          members: Array<{ id: string }>;
        };
      };
      const [ownerAccess, collaboratorAccess] = await Promise.all([
        gql<Access>(query, { w: candidate.id }),
        collaboratorGql<Access>(query, { w: candidate.id }),
      ]);
      if (
        ownerAccess.workspace.permissions.Workspace_CreateDoc &&
        collaboratorAccess.workspace.permissions.Workspace_CreateDoc &&
        ownerAccess.workspace.members.some(
          (member) => member.id === collaboratorId,
        )
      ) {
        sharedWorkspaceId = candidate.id;
        break;
      }
    }
    if (!sharedWorkspaceId)
      throw new Error(
        "Home Task journey requires an existing workspace writable by both seeded actors; no memberships were changed",
      );

    const workspaceId = sharedWorkspaceId;
    const projects: Array<{
      database: { id: string };
      fieldRoles: Array<{ roleKey: string; fieldId: string }>;
    }> = [];
    const rows: Array<{
      id: string;
      title: string;
      databaseId: string;
      titleFieldId: string;
    }> = [];
    const getRole = (project: (typeof projects)[number], key: string) => {
      const field = project.fieldRoles.find((field) => field.roleKey === key);
      if (!field) throw new Error(`Missing native Task role ${key}`);
      return field.fieldId;
    };
    try {
      for (let index = 0; index < 2; index++) {
        const created = await gql<{ createProject: (typeof projects)[number] }>(
          `mutation($input:CreateProjectInput!){createProject(input:$input){database{id}fieldRoles{roleKey fieldId}}}`,
          {
            input: {
              workspaceId,
              title: `Home task flow ${index + 1} · Persisted cross-Project work ${Date.now()}`,
              structurePreset: "TasksOnly",
            },
          },
        );
        const project = created.createProject;
        projects.push(project);
        for (let item = 0; item < 3; item++) {
          const day = new Date();
          day.setUTCDate(day.getUTCDate() - 14 + item);
          day.setUTCHours(index ? 11 : 0, 0, 0, 0);
          const title = `Home Task ${index + 1}.${item + 1} · Review the international deployment and release-owner handoff`;
          const createdRow = await gql<{
            createDatabaseRow: { row: { id: string } };
          }>(
            `mutation($input:CreateDatabaseRowInput!){createDatabaseRow(input:$input){row{id}}}`,
            {
              input: {
                databaseId: project.database.id,
                title,
                cells: [
                  {
                    fieldId: getRole(project, "task.assignees"),
                    value: { users: [current.currentUser.id] },
                  },
                  {
                    fieldId: getRole(project, "task.dueDate"),
                    value: {
                      dateTime: {
                        start: day.toISOString(),
                        allDay: index === 0,
                        timeZone: "UTC",
                      },
                    },
                  },
                ],
              },
            },
          );
          rows.push({
            id: createdRow.createDatabaseRow.row.id,
            title,
            databaseId: project.database.id,
            titleFieldId: getRole(project, "task.title"),
          });
        }
      }
      const preferences = await gql<{
        currentUser: {
          preferences: {
            values: { workspaceDashboardLayouts: DashboardLayout[] | null };
          };
        };
      }>(
        "query{currentUser{preferences{values{workspaceDashboardLayouts{workspaceId orderedDashletIds dashletSizes{dashletId size}}}}}}",
      );
      // The existing describe restores its previous settings; this independent
      // journey also restores its own exact snapshot in its finally boundary.
      const beforeLayouts =
        preferences.currentUser.preferences.values.workspaceDashboardLayouts;
      try {
        await gql(
          `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{workspaceDashboardLayouts{workspaceId}}}}`,
          { input: { workspaceDashboardLayouts: null } },
        );
        await page.goto(
          `${FRONTEND}/workspace/${workspaceId}/home?taskFlow=context`,
        );
        await waitForWorkspaceReady(page);
        const section = page.locator(
          '[data-myoxus-ui-role="workspace-home-tasks"]',
        );
        const preview = section.locator(
          '[data-myoxus-ui-role="workspace-home-task-row"]',
        );
        const canonical = async () =>
          (
            await gql<{
              workspace: {
                databaseTasks: {
                  totalCount: number;
                  rows: Array<{ rowId: string }>;
                };
              };
            }>(
              `query($w:String!){workspace(id:$w){databaseTasks(input:{scope:Mine,lifecycle:Open,timeZone:"UTC"},first:6){totalCount rows{rowId}}}}`,
              { w: workspaceId },
            )
          ).workspace.databaseTasks;
        const inventory = await canonical();
        await expect(preview).toHaveCount(4);
        await expect(
          section.getByText(`${inventory.totalCount} tasks`, { exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            preview.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute("data-task-id")),
            ),
          )
          .toEqual(inventory.rows.slice(0, 4).map((row) => row.rowId));
        const target = rows.find((row) =>
          inventory.rows.slice(0, 4).some((item) => item.rowId === row.id),
        );
        expect(
          target,
          "owned overdue fixture must participate in the real preview",
        ).toBeDefined();
        const before = await gql<{
          workspace: {
            databaseRow: { row: { id: string; editRevision: number } };
          };
        }>(
          `query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id editRevision}}}}`,
          { w: workspaceId, d: target!.databaseId, r: target!.id },
        );
        expect(before.workspace.databaseRow.row.id).toBe(target!.id);
        const revision = before.workspace.databaseRow.row.editRevision;
        const collaboratorTitle = `${target!.title} · collaborator confirmed`;
        await expect(
          section.getByText("Live updates unavailable", { exact: true }),
        ).toHaveCount(0);
        await collaboratorGql(
          `mutation($input:UpdateDatabaseRowTitleInput!){updateDatabaseRowTitle(input:$input){editRevision}}`,
          {
            input: {
              databaseId: target!.databaseId,
              rowId: target!.id,
              titleFieldId: target!.titleFieldId,
              expectedEditRevision: revision,
              title: collaboratorTitle,
            },
          },
        );
        await expect(
          section.locator(`[data-task-id="${target!.id}"]`),
        ).toContainText(collaboratorTitle);
        await section
          .getByRole("button", { name: "Open tasks", exact: true })
          .click();
        await expect(
          page.getByRole("radio", { name: "My tasks", exact: true }),
        ).toBeChecked();
        await expect(
          page.getByRole("combobox", { name: "Task lifecycle", exact: true }),
        ).toHaveValue("Open work");
        await page.goBack();
        await expect(section).toBeVisible();
        await section
          .getByRole("button", { name: "New task", exact: true })
          .click();
        const modal = page.getByTestId("task-creation-modal");
        await modal
          .getByRole("button", { name: "Destination", exact: true })
          .click();
        await expect(modal.getByTestId("task-destination-select")).toHaveValue(
          "Workspace Tasks",
        );
        await modal
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(page).toHaveURL(/\/home\?taskFlow=context$/);
        await expect(
          section.getByRole("button", { name: "New task", exact: true }),
        ).toBeFocused();
        const selected = section.locator(`[data-task-id="${target!.id}"]`);
        await selected.focus();
        await selected.press("Enter");
        const detail = page.getByTestId("context-surface-task-details");
        await expect(
          detail.getByText(collaboratorTitle, { exact: true }),
        ).toBeVisible();
        const params = new URL(page.url()).searchParams;
        expect(params.get("rowId")).toBe(target!.id);
        expect(params.get("databaseId")).toBe(target!.databaseId);
        await page.goBack();
        await expect(section).toBeVisible();
        await page.getByRole("button", { name: /Customi[sz]e/ }).click();
        await section
          .getByRole("button", { name: "Size", exact: true })
          .click();
        await expect(
          page.getByRole("menuitem", { name: "Compact", exact: true }),
        ).toBeDisabled();
        await page
          .getByRole("menuitem", { name: "Full width", exact: true })
          .click();
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await expect(preview).toHaveCount(6);
        await expect
          .poll(() =>
            preview.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute("data-task-id")),
            ),
          )
          .toEqual((await canonical()).rows.map((row) => row.rowId));
        for (const role of [
          "workspace-home-today",
          "workspace-home-new-documents",
          "workspace-home-reminders",
          "workspace-home-recent-documents",
          "workspace-home-activity",
        ])
          await expect(
            page.locator(`[data-myoxus-ui-role="${role}"]`),
          ).toHaveCount(1);
        const homeCapture = test
          .info()
          .outputPath("home-collaborator-wide.png");
        await page.screenshot({ path: homeCapture, fullPage: true });
        await test.info().attach("home-collaborator-wide", {
          path: homeCapture,
          contentType: "image/png",
        });
        await test.info().attach("home-collaborator-report", {
          body: JSON.stringify({
            workspaceId,
            projectIds: projects.map((project) => project.database.id),
            rowId: target!.id,
            url: page.url(),
            count: inventory.totalCount,
            errors,
          }),
          contentType: "application/json",
        });
        expect(errors).toEqual([]);
      } finally {
        try {
          await page.goto("about:blank");
        } finally {
          await gql(
            `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{workspaceDashboardLayouts{workspaceId}}}}`,
            { input: { workspaceDashboardLayouts: beforeLayouts } },
          );
        }
      }
    } finally {
      const cleanupErrors: unknown[] = [];
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
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Home Task fixture cleanup failed",
        );
    }
  });

  test("a Task read failure stays local while Journal and other Home sections remain usable", async ({
    page,
    context,
    request,
  }) => {
    const ownCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectSessionCookies(context, ownCookies);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, ownCookies);
    const failure = async (route: import("@playwright/test").Route) => {
      const query = route.request().postDataJSON()?.query ?? "";
      if (/query databaseTasks\(/.test(query))
        await route.fulfill({
          json: {
            errors: [
              {
                message: "Task read unavailable",
                extensions: { code: "MIX_DATABASE_TASKS_UNAVAILABLE" },
              },
            ],
          },
        });
      else await route.continue();
    };
    await page.route("**/graphql", failure);
    try {
      await page.goto(`${FRONTEND}/workspace/${workspaceId}/home`);
      await waitForWorkspaceReady(page);
      const section = page.locator(
        '[data-myoxus-ui-role="workspace-home-tasks"]',
      );
      await expect(
        section.getByText("Tasks could not be loaded", { exact: true }),
      ).toBeVisible();
      await expect(
        section.locator('[data-myoxus-ui-role="workspace-home-task-row"]'),
      ).toHaveCount(0);
      await expect(section.getByText(/^[0-9]+ tasks?$/)).toHaveCount(0);
      await expect(
        page.getByText(/MIX_DATABASE_TASKS_UNAVAILABLE/),
      ).toHaveCount(0);
      const errorCapture = test.info().outputPath("home-isolated-error.png");
      await page.screenshot({ path: errorCapture, fullPage: true });
      await test.info().attach("home-isolated-error", {
        path: errorCapture,
        contentType: "image/png",
      });
      const today = page.locator(
        '[data-myoxus-ui-role="workspace-home-today"]',
      );
      const journal = today.getByRole("button", { name: /Today's journal/ });
      await expect(journal).toBeEnabled();
      await journal.focus();
      await expect(journal).toBeFocused();
      await page
        .locator('[data-myoxus-ui-role="workspace-home-new-documents"]')
        .getByRole("button", { name: "All content", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/workspace/${workspaceId}/all$`),
      );
      await page.goBack();
      await expect(
        section.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await page.unroute("**/graphql", failure);
      await section.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(
        section.getByText("Tasks could not be loaded", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await page.unroute("**/graphql", failure);
    }
  });
});
