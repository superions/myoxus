/**
 * E2E: Config Roundtrip — Test admin UI config changes persist through restart.
 *
 * Test flow:
 * 1. Start stack with known local.yaml config
 * 2. Admin login with seed credentials
 * 3. Navigate Settings → System
 * 4. Read current server.name from UI (should match YAML)
 * 5. Change server.name to "E2E-Test-Name"
 * 6. Save and reload page
 * 7. Verify server.name persisted in UI
 * 8. Call /api/admin/config/export → YAML contains new value
 * 9. Restart stack (docker compose restart api)
 * 10. Login again → server.name still shows new value
 * 11. Cleanup: Reset to original value
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user exists (ensured in beforeAll via /api/setup/create-admin-user)
 */

import type { APIRequestContext } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  ensureAdminUser,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

async function restartProfileApi() {
  // The runtime-profile guard resolves the exact authorized development stack.
  // A health request cannot substitute for the restart this contract asserts.
  await promisify(execFile)(
    "bash",
    [
      "-lc",
      `set -euo pipefail
REPO_ROOT="$PWD"
source build/scripts/server/require-runtime-profile.sh verify
docker compose -f build/server/docker-compose.selfhost.yml restart api`,
    ],
    { timeout: 30_000 },
  );
}

async function waitForRestart(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${API_BASE}/ready`)).status();
        } catch (error) {
          // A real restart closes the listening socket before readiness returns.
          if (
            error instanceof Error &&
            /ECONNRESET|ECONNREFUSED|socket hang up/.test(error.message)
          )
            return 0;
          throw error;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
}

test.describe("Config roundtrip — admin UI changes persist", () => {
  let originalServerName: string | undefined;
  const testServerName = `E2E-Test-${Date.now().toString(36)}`;

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    const response = await request.get(`${API_BASE}/api/admin/config/export`);
    expect(response.ok()).toBe(true);
    originalServerName = (await response.json())["server.name"];
    expect(typeof originalServerName).toBe("string");
  });

  test("change server.name in admin UI and verify persistence through reload", async ({
    page,
    adminRequest: _adminRequest,
  }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Navigate to Settings → System
    await page.goto(`${ADMIN_FRONTEND_BASE}/system`);
    await page.waitForURL(`**system**`, { timeout: 10_000 });

    // Read current server.name value
    const serverNameInput = page.getByRole("textbox", {
      name: "Server name",
      exact: true,
    });
    await serverNameInput.waitFor({ state: "visible", timeout: 8_000 });
    // Change server.name
    await serverNameInput.fill(testServerName);

    // Save (click Save button or use keyboard shortcut)
    const saveBtn = page
      .locator('button:has-text("Save"), button:has-text("Apply")')
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 3_000 });
    await saveBtn.click();

    // Wait for save to complete
    await page.waitForLoadState("networkidle");

    // Reload page and verify persistence
    await page.reload({ waitUntil: "networkidle" });

    // Verify server.name is still the new value
    const reloadedInput = page.getByRole("textbox", {
      name: "Server name",
      exact: true,
    });
    await reloadedInput.waitFor({ state: "visible", timeout: 8_000 });
    const reloadedValue = await reloadedInput.inputValue();

    expect(reloadedValue).toBe(
      testServerName,
      "INV-CFG-RT01: server.name should persist after page reload",
    );
  });

  test("verify server.name persists via API export endpoint", async ({
    adminRequest,
  }) => {
    // Call /api/admin/config/export
    const exportRes = await adminRequest.get(
      `${API_BASE}/api/admin/config/export`,
    );
    expect(exportRes.ok()).toBe(true, "export endpoint should return 200");

    const exportJson = await exportRes.json();

    // Verify server.name is in the export
    expect(exportJson["server.name"]).toBe(
      testServerName,
      "INV-CFG-RT02: exported config should contain updated server.name",
    );
  });

  test("verify server.name persists after API restart", async ({
    page,
    adminRequest,
  }) => {
    await restartProfileApi();
    await waitForRestart(adminRequest);

    // Re-login after potential restart
    await page.goto(`${ADMIN_FRONTEND_BASE}`);
    await loginAsAdmin(page);

    // Navigate to Settings → System again
    await page.goto(`${ADMIN_FRONTEND_BASE}/system`);
    await page.waitForURL(`**system**`, { timeout: 10_000 });

    // Verify server.name is still the new value
    const serverNameInput = page.getByRole("textbox", {
      name: "Server name",
      exact: true,
    });
    await serverNameInput.waitFor({ state: "visible", timeout: 8_000 });
    const persistedValue = await serverNameInput.inputValue();

    expect(persistedValue).toBe(
      testServerName,
      "INV-CFG-RT03: server.name should persist after API restart",
    );
  });

  test.afterAll(async ({ adminRequest }) => {
    if (originalServerName === undefined) return;
    // Restore the original database value and its restart-required runtime.
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
    await restartProfileApi();
    await waitForRestart(adminRequest);
  });
});
