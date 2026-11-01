/**
 * E2E: Documents admin policy roundtrip.
 *
 * The test mutates one global policy field (`classification.exportMode`) and
 * restores the original value through the public admin GraphQL API before it
 * exits. That keeps the suite idempotent and avoids permanent database
 * artifacts while still proving that the UI writes the real server contract.
 */
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  gqlRequest,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const DOCUMENTS_URL = `${ADMIN_FRONTEND_BASE}/documents`;
const ATTRIBUTE_KEY = "classification";

type AttributeDefinition = {
  key: string;
  exportMode: string;
};

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await injectRequestSessionCookies(context, request);
}

async function readAttribute(
  request: APIRequestContext,
): Promise<AttributeDefinition> {
  const data = await gqlRequest<{
    admin: { documentMetadataFieldDefinitions: AttributeDefinition[] };
  }>(
    request,
    `query DocumentMetadataFieldDefinitionsForE2E {
      admin {
        documentMetadataFieldDefinitions {
          key
          exportMode
        }
      }
    }`,
  );
  const definition = data.admin.documentMetadataFieldDefinitions.find(
    (item) => item.key === ATTRIBUTE_KEY,
  );
  if (!definition) {
    throw new Error(
      `Missing ${ATTRIBUTE_KEY} document metadata field definition`,
    );
  }
  return definition;
}

async function restoreExportMode(
  request: APIRequestContext,
  exportMode: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation RestoreAttributeExportModeForE2E($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) {
      admin {
        updateDocumentMetadataFieldDefinition(input: $input) {
          key
          exportMode
        }
      }
    }`,
    { input: { key: ATTRIBUTE_KEY, exportMode } },
  );
}

async function openDocuments(page: Page): Promise<void> {
  await page.goto(DOCUMENTS_URL, { waitUntil: "networkidle", timeout: 20_000 });
  await expect(page.getByTestId("documents-admin-module")).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Documents admin module", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInAsAdmin(context, adminRequest);
  });

  test("P-DOC-ATTR-F-T06: classification export mode persists across reload", async ({
    page,
    adminRequest,
  }) => {
    const original = await readAttribute(adminRequest);

    try {
      await openDocuments(page);
      await page.getByTestId("documents-tab-attributes").click();
      await page
        .getByTestId(`documents-attribute-row-${ATTRIBUTE_KEY}`)
        .click();
      await page.locator("#attribute-export-mode").selectOption("required");
      await page.getByTestId("documents-attribute-save").click();
      await expect(page.getByTestId("documents-attribute-save")).toBeDisabled({
        timeout: 10_000,
      });

      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("documents-tab-attributes").click();
      await page
        .getByTestId(`documents-attribute-row-${ATTRIBUTE_KEY}`)
        .click();
      await expect(page.locator("#attribute-export-mode")).toHaveValue(
        "required",
      );
    } finally {
      await restoreExportMode(adminRequest, original.exportMode);
    }
  });

  test("versioning policy tab renders localized labels instead of raw enum values", async ({
    page,
  }, testInfo) => {
    await openDocuments(page);
    await page.getByTestId("documents-tab-versioning").click();
    await expect(page.getByTestId("documents-versioning-tab")).toBeVisible({
      timeout: 10_000,
    });

    const visibleText = await page.locator("body").innerText();
    expect(visibleText).toMatch(/PDF[- ]Export/i);
    expect(visibleText).toMatch(/Publish|Veröffentlichen/i);
    expect(visibleText).toMatch(/Daily|Täglich/i);
    expect(visibleText).not.toMatch(
      /\bsimple_counter\b|\bon_pdf_export\b|\bon_publish\b/,
    );

    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("documents-versioning-tab.png"),
    });
  });
});
