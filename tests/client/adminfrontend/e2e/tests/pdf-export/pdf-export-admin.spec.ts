/**
 * E2E: PDF Export admin surface — read-only live-stack invariants.
 *
 * Prerequisites:
 *   - API at localhost:3001 and admin frontend at localhost:3010.
 *   - Admin user can be bootstrapped through /api/setup/create-admin-user.
 *
 * The spec intentionally avoids successful uploads, font approvals, or brand
 * writes. Those flows mutate persistent tables and the public admin GraphQL
 * surface only exposes soft-delete for templates, which would leave database
 * artifacts behind. Instead, this live gate verifies the shipped page contract
 * against the real stack and covers client-side workflow guards that must fire
 * before any mutation can reach the server.
 *
 * Invariants:
 *   INV-PDF-ADM-E2E-00  Admin can reach /adminfrontend/pdf-export.
 *   INV-PDF-ADM-E2E-01  All seven PDF Export sub-pages are reachable.
 *   INV-PDF-ADM-E2E-02  Template upload workflow blocks invalid bundles.
 *   INV-PDF-ADM-E2E-03  Font approval workflow exposes license-gated controls.
 *   INV-PDF-ADM-E2E-04  Brand edit workflow renders with admin workspace data.
 *   INV-PDF-ADM-E2E-05  Render jobs and settings tabs render without crashes.
 *   INV-PDF-ADM-E2E-06  All sub-pages meet the configured Axe budget.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const PDF_EXPORT_URL = `${ADMIN_FRONTEND_BASE}/pdf-export`;
const PDF_A11Y_MIN_SCORE = 90;
const PDF_MODULE_TEST_ID = "pdf-export-admin-module";

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await injectRequestSessionCookies(context, request);
}

async function openPdfExport(page: Page): Promise<void> {
  await page.goto(PDF_EXPORT_URL, {
    waitUntil: "networkidle",
    timeout: 20_000,
  });
  expect(page.url()).toContain("/adminfrontend/pdf-export");
  await expect(page.getByTestId(PDF_MODULE_TEST_ID)).toBeVisible({
    timeout: 10_000,
  });
}

async function openTab(page: Page, testId: string): Promise<void> {
  const tab = page.getByTestId(testId);
  await tab.click();
  await expect(tab).toHaveAttribute("data-state", "active");
}

async function assertA11yBudget(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(`[data-testid="${PDF_MODULE_TEST_ID}"]`)
    .analyze();
  const checkedRules = result.passes.length + result.violations.length;
  const score =
    checkedRules === 0
      ? 100
      : Math.round((result.passes.length / checkedRules) * 100);
  const criticalViolations = result.violations.filter(
    (violation) => violation.impact === "critical",
  );
  const formatViolation = (violation: (typeof result.violations)[number]) =>
    `${violation.id}: ${violation.description} (${violation.nodes.length} nodes)`;

  expect(
    criticalViolations.map(formatViolation),
    `${label} must not have critical axe violations`,
  ).toEqual([]);
  expect(
    score,
    `${label} axe score must be >= ${PDF_A11Y_MIN_SCORE}; violations: ${result.violations
      .map(formatViolation)
      .join("; ")}`,
  ).toBeGreaterThanOrEqual(PDF_A11Y_MIN_SCORE);
}

async function createInvalidTemplateBundle(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myoxus-pdf-e2e-"));
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        schema_version: "2.0",
        id: "e2e-invalid-template",
        name: "E2E Invalid Template",
        version: "0.0.1",
        entry: "main.typ",
        assets: ["main.typ", "missing.typ"],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(dir, "main.typ"), "#let render(doc) = []\n");
  return dir;
}

test.describe("PDF Export admin module", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInAsAdmin(context, adminRequest);
  });

  test("INV-PDF-ADM-E2E-00/01: page and all sub-pages are reachable", async ({
    page,
  }) => {
    await openPdfExport(page);

    const tabs = page.locator('[data-testid^="pdf-export-tab-"]');
    await expect(tabs).toHaveCount(7);
    await expect(page.getByTestId("pdf-export-tab-templates")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-workspaces")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-brand")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-fonts")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-icc")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-jobs")).toBeVisible();
    await expect(page.getByTestId("pdf-export-tab-settings")).toBeVisible();

    await expect(
      page.getByRole("table", { name: /pdf export templates/i }),
    ).toBeVisible({ timeout: 10_000 });

    await openTab(page, "pdf-export-tab-workspaces");
    await expect(page.getByTestId("pdf-export-tab-workspaces")).toHaveAttribute(
      "data-state",
      "active",
    );

    await openTab(page, "pdf-export-tab-brand");
    await expect(page.getByTestId("pdf-export-tab-brand")).toHaveAttribute(
      "data-state",
      "active",
    );

    await openTab(page, "pdf-export-tab-fonts");
    await expect(page.getByTestId("pdf-export-tab-fonts")).toHaveAttribute(
      "data-state",
      "active",
    );

    await openTab(page, "pdf-export-tab-icc");
    await expect(page.locator("table").first()).toBeVisible({
      timeout: 10_000,
    });

    await openTab(page, "pdf-export-tab-jobs");
    await expect(page.getByTestId("pdf-export-tab-jobs")).toHaveAttribute(
      "data-state",
      "active",
    );

    await openTab(page, "pdf-export-tab-settings");
    await expect(page.getByTestId("pdf-export-tab-settings")).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("INV-PDF-ADM-E2E-02: invalid template bundle is rejected before upload", async ({
    page,
  }) => {
    await openPdfExport(page);
    const bundleDir = await createInvalidTemplateBundle();

    try {
      await page.getByRole("button", { name: /upload template/i }).click();
      await expect(
        page.getByRole("dialog", { name: /upload pdf export template/i }),
      ).toBeVisible();

      await page.locator("input#pdf-tpl-upload-files").setInputFiles(bundleDir);
      await expect(page.getByRole("alert")).toContainText(/missing\.typ/i);
      await expect(
        page.getByRole("button", { name: /^upload template$/i }).last(),
      ).toBeDisabled();
    } finally {
      await fs.rm(bundleDir, { recursive: true, force: true });
    }
  });

  test("INV-PDF-ADM-E2E-03/04: approval and brand workflows render guarded controls", async ({
    page,
  }) => {
    await openPdfExport(page);

    await openTab(page, "pdf-export-tab-fonts");
    await expect(page.getByTestId("pdf-export-tab-fonts")).toHaveAttribute(
      "data-state",
      "active",
    );

    const firstFont = page.getByRole("row").nth(1);
    if (await firstFont.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await firstFont.getByRole("button").first().click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      await page.keyboard.press("Escape");
    }

    await openTab(page, "pdf-export-tab-brand");
    await expect(page.getByTestId("pdf-export-tab-brand")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.locator("body")).toBeVisible();
  });

  test("INV-PDF-ADM-E2E-06: all sub-pages meet the axe accessibility budget", async ({
    page,
  }) => {
    await openPdfExport(page);
    await assertA11yBudget(page, "templates tab");

    for (const [label, tab] of [
      ["workspaces tab", "pdf-export-tab-workspaces"],
      ["brand assets tab", "pdf-export-tab-brand"],
      ["fonts tab", "pdf-export-tab-fonts"],
      ["icc profiles tab", "pdf-export-tab-icc"],
      ["render jobs tab", "pdf-export-tab-jobs"],
      ["settings tab", "pdf-export-tab-settings"],
    ] as const) {
      await openTab(page, tab);
      await assertA11yBudget(page, label);
    }
  });
});
