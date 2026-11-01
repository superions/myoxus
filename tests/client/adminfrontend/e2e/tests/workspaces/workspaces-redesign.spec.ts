// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E: Admin Workspaces redesign smoke.
 *
 * Covers P-AR-2-12 at the running-stack boundary. The test creates one
 * temporary workspace through the public GraphQL API, renames it through the
 * admin workspace contract, verifies the redesigned soft-list/side-drawer UI,
 * and always deletes the workspace again through the admin delete mutation.
 */
import AxeBuilder from "@axe-core/playwright";
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  TestInfo,
} from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  createTestUser,
  deleteTestUser,
  FRONTEND_BASE,
  gqlRequest,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  fetchOrganizationUnits,
  unassignOrganizationUnitWorkspace,
} from "../../fixtures/organization";

const THEME_MATRIX = [
  { themeSlug: "stuttgart", themeMode: "light" },
  { themeSlug: "stuttgart", themeMode: "dark" },
  { themeSlug: "hamburg", themeMode: "light" },
  { themeSlug: "hamburg", themeMode: "dark" },
  { themeSlug: "berlin", themeMode: "light" },
  { themeSlug: "berlin", themeMode: "dark" },
  { themeSlug: "wien", themeMode: "light" },
  { themeSlug: "wien", themeMode: "dark" },
] as const;

type ThemeMode = "light" | "dark" | "system";
type EffectiveThemeSnapshot = {
  themeMode: ThemeMode;
  theme: {
    slug: string;
  };
};

async function signInBrowserAsAdmin(
  context: BrowserContext,
  adminRequest: APIRequestContext,
) {
  await injectRequestSessionCookies(context, adminRequest);
}

async function createTemporaryWorkspace(
  adminRequest: APIRequestContext,
  name: string,
) {
  const created = await gqlRequest<{ createWorkspace: { id: string } }>(
    adminRequest,
    `mutation CreateWorkspaceForAdminRedesignSmoke {
      createWorkspace {
        id
      }
    }`,
  );
  const workspaceId = created.createWorkspace.id;
  await gqlRequest(
    adminRequest,
    `mutation RenameWorkspaceForAdminRedesignSmoke($input: AdminUpdateWorkspaceInput!) {
      admin {
        adminUpdateWorkspace(input: $input) {
          id
          name
        }
      }
    }`,
    { input: { id: workspaceId, name } },
  );
  return workspaceId;
}

async function deleteWorkspace(
  adminRequest: APIRequestContext,
  workspaceId: string,
) {
  await gqlRequest(
    adminRequest,
    `mutation DeleteWorkspaceForAdminRedesignSmoke($id: ID!) {
      admin {
        deleteWorkspace(id: $id)
      }
    }`,
    { id: workspaceId },
  ).catch(() => undefined);
}

async function addWorkspaceMember(
  adminRequest: APIRequestContext,
  workspaceId: string,
  userId: string,
  role: "Collaborator" | "Reader" | "Manager" | "Admin",
) {
  await gqlRequest(
    adminRequest,
    `mutation AddWorkspaceMemberForAdminRedesignSmoke(
      $workspaceId: ID!
      $userId: ID!
      $role: String
    ) {
      admin {
        addWorkspaceMember(
          workspaceId: $workspaceId
          userId: $userId
          role: $role
        ) {
          id
          role
          status
        }
      }
    }`,
    { workspaceId, userId, role },
  );
}

async function workspaceMemberRole(
  adminRequest: APIRequestContext,
  workspaceId: string,
  userEmail: string,
) {
  const data = await gqlRequest<{
    admin: {
      adminWorkspace: {
        members: Array<{ id: string; email: string; role: string }>;
      } | null;
    };
  }>(
    adminRequest,
    `query WorkspaceMemberRoleForAdminRedesignSmoke(
      $id: String!
      $memberQuery: String
    ) {
      admin {
        adminWorkspace(id: $id) {
          members(skip: 0, take: 8, query: $memberQuery) {
            id
            email
            role
          }
        }
      }
    }`,
    { id: workspaceId, memberQuery: userEmail },
  );
  return data.admin.adminWorkspace?.members.find(
    (member) => member.email === userEmail,
  )?.role;
}

