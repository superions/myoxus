// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E: Admin role foundation invariants.
 *
 * Covers the P-AR-0 foundation at the running-stack boundary without creating
 * persistent database artifacts:
 *   - the Organization page renders the shared Admin role shell,
 *   - native Facade text and surfaces consume the server theme projection,
 *   - all browser font requests stay on the selfhost `/api/fonts/...` path,
 *   - the rendered shell has no critical axe violations.
 */
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { waitForAdminRuntimeReady } from "../../fixtures/admin-ui-runtime-errors";
import {
  ADMIN_FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const ORGANIZATION_URL = `${ADMIN_FRONTEND_BASE}/organization`;
const FONT_CDN_PATTERN =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|fontawesome|fonts\.com|fontsource/i;

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await injectRequestSessionCookies(context, request);
}

async function openOrganization(page: Page): Promise<void> {
  await page.goto(ORGANIZATION_URL, {
    waitUntil: "load",
    timeout: 20_000,
  });
  await waitForAdminRuntimeReady(
    page,
    '[data-admin-route-anchor="admin-route-organization"]',
  );
  await expect(page.getByTestId("organization-tab-overview")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Admin role foundation", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInAsAdmin(context, adminRequest);
  });

  test("P-AR-0-T01: Organization shell renders and Facade surfaces consume server-owned theme roles", async ({
    page,
  }) => {
    await openOrganization(page);

    for (const tab of ["overview", "units", "organigram", "policy"]) {
      await expect(page.getByTestId(`organization-tab-${tab}`)).toBeVisible();
    }
    await expect(page.getByTestId("organization-tab-workspaces")).toHaveCount(
      0,
    );

    const values = await page.evaluate(() => {
      const root = document.documentElement;
      const frame = document.querySelector<HTMLElement>(
        "[data-myoxus-ui-role=admin-page-frame]",
      )!;
      const heading = frame.querySelector(
        "[data-myoxus-ui-role=settings-page-header] h1",
      )!;
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--myoxus-background-primary-color)";
      probe.style.color = "var(--myoxus-text-primary-color)";
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const paper = expected.backgroundColor;
      const ink = expected.color;
      probe.remove();
      let painted: HTMLElement | null = frame;
      while (
        painted?.parentElement &&
        getComputedStyle(painted).backgroundColor === "rgba(0, 0, 0, 0)"
      )
        painted = painted.parentElement;
      return {
        source: root.dataset.myoxusThemeSource,
        paperToken: getComputedStyle(root)
          .getPropertyValue("--myoxus-background-primary-color")
          .trim(),
        inkToken: getComputedStyle(root)
          .getPropertyValue("--myoxus-text-primary-color")
          .trim(),
        actualPaper: getComputedStyle(painted!).backgroundColor,
        actualInk: getComputedStyle(heading).color,
        paper,
        ink,
      };
    });
    expect(values.source).toBe("api");
    expect(values.paperToken, "server paper role must resolve").toBeTruthy();
    expect(values.inkToken, "server ink role must resolve").toBeTruthy();
    expect(values.actualPaper).toBe(values.paper);
    expect(values.actualInk).toBe(values.ink);
  });

  test("P-AR-0-05: admin browser font loading uses only selfhost API URLs", async ({
    page,
  }) => {
    const externalFontRequests: string[] = [];
    const selfhostFontRequests: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      if (FONT_CDN_PATTERN.test(url)) {
        externalFontRequests.push(url);
        return;
      }
      if (request.resourceType() !== "font") return;
      const parsed = new URL(url);
      if (
        parsed.hostname === "localhost" &&
        parsed.pathname.startsWith("/api/fonts/")
      ) {
        selfhostFontRequests.push(url);
        return;
      }
      externalFontRequests.push(url);
    });

    await openOrganization(page);
    await page.evaluate(() => document.fonts.ready);

    expect(
      externalFontRequests,
      "Admin pages must not load fonts from external hosts or non-/api/fonts paths",
    ).toEqual([]);
    expect(
      selfhostFontRequests.length,
      "Admin role typography must request server-bundled fonts from /api/fonts/",
    ).toBeGreaterThan(0);
  });

  test("P-AR-0-T01: Organization shell has no critical axe violations", async ({
    page,
  }) => {
    await openOrganization(page);
    const result = await new AxeBuilder({ page }).include("body").analyze();
    const critical = result.violations.filter(
      (violation) => violation.impact === "critical",
    );

    expect(
      critical.map(
        (violation) =>
          `${violation.id}: ${violation.description} (${violation.nodes.length} nodes)`,
      ),
    ).toEqual([]);
  });
});
