// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import {
  clearSmokeAuthSessionCache,
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  waitForWorkspaceReady,
  waitForWorkspaceDocSync,
} from "../../shared/workspace-helper";

import {
  installAbandonedRootLock,
  removeAbandonedRootLock,
  proveTransactionRollbackOnTermination,
} from "../../shared/storage-worker-crash-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ??
  process.env.E2E_BASE_URL ??
  "http://localhost:3010";
const API =
  process.env.MYOXUS_API_BASE_URL ??
  process.env.E2E_API_BASE_URL ??
  "http://localhost:3001";
const GQL = `${API}/graphql`;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /index error, retry in 5s/i,
  /blocks is not defined/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

type PermanentDeleteData = {
  deleteDocumentsPermanently: {
    failed: number;
    forbidden: number;
  };
};

type WorkspaceDocsData = {
  workspace: {
    doc: { id: string; title?: string } | null;
  } | null;
};

type DragLocation = "center" | "top" | "bottom" | "left" | "right";

function toDragPosition(
  rect: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
  location: DragLocation,
) {
  switch (location) {
    case "top":
      return { x: rect.width / 2, y: 1 };
    case "bottom":
      return { x: rect.width / 2, y: rect.height - 1 };
    case "left":
      return { x: 1, y: rect.height / 2 };
    case "right":
      return { x: rect.width - 1, y: rect.height / 2 };
    case "center":
    default:
      return { x: rect.width / 2, y: rect.height / 2 };
  }
}

async function dragTo(
  page: Page,
  locator: Locator,
  target: Locator,
  location: DragLocation = "center",
): Promise<void> {
  await locator.hover();
  const sourceRect = await locator.boundingBox();
  if (!sourceRect) {
    throw new Error("drag source element not found");
  }
  const sourceCenter = toDragPosition(sourceRect, "center");
  await page.mouse.move(
    sourceRect.x + sourceCenter.x,
    sourceRect.y + sourceCenter.y,
  );
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(
    sourceRect.x + sourceCenter.x + 1,
    sourceRect.y + sourceCenter.y + 1,
  );
  await page.mouse.move(1, 1, { steps: 10 });
  await target.hover();
  const targetRect = await target.boundingBox();
  if (!targetRect) {
    throw new Error("drag target element not found");
  }
  const targetPosition = toDragPosition(targetRect, location);
  await page.mouse.move(
    targetRect.x + targetPosition.x,
    targetRect.y + targetPosition.y,
    { steps: 10 },
  );
  await page.waitForTimeout(100);
  await page.mouse.up();
}

function collectFatalErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") {
      return;
    }
    const text = msg.text();
    if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return () => errors;
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
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

async function cleanupCreatedDocsViaApi(
  request: APIRequestContext,
  workspaceId: string,
  cookies: string[],
  docIds: string[],
): Promise<void> {
  if (docIds.length === 0) return;
  const response = await request.post(GQL, {
    data: {
      query: `mutation TrashSelectedDragCleanup($input: DeleteDocumentsPermanentlyInput!) {
        deleteDocumentsPermanently(input: $input) {
          failed
          forbidden
        }
      }`,
      variables: { input: { workspaceId, docIds } },
    },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
      "x-myoxus-client": "web-smoke",
      "x-myoxus-client-format": "myoxus-native",
      "x-myoxus-client-capabilities": "trash-selected-drag-cleanup",
    },
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `Trash selected drag cleanup HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    data?: PermanentDeleteData;
    errors?: unknown[];
  };
  if (body.errors?.length) {
    throw new Error(
      `Trash selected drag cleanup GraphQL errors: ${JSON.stringify(body.errors)}`,
    );
  }
  const result = body.data?.deleteDocumentsPermanently;
  if (!result) {
    throw new Error(
      "Trash selected drag cleanup did not return a delete result",
    );
  }
  if (result.failed > 0 || result.forbidden > 0) {
    throw new Error(
      `Trash selected drag cleanup failed: ${JSON.stringify(result)}`,
    );
  }
}

async function nativeGql<T>(
  request: APIRequestContext,
  cookies: string[],
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(GQL, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
      "x-myoxus-client": "web-smoke",
      "x-myoxus-client-format": "myoxus-native",
      "x-myoxus-client-capabilities": "trash-selected-drag-projection",
    },
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `GraphQL HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("GraphQL response did not contain data");
  return body.data;
}

async function waitForWorkspaceDocTitleProjection(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
  title: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const data = await nativeGql<WorkspaceDocsData>(
          request,
          cookies,
          `query TrashSelectedDragWorkspaceDoc($workspaceId: String!, $docId: String!) {
            workspace(id: $workspaceId) {
              doc(docId: $docId) { id title }
            }
          }`,
          { workspaceId, docId },
        );
        return data.workspace?.doc?.title ?? null;
      },
      {
        message: `workspace docs projection must durably expose title "${title}" for ${docId} before trash actions`,
        timeout: 45_000,
      },
    )
    .toBe(title);
}

async function openAllDocs(page: Page, workspaceId: string): Promise<void> {
  // Existing workspace journeys use the normal sidebar navigation. Cold entry
  // and the later explicit reload/readback checks still cross a page boundary.
  if (page.url().startsWith(`${FRONTEND}/workspace/${workspaceId}/`)) {
    await page.getByTestId("all-pages").click();
  } else {
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
      waitUntil: "load",
      timeout: 30_000,
    });
  }
  await waitForWorkspaceReady(page, { allDocs: true });
}

