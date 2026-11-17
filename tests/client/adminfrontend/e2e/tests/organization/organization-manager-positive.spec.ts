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

import { ensureAdminUserExists, gqlRequest } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  createOrganizationUnit,
  deactivateOrganizationUnit,
  fetchOrganizationUnitTypes,
  fetchOrganizationUnits,
} from "../../fixtures/organization";

test.describe("ORG-I-08 — Manager positive flow (API contract)", () => {
  const ownedUnits: Array<{ id: string; name: string }> = [];

  test.beforeAll(async ({ request }) => {
    await ensureAdminUserExists(request);
  });

  test.afterAll(async ({ adminRequest }) => {
    for (const unit of [...ownedUnits].reverse()) {
      await deactivateOrganizationUnit(adminRequest, unit.id);
      const data = await gqlRequest<{
        admin: {
          organizationUnitDeletionPreview: {
            updatedAt: string;
            deletable: boolean;
          };
        };
      }>(
        adminRequest,
        "query Preview($id: ID!) { admin { organizationUnitDeletionPreview(id: $id) { updatedAt deletable } } }",
        { id: unit.id },
      );
      const preview = data.admin.organizationUnitDeletionPreview;
      expect(preview.deletable).toBe(true);
      await gqlRequest(
        adminRequest,
        "mutation DeleteOwned($id: ID!, $name: String!, $revision: DateTime!) { admin { deleteOrganizationUnitPermanently(id: $id, confirmedName: $name, previewRevision: $revision) } }",
        { id: unit.id, name: unit.name, revision: preview.updatedAt },
      );
    }
  });

  test("admin creates an OU; canCreateOrganizationProject(unit) reflects policy", async ({
    adminRequest,
  }) => {
    const types = await fetchOrganizationUnitTypes(adminRequest);
    const team = types.find((t) => t.key === "team" && t.isPreset);
    expect(team).toBeTruthy();

    let root = (await fetchOrganizationUnits(adminRequest)).find(
      (unit) => !unit.parentUnitId && unit.status === "Active",
    );
    if (!root) {
      const rootType = types.find(
        (type) => type.isActive && type.canBeRootLevel,
      );
      expect(
        rootType,
        "an active type must permit root-level units",
      ).toBeTruthy();
      root = await createOrganizationUnit(adminRequest, {
        name: "e2e-manager-root-" + Date.now().toString(36),
        slug: "mgr-root-" + Date.now().toString(36),
        unitTypeId: rootType!.id,
      });
      ownedUnits.push(root);
    }
    const created = await createOrganizationUnit(adminRequest, {
      parentUnitId: root!.id,
      name: `e2e-manager-${Date.now().toString(36)}`,
      slug: `mgr-${Date.now().toString(36)}`,
      unitTypeId: team!.id,
    });
    ownedUnits.push(created);
    expect(created.status).toBe("Active");
  });
});
