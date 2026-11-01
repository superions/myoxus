/**
 * Virgultum event block E2E tests.
 *
 * Invariants checked:
 *   INV-CAL-BLOCK-01  The stable /event slash-menu item is present in the editor
 *   INV-CAL-BLOCK-02  Inserting via slash menu opens the EventEditDialog
 *   INV-CAL-BLOCK-03  After submitting the dialog, the event block renders the title
 *
 * Prerequisites: stack running at localhost:3010 / localhost:3001.
 * Standard test user: the clean-stack bootstrap admin.
 *
 * The test navigates to an already initialized cloud workspace, creates a
 * disposable future journal via the normal UI, then exercises the event block
 * slash menu. This keeps the event-block invariant independent from mutable
 * existing journal docs while preserving the journal context required by the
 * calendar block.
 */

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import { getSmokeWorkspaceId, smokeGql } from "../../shared/workspace-helper";

const FRONTEND = "http://localhost:3010";
const API = "http://localhost:3001";
const GQL = `${API}/graphql`;

const USER_EMAIL = DEFAULT_SMOKE_USER_EMAIL;
const USER_PASSWORD = DEFAULT_SMOKE_USER_PASSWORD;
const RUN_JOURNAL_DAY_OFFSET = 365 + (Math.floor(Date.now() / 1000) % 365);

// ---- helpers -----------------------------------------------------------------

/**
 * Suppress the "Open this doc in Myoxus app" overlay.
 *
 * Sets open-link-mode to "open-in-web" so that OpenInAppService.bootstrap()
 * hits the default branch and does not block the workspace UI.
 *
 * StorageMemento JSON-stringifies values, so the stored string is
 * '"open-in-web"' (with embedded quotes).
 */
async function suppressOpenInApp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("global-state:open-link-mode", '"open-in-web"');
    } catch {
      // ignore
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
      .click()
      .catch(async () => page.keyboard.press("Escape"));
  }
}

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

async function clickVisibleControl(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 });
  await target.click({ timeout: 15_000 });
}

function e2eCleanupWindow(): { from: string; to: string } {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setFullYear(to.getFullYear() + 4);
  return { from: from.toISOString(), to: to.toISOString() };
}

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

type PermanentDeleteData = {
  deleteDocumentsPermanently: {
    alreadyDeleted: number;
    deleted: number;
    failed: number;
    forbidden: number;
    rootMetaRemoved: number;
  };
};

const DELETE_DOCUMENTS_PERMANENTLY = `
  mutation EventBlockSmokeCleanupDocs($input: DeleteDocumentsPermanentlyInput!) {
    deleteDocumentsPermanently(input: $input) {
      alreadyDeleted
      deleted
      failed
      forbidden
      rootMetaRemoved
    }
  }
`;

