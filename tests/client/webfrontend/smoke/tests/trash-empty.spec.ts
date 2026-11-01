// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
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

const FRONTEND = process.env.E2E_BASE_URL ?? "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";
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
      query: `mutation TrashSmokeCleanup($input: DeleteDocumentsPermanentlyInput!) {
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
      "x-myoxus-client-capabilities": "trash-cleanup",
    },
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `Trash smoke cleanup HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    data?: PermanentDeleteData;
    errors?: unknown[];
  };
  if (body.errors?.length) {
    throw new Error(
      `Trash smoke cleanup GraphQL errors: ${JSON.stringify(body.errors)}`,
    );
  }
  const result = body.data?.deleteDocumentsPermanently;
  if (!result)
    throw new Error("Trash smoke cleanup did not return a delete result");
  if (result.failed > 0 || result.forbidden > 0) {
    throw new Error(`Trash smoke cleanup failed: ${JSON.stringify(result)}`);
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
      "x-myoxus-client-capabilities": "trash-projection",
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
        const data = await nativeGql<{
          workspace: {
            doc: { id: string; title: string | null } | null;
          } | null;
        }>(
          request,
          cookies,
          `query TrashSmokeWorkspaceDoc($workspaceId: String!, $docId: String!) {
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
        timeout: 30_000,
      },
    )
    .toBe(title);
}

async function waitForWorkspaceDocAbsent(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const data = await nativeGql<{
          workspace: { doc: { id: string } | null } | null;
        }>(
          request,
          cookies,
          `query TrashSmokeDeletedWorkspaceDoc($workspaceId: String!, $docId: String!) {
            workspace(id: $workspaceId) {
              doc(docId: $docId) { id }
            }
          }`,
          { workspaceId, docId },
        );
        return data.workspace?.doc ?? null;
      },
      {
        message: `permanent delete must remove authoritative workspace doc ${docId}`,
        timeout: 30_000,
      },
    )
    .toBeNull();
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
  await page.getByTestId("sidebar-new-page-button").click();
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
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await titleEditor.blur();
  await expect(titleContainer).toContainText(title, { timeout: 20_000 });
  await waitForWorkspaceDocTitleProjection(
    request,
    cookies,
    workspaceId,
    docId,
    title,
  );

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

async function moveDocToTrash(
  page: Page,
  docId: string,
  title: string,
): Promise<void> {
  const row = page.locator(
    `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(
    row,
    `All-pages row for ${docId} must retain its committed title before move-to-trash`,
  ).toContainText(title, { timeout: 20_000 });
  await row.hover();
  await row.getByTestId("doc-list-operation-button").click();
  await page.getByTestId("doc-list-operation-trash").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId("confirm-modal-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(
    page.getByTestId("doc-list-item").filter({ hasText: title }),
    `All-pages projection must remove "${title}" immediately after move-to-trash without reload`,
  ).toHaveCount(0, { timeout: 20_000 });
}

async function openTrash(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`${FRONTEND}/workspace/${workspaceId}/trash`, {
    waitUntil: "load",
    timeout: 30_000,
  });
}

async function openTrashViaSidebar(page: Page): Promise<void> {
  await page.getByTestId("trash-page").click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/trash(?:$|\?)/, {
    timeout: 20_000,
  });
}

async function openAllDocsViaSidebar(page: Page): Promise<void> {
  await page.getByTestId("all-pages").click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/all(?:$|\?)/, {
    timeout: 20_000,
  });
}

test("trash supports durable single delete and empty-trash bulk delete", async ({
  context,
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
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
  const singleTitle = `Trash single delete smoke ${suffix}`;
  const bulkTitle = `Trash empty delete smoke ${suffix}`;
  const createdDocIds: string[] = [];

  try {
    createdDocIds.push(
      await createDoc(request, cookies, page, workspaceId, singleTitle),
    );
    createdDocIds.push(
      await createDoc(request, cookies, page, workspaceId, bulkTitle),
    );

    await openAllDocs(page, workspaceId);
    await moveDocToTrash(page, createdDocIds[0], singleTitle);
    await moveDocToTrash(page, createdDocIds[1], bulkTitle);

    await openTrashViaSidebar(page);
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: singleTitle }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: bulkTitle }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("empty-trash-button")).toBeVisible({
      timeout: 10_000,
    });
    await testInfo.attach("trash-before-delete-actions", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await openAllDocsViaSidebar(page);
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: singleTitle }),
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: bulkTitle }),
    ).toHaveCount(0, { timeout: 20_000 });

    await openTrashViaSidebar(page);
    const singleRow = page
      .getByTestId("doc-list-item")
      .filter({ hasText: singleTitle });
    await singleRow.hover();
    await singleRow.getByTestId("delete-page-button").click();
    await page.getByRole("dialog").getByTestId("confirm-modal-confirm").click();
    await page.waitForTimeout(1000);

    await openTrash(page, workspaceId);
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: singleTitle }),
    ).toBeHidden({ timeout: 20_000 });
    try {
      await expect(
        page.getByTestId("doc-list-item").filter({ hasText: bulkTitle }),
      ).toBeVisible({ timeout: 20_000 });
    } catch (error) {
      await openAllDocs(page, workspaceId);
      const visibleInAllPages = await page
        .getByTestId("doc-list-item")
        .filter({ hasText: bulkTitle })
        .count();
      throw new Error(
        `Non-target trash document disappeared after selected delete; visibleInAllPages=${visibleInAllPages}`,
        { cause: error },
      );
    }
    await waitForWorkspaceDocAbsent(
      request,
      cookies,
      workspaceId,
      createdDocIds[0],
    );
    await openTrash(page, workspaceId);

    await page.getByTestId("empty-trash-button").click();
    const emptyDialog = page.getByRole("dialog");
    await expect(emptyDialog).toContainText(
      /permanently deletes|dauerhaft gelöscht|dauerhaft geloescht/i,
    );
    await testInfo.attach("trash-empty-confirm", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await emptyDialog.getByTestId("confirm-modal-confirm").click();
    await expect(emptyDialog).toBeHidden({ timeout: 30_000 });
    await expect(
      page.getByTestId("doc-list-item").filter({ hasText: bulkTitle }),
    ).toBeHidden({ timeout: 30_000 });

    await openTrash(page, workspaceId);
    await expect(page.getByTestId("empty-trash-button")).toHaveCount(0);
    await expect(page.locator("body")).toContainText(
      /Deleted content will appear here|Gelöschte Inhalte werden hier angezeigt/i,
      { timeout: 20_000 },
    );
    await testInfo.attach("trash-after-empty", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await waitForWorkspaceDocAbsent(
      request,
      cookies,
      workspaceId,
      createdDocIds[1],
    );
    expect(readFatalErrors()).toEqual([]);
  } finally {
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
