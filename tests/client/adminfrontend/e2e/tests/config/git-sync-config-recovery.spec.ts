// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleMessage, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

function importantConsole(message: ConsoleMessage) {
  const text = message.text();
  if (/Sentry Logger \[warn\]: No DSN provided/.test(text)) return false;
  if (/Download the React DevTools/.test(text)) return false;
  if (text === "Debug logs enabled") return false;
  return message.type() === "error" || message.type() === "warning";
}

async function expectAllTabsReachable(page: Page) {
  for (const name of [
    /Policy|Richtlinie/,
    /Activity|Aktivität/,
    /Operations|Operationen/,
    /Storage|Speicher/,
    /Profiles|Profile/,
  ]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
}

test("stale Git-Sync config is scoped, scrubbed, and recoverable against the served Admin bundle", async ({
  adminRequest,
  page,
}, testInfo) => {
  await injectRequestSessionCookies(page.context(), adminRequest);

  let staleValuesResponses = 0;
  await page.route("**/graphql", async (route) => {
    const request = route.request();
    const payload = request.postDataJSON() as { operationName?: string } | null;
    if (
      payload?.operationName !== "adminConfigValues" ||
      staleValuesResponses > 0
    ) {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const body = await response.json();
    const modules = body?.data?.admin?.adminConfigValues?.modules ?? [];
    const gitSync = modules.find(
      (module: { module?: string }) => module.module === "gitSync",
    );
    const fields = (gitSync?.groups ?? []).flatMap(
      (group: { fields?: Array<{ path?: string; value?: unknown }> }) =>
        group.fields ?? [],
    );
    const enabled = fields.find(
      (field: { path?: string }) => field.path === "gitSync.enabled",
    );
    if (!enabled) {
      const moduleNames = modules
        .map((module: { module?: string }) => module.module ?? "unknown")
        .join(",");
      const errorCodes = (body?.errors ?? [])
        .map(
          (error: { extensions?: { code?: string } }) =>
            error.extensions?.code ?? "unknown",
        )
        .join(",");
      throw new Error(
        `served adminConfigValues omitted gitSync.enabled (modules=${moduleNames}; errorCodes=${errorCodes})`,
      );
    }
    enabled.value = "synthetic-stale-value";
    staleValuesResponses += 1;
    await route.fulfill({ response, json: body });
  });

  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (importantConsole(message)) consoleMessages.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${ADMIN_FRONTEND_BASE}/git-sync?tab=policy&debug`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('[data-admin-page-frame="true"]')).toBeVisible();
  await expectAllTabsReachable(page);
  await expect(
    page.getByText(/^Diagnose: GITSYNC-VALUE_TYPE-[0-9a-f]{8}$/),
  ).toBeVisible();
  await expect(page.getByText("synthetic-stale-value")).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("git-sync-stale-config.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", {
      name: /Reload server values|Serverwerte neu laden/,
    })
    .click();
  await expect(page.getByText(/GITSYNC-VALUE_TYPE-[0-9a-f]{8}/)).toHaveCount(0);
  await expectAllTabsReachable(page);

  await page.screenshot({
    path: testInfo.outputPath("git-sync-recovered-config.png"),
    fullPage: true,
  });

  expect(staleValuesResponses).toBe(1);
  expect(pageErrors).toEqual([]);
  expect(
    consoleMessages.filter(
      (message) => !message.includes("git sync admin diagnosis"),
    ),
  ).toEqual([]);
  expect(
    consoleMessages.some((message) =>
      message.includes("git sync admin diagnosis"),
    ),
  ).toBe(true);
});
