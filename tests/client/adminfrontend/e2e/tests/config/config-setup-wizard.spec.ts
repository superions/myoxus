// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser contract for the first-admin cache transition.
 *
 * The server-side cache invalidation is covered against the real handler and
 * database separately. This test owns the consuming browser tier: a stateful
 * GraphQL boundary deliberately holds the fresh initialized=true response so
 * the UI cannot pass merely because it called a mock or advanced local state.
 */
import type { BrowserContext, Page, Route } from "@playwright/test";

import { ADMIN_FRONTEND_BASE } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

function serverInfo(initialized: boolean) {
  return {
    availableUpgrade: null,
    availableUserFeatures: ["Admin"],
    availableWorkspaceFeatures: [],
    baseUrl: "/",
    buildSha: "office-operations-e2e",
    credentialsRequirement: {
      password: { maxLength: 128, minLength: 8 },
    },
    deploymentType: "selfhosted",
    features: [],
    i18n: { availableLocales: ["en", "de"], defaultLocale: "en" },
    initialized,
    name: "Myoxus",
    oauthProviders: [],
    type: "selfhosted",
    version: "0.0.0-test",
  };
}

function operationName(route: Route): string {
  const body = route.request().postDataJSON() as {
    operationName?: string;
    query?: string;
  };
  if (body.operationName) return body.operationName;
  return body.query?.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "";
}

const visualProfiles = [
  {
    colorScheme: "light" as const,
    name: "desktop-light",
    viewport: { height: 900, width: 1440 },
  },
  {
    colorScheme: "dark" as const,
    name: "desktop-dark",
    viewport: { height: 900, width: 1440 },
  },
  {
    colorScheme: "light" as const,
    name: "mobile-light",
    viewport: { height: 844, width: 390 },
  },
  {
    colorScheme: "dark" as const,
    name: "mobile-dark",
    viewport: { height: 844, width: 390 },
  },
] as const;

async function assertFirstAdminTransition(
  context: BrowserContext,
  page: Page,
  outputPath: (name: string) => string,
) {
  await context.clearCookies();

  const invalidLayoutWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "warning" &&
      message.text().includes("Invalid layout total size")
    ) {
      invalidLayoutWarnings.push(message.text());
    }
  });

  let adminCreated = false;
  let createRequests = 0;
  let freshResponseRequested = false;
  const serverConfigStates: boolean[] = [];
  const transitionEvents: string[] = [];
  let releaseFreshResponse: (() => void) | undefined;
  const freshResponseGate = new Promise<void>((resolve) => {
    releaseFreshResponse = resolve;
  });

  await page.route("**/api/setup/create-admin-user", async (route) => {
    createRequests += 1;
    transitionEvents.push("create-admin");
    adminCreated = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Set-Cookie":
          "affine_session=office-operations-e2e; Path=/; HttpOnly; SameSite=Lax",
      },
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000003",
        email: "first-admin@example.test",
        name: "First Admin",
      }),
    });
  });

  await page.route("**/graphql", async (route) => {
    const operation = operationName(route);
    if (operation === "adminServerConfig") {
      if (adminCreated) {
        freshResponseRequested = true;
        await freshResponseGate;
      }
      serverConfigStates.push(adminCreated);
      transitionEvents.push(`server-config:${String(adminCreated)}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { admin: { serverInfo: serverInfo(adminCreated) } },
        }),
      });
      return;
    }
    if (operation === "getCurrentUserFeatures") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            currentUser: adminCreated
              ? {
                  avatarUrl: null,
                  email: "first-admin@example.test",
                  emailVerified: true,
                  features: ["Admin"],
                  id: "00000000-0000-4000-8000-000000000003",
                  name: "First Admin",
                }
              : null,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });

  await page.goto(`${ADMIN_FRONTEND_BASE}/setup`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome to Myoxus" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name").fill("First Admin");
  await page.getByLabel("Email").fill("first-admin@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect.poll(() => createRequests).toBe(1);
  await expect.poll(() => freshResponseRequested).toBe(true);
  await expect(page).toHaveURL(/\/adminfrontend\/setup$/);
  await expect(page.getByText("All Settings Done")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    fullPage: true,
    path: outputPath("setup-awaits-fresh-server-config.png"),
  });

  releaseFreshResponse?.();
  await expect.poll(() => serverConfigStates).toEqual([false, true]);
  await expect(page).toHaveURL(/\/adminfrontend(?:\/dashboard)?$/);
  expect(transitionEvents).toEqual([
    "server-config:false",
    "create-admin",
    "server-config:true",
  ]);

  await page.goto(`${ADMIN_FRONTEND_BASE}/setup`);
  await expect(page).toHaveURL(/\/adminfrontend(?:\/dashboard)?$/);
  expect(createRequests).toBe(1);
  expect(
    invalidLayoutWarnings,
    "the responsive admin shell must register a 100% panel layout",
  ).toEqual([]);
}

for (const profile of visualProfiles) {
  test.describe(`first-admin transition ${profile.name}`, () => {
    test.use({
      colorScheme: profile.colorScheme,
      viewport: profile.viewport,
    });

    test("leaves setup only after fresh initialized state in the same browser", async ({
      context,
      page,
    }, testInfo) => {
      await assertFirstAdminTransition(context, page, (name) =>
        testInfo.outputPath(`${profile.name}-${name}`),
      );
    });
  });
}
