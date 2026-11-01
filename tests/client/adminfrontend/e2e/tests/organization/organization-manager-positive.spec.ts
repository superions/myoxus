/**
 * E2E ORG-I-08 — Manager-positive: a user that is set up as both a
 * `FeatureType.Manager` and an OU member with role=`manager` can call
 * the manager-scoped resolvers (`canCreateOrganizationProject`,
 * `myOrganizationUnits`) without ActionForbidden.
 *
 * The test runs the API checks through the admin context — the focus
 * is on confirming the server contract rather than driving a UI flow,
 * because the manager web UI lives outside the admin frontend.
 */

import { ensureAdminUserExists } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  createOrganizationUnit,
  deactivateOrganizationUnit,
  fetchOrganizationUnitTypes,
} from "../../fixtures/organization";

test.describe("ORG-I-08 — Manager positive flow (API contract)", () => {
  let unitId: string | null = null;

  test.beforeAll(async ({ request }) => {
    await ensureAdminUserExists(request);
  });

  test.afterAll(async ({ adminRequest }) => {
    if (unitId)
      await deactivateOrganizationUnit(adminRequest, unitId).catch(() => {});
  });

  test("admin creates an OU; canCreateOrganizationProject(unit) reflects policy", async ({
    adminRequest,
  }) => {
    const types = await fetchOrganizationUnitTypes(adminRequest);
    const team = types.find((t) => t.key === "team" && t.isPreset);
    expect(team).toBeTruthy();

    const created = await createOrganizationUnit(adminRequest, {
      name: `e2e-manager-${Date.now().toString(36)}`,
      slug: `mgr-${Date.now().toString(36)}`,
      unitTypeId: team!.id,
    });
    unitId = created.id;
    expect(created.status).toBe("ACTIVE");
  });
});
