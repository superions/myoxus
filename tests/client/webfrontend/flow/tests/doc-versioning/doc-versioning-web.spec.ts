// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Document-Versioning Web E2E (P-DOC-VER-10-02).
 *
 * Covers the user-facing sidebar journey against the running local live stack:
 * create named versions, pin one version, restore an older version and open the
 * server-backed diff viewer. Setup/cleanup uses HTTP/GraphQL APIs only; tests
 * do not write directly to the database and delete the temporary workspace/user
 * at the end.
 *
 * Run:
 *   npx playwright test --config tests/client/webfrontend/flow/playwright.config.ts \
 *     tests/client/webfrontend/flow/tests/doc-versioning/doc-versioning-web.spec.ts
 */

import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import {
  apiSignIn,
  type ApiUser,
  createTestUser,
  ensureAdminUser,
  FRONTEND_BASE,
  gqlRequest,
  injectSessionCookies,
} from "../../../../adminfrontend/e2e/fixtures/auth";

interface WorkspaceListResponse {
  workspaces: Array<{ id: string }>;
}

interface DocumentVersionOption {
  id: string;
  label: string;
  event?: string;
}

interface PdfExportBootstrapResponse {
  availablePdfTemplates: Array<{ id: string; name: string }>;
  documentVersions: DocumentVersionOption[];
}

interface PdfTemplatesResponse {
  admin: {
    pdfTemplates: Array<{
      id: string;
      slug: string;
      name: string;
      manifest: {
        inputs_schema?: {
          properties?: Record<string, { enum?: unknown[]; type?: string }>;
          required?: string[];
        };
      };
    }>;
  };
}

interface AssignPdfTemplateResponse {
  admin: {
    assignPdfTemplateToWorkspace: { templateId: string };
  };
}

interface SetDefaultPdfTemplateResponse {
  admin: {
    setWorkspaceDefaultPdfTemplate: { defaultTemplateId: string | null };
  };
}

interface DocumentVersionsResponse {
  documentVersions: DocumentVersionOption[];
}

interface UpdateDocumentVersioningSettingsResponse {
  updateDocumentVersioningSettings: {
    enabled: boolean;
    retentionCount: number;
    autoVersionOn: string[];
  };
}

interface ExportPdfResponse {
  exportPdf: {
    id: string;
    status: string;
    errorClass: string | null;
    errorDetail: string | null;
  };
}

interface PdfExportJobResponse {
  pdfExportJob: {
    id: string;
    status: string;
    errorClass: string | null;
    errorDetail: string | null;
  };
}

interface DeleteUserResponse {
  admin: { deleteUser: { success: boolean } };
}

let user: ApiUser;
let userCookies: string[];
let workspaceId: string;
let historyDocId: string;
const temporaryWorkspaceIds = new Set<string>();

async function revision(page: Page, targetWorkspaceId: string, docId: string) {
  const data = await gqlRequest<{ documentHistoryRevision: string }>(
    page.request,
    `query HistoryRevision($w: ID!, $d: ID!) {
      documentHistoryRevision(workspaceId: $w, docId: $d)
    }`,
    { w: targetWorkspaceId, d: docId },
  );
  return data.documentHistoryRevision;
}

function typedInputsForTemplate(
  template: PdfTemplatesResponse["admin"]["pdfTemplates"][number],
): Record<string, unknown> | undefined {
  const schema = template.manifest.inputs_schema;
  const required = schema?.required ?? [];
  if (!required.length) return undefined;

  return Object.fromEntries(
    required.map((key) => {
      const property = schema?.properties?.[key];
      if (property?.enum?.length) return [key, property.enum[0]];
      switch (property?.type) {
        case "boolean":
          return [key, true];
        case "integer":
        case "number":
          return [key, 1];
        case "array":
          return [key, [`E2E ${key}`]];
        case "object":
          return [key, {}];
        default:
          return [key, `E2E ${key}`];
      }
    }),
  );
}

async function clickFirstVisible(
  page: Page,
  selectors: string[],
): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await locator.click();
      return;
    }
  }
  throw new Error(`No visible locator found: ${selectors.join(", ")}`);
}

async function dismissOpenInAppOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        [data-testid="open-in-app-card"] {
          display: none !important;
          pointer-events: none !important;
        }
      `,
    })
    .catch(() => undefined);
  const dismissButton = page.getByRole("button", { name: "Dismiss" });
  if (await dismissButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await dismissButton
      .evaluate((button: HTMLButtonElement) => button.click())
      .catch(async () => {
        await page.keyboard.press("Escape");
      });
  }
}

async function createWorkspacePage(
  page: Page,
  targetWorkspaceId: string,
  title: string,
): Promise<string> {
  await page.goto(`${FRONTEND_BASE}/workspace/${targetWorkspaceId}/all`, {
    waitUntil: "load",
  });
  await dismissOpenInAppOverlay(page);
  await page.waitForSelector(
    '[data-testid="sidebar-new-page-button"], [data-testid="new-page-button-trigger"]',
    { timeout: 30_000 },
  );
  await clickFirstVisible(page, [
    '[data-testid="sidebar-new-page-button"]',
    '[data-testid="new-page-button-trigger"]',
  ]);
  await page.waitForURL(
    (url) => !url.pathname.endsWith(`/${targetWorkspaceId}/all`),
    { timeout: 20_000 },
  );

  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  await titleEditor.fill(title);
  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForSelector("v-line", { timeout: 20_000 });
  await dismissOpenInAppOverlay(page);

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive doc id from URL: ${page.url()}`);
  }
  return docId;
}

