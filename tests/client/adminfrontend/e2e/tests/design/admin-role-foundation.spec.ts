// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E: Admin role foundation invariants.
 *
 * Covers the P-AR-0 foundation at the running-stack boundary without creating
 * persistent database artifacts:
 *   - the Organization page renders the shared Admin role shell,
 *   - `--org-*` tokens are live aliases onto the v2 theme cascade,
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

  test("P-AR-0-T01: Organization shell renders and v2 theme cascade drives Admin role tokens", async ({
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
      const style = getComputedStyle(root);
      const orgPaper = style.getPropertyValue("--org-paper").trim();
      const v2Paper = style
        .getPropertyValue("--myoxus-background-primary-color")
        .trim();
      const orgInk = style.getPropertyValue("--org-ink").trim();
      const v2Ink = style
        .getPropertyValue("--myoxus-text-primary-color")
        .trim();
      return { orgPaper, v2Paper, orgInk, v2Ink };
    });

    expect(values.orgPaper, "--org-paper must resolve").toBeTruthy();
    expect(values.v2Paper, "v2 paper token must resolve").toBeTruthy();
    expect(values.orgPaper).toBe(values.v2Paper);
    expect(values.orgInk, "--org-ink must resolve").toBeTruthy();
    expect(values.v2Ink, "v2 ink token must resolve").toBeTruthy();
    expect(values.orgInk).toBe(values.v2Ink);
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