async function workspaceHeadingH1Size(
  adminRequest: APIRequestContext,
  workspaceId: string,
) {
  const data = await gqlRequest<{
    admin: {
      effectiveThemeProfile: {
        theme: {
          typographyStyles: Array<{
            styleKey: string;
            sizePx: number | null;
          }>;
        };
      };
    };
  }>(
    adminRequest,
    `query WorkspaceTypographyForAdminRedesignSmoke($workspaceId: ID) {
      admin {
        effectiveThemeProfile(workspaceId: $workspaceId) {
          theme {
            typographyStyles {
              styleKey
              sizePx
            }
          }
        }
      }
    }`,
    { workspaceId },
  );
  return (
    data.admin.effectiveThemeProfile.theme.typographyStyles.find(
      (style) => style.styleKey === "heading.h1",
    )?.sizePx ?? null
  );
}

async function readEffectiveTheme(adminRequest: APIRequestContext) {
  const data = await gqlRequest<{
    admin: { effectiveThemeProfile: EffectiveThemeSnapshot };
  }>(
    adminRequest,
    `query AdminEffectiveThemeForWorkspacesRedesignSmoke {
      admin {
        effectiveThemeProfile {
          themeMode
          theme { slug }
        }
      }
    }`,
  );
  return data.admin.effectiveThemeProfile;
}

async function setThemeProfile(
  adminRequest: APIRequestContext,
  input: { themeSlug: string; themeMode: ThemeMode },
) {
  const data = await gqlRequest<{
    admin: { setThemeProfile: EffectiveThemeSnapshot };
  }>(
    adminRequest,
    `mutation AdminSetThemeForWorkspacesRedesignSmoke($input: SetThemeProfileInput!) {
      admin {
        setThemeProfile(input: $input) {
          themeMode
          theme { slug }
        }
      }
    }`,
    { input },
  );
  expect(data.admin.setThemeProfile.theme.slug).toBe(input.themeSlug);
}

async function restoreBranding(
  adminRequest: APIRequestContext,
  original: EffectiveThemeSnapshot,
) {
  await setThemeProfile(adminRequest, {
    themeSlug: original.theme.slug,
    themeMode: original.themeMode,
  });
}

async function resetWorkspaceThemeProfile(
  adminRequest: APIRequestContext,
  workspaceId: string,
) {
  await gqlRequest(
    adminRequest,
    `mutation ResetWorkspaceThemeForWorkspacesRedesignSmoke($input: ResetWorkspaceThemeProfileInput!) {
      admin {
        resetWorkspaceThemeProfile(input: $input) {
          scope
        }
      }
    }`,
    { input: { workspaceId } },
  );
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(
    overflow.body,
    "body must not horizontally overflow",
  ).toBeLessThanOrEqual(1);
  expect(
    overflow.root,
    "document root must not horizontally overflow",
  ).toBeLessThanOrEqual(1);
}

