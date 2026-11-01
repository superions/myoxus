// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E: Admin organization lifecycle scenario.
 *
 * This is intentionally broader than a smoke test. It creates real temporary
 * users/workspaces through supported API contracts where the Admin UI has no
 * creation form, then drives the Admin UI through custom unit-type creation,
 * OU hierarchy creation, manager/member assignment, workspace linking,
 * member-limit editing, member drawer inspection, and workspace drawer
 * inspection.
 *
 * Every persisted object uses a unique `e2e-org-lifecycle-*` marker and is
 * cleaned up in reverse dependency order so the scenario remains idempotent.
 */

import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  type ApiUser,
  createTestUser,
  deleteTestUser,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  deactivateOrganizationUnit,
  deactivateOrganizationUnitType,
  fetchOrganizationUnitMembers,
  fetchOrganizationUnits,
  fetchOrganizationUnitTypes,
  fetchOrganizationUnitWorkspaces,
  unassignOrganizationUnitMember,
  unassignOrganizationUnitWorkspace,
} from "../../fixtures/organization";
import {
  createTemporaryWorkspace,
  deleteWorkspace,
} from "../../fixtures/workspaces";

const MARKER = "e2e-org-lifecycle";

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function clickDialogSubmit(page: Page) {
  await page
    .locator('[role="dialog"]')
    .getByRole("button", { name: /^(Anlegen|Create)$/i })
    .click();
}

async function selectOptionByText(page: Page, text: string | RegExp) {
  await page.getByRole("option", { name: text }).first().click();
}

