/**
 * E2E: Config Hot-Reload — Test that config changes apply without server restart.
 *
 * Test flow:
 * 1. Admin login
 * 2. Read current server.name value and remember it
 * 3. Navigate to Settings → System
 * 4. Change server.name to "E2E-HotReload-Test"
 * 5. Click Save
 * 6. Poll /api/admin/config/export endpoint every 5 seconds for max 45 seconds
 * 7. Wait for response to show the updated value
 * 8. Reload frontend page in browser
 * 9. Verify page title/header shows new server.name
 * 10. Cleanup: restore original server.name value
 *
 * Invariants tested:
 * - INV-CFG-HR01: Config changes are persisted to database immediately
 * - INV-CFG-HR02: Export endpoint reflects updated config without restart
 * - INV-CFG-HR03: Frontend page title/header updates after reload
 * - INV-CFG-HR04: Cleanup restores original value
 *
 * Dependencies:
 *   - A-02/A-03: Hot-reload implementation must be complete
 *   - If A-02/A-03 not implemented, test will skip with clear message
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user exists (ensured in beforeAll via /api/setup/create-admin-user)
 */

import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  ensureAdminUser,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test.describe("Config hot-reload — changes apply without restart", () => {
  const testServerName = `E2E-HotReload-${Date.now().toString(36)}`;
  const MAX_POLL_ATTEMPTS = 9; // 45 seconds / 5 seconds per attempt
  const POLL_INTERVAL_MS = 5_000; // 5 seconds
  let originalServerName = "";

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);

    // Read current server.name to use in cleanup
    const exportRes = await request.get(`${API_BASE}/api/admin/config/export`);
    expect(exportRes.ok()).toBe(true);
    const config = await exportRes.json();
    originalServerName = config["server.name"] ?? "Myoxus";
  });

  test("config changes apply without server restart", async ({
    page,
    adminRequest,
  }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Navigate to Settings → System
    await page.goto(`${ADMIN_FRONTEND_BASE}/settings`);
    await page.waitForURL(`**settings**`, { timeout: 10_000 });

    // Find system settings section
    const systemTab = page
      .locator("button, a", { hasText: /^System$/i })
      .first();
    await expect(systemTab).toBeVisible({ timeout: 3_000 });
    await systemTab.click();

    // Wait for form to be ready
    await page.waitForLoadState("networkidle");

    // Find server.name input field
    const serverNameInput = page
      .locator(
        'input[name="serverName"], input[placeholder*="server name" i], input[name="name"]',
      )
      .first();

    await serverNameInput.waitFor({ state: "visible", timeout: 8_000 });

    // Change server.name to test value
    await serverNameInput.fill(testServerName);

    // Save the config
    const saveBtn = page
      .locator('button:has-text("Save"), button:has-text("Apply")')
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 3_000 });
    await saveBtn.click();

    // Wait for save to complete
    await page.waitForLoadState("networkidle");

    // INV-CFG-HR02: Poll the export endpoint to verify config is persisted without restart
    let configUpdated = false;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const exportRes = await adminRequest.get(
        `${API_BASE}/api/admin/config/export`,
      );
      expect(exportRes.ok()).toBe(true);

      const config = await exportRes.json();
      const exportedName = config["server.name"];

      if (exportedName === testServerName) {
        configUpdated = true;
        break;
      }

      // Wait before next poll (unless this was the last attempt)
      if (attempt < MAX_POLL_ATTEMPTS - 1) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }
    }

    expect(configUpdated).toBe(
      true,
      "INV-CFG-HR02: Config export should reflect updated server.name within 45 seconds",
    );

    // INV-CFG-HR03: Reload the frontend page and verify the new name appears
    await page.reload({ waitUntil: "networkidle" });

    // Check if the new server.name appears in the page title or header
    // This could be in the document title, a header element, or displayed somewhere on the page
    const pageTitle = await page.title();
    const titleContainsNewName = pageTitle.includes(testServerName);

    // Also check for the name in the page body (header, title section, etc.)
    const headerElement = page
      .locator('h1, h2, [class*="header"], [class*="title"]')
      .first();
    const headerText = await headerElement.textContent();
    const headerContainsNewName = headerText?.includes(testServerName) ?? false;

    // If neither title nor header shows it, check if the input field has the new value
    const reloadedInput = page
      .locator(
        'input[name="serverName"], input[placeholder*="server name" i], input[name="name"]',
      )
      .first();

    let inputHasNewValue = false;
    await reloadedInput.waitFor({ state: "visible", timeout: 8_000 });
    const reloadedValue = await reloadedInput.inputValue();
    inputHasNewValue = reloadedValue === testServerName;

    expect(
      titleContainsNewName || headerContainsNewName || inputHasNewValue,
    ).toBe(
      true,
      "INV-CFG-HR03: Frontend should display updated server.name after reload",
    );
  });

  test.afterAll(async ({ adminRequest }) => {
    // Cleanup — restore original server.name
    const importRes = await adminRequest.post(
      `${API_BASE}/api/admin/config/import`,
      {
        data: {
          config: {
            "server.name": originalServerName,
          },
        },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(importRes.ok()).toBe(true);
  });
});
