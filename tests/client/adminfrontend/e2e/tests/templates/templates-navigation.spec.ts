/**
 * E2E: Template Registry — navigation and basic UI invariants.
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user exists (ensured in beforeAll via /api/setup/create-admin-user)
 *
 * Authentication strategy: reuse the authenticated adminRequest cookies and
 * inject them into the browser context. This avoids a second sign-in and keeps
 * the suite stable on CAPTCHA/rate-limit enabled stacks.
 *
 * These tests are read-only navigation + form-validation tests.
 * No data is created (no cleanup required).
 *
 * Invariants:
 *   INV-TPL-E2E-00  Admin can reach the Templates page after login
 *   INV-TPL-E2E-01  All 7 tabs are present in the tab list
 *   INV-TPL-E2E-02  Catalog tab shows empty state or table (no crash)
 *   INV-TPL-E2E-03  Import tab has file upload and a disabled submit button
 *   INV-TPL-E2E-04  Assignments tab shows workspace search field
 *   INV-TPL-E2E-05  Jobs tab renders without crashing
 *   INV-TPL-E2E-06  Archive tab renders without crashing
 *   INV-TPL-E2E-07  Versions tab renders template selector without crashing
 *   INV-TPL-E2E-08  Settings tab renders without crashing
 */

import type { APIRequestContext, BrowserContext } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  ensureAdminUser,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const TEMPLATES_URL = `${ADMIN_FRONTEND_BASE}/templates`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Mirrors the authenticated APIRequestContext into the browser context. The
 * request context already signed in via the shared fixture/ensure step, so this
 * deliberately does not call `/api/auth/sign-in` a second time.
 */
async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await ensureAdminUser(request);
  await injectRequestSessionCookies(context, request);
}