async function deleteEventsByTitle(
  request: APIRequestContext,
  title: string,
): Promise<void> {
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
  let failedDeletes = 0;
  for (const event of events) {
    if (event.title !== title) continue;
    const deleted = (await gql(request, cookies, DELETE_EVENT, {
      eventId: event.id,
      workspaceId,
      scope: "All",
    })) as { deleteWorkspaceEvent?: boolean };
    if (!deleted.deleteWorkspaceEvent) {
      failedDeletes += 1;
    }
  }
  if (failedDeletes > 0) {
    throw new Error(
      `failed to delete ${failedDeletes} calendar E2E event(s) titled "${title}"`,
    );
  }
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

async function cleanupDisposableJournalDocs(
  request: APIRequestContext,
  docIds: Iterable<string>,
  titles: Iterable<string>,
): Promise<void> {
  const cleanupDocIds = [...new Set(docIds)];
  const cleanupTitles = new Set(titles);
  if (cleanupDocIds.length === 0 && cleanupTitles.size === 0) {
    return;
  }

  if (cleanupDocIds.length > 0) {
    // Use the same acknowledged GraphQL cleanup path as the Mermaid and
    // metadata smokes. Socket `space:delete-doc` is fine for product flows, but
    // fire-and-forget teardown can race the final visibility poll and leave
    // future journal artifacts in the shared dev database.
    const { deleteDocumentsPermanently } = await gql<PermanentDeleteData>(
      request,
      cookies,
      DELETE_DOCUMENTS_PERMANENTLY,
      { input: { docIds: cleanupDocIds, workspaceId } },
    );
    if (
      deleteDocumentsPermanently.failed > 0 ||
      deleteDocumentsPermanently.forbidden > 0
    ) {
      throw new Error(
        `event-block smoke cleanup failed: ${JSON.stringify(deleteDocumentsPermanently)}`,
      );
    }
  }

  await expect
    .poll(
      async () => {
        const data = await smokeGql<{
          workspace: {
            docs: { edges: Array<{ node: { id: string; title?: string } }> };
          } | null;
        }>(
          request,
          GQL,
          cookies,
          `query EventBlockCleanupDocs($workspaceId: String!) {
             workspace(id: $workspaceId) {
               docs(pagination: { first: 50 }) {
                 edges { node { id title } }
               }
             }
           }`,
          { workspaceId },
        );
        const visibleDocs = data.workspace?.docs.edges ?? [];
        return visibleDocs.filter(
          ({ node }) =>
            cleanupDocIds.includes(node.id) ||
            cleanupTitles.has(node.title ?? ""),
        ).length;
      },
      {
        message:
          "event-block smoke cleanup must remove visible disposable journal documents before the test exits",
        timeout: 20_000,
      },
    )
    .toBe(0);
}

/**
 * Navigate to a newly created disposable journal page.
 *
 * Each test uses a future date that should not have user content. That avoids
 * coupling the event-block invariant to today's mutable journal while still
 * preserving the journal context the event block expects.
 */
async function createDisposableJournalEditor(
  page: Page,
  workspaceId: string,
  date: string,
): Promise<string> {
  await page.goto(
    `${FRONTEND}/workspace/${workspaceId}/journals?date=${date}`,
    {
      waitUntil: "load",
      timeout: 30_000,
    },
  );
  await dismissOpenInAppOverlay(page);

  const editor = page.locator("[data-myoxus-editor-container]");
  const createBtn = page.locator(
    '[data-testid="confirm-create-journal-button"]',
  );

  let state: "editor" | "create" | undefined;
  const startedAt = Date.now();
  // Do not use Promise.any with two locator.waitFor calls here: the losing
  // wait remains active and Playwright serializes later actions behind it,
  // making visible buttons appear unclickable until the stale wait times out.
  while (Date.now() - startedAt < 30_000) {
    if (await editor.isVisible({ timeout: 500 }).catch(() => false)) {
      state = "editor";
      break;
    }
    if (await createBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      state = "create";
      break;
    }
    await page.waitForTimeout(250);
  }

  if (!state) {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `Disposable journal did not become ready for ${date}. Visible body text:\n${bodyText.slice(
        0,
        2000,
      )}`,
    );
  }

  if (state === "create") {
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    // The create action is setup for the Event-Block contract. The journal
    // placeholder is already visible and the following editor assertion proves
    // that the real create handler ran; force avoids unrelated overlay
    // actionability noise from the right sidebar while still using the rendered
    // button element.
    await createBtn.click({ force: true, timeout: 15_000 });
    await expect(editor).toBeVisible({ timeout: 30_000 });
  }
  await page.waitForSelector("v-line", { timeout: 20_000 });
  await dismissOpenInAppOverlay(page);

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive doc id from URL: ${page.url()}`);
  }
  return docId;
}

function futureDateString(dayOffset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function closeTransientJournalUi(page: Page): Promise<void> {
  await dismissOpenInAppOverlay(page);
  // Disposable journal documents are deleted through the acknowledged GraphQL
  // cleanup in afterAll. Do not drive the document-header trash menu here: the
  // journal header intentionally uses week navigation instead of the regular
  // document overflow menu, and the UI menu is not part of this event-block
  // invariant.
  await page.keyboard.press("Escape").catch(() => undefined);
}

/**
 * Position the cursor in a fresh blank line at the end of the document
 * and type the slash command. Returns when the slash menu is ready.
 *
 * Uses Ctrl+End to navigate to the document end (bypassing any non-text
 * blocks like existing event blocks), then creates a new line.
 */
async function typeSlashCommand(page: Page, command: string): Promise<void> {
  const editor = page.locator("[data-myoxus-editor-container]");
  await expect(editor).toBeVisible({ timeout: 20_000 });

  // Click the blank gap first so journal documents with only the placeholder
  // get a real paragraph line. Then target the last rendered editor line; the
  // journal chrome can otherwise keep keyboard focus outside the rich-text host
  // while still showing "Type '/' for commands".
  const blank = page.locator('[data-testid="page-editor-blank"]');
  if (await blank.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await clickVisibleControl(page, blank);
  } else {
    await clickVisibleControl(page, editor);
  }

  const lastLine = page.locator("v-line").last();
  await expect(lastLine).toBeVisible({ timeout: 10_000 });
  await lastLine.click({ timeout: 10_000 });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(
            active?.closest?.("rich-text") ||
            active?.closest?.("v-line") ||
            active?.closest?.("[data-myoxus-editor-container]") ||
            document.querySelector("rich-text")?.contains(active),
          );
        }),
      {
        message:
          "Journal slash-command smoke must focus the Virgultum rich-text host before typing.",
        timeout: 5_000,
      },
    )
    .toBe(true);

  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(command);

  await expect(
    page.getByRole("button", {
      name: /Event\s+Insert a workspace event\./i,
    }),
  ).toBeVisible({
    timeout: 5_000,
  });
}

/**
 * Activate the slash menu item matching the given text.
 *
 * Tries to find the item in the `myoxus-slash-menu` element (which is
 * appended to document.body). Falls back to pressing Enter (which selects
 * the first/highlighted item in the open menu).
 */
async function selectSlashMenuItem(
  page: Page,
  itemText: string,
): Promise<void> {
  // The popover host may stay hidden while its item is projected into the
  // accessibility tree. Target the visible item rather than the implementation
  // host so the smoke follows the user-visible slash-menu contract.
  const escapedItemText = itemText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const item = page.getByRole("button", {
    name: new RegExp(`^${escapedItemText}\\b`, "i"),
  });
  if (await item.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await clickVisibleControl(page, item);
    return;
  }

  // Fallback: press Enter to select the first/highlighted item.
  // This works because the slash menu intercepts Enter on the inline editor.
  await page.keyboard.press("Enter");
}

// ---- test setup --------------------------------------------------------------

let cookies: string[];
let workspaceId: string;
const disposableJournalDocIds = new Set<string>();
const disposableJournalTitles = new Set<string>();

async function openTrackedDisposableJournal(
  page: Page,
  date: string,
): Promise<void> {
  const docId = await createDisposableJournalEditor(page, workspaceId, date);
  disposableJournalDocIds.add(docId);
  disposableJournalTitles.add(date);
}

test.beforeAll(async ({ request }) => {
  cookies = await signInViaApi(request, API, USER_EMAIL, USER_PASSWORD);
  workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
});

test.afterAll(async ({ request }) => {
  try {
    await cleanupSmokeEvents(request);
    await cleanupDisposableJournalDocs(
      request,
      disposableJournalDocIds,
      disposableJournalTitles,
    );
  } finally {
    await signOutViaApi(request, API, cookies);
  }
});

// ---- tests -------------------------------------------------------------------

test.describe("Virgultum event block", () => {
  test.describe.configure({ timeout: 180_000 });

  test("INV-CAL-BLOCK-01: /event slash-menu item is present in the editor", async ({
    page,
    context,
  }) => {
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    await openTrackedDisposableJournal(
      page,
      futureDateString(RUN_JOURNAL_DAY_OFFSET),
    );

    try {
      await typeSlashCommand(page, "/event");

      // The slash menu should appear with "Event" entry
      const slashMenuEl = page.locator("myoxus-slash-menu");
      const menuVisible = await slashMenuEl
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      if (menuVisible) {
        // Verify "Event" option exists in the menu (Playwright pierces shadow DOM)
        await expect(
          page.getByText("Event", { exact: true }).first(),
        ).toBeVisible({
          timeout: 3_000,
        });
      } else {
        // Menu may not be visible via this locator; verify body text
        await expect(page.locator("body")).toContainText(/Event/, {
          timeout: 3_000,
        });
      }

      // Close the slash menu
      await page.keyboard.press("Escape");
    } finally {
      await closeTransientJournalUi(page);
    }
  });

  test("INV-CAL-BLOCK-02: inserting event block via slash menu opens EventEditDialog", async ({
    page,
    context,
  }) => {
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    await openTrackedDisposableJournal(
      page,
      futureDateString(RUN_JOURNAL_DAY_OFFSET + 1),
    );

    try {
      await typeSlashCommand(page, "/event");
      await selectSlashMenuItem(page, "Event");

      // EventEditDialog should open
      const dialog = page.locator('[data-testid="event-edit-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // Close without saving
      await page.keyboard.press("Escape");
    } finally {
      await closeTransientJournalUi(page);
    }
  });

  test("INV-CAL-BLOCK-03: event block renders title after dialog submit", async ({
    page,
    context,
    request,
  }) => {
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const uniqueTitle = `E2E Block Test ${Date.now()}`;

    try {
      // Capture console errors to diagnose update failures (e.g. readonly store)
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await openTrackedDisposableJournal(
        page,
        futureDateString(RUN_JOURNAL_DAY_OFFSET + 2),
      );

      await typeSlashCommand(page, "/event");
      await selectSlashMenuItem(page, "Event");

      // EventEditDialog must open
      const dialog = page.locator('[data-testid="event-edit-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // Fill in the event title
      const titleInput = dialog.locator('[data-testid="event-title-input"]');
      await titleInput.fill(uniqueTitle);

      // Submit
      const submitBtn = dialog.locator('[data-testid="event-submit-button"]');
      await clickVisibleControl(page, submitBtn);

      // Dialog should close
      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // Event block should appear in the editor with the title.
      // Filter by hasText to target specifically the newly created block
      // (previous test runs may have left unreferenced event blocks in the doc).
      await expect(
        page
          .locator("myoxus-event .event-title")
          .filter({ hasText: uniqueTitle }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await deleteEventsByTitle(request, uniqueTitle);
      await closeTransientJournalUi(page);
    }
  });
});