async function createDoc(
  request: APIRequestContext,
  cookies: string[],
  page: Page,
  workspaceId: string,
  title: string,
): Promise<string> {
  await openAllDocs(page, workspaceId);
  await page
    .locator(
      '[data-testid="sidebar-new-page-button"], [data-testid="new-page-button-trigger"]',
    )
    .first()
    .click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/(?!all(?:$|\?))[^/?#]+/, {
    timeout: 20_000,
  });

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive doc id from ${page.url()}`);
  }

  const titleContainer = page.locator("doc-title .doc-title-container").first();
  await expect(titleContainer).toBeVisible({ timeout: 20_000 });
  await titleContainer.click();

  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  // The Lit-backed title editor stores the root title in a Y.Text. Keyboard
  // input exercises the same composition path as users and avoids a Playwright
  // `fill()` shortcut that can leave the UI text updated without committing the
  // expected root-metadata title under load.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await titleEditor.blur();
  await expect(titleContainer).toContainText(title, { timeout: 20_000 });
  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForSelector("v-line", { timeout: 20_000 });
  await waitForWorkspaceDocTitleProjection(
    request,
    cookies,
    workspaceId,
    docId,
    title,
  );

  const paragraph = page.locator("myoxus-paragraph .inline-editor").first();
  await paragraph.click();
  await page.keyboard.insertText(`Acknowledged content: ${title}`);
  await expect(paragraph).toContainText(`Acknowledged content: ${title}`);

  // The title projection alone does not acknowledge both editor sync units.
  await waitForWorkspaceDocSync(page, docId);

  await openAllDocs(page, workspaceId);
  const row = page.locator(
    `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(
    row,
    `All-pages projection must expose the committed title for newly created doc ${docId}`,
  ).toContainText(title, { timeout: 20_000 });
  return docId;
}

async function openTrashViaSidebar(page: Page): Promise<void> {
  await page.getByTestId("trash-page").click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/trash(?:$|\?)/, {
    timeout: 20_000,
  });
}

test("trash accepts a selected all-docs drag payload", async ({
  context,
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  const readFatalErrors = collectFatalErrors(page);
  let cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  await injectCookies(context, cookies);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

  const suffix = Date.now();
  const titles = Array.from(
    { length: 3 },
    (_, index) => `Trash selected drag smoke ${suffix}-${index + 1}`,
  );
  const createdDocIds: string[] = [];
  let abandonedLease:
    Awaited<ReturnType<typeof installAbandonedRootLock>> | undefined;

  try {
    for (const title of titles) {
      createdDocIds.push(
        await createDoc(request, cookies, page, workspaceId, title),
      );
    }

    await openAllDocs(page, workspaceId);
    // Preserve cold readback of the acknowledged titles before testing drag.
    await page.reload({ waitUntil: "load", timeout: 30_000 });
    await waitForWorkspaceReady(page, { allDocs: true });
    await proveTransactionRollbackOnTermination(page);
    abandonedLease = await installAbandonedRootLock(page);
    await page.reload({ waitUntil: "load", timeout: 30_000 });
    await waitForWorkspaceReady(page, { allDocs: true });
    const rows = createdDocIds.map((docId) =>
      page.locator(`[data-testid="doc-list-item"][data-doc-id="${docId}"]`),
    );

    for (let index = 0; index < rows.length; index += 1) {
      await expect(rows[index]).toBeVisible({ timeout: 20_000 });
      await expect(rows[index]).toContainText(titles[index], {
        timeout: 20_000,
      });
    }

    await rows[0].click();
    await expect(
      page.locator("myoxus-paragraph .inline-editor").first(),
    ).toContainText(`Acknowledged content: ${titles[0]}`, { timeout: 20_000 });
    await openAllDocs(page, workspaceId);
    await rows[0].click({ modifiers: ["Shift"] });
    for (const row of rows.slice(1)) {
      await row.click();
    }
    await expect(page.getByTestId("floating-toolbar")).toContainText(
      String(titles.length),
      {
        timeout: 10_000,
      },
    );

    const trashDropTarget = page
      .getByTestId("trash-page")
      .locator("xpath=ancestor::a[1]");
    await expect(trashDropTarget).toBeVisible();
    await dragTo(page, rows[0], trashDropTarget);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText(String(titles.length));
    await dialog.getByTestId("confirm-modal-confirm").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    for (const title of titles) {
      await expect(
        page.getByTestId("doc-list-item").filter({ hasText: title }),
      ).toHaveCount(0, { timeout: 30_000 });
    }

    await openTrashViaSidebar(page);
    for (const title of titles) {
      await expect(
        page.getByTestId("doc-list-item").filter({ hasText: title }),
      ).toBeVisible({ timeout: 30_000 });
    }
    await testInfo.attach("trash-selected-drag-after", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    expect(readFatalErrors()).toEqual([]);
  } finally {
    if (abandonedLease) await removeAbandonedRootLock(page, abandonedLease);
    try {
      await cleanupCreatedDocsViaApi(
        request,
        workspaceId,
        cookies,
        createdDocIds,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/AUTHENTICATION_REQUIRED|authentication required/i.test(error.message)
      ) {
        throw error;
      }
      clearSmokeAuthSessionCache();
      cookies = await signInViaApi(
        request,
        API,
        DEFAULT_SMOKE_USER_EMAIL,
        DEFAULT_SMOKE_USER_PASSWORD,
      );
      await cleanupCreatedDocsViaApi(
        request,
        workspaceId,
        cookies,
        createdDocIds,
      );
    }
    await signOutViaApi(request, API, cookies);
  }
});
