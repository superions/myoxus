/**
 * Journal calendar E2E smoke tests.
 *
 * Invariants checked:
 *   INV-CAL-01  A workspace event created via GQL appears in the journal day panel
 *   INV-CAL-02  The edit dialog opens pre-filled with the event title
 *   INV-CAL-03  Saving the edit dialog updates the event title in the list
 *   INV-CAL-04  The delete flow removes the event from the list
 *   INV-CAL-05  Month view keeps configured weekday order and grid alignment
 *
 * Prerequisites: stack running at localhost:3010 / localhost:3001.
 * Standard test user: the clean-stack bootstrap admin.
 */

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getAccountColorMode,
  getAccountLocale,
  setAccountColorMode,
  setAccountLocale,
  setBrowserLocale,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId, smokeGql } from "../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ??
  process.env.E2E_BASE_URL ??
  "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${API}/graphql`;

const USER_EMAIL = DEFAULT_SMOKE_USER_EMAIL;
const USER_PASSWORD = DEFAULT_SMOKE_USER_PASSWORD;

// ---- helpers -----------------------------------------------------------------

async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const nameVal = raw.split(";")[0];
    const [name, ...rest] = nameVal.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: rest.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

async function gql<T = unknown>(
  request: APIRequestContext,
  cookies: string[],
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return smokeGql<T>(request, GQL, cookies, query, variables);
}

async function suppressOpenInApp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("global-state:open-link-mode", '"open-in-web"');
    } catch {
      // The test still works if storage is unavailable; the overlay is dismissed
      // again after navigation as a second line of defense.
    }
  });
}

async function dismissOpenInAppOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        [data-testid="open-in-app-card"] {
          display: none !important;
          pointer-events: none !important;
        }
      `,
    })
    .catch(() => undefined);

  const dismissButton = page.getByRole("button", {
    name: /dismiss|schliessen|schließen/i,
  });
  if (await dismissButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await dismissButton
      .click({ timeout: 2_000 })
      .catch(async () => page.keyboard.press("Escape"));
  }
}

type VisiblePoint = {
  x: number;
  y: number;
};

async function waitForVisibleEventRow(
  page: Page,
  title: string,
  timeout = 45_000,
): Promise<VisiblePoint> {
  const row = page
    .locator('[data-testid="event-row"]')
    .filter({ hasText: title })
    .first();
  await expect(row).toBeVisible({ timeout });
  const box = await row.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`event row has zero-sized bounds: ${title}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickVisibleEventRow(
  page: Page,
  title: string,
  timeout = 45_000,
): Promise<void> {
  const row = page
    .locator('[data-testid="event-row"]')
    .filter({ hasText: title })
    .first();
  await expect(row).toBeVisible({ timeout });
  // Use Playwright's actionability checks for the semantic row click. Raw
  // coordinate clicks are reserved for geometry probes; they can become stale
  // when the journal sidebar finishes layout or reveals hover actions.
  await row.click({ timeout: 15_000 });
}

