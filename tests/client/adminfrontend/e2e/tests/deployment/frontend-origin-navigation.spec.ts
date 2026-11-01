// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

import { injectRequestSessionCookies } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const ADMIN_DEEP_LINKS = [
  "/adminfrontend/dashboard",
  "/adminfrontend/organization?tab=members",
  "/adminfrontend/system?tab=logging",
  "/adminfrontend/storage?tab=orphaned",
] as const;
const ADMIN_NAVIGATION = '[data-myoxus-ui-role="sidebar-nav-root"]';
const QA_DIR = path.join(
  process.cwd(),
  "playwright/.qa/office-operations/p02-frontend-origin",
);

function collectBrowserErrors(page: Page, errors: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`page: ${error.message}`);
  });
}

test.describe("frontend public-origin navigation", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await injectRequestSessionCookies(context, adminRequest);
  });

  test("opens Admin from Web and hard-reloads deep links on the public origin", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    collectBrowserErrors(page, errors);

    const webResponse = await page.goto("/", {
      waitUntil: "domcontentloaded",
    });
    expect(webResponse?.status()).toBe(200);
    await expect(page.getByTestId("sidebar-user-avatar")).toBeVisible();

    const publicOrigin = new URL(page.url()).origin;
    await page.getByTestId("sidebar-user-avatar").click();
    const adminAction = page.getByTestId(
      "workspace-modal-account-admin-option",
    );
    await expect(adminAction).toBeVisible();

    const adminPagePromise = page.waitForEvent("popup");
    await adminAction.click();
    const adminPage = await adminPagePromise;
    collectBrowserErrors(adminPage, errors);

    expect(new URL(adminPage.url()).origin).toBe(publicOrigin);
    await expect(adminPage).toHaveURL(/\/adminfrontend\//);
    await adminPage.waitForLoadState("networkidle", { timeout: 20_000 });
    await expect(adminPage.locator(ADMIN_NAVIGATION)).toBeVisible({
      timeout: 15_000,
    });

    for (const path of ADMIN_DEEP_LINKS) {
      const navigation = await adminPage.goto(`${publicOrigin}${path}`, {
        waitUntil: "networkidle",
      });
      expect(navigation?.status()).toBe(200);
      expect(new URL(adminPage.url()).origin).toBe(publicOrigin);
      await expect(adminPage.locator(ADMIN_NAVIGATION)).toBeVisible({
        timeout: 15_000,
      });

      const reload = await adminPage.reload({ waitUntil: "networkidle" });
      expect(reload?.status()).toBe(200);
      expect(new URL(adminPage.url()).origin).toBe(publicOrigin);
      await expect(adminPage.locator(ADMIN_NAVIGATION)).toBeVisible({
        timeout: 15_000,
      });
      await expect(adminPage.locator("body")).not.toContainText(
        /Unauthorized|AuthenticationRequired|Bad Gateway/i,
      );

      if (path.startsWith("/adminfrontend/system")) {
        await mkdir(QA_DIR, { recursive: true });
        const screenshotPath = `${QA_DIR}/admin-system-deep-link.png`;
        await adminPage.screenshot({ fullPage: true, path: screenshotPath });
        await testInfo.attach("frontend-admin-system-deep-link", {
          path: screenshotPath,
          contentType: "image/png",
        });
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