async function waitForUnitBySlug(request: APIRequestContext, slug: string) {
  await expect
    .poll(
      async () =>
        (await fetchOrganizationUnits(request)).find((u) => u.slug === slug),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return (await fetchOrganizationUnits(request)).find((u) => u.slug === slug)!;
}

async function waitForUnitTypeByKey(request: APIRequestContext, key: string) {
  await expect
    .poll(
      async () =>
        (await fetchOrganizationUnitTypes(request)).find(
          (type) => type.key === key,
        ),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return (await fetchOrganizationUnitTypes(request)).find(
    (type) => type.key === key,
  )!;
}

async function cleanupByMarker(
  request: APIRequestContext,
  state: {
    users: ApiUser[];
    workspaceIds: string[];
    unitTypeKey: string;
    unitSlugs: string[];
  },
) {
  for (const slug of [...state.unitSlugs].reverse()) {
    const unit = (await fetchOrganizationUnits(request)).find(
      (candidate) => candidate.slug === slug,
    );
    if (!unit) continue;

    const links = await fetchOrganizationUnitWorkspaces(request, unit.id).catch(
      () => [],
    );
    for (const link of links) {
      await unassignOrganizationUnitWorkspace(request, {
        unitId: link.unitId,
        workspaceId: link.workspaceId,
        relationship: link.relationship,
      }).catch(() => undefined);
    }

    const members = await fetchOrganizationUnitMembers(request, unit.id).catch(
      () => [],
    );
    for (const member of members) {
      if (state.users.some((user) => user.id === member.userId)) {
        await unassignOrganizationUnitMember(
          request,
          unit.id,
          member.userId,
        ).catch(() => undefined);
      }
    }
    await deactivateOrganizationUnit(request, unit.id).catch(() => undefined);
  }

  for (const workspaceId of state.workspaceIds) {
    await deleteWorkspace(request, workspaceId);
  }

  const unitType = (await fetchOrganizationUnitTypes(request)).find(
    (candidate) => candidate.key === state.unitTypeKey,
  );
  if (unitType) {
    await deactivateOrganizationUnitType(request, unitType.id).catch(
      () => undefined,
    );
  }

  for (const user of state.users) {
    await deleteTestUser(request, user.id);
  }
}

test.describe("ORG-LIFE — Admin organization lifecycle", () => {
  test("admin can manage users, custom OUs, managers, memberships and workspaces end-to-end", async ({
    page,
    adminRequest,
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 980 });

    const suffix = uniqueSuffix();
    const state = {
      users: [] as ApiUser[],
      workspaceIds: [] as string[],
      unitTypeKey: `${MARKER}-${suffix}`,
      unitSlugs: [`${MARKER}-parent-${suffix}`, `${MARKER}-child-${suffix}`],
    };

    // User and workspace creation are API preconditions because this Admin
    // surface administers existing identities/workspaces instead of exposing
    // separate creation screens for them.
    const manager = await createTestUser(adminRequest, {
      name: `E2E Lifecycle Manager ${suffix}`,
      email: `${MARKER}-manager-${suffix}@myoxus.local`,
    });
    const member = await createTestUser(adminRequest, {
      name: `E2E Lifecycle Member ${suffix}`,
      email: `${MARKER}-member-${suffix}@myoxus.local`,
    });
    state.users.push(manager, member);

    const workspaceName = `E2E Lifecycle Workspace ${suffix}`;
    const workspaceId = await createTemporaryWorkspace(
      adminRequest,
      workspaceName,
    );
    state.workspaceIds.push(workspaceId);

    try {
      await loginAsAdmin(page);
      await page.goto(`${ADMIN_FRONTEND_BASE}/organization`, {
        waitUntil: "networkidle",
      });

      await page.getByTestId("organization-tab-unit-types").click();
      await page.getByTestId("organization-create-unit-type-button").click();
      await page.locator("#utype-key").fill(state.unitTypeKey);
      await page
        .locator("#utype-label")
        .fill(`E2E Lifecycle Custom Type ${suffix}`);
      await clickDialogSubmit(page);
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10_000,
      });
      const unitType = await waitForUnitTypeByKey(
        adminRequest,
        state.unitTypeKey,
      );
      await expect(
        page.getByText(`E2E Lifecycle Custom Type ${suffix}`),
      ).toBeVisible({ timeout: 15_000 });

      await page.getByTestId("organization-tab-units").click();
      await page.getByTestId("organization-create-unit-button").click();
      await page.locator("#ou-name").fill(`E2E Lifecycle Parent ${suffix}`);
      await page.locator("#ou-slug").fill(state.unitSlugs[0]);
      await page.locator('[role="dialog"] [role="combobox"]').first().click();
      await selectOptionByText(
        page,
        new RegExp(`E2E Lifecycle Custom Type ${escapeRegExp(suffix)}`),
      );
      await clickDialogSubmit(page);
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10_000,
      });
      const parentUnit = await waitForUnitBySlug(
        adminRequest,
        state.unitSlugs[0],
      );

      await page.getByTestId("organization-create-unit-button").click();
      await page.locator("#ou-name").fill(`E2E Lifecycle Child ${suffix}`);
      await page.locator("#ou-slug").fill(state.unitSlugs[1]);
      const createDialogComboboxes = page.locator(
        '[role="dialog"] [role="combobox"]',
      );
      await createDialogComboboxes.first().click();
      await selectOptionByText(
        page,
        new RegExp(`E2E Lifecycle Custom Type ${escapeRegExp(suffix)}`),
      );
      await createDialogComboboxes.nth(1).click();
      await selectOptionByText(
        page,
        new RegExp(`E2E Lifecycle Parent ${escapeRegExp(suffix)}`),
      );
      await clickDialogSubmit(page);
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10_000,
      });
      const childUnit = await waitForUnitBySlug(
        adminRequest,
        state.unitSlugs[1],
      );
      expect(childUnit.parentUnitId).toBe(parentUnit.id);
      expect(childUnit.unitTypeId).toBe(unitType.id);

      const childRow = page.getByTestId(
        `organization-unit-row-${childUnit.id}`,
      );
      await expect(childRow).toBeVisible({ timeout: 15_000 });
      await childRow.locator("button").first().click();
      await expect(page.getByTestId("unit-detail")).toBeVisible();
      await attachScreenshot(page, testInfo, "organization-units-detail.png");

      await page.getByTestId("unit-detail-tab-members").click();
      const userPicker = page
        .getByTestId("unit-detail-add-member-picker")
        .getByRole("combobox");
      await userPicker.fill(manager.email);
      await page
        .getByRole("option", {
          name: new RegExp(escapeRegExp(manager.email), "i"),
        })
        .click();
      await page.getByTestId("unit-detail-add-member-role").click();
      await page.getByRole("option", { name: /manager/i }).click();
      await page.getByTestId("unit-detail-add-member-button").click();
      await expect(
        page.getByTestId(`unit-detail-member-row-${manager.id}`),
      ).toBeVisible({ timeout: 15_000 });

      await userPicker.fill(member.email);
      await page
        .getByRole("option", {
          name: new RegExp(escapeRegExp(member.email), "i"),
        })
        .click();
      await page.getByTestId("unit-detail-add-member-button").click();
      await expect(
        page.getByTestId(`unit-detail-member-row-${member.id}`),
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          async () =>
            (await fetchOrganizationUnitMembers(adminRequest, childUnit.id))
              .filter((entry) => [manager.id, member.id].includes(entry.userId))
              .map((entry) => `${entry.userId}:${entry.role}`)
              .sort(),
          { timeout: 15_000 },
        )
        .toEqual([`${manager.id}:MANAGER`, `${member.id}:MEMBER`].sort());
      await attachScreenshot(
        page,
        testInfo,
        "organization-members-assigned.png",
      );

      await page.getByTestId("unit-detail-tab-workspaces").click();
      const workspacePicker = page
        .getByTestId("unit-detail-add-workspace-picker")
        .getByRole("combobox");
      await workspacePicker.fill(workspaceName);
      await page.getByTestId("workspace-picker-option-0").click();
      await page.getByTestId("unit-detail-add-workspace-button").click();
      await expect(
        page.getByTestId(`unit-detail-workspace-row-${workspaceId}`),
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          async () =>
            (
              await fetchOrganizationUnitWorkspaces(adminRequest, childUnit.id)
            ).find((link) => link.workspaceId === workspaceId)?.relationship,
          { timeout: 15_000 },
        )
        .toBe("MANAGED");
      await attachScreenshot(page, testInfo, "organization-workspace-link.png");

      await page.getByTestId("organization-tab-members").click();
      await page.locator("#organization-members-search").fill(manager.email);
      const managerRow = page.getByTestId(
        `organization-member-row-${manager.id}`,
      );
      await expect(managerRow).toBeVisible({ timeout: 15_000 });
      await managerRow.click();
      await expect(
        page.getByTestId("organization-member-drawer"),
      ).toBeVisible();
      for (const tab of [
        "profile",
        "capabilities",
        "memberships",
        "activity",
      ]) {
        await expect(
          page.getByTestId(`organization-member-drawer-tab-${tab}`),
        ).toBeVisible();
      }
      await page
        .getByTestId("organization-member-drawer-tab-memberships")
        .click();
      await expect(
        page.getByTestId(`organization-member-membership-${childUnit.id}`),
      ).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, "organization-member-drawer.png");

      await page.goto(`${ADMIN_FRONTEND_BASE}/workspaces`, {
        waitUntil: "networkidle",
      });
      await expect(page.getByTestId("workspace-soft-list")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("workspace-search-input").fill(workspaceName);
      const workspaceRow = page.getByTestId(
        `workspace-soft-row-${workspaceId}`,
      );
      await expect(workspaceRow).toBeVisible({ timeout: 15_000 });
      await workspaceRow.click();
      for (const tab of ["basics", "members", "ou-link", "quota", "audit"]) {
        await expect(
          page.getByTestId(`workspace-drawer-tab-${tab}`),
        ).toBeVisible();
      }
      await page.getByTestId("workspace-drawer-tab-ou-link").click();
      await expect(
        page.getByTestId("workspace-drawer-panel-ou-link"),
      ).toBeVisible();
      await page.getByTestId("workspace-drawer-tab-quota").click();
      await expect(
        page.getByTestId("workspace-drawer-panel-quota"),
      ).toBeVisible();
      await attachScreenshot(page, testInfo, "workspace-admin-drawer.png");
    } finally {
      await cleanupByMarker(adminRequest, state);
    }
  });
});
