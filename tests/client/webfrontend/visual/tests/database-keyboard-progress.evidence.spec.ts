// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  type AuthenticatedPreferenceTarget,
  getAccountColorMode,
  setAccountColorMode,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId, smokeGql } from "../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${API}/graphql`;
const evidenceKey = (
  process.env.MYOXUS_DATABASE_KANBAN_EVIDENCE_KEY ?? "current"
).replaceAll(/[^a-zA-Z0-9._-]/g, "-");
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "output/playwright/pdb31-database-keyboard",
  evidenceKey,
);

type DatabaseRowFixture = {
  row: {
    editRevision: number;
    id: string;
    position: number;
    title: string;
  };
  cells: Array<{
    fieldId: string;
    value: {
      date?: { end?: string | null; start: string } | null;
      dateTime?: {
        allDay: boolean;
        end?: string | null;
        start: string;
        timeZone?: string | null;
      } | null;
      select?: string | null;
      text?: string | null;
    };
  }>;
};

type DatabaseFixture = {
  workspace: {
    database: {
      database: { id: string; title: string };
      views: Array<{
        id: string;
        name: string;
        position: number;
        viewKind: string;
      }>;
    } | null;
    databaseRows: {
      rows: DatabaseRowFixture[];
    };
  } | null;
};

type DatabaseRowsReadback = {
  workspace: {
    databaseRows: {
      rows: DatabaseRowFixture[];
    };
  } | null;
};

async function readLocalSeedReadonlyAccount(): Promise<{
  email: string;
  password: string;
}> {
  const email = process.env.E2E_DATABASE_READONLY_EMAIL;
  const password = process.env.E2E_DATABASE_READONLY_PASSWORD;
  if (email && password) return { email, password };
  if (email || password) {
    throw new Error(
      "E2E_DATABASE_READONLY_EMAIL and E2E_DATABASE_READONLY_PASSWORD must be set together",
    );
  }
  const seedSource = await readFile(
    path.join(process.cwd(), "build/scripts/test/seed-test-users.sh"),
    "utf8",
  );
  const match = seedSource.match(/^#\s+Bobby:\s+(\S+)\s+\/\s+(\S+)\s*$/m);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      "Readonly Database evidence requires the Bobby account provisioned by build/scripts/test/seed-test-users.sh",
    );
  }
  return { email: match[1], password: match[2] };
}

async function readDatabaseRows(
  request: Parameters<typeof smokeGql>[0],
  cookies: string[],
  workspaceId: string,
  databaseId: string,
): Promise<DatabaseRowFixture[]> {
  const readback = await smokeGql<DatabaseRowsReadback>(
    request,
    GQL,
    cookies,
    `query DatabaseKanbanReadback($workspaceId: String!, $databaseId: ID!) {
      workspace(id: $workspaceId) {
        databaseRows(databaseId: $databaseId, first: 100) {
          rows {
            row { id title position editRevision }
            cells { fieldId value { date { start end } dateTime { start end allDay timeZone } select text } }
          }
        }
      }
    }`,
    { databaseId, workspaceId },
  );
  if (!readback.workspace)
    throw new Error("Database readback workspace missing");
  return readback.workspace.databaseRows.rows;
}

function collectBrowserErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return () => errors;
}

async function pressAndExpectGraphqlMutationSuccess(
  page: Page,
  key: string,
  operation: string,
) {
  return runAndExpectGraphqlMutationSuccess(page, operation, () =>
    page.keyboard.press(key),
  );
}

async function runAndExpectGraphqlMutationSuccess(
  page: Page,
  operation: string,
  action: () => Promise<unknown>,
) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (
      new URL(response.url()).pathname !== "/graphql" ||
      request.method() !== "POST"
    ) {
      return false;
    }
    return request.headers()["x-operation-name"] === operation;
  });
  await action();
  const response = await responsePromise;
  expect(response.status(), `${operation} must return GraphQL HTTP 200`).toBe(
    200,
  );
  const payload = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: unknown;
  };
  expect(payload.errors).toBeUndefined();
  return {
    payload,
    variables: response.request().postDataJSON().variables as Record<
      string,
      unknown
    >,
  };
}

async function pointerDrag(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Kanban pointer target is not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
}

async function activateDatabaseView(page: Page, viewId: string) {
  const tab = page.getByTestId(`database-view-tab-${viewId}`);
  if (await tab.isVisible()) {
    await tab.focus();
    await page.keyboard.press("Enter");
    return;
  }
  const more = page.locator(
    '[data-myoxus-ui-role="overflow-tabs-more-trigger"]',
  );
  await expect(more).toBeVisible();
  if ((await more.getAttribute("aria-expanded")) !== "true") {
    await more.focus();
    await page.keyboard.press("Enter");
  }
  const item = page.getByTestId(`overflow-tab-item-${viewId}`);
  await expect(item).toBeVisible();
  await item.focus();
  await page.keyboard.press("Enter");
}

function seededUuid(seed: string): string {
  // Mirrors the seed script's non-cryptographic stable fixture identifier.
  const hash = createHash("md5").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function installSessionCookies(
  page: Page,
  rawCookies: string[],
): Promise<void> {
  await page.context().addCookies(
    rawCookies.map((rawCookie) => {
      const [nameValue] = rawCookie.split(";");
      const [name, ...value] = nameValue.split("=");
      return {
        name: name.trim(),
        value: value.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      };
    }),
  );
}

async function setTheme(
  page: Page,
  target: AuthenticatedPreferenceTarget,
  theme: "light" | "dark" | "system",
): Promise<void> {
  await setAccountColorMode(target, theme);
  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("database-detail")).toBeVisible();
}