async function appendEditorText(page: Page, text: string): Promise<void> {
  const route = new URL(page.url()).pathname.split("/");
  const before = await revision(page, route[2], route[3]);
  let body = page
    .locator("myoxus-paragraph .inline-editor[contenteditable=true]:visible")
    .last();
  await expect(body).toBeVisible({ timeout: 10_000 });
  const pointAtEnd = async (target: Locator) => {
    const box = await target.boundingBox();
    if (!box) throw new Error("The writable paragraph has no pointer bounds");
    await target.click({ position: { x: box.width - 2, y: box.height - 2 } });
    await expect
      .poll(() =>
        target.evaluate((node) => {
          const element = node as HTMLElement & {
            inlineEditor: { yText: { length: number; toString(): string } };
          };
          const block = element.closest("myoxus-paragraph") as HTMLElement & {
            model: { id: string };
            host: {
              selection: {
                value: Array<{
                  from?: { blockId: string; index: number; length: number };
                }>;
              };
            };
          };
          const selected = block.host.selection.value[0]?.from;
          return (
            element.contains(window.getSelection()?.anchorNode ?? null) &&
            selected?.blockId === block.model.id &&
            selected.index === element.inlineEditor.yText.length &&
            selected.length === 0
          );
        }),
      )
      .toBe(true);
  };
  // The editor's controlled selection must consume the native pointer before
  // typing. Contenteditable fill/End can otherwise target an earlier selection.
  await pointAtEnd(body);
  const initial = await body.evaluate((node) =>
    (
      node as HTMLElement & { inlineEditor: { yText: { toString(): string } } }
    ).inlineEditor.yText.toString(),
  );
  if (initial) {
    const count = await page
      .locator("myoxus-paragraph .inline-editor[contenteditable=true]:visible")
      .count();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(
        "myoxus-paragraph .inline-editor[contenteditable=true]:visible",
      ),
    ).toHaveCount(count + 1);
    body = page
      .locator("myoxus-paragraph .inline-editor[contenteditable=true]:visible")
      .last();
    await pointAtEnd(body);
  }
  await page.keyboard.insertText(text);
  await expect(body).toContainText(text, { timeout: 10_000 });
  // A DOM-only edit is not a restore/binding proof. Require the live Y.Text
  // and an acknowledged server revision before taking a capture or navigating.
  await expect
    .poll(() =>
      body.evaluate((node) => {
        const editor = (
          node as HTMLElement & {
            inlineEditor?: { yText: { toString(): string } };
          }
        ).inlineEditor;
        return editor?.yText.toString();
      }),
    )
    .toBe(text);
  await expect
    .poll(() => revision(page, route[2], route[3]), {
      timeout: 30_000,
    })
    .not.toBe(before);
  await page.locator("doc-title .inline-editor").first().click();
  // A leaf revision can advance while the workspace metadata update is still
  // queued. Settle both sync units before a full navigation disposes the editor.
  await page.evaluate(async (docId) => {
    const workspace = (
      window as Window & {
        currentWorkspace?: {
          id: string;
          engine: {
            doc: {
              waitForSynced(id: string, signal: AbortSignal): Promise<void>;
            };
          };
        };
      }
    ).currentWorkspace;
    if (!workspace)
      throw new Error("No active workspace for write acknowledgement");
    const signal = AbortSignal.timeout(30_000);
    await workspace.engine.doc.waitForSynced(workspace.id, signal);
    await workspace.engine.doc.waitForSynced(docId, signal);
  }, route[3]);
}

async function deleteTestUserStrict(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const data = await gqlRequest<DeleteUserResponse>(
    request,
    `mutation DeleteE2EUser($id: String!) {
       admin {
         deleteUser(id: $id) {
           success
         }
       }
     }`,
    { id: userId },
  );
  expect(data.admin.deleteUser.success).toBe(true);
}

async function openDocumentVersionsSidebar(page: Page): Promise<void> {
  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });
  await dismissOpenInAppOverlay(page);
  const toggle = page.getByTestId("context-panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await page.getByTestId("header-dropDownButton").click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  const tool = page.getByTestId("workbench-tool-menu-activity");
  if ((await tool.getAttribute("data-checked")) !== "true") {
    await tool.focus();
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("document-versions-sidebar")).toBeVisible({
    timeout: 15_000,
  });
}

