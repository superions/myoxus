// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared-workspace manager integrity flow.
 *
 * Setup and cleanup use only public Admin/GraphQL APIs. The browser actor is
 * deliberately removed from direct workspace membership after creating the
 * fixture, so every successful interaction proves effective OU-manager
 * capabilities rather than an accidental direct role.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  type APIRequestContext,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from "@playwright/test";

import {
  API_BASE,
  apiSignIn,
  type ApiUser,
  createTestUser,
  deleteTestUser,
  ensureAdminUser,
  FRONTEND_BASE,
  gqlRequest,
  injectSessionCookies,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  assignOrganizationUnitMember,
  createOrganizationUnit,
  deactivateOrganizationUnit,
  fetchOrganizationUnits,
  fetchOrganizationUnitTypes,
  unassignOrganizationUnitMember,
} from "../../../../adminfrontend/e2e/fixtures/organization";
import {
  setAccountColorMode,
  setAccountLocale,
} from "../../../shared/user-preferences-helper";

type WorkspaceRecord = {
  id: string;
  initialized: boolean;
  name: string;
  role?: string;
};

let manager: ApiUser;
let member: ApiUser;
let outsider: ApiUser;
let workspaceAdmin: ApiUser;
let managerCookies: string[] = [];
let managerRequest: APIRequestContext;
let outsiderRequest: APIRequestContext;
let unitId = "";
let unitName = "";
let workspaceAId = "";
let workspaceBId = "";

const visualEvidenceDir = path.resolve(
  "output/visual-qa/p-swai-03-web-capability-consumers/after",
);