let apiSessionCookies: string[] | undefined;
let originalColorMode: "dark" | "light" | "system" | null | undefined;
let readonlySessionCookies: string[] | undefined;
let readonlyOriginalColorMode: "dark" | "light" | "system" | null | undefined;
let readonlyMembershipCleanup:
  { userId: string; workspaceId: string } | undefined;
let temporalCleanup:
  | {
      databaseId: string;
      dependency?: { fieldId: string; rowId: string };
      kanbanRowId?: string;
      rowId?: string;
    }
  | undefined;

test.afterAll(async ({ request }) => {
  if (apiSessionCookies && temporalCleanup?.kanbanRowId) {
    await smokeGql(
      request,
      GQL,
      apiSessionCookies,
      `mutation DeleteKanbanEvidenceRow($input: DeleteDatabaseRowInput!) {
        deleteDatabaseRow(input: $input)
      }`,
      {
        input: {
          databaseId: temporalCleanup.databaseId,
          force: true,
          rowId: temporalCleanup.kanbanRowId,
        },
      },
    );
  }
  if (apiSessionCookies && temporalCleanup?.dependency) {
    await smokeGql(
      request,
      GQL,
      apiSessionCookies,
      `mutation ClearTemporalDependency($input: ClearDatabaseCellValueInput!) {
        clearDatabaseCellValue(input: $input) { rowId fieldId hasValue }
      }`,
      {
        input: {
          databaseId: temporalCleanup.databaseId,
          fieldId: temporalCleanup.dependency.fieldId,
          force: true,
          rowId: temporalCleanup.dependency.rowId,
        },
      },
    );
  }
  if (apiSessionCookies && temporalCleanup?.rowId) {
    await smokeGql(
      request,
      GQL,
      apiSessionCookies,
      `mutation DeleteTemporalEvidenceRow($input: DeleteDatabaseRowInput!) {
        deleteDatabaseRow(input: $input)
      }`,
      {
        input: {
          databaseId: temporalCleanup.databaseId,
          force: true,
          rowId: temporalCleanup.rowId,
        },
      },
    );
  }
  if (apiSessionCookies && originalColorMode !== undefined) {
    await setAccountColorMode(
      { request, gqlEndpoint: GQL, cookies: apiSessionCookies },
      originalColorMode,
    );
  }
  if (readonlySessionCookies && readonlyOriginalColorMode !== undefined) {
    await setAccountColorMode(
      {
        request,
        gqlEndpoint: GQL,
        cookies: readonlySessionCookies,
      },
      readonlyOriginalColorMode,
    );
  }
  if (apiSessionCookies && readonlyMembershipCleanup) {
    await smokeGql(
      request,
      GQL,
      apiSessionCookies,
      `mutation RemoveDatabaseReadonlyMember($workspaceId: ID!, $userId: ID!) {
        admin {
          adminRemoveWorkspaceMember(
            workspaceId: $workspaceId
            userId: $userId
          )
        }
      }`,
      readonlyMembershipCleanup,
    );
  }
  await signOutViaApi(request, API, readonlySessionCookies);
  await signOutViaApi(request, API, apiSessionCookies);
});

