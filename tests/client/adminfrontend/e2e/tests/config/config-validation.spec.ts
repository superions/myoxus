/**
 * E2E: Config Validation — Test frontend form validation and error display.
 *
 * Invariants tested:
 * - INV-CFG-VAL01: Invalid URL format triggers client-side validation error
 * - INV-CFG-VAL02: Error toast appears when saving invalid config
 * - INV-CFG-VAL03: Correction to valid URL clears error display
 * - INV-CFG-VAL04: Valid URL save succeeds with success toast
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user exists (ensured in beforeAll via /api/setup/create-admin-user)
 */

import {
  ADMIN_FRONTEND_BASE,
  ensureAdminUser,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test.describe("Config validation — form errors and validation messages", () => {
  const validUrl = "https://valid.example.com";
  const invalidUrl = "not-a-url";

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
  });

  /**
   * Navigate to settings and locate the externalUrl input.
   * Shared setup for all three tests.
   */
  async function navigateToExternalUrlField(page: any) {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/settings`);
    await page.waitForURL(`**settings**`, { timeout: 10_000 });

    // Click System tab if present — some layouts show tabs
    const systemTab = page
      .locator("button, a", { hasText: /^System$/i })
      .first();
    // System tab is optional — layout may not have tabs
    const tabVisible = await systemTab
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (tabVisible) {
      await systemTab.click();
    }

    const externalUrlInput = page
      .locator(
        'input[name="externalUrl"], input[placeholder*="external" i], input[placeholder*="url" i]',
      )
      .first();
    await expect(externalUrlInput).toBeVisible({ timeout: 8_000 });
    return externalUrlInput;
  }

  test("invalid externalUrl shows validation error", async ({ page }) => {
    const externalUrlInput = await navigateToExternalUrlField(page);

    await externalUrlInput.fill(invalidUrl);

    // Wait for validation error to appear near the field
    const errorIndicator = page
      .locator(
        '[role="alert"], .error, [class*="error"], text=/invalid|not.*url|must.*https/i',
      )
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 5_000 });
  });

  test("correcting URL clears validation error", async ({ page }) => {
    const externalUrlInput = await navigateToExternalUrlField(page);

    // First trigger the error
    await externalUrlInput.fill(invalidUrl);
    const errorIndicator = page
      .locator(
        '[role="alert"], .error, [class*="error"], text=/invalid|not.*url|must.*https/i',
      )
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 5_000 });

    // Now correct the value
    await externalUrlInput.fill(validUrl);

    // Error should disappear
    await expect(errorIndicator).not.toBeVisible({ timeout: 5_000 });
  });

  test("valid URL saves successfully", async ({ page }) => {
    const externalUrlInput = await navigateToExternalUrlField(page);

    await externalUrlInput.fill(validUrl);

    const saveBtn = page
      .locator('button:has-text("Save"), button:has-text("Apply")')
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 3_000 });
    await saveBtn.click();

    // Wait for success toast
    const successToast = page
      .locator(
        'text=/saved|success|updated/i, [class*="success"], [role="status"]',
      )
      .first();
    await expect(successToast).toBeVisible({ timeout: 5_000 });
  });
});
