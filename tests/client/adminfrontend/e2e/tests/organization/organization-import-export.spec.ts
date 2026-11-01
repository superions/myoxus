/**
 * E2E ORG-I-10 — Import/Export pipeline through the admin UI.
 *
 * Walks the admin to the Import/Export tab, runs an export, then runs a
 * dry-run import of a malformed JSON payload to confirm the structured
 * error log surfaces the message.
 */

import {
  ADMIN_FRONTEND_BASE,
  ensureAdminUserExists,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  exportOrganizationSnapshot,
  importOrganizationSnapshotDryRun,
} from "../../fixtures/organization";

test.describe("ORG-I-10 — Organization Import / Export", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUserExists(request);
  });

  test("admin can export the snapshot and re-apply it cleanly via API", async ({
    adminRequest,
  }) => {
    const exported = await exportOrganizationSnapshot(adminRequest);
    expect(exported.schemaVersion).toBe(1);
    expect(exported.json.length).toBeGreaterThan(50);

    // Roundtrip dry-run with the just-exported snapshot.
    const dryRun = await importOrganizationSnapshotDryRun(
      adminRequest,
      exported.json,
    );
    expect(
      dryRun.errors,
      `dry-run of own export must be clean, got: ${JSON.stringify(dryRun.errors)}`,
    ).toEqual([]);
  });

  test("dry-run with a malformed JSON snapshot surfaces structured errors", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/organization`);
    await page.getByTestId("organization-tab-import-export").click();

    // Open the textarea via the localized "paste manually" action.
    await page.getByText(/paste manually|manuell einfügen/i).click();

    // Paste a snapshot with a bad schemaVersion + cycle
    const snapshot = JSON.stringify({
      schemaVersion: 99,
      organization: { key: "myoxus", name: "X", slug: "x", metadata: {} },
      unitTypes: [],
      units: [],
      members: [],
      workspaceLinks: [],
      policies: {
        managerRootProjectCreation: "disabled",
        managerUnitProjectCreation: "disabled",
        managerCanCreateWorkspaces: false,
        managerCanManageOuMembers: false,
        importExportEnabled: true,
      },
    });
    await page.fill('[data-testid="organization-import-textarea"]', snapshot);
    await page.getByTestId("organization-import-dry-run").click();

    // The schemaVersion error must surface in the error log.
    await expect(page.getByText(/unsupported schemaVersion/i)).toBeVisible({
      timeout: 8_000,
    });
  });
});