test("P-DB-31 database keyboard and Progress evidence", async ({
  browser,
  page,
  request,
}) => {
  test.slow();
  const browserErrors = collectBrowserErrors(page);
  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  apiSessionCookies = cookies;
  const preferenceTarget = { request, gqlEndpoint: GQL, cookies };
  originalColorMode = await getAccountColorMode(preferenceTarget);
  await installSessionCookies(page, cookies);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const seededDatabaseId = seededUuid(
    `${workspaceId}:database-qa-board:database`,
  );
  const fixture = await smokeGql<DatabaseFixture>(
    request,
    GQL,
    cookies,
    `query DatabaseKeyboardFixture($workspaceId: String!, $databaseId: ID!) {
      workspace(id: $workspaceId) {
        database(databaseId: $databaseId) {
          database { id title }
          views { id name position viewKind }
        }
        databaseRows(databaseId: $databaseId, first: 100) {
          rows {
            row { id title position editRevision }
            cells {
              fieldId
              value {
                date { start end }
                dateTime { start end allDay timeZone }
                select
                text
              }
            }
          }
        }
      }
    }`,
    { databaseId: seededDatabaseId, workspaceId },
  );
  const database = fixture.workspace?.database;
  if (!database) throw new Error("Database QA Board seed is missing");
  expect(database.database).toEqual({
    id: seededDatabaseId,
    title: "Database QA Board",
  });
  temporalCleanup = { databaseId: database.database.id };
  const tableView = database.views.find((view) => view.viewKind === "Table");
  const progressView = database.views.find(
    (view) => view.viewKind === "Progress",
  );
  const kanbanView = database.views.find((view) => view.viewKind === "Kanban");
  const listView = database.views.find((view) => view.viewKind === "List");
  const galleryView = database.views.find(
    (view) => view.viewKind === "Gallery",
  );
  const calendarView = database.views.find(
    (view) => view.viewKind === "Calendar",
  );
  const timelineView = database.views.find(
    (view) => view.viewKind === "Timeline",
  );
  const ganttView = database.views.find((view) => view.viewKind === "Gantt");
  if (
    !tableView ||
    !progressView ||
    !kanbanView ||
    !listView ||
    !galleryView ||
    !calendarView ||
    !timelineView ||
    !ganttView
  ) {
    throw new Error(
      "Database QA Board must expose every supported Database view",
    );
  }
  for (const databaseView of database.views) {
    await smokeGql(
      request,
      GQL,
      cookies,
      `mutation ResetDatabaseEvidenceViewState(
        $input: ResetDatabaseViewUserStateInput!
      ) {
        resetDatabaseViewUserState(input: $input)
      }`,
      {
        input: {
          databaseId: database.database.id,
          viewId: databaseView.id,
        },
      },
    );
  }

  await mkdir(EVIDENCE_DIR, { recursive: true });
  const tableUrl = `${FRONTEND}/workspace/${workspaceId}/databases/${database.database.id}?viewId=${tableView.id}`;
  await page.goto(tableUrl, { waitUntil: "load" });
  await expect(page.getByTestId("database-detail")).toBeVisible();

  const search = page.getByTestId("database-table-search");
  await search.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("Polish table UX");
  await expect(search).toHaveValue("Polish table UX");
  await expect(
    page
      .getByTestId("database-table-grid")
      .getByText("Polish table UX", { exact: true }),
  ).toBeVisible();
  const clearSearch = page.getByRole("button", { name: "Clear search" });
  await clearSearch.click();
  await expect(search).toHaveValue("");

  const fieldMenu = page
    .getByTestId("database-table-field-menu-trigger")
    .nth(1);
  await fieldMenu.focus();
  await page.keyboard.press("Enter");
  const descending = page.getByRole("menuitem", { name: "Descending" });
  await descending.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByTestId("database-table-grid")
      .getByText("Timeline smoke", { exact: true }),
  ).toBeVisible();

  const settingsTrigger = page.getByTestId("database-context-settings-trigger");
  await settingsTrigger.focus();
  await page.keyboard.press("Enter");
  const settings = page.getByTestId("database-workbench-context");
  await expect(settings).toBeVisible();
  await expect(
    settings.locator('[data-myoxus-ui-role="database-visible-field-list"]'),
  ).toBeVisible();

  const firstRowSelection = page
    .getByTestId("database-table-select-row")
    .first();
  await firstRowSelection.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByTestId("database-bulk-selection-toolbar"),
  ).toBeVisible();
  await page.keyboard.press("Space");

  const databaseActions = page.getByTestId(
    "database-detail-header-menu-trigger",
  );
  await databaseActions.focus();
  await page.keyboard.press("Enter");
  const exportItem = page.getByTestId("database-export-csv-menu-item");
  await exportItem.focus();
  await page.keyboard.press("Enter");
  const exportModal = page.getByTestId("database-export-modal");
  await expect(exportModal).toBeVisible();
  await expect(
    exportModal.getByRole("combobox", { name: "Format" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exportModal).toBeHidden();
  await expect(databaseActions).toBeFocused();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "table-desktop-light.png"),
    fullPage: true,
  });

  const kanbanTab = page.getByTestId(`database-view-tab-${kanbanView.id}`);
  await kanbanTab.focus();
  await page.keyboard.press("Enter");
  const activeKanban = page.locator(
    '[data-testid="database-kanban-view"]:visible',
  );
  await expect(activeKanban).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "kanban-desktop-light.png"),
    fullPage: true,
  });
  const kanbanColumns = activeKanban.getByTestId(
    "database-kanban-column-frame",
  );
  const columnCount = await kanbanColumns.count();
  let sourceColumnIndex = -1;
  for (let index = 0; index < columnCount - 1; index += 1) {
    if (
      (await kanbanColumns
        .nth(index)
        .getByTestId("database-kanban-card")
        .count()) > 0
    ) {
      sourceColumnIndex = index;
      break;
    }
  }
  if (sourceColumnIndex < 0) {
    throw new Error("Kanban seed needs a card outside the final column");
  }
  const sourceColumn = kanbanColumns.nth(sourceColumnIndex);
  const targetColumn = kanbanColumns.nth(sourceColumnIndex + 1);
  const sourceCards = sourceColumn.getByTestId("database-kanban-card");
  const targetCards = targetColumn.getByTestId("database-kanban-card");

  const addTask = sourceColumn.getByRole("button", { name: /Add task/ });
  const creation = await runAndExpectGraphqlMutationSuccess(
    page,
    "createDatabaseRow",
    () => addTask.click(),
  );
  const createdRow = (
    creation.payload.data?.createDatabaseRow as
      { row?: { id?: string } } | undefined
  )?.row;
  if (!createdRow?.id) {
    throw new Error("Kanban task creation did not return a row id");
  }
  temporalCleanup.kanbanRowId = createdRow.id;
  const createdCard = activeKanban.locator(
    `:is([data-row-id="${createdRow.id}"], [data-card-id="${createdRow.id}"]):visible`,
  );
  await expect(createdCard).toBeVisible();
  const createdTitleDisplay = createdCard
    .locator('[data-myoxus-ui-role="inline-edit-display"]')
    .first();
  await expect(createdTitleDisplay).toBeFocused();
  await page.keyboard.press("F2");
  const titleInput = createdCard.getByRole("textbox", { name: "Title" });
  await expect(titleInput).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("Phase 07 parity task");
  await runAndExpectGraphqlMutationSuccess(page, "updateDatabaseRowTitle", () =>
    page.keyboard.press("Enter"),
  );
  await expect(createdCard).toContainText("Phase 07 parity task");

  const createdReadback = (
    await readDatabaseRows(request, cookies, workspaceId, database.database.id)
  ).find((row) => row.row.id === createdRow.id);
  expect(createdReadback?.row.title).toBe("Phase 07 parity task");
  await smokeGql(
    request,
    GQL,
    cookies,
    `mutation DeleteKanbanEvidenceRow($input: DeleteDatabaseRowInput!) {
      deleteDatabaseRow(input: $input)
    }`,
    {
      input: {
        databaseId: database.database.id,
        force: true,
        rowId: createdRow.id,
      },
    },
  );
  temporalCleanup.kanbanRowId = undefined;
  await page.reload({ waitUntil: "load" });
  await expect(activeKanban).toBeVisible();
  await expect(createdCard).toHaveCount(0);

  const columnMenu = sourceColumn.getByTestId("database-kanban-column-menu");
  await columnMenu.focus();
  await page.keyboard.press("Enter");
  const groupingItem = page.getByRole("menuitem", { name: "Grouping" });
  await groupingItem.focus();
  await page.keyboard.press("Enter");
  const groupFieldDialog = page.getByRole("dialog", {
    name: "Field settings: Status",
  });
  await expect(groupFieldDialog).toBeVisible();
  await expect(
    groupFieldDialog.getByRole("textbox", { name: "Options" }),
  ).toHaveValue("To do\nIn progress\nDone");
  await groupFieldDialog.getByRole("button", { name: "Close" }).click();
  await expect(groupFieldDialog).toBeHidden();
  await expect(columnMenu).toBeFocused();

  const sourceCount = await sourceCards.count();
  const targetCount = await targetCards.count();
  const sourceCard = sourceCards.first();
  const sourceRowId =
    (await sourceCard.getAttribute("data-row-id")) ??
    (await sourceCard.getAttribute("data-card-id"));
  if (!sourceRowId) throw new Error("Kanban card is missing its row identity");
  const originalNotes = fixture.workspace?.databaseRows.rows
    .find((row) => row.row.id === sourceRowId)
    ?.cells.find((cell) => cell.value.text)?.value.text;
  if (!originalNotes) throw new Error("Kanban seed card is missing Notes");
  const sourceCardLabel = await sourceCard.getAttribute("aria-label");
  if (!sourceCardLabel?.endsWith(": Open details")) {
    throw new Error("Kanban card is missing its semantic detail label");
  }
  const movedTitle = sourceCardLabel.slice(0, -": Open details".length);
  const sourceDragHandle = sourceCard.getByRole("button", { name: "Drag row" });
  const pointerMove = await runAndExpectGraphqlMutationSuccess(
    page,
    "updateDatabaseRowPosition",
    () => pointerDrag(page, sourceDragHandle, targetCards.first()),
  );
  await expect(sourceCards).toHaveCount(sourceCount - 1);
  await expect(targetCards).toHaveCount(targetCount + 1);
  const movedCard = targetCards.filter({ hasText: movedTitle });
  await expect(movedCard).toHaveCount(1);
  const movedDragHandle = movedCard.getByRole("button", { name: "Drag row" });
  await movedDragHandle.focus();
  const keyboardMove = await pressAndExpectGraphqlMutationSuccess(
    page,
    "ArrowLeft",
    "updateDatabaseRowPosition",
  );
  expect(keyboardMove.variables.input).toMatchObject({
    rowId: (pointerMove.variables.input as { rowId: string }).rowId,
  });
  await expect(sourceCards).toHaveCount(sourceCount);
  await expect(targetCards).toHaveCount(targetCount);
  await expect(sourceCards.filter({ hasText: movedTitle })).toHaveCount(1);
  await expect(targetCards.filter({ hasText: movedTitle })).toHaveCount(0);

  const movedRowId = (keyboardMove.variables.input as { rowId: string }).rowId;
  const movedReadback = (
    await readDatabaseRows(request, cookies, workspaceId, database.database.id)
  ).find((row) => row.row.id === movedRowId);
  expect(movedReadback?.row.title).toBe(movedTitle);
  expect(Number.isInteger(movedReadback?.row.position)).toBe(true);
  await page.reload({ waitUntil: "load" });
  await expect(activeKanban).toBeVisible();
  await expect(sourceCards.filter({ hasText: movedTitle })).toHaveCount(1);
  await expect(targetCards.filter({ hasText: movedTitle })).toHaveCount(0);

  const detailTrigger = activeKanban.getByLabel(`${movedTitle}: Open details`, {
    exact: true,
  });
  await detailTrigger.click();
  const sidePeek = page.getByRole("dialog", { name: "Row details" });
  await expect(sidePeek).toBeVisible();
  const detailsAccordion = sidePeek.getByRole("button", {
    name: "Details",
    exact: true,
  });
  await detailsAccordion.click();
  const notesDisplay = sidePeek.getByRole("button", {
    name: "Notes",
    exact: true,
  });
  await notesDisplay.dblclick();
  const notesInput = sidePeek.getByRole("textbox", { name: "Notes" });
  await expect(notesInput).toBeFocused();
  await notesInput.fill("Server-backed Kanban parity evidence");
  await runAndExpectGraphqlMutationSuccess(
    page,
    "updateDatabaseCellValue",
    () => notesInput.press("Enter"),
  );
  const notesReadback = (
    await readDatabaseRows(request, cookies, workspaceId, database.database.id)
  ).find((row) => row.row.id === movedRowId);
  expect(
    notesReadback?.cells.some(
      (cell) => cell.value.text === "Server-backed Kanban parity evidence",
    ),
  ).toBe(true);
  await sidePeek.getByRole("button", { name: "Notes", exact: true }).dblclick();
  const restoreNotesInput = sidePeek.getByRole("textbox", { name: "Notes" });
  await restoreNotesInput.fill(originalNotes);
  await runAndExpectGraphqlMutationSuccess(
    page,
    "updateDatabaseCellValue",
    () => restoreNotesInput.press("Enter"),
  );
  await expect(
    sidePeek.getByText(originalNotes, { exact: true }),
  ).toBeVisible();
  await detailsAccordion.click();
  await sidePeek.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "kanban-side-peek-desktop-light.png"),
    fullPage: true,
  });
  await sidePeek.getByRole("button", { name: "Close" }).click();
  await expect(sidePeek).toBeHidden();
  await expect(detailTrigger).toBeFocused();

  for (const sibling of [
    {
      view: listView,
      testId: "database-list-view",
      screenshot: "list-desktop-light.png",
    },
    {
      view: galleryView,
      testId: "database-gallery-view",
      screenshot: "gallery-desktop-light.png",
    },
    {
      view: calendarView,
      testId: "database-calendar-view",
      screenshot: "calendar-desktop-light.png",
    },
    {
      view: timelineView,
      testId: "database-timeline-view",
      screenshot: "timeline-desktop-light.png",
    },
    {
      view: ganttView,
      testId: "database-gantt-view",
      screenshot: "gantt-desktop-light.png",
    },
  ]) {
    await activateDatabaseView(page, sibling.view.id);
    const siblingSurface = page.getByTestId(sibling.testId);
    await expect(siblingSurface).toBeVisible();
    if (sibling.view.id === listView.id) {
      await expect(
        siblingSurface.getByText("Priority", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        siblingSurface.getByText(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        ),
      ).toHaveCount(0);
    }
    if (sibling.view.id === timelineView.id) {
      const dateInput = siblingSurface.getByRole("textbox", { name: "Date" });
      await dateInput.fill("07/15/2026");
      await dateInput.press("Enter");
      await expect(
        siblingSurface.locator('[data-myoxus-ui-role="temporal-axis"]'),
      ).toHaveAttribute("data-zoom", "month");
      await expect(
        siblingSurface.locator('[data-myoxus-ui-role="temporal-item"]').first(),
      ).toBeVisible();
      await dateInput.press("Escape");
      await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
    }
    if (sibling.view.id === ganttView.id) {
      const items = siblingSurface.locator(
        '[data-myoxus-ui-role="temporal-item"]',
      );
      const originalItemCount = await items.count();
      expect(originalItemCount).toBeGreaterThan(1);
      const firstItem = items.first();
      await expect(firstItem).toBeVisible();
      const firstItemTitle = (await firstItem.textContent())?.trim();
      if (!firstItemTitle) {
        throw new Error("Temporal evidence item is missing its visible title");
      }

      const firstItemId = await firstItem.getAttribute("data-item-id");
      if (!firstItemId) {
        throw new Error("Temporal evidence item is missing its row identity");
      }
      const originalRow = fixture.workspace?.databaseRows.rows.find(
        (row) => row.row.id === firstItemId,
      );

      await firstItem.focus();
      await page.keyboard.press("Enter");
      const rowDetail = page.getByRole("dialog", { name: "Row details" });
      await expect(rowDetail).toBeVisible();
      await expect(
        rowDetail.getByText("Row details", { exact: true }),
      ).toBeVisible();
      await rowDetail.getByRole("button", { name: "Close" }).click();
      await expect(rowDetail).toBeHidden();

      await firstItem.focus();
      const move = await pressAndExpectGraphqlMutationSuccess(
        page,
        "ArrowRight",
        "updateDatabaseCellValue",
      );
      const temporalInput = move.variables.input as {
        fieldId: string;
        rowId: string;
      };
      const originalCell = originalRow?.cells.find(
        (cell) => cell.fieldId === temporalInput.fieldId,
      );
      const originalValue = originalCell?.value.dateTime
        ? { dateTime: originalCell.value.dateTime }
        : originalCell?.value.date
          ? { date: originalCell.value.date }
          : undefined;
      if (!originalValue) {
        throw new Error("Temporal evidence row has no original schedule value");
      }
      const dateInput = siblingSurface.getByRole("textbox", { name: "Date" });
      await dateInput.fill("07/20/2026");
      await dateInput.press("Enter");
      const movedItem = items.filter({ hasText: firstItemTitle });
      await expect(movedItem).toBeVisible();
      await movedItem.focus();
      await pressAndExpectGraphqlMutationSuccess(
        page,
        "Shift+ArrowRight",
        "updateDatabaseCellValue",
      );
      await smokeGql(
        request,
        GQL,
        cookies,
        `mutation RestoreTemporalEvidenceCell($input: UpdateDatabaseCellValueInput!) {
          updateDatabaseCellValue(input: $input) { rowId fieldId editRevision }
        }`,
        {
          input: {
            databaseId: database.database.id,
            fieldId: temporalInput.fieldId,
            force: true,
            rowId: temporalInput.rowId,
            value: originalValue,
          },
        },
      );
      await dateInput.fill("07/15/2026");
      await dateInput.press("Enter");

      await firstItem.click();
      const connect = siblingSurface.getByRole("button", { name: "Connect" });
      await expect(connect).toBeVisible();
      await connect.click();
      const connection = await runAndExpectGraphqlMutationSuccess(
        page,
        "updateDatabaseCellValue",
        () => items.nth(1).click(),
      );
      const connectionInput = connection.variables.input as {
        fieldId: string;
        rowId: string;
      };
      temporalCleanup.dependency = connectionInput;
      await smokeGql(
        request,
        GQL,
        cookies,
        `mutation ClearTemporalDependency($input: ClearDatabaseCellValueInput!) {
          clearDatabaseCellValue(input: $input) { rowId fieldId hasValue }
        }`,
        {
          input: {
            databaseId: database.database.id,
            fieldId: connectionInput.fieldId,
            force: true,
            rowId: connectionInput.rowId,
          },
        },
      );
      temporalCleanup.dependency = undefined;

      const lane = siblingSurface
        .locator('[data-myoxus-ui-role="temporal-lane"]')
        .first();
      await lane.focus();
      const creation = await pressAndExpectGraphqlMutationSuccess(
        page,
        "Enter",
        "createDatabaseRow",
      );
      const createdRow = (
        creation.payload.data?.createDatabaseRow as
          { row?: { id?: string } } | undefined
      )?.row;
      if (!createdRow?.id) {
        throw new Error("Temporal keyboard create did not return a row id");
      }
      temporalCleanup.rowId = createdRow.id;
      await expect(items).toHaveCount(originalItemCount + 1);
      await smokeGql(
        request,
        GQL,
        cookies,
        `mutation DeleteTemporalEvidenceRow($input: DeleteDatabaseRowInput!) {
          deleteDatabaseRow(input: $input)
        }`,
        {
          input: {
            databaseId: database.database.id,
            force: true,
            rowId: createdRow.id,
          },
        },
      );
      temporalCleanup.rowId = undefined;

      await page.reload({ waitUntil: "load" });
      const reloadedGantt = page.getByTestId("database-gantt-view");
      await expect(reloadedGantt).toBeVisible();
      const reloadedDateInput = reloadedGantt.getByRole("textbox", {
        name: "Date",
      });
      await reloadedDateInput.fill("07/15/2026");
      await reloadedDateInput.press("Enter");
      await expect(
        reloadedGantt.locator('[data-myoxus-ui-role="temporal-item"]'),
      ).toHaveCount(originalItemCount);
      await expect(
        reloadedGantt.locator(".myoxus-temporal-dependency"),
      ).toHaveCount(0);
      await reloadedDateInput.press("Escape");
      await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
    }
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, sibling.screenshot),
      fullPage: true,
    });
  }

  const ganttSurface = page.getByTestId("database-gantt-view");
  const ganttDateInput = () =>
    page.getByTestId("database-gantt-view").getByRole("textbox", {
      name: "Date",
    });
  await ganttDateInput().fill("07/15/2030");
  await ganttDateInput().press("Enter");
  await expect(
    ganttSurface.locator('[data-myoxus-ui-role="temporal-item"]'),
  ).toHaveCount(0);
  await ganttDateInput().press("Escape");
  await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "gantt-empty-desktop-light.png"),
    fullPage: true,
  });

  await setTheme(page, preferenceTarget, "dark");
  await ganttDateInput().fill("07/15/2026");
  await ganttDateInput().press("Enter");
  await expect(
    page
      .getByTestId("database-gantt-view")
      .locator('[data-myoxus-ui-role="temporal-item"]')
      .first(),
  ).toBeVisible();
  await ganttDateInput().press("Escape");
  await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "gantt-desktop-dark.png"),
    fullPage: true,
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await setTheme(page, preferenceTarget, "system");
  await ganttDateInput().fill("07/15/2026");
  await ganttDateInput().press("Enter");
  await ganttDateInput().press("Escape");
  await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "gantt-desktop-system.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 900, height: 720 });
  await setTheme(page, preferenceTarget, "light");
  const compactGantt = page.getByTestId("database-gantt-view");
  await expect(compactGantt).toBeVisible();
  await ganttDateInput().fill("07/15/2026");
  await ganttDateInput().press("Enter");
  await ganttDateInput().press("Escape");
  await expect(page.locator('[data-dates-dropdown="true"]')).toBeHidden();
  await expect(
    compactGantt.locator('[data-myoxus-ui-role="temporal-item"]').first(),
  ).toBeVisible();
  await expect(
    compactGantt.locator('[data-myoxus-ui-role="temporal-axis-scroll"]'),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "gantt-compact-light.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, preferenceTarget, "light");

  await activateDatabaseView(page, progressView.id);
  const progressSurface = page.getByTestId("database-progress-view");
  await expect(progressSurface).toBeVisible();
  const progressRow = page
    .getByTestId("database-progress-rows")
    .getByRole("button")
    .first();
  await progressRow.focus();
  await page.keyboard.press("Enter");
  await expect(progressRow).toHaveAttribute("aria-expanded", "true");

  const progressUrl = `${FRONTEND}/workspace/${workspaceId}/databases/${database.database.id}?viewId=${progressView.id}`;
  await page.goto(progressUrl, { waitUntil: "load" });
  const routedProgressSurface = page.getByTestId("database-progress-view");
  await expect(routedProgressSurface).toBeVisible();
  await expect(
    routedProgressSurface.getByText("Scope database editing", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "progress-desktop-light.png"),
    fullPage: true,
  });
  await setTheme(page, preferenceTarget, "dark");
  await expect(page.getByTestId("database-progress-view")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "progress-desktop-dark.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await setTheme(page, preferenceTarget, "system");
  await expect(page.getByTestId("database-progress-view")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "progress-desktop-system.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 720 });
  await setTheme(page, preferenceTarget, "light");
  await expect(page.getByTestId("database-progress-view")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "progress-compact-light.png"),
    fullPage: true,
  });

  await page.goto(`${FRONTEND}/workspace/${workspaceId}/databases`, {
    waitUntil: "load",
  });
  await expect(page.getByTestId("database-index")).toBeVisible();
  await page.getByTestId("database-csv-file-input").setInputFiles({
    name: "keyboard-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Title,Status\nKeyboard import,Todo\n", "utf8"),
  });
  const importModal = page.getByTestId("database-csv-import-modal");
  await expect(importModal).toBeVisible();
  await expect(
    importModal.getByRole("textbox", { name: "Database name" }),
  ).toBeVisible();
  await expect(
    importModal.getByRole("combobox", { name: "Delimiter" }),
  ).toBeVisible();
  await expect(
    importModal.getByRole("checkbox", { name: "Include Title" }),
  ).toBeVisible();
  const statusMapping = importModal.getByRole("textbox", {
    name: "Field: Status",
  });
  await expect(statusMapping).toBeVisible();
  await statusMapping.focus();
  await page.keyboard.press("Tab");
  await expect(
    importModal.getByRole("combobox", { name: "Type: Status" }),
  ).toBeFocused();
  const activeElementIsInsideImport = await importModal.evaluate((element) =>
    element.contains(document.activeElement),
  );
  expect(activeElementIsInsideImport).toBe(true);
  await page.keyboard.press("Tab");
  expect(
    await importModal.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(importModal).toBeHidden();

  const readonlyAccount = await readLocalSeedReadonlyAccount();
  readonlySessionCookies = await signInViaApi(
    request,
    API,
    readonlyAccount.email,
    readonlyAccount.password,
  );
  const readonlyPreferenceTarget = {
    request,
    gqlEndpoint: GQL,
    cookies: readonlySessionCookies,
  };
  readonlyOriginalColorMode = await getAccountColorMode(
    readonlyPreferenceTarget,
  );
  await setAccountColorMode(readonlyPreferenceTarget, "dark");
  const readonlyUserData = await smokeGql<{
    currentUser: { id: string; email: string } | null;
  }>(
    request,
    GQL,
    readonlySessionCookies,
    `query DatabaseReadonlyUser {
      currentUser { id email }
    }`,
  );
  if (!readonlyUserData.currentUser) {
    throw new Error("Readonly Database evidence user is missing");
  }
  const readonlyWorkspaceData = await smokeGql<{
    workspaces: Array<{
      id: string;
      initialized: boolean;
      name: string | null;
      role: string;
    }>;
  }>(
    request,
    GQL,
    cookies,
    `query DatabaseReadonlyAdminWorkspaces {
      workspaces { id initialized name role }
    }`,
  );
  const readonlyWorkspace = readonlyWorkspaceData.workspaces.find(
    (candidate) =>
      candidate.initialized &&
      candidate.name === "Alpha" &&
      ["Admin", "Owner"].includes(candidate.role),
  );
  if (!readonlyWorkspace) {
    throw new Error(
      "Readonly Database evidence requires the Alpha workspace from build/scripts/test/seed-test-users.sh",
    );
  }
  const readonlyMembership = await smokeGql<{
    admin: {
      addWorkspaceMember: { id: string; role: string; status: string };
    };
  }>(
    request,
    GQL,
    cookies,
    `mutation AddDatabaseReadonlyMember(
      $workspaceId: ID!
      $userId: ID!
      $role: String
    ) {
      admin {
        addWorkspaceMember(
          workspaceId: $workspaceId
          userId: $userId
          role: $role
        ) {
          id
          role
          status
        }
      }
    }`,
    {
      role: "Reader",
      userId: readonlyUserData.currentUser.id,
      workspaceId: readonlyWorkspace.id,
    },
  );
  readonlyMembershipCleanup = {
    userId: readonlyUserData.currentUser.id,
    workspaceId: readonlyWorkspace.id,
  };
  expect(readonlyMembership.admin.addWorkspaceMember.role).toBe("Reader");
  expect(readonlyMembership.admin.addWorkspaceMember.status).toBe("Accepted");
  const readonlyDatabaseId = seededUuid(
    `${readonlyWorkspace.id}:database-qa-board:database`,
  );
  const readonlyDatabaseData = await smokeGql<{
    workspace: {
      database: {
        database: { id: string };
        views: Array<{ id: string; viewKind: string }>;
      } | null;
    } | null;
  }>(
    request,
    GQL,
    readonlySessionCookies,
    `query DatabaseReadonlyFixture($workspaceId: String!, $databaseId: ID!) {
      workspace(id: $workspaceId) {
        database(databaseId: $databaseId) {
          database { id }
          views { id viewKind }
        }
      }
    }`,
    { databaseId: readonlyDatabaseId, workspaceId: readonlyWorkspace.id },
  );
  const readonlyDatabase = readonlyDatabaseData.workspace?.database;
  const readonlyKanbanView = readonlyDatabase?.views.find(
    (view) => view.viewKind === "Kanban",
  );
  if (!readonlyDatabase || !readonlyKanbanView) {
    throw new Error("Readonly Database QA Kanban fixture is missing");
  }
  const readonlyAccess = await smokeGql<{
    workspaces: Array<{ id: string; role: string }>;
    workspace: {
      databaseEffectiveViewState: { canEditShared: boolean };
    } | null;
  }>(
    request,
    GQL,
    readonlySessionCookies,
    `query DatabaseReadonlyAccess(
      $workspaceId: String!
      $databaseId: ID!
      $viewId: ID!
    ) {
      workspaces { id role }
      workspace(id: $workspaceId) {
        databaseEffectiveViewState(
          databaseId: $databaseId
          viewId: $viewId
        ) {
          canEditShared
        }
      }
    }`,
    {
      databaseId: readonlyDatabase.database.id,
      viewId: readonlyKanbanView.id,
      workspaceId: readonlyWorkspace.id,
    },
  );
  expect(
    readonlyAccess.workspaces.find(
      (candidate) => candidate.id === readonlyWorkspace.id,
    )?.role,
  ).toBe("Reader");
  expect(
    readonlyAccess.workspace?.databaseEffectiveViewState.canEditShared,
  ).toBe(false);
  const readonlyRowsBefore = await readDatabaseRows(
    request,
    readonlySessionCookies,
    readonlyWorkspace.id,
    readonlyDatabase.database.id,
  );
  const readonlyContext = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    viewport: { width: 390, height: 844 },
  });
  const readonlyPage = await readonlyContext.newPage();
  const readonlyBrowserErrors = collectBrowserErrors(readonlyPage);
  await installSessionCookies(readonlyPage, readonlySessionCookies);
  await readonlyPage.goto(
    `${FRONTEND}/workspace/${readonlyWorkspace.id}/databases/${readonlyDatabase.database.id}?viewId=${readonlyKanbanView.id}`,
    { waitUntil: "load" },
  );
  const readonlyRoot = readonlyPage.getByTestId("database-kanban-view-root");
  const readonlyKanban = readonlyPage.locator(
    '[data-testid="database-kanban-view"]:visible',
  );
  await expect(readonlyRoot).toBeVisible();
  await expect(
    readonlyPage.getByTestId("database-kanban-read-only-notice"),
  ).toBeVisible();
  const readonlyAdd = readonlyKanban
    .getByTestId("database-kanban-column-new")
    .first();
  await expect(readonlyAdd).toBeDisabled();
  const readonlyCard = readonlyKanban
    .getByTestId("database-kanban-card")
    .first();
  const readonlyTitle = readonlyCard
    .locator('[data-myoxus-ui-role="inline-edit-display"]')
    .first();
  await expect(readonlyTitle).toBeVisible();
  await expect(readonlyTitle).not.toHaveAttribute("role", "button");
  const readonlyDrag = readonlyCard.getByLabel("Drag row");
  await expect(readonlyDrag).toHaveAttribute("aria-disabled", "true");
  await expect(readonlyDrag).not.toHaveAttribute("tabindex", /.+/);

  const attemptedMutationOperations: string[] = [];
  readonlyPage.on("request", (requestEvent) => {
    if (
      requestEvent.method() === "POST" &&
      new URL(requestEvent.url()).pathname === "/graphql"
    ) {
      const operation = requestEvent.headers()["x-operation-name"];
      if (operation) attemptedMutationOperations.push(operation);
    }
  });
  await readonlyAdd.evaluate((element) => (element as HTMLElement).click());
  await readonlyCard.focus();
  await readonlyPage.keyboard.press("F2");
  await expect(
    readonlyCard.getByRole("textbox", { name: "Title" }),
  ).toHaveCount(0);
  await readonlyDrag.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
    ),
  );
  expect(
    attemptedMutationOperations.filter((operation) =>
      [
        "createDatabaseRow",
        "updateDatabaseCellValue",
        "updateDatabaseRowPosition",
        "updateDatabaseRowTitle",
      ].includes(operation),
    ),
  ).toEqual([]);
  const readonlyRowsAfter = await readDatabaseRows(
    request,
    readonlySessionCookies,
    readonlyWorkspace.id,
    readonlyDatabase.database.id,
  );
  expect(readonlyRowsAfter).toEqual(readonlyRowsBefore);

  const readonlyCardLabel = await readonlyCard.getAttribute("aria-label");
  if (!readonlyCardLabel) {
    throw new Error("Readonly Kanban card has no detail label");
  }
  const readonlyDetailTrigger = readonlyKanban.getByLabel(readonlyCardLabel, {
    exact: true,
  });
  await readonlyDetailTrigger.focus();
  await readonlyPage.keyboard.press("Enter");
  const readonlySidePeek = readonlyPage.getByRole("dialog", {
    name: "Row details",
  });
  await expect(readonlySidePeek).toBeVisible();
  await readonlySidePeek.getByRole("button", { name: "Close" }).click();
  await expect(readonlySidePeek).toBeHidden();
  await expect(readonlyDetailTrigger).toBeFocused();

  const compactScrollViewport = readonlyKanban.locator(
    ".mantine-ScrollArea-viewport",
  );
  const compactGeometry = await compactScrollViewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(compactGeometry.scrollWidth).toBeGreaterThan(
    compactGeometry.clientWidth,
  );
  await compactScrollViewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => compactScrollViewport.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await readonlyPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await readonlyPage.screenshot({
    path: path.join(EVIDENCE_DIR, "kanban-compact-readonly-dark.png"),
    fullPage: true,
  });
  expect(readonlyBrowserErrors()).toEqual([]);
  await readonlyContext.close();

  expect(browserErrors()).toEqual([]);
});