async function waitForVisibleTestId(
  page: Page,
  testId: string,
  timeout = 15_000,
): Promise<VisiblePoint> {
  const element = page.getByTestId(testId).first();
  await expect(element).toBeVisible({ timeout });
  const box = await element.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`element has zero-sized bounds: ${testId}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickVisibleTestId(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId).first();
  await expect(target).toBeVisible({ timeout: 15_000 });
  const box = await target.boundingBox({ timeout: 15_000 });
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`visible element has zero-sized bounds: ${testId}`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function setInputByTestId(
  page: Page,
  testId: string,
  value: string,
): Promise<void> {
  const input = page.getByTestId(testId).first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(value, { timeout: 15_000 });
  await expect(input).toHaveValue(value, { timeout: 15_000 });
}

async function expectTestIdGone(page: Page, testId: string): Promise<void> {
  await expect(page.getByTestId(testId).first()).toBeHidden({
    timeout: 10_000,
  });
}

async function expectEventRowGone(page: Page, title: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((expectedTitle) => {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="event-row"]'),
          );
          return rows.some((row) => row.textContent?.includes(expectedTitle));
        }, title),
      { timeout: 8_000 },
    )
    .toBe(false);
}

async function clickEventRowAction(
  page: Page,
  title: string,
  actionTestId: string,
): Promise<void> {
  const row = page
    .locator('[data-testid="event-row"]')
    .filter({ hasText: title })
    .first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.hover({ timeout: 15_000 });
  const button = row.getByTestId(actionTestId).first();
  await expect(button).toBeVisible({ timeout: 15_000 });
  const box = await button.boundingBox({ timeout: 15_000 });
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`event row action has zero-sized bounds: ${actionTestId}`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function clickVisibleControl(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 });
  const box = await target.boundingBox({ timeout: 15_000 });
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("visible control has zero-sized DOM bounds");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Build an event window for "local-today at HH:00 → HH+1:00" and the matching
 * URL date string. The journal panel buckets events by browser-local day
 * (`dayjs()`), so a UTC-today date can drift onto local-yesterday during the
 * late-evening UTC window — which is exactly what was breaking these tests.
 * Computing the slot in local time keeps the event on local-today regardless
 * of timezone offset.
 */
function localTodayWindow(startHour: number): {
  dateStr: string;
  startsAt: string;
  endsAt: string;
} {
  const start = new Date();
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(startHour + 1, 0, 0, 0);
  const yyyy = start.getFullYear();
  const mm = String(start.getMonth() + 1).padStart(2, "0");
  const dd = String(start.getDate()).padStart(2, "0");
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

const CREATE_EVENT = `
  mutation createWorkspaceEvent($input: CreateWorkspaceEventInput!) {
    createWorkspaceEvent(input: $input) { id title startsAt endsAt }
  }
`;

const CALENDAR_EVENTS = `
  query calendarEvents($workspaceId: String!, $from: DateTime!, $to: DateTime!) {
    workspace(id: $workspaceId) {
      calendars {
        events(from: $from, to: $to) {
          id
          title
        }
      }
    }
  }
`;

const DELETE_EVENT = `
  mutation deleteWorkspaceEvent($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!) {
    deleteWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: $scope)
  }
