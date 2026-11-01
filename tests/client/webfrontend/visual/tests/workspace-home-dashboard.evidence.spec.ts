// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../shared/auth-helper";
import {
  getAccountColorMode,
  getAccountLocale,
  setAccountColorMode,
  setAccountLocale,
  type UserColorMode,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId, smokeGql } from "../../shared/workspace-helper";

const FRONTEND = "http://localhost:3010";
const API = "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "output/visual-qa/p-wdh-05a-dashboard-arrangement/after",
);

type DashboardLayout = {
  workspaceId: string;
  orderedDashletIds: string[];
  dashletSizes: Array<{ dashletId: string; size: string }>;
};

let cookies: string[] = [];
let previousColorMode: UserColorMode | null = null;
let previousLocale: string | null = null;
let previousLayouts: DashboardLayout[] | null = null;

async function installSession(page: Page) {
  await page.context().addCookies(
    cookies.map((rawCookie) => {
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

async function readLayouts(request: Parameters<typeof smokeGql>[0]) {
  const result = await smokeGql<{
    currentUser: {
      preferences: {
        values: { workspaceDashboardLayouts: DashboardLayout[] | null };
      };
    };
  }>(
    request,
    GQL,
    cookies,
    `query WorkspaceHomeVisualLayouts {
      currentUser {
        preferences {
          values {
            workspaceDashboardLayouts {
              workspaceId
              orderedDashletIds
              dashletSizes { dashletId size }
            }
          }
        }
      }
    }`,
  );
  return result.currentUser.preferences.values.workspaceDashboardLayouts;
}

async function setLayouts(
  request: Parameters<typeof smokeGql>[0],
  layouts: DashboardLayout[] | null,
) {
  await smokeGql(
    request,
    GQL,
    cookies,
    `mutation WorkspaceHomeVisualLayouts(
      $input: UpdateUserPreferencesInput!
    ) {
      updatePreferences(input: $input) {
        values { workspaceDashboardLayouts { workspaceId } }
      }
    }`,
    { input: { workspaceDashboardLayouts: layouts } },
  );
}

async function openHome(page: Page, workspaceId: string) {
  await page.goto(`${FRONTEND}/workspace/${workspaceId}/home`, {
    waitUntil: "load",
  });
  await expect(page.getByTestId("main-container")).toBeVisible();
  await expect(
    page.locator(
      '[data-myoxus-ui-role="app-sidebar-fallback-body"][aria-busy="true"]',
    ),
  ).toBeHidden({ timeout: 15_000 });
  const expandSidebar = page.getByRole("button", {
    name: "Expand sidebar",
    exact: true,
  });
  if (await expandSidebar.isVisible().catch(() => false)) {
    await expandSidebar.click();
  }
  await expect(
    page.locator('[data-myoxus-ui-role="workspace-home-grid"]'),
  ).toBeVisible({ timeout: 15_000 });
}

async function screenshot(
  page: Page,
  name: string,
  options: { preserveScroll?: boolean } = {},
) {
  if (!options.preserveScroll) {
    await page
      .getByRole("heading", { name: "Overview", level: 1 })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
  }
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
  });
}

test.beforeAll(async ({ request }) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const target = { request, gqlEndpoint: GQL, cookies };
  previousColorMode = await getAccountColorMode(target);
  previousLocale = await getAccountLocale(target);
  previousLayouts = await readLayouts(request);
  await setAccountLocale(target, "en");
  await setLayouts(request, null);
});

test.afterAll(async ({ request }) => {
  if (!cookies.length) return;
  const target = { request, gqlEndpoint: GQL, cookies };
  await setLayouts(request, previousLayouts);
  await setAccountLocale(target, previousLocale);
  await setAccountColorMode(target, previousColorMode);
});

test("P-WDH-05A served visual state matrix", async ({
  context,
  page,
  request,
}) => {
  await installSession(page);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const target = { request, gqlEndpoint: GQL, cookies };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  for (const theme of ["light", "dark", "system"] as const) {
    await setAccountColorMode(target, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page, workspaceId);
    await screenshot(page, `${theme}-desktop-default`);
    await page.getByRole("button", { name: /Customi[sz]e/ }).click();
    await screenshot(page, `${theme}-desktop-edit`);

    await page.setViewportSize({ width: 640, height: 900 });
    await screenshot(page, `${theme}-compact-edit`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await screenshot(page, `${theme}-compact-default`);
  }

  await setAccountColorMode(target, "light");
  await setLayouts(request, [
    {
      workspaceId,
      orderedDashletIds: [
        "Today",
        "Activity",
        "NewDocuments",
        "Reminders",
        "RecentlyEdited",
      ],
      dashletSizes: [
        { dashletId: "Today", size: "Wide" },
        { dashletId: "Activity", size: "Wide" },
        { dashletId: "NewDocuments", size: "Compact" },
        { dashletId: "Reminders", size: "Standard" },
        { dashletId: "RecentlyEdited", size: "Compact" },
      ],
    },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page, workspaceId);
  await page.getByRole("button", { name: /Customi[sz]e/ }).click();
  await screenshot(page, "light-desktop-mixed-sizes");

  const grid = page.locator('[data-myoxus-ui-role="workspace-home-grid"]');
  const activityHandle = grid
    .locator('[data-dashlet-id="activity"]')
    .locator('[data-myoxus-ui-role="drag-handle"]:visible');
  const today = grid.locator('[data-dashlet-id="today"]');
  const newDocuments = grid.locator('[data-dashlet-id="new-documents"]');
  const sourceBox = await activityHandle.boundingBox();
  const targetBox = await today.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(sourceBox!.x, sourceBox!.y, { steps: 4 });
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 4, {
    steps: 12,
  });
  await screenshot(page, "light-desktop-dragging-drop-target", {
    preserveScroll: true,
  });
  await page.mouse.up();

  let delayNextPreference = true;
  await page.route("**/graphql", async (route) => {
    const payload = route.request().postData() ?? "";
    if (delayNextPreference && payload.includes("updateUserPreferences")) {
      delayNextPreference = false;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    await route.continue();
  });
  await newDocuments.getByRole("button", { name: "Size", exact: true }).click();
  await page
    .locator('[role="menu"]:visible')
    .last()
    .getByRole("menuitem", { name: "Standard", exact: true })
    .click();
  await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
  await screenshot(page, "light-desktop-pending");
  await page.setViewportSize({ width: 640, height: 900 });
  await screenshot(page, "light-compact-pending");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
  await page.unroute("**/graphql");

  let failNextPreference = true;
  await page.route("**/graphql", async (route) => {
    const payload = route.request().postData() ?? "";
    if (failNextPreference && payload.includes("updateUserPreferences")) {
      failNextPreference = false;
      await route.fulfill({ status: 503, body: "visual evidence failure" });
      return;
    }
    await route.continue();
  });
  await newDocuments.getByRole("button", { name: "Size", exact: true }).click();
  await page
    .locator('[role="menu"]:visible')
    .last()
    .getByRole("menuitem", { name: "Compact", exact: true })
    .click();
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeHidden();
  await screenshot(page, "light-desktop-error-retry");
  await page.setViewportSize({ width: 640, height: 900 });
  await screenshot(page, "light-compact-error-retry");
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const compactRetryMenu = page.locator('[role="menu"]:visible').last();
  const compactRetry = compactRetryMenu.getByRole("menuitem", {
    name: "Retry",
    exact: true,
  });
  await expect(compactRetry).toBeVisible();
  await compactRetryMenu.screenshot({
    path: path.join(EVIDENCE_DIR, "light-compact-error-retry-menu-surface.png"),
  });
  await page.unroute("**/graphql");
  await compactRetry.click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText("Save failed", { exact: true })).toBeHidden();

  await context.setOffline(true);
  const reminders = grid.locator('[data-dashlet-id="reminders"]');
  await reminders.getByRole("button", { name: "Size", exact: true }).click();
  await page
    .locator('[role="menu"]:visible')
    .last()
    .getByRole("menuitem", { name: "Full width", exact: true })
    .click();
  await expect(page.getByText("Queued offline", { exact: true })).toBeVisible();
  await screenshot(page, "light-desktop-offline-pending");
  await page.setViewportSize({ width: 640, height: 900 });
  await screenshot(page, "light-compact-offline-pending");
  await page.setViewportSize({ width: 1440, height: 900 });
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Queued offline", { exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page
    .locator('[role="menu"]:visible')
    .last()
    .getByRole("menuitem", { name: "Reset", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.waitForTimeout(300);
  await screenshot(page, "light-desktop-reset-undo");
  await page.setViewportSize({ width: 640, height: 900 });
  await screenshot(page, "light-compact-reset-undo");
  await page.setViewportSize({ width: 1440, height: 900 });

  browserErrors.length = 0;
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("main-container")).toBeVisible();
  await expect(
    page.locator('[data-myoxus-ui-role="workspace-home-grid"]'),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
