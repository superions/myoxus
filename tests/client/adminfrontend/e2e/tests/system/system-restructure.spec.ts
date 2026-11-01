// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E2E: Admin phase-3 route and tab consolidation smoke.
 *
 * Read-only by design: the suite signs in as the shared admin and verifies that
 * moved routes, consolidated tabs, and the audit inspection surface are wired in
 * the running bundle. It does not create or mutate domain data.
 */
import type { APIRequestContext, BrowserContext } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

async function signInBrowserAsAdmin(
  context: BrowserContext,
  adminRequest: APIRequestContext,
) {
  await injectRequestSessionCookies(context, adminRequest);
}

test.describe("P-AR-3 — Admin system restructure", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInBrowserAsAdmin(context, adminRequest);
  });

  test("system, performance, storage and audit consolidations are reachable", async ({
    page,
  }) => {
    await page.goto(`${ADMIN_FRONTEND_BASE}/about`, {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/adminfrontend\/system/);
    await expect(page.getByTestId("system-tab-overview")).toBeVisible();
    await expect(page.getByTestId("system-tab-logging")).toBeVisible();

    await page.goto(`${ADMIN_FRONTEND_BASE}/system?tab=logging`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByTestId("system-tab-logging")).toBeVisible();

    await page.goto(`${ADMIN_FRONTEND_BASE}/performance`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByTestId("performance-tab-overview")).toBeVisible();
    await expect(
      page.getByTestId("performance-tab-server-tuning"),
    ).toBeVisible();
    await expect(page.getByTestId("performance-tab-websockets")).toBeVisible();
    await expect(
      page.getByTestId("performance-tab-sync-pipeline"),
    ).toBeVisible();
    await expect(page.getByTestId("performance-tab-limits")).toBeVisible();

    await page.goto(`${ADMIN_FRONTEND_BASE}/orphaned-workspaces`, {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/adminfrontend\/storage\?tab=orphaned/);
    await expect(page.getByTestId("storage-tab-orphaned")).toBeVisible();

    await page.goto(`${ADMIN_FRONTEND_BASE}/audit-log`, {
      waitUntil: "networkidle",
    });
    await expect(page.locator("#audit-target-type")).toBeVisible();
    await page.locator("#audit-target-type").selectOption("workspace");
    await page.locator("#audit-target-id").fill("workspace-smoke-id");
    await page.locator("#audit-event-key").fill("admin.");
    await page.getByRole("button", { name: /Reset|Zurücksetzen/i }).click();

    const rows = page.locator("tbody tr");
    const rowCount = await rows.count();
    if (rowCount === 0) {
      await expect(
        page.getByText(/No audit log entries|Keine Audit-Log-Einträge/i),
      ).toBeVisible();
      return;
    }

    await rows.first().click();
    // Live audit rows may represent create-only changes, so old/new labels are
    // locale- and event-shape-dependent. The diff surface itself is the stable
    // inspection contract.
    await expect(page.getByTestId("audit-json-diff")).toBeVisible();
  });
});
