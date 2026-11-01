/**
 * E2E invariant tests for OTS font integrity and browser font loading.
 *
 * Invariants:
 *   INV-FONT-WARN-01  GET /api/fonts returns manifest entries with versionHash
 *   INV-FONT-WARN-02  Font file responses are served with immutable cache headers
 *   INV-FONT-WARN-03  Loading the design page produces no browser console font warnings
 *
 * Prerequisites: stack running at localhost:3010 / localhost:3001.
 * Run:  npx playwright test --config tests/client/adminfrontend/e2e/playwright.config.ts \
 *          tests/client/adminfrontend/e2e/tests/design/font-warnings.spec.ts
 */

import { expect, test } from "@playwright/test";

import { waitForAdminRuntimeReady } from "../../fixtures/admin-ui-runtime-errors";
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  loginAsAdmin,
} from "../../fixtures/auth";

const FONT_WARNING_PATTERNS = [
  /Glyph bbox/i,
  /caretOffset/i,
  /empty gid used as component/i,
  /OTS parsing error/i,
  /Failed to load font/i,
  /could not be loaded/i,
];

test.describe("font integrity", () => {
  test("inv_font_warn_01_manifest_entries_have_version_hash", async ({
    request,
  }) => {
    const res = await request.get(`${API_BASE}/api/fonts`);
    expect(res.status()).toBe(200);
    const fonts = await res.json();
    expect(Array.isArray(fonts)).toBe(true);
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(
        font.versionHash,
        `font ${font.file} must have versionHash`,
      ).toBeTruthy();
      expect(font.versionHash.length).toBeGreaterThanOrEqual(8);
      expect(font.url, `font ${font.file} url must embed ?v=`).toContain("?v=");
    }
  });

  test("inv_font_warn_02_font_files_have_immutable_cache_headers", async ({
    request,
  }) => {
    const res = await request.get(`${API_BASE}/api/fonts`);
    const fonts = await res.json();
    // Spot-check first font
    const first = fonts[0];
    const fontUrl = `${API_BASE}/api/fonts/${first.file}`;
    const fontRes = await request.get(fontUrl);
    expect(fontRes.status()).toBe(200);
    const cc = fontRes.headers()["cache-control"] ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });

  test("inv_font_warn_03_design_page_no_font_warnings_in_console", async ({
    page,
  }) => {
    await loginAsAdmin(page);

    const fontWarnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "warning" &&
        FONT_WARNING_PATTERNS.some((p) => p.test(text))
      ) {
        fontWarnings.push(text);
      }
    });

    // Load the design page — it triggers all branding font CSS variables
    await page.goto(`${ADMIN_FRONTEND_BASE}/design`, { waitUntil: "load" });
    await waitForAdminRuntimeReady(
      page,
      '[data-admin-route-anchor="admin-route-design"]',
    );

    expect(
      fontWarnings,
      `Font warnings detected on design page: ${fontWarnings.join("; ")}`,
    ).toHaveLength(0);
  });
});