async function createNamedVersion(
  page: Page,
  label: string,
  description: string,
): Promise<string> {
  await page.getByTestId("document-version-new").click();
  const modal = page.getByTestId("document-version-modal-create");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("document-version-modal-create-label").fill(label);
  await page
    .getByTestId("document-version-modal-create-description")
    .fill(description);
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/graphql") &&
      response.request().postData()?.includes("captureDocumentHistory") ===
        true,
    { timeout: 10_000 },
  );
  await modal.getByRole("button", { name: "Save" }).click();
  const response = await createResponse;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data?: {
      captureDocumentHistory?: {
        historyId?: string;
        version?: {
          id?: string;
          label?: string;
          description?: string | null;
        };
      };
    };
    errors?: unknown;
  };
  const createdVersion = body.data?.captureDocumentHistory?.version;
  if (body.errors || !createdVersion?.id || !createdVersion.label) {
    throw new Error(
      `captureDocumentHistory failed: ${JSON.stringify(
        body.errors ?? body.data,
      )}`,
    );
  }
  const row = page
    .getByTestId("version-history-item")
    .filter({ hasText: createdVersion.label });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back to doc" }).click();
  await expect(page.getByTestId("document-history-view")).toBeHidden();
  await expect(page.getByTestId("document-versions-sidebar")).toBeVisible();
  return createdVersion.label;
}

async function assignFirstPdfTemplateToWorkspace(
  request: APIRequestContext,
  targetWorkspaceId: string,
): Promise<{ templateId: string; typedInputs?: Record<string, unknown> }> {
  await ensureAdminUser(request);
  const templates = await gqlRequest<PdfTemplatesResponse>(
    request,
    `query PdfTemplatesForE2E {
       admin {
         pdfTemplates(includeDeleted: false) {
           id
           slug
           name
           manifest
         }
       }
     }`,
  );
  const template = templates.admin.pdfTemplates.find(
    (candidate) => candidate.slug === "default",
  );
  if (!template) {
    throw new Error("PDF export auto-version E2E needs the default template");
  }

  const assignment = await gqlRequest<AssignPdfTemplateResponse>(
    request,
    `mutation AssignPdfTemplateForE2E($workspaceId: ID!, $templateId: ID!) {
       admin {
         assignPdfTemplateToWorkspace(
           workspaceId: $workspaceId
           templateId: $templateId
         ) {
           templateId
         }
       }
     }`,
    { workspaceId: targetWorkspaceId, templateId: template.id },
  );
  expect(assignment.admin.assignPdfTemplateToWorkspace.templateId).toBe(
    template.id,
  );

  const defaulted = await gqlRequest<SetDefaultPdfTemplateResponse>(
    request,
    `mutation DefaultPdfTemplateForE2E($workspaceId: ID!, $templateId: ID!) {
       admin {
         setWorkspaceDefaultPdfTemplate(
           workspaceId: $workspaceId
           templateId: $templateId
         ) {
           defaultTemplateId
         }
       }
     }`,
    { workspaceId: targetWorkspaceId, templateId: template.id },
  );
  expect(defaulted.admin.setWorkspaceDefaultPdfTemplate.defaultTemplateId).toBe(
    template.id,
  );
  return {
    templateId: template.id,
    typedInputs: typedInputsForTemplate(template),
  };
}

async function signInApiAsTemporaryUser(
  request: APIRequestContext,
): Promise<void> {
  await apiSignIn(request, user.email, user.password);
}

async function enablePdfAutoVersioning(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
): Promise<void> {
  const data = await gqlRequest<UpdateDocumentVersioningSettingsResponse>(
    request,
    `mutation EnablePdfAutoVersioning($workspaceId: ID!, $docId: ID!) {
       updateDocumentVersioningSettings(
         workspaceId: $workspaceId
         docId: $docId
         enabled: true
         retentionCount: 10
         autoVersionOn: [on_pdf_export]
       ) {
         enabled
         retentionCount
         autoVersionOn
       }
     }`,
    { workspaceId, docId },
  );
  expect(data.updateDocumentVersioningSettings.enabled).toBe(true);
  expect(data.updateDocumentVersioningSettings.autoVersionOn).toContain(
    "on_pdf_export",
  );
}

async function loadPdfExportBootstrap(
  request: APIRequestContext,
  targetWorkspaceId: string,
  docId: string,
): Promise<PdfExportBootstrapResponse> {
  return gqlRequest<PdfExportBootstrapResponse>(
    request,
    `query PdfExportBootstrap($workspaceId: ID!, $docId: ID!) {
       availablePdfTemplates(workspaceId: $workspaceId) {
         id
         name
       }
       documentVersions(workspaceId: $workspaceId, docId: $docId) {
         id
         label
       }
     }`,
    { workspaceId: targetWorkspaceId, docId },
  );
}

