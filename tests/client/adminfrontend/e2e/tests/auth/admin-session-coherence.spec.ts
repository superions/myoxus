// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";

import {
  ADMIN_EMAIL,
  ADMIN_FRONTEND_BASE,
  ADMIN_PASSWORD,
  apiSignIn,
  injectRequestSessionCookies,
  injectSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const ADMIN_ROUTES = [
  "/dashboard",
  "/organization",
  "/workspaces",
  "/system",
  "/design",
  "/templates",
] as const;

async function expectNoRawAuthError(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /Unauthorized|GraphQL query responds unexpected result|AuthenticationRequired/i,
  );
}

async function expectSharedSignInRedirect(page: Page, redirectPath?: string) {
  await expect(page).toHaveURL(/\/sign-in\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get("auth_context")).toBe("admin");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (redirectPath) {
    expect(redirectUri).toBe(`/adminfrontend${redirectPath}`);
  } else {
    expect(redirectUri?.startsWith("/adminfrontend")).toBe(true);
  }
  await expectNoRawAuthError(page);
}

async function openAdminRoute(page: Page, route: string) {
  await page.goto(`${ADMIN_FRONTEND_BASE}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await expect(page).toHaveURL(new RegExp(`/adminfrontend${route}`));
  await expect(page.locator("body")).toBeVisible();
  await expectNoRawAuthError(page);
}

test.describe("admin session coherence", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await injectRequestSessionCookies(context, adminRequest);
  });

  test("expired session does not leave stale admin pages after back, forward or reload", async ({
    context,
    page,
  }) => {
    for (const route of ADMIN_ROUTES) {
      await openAdminRoute(page, route);
    }

    await context.clearCookies();

    await page.goto(`${ADMIN_FRONTEND_BASE}/queue`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expectSharedSignInRedirect(page, "/queue");

    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expectSharedSignInRedirect(page);

    await page.goForward({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expectSharedSignInRedirect(page);

    await page.goto(`${ADMIN_FRONTEND_BASE}/system`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expectSharedSignInRedirect(page, "/system");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectSharedSignInRedirect(page, "/system");
  });

  test("explicit sidebar logout does not leave stale admin pages in browser history", async ({
    adminRequest,
    context,
    page,
  }) => {
    // Use a fresh session for the destructive logout path so the shared
    // admin storage-state remains available for the rest of the suite.
    await context.clearCookies();
    await injectSessionCookies(
      context,
      await apiSignIn(adminRequest, ADMIN_EMAIL, ADMIN_PASSWORD),
    );

    await openAdminRoute(page, "/dashboard");
    await openAdminRoute(page, "/workspaces");

    await page
      .getByRole("button", { name: /Open user menu|Benutzermenü öffnen/ })
      .click();
    await page.getByRole("menuitem", { name: /Logout|Abmelden/ }).click();

    await expectSharedSignInRedirect(page, "/workspaces");

    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
    await expectSharedSignInRedirect(page);

    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expectSharedSignInRedirect(page, "/organization");
  });
});
