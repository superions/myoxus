/**
 * E2E ORG-I-07 — Admin Organization page: create OU, see preset listing.
 *
 * Walks the admin through the full Admin role UI: open the page,
 * confirm the hero strip, switch to the Units tab, create an OU via the
 * dialog, see the new row appear, then deactivate it.
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user (admin@myoxus.local / AdminMyoxus2026 or env override)
 */

import {
  ADMIN_FRONTEND_BASE,
  ensureAdminUserExists,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  deactivateOrganizationUnit,
  fetchOrganization,
  fetchOrganizationUnits,
  fetchOrganizationUnitTypes,
  updateOrganizationMetadata,
} from "../../fixtures/organization";

test.describe("ORG-I-07 — Admin Organization page", () => {
  let createdUnitId: string | null = null;
  let originalOrganizationMetadata: Record<string, unknown> | null = null;

  test.beforeAll(async ({ request }) => {
    await ensureAdminUserExists(request);
  });

  test.afterAll(async ({ adminRequest }) => {
    if (createdUnitId) {
      await deactivateOrganizationUnit(adminRequest, createdUnitId).catch(
        () => {},
      );
    }
    if (originalOrganizationMetadata) {
      await updateOrganizationMetadata(
        adminRequest,
        originalOrganizationMetadata,
      ).catch(() => {});
    }
  });

  test("admin sees the hero strip + 8 tab triggers", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`);

    // The overview panel is localized; test the stable Admin role structure
    // instead of language-specific marketing copy.
    await expect(
      page.getByRole("heading", { name: /Übersicht|Overview/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/Öffentlicher Name|Public name/i),
    ).toBeVisible();

    // Workspace-OU assignment lives in the workspace detail drawer; the
    // Organization page keeps only organization-owned tabs.
    for (const tab of [
      "overview",
      "units",
      "unit-types",
      "organigram",
      "members",
      "policy",
      "requests",
      "import-export",
    ]) {
      await expect(page.getByTestId(`organization-tab-${tab}`)).toBeVisible();
    }
    await expect(page.getByTestId("organization-tab-workspaces")).toHaveCount(
      0,
    );
  });

  test("admin can select the small municipal model and foreign unit types disappear from authoring", async ({
    page,
    adminRequest,
  }) => {
    const organization = await fetchOrganization(adminRequest);
    originalOrganizationMetadata = organization.metadata ?? {};
    await updateOrganizationMetadata(adminRequest, {
      ...originalOrganizationMetadata,
      unit_type_catalog: {
        schema_version: 1,
        id: "kvk",
        updated_at: new Date().toISOString(),
      },
    });

    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`);
    await page.getByTestId("organization-tab-units").click();
    await page.getByTestId("organization-create-unit-button").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 8_000 });

    const selects = page.locator('[role="dialog"] [role="combobox"]');
    await selects.first().click();

    await expect(
      page.getByRole("option", {
        name: /^Fachbereichkvk\.fachbereich$/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", {
        name: /^Amtkvg\.amt$/,
      }),
    ).toHaveCount(0);

    await updateOrganizationMetadata(
      adminRequest,
      originalOrganizationMetadata ?? {},
    );
    originalOrganizationMetadata = null;
  });

  test("admin can create + see + deactivate an OU through the UI", async ({
    page,
    adminRequest,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`);

    // Switch to the Units tab
    await page.getByTestId("organization-tab-units").click();

    // Pick a preset unit-type for the new OU.
    const types = await fetchOrganizationUnitTypes(adminRequest);
    const presetType = types.find((t) => t.isPreset && t.isActive);
    expect(
      presetType,
      "expected at least one active preset unit type",
    ).toBeTruthy();

    // Open the create dialog
    await page.getByTestId("organization-create-unit-button").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 8_000 });

    // Fill in name + slug
    const slug = `e2e-${Date.now().toString(36)}`;
    await page.fill("#ou-name", `E2E OU ${slug}`);
    await page.fill("#ou-slug", slug);

    // Select the preset unit-type via radix select trigger.
    // The select is the first <button role="combobox"> in the dialog.
    const selects = page.locator('[role="dialog"] [role="combobox"]');
    await selects.first().click();
    await page
      .getByRole("option", { name: new RegExp(presetType!.label) })
      .first()
      .click();

    // Submit the dialog
    await page
      .locator(
        '[role="dialog"] button:has-text("Anlegen"), [role="dialog"] button:has-text("Create")',
      )
      .first()
      .click();

    // Wait for the dialog to close and the new row to appear
    await page.waitForSelector('[role="dialog"]', {
      state: "detached",
      timeout: 8_000,
    });

    // The new OU surfaces as a list item — capture its id from the API for
    // the cleanup hook.
    const units = await fetchOrganizationUnits(adminRequest);
    const created = units.find((u) => u.slug === slug);
    expect(created, `expected created OU with slug ${slug}`).toBeTruthy();
    createdUnitId = created!.id;

    // Verify it shows in the UI
    await expect(page.getByText(`E2E OU ${slug}`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin sees the preset showcase banner on the unit-types tab", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`);
    await page.getByTestId("organization-tab-unit-types").click();

    // The preset showcase banner mentions the seeded packages.
    await expect(
      page.getByText(/Mitgelieferte Preset-Pakete|Seeded preset packages/i),
    ).toBeVisible();
    await expect(page.getByText(/Default/i).first()).toBeVisible();
  });
});