async function exportPdfWithLatestDocumentState(
  request: APIRequestContext,
  targetWorkspaceId: string,
  docId: string,
  templateId: string,
  typedInputs?: Record<string, unknown>,
): Promise<string> {
  const data = await gqlRequest<ExportPdfResponse>(
    request,
    `mutation ExportPdf($input: PdfExportInputV2Input!) {
       exportPdf(input: $input) {
         id
         status
         errorClass
         errorDetail
       }
     }`,
    {
      input: {
        workspaceId: targetWorkspaceId,
        docId,
        templateId,
        documentVersionId: "latest",
        ...(typedInputs ? { typedInputs } : {}),
      },
    },
  );
  expect(data.exportPdf.errorClass).toBeNull();
  expect(data.exportPdf.errorDetail).toBeNull();
  return data.exportPdf.id;
}

async function waitForPdfExportTerminal(
  request: APIRequestContext,
  jobId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const data = await gqlRequest<PdfExportJobResponse>(
          request,
          `query PdfExportJob($jobId: String!) {
             pdfExportJob(jobId: $jobId) {
               id
               status
               errorClass
               errorDetail
             }
           }`,
          { jobId },
        );
        if (data.pdfExportJob.status === "failed") {
          throw new Error(
            `PDF export failed: ${data.pdfExportJob.errorClass ?? "Unknown"} ${
              data.pdfExportJob.errorDetail ?? ""
            }`,
          );
        }
        return data.pdfExportJob.status;
      },
      {
        message: `wait for PDF export job ${jobId} to finish`,
        timeout: 60_000,
      },
    )
    .toBe("done");
}

async function waitForAutoPdfVersionLabel(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
): Promise<string> {
  await expect
    .poll(
      async () => {
        const data = await gqlRequest<DocumentVersionsResponse>(
          request,
          `query DocumentVersions($workspaceId: ID!, $docId: ID!) {
             documentVersions(workspaceId: $workspaceId, docId: $docId) {
               id
               label
               event
             }
           }`,
          { workspaceId, docId },
        );
        return data.documentVersions;
      },
      {
        message: "wait for automatic pdf-export document version",
        timeout: 15_000,
      },
    )
    .toContainEqual(expect.objectContaining({ event: "pdf_export" }));

  const data = await gqlRequest<DocumentVersionsResponse>(
    request,
    `query DocumentVersions($workspaceId: ID!, $docId: ID!) {
       documentVersions(workspaceId: $workspaceId, docId: $docId) {
         id
         label
         event
       }
     }`,
    { workspaceId, docId },
  );
  const autoVersion = data.documentVersions.find(
    (version) => version.event === "pdf_export",
  );
  if (!autoVersion) {
    throw new Error(
      `Auto PDF version missing in ${JSON.stringify(data.documentVersions)}`,
    );
  }
  return autoVersion.label;
}