test.describe("P-AR-2-12 — Admin Workspaces redesign", () => {
  test("soft-list filters, drawer tabs, theme overflow, and axe budget hold at 1280x720", async ({
    page,
    context,
    adminRequest,
  }, testInfo: TestInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    const name = `E2E Workspace Redesign ${Date.now().toString(36)}`;
    const workspaceId = await createTemporaryWorkspace(adminRequest, name);
    const user = await createTestUser(adminRequest);
    await addWorkspaceMember(
      adminRequest,
      workspaceId,
      user.id,
      "Collaborator",
    );

    const units = await fetchOrganizationUnits(adminRequest);
    const unit = units.find((item) => item.status.toUpperCase() === "ACTIVE");
    expect(
      unit,
      "workspace OU-link E2E requires at least one active organization unit",
    ).toBeTruthy();
    const originalBranding = await readEffectiveTheme(adminRequest);
    let ouRelationshipAssigned = false;

    try {
      await signInBrowserAsAdmin(context, adminRequest);
      await page.goto(`${ADMIN_FRONTEND_BASE}/workspaces`, {
        waitUntil: "networkidle",
      });

      await expect(page.getByTestId("workspace-soft-list")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("workspace-search-input").fill(name);

      const row = page.getByTestId(`workspace-soft-row-${workspaceId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click();
      await expect(
        page.getByText(/Details bearbeiten|Edit details/i),
      ).toBeVisible();

      for (const tab of [
        "basics",
        "members",
        "branding",
        "ou-link",
        "quota",
        "audit",
      ]) {
        await expect(
          page.getByTestId(`workspace-drawer-tab-${tab}`),
        ).toBeVisible();
      }
      await expect(
        page.getByTestId("workspace-drawer-panel-basics"),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      await page.getByTestId("workspace-drawer-tab-members").click();
      await expect(
        page.getByTestId("workspace-drawer-panel-members"),
      ).toBeVisible();
      await page.getByTestId("member-search-input").fill(user.email);
      const roleSelect = page.getByTestId(`member-role-select-${user.id}`);
      await expect(roleSelect).toBeVisible({ timeout: 15_000 });
      await expect(roleSelect).toHaveValue("Collaborator");
      await roleSelect.selectOption("Reader");
      await expect
        .poll(
          () => workspaceMemberRole(adminRequest, workspaceId, user.email),
          {
            message:
              "workspace member role is persisted through admin mutation",
            timeout: 15_000,
          },
        )
        .toBe("Reader");
      await expect(roleSelect).toHaveValue("Reader", { timeout: 15_000 });

      await page.getByTestId("workspace-drawer-tab-ou-link").click();
      await expect(
        page.getByTestId("workspace-drawer-panel-ou-link"),
      ).toBeVisible();
      await page
        .getByTestId("workspace-ou-picker")
        .getByRole("combobox")
        .fill(unit!.slug);
      await page.getByTestId("ou-picker-option-0").click();
      await page
        .getByTestId("workspace-ou-relationship-select")
        .selectOption("LINKED");
      await page.getByTestId("workspace-ou-assign-btn").click();
      ouRelationshipAssigned = true;
      const linkRow = page
        .getByTestId("workspace-drawer-panel-ou-link")
        .locator("div", { hasText: unit!.slug })
        .filter({ hasText: unit!.name })
        .first();
      await expect(linkRow).toBeVisible({ timeout: 15_000 });
      await expect(linkRow).toContainText(unit!.name);
      await expect(linkRow).toContainText(unit!.slug);

      await page.getByTestId("workspace-drawer-tab-branding").click();
      await expect(
        page.getByTestId("workspace-drawer-panel-branding"),
      ).toBeVisible();
      await expect(page.getByTestId("workspace-typography-editor")).toBeVisible(
        {
          timeout: 15_000,
        },
      );
      const accentInput = page.getByTestId(
        "colors-tab-input-light-accent-primary",
      );
      const originalAccent = (await accentInput.inputValue()).toLowerCase();
      const nextAccent = originalAccent === "#123456" ? "#654321" : "#123456";
      await accentInput.fill(nextAccent);
      await expect(page.getByTestId("colors-tab-save")).toBeEnabled();
      await page.getByTestId("colors-tab-save").click();
      await expect
        .poll(
          async () =>
            (
              await adminRequest.get(
                `${FRONTEND_BASE}/api/branding/theme.css?workspaceId=${encodeURIComponent(
                  workspaceId,
                )}`,
              )
            )
              .text()
              .then((css) =>
                css.includes(`--myoxus-accent-primary: ${nextAccent};`),
              ),
          {
            message:
              "workspace-scoped Runtime CSS must project the saved accent color",
            timeout: 15_000,
          },
        )
        .toBe(true);
      const h1SizeInput = page.getByTestId("hierarchy-h1-size");
      const originalH1Size = Number(await h1SizeInput.inputValue());
      const nextH1Size = originalH1Size === 43 ? 44 : 43;
      await h1SizeInput.fill(String(nextH1Size));
      await expect(page.getByTestId("typography-save")).toBeEnabled();
      await page.getByTestId("typography-save").click();
      await expect
        .poll(() => workspaceHeadingH1Size(adminRequest, workspaceId), {
          message:
            "workspace typography override must persist through AdminRoot",
          timeout: 15_000,
        })
        .toBe(nextH1Size);
      const scopedCssResponse = await adminRequest.get(
        `${FRONTEND_BASE}/api/branding/theme.css?workspaceId=${encodeURIComponent(
          workspaceId,
        )}`,
      );
      expect(scopedCssResponse.ok(), await scopedCssResponse.text()).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await adminRequest.get(
                `${FRONTEND_BASE}/api/branding/theme.css?workspaceId=${encodeURIComponent(
                  workspaceId,
                )}`,
              )
            )
              .text()
              .then((css) =>
                css.includes(`--myoxus-typography-h1-size: ${nextH1Size}px;`),
              ),
          {
            message:
              "workspace-scoped Runtime CSS must project the saved H1 size",
            timeout: 15_000,
          },
        )
        .toBe(true);
      const webPage = await context.newPage();
      try {
        await webPage.goto(`${FRONTEND_BASE}/workspace/${workspaceId}/all`, {
          // The workspace shell keeps sync/polling active; the CSS invariant
          // below is the actual readiness condition for this Theme DB gate.
          waitUntil: "domcontentloaded",
        });
        await expect(webPage).toHaveURL(
          new RegExp(`/workspace/${workspaceId}/all`),
          { timeout: 15_000 },
        );
        await webPage.waitForFunction(
          ({ expectedAccent, expectedSize }) => {
            const root = getComputedStyle(document.documentElement);
            return (
              root
                .getPropertyValue("--myoxus-accent-primary")
                .trim()
                .toLowerCase() === expectedAccent &&
              root.getPropertyValue("--myoxus-typography-h1-size").trim() ===
                `${expectedSize}px`
            );
          },
          { expectedAccent: nextAccent, expectedSize: nextH1Size },
          { timeout: 15_000 },
        );
      } finally {
        await webPage.close().catch(() => undefined);
      }
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath("workspace-branding-color-typography.png"),
      });

      const result = await new AxeBuilder({ page }).include("body").analyze();
      const critical = result.violations.filter(
        (violation) => violation.impact === "critical",
      );
      expect(
        critical.map(
          (violation) =>
            `${violation.id}: ${violation.description} (${violation.nodes.length} nodes)`,
        ),
      ).toEqual([]);

      for (const { themeSlug, themeMode } of THEME_MATRIX) {
        await setThemeProfile(adminRequest, { themeSlug, themeMode });
        await page.goto(`${ADMIN_FRONTEND_BASE}/workspaces`, {
          waitUntil: "networkidle",
        });
        await page.getByTestId("workspace-search-input").fill(name);
        const themedRow = page.getByTestId(`workspace-soft-row-${workspaceId}`);
        await expect(
          themedRow,
          `${themeSlug}/${themeMode} must keep the filtered soft-list row visible`,
        ).toBeVisible({ timeout: 15_000 });
        await themedRow.click();
        await expect(
          page.getByTestId("workspace-drawer-tab-basics"),
        ).toBeVisible();
        await assertNoHorizontalOverflow(page);
      }
    } finally {
      await restoreBranding(adminRequest, originalBranding).catch(
        () => undefined,
      );
      await resetWorkspaceThemeProfile(adminRequest, workspaceId).catch(
        () => undefined,
      );
      if (ouRelationshipAssigned) {
        await unassignOrganizationUnitWorkspace(adminRequest, {
          unitId: unit!.id,
          workspaceId,
          relationship: "LINKED",
        }).catch(() => undefined);
      }
      await deleteWorkspace(adminRequest, workspaceId);
      await deleteTestUser(adminRequest, user.id).catch(() => undefined);
    }
  });
});
