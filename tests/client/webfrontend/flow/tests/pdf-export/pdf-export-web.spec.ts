/**
 * Web E2E: user-facing PDF export download and Admin -> User assignment path.
 *
 * This is intentionally stronger than the server integration tests: it creates
 * a real document in the web client, opens the PDF export dialog from the page
 * export menu, clicks Start export, and asserts that the browser downloads a
 * real PDF through the same `/api/pdf-export/{job}/download` response the user
 * path consumes. The second scenario changes the workspace default template via
 * AdminRoot and verifies that a normal user sees that assignment without gaining
 * access to admin-only PDF template operations.
 *
 * Run:
 *   npx playwright test --config tests/client/webfrontend/flow/playwright.config.ts \
 *     tests/client/webfrontend/flow/tests/pdf-export/pdf-export-web.spec.ts
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

import {
  API_BASE,
  apiSignIn,
  type ApiUser,
  createTestUser,
  ensureAdminUser,
  FRONTEND_BASE,
  gqlRequest,
  injectSessionCookies,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import { deleteWorkspace } from "../../../../adminfrontend/e2e/fixtures/workspaces";
import { openDocumentTool } from "../../helpers/workbench-helper";

const execFileAsync = promisify(execFile);

interface WorkspaceListResponse {
  workspaces: Array<{ id: string }>;
}

interface PdfTemplatesResponse {
  admin: {
    pdfTemplates: Array<{ id: string; slug: string; name: string }>;
  };
}

type PdfTemplateFixture = PdfTemplatesResponse["admin"]["pdfTemplates"][number];

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

interface DeleteUserResponse {
  admin: { deleteUser: { success: boolean } };
}

let user: ApiUser;
let userCookies: string[];
let workspaceId: string;

async function deleteTestUserStrict(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const data = await gqlRequest<DeleteUserResponse>(
    request,
    `mutation DeletePdfExportE2EUser($id: String!) {
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

async function assignDefaultTemplateToWorkspace(
  request: APIRequestContext,
  targetWorkspaceId: string,
  preferredSlug = "default",
): Promise<PdfTemplateFixture> {
  await ensureAdminUser(request);
  const templates = await gqlRequest<PdfTemplatesResponse>(
    request,
    `query PdfExportWebE2ETemplates {
       admin {
         pdfTemplates(includeDeleted: false) {
           id
           slug
           name
         }
       }
     }`,
  );
  const template =
    templates.admin.pdfTemplates.find(
      (entry) => entry.slug === preferredSlug,
    ) ?? templates.admin.pdfTemplates[0];
  if (!template) {
    throw new Error("PDF export E2E needs at least one active PDF template");
  }

  const assigned = await gqlRequest<AssignPdfTemplateResponse>(
    request,
    `mutation AssignPdfExportWebE2ETemplate($workspaceId: ID!, $templateId: ID!) {
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
  expect(assigned.admin.assignPdfTemplateToWorkspace.templateId).toBe(
    template.id,
  );

  const defaulted = await gqlRequest<SetDefaultPdfTemplateResponse>(
    request,
    `mutation DefaultPdfExportWebE2ETemplate($workspaceId: ID!, $templateId: ID!) {
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
  return template;
}

async function listActivePdfTemplates(
  request: APIRequestContext,
): Promise<PdfTemplateFixture[]> {
  await ensureAdminUser(request);
  const templates = await gqlRequest<PdfTemplatesResponse>(
    request,
    `query PdfExportWebE2EActiveTemplates {
       admin {
         pdfTemplates(includeDeleted: false) {
           id
           slug
           name
         }
       }
     }`,
  );
  return templates.admin.pdfTemplates;
}

function cookieHeaderFromSetCookie(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((header) => header.split(";")[0]).join("; ");
}

async function expectUserCannotReadAdminPdfTemplates(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.post(`${API_BASE}/graphql`, {
    data: {
      query:
        "query PdfExportUserMustNotReadAdminTemplates { admin { pdfTemplates { id } } }",
    },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeaderFromSetCookie(userCookies),
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data?.admin ?? null).toBeNull();
  expect(
    JSON.stringify(body.errors ?? []),
    "user-owned PDF E2E account must not access AdminRoot PDF operations",
  ).toMatch(/Unauthorized|Forbidden|permission|admin/i);
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
      .click()
      .catch(async () => page.keyboard.press("Escape"));
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
  const blank = page.getByTestId("page-editor-blank");
  if (await blank.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await blank.click();
  } else {
    await page.locator("[data-myoxus-editor-container]").click();
  }
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText(text);
  await expect(page.locator("v-line").filter({ hasText: text })).toBeVisible({
    timeout: 10_000,
  });
}

async function extractPdfText(downloadPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [downloadPath, "-"]);
    return stdout;
  } catch (pdftotextError) {
    try {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const bytes = await readFile(downloadPath);
      const pdf = await getDocument({
        data: new Uint8Array(bytes),
        disableWorker: true,
      }).promise;
      const chunks: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        chunks.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      return chunks.join("\n");
    } catch (pdfjsError) {
      throw new Error(
        `PDF text extraction failed. pdftotext error: ${String(
          pdftotextError,
        )}; pdfjs fallback error: ${String(pdfjsError)}`,
      );
    }
  }
}

async function openPdfExportHistorySidebar(page: Page): Promise<void> {
  const surface = await openDocumentTool(page, "export");
  await expect(surface.getByTestId("pdf-export-history-panel")).toBeVisible({
    timeout: 10_000,
  });
}

async function openPdfExportDialog(page: Page): Promise<void> {
  await page.getByTestId("header-dropDownButton").click();
  const pdfExportItem = page.getByTestId("export-to-pdf-export");
  if (await pdfExportItem.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await pdfExportItem.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    return;
  }
  const pdfExportMenuItem = page.getByRole("menuitem", {
    name: /^Export to PDF$/,
  });
  if (
    await pdfExportMenuItem.isVisible({ timeout: 2_000 }).catch(() => false)
  ) {
    await pdfExportMenuItem.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    return;
  }
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
  await pdfExportItem.click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
}

async function openPdfExportInputs(page: Page): Promise<void> {
  const next = page.getByRole("button", { name: "Continue", exact: true });
  if (await next.isVisible()) await next.click();
  await expect(page.getByRole("button", { name: "Start export" })).toBeEnabled({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "Advanced typed inputs", exact: true })
    .click();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe.serial("PDF export web E2E", () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    user = await createTestUser(request, { name: "PDF Export Web E2E" });
    userCookies = await apiSignIn(request, user.email, user.password);

    const workspaces = await gqlRequest<WorkspaceListResponse>(
      request,
      `query PdfExportWebE2EWorkspaces { workspaces { id } }`,
    );
    workspaceId = workspaces.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error("Temporary PDF export E2E user has no workspace");
    }
    await assignDefaultTemplateToWorkspace(request, workspaceId);
  });

  test.afterAll(async ({ request }) => {
    await ensureAdminUser(request);
    if (workspaceId) {
      await deleteWorkspace(request, workspaceId);
    }
    if (user?.id) {
      await deleteTestUserStrict(request, user.id);
    }
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

  test("INV-PDF-WEB-E2E-01: page export dialog downloads a real PDF", async ({
    page,
  }, testInfo) => {
    const suffix = Date.now().toString(36);
    const title = `PDF Export Web E2E ${suffix}`;
    const paragraph = `Rendered PDF source paragraph ${suffix} äöü ÄÖÜ ß € # []`;
    await createWorkspacePage(page, workspaceId, title);
    await appendEditorText(page, paragraph);
    await openPdfExportDialog(page);
    await openPdfExportInputs(page);

    await expect(
      page.getByRole("textbox", { name: "Advanced typed inputs", exact: true }),
    ).toHaveValue(new RegExp(`"title":\\s*"${escapeRegExp(title)}"`), {
      timeout: 5_000,
    });
    await testInfo.attach("pdf-export-dialog-desktop", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    const downloadResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          /^\/api\/pdf-export\/[^/]+\/download$/.test(url.pathname)
        );
      },
      { timeout: 60_000 },
    );
    const browserDownloadPromise = page.waitForEvent("download", {
      timeout: 60_000,
    });

    await page.getByRole("button", { name: "Start export" }).click();

    const [downloadResponse, browserDownload] = await Promise.all([
      downloadResponsePromise,
      browserDownloadPromise,
    ]);
    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()["content-type"]).toContain(
      "application/pdf",
    );
    expect(browserDownload.suggestedFilename()).toMatch(/\.pdf$/);
    expect(await browserDownload.failure()).toBeNull();
    const downloadPath = await browserDownload.path();
    expect(downloadPath).toBeTruthy();
    const pdfBytes = await readFile(downloadPath!);
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfBytes.length).toBeGreaterThan(100);
    const pdfText = await extractPdfText(downloadPath!);
    expect(pdfText).toContain(`Rendered PDF source paragraph ${suffix}`);
    expect(pdfText).toContain("äöü ÄÖÜ ß €");
    expect(pdfText).not.toContain("Canvas snapshot not available");
    await expect(
      page.getByText("PDF exported successfully.").first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    await openPdfExportHistorySidebar(page);
    const history = page.getByTestId("pdf-export-history-panel");
    await expect(history.getByText("invalid doc_id")).toHaveCount(0);
    await expect(history.getByText("Recent exports")).toBeVisible({
      timeout: 10_000,
    });
    await expect(history.getByText("Done").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("INV-PDF-WEB-E2E-02: admin template default switch is reflected in the user export dialog", async ({
    page,
    request,
  }) => {
    const templates = await listActivePdfTemplates(request);
    if (templates.length < 2) {
      throw new Error(
        "PDF Admin->User E2E requires at least two active PDF templates",
      );
    }
    const currentDefault =
      templates.find((template) => template.slug === "default") ?? templates[0];
    const nextDefault = templates.find(
      (template) => template.id !== currentDefault.id,
    );
    if (!nextDefault) {
      throw new Error(
        "PDF Admin->User E2E requires at least two active PDF templates",
      );
    }
    const assigned = await assignDefaultTemplateToWorkspace(
      request,
      workspaceId,
      nextDefault.slug,
    );
    expect(assigned.id).toBe(nextDefault.id);

    await expectUserCannotReadAdminPdfTemplates(request);

    const suffix = Date.now().toString(36);
    const title = `PDF Admin User Template E2E ${suffix}`;
    await createWorkspacePage(page, workspaceId, title);
    await openPdfExportDialog(page);

    await expect(
      page.getByRole("radio", {
        name: new RegExp(escapeRegExp(nextDefault.name)),
      }),
    ).toBeChecked();
    await openPdfExportInputs(page);
    // Alternate templates need not declare a title input; E2E-01 covers title defaults.
    await expect(
      page.getByRole("textbox", { name: "Advanced typed inputs", exact: true }),
    ).toBeVisible();
  });
});