async function expectGraphqlRejection(
  request: APIRequestContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<void> {
  const response = await request.post(`${API_BASE}/graphql`, {
    data: { query, variables },
    headers: { "Content-Type": "application/json" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { errors?: unknown[] };
  expect(body.errors?.length ?? 0).toBeGreaterThan(0);
}

async function createSharedWorkspace(
  request: APIRequestContext,
  targetUnitId: string,
  name: string,
): Promise<WorkspaceRecord> {
  const data = await gqlRequest<{
    createWorkspaceInOrganizationUnit: WorkspaceRecord;
  }>(
    request,
    `mutation CreateSharedWorkspace($input: CreateWorkspaceInOrganizationUnitInput!) {
       createWorkspaceInOrganizationUnit(input: $input) {
         id
         name
         initialized
       }
     }`,
    { input: { unitId: targetUnitId, name } },
  );
  return data.createWorkspaceInOrganizationUnit;
}

async function addWorkspaceMember(
  request: APIRequestContext,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation AddSharedWorkspaceMember(
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

async function removeWorkspaceMember(
  request: APIRequestContext,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation RemoveSharedWorkspaceMember($workspaceId: ID!, $userId: ID!) {
       admin {
         adminRemoveWorkspaceMember(
           workspaceId: $workspaceId
           userId: $userId
         )
       }
     }`,
    { workspaceId, userId },
  );
}

async function deleteWorkspaceStrict(
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation DeleteSharedWorkspace($id: ID!) {
       admin {
         deleteWorkspace(id: $id)
       }
     }`,
    { id: workspaceId },
  );
}

async function deleteOrganizationUnitStrict(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  await deactivateOrganizationUnit(request, id);
  const preview = await gqlRequest<{
    admin: {
      organizationUnitDeletionPreview: {
        blockers: Array<{ code: string; count: number }>;
        deletable: boolean;
        name: string;
        updatedAt: string;
      };
    };
  }>(
    request,
    `query SharedWorkspaceOuDeletionPreview($id: ID!) {
       admin {
         organizationUnitDeletionPreview(id: $id) {
           name
           updatedAt
           deletable
           blockers { code count }
         }
       }
     }`,
    { id },
  );
  const value = preview.admin.organizationUnitDeletionPreview;
  expect(value.blockers).toEqual([]);
  expect(value.deletable).toBe(true);
  await gqlRequest(
    request,
    `mutation DeleteSharedWorkspaceOu(
       $id: ID!
       $name: String!
       $revision: DateTime!
     ) {
       admin {
         deleteOrganizationUnitPermanently(
           id: $id
           confirmedName: $name
           previewRevision: $revision
         )
       }
     }`,
    { id, name: value.name, revision: value.updatedAt },
  );
}

async function createDocument(page: Page, workspaceId: string, title: string) {
  await page.goto(`${FRONTEND_BASE}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
  });
  const sidebar = page.getByTestId("app-sidebar");
  const rootFolderMenu = sidebar
    .getByTestId("structure-tree-node-operation-button")
    .last();
  await rootFolderMenu
    .locator('xpath=ancestor::*[@data-myoxus-ui-role="structure-tree-row"][1]')
    .hover();
  const sidebarGeometry = await rootFolderMenu.evaluate((button) => {
    const sidebar = button.closest('[data-testid="app-sidebar"]');
    const buttonRect = button.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const ancestors: Array<{
      role: string | null;
      width: number;
      paddingLeft: string;
      paddingRight: string;
    }> = [];
    let current: Element | null = button;
    while (current && current !== sidebar) {
      const rect = current.getBoundingClientRect();
      const style = window.getComputedStyle(current);
      ancestors.push({
        role: current.getAttribute("data-myoxus-ui-role"),
        width: rect.width,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      });
      current = current.parentElement;
    }
    return {
      ancestors,
      buttonRight: buttonRect.right,
      sidebarRight: sidebarRect?.right ?? 0,
      withinSidebar: buttonRect.right <= (sidebarRect?.right ?? 0),
    };
  });
  expect(
    sidebarGeometry.withinSidebar,
    JSON.stringify(sidebarGeometry, null, 2),
  ).toBe(true);
  await rootFolderMenu.click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const folderName = `Shared folder ${Date.now().toString(36)}`;
  const folderNameInput = page.getByTestId("rename-modal-input");
  await folderNameInput.fill(folderName);
  await folderNameInput.press("Enter");
  const folderNode = sidebar
    .locator('[data-testid^="structure-tree-folder-"]')
    .filter({ hasText: folderName });
  await expect(folderNode).toBeVisible();
  const folderMenu = folderNode.getByTestId(
    "structure-tree-node-operation-button",
  );
  await folderNode
    .locator('[data-myoxus-ui-role="structure-tree-row"]')
    .hover();
  await folderMenu.click();
  await page.getByRole("menuitem", { name: "New doc" }).click();
  await page.waitForURL(
    (url) => !url.pathname.endsWith(`/workspace/${workspaceId}/all`),
    { timeout: 20_000 },
  );
  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  await titleEditor.fill(title);
  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive document id from ${page.url()}`);
  }
  await expect(page.getByTestId(`structure-tree-doc-${docId}`)).toContainText(
    title,
    { timeout: 20_000 },
  );
  return docId;
}

async function openWorkspaceSettings(
  page: Page,
  workspaceId: string,
  tabTestId: string,
) {
  await page.goto(`${FRONTEND_BASE}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
  });
  const workspaceSection = page.getByTestId("sidebar-workspaces-section");
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  await Promise.race([
    workspaceSection.waitFor({ state: "visible" }),
    expandSidebar.waitFor({ state: "visible" }),
  ]);
  if (!(await workspaceSection.isVisible().catch(() => false))) {
    await expandSidebar.click();
  }
  await workspaceSection.click();
  const membersLoaded =
    tabTestId === "workspace-setting:members"
      ? page.waitForResponse(
          (response) =>
            response.request().headers()["x-operation-name"] ===
              "getMembersByWorkspaceId" && response.status() === 200,
        )
      : null;
  await page.getByTestId("workspace-navigation-settings").click();
  await page.getByTestId(tabTestId).click();
  await membersLoaded;
}

async function captureVisualEvidence(page: Page) {
  await mkdir(visualEvidenceDir, { recursive: true });
  const preferenceTarget = {
    request: managerRequest,
    gqlEndpoint: `${API_BASE}/graphql`,
    cookies: managerCookies,
  };
  const captureSettings = async (
    theme: "light" | "dark",
    state: "members" | "preference" | "organization",
  ) => {
    await setAccountColorMode(preferenceTarget, theme);
    await openWorkspaceSettings(
      page,
      workspaceAId,
      `workspace-setting:${state}`,
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      path: path.join(visualEvidenceDir, `${theme}-desktop-${state}.png`),
    });
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    for (const state of ["members", "preference", "organization"] as const) {
      await captureSettings(theme, state);
    }
    await setAccountColorMode(preferenceTarget, theme);
    await page.goto(`${FRONTEND_BASE}/workspace/${workspaceAId}/all`, {
      waitUntil: "load",
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme);
    await expect(page.getByTestId("app-sidebar")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("sidebar-new-page-button")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Loading database...", { exact: true }),
    ).toBeHidden({
      timeout: 20_000,
    });
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      path: path.join(visualEvidenceDir, `${theme}-desktop-all.png`),
    });
  }
}

test.describe.serial("OU-managed shared workspace integrity", () => {
  test.setTimeout(180_000);

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    const suffix = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    manager = await createTestUser(request, {
      name: `Shared Manager ${suffix}`,
    });
    member = await createTestUser(request, {
      name: `Shared Member ${suffix}`,
    });
    outsider = await createTestUser(request, {
      name: `Shared Outsider ${suffix}`,
    });
    workspaceAdmin = await createTestUser(request, {
      name: `Shared Administrator ${suffix}`,
    });

    const unitType = (await fetchOrganizationUnitTypes(request)).find(
      (candidate) => candidate.key === "team" && candidate.isPreset,
    );
    if (!unitType) throw new Error("Preset organization unit type is missing");
    const organizationRoot = (await fetchOrganizationUnits(request)).find(
      (unit) => unit.parentUnitId === null,
    );
    if (!organizationRoot) {
      throw new Error("Organization root unit is missing");
    }
    unitName = `Shared Access ${suffix}`;
    const unit = await createOrganizationUnit(request, {
      name: unitName,
      slug: `shared-access-${suffix}`,
      unitTypeId: unitType.id,
      parentUnitId: organizationRoot.id,
    });
    unitId = unit.id;
    await assignOrganizationUnitMember(request, {
      unitId,
      userId: manager.id,
      role: "Manager",
    });

    managerRequest = await playwrightRequest.newContext();
    managerCookies = await apiSignIn(
      managerRequest,
      manager.email,
      manager.password,
    );
    await setAccountLocale(
      {
        request: managerRequest,
        gqlEndpoint: `${API_BASE}/graphql`,
        cookies: managerCookies,
      },
      "en",
    );
    const workspaceA = await createSharedWorkspace(
      managerRequest,
      unitId,
      `Shared Workspace A ${suffix}`,
    );
    expect(workspaceA.initialized).toBe(true);
    workspaceAId = workspaceA.id;

    await ensureAdminUser(request);
    // Keep an active direct administrator while the actor uses only inherited OU rights.
    await addWorkspaceMember(request, workspaceAId, workspaceAdmin.id, "Admin");
    await removeWorkspaceMember(request, workspaceAId, manager.id);
    await addWorkspaceMember(request, workspaceAId, member.id, "Collaborator");

    outsiderRequest = await playwrightRequest.newContext();
    await apiSignIn(outsiderRequest, outsider.email, outsider.password);
  });

  test.afterAll(async ({ request }) => {
    const cleanupErrors: string[] = [];
    const cleanup = async (label: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    await ensureAdminUser(request);
    if (workspaceBId) {
      await cleanup("workspace B", () =>
        deleteWorkspaceStrict(request, workspaceBId),
      );
    }
    if (workspaceAId) {
      await cleanup("workspace A", () =>
        deleteWorkspaceStrict(request, workspaceAId),
      );
    }
    if (unitId && manager?.id) {
      await cleanup("OU manager membership", () =>
        unassignOrganizationUnitMember(request, unitId, manager.id),
      );
    }
    if (unitId) {
      await cleanup("organization unit", () =>
        deleteOrganizationUnitStrict(request, unitId),
      );
    }
    for (const user of [manager, member, outsider, workspaceAdmin]) {
      if (user?.id) {
        await cleanup(`user ${user.id}`, () =>
          deleteTestUser(request, user.id),
        );
      }
    }
    await managerRequest?.dispose();
    await outsiderRequest?.dispose();
    expect(cleanupErrors).toEqual([]);
  });

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.localStorage.setItem("app_config", '{"onBoarding":false}');
      window.localStorage.setItem("is-first-open", "false");
      window.localStorage.setItem(
        "global-state:open-link-mode",
        '"open-in-web"',
      );
    });
    await injectSessionCookies(context, managerCookies);
  });

  test("manager edits member, workspace, document and creates a named workspace", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      const operation = request.headers()["x-operation-name"];
      const failure = request.failure()?.errorText ?? "failed";
      const routeCancelledReadOperations = new Set([
        "databases",
        "documentSnippets",
        "getDocRolePermissions",
        "getMembersByWorkspaceId",
        "myOrganizationUnits",
        "myOrganizationUnitWorkspaces",
      ]);
      if (
        failure === "net::ERR_ABORTED" &&
        operation &&
        routeCancelledReadOperations.has(operation)
      ) {
        return;
      }
      requestFailures.push(
        `${request.method()} ${request.url()} [${
          operation ?? "no-operation"
        }]: ${failure}`,
      );
    });

    const capability = await gqlRequest<{
      workspace: {
        role: string;
        permissions: {
          Workspace_Administrators_Manage: boolean;
          Workspace_Settings_Update: boolean;
          Workspace_TransferOwner: boolean;
          Workspace_Users_Manage: boolean;
        };
      };
    }>(
      managerRequest,
      `query SharedManagerCapabilities($id: String!) {
         workspace(id: $id) {
           role
           permissions {
             Workspace_Users_Manage
             Workspace_Administrators_Manage
             Workspace_TransferOwner
             Workspace_Settings_Update
           }
         }
       }`,
      { id: workspaceAId },
    );
    expect(capability.workspace).toMatchObject({
      role: "External",
      permissions: {
        Workspace_Users_Manage: true,
        Workspace_Administrators_Manage: false,
        Workspace_TransferOwner: false,
        Workspace_Settings_Update: true,
      },
    });

    await openWorkspaceSettings(
      page,
      workspaceAId,
      "workspace-setting:members",
    );
    const memberRow = page
      .getByTestId("member-item")
      .filter({ hasText: member.email });
    await expect(memberRow).toBeVisible();
    await memberRow.getByRole("button").last().click();
    await expect(page.getByRole("menuitem", { name: "Manager" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: /assign.*owner/i }),
    ).toHaveCount(0);
    const roleMutation = page.waitForResponse(
      (response) =>
        response.request().headers()["x-operation-name"] ===
          "grantWorkspaceMember" && response.status() === 200,
    );
    await page.getByRole("menuitem", { name: "Manager" }).click();
    await roleMutation;
    await openWorkspaceSettings(
      page,
      workspaceAId,
      "workspace-setting:members",
    );
    await expect(
      page.getByTestId("member-item").filter({ hasText: member.email }),
    ).toContainText("Manager");

    const persistedMember = await gqlRequest<{
      workspace: {
        members: Array<{ id: string; role: string; status: string }>;
      };
    }>(
      managerRequest,
      `query SharedManagerMembers($id: String!) {
         workspace(id: $id) {
           members(skip: 0, take: 20) { id role status }
         }
       }`,
      { id: workspaceAId },
    );
    expect(
      persistedMember.workspace.members.find(
        (candidate) => candidate.id === member.id,
      )?.role,
    ).toBe("Manager");

    const renamedWorkspace = `Renamed Shared ${Date.now().toString(36)}`;
    await openWorkspaceSettings(
      page,
      workspaceAId,
      "workspace-setting:preference",
    );
    const workspaceNameInput = page.getByTestId("workspace-name-input");
    await expect(workspaceNameInput).toBeEnabled();
    await workspaceNameInput.fill(renamedWorkspace);
    await page.getByTestId("save-workspace-name").click();
    await expect(workspaceNameInput).toHaveValue(renamedWorkspace);
    await openWorkspaceSettings(
      page,
      workspaceAId,
      "workspace-setting:preference",
    );
    await expect(page.getByTestId("workspace-name-input")).toHaveValue(
      renamedWorkspace,
    );
    const persistedWorkspace = await gqlRequest<{
      workspace: { id: string; name: string };
    }>(
      managerRequest,
      `query SharedWorkspaceName($id: String!) {
         workspace(id: $id) { id name }
       }`,
      { id: workspaceAId },
    );
    expect(persistedWorkspace.workspace.name).toBe(renamedWorkspace);

    const initialDocTitle = `Shared document ${Date.now().toString(36)}`;
    const docId = await createDocument(page, workspaceAId, initialDocTitle);
    const renamedDoc = `${initialDocTitle} reviewed`;
    const docNode = page.getByTestId(`structure-tree-doc-${docId}`);
    await docNode.hover();
    await docNode.getByTestId("structure-tree-node-operation-button").click();
    const renameItem = page.getByRole("menuitem", { name: "Rename" });
    await expect(renameItem).toBeEnabled();
    await renameItem.click();
    const renameInput = page.getByTestId("rename-modal-input");
    await renameInput.fill(renamedDoc);
    await renameInput.press("Enter");
    await expect(docNode).toContainText(renamedDoc);
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      renamedDoc,
    );
    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId(`structure-tree-doc-${docId}`)).toContainText(
      renamedDoc,
      { timeout: 20_000 },
    );
    const persistedDoc = await gqlRequest<{
      workspace: { doc: { id: string; title: string } };
    }>(
      managerRequest,
      `query SharedDocumentTitle($workspaceId: String!, $docId: String!) {
         workspace(id: $workspaceId) {
           doc(docId: $docId) { id title }
         }
       }`,
      { workspaceId: workspaceAId, docId },
    );
    expect(persistedDoc.workspace.doc.title).toBe(renamedDoc);

    await expectGraphqlRejection(
      outsiderRequest,
      `mutation OutsiderWorkspaceRename($id: String!, $name: String!) {
         updateWorkspace(input: { id: $id, name: $name }) { id }
       }`,
      { id: workspaceAId, name: "Forbidden rename" },
    );
    await expectGraphqlRejection(
      outsiderRequest,
      `mutation OutsiderMemberRole($workspace: ID!, $user: ID!) {
         grantMember(
           workspaceId: $workspace
           userId: $user
           permission: Manager
         )
       }`,
      { workspace: workspaceAId, user: member.id },
    );
    await expectGraphqlRejection(
      outsiderRequest,
      `mutation OutsiderDocumentUpdate(
         $workspaceId: String!
         $docId: String!
       ) {
         applyDocUpdates(
           workspaceId: $workspaceId
           docId: $docId
           op: "replace"
           updates: "forbidden"
         )
       }`,
      { workspaceId: workspaceAId, docId },
    );
    await expectGraphqlRejection(
      managerRequest,
      `mutation ManagerCannotGrantAdmin($workspace: ID!, $user: ID!) {
         grantMember(
           workspaceId: $workspace
           userId: $user
           permission: Admin
         )
       }`,
      { workspace: workspaceAId, user: member.id },
    );
    await expectGraphqlRejection(
      managerRequest,
      `mutation ManagerCannotGrantOwner($workspace: ID!, $user: ID!) {
         grantMember(
           workspaceId: $workspace
           userId: $user
           permission: Owner
         )
       }`,
      { workspace: workspaceAId, user: member.id },
    );

    const workspaceBName = `Shared Workspace B ${Date.now().toString(36)}`;
    await openWorkspaceSettings(
      page,
      workspaceAId,
      "workspace-setting:organization",
    );
    await page.getByTestId("organization-create-ws-name").fill(workspaceBName);
    const unitSelect = page.getByTestId("organization-create-ws-unit");
    await unitSelect.click();
    await page.getByRole("option", { name: unitName }).click();
    await expect(
      page.getByTestId("organization-create-ws-submit"),
    ).toBeEnabled();
    await page.getByTestId("organization-create-ws-submit").click();

    await expect
      .poll(
        async () => {
          const result = await gqlRequest<{
            myOrganizationUnitWorkspaces: Array<{
              workspaceId: string;
              workspaceName: string;
            }>;
          }>(
            managerRequest,
            `query SharedManagerOuWorkspaces {
               myOrganizationUnitWorkspaces {
                 workspaceId
                 workspaceName
               }
             }`,
          );
          const created = result.myOrganizationUnitWorkspaces.find(
            (workspace) => workspace.workspaceName === workspaceBName,
          );
          workspaceBId = created?.workspaceId ?? "";
          return workspaceBId;
        },
        { timeout: 20_000 },
      )
      .not.toBe("");

    await page.goto(`${FRONTEND_BASE}/workspace/${workspaceBId}/all`, {
      waitUntil: "load",
    });
    await expect(page.getByTestId("sidebar-new-page-button")).toBeVisible();
    await expect(
      page.getByText(workspaceBName, { exact: true }).first(),
    ).toBeVisible();
    const createdWorkspace = await gqlRequest<{
      workspace: WorkspaceRecord;
    }>(
      managerRequest,
      `query CreatedSharedWorkspace($id: String!) {
         workspace(id: $id) { id name initialized }
       }`,
      { id: workspaceBId },
    );
    expect(createdWorkspace.workspace).toMatchObject({
      id: workspaceBId,
      initialized: true,
      name: workspaceBName,
    });

    await captureVisualEvidence(page);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requestFailures).toEqual([]);
  });
});