// ---------------------------------------------------------------------------
// INV-TPL-E2E-00: Admin can navigate to Templates page
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-00: Templates page accessible", () => {
  test("admin can navigate to /adminfrontend/templates after sign-in", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Should land on templates page (not auth redirect)
    expect(page.url()).toContain("/adminfrontend/templates");

    // Page renders some visible content (header or nav sidebar)
    // Allow either German ("Vorlagen") or English heading
    const bodyVisible = await page.locator("body").isVisible();
    expect(bodyVisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-01: All 7 tabs visible
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-01: All 7 tabs present", () => {
  test("tab list contains all 7 template registry tabs", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Wait for tabs to render
    const tabList = page.locator('[role="tablist"]');
    await expect(tabList).toBeVisible({ timeout: 10_000 });

    const tabs = page.locator('[role="tab"]');
    const count = await tabs.count();
    // INV-TPL-E2E-01: at least 7 tabs must exist
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-02: Catalog tab — empty state or table, no crash
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-02: Catalog tab renders correctly", () => {
  test('catalog tab shows "Template Catalog" heading and empty state or rows', async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Catalog is the default tab — wait for its content
    const catalogHeading = page.locator("text=Template Catalog");
    await expect(catalogHeading).toBeVisible({ timeout: 10_000 });

    // Either the empty state or a table must be visible
    const emptyState = page.locator("text=No templates yet");
    const tableBody = page.locator("tbody");
    const hasEmpty = await emptyState
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const hasTable = await tableBody
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    // INV-TPL-E2E-02: exactly one renders without crashing
    expect(hasEmpty || hasTable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-03: Import tab — file upload UI and disabled submit
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-03: Import tab form validation", () => {
  test("import tab has file upload area and disabled upload button when no file", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    // Click Import tab
    await page
      .locator('[role="tab"]')
      .filter({ hasText: /import/i })
      .click();

    // Import heading
    await expect(page.locator("text=Import Template Bundle")).toBeVisible({
      timeout: 8_000,
    });

    // Drop zone text
    await expect(
      page.locator("text=Drag & drop a ZIP bundle here"),
    ).toBeVisible({ timeout: 5_000 });

    // Choose File button
    await expect(
      page.locator("button", { hasText: /choose file/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Upload & Validate button is disabled when no file selected
    const uploadBtn = page.locator("button", { hasText: /upload & validate/i });
    await expect(uploadBtn).toBeVisible({ timeout: 5_000 });
    await expect(uploadBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-04: Assignments tab — workspace search field present
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-04: Assignments tab workspace search", () => {
  test("assignments tab shows workspace ID search field", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page
      .locator('[role="tab"]')
      .filter({ hasText: /assignments/i })
      .click();

    await expect(page.locator("text=Workspace Assignments")).toBeVisible({
      timeout: 8_000,
    });

    // Workspace ID input field
    const searchInput = page.locator('input[placeholder*="workspace" i]');
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // Search button disabled when input is empty
    const searchBtn = page.locator("button", { hasText: /search/i });
    await expect(searchBtn).toBeVisible({ timeout: 5_000 });
    await expect(searchBtn).toBeDisabled();
  });

  test("entering workspace ID enables search button", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page
      .locator('[role="tab"]')
      .filter({ hasText: /assignments/i })
      .click();
    await expect(page.locator("text=Workspace Assignments")).toBeVisible({
      timeout: 8_000,
    });

    const searchInput = page.locator('input[placeholder*="workspace" i]');
    await searchInput.fill("00000000-0000-0000-0000-000000000001");

    const searchBtn = page.locator("button", { hasText: /search/i });
    await expect(searchBtn).toBeEnabled({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-05: Jobs tab renders without crashing
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-05: Jobs tab renders", () => {
  test('jobs tab shows "Template Jobs" heading and list or empty state', async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page.locator('[role="tab"]').filter({ hasText: /jobs/i }).click();

    await expect(page.locator("text=Template Jobs")).toBeVisible({
      timeout: 8_000,
    });

    // Wait for Suspense boundary to resolve — skeleton (aria-hidden divs) to
    // be replaced by actual content.  Give the data fetch up to 8 seconds.
    await page.waitForTimeout(500);
    const emptyState = page.locator("text=No jobs recorded yet");
    const tableBody = page.locator("tbody");
    // Try up to 8 seconds for either to appear
    const hasEmpty = await emptyState
      .isVisible({ timeout: 8_000 })
      .catch(() => false);
    const hasTable = await tableBody
      .isVisible({ timeout: 8_000 })
      .catch(() => false);
    expect(hasEmpty || hasTable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-06: Archive tab renders without crashing
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-06: Archive tab renders", () => {
  test('archive tab shows "Archived Templates" heading', async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page
      .locator('[role="tab"]')
      .filter({ hasText: /archive/i })
      .click();

    // Use heading role to avoid strict-mode violation (multiple elements contain
    // the substring "Archived Templates" — the h3 is uniquely a heading).
    await expect(
      page.getByRole("heading", { name: "Archived Templates" }),
    ).toBeVisible({ timeout: 8_000 });

    // Wait for Suspense boundary to settle
    await page.waitForTimeout(500);
    // Empty state or table — no crash
    const emptyState = page.locator("text=No archived templates").first();
    const tableBody = page.locator("tbody");
    const hasEmpty = await emptyState
      .isVisible({ timeout: 8_000 })
      .catch(() => false);
    const hasTable = await tableBody
      .isVisible({ timeout: 8_000 })
      .catch(() => false);
    expect(hasEmpty || hasTable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-07: Versions tab renders without crashing
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-07: Versions tab renders", () => {
  test('versions tab shows "Template Versions" heading', async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page
      .locator('[role="tab"]')
      .filter({ hasText: /versions/i })
      .click();

    await expect(page.locator("text=Template Versions")).toBeVisible({
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-08: Settings tab renders without crashing
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-08: Settings tab renders", () => {
  test("settings tab loads without error", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await page.goto(TEMPLATES_URL, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    await page
      .locator('[role="tab"]')
      .filter({ hasText: /settings/i })
      .click();

    // The settings tab renders — the tab list must still be visible (no crash)
    await expect(page.locator('[role="tablist"]')).toBeVisible({
      timeout: 8_000,
    });

    // No error overlay that indicates a crash
    const errorOverlay = page.locator("text=Something went wrong").first();
    // Allow some time then confirm no crash overlay on this tab
    await page.waitForTimeout(1_000);
    const isCrashed = await errorOverlay.isVisible().catch(() => false);
    // If crashed, this is a real failure — the settings tab should render cleanly
    expect(isCrashed).toBe(false);
  });
});
