// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

import {
  expect,
  type Page,
  request as requestFactory,
  test,
} from "@playwright/test";

import {
  apiSignIn,
  createTestUser,
  deleteTestUser,
  ensureAdminUser,
  getCachedAdminStorageState,
  gqlRequest,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import { fetchOrganizationUnits } from "../../../../adminfrontend/e2e/fixtures/organization";
import { waitForWorkspaceReady } from "../../../shared/workspace-helper";

const frontend =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";

type TemplateState = {
  state: string;
  origin: string | null;
};

async function readTemplateState(
  page: Page,
  workspaceId: string,
  docId: string,
): Promise<TemplateState | null> {
  const response = await page.request.post(`${frontend}/graphql`, {
    data: {
      query: `query CustomTemplateLifecycleMetadata($workspaceId: ID!, $docId: ID!) {
        documentMetadata(
          workspaceId: $workspaceId
          docId: $docId
          requestedProjectionMode: MYOXUS_NATIVE
        ) {
          template { state origin }
        }
      }`,
      variables: { workspaceId, docId },
    },
    headers: {
      "x-myoxus-client": "web-flow",
      "x-myoxus-client-format": "myoxus-native",
      "x-myoxus-client-capabilities": "document-metadata",
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data?: { documentMetadata: { template: TemplateState | null } };
    errors?: unknown[];
  };
  expect(body.errors).toBeUndefined();
  return body.data?.documentMetadata.template ?? null;
}

// A reload must start after the native source update is acknowledged, not
// merely after its metadata/title projection has changed in the header.
async function waitForNativeSourceSync(page: Page, docId: string) {
  await page.evaluate(async (id) => {
    const workspace = (
      window as Window & {
        currentWorkspace?: {
          id: string;
          engine: {
            doc: {
              waitForSynced: (id: string, signal: AbortSignal) => Promise<void>;
            };
          };
        };
      }
    ).currentWorkspace;
    if (!workspace) throw new Error("No active workspace");
    const signal = AbortSignal.timeout(20_000);
    await workspace.engine.doc.waitForSynced(id, signal);
    await workspace.engine.doc.waitForSynced(workspace.id, signal);
  }, docId);
}

let workspaceId = "";
let originalLocale: string | null | undefined;
const guideSlugs = [
  "welcome-myoxus",
  "getting-started-myoxus",
  "using-folders-myoxus",
  "meeting-templates-myoxus",
  "databases-guide-myoxus",
];
type DefaultPolicy = {
  templateId: string;
  applyToNewWorkspaces: boolean;
  selectionMode: string;
  provisioningMode: string;
};
let changedDefaults: DefaultPolicy[] = [];
const rowBodyTemplateIds = new Set<string>();

test.describe("Custom template lifecycle", () => {
  // These source journeys target the live bundle, not an older offline SW cache.
  test.use({ serviceWorkers: "block" });
  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    const preferences = await gqlRequest<{
      currentUser: { preferences: { values: { locale: string | null } } };
    }>(request, `{currentUser{preferences{values{locale}}}}`);
    originalLocale = preferences.currentUser.preferences.values.locale;
    // These semantic control assertions use English; restore the operator's
    // original preference when this isolated workspace journey ends.
    await gqlRequest(
      request,
      `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){effectiveValues{locale}}}`,
      { input: { locale: "en" } },
    );

    const defaults = await gqlRequest<{
      admin: {
        templateCatalog: { id: string; slug: string }[];
        templateDefaultPolicies: DefaultPolicy[];
      };
    }>(
      request,
      `{admin{templateCatalog(take:100){id slug} templateDefaultPolicies{templateId applyToNewWorkspaces selectionMode provisioningMode}}}`,
    );
    const ids = defaults.admin.templateCatalog
      .filter((entry) => guideSlugs.includes(entry.slug))
      .map((entry) => entry.id);
    expect(ids).toHaveLength(5);
    changedDefaults = defaults.admin.templateDefaultPolicies.filter(
      (policy) =>
        ids.includes(policy.templateId) && !policy.applyToNewWorkspaces,
    );
    // Temporarily enable the selected defaults before provisioning this owned
    // workspace, then restore every operator opt-out after the journey.
    for (const policy of changedDefaults)
      await gqlRequest(
        request,
        `mutation($input:SetTemplateDefaultPolicyInput!){admin{setTemplateDefaultPolicy(input:$input)}}`,
        { input: { ...policy, applyToNewWorkspaces: true } },
      );
    const ownerUnit = (await fetchOrganizationUnits(request)).find(
      (unit) => unit.parentUnitId === null,
    );
    if (ownerUnit) {
      const created = await gqlRequest<{
        createWorkspaceInOrganizationUnit: { id: string; initialized: boolean };
      }>(
        request,
        `mutation CreateCustomTemplateWorkspace($input: CreateWorkspaceInOrganizationUnitInput!) {
        createWorkspaceInOrganizationUnit(input: $input) { id initialized }
      }`,
        {
          input: {
            unitId: ownerUnit.id,
            name: `Custom template flow ${Date.now()}`,
          },
        },
      );
      expect(created.createWorkspaceInOrganizationUnit.initialized).toBe(true);
      workspaceId = created.createWorkspaceInOrganizationUnit.id;
    } else {
      // Personal workspace provisioning exercises the same source lifecycle on
      // isolated fixtures that deliberately have no organization hierarchy.
      const created = await gqlRequest<{ createWorkspace: { id: string } }>(
        request,
        `mutation { createWorkspace { id } }`,
      );
      workspaceId = created.createWorkspace.id;
    }
  });

  test.afterAll(async ({ request }) => {
    await ensureAdminUser(request);
    try {
      if (workspaceId)
        await gqlRequest(
          request,
          `mutation DeleteCustomTemplateWorkspace($id: ID!) {admin { deleteWorkspace(id: $id) }}`,
          { id: workspaceId },
        );
    } finally {
      try {
        for (const templateId of rowBodyTemplateIds)
          await gqlRequest(
            request,
            `mutation($id:ID!){admin{archiveTemplate(templateId:$id){id}}}`,
            { id: templateId },
          );
        for (const policy of changedDefaults)
          await gqlRequest(
            request,
            `mutation($input:SetTemplateDefaultPolicyInput!){admin{setTemplateDefaultPolicy(input:$input)}}`,
            { input: policy },
          );
      } finally {
        if (originalLocale !== undefined)
          await gqlRequest(
            request,
            `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){effectiveValues{locale}}}`,
            { input: { locale: originalLocale } },
          );
      }
    }
  });

  test("fresh defaults expose ordinary native guides and standalone meeting copies", async ({
    context,
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await ensureAdminUser(request);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const adminState = await getCachedAdminStorageState(requestFactory);
    await context.addCookies(adminState.cookies);
    await page.goto(`${frontend}/workspace/${workspaceId}/all`);
    await waitForWorkspaceReady(page, { allDocs: true });
    const slugs = guideSlugs;
    type Inventory = {
      admin: {
        templateCatalog: { id: string; slug: string }[];
        workspaceTemplateInstances: {
          templateId: string;
          workspaceDocId: string | null;
          state: string;
        }[];
      };
    };
    const inventory = () =>
      gqlRequest<Inventory>(
        request,
        `query($workspaceId:String!){admin{templateCatalog(take:100){id slug} workspaceTemplateInstances(workspaceId:$workspaceId){templateId workspaceDocId state}}}`,
        { workspaceId },
      );
    await expect
      .poll(
        async () => {
          const current = (await inventory()).admin;
          return slugs.every((slug) => {
            const entry = current.templateCatalog.find(
              (entry) => entry.slug === slug,
            );
            return (
              entry &&
              current.workspaceTemplateInstances.some(
                (instance) =>
                  instance.templateId === entry.id &&
                  instance.state === "Ok" &&
                  instance.workspaceDocId,
              )
            );
          });
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const current = (await inventory()).admin;
    const guides = slugs.map((slug) => ({
      slug,
      id: current.workspaceTemplateInstances.find(
        (instance) =>
          instance.templateId ===
          current.templateCatalog.find((entry) => entry.slug === slug)!.id,
      )!.workspaceDocId!,
    }));

    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    for (const guide of guides)
      await expect(
        page.getByTestId(`template-catalog-row-document:${guide.id}`),
      ).toHaveCount(0);
    const dailyTemplateId = current.templateCatalog.find(
      (entry) => entry.slug === "agile-standup",
    )?.id;
    const dailyDocId = current.workspaceTemplateInstances.find(
      (instance) => instance.templateId === dailyTemplateId,
    )?.workspaceDocId;
    // Catalog metadata can replace the native source title after first render.
    const daily = page
      .locator('[data-testid^="template-catalog-row-"]')
      .filter({ has: page.locator(`a[href$="/${dailyDocId}"]`) });
    await expect(daily).toHaveCount(1);
    const sourceHref = await daily.getByRole("link").getAttribute("href");
    expect(sourceHref).toBe(`/workspace/${workspaceId}/${dailyDocId}`);
    expect(sourceHref).toMatch(/^\/workspace\/[^/]+\/[^/]+$/);
    await daily.getByRole("link").click();
    const sourceId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(sourceId).toBe(dailyDocId);
    const sourceEditor = page.getByTestId(`editor-${sourceId}`);
    await expect(sourceEditor.locator("myoxus-table").first()).toBeVisible();
    const sourceBody = await sourceEditor.innerText();
    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    await daily.getByRole("button", { name: "Use", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/templates"));
    const workingId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(workingId).not.toBe(sourceId);
    const working = page.getByTestId(`editor-${workingId}`);
    await expect(working.locator("myoxus-table").first()).toBeVisible();
    await expect
      .poll(() => readTemplateState(page, workspaceId, workingId))
      .toBeNull();
    const cell = working
      .locator('myoxus-table-cell [contenteditable="true"]')
      .last();
    await cell.click();
    await page.keyboard.insertText("Native standalone decision");
    await waitForNativeSourceSync(page, workingId);
    await page.reload();
    await expect(working).toContainText("Native standalone decision");
    await page.goto(`${frontend}/workspace/${workspaceId}/${sourceId}`);
    await expect(sourceEditor).toBeVisible();
    expect(await sourceEditor.innerText()).toBe(sourceBody);
    expect(errors).toEqual([]);
  });

  test("keeps a custom source discoverable and its ordinary target independent", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const adminState = await getCachedAdminStorageState(requestFactory);
    await context.addCookies(adminState.cookies);
    await page.goto(`${frontend}/workspace/${workspaceId}/all`);
    await waitForWorkspaceReady(page, { allDocs: true });

    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    await page.getByTestId("template-catalog-create").click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/templates`),
    );
    const sourceDocId = new URL(page.url()).pathname.split("/").at(-1)!;
    const sourceTitle = `Custom source ${Date.now()}`;
    const sourceTitleEditor = page.locator("doc-title .inline-editor").first();
    await sourceTitleEditor.click();
    await page.keyboard.insertText(sourceTitle);
    await expect(sourceTitleEditor).toHaveText(sourceTitle);
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(sourceTitleEditor).toHaveText(sourceTitle, {
      timeout: 20_000,
    });

    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    const sourceRow = page.getByTestId(
      `template-catalog-row-document:${sourceDocId}`,
    );
    await expect(sourceRow).toContainText(sourceTitle);
    await expect
      .poll(() => readTemplateState(page, workspaceId, sourceDocId))
      .toEqual({
        state: "managed",
        origin: "custom",
      });

    await page.locator(`a[href$="/${workspaceId}/all"]`).click();
    await waitForWorkspaceReady(page, { allDocs: true });
    await expect(page.locator(`a[href$="/${sourceDocId}"]`)).toHaveCount(0);

    await page.getByTestId("sidebar-new-page-button").click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/all`),
    );
    const targetDocId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(targetDocId).not.toBe(sourceDocId);
    await page.getByTestId("template-docs-button").click();
    await page
      .getByRole("menuitem", { name: sourceTitle, exact: true })
      .click();
    const targetTitleEditor = page.locator("doc-title .inline-editor").first();
    await expect(targetTitleEditor).toHaveText(sourceTitle);
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(targetTitleEditor).toHaveText(sourceTitle);
    await expect
      .poll(() => readTemplateState(page, workspaceId, targetDocId))
      .toBeNull();

    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    await sourceRow.getByRole("link").click();
    const changedSourceTitle = `${sourceTitle} changed`;
    await page.locator("doc-title .inline-editor").first().click();
    await page.locator("doc-title .inline-editor").first().press("Control+a");
    await page.keyboard.insertText(changedSourceTitle);
    await expect(sourceTitleEditor).toHaveText(changedSourceTitle);
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      changedSourceTitle,
    );

    await page.goto(`${frontend}/workspace/${workspaceId}/${targetDocId}`);
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      sourceTitle,
    );
    const changedTargetTitle = `${sourceTitle} target`;
    await page.locator("doc-title .inline-editor").first().click();
    await page.locator("doc-title .inline-editor").first().press("Control+a");
    await page.keyboard.insertText(changedTargetTitle);
    await expect(targetTitleEditor).toHaveText(changedTargetTitle);
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      changedTargetTitle,
    );

    await page.goto(`${frontend}/workspace/${workspaceId}/${sourceDocId}`);
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      changedSourceTitle,
    );
    await page.locator(`a[href$="/${workspaceId}/all"]`).click();
    await waitForWorkspaceReady(page, { allDocs: true });
    await expect(page.locator(`a[href$="/${sourceDocId}"]`)).toHaveCount(0);
    await expect(page.locator(`a[href$="/${targetDocId}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href$="/${targetDocId}"]`)).toContainText(
      changedTargetTitle,
    );
    expect(consoleErrors).toEqual([]);
  });

  test("manual template inputs are captured once, cancel without creation and survive editing", async ({
    context,
    page,
  }) => {
    const state = await getCachedAdminStorageState(requestFactory);
    await context.addCookies(state.cookies);
    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    await page.getByTestId("template-catalog-create").click();
    await page.waitForURL((url) => !url.pathname.endsWith("/templates"));
    const sourceId = new URL(page.url()).pathname.split("/").at(-1)!;
    const title = page.locator("doc-title .inline-editor").first();
    await title.fill(
      "Brief {{input.project_name}} / {{input.reference}} / {{input.project_name}}",
    );
    await title.press("Enter");
    const body = page.locator("myoxus-paragraph .inline-editor").first();
    await body.fill("Project ");
    await body.press(`${process.platform === "darwin" ? "Meta" : "Control"}+a`);
    await page
      .getByRole("button", { name: "Insert variable", exact: true })
      .click();
    const picker = page.getByTestId("template-variable-menu");
    await picker.getByRole("textbox").fill("input.project_name");
    await picker.getByRole("textbox").press("Enter");
    await expect(body).toHaveText("{{input.project_name}}");
    await waitForNativeSourceSync(page, sourceId);
    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    const sourceRow = page.getByTestId(
      `template-catalog-row-document:${sourceId}`,
    );
    await sourceRow.getByRole("button", { name: "Use", exact: true }).click();
    const dialog = page.getByTestId("template-input-dialog");
    await expect(dialog.getByRole("textbox")).toHaveCount(2);
    await dialog
      .getByRole("textbox", { name: "project name" })
      .fill("Atlas {{date}}");
    await dialog.getByRole("textbox", { name: "reference" }).fill("R-1");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      sourceRow.getByRole("button", { name: "Use", exact: true }),
    ).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/${workspaceId}/templates$`));
    await sourceRow.getByRole("button", { name: "Use", exact: true }).click();
    await expect(
      dialog.getByRole("textbox", { name: "project name" }),
    ).toHaveValue("");
    await dialog
      .getByRole("textbox", { name: "project name" })
      .fill("Atlas {{date}}");
    await dialog.getByRole("textbox", { name: "reference" }).fill("R-1");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(title).toHaveText(
      "Brief Atlas {{date}} / R-1 / Atlas {{date}}",
    );
    const targetId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(targetId).not.toBe(sourceId);
    await title.fill("Edited brief");
    await waitForNativeSourceSync(page, targetId);
    await page.reload();
    await expect(title).toHaveText("Edited brief");
    await page.goto(`${frontend}/workspace/${workspaceId}/${sourceId}`);
    await expect(title).toHaveText(
      "Brief {{input.project_name}} / {{input.reference}} / {{input.project_name}}",
    );

    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("workspace-navigation-settings").click();
    await page.getByTestId("workspace-setting:preference").click();
    const selector = page.getByTestId("journal-template-selector");
    await expect(selector).toHaveText("Keep empty");
    await selector.click();
    // This lower item extends past the containing settings Card. A mouse click
    // must reach it, not the section underneath a clipped dropdown.
    await page
      .getByRole("menuitem", {
        name: "Brief {{input.project_name}} / {{input.reference}} / {{input.project_name}}",
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole("alert")
        .getByText(
          "Journal defaults cannot require manual input. Select a template without input fields.",
          { exact: true },
        ),
    ).toBeVisible();
    await expect(selector).toHaveText("Keep empty");
    await page
      .getByRole("dialog", { name: "Workspace", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
  });

  test("authors literal variables in title, text and native cells with one undo step", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const state = await getCachedAdminStorageState(requestFactory);
    await context.addCookies(state.cookies);
    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    await page.getByTestId("template-catalog-create").click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/templates`),
    );
    const title = page.locator("doc-title .inline-editor").first();
    await title.fill("Variable source");
    const sourceUrl = page.url();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const choose = async (token: string) => {
      const dialog = page.getByTestId("template-variable-menu");
      const search = dialog.getByRole("textbox");
      await expect(search).toBeFocused();
      await search.fill("no-such-variable");
      await expect(dialog.getByRole("option")).toHaveCount(0);
      await search.fill(token);
      await expect(dialog.getByRole("option")).toHaveCount(1);
      await search.press("ArrowDown");
      await search.press("ArrowUp");
      await search.press("Enter");
      await expect(dialog).toBeHidden();
    };
    const history = async (
      editor: ReturnType<Page["locator"]>,
      before: string,
      after: string,
    ) => {
      await expect(editor).toHaveText(after);
      // Typing without a pointer action proves focus returned to the source.
      await page.keyboard.type("!");
      await expect(editor).toHaveText(`${after}!`);
      await page.keyboard.press(`${modifier}+z`);
      await expect(editor).toHaveText(after);
      await page.keyboard.press(`${modifier}+z`);
      await expect(editor).toHaveText(before);
      await page.keyboard.press(`${modifier}+Shift+z`);
      await expect(editor).toHaveText(after);
    };
    await title.press("End");
    await title.click({ button: "right" });
    await choose("{{workspace.name}}");
    await history(
      title,
      "Variable source",
      "Variable source{{workspace.name}}",
    );

    await title.press("Enter");
    const paragraph = page.locator("myoxus-paragraph .inline-editor").first();
    await paragraph.fill("Body");
    await paragraph.press(`${modifier}+a`);
    await page
      .getByRole("button", { name: /^(Insert variable|Variable einfügen)$/ })
      .click();
    const paragraphCount = await page.locator("myoxus-paragraph").count();
    await choose("{{date}}");
    await history(paragraph, "Body", "{{date}}");
    await expect(page.locator("myoxus-paragraph")).toHaveCount(paragraphCount);

    await paragraph.press("End");
    await paragraph.press("Enter");
    await page.keyboard.type("/table");
    await page.getByTestId("slash-menu-item-block-table-insert").click();
    const cell = page.locator("myoxus-table .inline-editor").first();
    await cell.fill("Cell");
    await cell.press("End");
    await cell.click({ button: "right" });
    await page
      .locator("myoxus-menu-button")
      .filter({ hasText: /Insert variable|Variable einfügen/ })
      .click();
    await choose("{{date}}");
    await history(cell, "Cell", "Cell{{date}}");

    await cell.press("End");
    await cell.press("Shift+F10");
    await page
      .locator("myoxus-menu-button")
      .filter({ hasText: /Insert variable|Variable einfügen/ })
      .click();
    await page
      .getByTestId("template-variable-menu")
      .getByRole("textbox")
      .press("Escape");
    await expect(page.getByTestId("template-variable-menu")).toBeHidden();
    await expect(cell).toHaveText("Cell{{date}}");
    await page.keyboard.type("?");
    await expect(cell).toHaveText("Cell{{date}}?");
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(title).toHaveText("Variable source{{workspace.name}}");
    await expect(paragraph).toHaveText("{{date}}");
    await expect(cell).toHaveText("Cell{{date}}?");

    await page.getByTestId("sidebar-new-page-button").click();
    await page.waitForURL((url) => url.toString() !== sourceUrl);
    await title.fill("Ordinary document");
    await title.click({ button: "right" });
    await expect(page.getByTestId("template-variable-menu")).toHaveCount(0);
    await title.press("Escape");
    await title.press("Enter");
    await paragraph.fill("Ordinary body");
    await paragraph.press(`${modifier}+a`);
    await expect(
      page.getByRole("button", {
        name: /^(Insert variable|Variable einfügen)$/,
      }),
    ).toHaveCount(0);
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    const sourceDocId = new URL(sourceUrl).pathname.split("/").at(-1)!;
    // The author left the source above; the readonly journey is its only open instance.
    const viewer = await createTestUser(page.request);
    await gqlRequest(
      page.request,
      `mutation AddVariableViewer($workspaceId: ID!, $userId: ID!) {
      admin { addWorkspaceMember(workspaceId: $workspaceId, userId: $userId, role: "Reader") { id } }
    }`,
      { workspaceId, userId: viewer.id },
    );
    await gqlRequest(
      page.request,
      `mutation GrantVariableReader($input: GrantDocUserRolesInput!) {
      grantDocUserRoles(input: $input)
    }`,
      {
        input: {
          workspaceId,
          externalDocId: sourceDocId,
          userIds: [viewer.id],
          role: "Reader",
        },
      },
    );
    const anonymous = await context
      .browser()!
      .newContext({ serviceWorkers: "block" });
    try {
      await apiSignIn(anonymous.request, viewer.email, viewer.password);
      await gqlRequest(
        anonymous.request,
        `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){effectiveValues{locale}}}`,
        { input: { locale: "en" } },
      );
      const readonly = await anonymous.newPage();
      readonly.on("pageerror", (error) => errors.push(error.message));
      await readonly.goto(
        `${frontend}/workspace/${workspaceId}/${sourceDocId}`,
      );
      await expect(readonly.locator("doc-title")).toContainText(
        "Variable source",
      );
      await expect(
        readonly.locator("doc-title [contenteditable=true]"),
      ).toHaveCount(0);
      await readonly.getByTestId("header-dropDownButton").click();
      await readonly.getByTestId("template-check-action").click();
      await expect(readonly.getByTestId("template-check-dialog")).toContainText(
        "Available now",
      );
      await readonly
        .getByTestId("template-check-diagnostic")
        .filter({ hasText: "Workspace name" })
        .getByTestId("template-check-locate")
        .click();
      await expect
        .poll(() => readonly.evaluate(() => window.getSelection()?.toString()))
        .toBe("{{workspace.name}}");
      await expect(
        readonly.locator("doc-title [contenteditable=true]"),
      ).toHaveCount(0);
      await readonly.getByTestId("header-dropDownButton").click();
      await readonly.getByTestId("template-check-action").click();
      await expect(readonly.getByTestId("template-check-again")).toBeEnabled();
      await readonly.keyboard.press("Escape");
      await expect(readonly.getByTestId("header-dropDownButton")).toBeFocused();

      await readonly.locator("doc-title").click({ button: "right" });
      await expect(readonly.getByTestId("template-variable-menu")).toHaveCount(
        0,
      );
      await readonly.keyboard.press("Escape");
      await readonly
        .locator("myoxus-table .inline-editor")
        .first()
        .click({ button: "right" });
      await expect(
        readonly
          .locator("myoxus-menu-button")
          .filter({ hasText: /Insert variable|Variable einfügen/ }),
      ).toHaveCount(0);
    } finally {
      await anonymous.close();
      await deleteTestUser(page.request, viewer.id);
    }
    expect(errors).toEqual([]);
  });
  test("checks source diagnostics and locations without creating a target or prompting for inputs", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const state = await getCachedAdminStorageState(requestFactory);
    await context.addCookies(state.cookies);
    await page.goto(`${frontend}/workspace/${workspaceId}/templates`);
    await page.getByTestId("template-catalog-create").click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/templates`),
    );
    const sourceDocId = new URL(page.url()).pathname.split("/").at(-1)!;
    const title = page.locator("doc-title .inline-editor").first();
    await title.fill("Check {{unknown.title}}");
    await title.press("Enter");
    const paragraph = page.locator("myoxus-paragraph .inline-editor").first();
    await paragraph.fill(
      "{{unknown.body}} {{input.project}} {{creator.name}} {{folder_name}} {{member.name}}",
    );
    await paragraph.press("End");
    await paragraph.press("Enter");
    await page.keyboard.type("/table");
    await page.getByTestId("slash-menu-item-block-table-insert").click();
    const cell = page.locator("myoxus-table .inline-editor").first();
    await cell.fill("Cell {{unknown.cell}}");
    await expect(cell).toHaveText("Cell {{unknown.cell}}");
    await cell.press("Tab");
    await waitForNativeSourceSync(
      page,
      new URL(page.url()).pathname.split("/").at(-1)!,
    );
    await page.reload();
    await waitForWorkspaceReady(page);
    await expect(page.locator("doc-title .inline-editor").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(title).toHaveText("Check {{unknown.title}}", {
      timeout: 20_000,
    });
    const before = await readTemplateState(page, workspaceId, sourceDocId);
    const check = async () => {
      await page.getByTestId("header-dropDownButton").click();
      await page.getByTestId("template-check-action").click();
      await expect(page.getByTestId("template-check-again")).toBeEnabled();
    };
    await check();
    const dialog = page.getByTestId("template-check-dialog");
    await expect(dialog).toContainText("Unknown variable token");
    await expect(dialog).toContainText("Input required");
    await expect(dialog).toContainText("Resolved on application");
    await expect(dialog).toContainText("Invalid repeat");
    await expect(dialog).toContainText("Context required");
    await dialog
      .getByTestId("template-check-diagnostic")
      .filter({ hasText: "{{unknown.cell}}" })
      .getByTestId("template-check-locate")
      .click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("{{unknown.cell}}");
    await page.keyboard.type("{{date}}");
    await expect(cell).toHaveText("Cell {{date}}");
    await check();
    await expect(dialog).not.toContainText("{{unknown.cell}}");
    await dialog
      .getByTestId("template-check-diagnostic")
      .filter({ hasText: "{{unknown.title}}" })
      .getByTestId("template-check-locate")
      .click();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("{{unknown.title}}");
    await page.keyboard.type("{{workspace.name}}");
    await expect(title).toHaveText("Check {{workspace.name}}");
    await check();
    await dialog
      .getByTestId("template-check-diagnostic")
      .filter({ hasText: "{{unknown.body}}" })
      .getByTestId("template-check-locate")
      .click();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("{{unknown.body}}");
    await page.keyboard.type("{{input.project}}");
    await check();
    await expect(dialog).toContainText("Input required");
    await expect(dialog).not.toContainText("Unknown variable token");
    // A single editor instance produces the same native revision change as a
    // remote collaborator; no second collaborative browser can write fixtures.
    await paragraph.evaluate((editor) => {
      const block = editor.closest("myoxus-paragraph") as HTMLElement & {
        model: {
          props: {
            text: {
              length: number;
              delete: (index: number, length: number) => void;
              insert: (text: string, index: number) => void;
            };
          };
        };
      };
      const text = block.model.props.text;
      text.delete(0, text.length);
      text.insert("{{unknown.changed}}", 0);
    });
    await expect(dialog).toContainText("The source changed.");
    await expect(
      dialog.getByTestId("template-check-locate").first(),
    ).toBeDisabled();
    await dialog.getByTestId("template-check-again").click();
    await expect(dialog).toContainText("{{unknown.changed}}");
    await expect(dialog).not.toContainText("The source changed.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("header-dropDownButton")).toBeFocused();
    expect(await readTemplateState(page, workspaceId, sourceDocId)).toEqual(
      before,
    );
    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    const row = page.getByTestId(
      `template-catalog-row-document:${sourceDocId}`,
    );
    const trigger = row.getByRole("button", { name: /Open menu/ });
    await trigger.click();
    await page.getByTestId("template-check-action").click();
    await expect(dialog).toContainText("{{unknown.changed}}");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(row).toContainText("Check {{workspace.name}}");
    expect(errors).toEqual([]);
  });
  test("Database bodies share manual inputs, native repeats and source revalidation", async ({
    context,
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await context.addCookies(
      (await getCachedAdminStorageState(requestFactory)).cookies,
    );
    await ensureAdminUser(request);
    // A published native fixture exercises Registry guards without detaching or
    // editing another managed source. Its title input must never become a body field.
    const bundle = await JSZip.loadAsync(
      await readFile(
        resolve(__dirname, "../../fixtures/template-row-inputs.zip"),
      ),
    );
    const manifest = JSON.parse(
      await bundle.file("manifest.json")!.async("string"),
    );
    manifest.template_id = `tv10-row-body-${Date.now()}`;
    bundle.file("manifest.json", JSON.stringify(manifest));
    const uploaded = await page.request.post(`${frontend}/graphql`, {
      multipart: {
        operations: JSON.stringify({
          query: `mutation($file:Upload!){admin{importTemplate(file:$file){entry{id} revision{id} error}}}`,
          variables: { file: null },
        }),
        map: JSON.stringify({ "0": ["variables.file"] }),
        "0": {
          name: "row-body.zip",
          mimeType: "application/zip",
          buffer: await bundle.generateAsync({ type: "nodebuffer" }),
        },
      },
    });
    expect(uploaded.ok()).toBe(true);
    const imported = await uploaded.json();
    expect(imported.errors).toBeUndefined();
    const importedTemplate = imported.data.admin.importTemplate;
    expect(importedTemplate.error).toBeNull();
    const templateId: string = importedTemplate.entry.id;
    rowBodyTemplateIds.add(templateId);
    await gqlRequest(
      request,
      `mutation($id:ID!){admin{publishRevision(revisionId:$id){id}}}`,
      { id: importedTemplate.revision.id },
    );
    await gqlRequest(
      request,
      `mutation($workspaceId:String!,$templateId:ID!){admin{assignTemplateToWorkspace(workspaceId:$workspaceId,templateId:$templateId,provisioningMode:ManagedUntilLocalEdit,selectionMode:Published){id}}}`,
      { workspaceId, templateId },
    );
    await gqlRequest(
      request,
      `mutation($workspaceId:String!){admin{triggerReconcile(workspaceId:$workspaceId)}}`,
      { workspaceId },
    );
    const instance = async () =>
      (
        await gqlRequest<{
          admin: {
            workspaceTemplateInstances: {
              templateId: string;
              workspaceDocId: string | null;
              state: string;
            }[];
          };
        }>(
          request,
          `query($workspaceId:String!){admin{workspaceTemplateInstances(workspaceId:$workspaceId){templateId workspaceDocId state}}}`,
          { workspaceId },
        )
      ).admin.workspaceTemplateInstances.find(
        (item) => item.templateId === templateId,
      );
    await expect
      .poll(async () => (await instance())?.state, { timeout: 30_000 })
      .toBe("Ok");
    const sourceId = (await instance())!.workspaceDocId!;
    const body = page.locator("myoxus-paragraph .inline-editor").first();
    const created = await gqlRequest<{
      createDatabase: { database: { id: string } };
    }>(
      request,
      `mutation($input:CreateDatabaseInput!){createDatabase(input:$input){database{id}}}`,
      {
        input: {
          workspaceId,
          title: "Row body input flow",
          initialViewKind: "Table",
        },
      },
    );
    const databaseId = created.createDatabase.database.id;
    const inventoryRows = async () =>
      (
        await gqlRequest<{
          workspace: {
            databaseRows: {
              rows: {
                row: {
                  id: string;
                  contentDocument: { externalId: string } | null;
                };
              }[];
            };
          };
        }>(
          request,
          `query($workspaceId:String!,$databaseId:ID!){workspace(id:$workspaceId){databaseRows(databaseId:$databaseId,first:100){rows{row{id contentDocument{externalId}}}}}}`,
          { workspaceId, databaseId },
        )
      ).workspace.databaseRows.rows;
    const route = `${frontend}/workspace/${workspaceId}/databases/${databaseId}`;
    await page.goto(route);
    await page
      .getByRole("button", { name: "View settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Row templates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add template", exact: true })
      .click();
    await page.getByTestId(`template-suggestion-item-${templateId}`).click();
    const binding = page.getByRole("region", {
      name: "Row templates",
      exact: true,
    });
    const entry = binding.getByRole("button", { name: /Available$/ }).last();
    await expect(entry).toBeVisible();
    if ((await entry.getAttribute("aria-expanded")) !== "true")
      await entry.click();
    const templateRegion = binding
      .getByRole("region", { name: /Available$/ })
      .last();
    const setDefault = templateRegion.getByRole("button", {
      name: "Set default",
      exact: true,
    });
    if (await setDefault.isVisible()) await setDefault.click();
    await expect(
      templateRegion.getByRole("button", { name: "Default", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Expand/collapse sidebar", exact: true })
      .click();
    await page.getByTestId("database-new-row").click();
    const dialog = page.getByTestId("template-input-dialog");
    await expect(dialog.getByRole("textbox")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("database-new-row")).toBeFocused();
    expect(await inventoryRows()).toHaveLength(0);
    await page.getByTestId("database-new-row").click();
    await dialog
      .getByRole("textbox", { name: "project name" })
      .fill("Atlas {{date}}");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await inventoryRows()).length).toBe(1);
    const createdRow = (await inventoryRows())[0]!.row;
    const targetId = createdRow.contentDocument!.externalId;
    await page.goto(`${route}?rowId=${createdRow.id}`);
    await page
      .getByRole("button", { name: "Page content", exact: true })
      .click();
    const target = page.getByTestId(`editor-${targetId}`);
    await expect(target).toContainText("Atlas {{date}}");
    expect(
      (await target.innerText()).match(/Atlas \{\{date\}\}/g)!.length,
    ).toBeGreaterThanOrEqual(2);
    expect(await target.innerText()).not.toMatch(
      /\{\{(?:input\.|workspace\.|creator\.|member\.|document\.created_at)/,
    );
    const targetBody = target
      .locator("myoxus-paragraph .inline-editor")
      .first();
    await targetBody.click();
    await target.locator("myoxus-page-root").press("End");
    await page.keyboard.insertText(" Edited Row body");
    await waitForNativeSourceSync(page, targetId);
    await page.reload();
    await page
      .getByRole("button", { name: "Page content", exact: true })
      .click();
    await expect(target).toContainText("Edited Row body");
    await page.goto(`${frontend}/workspace/${workspaceId}/${sourceId}`);
    await expect(body).toContainText("{{input.project_name}}");
    // Leave the source before the authorized consumer opens the Database.
    await page.goto(route);
    const user = await createTestUser(request);
    const consumer = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      serviceWorkers: "block",
    });
    try {
      await gqlRequest(
        request,
        `mutation($workspaceId:ID!,$userId:ID!){admin{addWorkspaceMember(workspaceId:$workspaceId,userId:$userId,role:"Collaborator"){id}}}`,
        { workspaceId, userId: user.id },
      );
      await apiSignIn(consumer.request, user.email, user.password);
      const authenticated = await gqlRequest<{ currentUser: { id: string } }>(
        consumer.request,
        `{currentUser{id}}`,
      );
      expect(authenticated.currentUser.id).toBe(user.id);
      await gqlRequest(
        consumer.request,
        `mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){effectiveValues{locale}}}`,
        { input: { locale: "en" } },
      );
      const userPage = await consumer.newPage();
      userPage.on("pageerror", (error) => errors.push(error.message));
      userPage.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await userPage.goto(route);
      await userPage.getByTestId("database-new-row").click();
      const userDialog = userPage.getByTestId("template-input-dialog");
      await userDialog
        .getByRole("textbox", { name: "project name" })
        .fill("Denied body");
      // Workspace Collaborator is an intentional role floor. Archive the
      // published source to exercise real revocation of binding eligibility;
      // the server integration owner separately blocks source-document reads.
      await gqlRequest(
        request,
        `mutation($id:ID!){admin{archiveTemplate(templateId:$id){id}}}`,
        { id: templateId },
      );
      rowBodyTemplateIds.delete(templateId);
      const deniedWrite = userPage.waitForResponse(
        (response) =>
          response.request().headers()["x-operation-name"] ===
          "createDatabaseRowFromTemplate",
      );
      await userDialog
        .getByRole("button", { name: "Apply", exact: true })
        .click();
      const denial = await (await deniedWrite).json();
      expect(denial.errors?.[0]?.extensions?.code).toBe(
        "MIX_DATABASE_ROW_TEMPLATE_TEMPLATE_INVALID",
      );
      await expect(
        userDialog.getByText(
          "The template could not be applied. Please try again.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(await inventoryRows()).toHaveLength(1);
      await expect(
        userDialog.getByRole("textbox", { name: "project name" }),
      ).toHaveValue("Denied body");
      await userDialog
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    } finally {
      await consumer.close();
      await deleteTestUser(request, user.id);
    }
    expect(errors).toEqual([]);
  });
});
