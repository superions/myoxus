// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, request as requestFactory, test } from "@playwright/test";

import {
  ensureAdminUser,
  getCachedAdminStorageState,
  gqlRequest,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import { fetchOrganizationUnits } from "../../../../adminfrontend/e2e/fixtures/organization";
import {
  getAccountLocale,
  setAccountLocale,
} from "../../../shared/user-preferences-helper";
import { waitForWorkspaceReady } from "../../../shared/workspace-helper";

const frontend =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";

const shippedTemplates = [
  { slug: "meeting-agenda", title: "Agenda · Besprechungsprotokoll" },
  { slug: "meeting-focus", title: "Fokus · Besprechungsprotokoll" },
  { slug: "meeting-register", title: "Register · Besprechungsprotokoll" },
] as const;

type CatalogEntry = {
  id: string;
  slug: string;
  title: string;
  source: string;
  status: string;
};

let workspaceId = "";
let catalog = new Map<string, CatalogEntry>();
let sourceDocIds = new Map<string, string>();
let adminCookies: string[] = [];
let originalLocale: string | null | undefined;

test.describe("Shipped meeting templates", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    const adminState = await getCachedAdminStorageState(requestFactory);
    adminCookies = adminState.cookies.map(
      (cookie) => `${cookie.name}=${cookie.value}`,
    );
    const preferenceTarget = {
      request,
      gqlEndpoint: `${frontend}/graphql`,
      cookies: adminCookies,
    };
    originalLocale = await getAccountLocale(preferenceTarget);
    await setAccountLocale(preferenceTarget, "en");
    const ownerUnit = (await fetchOrganizationUnits(request)).find(
      (unit) => unit.parentUnitId === null,
    );
    if (!ownerUnit) throw new Error("Organization root unit is missing");
    const workspace = await gqlRequest<{
      createWorkspaceInOrganizationUnit: { id: string; initialized: boolean };
    }>(
      request,
      `mutation CreateMeetingTemplateWorkspace($input: CreateWorkspaceInOrganizationUnitInput!) {
        createWorkspaceInOrganizationUnit(input: $input) { id initialized }
      }`,
      {
        input: {
          unitId: ownerUnit.id,
          name: `Meeting template flow ${Date.now()}`,
        },
      },
    );
    expect(workspace.createWorkspaceInOrganizationUnit.initialized).toBe(true);
    workspaceId = workspace.createWorkspaceInOrganizationUnit.id;

    const data = await gqlRequest<{
      admin: { templateCatalog: CatalogEntry[] };
    }>(
      request,
      `query ShippedMeetingTemplateCatalog {
        admin {
          templateCatalog(status: Active, take: 100) {
            id
            slug
            title
            source
            status
          }
        }
      }`,
    );
    catalog = new Map(
      data.admin.templateCatalog.map((entry) => [entry.slug, entry]),
    );

    for (const expected of shippedTemplates) {
      const entry = catalog.get(expected.slug);
      expect(entry).toMatchObject({
        slug: expected.slug,
        title: expected.title,
        source: "Bundle",
        status: "Active",
      });
    }

    type Instance = {
      templateId: string;
      workspaceDocId: string | null;
      state: string;
    };
    const readInstances = () =>
      gqlRequest<{ admin: { workspaceTemplateInstances: Instance[] } }>(
        request,
        `query MaterializedShippedMeetingTemplates($workspaceId: String!) {
          admin {
            workspaceTemplateInstances(workspaceId: $workspaceId) {
              templateId
              workspaceDocId
              state
            }
          }
        }`,
        { workspaceId },
      );
    await expect
      .poll(async () => {
        const instances = await readInstances();
        return shippedTemplates.filter((expected) => {
          const templateId = catalog.get(expected.slug)?.id;
          return instances.admin.workspaceTemplateInstances.some(
            (instance) =>
              instance.templateId === templateId &&
              instance.state === "Ok" &&
              instance.workspaceDocId,
          );
        }).length;
      })
      .toBe(shippedTemplates.length);
    const instances = await readInstances();
    for (const expected of shippedTemplates) {
      const entry = catalog.get(expected.slug)!;
      const instance = instances.admin.workspaceTemplateInstances.find(
        (candidate) => candidate.templateId === entry.id,
      );
      expect(instance).toMatchObject({
        workspaceDocId: expect.any(String),
        state: "Ok",
      });
      sourceDocIds.set(expected.slug, instance!.workspaceDocId!);
    }
  });

  test.afterAll(async ({ request }) => {
    try {
      if (workspaceId) {
        await ensureAdminUser(request);
        await gqlRequest(
          request,
          `mutation DeleteMeetingTemplateWorkspace($id: ID!) {
        admin { deleteWorkspace(id: $id) }
      }`,
          { id: workspaceId },
        );
      }
    } finally {
      if (originalLocale !== undefined) {
        await setAccountLocale(
          {
            request,
            gqlEndpoint: `${frontend}/graphql`,
            cookies: adminCookies,
          },
          originalLocale,
        );
      }
    }
  });

  test("provisions packaged sources and keeps applied content independent", async ({
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
    for (const sourceDocId of sourceDocIds.values()) {
      await expect(page.locator(`a[href$="/${sourceDocId}"]`)).toHaveCount(0);
    }

    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    const focus = shippedTemplates.find(
      (template) => template.slug === "meeting-focus",
    )!;
    const focusEntry = catalog.get(focus.slug)!;
    const focusRow = page.getByTestId(
      `template-catalog-row-registry:${focusEntry.id}`,
    );
    await expect(focusRow).toContainText(focus.title);
    await focusRow.getByRole("button", { name: "Use", exact: true }).click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/templates`),
    );
    const firstTargetId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(firstTargetId).not.toBe(sourceDocIds.get(focus.slug));
    await expect(page.locator("doc-title .inline-editor").first()).toHaveText(
      focus.title,
    );

    const decisionCell = page
      .getByRole("row")
      .filter({ has: page.getByText("Entscheidung", { exact: true }) })
      .first()
      .getByRole("cell")
      .nth(2)
      .locator("v-line");
    await expect(decisionCell).toContainText("[Ergebnis / Begründung]");
    const decision = `Entscheidung ${Date.now()}`;
    await decisionCell.selectText();
    await page.keyboard.type(decision);
    await expect(decisionCell).toHaveText(decision);
    await page.locator("doc-title .inline-editor").first().click();
    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(page.getByText(decision, { exact: true })).toBeVisible();

    await page.locator(`a[href$="/${workspaceId}/templates"]`).click();
    await focusRow.getByRole("button", { name: "Use", exact: true }).click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/templates`),
    );
    const secondTargetId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(secondTargetId).not.toBe(firstTargetId);
    await expect(page.getByText(decision, { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("row")
        .filter({ has: page.getByText("Entscheidung", { exact: true }) })
        .first()
        .getByRole("cell")
        .nth(2),
    ).toContainText("[Ergebnis / Begründung]");

    await page.goto(`${frontend}/workspace/${workspaceId}/${firstTargetId}`);
    await expect(page.getByText(decision, { exact: true })).toBeVisible();

    for (const expected of shippedTemplates.filter(
      (template) => template.slug !== focus.slug,
    )) {
      await page.getByTestId("sidebar-new-page-button").click();
      await expect(page.getByTestId("template-docs-button")).toBeVisible();
      const targetUrl = page.url();

      await page.getByTestId("template-docs-button").click();
      const source = page.getByRole("menuitem", {
        name: expected.title,
        exact: true,
      });
      await expect(source).toBeVisible();
      await expect(source).toBeEnabled();
      await source.click();

      await expect(
        page.locator("doc-title .inline-editor").first(),
      ).toContainText(expected.title);
      expect(page.url()).toBe(targetUrl);
      await page.reload();
      await expect(
        page.locator("doc-title .inline-editor").first(),
      ).toContainText(expected.title);
    }

    await page.goto(`${frontend}/workspace/${workspaceId}/all`);
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("workspace-navigation-settings").click();
    await page.getByTestId("workspace-setting:preference").click();
    await page.getByTestId("journal-template-selector").click();
    await page
      .getByRole("menuitem", { name: focus.title, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Workspace" })
      .getByRole("button", { name: "Close" })
      .click();

    const journalDate = "2042-03-17";
    await page.goto(
      `${frontend}/workspace/${workspaceId}/journals?date=${journalDate}`,
    );
    const journalTitle = await page.getByTestId("date").innerText();
    await page.getByTestId("confirm-create-journal-button").click();
    await page.waitForURL(
      (url) => !url.pathname.endsWith(`/${workspaceId}/journals`),
    );
    await expect(page.getByTestId("date")).toHaveText(journalTitle);
    await expect(
      page.getByText("Punkte & Ergebnisse", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("date")).toHaveText(journalTitle);
    await expect(
      page.getByText("Punkte & Ergebnisse", { exact: true }),
    ).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
