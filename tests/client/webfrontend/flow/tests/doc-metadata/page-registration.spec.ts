import { expect, test } from "@playwright/test";

import {
  apiSignIn,
  createTestUser,
  ensureAdminUser,
  FRONTEND_BASE,
  gqlRequest,
  injectSessionCookies,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import { deleteWorkspace } from "../../../../adminfrontend/e2e/fixtures/workspaces";
import { pageRegistrationFixture } from "./page-registration-fixture";

test("recovery preserves unresolved content but excludes permanently deleted stale caches", async ({
  browser,
  request,
}) => {
  await ensureAdminUser(request);
  const user = await createTestUser(request, {
    name: "Page registration recovery",
  });
  let workspaceId: string | undefined;
  let context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const cookies = await apiSignIn(request, user.email, user.password);
    const response = await gqlRequest<{ workspaces: Array<{ id: string }> }>(
      request,
      "query { workspaces { id } }",
    );
    workspaceId = response.workspaces[0]?.id;
    if (!workspaceId) throw new Error("Generated user has no workspace");
    await injectSessionCookies(context, cookies);
    await context.addInitScript(() => {
      localStorage.setItem("app_config", '{"onBoarding":false}');
      localStorage.setItem("global-state:open-link-mode", '"open-in-web"');
      localStorage.setItem("is-first-open", "false");
    });
    let page = await context.newPage();
    const route = `${FRONTEND_BASE}/workspace/${workspaceId}/all`;
    await page.goto(route);
    await page.waitForFunction(
      () => !!(window as any).currentWorkspace?.engine,
    );
    const fixture = pageRegistrationFixture();
    // Leave the application before constructing the old cache so no worker can
    // upload it. Preserve the real IndexedDB schema across a closed context.
    await page.goto(`${FRONTEND_BASE}/style/logo.svg`);
    await page.evaluate(
      async ({ workspaceId, fixture }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(`myoxus-cloud:workspace:${workspaceId}`);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["snapshots", "clocks"], "readwrite");
            const now = new Date();
            tx.objectStore("snapshots").put({
              docId: fixture.id,
              bin: Uint8Array.from(fixture.update),
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore("clocks").put({ docId: fixture.id, timestamp: now });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } finally {
          db.close();
        }
      },
      { workspaceId, fixture },
    );
    const persisted = await context.storageState({ indexedDB: true });
    await context.close();
    context = await browser.newContext({
      storageState: persisted,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    await page.goto(route);
    const recovery = page.getByTestId("page-registration-recovery");
    await expect(recovery).toBeVisible();
    const rootCount = () =>
      page.evaluate(
        (id) =>
          (window as any).currentWorkspace.rootYDoc
            .getMap("meta")
            .get("pages")
            .toJSON()
            .filter((p: { id: string }) => p.id === id).length,
        fixture.id,
      );
    expect(await rootCount()).toBe(0);
    expect(
      await page.evaluate(
        async (id) =>
          Array.from(
            (
              await (window as any).currentWorkspace.engine.doc.storage.getDoc(
                id,
              )
            ).bin,
          ),
        fixture.id,
      ),
    ).toEqual(fixture.update);
    await recovery
      .getByRole("button", { name: "Recover local documents", exact: true })
      .click();
    await expect(recovery).toBeHidden();
    await expect.poll(rootCount).toBe(1);
    await page.getByText(fixture.title, { exact: true }).first().click();
    await expect(page.locator("doc-title .inline-editor")).toHaveText(
      fixture.title,
    );
    await expect(
      page.locator("myoxus-paragraph .inline-editor").first(),
    ).toHaveText(fixture.content);
    await page.reload();
    await expect(
      page.locator("myoxus-paragraph .inline-editor").first(),
    ).toHaveText(fixture.content);
    expect(await rootCount()).toBe(1);

    // Keep a real, previously synced cache for the offline-client regression.
    const staleCache = await context.storageState({ indexedDB: true });
    await page.goto(route);
    await page
      .getByRole("radio", { name: "List", exact: true })
      .locator("..")
      .click();
    const item = page.locator(
      `[data-testid="doc-list-item"][data-doc-id="${fixture.id}"]`,
    );
    await item.hover();
    await item.getByTestId("doc-list-operation-button").click();
    await page.getByTestId("doc-list-operation-trash").click();
    await page.getByRole("dialog").getByTestId("confirm-modal-confirm").click();
    await expect(item).toHaveCount(0);
    // An independent API request acts as another client; the open browser must
    // consume the server notification without a reload or local delete call.
    const deletion = await gqlRequest<{
      deleteDocumentsPermanently: { deleted: number; failed: number };
    }>(
      request,
      "mutation($input: DeleteDocumentsPermanentlyInput!) { deleteDocumentsPermanently(input: $input) { deleted failed } }",
      { input: { workspaceId, docIds: [fixture.id] } },
    );
    expect(deletion.deleteDocumentsPermanently).toEqual({
      deleted: 1,
      failed: 0,
    });
    const localRecord = () =>
      page.evaluate(
        async (id) =>
          (window as any).currentWorkspace.engine.doc.storage.getDoc(id),
        fixture.id,
      );
    await expect.poll(localRecord).toBeNull();
    await expect(page.getByTestId("page-registration-recovery")).toBeHidden();
    await page.screenshot({
      path: "output/playwright/doc-delete-live.png",
      fullPage: true,
    });

    await context.close();
    context = await browser.newContext({
      storageState: staleCache,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    await page.goto(route);
    await page.waitForFunction(
      () => !!(window as any).currentWorkspace?.engine,
    );
    await expect.poll(localRecord).toBeNull();
    await expect.poll(rootCount).toBe(0);
    await expect(page.getByTestId("page-registration-recovery")).toBeHidden();
    await page.reload();
    await page.waitForFunction(
      () => !!(window as any).currentWorkspace?.engine,
    );
    await expect.poll(localRecord).toBeNull();
    await expect(page.getByTestId("page-registration-recovery")).toBeHidden();
    await page.screenshot({
      path: "output/playwright/doc-delete-reopened-cache.png",
      fullPage: true,
    });
  } finally {
    await context.close();
    await ensureAdminUser(request);
    if (workspaceId) await deleteWorkspace(request, workspaceId);
    const deleted = await gqlRequest<{
      admin: { deleteUser: { success: boolean } };
    }>(
      request,
      "mutation($id: String!) { admin { deleteUser(id: $id) { success } } }",
      { id: user.id },
    );
    expect(deleted.admin.deleteUser.success).toBe(true);
  }
});