`;

function e2eCleanupWindow(): { from: string; to: string } {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setFullYear(to.getFullYear() + 4);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function cleanupSmokeEvents(request: APIRequestContext): Promise<void> {
  const { from, to } = e2eCleanupWindow();
  const data = (await gql(request, cookies, CALENDAR_EVENTS, {
    workspaceId,
    from,
    to,
  })) as {
    workspace?: {
      calendars?: Array<{ events?: Array<{ id: string; title?: string }> }>;
    };
  };
  const events =
    data.workspace?.calendars?.flatMap((calendar) => calendar.events ?? []) ??
    [];
  const cleanupEvents = events.filter((event) =>
    /^E2E (Test Event|Edit Test|Delete Test|Block Test) \d+/.test(
      event.title ?? "",
    ),
  );
  const failedDeletes: string[] = [];

  for (const event of cleanupEvents) {
    const deleted = (await gql(request, cookies, DELETE_EVENT, {
      eventId: event.id,
      workspaceId,
      scope: "All",
    })) as { deleteWorkspaceEvent?: boolean };
    if (!deleted.deleteWorkspaceEvent) {
      failedDeletes.push(event.id);
    }
  }

  if (failedDeletes.length > 0) {
    throw new Error(
      `failed to delete calendar E2E artifact(s): ${failedDeletes.join(", ")}`,
    );
  }
}

async function deleteEventById(
  request: APIRequestContext,
  eventId: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deleted = (await Promise.race([
      gql(request, cookies, DELETE_EVENT, {
        eventId,
        workspaceId,
        scope: "All",
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(`Timed out deleting test calendar event ${eventId}`),
          );
        }, 10_000);
      }),
    ])) as { deleteWorkspaceEvent?: boolean };
    if (!deleted.deleteWorkspaceEvent) {
      throw new Error(`calendar event cleanup returned false for ${eventId}`);
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type JournalToolLayout = {
  workspaceId: string;
  viewFamily: string;
  orderedToolIds: string[];
  visibleToolIds: string[];
  collapsedToolIds: string[];
};
const journalFixtureState = new WeakMap<
  Page,
  {
    original: JournalToolLayout | null;
    originallyNull: boolean;
    panelOpen?: boolean;
    changed: boolean;
  }
>();
const layoutFields =
  "workspaceId viewFamily orderedToolIds visibleToolIds collapsedToolIds";
async function readToolLayouts(request: APIRequestContext) {
  const result = await gql<{
    currentUser: {
      preferences: {
        values: {
          workbenchToolLayouts: JournalToolLayout[] | null;
        };
      };
    };
  }>(
    request,
    cookies,
    `query CalendarToolPreferences {
    currentUser { preferences { values { workbenchToolLayouts { ${layoutFields} } } } }
  }`,
  );
  return result.currentUser.preferences.values.workbenchToolLayouts;
}
const isJournalLayout = (layout: JournalToolLayout) =>
  layout.workspaceId === workspaceId &&
  layout.viewFamily.toLowerCase() === "journal";

async function clickPersistedToolControl(page: Page, control: Locator) {
  // Cleanup owns attempted changes even when acknowledgement fails.
  journalFixtureState.get(page)!.changed = true;
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => {
        const body = response.request().postData() ?? "";
        return (
          response.url().endsWith("/graphql") &&
          body.includes("mutation") &&
          body.includes("updatePreferences") &&
          body.includes("workbenchToolLayouts")
        );
      },
      { timeout: 10_000 },
    ),
    control.click(),
  ]);
  expect(response.status()).toBe(200);
  expect((await response.json()).errors ?? []).toEqual([]);
}

/** Use the current host's membership and collapse controls, never legacy tabs. */
async function openJournalTool(page: Page, tool: "calendar" | "agenda") {
  const state = journalFixtureState.get(page)!;
  const toggle = page.getByTestId("context-panel-toggle");
  await expect(toggle).toBeVisible();
  const open = (await toggle.getAttribute("aria-expanded")) === "true";
  state.panelOpen ??= open;
  if (!open) await toggle.click();
  await page.getByTestId("header-dropDownButton").click();
  await page.getByRole("menuitem", { name: /^(Tools|Werkzeuge)$/ }).hover();
  const item = page.getByTestId(`workbench-tool-menu-${tool}`);
  if ((await item.getAttribute("data-checked")) !== "true") {
    await clickPersistedToolControl(page, item);
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const header = page
    .getByTestId(`context-surface-${tool}`)
    .locator("button[aria-expanded]")
    .first();
  await expect(header).toBeVisible();
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await clickPersistedToolControl(page, header);
  }
  await expect(page.getByTestId(`journal-${tool}-tool`)).toBeVisible({
    timeout: 10_000,
  });
}

async function openJournalSidebarPanel(page: Page) {
  await openJournalTool(page, "calendar");
}
async function openJournalAgendaTool(page: Page) {
  await openJournalTool(page, "agenda");
}

async function expectMonthCalendarUsesConfiguredWeekStart(
  page: Page,
): Promise<void> {
  const panel = page.getByTestId("journal-calendar-tool");
  const calendar = panel.getByRole("table");
  const headers = calendar.getByRole("columnheader");
  const firstWeekDays = calendar.getByRole("row").nth(1).getByRole("button");

  await expect(headers.first()).toBeVisible({ timeout: 10_000 });
  await expect(firstWeekDays.first()).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(
      async () =>
        (await headers.allTextContents())
          .map((text) => text.trim())
          .filter((text) => text !== "#")
          .slice(0, 7),
      {
        message:
          "month calendar must render the localized configured weekday order",
        timeout: 10_000,
      },
    )
    .toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);

  await expect(firstWeekDays.first()).toHaveText("27", {
    timeout: 10_000,
  });

  const xOffsets = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      '[data-testid="journal-calendar-tool"]',
    );
    if (!root) return null;
    const headerRects = Array.from(
      root.querySelectorAll<HTMLElement>("table thead th"),
    )
      .filter((element) => element.textContent?.trim() !== "#")
      .slice(0, 7)
      .map((element) => element.getBoundingClientRect());
    const firstWeek = root.querySelector<HTMLElement>("table tbody tr");
    const dayRects = Array.from(
      firstWeek?.querySelectorAll<HTMLElement>("td button") ?? [],
    )
      .slice(0, 7)
      .map((element) => element.getBoundingClientRect());
    if (headerRects.length !== 7 || dayRects.length !== 7) return null;
    return headerRects.map((header, index) =>
      Math.abs(
        header.left +
          header.width / 2 -
          (dayRects[index].left + dayRects[index].width / 2),
      ),
    );
  });

  expect(xOffsets).not.toBeNull();
  const maxOffset = Math.max(...(xOffsets ?? [Number.POSITIVE_INFINITY]));
  expect(maxOffset).toBeLessThanOrEqual(8);
}

async function openConfiguredMonthCalendar(page: Page): Promise<void> {
  await page.goto(
    `${FRONTEND}/workspace/${workspaceId}/journals?date=2026-05-19`,
    {
      waitUntil: "load",
      timeout: 30_000,
    },
  );
  await dismissOpenInAppOverlay(page);
  await openJournalSidebarPanel(page);
  await clickVisibleControl(page, page.getByTestId("calendar-view-month"));
  await expect(page.locator('input[type="radio"][value="month"]')).toBeChecked({
    timeout: 10_000,
  });
  await expectMonthCalendarUsesConfiguredWeekStart(page);
}

async function captureMonthCalendarEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const panel = page.getByTestId("journal-calendar-tool");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.screenshot({
    path: testInfo.outputPath(`journal-calendar-${name}.png`),
  });
}

// ---- test setup --------------------------------------------------------------

let cookies: string[];
let workspaceId: string;
let originalColorMode: "dark" | "light" | "system" | null;
let originalLocale: string | null;

test.beforeAll(async ({ request }) => {
  cookies = await signInViaApi(request, API, USER_EMAIL, USER_PASSWORD);
  originalLocale = await getAccountLocale({
    request,
    gqlEndpoint: GQL,
    cookies,
  });
  originalColorMode = await getAccountColorMode({
    request,
    gqlEndpoint: GQL,
    cookies,
  });
  workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
});

test.afterAll(async ({ request }) => {
  try {
    await cleanupSmokeEvents(request);
  } finally {
    await setAccountColorMode(
      { request, gqlEndpoint: GQL, cookies },
      originalColorMode,
    );
    await setAccountLocale(
      { request, gqlEndpoint: GQL, cookies },
      originalLocale,
    );
    await signOutViaApi(request, API, cookies);
  }
});

// Snapshot only the owning Journal preference entry; preserve parallel layouts.
test.beforeEach(async ({ page, request }) => {
  const layouts = await readToolLayouts(request);
  journalFixtureState.set(page, {
    original: layouts?.find(isJournalLayout) ?? null,
    originallyNull: layouts === null,
    changed: false,
  });
});
test.afterEach(async ({ page, request }) => {
  const state = journalFixtureState.get(page)!;
  if (state.changed) {
    const current = await readToolLayouts(request);
    const restored = (current ?? []).filter(
      (layout) => !isJournalLayout(layout),
    );
    if (state.original) restored.push(state.original);
    // UI mutations above have acknowledged server persistence. Restore the
    // exact original scope, including absence of an override, before teardown.
    await gql(
      request,
      cookies,
      `mutation RestoreCalendarToolPreferences($input: UpdateUserPreferencesInput!) {
      updatePreferences(input: $input) { effectiveValues { workbenchToolLayouts { ${layoutFields} } } }
    }`,
      {
        input: {
          workbenchToolLayouts: restored.length
            ? restored
            : state.originallyNull
              ? null
              : [],
        },
      },
    );
    expect(
      (await readToolLayouts(request))?.find(isJournalLayout) ?? null,
    ).toEqual(state.original);
  }
  if (state.panelOpen !== undefined) {
    await page.keyboard.press("Escape");
    const toggle = page.getByTestId("context-panel-toggle");
    if (
      ((await toggle.getAttribute("aria-expanded")) === "true") !==
      state.panelOpen
    )
      await toggle.click();
  }
  journalFixtureState.delete(page);
});

// ---- tests -------------------------------------------------------------------

test.describe("Journal calendar panel", () => {
  test.describe.configure({ timeout: 180_000 });

  test("INV-CAL-01: event created via GQL appears in journal day panel", async ({
    page,
    context,
    request,
  }) => {
    const { dateStr, startsAt, endsAt } = localTodayWindow(10);
    const title = `E2E Test Event ${Date.now()}`;

    const created = (await gql(request, cookies, CREATE_EVENT, {
      input: { workspaceId, title, startsAt, endsAt },
    })) as { createWorkspaceEvent: { id: string } };
    const eventId = created.createWorkspaceEvent.id;

    try {
      await suppressOpenInApp(context);
      await injectCookies(context, cookies);
      await page.goto(
        `${FRONTEND}/workspace/${workspaceId}/journals?date=${dateStr}`,
        {
          waitUntil: "load",
          timeout: 30_000,
        },
      );
      await dismissOpenInAppOverlay(page);

      await openJournalAgendaTool(page);

      // Journal panel must show the event sections (today section is open
      // by default and contains today's events).
      const sections = page.locator('[data-testid="event-sections"]');
      await expect(sections).toBeVisible({ timeout: 10_000 });

      // The event title must appear in an event row inside the today section.
      await waitForVisibleEventRow(page, title);
    } finally {
      await deleteEventById(request, eventId);
    }
  });

  test("INV-CAL-02/03: edit dialog pre-fills title and saving updates the list", async ({
    page,
    context,
    request,
  }, testInfo) => {
    const { dateStr, startsAt, endsAt } = localTodayWindow(14);
    const originalTitle = `E2E Edit Test ${Date.now()}`;
    const updatedTitle = `${originalTitle} UPDATED`;

    const created = (await gql(request, cookies, CREATE_EVENT, {
      input: { workspaceId, title: originalTitle, startsAt, endsAt },
    })) as { createWorkspaceEvent: { id: string } };
    const eventId = created.createWorkspaceEvent.id;

    try {
      await suppressOpenInApp(context);
      await injectCookies(context, cookies);
      await page.goto(
        `${FRONTEND}/workspace/${workspaceId}/journals?date=${dateStr}`,
        {
          waitUntil: "load",
          timeout: 30_000,
        },
      );
      await dismissOpenInAppOverlay(page);

      await openJournalAgendaTool(page);

      const sections = page.locator('[data-testid="event-sections"]');
      await expect(sections).toBeVisible({ timeout: 10_000 });
      await waitForVisibleEventRow(page, originalTitle);

      // The row itself is the primary edit affordance; relying on hover-only
      // icon buttons made this gate pass/fail based on animation timing rather
      // than the user-visible edit contract.
      await clickVisibleEventRow(page, originalTitle);

      // Dialog must open
      await waitForVisibleTestId(page, "event-edit-dialog");

      // Title input must be pre-filled with the original title
      const titleInput = page.getByTestId("event-title-input");
      await expect(titleInput).toHaveValue(originalTitle, { timeout: 15_000 });
      const dateTimeControls = page
        .getByTestId("event-edit-dialog")
        .locator(
          '[data-testid="event-start-datetime-input"], [data-testid="event-end-datetime-input"]',
        );
      await expect(dateTimeControls.first()).toBeVisible({ timeout: 15_000 });
      const visibleDateTimeText = (
        await dateTimeControls.allTextContents()
      ).join(" ");
      expect(visibleDateTimeText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(visibleDateTimeText).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      await page.getByTestId("event-edit-dialog").screenshot({
        path: testInfo.outputPath("journal-event-edit-dialog.png"),
      });

      // Update title and submit
      await setInputByTestId(page, "event-title-input", updatedTitle);
      await clickVisibleTestId(page, "event-submit-button");

      // Dialog must close
      await expectTestIdGone(page, "event-edit-dialog");

      // Updated title must appear in the list
      await waitForVisibleEventRow(page, updatedTitle);
    } finally {
      await deleteEventById(request, eventId);
    }
  });

  test("INV-CAL-04: delete flow removes event from the list", async ({
    page,
    context,
    request,
  }) => {
    const { dateStr, startsAt, endsAt } = localTodayWindow(16);
    const title = `E2E Delete Test ${Date.now()}`;

    const created = (await gql(request, cookies, CREATE_EVENT, {
      input: { workspaceId, title, startsAt, endsAt },
    })) as { createWorkspaceEvent: { id: string } };
    const eventId = created.createWorkspaceEvent.id;

    // deleteViaApi is for cleanup only if the UI delete fails
    let needsApiCleanup = true;

    try {
      await suppressOpenInApp(context);
      await injectCookies(context, cookies);
      await page.goto(
        `${FRONTEND}/workspace/${workspaceId}/journals?date=${dateStr}`,
        {
          waitUntil: "load",
          timeout: 30_000,
        },
      );
      await dismissOpenInAppOverlay(page);

      await openJournalAgendaTool(page);

      const sections = page.locator('[data-testid="event-sections"]');
      await expect(sections).toBeVisible({ timeout: 10_000 });

      // Click delete (trash icon) → shows inline confirm
      await clickEventRowAction(page, title, "event-row-delete");

      // The confirm button must appear within the row
      await clickEventRowAction(page, title, "event-delete-confirm");

      // Event must disappear from the sections
      await expectEventRowGone(page, title);

      needsApiCleanup = false;
    } finally {
      if (needsApiCleanup) {
        await deleteEventById(request, eventId);
      }
    }
  });

  test("INV-CAL-05: month view respects configured Monday-first layout", async ({
    page,
    context,
    request,
  }, testInfo) => {
    await suppressOpenInApp(context);
    await injectCookies(context, cookies);
    await setBrowserLocale(page, "de", {
      request,
      gqlEndpoint: GQL,
      cookies,
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await setAccountColorMode({ request, gqlEndpoint: GQL, cookies }, "light");
    await openConfiguredMonthCalendar(page);
    await captureMonthCalendarEvidence(page, testInfo, "desktop-light");

    await setAccountColorMode({ request, gqlEndpoint: GQL, cookies }, "dark");
    await openConfiguredMonthCalendar(page);
    await captureMonthCalendarEvidence(page, testInfo, "desktop-dark");
  });
});