async function openPdfExportDialog(page: Page): Promise<void> {
  await page.getByTestId("header-dropDownButton").click();
  const exportMenu = page.getByTestId("export-menu");
  await expect(exportMenu).toBeVisible({ timeout: 10_000 });
  await exportMenu.hover();
  if (
    !(await page
      .getByTestId("export-to-pdf-export")
      .isVisible({ timeout: 2_000 })
      .catch(() => false))
  ) {
    await exportMenu.click();
  }
  await page.getByTestId("export-to-pdf-export").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const continueButton = dialog.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  if (await continueButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await continueButton.click();
  }
  await expect(
    page.getByRole("combobox", { name: "Document version", exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

test.describe.serial("Document versioning web sidebar", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    user = await createTestUser(request, {
      name: "Doc Versioning E2E",
    });
    userCookies = await apiSignIn(request, user.email, user.password);

    const data = await gqlRequest<WorkspaceListResponse>(
      request,
      `query DocVersioningE2EWorkspaces { workspaces { id } }`,
    );
    workspaceId = data.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error("Temporary E2E user has no workspace");
    }
    temporaryWorkspaceIds.add(workspaceId);
  });

  test.afterAll(async ({ request }) => {
    await ensureAdminUser(request);
    for (const id of temporaryWorkspaceIds) {
      await gqlRequest(
        request,
        `mutation($id: ID!) {
        admin { deleteWorkspace(id: $id) }
      }`,
        { id },
      );
      const remaining = await gqlRequest<{
        admin: { adminWorkspace: unknown };
      }>(
        request,
        `query($id: String!) { admin { adminWorkspace(id: $id) { id } } }`,
        { id },
      );
      expect(remaining.admin.adminWorkspace).toBeNull();
    }
    if (user?.id) {
      await deleteTestUserStrict(request, user.id);
    }
  });

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      // Initial about:blank and sandboxed export frames have opaque origins.
      if (window.location.origin === "null") return;
      window.localStorage.setItem("app_config", '{"onBoarding":false}');
      window.localStorage.setItem(
        "global-state:open-link-mode",
        '"open-in-web"',
      );
      window.localStorage.setItem("is-first-open", "false");
      window.localStorage.setItem("dismissAiOnboarding", "true");
      window.localStorage.setItem("dismissAiOnboardingEdgeless", "true");
      window.localStorage.setItem("dismissAiOnboardingLocal", "true");
    });
    await injectSessionCookies(context, userCookies);
  });

  test("P-DOC-VER-10-02: create, pin, restore and diff are visible", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const suffix = Date.now().toString(36);
    const pageTitle = `Doc Versioning E2E ${suffix}`;
    const firstLabel = `e2e-baseline-${suffix}`;
    const secondLabel = `e2e-review-${suffix}`;

    const docId = await createWorkspacePage(page, workspaceId, pageTitle);
    historyDocId = docId;
    await openDocumentVersionsSidebar(page);
    await page.getByTestId("document-version-automation-settings").click();
    const workspaceSettings = page.getByRole("dialog", { name: "Workspace" });
    await expect(
      workspaceSettings.getByRole("heading", { name: "Automatic saving" }),
    ).toBeVisible();
    await expect(
      workspaceSettings.getByRole("combobox", {
        name: "Automatic edit capture",
      }),
    ).toHaveValue("Server default (on)");
    await expect(
      workspaceSettings.getByRole("combobox", {
        name: "Capture interval (minutes)",
      }),
    ).toHaveValue("Server default (1440)");
    await workspaceSettings.getByRole("button", { name: "Close" }).click();

    await appendEditorText(page, `Baseline paragraph ${suffix}`);
    const firstVersionLabel = await createNamedVersion(
      page,
      firstLabel,
      "Baseline created from E2E",
    );
    await appendEditorText(page, `Review paragraph ${suffix}`);
    const secondVersionLabel = await createNamedVersion(
      page,
      secondLabel,
      "Second version created from E2E",
    );

    // More than one cursor page: the named selector can resolve an exact old
    // capture before that row is loaded. These public, unnamed captures also
    // distinguish the server's named-only predicate from client-side filtering.
    for (let index = 0; index < 11; index++) {
      await gqlRequest(
        page.request,
        `mutation($w: ID!, $d: ID!, $k: ID!) {
        captureDocumentHistory(workspaceId: $w, docId: $d, requestKey: $k) { historyId }
      }`,
        { w: workspaceId, d: docId, k: crypto.randomUUID() },
      );
    }

    await page.getByTestId("document-version-history").click();
    await expect(page.getByTestId("version-history-item")).toHaveCount(10);
    await expect(
      page
        .getByTestId("version-history-item")
        .filter({ hasText: firstVersionLabel }),
    ).toHaveCount(0);
    await page.getByTestId("history-named-version-select").click();
    await page
      .getByRole("option", { name: firstVersionLabel, exact: true })
      .click();
    const outOfPageId = new URL(page.url()).searchParams.get("snapshotId");
    const metadata = await gqlRequest<{
      workspace: { history: { timestamp: string } };
    }>(
      page.request,
      `query($w: String!, $d: String!, $s: ID!) {
        workspace(id: $w) { history(guid: $d, snapshotId: $s) { timestamp } }
      }`,
      { w: workspaceId, d: docId, s: outOfPageId },
    );
    await expect(page.locator("[data-capture-time]")).toHaveAttribute(
      "data-capture-time",
      metadata.workspace.history.timestamp,
    );
    const clear = page
      .getByTestId("history-named-version-select")
      .locator("..")
      .getByRole("button", { name: "Clear selection" });
    await clear.click();
    expect(new URL(page.url()).searchParams.has("versionId")).toBe(false);
    const namedRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/graphql") &&
        request.postData()?.includes("listHistory") === true &&
        request.postDataJSON().variables.namedOnly === true,
    );
    await page.getByTestId("history-filter-named").click();
    await namedRequest;
    await expect(page.getByTestId("version-history-item")).toHaveCount(2);
    await page.getByTestId("history-filter-all").click();
    await expect(page.getByTestId("version-history-item")).toHaveCount(10);
    await page.getByTestId("page-history-load-more").click();
    await expect(page.getByTestId("version-history-item")).toHaveCount(13);
    const secondRow = page
      .getByTestId("version-history-item")
      .filter({ hasText: secondVersionLabel });
    await secondRow
      .locator("xpath=..")
      .getByRole("button", { name: "Actions" })
      .click();
    await page
      .getByRole("menuitem", { name: `Pin: ${secondVersionLabel}` })
      .click();
    await expect(secondRow).toContainText("Pinned", { timeout: 10_000 });

    const firstRow = page
      .getByTestId("version-history-item")
      .filter({ hasText: firstVersionLabel });
    await firstRow.click();
    expect(new URL(page.url()).searchParams.has("versionId")).toBe(false);
    const preview = page.getByTestId("document-history-view");
    await expect(
      preview.getByText(`Baseline paragraph ${suffix}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      preview.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toHaveCount(0);
    const snapshotId = new URL(page.url()).searchParams.get("snapshotId");
    expect(snapshotId).toMatch(/^[1-9]\d*$/);
    const beforeFailure = await revision(page, workspaceId, docId);
    // Metadata still lists/selects this entry when its binary request fails.
    const binary = `**/api/workspaces/${workspaceId}/docs/${docId}/histories/by-id/${snapshotId}`;
    await page.route(binary, (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.reload();
    await expect(page.getByTestId("version-history-item")).toHaveCount(10, {
      timeout: 15_000,
    });
    expect(new URL(page.url()).searchParams.get("snapshotId")).toBe(snapshotId);
    await expect(page.locator("[data-capture-time]")).toHaveAttribute(
      "data-capture-time",
      metadata.workspace.history.timestamp,
    );
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toBeDisabled();
    expect(await revision(page, workspaceId, docId)).toBe(beforeFailure);
    await page.unroute(binary);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      preview.getByText(`Baseline paragraph ${suffix}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByTestId("confirm-restore-history-button").click();
    await expect(preview).toBeHidden({ timeout: 30_000 });
    expect(new URL(page.url()).searchParams.has("history")).toBe(false);
    await expect(
      page.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText(`Baseline paragraph ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toHaveCount(0);
    await openDocumentVersionsSidebar(page);
    const restoredHistories = await gqlRequest<{
      workspace: { histories: Array<{ snapshotId: string; origin: string }> };
    }>(
      page.request,
      `query($w: String!, $d: String!) {
        workspace(id: $w) { histories(guid: $d, take: 10) { snapshotId origin } }
      }`,
      { w: workspaceId, d: docId },
    );
    const recovery = restoredHistories.workspace.histories.find(
      (row) => row.origin === "recovery",
    );
    expect(recovery).toBeDefined();
    const recoveryRow = page.locator(
      `[data-testid="document-history-recent-item"][data-snapshot-id="${recovery!.snapshotId}"]`,
    );
    await expect(recoveryRow).toContainText("Recovery state", {
      timeout: 15_000,
    });
    await recoveryRow.click();
    await expect(
      preview.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toBeVisible();
    await page.getByTestId("history-back-to-document").click();
    await expect(
      page.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toHaveCount(0);

    await page.getByTestId("document-version-history").click();
    await page.getByTestId("history-named-version-select").click();
    await page
      .getByRole("option", { name: secondVersionLabel, exact: true })
      .click();
    await page.getByTestId("history-mode-changes").click();
    const comparison = page.getByTestId("history-current-comparison");
    await expect(comparison.locator("[data-current-revision]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      comparison
        .locator("del")
        .filter({ hasText: `Review paragraph ${suffix}` }),
    ).toContainText(`Review paragraph ${suffix}`);
    await expect(
      comparison
        .locator("del")
        .filter({ hasText: `Review paragraph ${suffix}` })
        .first(),
    ).toHaveCSS("text-decoration-line", "line-through");
    const selectedLink = page.url();
    await page.reload();
    await expect(comparison.locator("[data-current-revision]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      comparison
        .locator("del")
        .filter({ hasText: `Review paragraph ${suffix}` }),
    ).toContainText(`Review paragraph ${suffix}`);
    expect(page.url()).toBe(selectedLink);
    await page.getByTestId("history-back-to-document").click();
    await page.goBack();
    await expect(comparison.locator("[data-current-revision]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      comparison
        .locator("del")
        .filter({ hasText: `Review paragraph ${suffix}` }),
    ).toContainText(`Review paragraph ${suffix}`);
    await page.goForward();
    await expect(preview).toBeHidden();

    // Explicit named intent takes the named restore path, independently of the
    // snapshot-only restore above. Reopen proves durable content and bindings.
    await page.goto(
      selectedLink.replace("historyMode=changes", "historyMode=preview"),
    );
    await expect(
      preview.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const namedRestore = page.waitForRequest(
      (request) =>
        request.url().endsWith("/graphql") &&
        request.postData()?.includes("restoreDocumentVersion") === true,
    );
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByTestId("confirm-restore-history-button").click();
    expect((await namedRestore).postDataJSON().variables.id).toBe(
      new URL(selectedLink).searchParams.get("versionId"),
    );
    await expect(preview).toBeHidden();
    await page.reload();
    await expect(
      page.getByText(`Review paragraph ${suffix}`, { exact: true }),
    ).toBeVisible();
    await appendEditorText(page, `Uncaptured current red blue red! ${suffix}`);
    await page.goto(selectedLink);
    await expect(comparison.locator("[data-current-revision]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      comparison
        .locator("ins")
        .filter({ hasText: `Uncaptured current red blue red! ${suffix}` }),
    ).toContainText(`Uncaptured current red blue red! ${suffix}`);
    await expect(
      comparison.getByText(/formatting|presentation|non-text/).first(),
    ).toBeVisible();
  });

  test("late overview cannot replace a newly opened document's history", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let release!: () => void;
    let blocked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    let delayed = false;
    let finished: Promise<void> | undefined;
    await page.route("**/graphql", async (route) => {
      const request = route.request();
      const operation = request.postDataJSON();
      if (
        !delayed &&
        operation.query.includes("documentVersioningOverview") &&
        operation.variables.docId === historyDocId
      ) {
        delayed = true;
        const response = await route.fetch();
        blocked();
        finished = gate.then(() => route.fulfill({ response }));
        await finished;
      } else await route.continue();
    });
    try {
      await page.goto(
        `${FRONTEND_BASE}/workspace/${workspaceId}/${historyDocId}?history=1`,
      );
      await expect
        .poll(() => finished !== undefined, { timeout: 30_000 })
        .toBe(true);
      await arrived;
      await clickFirstVisible(page, [
        "[data-testid=sidebar-new-page-button]",
        "[data-testid=new-page-button-trigger]",
      ]);
      await page.waitForURL(
        (url) => !url.pathname.endsWith(`/${historyDocId}`),
      );
      const nextId = new URL(page.url()).pathname.split("/").at(-1)!;
      const nextTitle = `New scope ${Date.now().toString(36)}`;
      await page.locator("doc-title .inline-editor").first().fill(nextTitle);
      await appendEditorText(page, `Persisted empty history ${nextTitle}`);
      await openDocumentVersionsSidebar(page);
      await page.getByTestId("document-version-history").click();
      await expect(page.getByTestId("document-history-view")).toBeVisible();
      await expect(page.getByTestId("version-history-item")).toHaveCount(0);
      const lateResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/graphql") &&
          response
            .request()
            .postData()
            ?.includes("documentVersioningOverview") === true &&
          response.request().postDataJSON().variables.docId === historyDocId,
      );
      release();
      await finished;
      await (await lateResponse).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(new URL(page.url()).pathname).toBe(
        `/workspace/${workspaceId}/${nextId}`,
      );
      await expect(page.getByTestId("version-history-item")).toHaveCount(0);
      await expect(
        page.getByTestId("history-named-version-select"),
      ).toHaveCount(0);
      await expect(page.getByTestId("workbench-view-header")).toContainText(
        nextTitle,
      );
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
      await finished;
      await page.unroute("**/graphql");
    }
  });

  test("P-DOC-VER-10-03: PDF export auto-trigger creates a picker-visible version", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = Date.now().toString(36);
    const pageTitle = `Doc Versioning PDF E2E ${suffix}`;

    const { templateId: assignedTemplateId, typedInputs } =
      await assignFirstPdfTemplateToWorkspace(request, workspaceId);
    await signInApiAsTemporaryUser(request);
    const docId = await createWorkspacePage(page, workspaceId, pageTitle);
    await appendEditorText(page, `PDF export source paragraph ${suffix}`);
    await enablePdfAutoVersioning(request, workspaceId, docId);

    const bootstrap = await loadPdfExportBootstrap(request, workspaceId, docId);
    const template = bootstrap.availablePdfTemplates.find(
      (candidate) => candidate.id === assignedTemplateId,
    );
    if (!template) {
      throw new Error("PDF export auto-version E2E needs an assigned template");
    }
    expect(template.id).toBe(assignedTemplateId);
    expect(bootstrap.documentVersions).toHaveLength(0);

    const jobId = await exportPdfWithLatestDocumentState(
      request,
      workspaceId,
      docId,
      template.id,
      typedInputs,
    );
    await waitForPdfExportTerminal(request, jobId);
    const autoLabel = await waitForAutoPdfVersionLabel(
      request,
      workspaceId,
      docId,
    );

    await openPdfExportDialog(page);
    const picker = page.getByRole("combobox", {
      name: "Document version",
      exact: true,
    });
    await picker.click();
    await expect(
      page.getByRole("option").filter({ hasText: autoLabel }),
    ).toHaveCount(1);
  });

  test("automatic history follows a real public Move into the destination policy", async ({
    page,
    request,
  }) => {
    // The supported minimum is fifteen minutes. Never shorten server defaults,
    // manufacture a due timestamp or substitute a manual capture for this row.
    test.setTimeout(1_200_000);
    await signInApiAsTemporaryUser(request);
    const target = (
      await gqlRequest<{ createWorkspace: { id: string } }>(
        request,
        `mutation { createWorkspace { id } }`,
      )
    ).createWorkspace.id;
    temporaryWorkspaceIds.add(target);
    const policy = async (id: string, interval: number) => {
      const current = await gqlRequest<{
        workspaceHistorySettings: { revision: string };
      }>(
        request,
        `query($w: ID!) { workspaceHistorySettings(workspaceId: $w) { revision } }`,
        { w: id },
      );
      await gqlRequest(
        request,
        `mutation($w: ID!, $i: UpdateWorkspaceHistorySettingsInput!) {
        updateWorkspaceHistorySettings(workspaceId: $w, input: $i) {
          effectiveEditCaptureEnabled effectiveEditCaptureIntervalMs
        }
      }`,
        {
          w: id,
          i: {
            expectedRevision: current.workspaceHistorySettings.revision,
            editCaptureEnabled: true,
            editCaptureIntervalMs: interval,
          },
        },
      );
    };
    await policy(workspaceId, 1_800_000);
    await policy(target, 900_000);
    const suffix = Date.now().toString(36);
    const docId = await createWorkspacePage(
      page,
      workspaceId,
      `Moved history ${suffix}`,
    );
    await appendEditorText(page, `Before ownership transition ${suffix}`);
    const preflight = await gqlRequest<{
      workspaceContentPreflight: {
        operation: { id: string };
        revision: string;
        blockers: string[];
        requiredConfirmations: Array<{
          kind: string;
          userId: string | null;
          role: string | null;
          resource: { kind: string; id: string; workspaceId: string } | null;
        }>;
      };
    }>(
      request,
      `mutation($i: WorkspaceContentPreflightInput!) {
      workspaceContentPreflight(input: $i) {
        operation { id } revision blockers
        requiredConfirmations { kind userId role resource { kind id workspaceId } }
      }
    }`,
      {
        i: {
          idempotencyId: crypto.randomUUID(),
          kind: "Move",
          sourceWorkspaceId: workspaceId,
          targetWorkspaceId: target,
          resources: [{ kind: "Document", id: docId }],
        },
      },
    );
    const plan = preflight.workspaceContentPreflight;
    expect(plan.blockers).toEqual([]);
    await gqlRequest(
      request,
      `mutation($i: WorkspaceContentExecuteInput!) {
      executeWorkspaceContentOperation(input: $i) { id status }
    }`,
      {
        i: {
          operationId: plan.operation.id,
          revision: plan.revision,
          confirmations: plan.requiredConfirmations.map(
            ({ resource, ...confirmation }) => ({
              ...confirmation,
              resource: resource
                ? { kind: resource.kind, id: resource.id }
                : null,
              resourceWorkspaceId: resource?.workspaceId,
            }),
          ),
        },
      },
    );
    await expect
      .poll(
        async () =>
          (
            await gqlRequest<{ workspaceContentOperation: { status: string } }>(
              request,
              `query($id: UUID!) { workspaceContentOperation(operationId: $id) { status } }`,
              { id: plan.operation.id },
            )
          ).workspaceContentOperation.status,
        { timeout: 90_000 },
      )
      .toBe("Succeeded");
    await page.goto(`${FRONTEND_BASE}/workspace/${target}/${docId}`);
    await expect(
      page.getByText(`Before ownership transition ${suffix}`, { exact: true }),
    ).toBeVisible();
    await appendEditorText(page, `After Move automatic capture ${suffix}`);
    const histories = async (id: string) =>
      (
        await gqlRequest<{
          workspace: {
            histories: Array<{
              snapshotId: string;
              origin: string;
              timestamp: string;
            }>;
          } | null;
        }>(
          request,
          `query($w: String!, $d: String!) {
      workspace(id: $w) { histories(guid: $d, take: 100) { snapshotId origin timestamp } }
    }`,
          { w: id, d: docId },
        )
      ).workspace?.histories ?? [];
    await openDocumentVersionsSidebar(page);
    await page.getByTestId("document-version-history").click();
    await expect
      .poll(
        async () =>
          (await histories(target)).some((row) => row.origin === "automatic"),
        {
          timeout: 1_020_000,
          intervals: [15_000],
        },
      )
      .toBe(true);
    const automatic = (await histories(target)).find(
      (row) => row.origin === "automatic",
    )!;
    // Current ownership denies the old scope rather than returning synthetic
    // success/empty metadata for a foreign document.
    await expect(histories(workspaceId)).rejects.toThrow();
    // Reopening revalidates the same scoped owner, then the consumer reads bytes.
    await page.getByTestId("history-back-to-document").click();
    await page.getByTestId("document-version-history").click();
    const row = page
      .getByTestId("version-history-item")
      .filter({ hasText: "Automatic" })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    expect(new URL(page.url()).searchParams.get("snapshotId")).toBe(
      automatic.snapshotId,
    );
    await expect(
      page
        .getByTestId("document-history-view")
        .getByText(`After Move automatic capture ${suffix}`, { exact: true }),
    ).toBeVisible();
  });
});
