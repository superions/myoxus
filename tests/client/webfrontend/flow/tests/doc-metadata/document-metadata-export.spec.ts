/**
 * Document metadata PDF-export E2E.
 *
 * Covers PDF-export contract boundaries that are not visible in component tests:
 * selected version export, latest auto-versioning, server-backed required
 * classification blocking, and append-only restore state visible to the client.
 */
import {
  type APIRequestContext,
  expect,
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
import { deleteWorkspace } from "../../../../adminfrontend/e2e/fixtures/workspaces";

interface WorkspaceListResponse {
  workspaces: Array<{ id: string }>;
}

interface WorkspaceDocsResponse {
  workspace: {
    docs: {
      edges: Array<{ node: { id: string; title: string } }>;
    };
  };
}

interface DeleteUserResponse {
  admin: { deleteUser: { success: boolean } };
}

interface PdfTemplatesResponse {
  admin: {
    pdfTemplates: Array<{
      id: string;
      slug: string;
      name: string;
      manifest?: {
        inputs_schema?: {
          required?: string[];
          properties?: Record<string, { enum?: unknown[]; type?: string }>;
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

interface MetadataFieldResponse {
  admin: {
    documentMetadataFieldDefinitions: Array<{
      key: string;
      exportMode: string;
    }>;
  };
}

interface MetadataValuesResponse {
  documentMetadataValueDefinitions: Array<{
    id: string;
    key: string;
    label: string;
    isActive: boolean;
  }>;
}

interface SetMetadataResponse {
  setDocumentMetadata: {
    metadata: {
      fields: Array<{
        key: string;
        reference: { id: string } | null;
      }>;
    };
  };
}

interface DocumentVersionsResponse {
  documentVersions: Array<{
    id: string;
    label: string;
    description: string | null;
    event: string;
    kind: string;
  }>;
}

interface ExportPdfResponse {
  exportPdf: {
    id: string;
    status: string;
    errorClass: string | null;
    errorDetail: string | null;
  };
}

interface UpdateDocumentVersioningSettingsResponse {
  updateDocumentVersioningSettings: {
    enabled: boolean;
    autoVersionOn: string[];
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

let user: ApiUser;
let userCookies: string[];
let workspaceId: string;
let templateId: string;
let typedInputs: Record<string, unknown> | undefined;

async function deleteTestUserStrict(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const data = await gqlRequest<DeleteUserResponse>(
    request,
    `mutation DeleteDocMetadataExportUser($id: String!) {
       admin { deleteUser(id: $id) { success } }
     }`,
    { id: userId },
  );
  expect(data.admin.deleteUser.success).toBe(true);
}

function typedInputsForTemplate(
  template: PdfTemplatesResponse["admin"]["pdfTemplates"][number],
): Record<string, unknown> | undefined {
  const schema = template.manifest?.inputs_schema;
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

async function assignDefaultTemplateToWorkspace(
  request: APIRequestContext,
  targetWorkspaceId: string,
): Promise<void> {
  await ensureAdminUser(request);
  const templates = await gqlRequest<PdfTemplatesResponse>(
    request,
    `query DocMetadataExportTemplates {
       admin {
         pdfTemplates(includeDeleted: false) { id slug name manifest }
       }
     }`,
  );
  const template =
    templates.admin.pdfTemplates.find((entry) => entry.slug === "default") ??
    templates.admin.pdfTemplates[0];
  if (!template)
    throw new Error("Document metadata PDF E2E needs an active PDF template");
  const assigned = await gqlRequest<AssignPdfTemplateResponse>(
    request,
    `mutation AssignDocMetadataExportTemplate($workspaceId: ID!, $templateId: ID!) {
       admin {
         assignPdfTemplateToWorkspace(workspaceId: $workspaceId, templateId: $templateId) { templateId }
       }
     }`,
    { workspaceId: targetWorkspaceId, templateId: template.id },
  );
  expect(assigned.admin.assignPdfTemplateToWorkspace.templateId).toBe(
    template.id,
  );

  const defaulted = await gqlRequest<SetDefaultPdfTemplateResponse>(
    request,
    `mutation DefaultDocMetadataExportTemplate($workspaceId: ID!, $templateId: ID!) {
       admin {
         setWorkspaceDefaultPdfTemplate(workspaceId: $workspaceId, templateId: $templateId) { defaultTemplateId }
       }
     }`,
    { workspaceId: targetWorkspaceId, templateId: template.id },
  );
  expect(defaulted.admin.setWorkspaceDefaultPdfTemplate.defaultTemplateId).toBe(
    template.id,
  );
  templateId = template.id;
  typedInputs = typedInputsForTemplate(template);
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
      content: `[data-testid="open-in-app-card"] { display: none !important; pointer-events: none !important; }`,
    })
    .catch(() => undefined);
  const dismissButton = page.getByRole("button", { name: "Dismiss" });
  if (await dismissButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await dismissButton
      .click()
      .catch(async () => page.keyboard.press("Escape"));
  }
}

async function createWorkspacePage(
  request: APIRequestContext,
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
    {
      timeout: 30_000,
    },
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

  const segments = new URL(page.url()).pathname.split("/").filter(Boolean);
  const workspaceRouteIndex = segments.findIndex(
    (segment, index) =>
      segment === "workspace" && segments[index + 1] === targetWorkspaceId,
  );
  const routeId =
    workspaceRouteIndex >= 0 ? segments[workspaceRouteIndex + 2] : undefined;
  // Cloud document IDs are not UUID-only; newly created docs commonly use
  // compact URL-safe IDs, so only reject known workspace collection routes.
  if (routeId && !["all", "journals"].includes(routeId)) {
    return routeId;
  }

  const docs = await gqlRequest<WorkspaceDocsResponse>(
    request,
    `query DocMetadataExportResolveDoc($workspaceId: String!) {
       workspace(id: $workspaceId) {
         docs(pagination: { first: 50 }) {
           edges { node { id title } }
         }
       }
     }`,
    { workspaceId: targetWorkspaceId },
  );
  const docId = docs.workspace.docs.edges
    .map((edge) => edge.node)
    .find((doc) => doc.title === title)?.id;
  if (!docId)
    throw new Error(`Could not derive doc id from URL/title: ${page.url()}`);
  return docId;
}

async function appendEditorText(page: Page, text: string): Promise<void> {
  const blank = page.getByTestId("page-editor-blank");
  if (await blank.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await blank.click();
  } else {
    await page.locator("[data-myoxus-editor-container]").click();
  }
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
  await expect(page.locator("v-line").filter({ hasText: text })).toBeVisible({
    timeout: 10_000,
  });
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
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
}

async function readClassificationMode(
  request: APIRequestContext,
): Promise<string> {
  const data = await gqlRequest<MetadataFieldResponse>(
    request,
    `query DocMetadataExportDefinition {
       admin { documentMetadataFieldDefinitions { key exportMode } }
     }`,
  );
  const definition = data.admin.documentMetadataFieldDefinitions.find(
    (item) => item.key === "classification",
  );
  if (!definition)
    throw new Error("Missing classification metadata field definition");
  return definition.exportMode;
}

async function setClassificationExportMode(
  request: APIRequestContext,
  exportMode: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation SetClassificationExportMode($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) {
       admin { updateDocumentMetadataFieldDefinition(input: $input) { key exportMode } }
     }`,
    { input: { key: "classification", exportMode } },
  );
}

async function classificationId(request: APIRequestContext): Promise<string> {
  const values = await gqlRequest<MetadataValuesResponse>(
    request,
    `query DocMetadataExportClassifications($fieldKey: String!) {
       documentMetadataValueDefinitions(fieldKey: $fieldKey) { id key label isActive }
     }`,
    { fieldKey: "classification" },
  );
  const value =
    values.documentMetadataValueDefinitions.find(
      (item) => item.key === "internal" && item.isActive,
    ) ?? values.documentMetadataValueDefinitions.find((item) => item.isActive);
  if (!value) throw new Error("Missing active classification value");
  return value.id;
}

async function setDocumentClassification(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
  nextClassificationId: string | null,
): Promise<void> {
  const data = await gqlRequest<SetMetadataResponse>(
    request,
    `mutation SetDocClassification($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) {
       setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) {
         metadata { fields { key reference { id } } }
       }
     }`,
    { workspaceId, docId, input: { classificationId: nextClassificationId } },
    { "x-myoxus-client-format": "myoxus-native" },
  );
  const classification = data.setDocumentMetadata.metadata.fields.find(
    (field) => field.key === "classification",
  );
  expect(classification?.reference?.id ?? null).toBe(nextClassificationId);
}

async function createNamedVersion(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
  label: string,
): Promise<{ id: string; label: string }> {
  const data = await gqlRequest<{
    createDocumentVersion: { id: string; label: string };
  }>(
    request,
    `mutation CreateDocMetadataExportVersion($workspaceId: ID!, $docId: ID!, $label: String!) {
       createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: $label) { id label }
    }`,
    { workspaceId, docId, label },
  );
  expect(data.createDocumentVersion.id).toBeTruthy();
  expect(data.createDocumentVersion.label).toBeTruthy();
  return data.createDocumentVersion;
}

async function enablePdfAutoVersioning(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
): Promise<void> {
  const data = await gqlRequest<UpdateDocumentVersioningSettingsResponse>(
    request,
    `mutation EnableDocMetadataPdfAutoVersioning($workspaceId: ID!, $docId: ID!) {
       updateDocumentVersioningSettings(
         workspaceId: $workspaceId
         docId: $docId
         enabled: true
         retentionCount: 10
         autoVersionOn: [on_pdf_export]
       ) {
         enabled
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

async function restoreVersion(
  request: APIRequestContext,
  versionId: string,
): Promise<string> {
  const data = await gqlRequest<{
    restoreDocumentVersion: {
      id: string;
      label: string;
      event: string;
      kind: string;
    };
  }>(
    request,
    `mutation RestoreDocMetadataExportVersion($id: ID!) {
       restoreDocumentVersion(id: $id) { id label event kind }
     }`,
    { id: versionId },
  );
  expect(data.restoreDocumentVersion.event).toBe("restore");
  expect(data.restoreDocumentVersion.kind).toBe("restored");
  return data.restoreDocumentVersion.id;
}

async function exportPdf(
  request: APIRequestContext,
  docId: string,
  documentVersionId: string,
): Promise<string> {
  const data = await gqlRequest<ExportPdfResponse>(
    request,
    `mutation ExportDocMetadataPdf($input: PdfExportInputV2Input!) {
       exportPdf(input: $input) { id status errorClass errorDetail }
     }`,
    {
      input: {
        workspaceId,
        docId,
        templateId,
        documentVersionId,
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
          `query DocMetadataPdfJob($jobId: String!) {
             pdfExportJob(jobId: $jobId) { id status errorClass errorDetail }
           }`,
          { jobId },
        );
        if (data.pdfExportJob.status === "failed") {
          throw new Error(
            `PDF export failed: ${data.pdfExportJob.errorClass ?? "Unknown"} ${data.pdfExportJob.errorDetail ?? ""}`,
          );
        }
        return data.pdfExportJob.status;
      },
      { timeout: 60_000, message: `wait for PDF export job ${jobId}` },
    )
    .toBe("done");
}

async function readVersions(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
): Promise<DocumentVersionsResponse> {
  return gqlRequest<DocumentVersionsResponse>(
    request,
    `query DocMetadataExportVersions($workspaceId: ID!, $docId: ID!) {
       documentVersions(workspaceId: $workspaceId, docId: $docId) { id label description event kind }
     }`,
    { workspaceId, docId },
  );
}

test.describe.serial("Document metadata PDF export E2E", () => {
  test.setTimeout(180_000);

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    user = await createTestUser(request, { name: "Doc Metadata Export E2E" });
    userCookies = await apiSignIn(request, user.email, user.password);
    const workspaces = await gqlRequest<WorkspaceListResponse>(
      request,
      `query DocMetadataExportWorkspaces { workspaces { id } }`,
    );
    workspaceId = workspaces.workspaces[0]?.id;
    if (!workspaceId) throw new Error("Temporary export user has no workspace");
    await assignDefaultTemplateToWorkspace(request, workspaceId);
  });

  test.afterAll(async ({ request }) => {
    await ensureAdminUser(request);
    if (workspaceId) await deleteWorkspace(request, workspaceId);
    if (user?.id) await deleteTestUserStrict(request, user.id);
  });

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
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

  test("P-DOC-ATTR-I-02/I-03/I-05: selected/latest export and restore stay version-bound", async ({
    page,
    request,
  }) => {
    await apiSignIn(request, user.email, user.password);
    const suffix = Date.now().toString(36);
    const docId = await createWorkspacePage(
      request,
      page,
      workspaceId,
      `Doc Metadata Export Versions ${suffix}`,
    );
    await appendEditorText(page, `Selected version source ${suffix}`);
    const selectedVersion = await createNamedVersion(
      request,
      workspaceId,
      docId,
      `selected-${suffix}`,
    );
    const selectedVersionId = selectedVersion.id;
    await enablePdfAutoVersioning(request, workspaceId, docId);
    const versionsBeforeLatest = (
      await readVersions(request, workspaceId, docId)
    ).documentVersions.length;

    const selectedJobId = await exportPdf(request, docId, selectedVersionId);
    await waitForPdfExportTerminal(request, selectedJobId);

    await appendEditorText(page, `Latest version source ${suffix}`);
    const latestJobId = await exportPdf(request, docId, "latest");
    await waitForPdfExportTerminal(request, latestJobId);
    const afterLatest = await readVersions(request, workspaceId, docId);
    expect(
      afterLatest.documentVersions.some(
        (version) => version.id === selectedVersionId,
      ),
    ).toBe(true);
    expect(afterLatest.documentVersions.length).toBe(versionsBeforeLatest + 1);

    const restoredVersionId = await restoreVersion(request, selectedVersionId);
    const afterRestore = await readVersions(request, workspaceId, docId);
    const restored = afterRestore.documentVersions.find(
      (version) => version.id === restoredVersionId,
    );
    expect(restored?.event).toBe("restore");
    expect(restored?.kind).toBe("restored");
    expect(restored?.description).toContain(selectedVersion.label);
  });

  test("P-DOC-ATTR-I-04: required classification blocks PDF export until fixed", async ({
    page,
    request,
  }) => {
    await ensureAdminUser(request);
    const originalMode = await readClassificationMode(request);
    try {
      await setClassificationExportMode(request, "required");
      await apiSignIn(request, user.email, user.password);
      const suffix = Date.now().toString(36);
      const docId = await createWorkspacePage(
        request,
        page,
        workspaceId,
        `Doc Metadata Export Block ${suffix}`,
      );
      await appendEditorText(page, `Required classification source ${suffix}`);
      await setDocumentClassification(request, workspaceId, docId, null);

      await openPdfExportDialog(page);
      await expect(
        page.getByText("Document metadata blocks PDF export"),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("Classification is required for export"),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole("button", { name: "Start export" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });

      await setDocumentClassification(
        request,
        workspaceId,
        docId,
        await classificationId(request),
      );
      await openPdfExportDialog(page);
      await expect(
        page.getByRole("button", { name: "Start export" }),
      ).toBeEnabled({ timeout: 15_000 });
    } finally {
      await ensureAdminUser(request);
      await setClassificationExportMode(request, originalMode);
    }
  });
});
