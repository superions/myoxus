// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../shared/auth-helper";
import {
  getAccountColorMode,
  getAccountLocale,
  setAccountColorMode,
  setAccountLocale,
  type UserColorMode,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "../../editor-flow/tests/virgultum-mermaid-block-doc-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "../../editor-flow/tests/virgultum-mermaid-block-http-helpers";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "output/visual-qa/p-mermaid-repair-20260726-01/after",
);

let cookies: string[] = [];
let originalColorMode: UserColorMode | null = null;
let originalLocale: string | null = null;

async function openCatalog(page: Page, workspaceId: string) {
  await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await expect(page.getByTestId("main-container")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-myoxus-ui-role="diagram-catalog"]'),
  ).toBeVisible({ timeout: 20_000 });
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo({ top: 0 });
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollTop > 0) element.scrollTop = 0;
    }
  });
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, `${name}.png`),
  });
}

async function expectResolvedTheme(page: Page, theme: UserColorMode) {
  const resolved = await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 10_000,
    })
    .toMatch(/^(dark|light)$/);
  void resolved;
  if (theme !== "system") {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme);
  }
}

test.beforeAll(async ({ request }) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const target = { request, gqlEndpoint: GQL, cookies };
  originalColorMode = await getAccountColorMode(target);
  originalLocale = await getAccountLocale(target);
  await setAccountLocale(target, "en");
});

test.afterAll(async ({ request }) => {
  if (!cookies.length) return;
  const target = { request, gqlEndpoint: GQL, cookies };
  await setAccountLocale(target, originalLocale);
  await setAccountColorMode(target, originalColorMode);
});

test("Phase 01 catalog status is honest in every theme and compact width", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await injectCookies(context, cookies);
  await suppressOpenInApp(context);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const target = { request, gqlEndpoint: GQL, cookies };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  for (const theme of ["light", "dark", "system"] as const) {
    await setAccountColorMode(target, theme);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openCatalog(page, workspaceId);
    await expectResolvedTheme(page, theme);

    await expect(page.getByTestId("diagram-support-flowchart")).toHaveText(
      "Browser-tested visual editor",
    );
    await expect(page.getByText("Stable", { exact: true })).toHaveCount(0);

    const allFilter = page.getByTestId("diagram-category-all");
    await allFilter.focus();
    await expect(allFilter).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    const kanban = page.getByTestId("diagram-type-kanban");
    await kanban.scrollIntoViewIfNeeded();
    await expect(
      kanban.getByText("Browser-tested visual editor", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("diagram-type-swimlanes")
        .getByText("Source-first diagram", { exact: true }),
    ).toBeVisible();
    await kanban.click();
    await expect(page.getByTestId("create-selected-diagram-button")).toHaveText(
      /Kanban/,
    );
    await capture(page, `${theme}-desktop-catalog-all`);

    await page.setViewportSize({ width: 640, height: 900 });
    await expect(page.getByTestId("diagram-type-kanban")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await capture(page, `${theme}-compact-catalog-all`);
  }

  for (const worker of page.workers()) {
    await expect(worker.evaluate(() => true)).resolves.toBe(true);
  }
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});

test("Phase 01 Page and Edgeless unsupported-source recovery retain source and preview", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await injectCookies(context, cookies);
  await suppressOpenInApp(context);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const target = { request, gqlEndpoint: GQL, cookies };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  let docId: string | undefined;
  try {
    await setAccountColorMode(target, "light");
    docId = await createDisposableDoc(page, workspaceId);
    await typeSlashCommand(page, "/mermaid");
    const kanbanMenuItem = page.getByRole("button", {
      name: /Mermaid: Kanban\s+Create a Mermaid diagram/i,
    });
    await expect(kanbanMenuItem).toContainText("Browser-tested visual editor");
    await kanbanMenuItem.click();

    const block = page.locator("myoxus-mermaid").first();
    await expect(block.getByTestId("mermaid-kanban-board")).toBeVisible({
      timeout: 10_000,
    });
    await block.getByRole("tab", { name: "Source" }).click();
    const source = block.getByRole("textbox", { name: "Mermaid source" });
    const validSource = await source.inputValue();
    await source.fill(`${validSource}\n  unsupported syntax`);
    await expect(
      block.locator('[data-editor-surface="source-first"]'),
    ).toBeVisible();
    await expect(source).toBeVisible();
    await expect(block.getByRole("tab", { name: "Visual" })).toHaveCount(0);
    await expect(block.locator(".myoxus-mermaid-preview svg")).toBeVisible({
      timeout: 10_000,
    });
    await source.focus();
    await expect(source).toBeFocused();
    await capture(page, "light-desktop-page-source-first");

    await source.fill("kanban\n  empty[Empty]");
    await expect(block.locator(".myoxus-mermaid-preview svg")).toBeVisible({
      timeout: 10_000,
    });
    await expect(source).toHaveValue("kanban\n  empty[Empty]");
    await expect(block.locator(".myoxus-mermaid-preview")).toContainText(
      "Empty",
      { timeout: 10_000 },
    );
    await capture(page, "light-desktop-page-minimal-source-first");

    const denseSource = [
      "kanban",
      "  backlog[Backlog]",
      "    b1[Research requirements]",
      "    b2[Map dependencies]",
      "    b3[Review access rules]",
      "    b4[Confirm release scope]",
      "  active[In progress]",
      "    a1[Build parser contract]",
      "    a2[Wire source recovery]",
      "    a3[Verify compact layout]",
      "    a4[Inspect dark theme]",
      "  review[Review]",
      "    r1[Keyboard journey]",
      "    r2[Readonly behavior]",
      "    r3[Worker diagnostics]",
      "    r4[Evidence ledger]",
      "  done[Done]",
      "    d1[Catalog labels]",
      "    d2[Source-first copy]",
      "    d3[Parse line feedback]",
      "    d4[Last valid preview]",
    ].join("\n");
    await source.fill(denseSource);
    await expect(block.locator(".myoxus-mermaid-preview svg")).toBeVisible({
      timeout: 10_000,
    });
    await expect(source).toHaveValue(denseSource);
    await expect(block.locator(".myoxus-mermaid-preview")).toContainText(
      "Backlog",
      { timeout: 10_000 },
    );
    await capture(page, "light-desktop-page-dense-source-first");

    await source.fill(validSource);
    await expect(block.locator(".myoxus-mermaid-preview svg")).toBeVisible({
      timeout: 10_000,
    });
    const invalidSource = `${validSource}\n  broken[`;
    await source.fill(invalidSource);
    await expect(block.getByRole("alert")).toContainText(/line \d+/i, {
      timeout: 10_000,
    });
    await expect(block.getByLabel("Last valid Mermaid preview")).toBeVisible();
    await expect(source).toHaveValue(invalidSource);
    await capture(page, "light-desktop-page-parse-recovery");

    await source.fill(validSource);
    await expect(block.locator(".myoxus-mermaid-preview svg")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("switch-edgeless-mode-button").click();
    await expect(
      page.getByRole("radio", { checked: true, name: "Edgeless" }),
    ).toBeChecked({ timeout: 10_000 });
    await expect(block).toBeVisible({ timeout: 10_000 });
    await capture(page, "light-desktop-edgeless-source-first");

    await setAccountColorMode(target, "dark");
    await page.reload({ waitUntil: "load" });
    await expectResolvedTheme(page, "dark");
    await expect(page.locator("myoxus-mermaid").first()).toBeVisible({
      timeout: 15_000,
    });
    await capture(page, "dark-desktop-edgeless-source-first");

    await page.getByTestId("switch-page-mode-button").click();
    await expect(
      page.getByRole("radio", { checked: true, name: "Page" }),
    ).toBeChecked({ timeout: 10_000 });
    await page.setViewportSize({ width: 640, height: 900 });
    const compactBlock = page.locator("myoxus-mermaid").first();
    await expect(compactBlock).toBeVisible({ timeout: 10_000 });
    await expect(compactBlock.getByTestId("mermaid-kanban-board")).toBeVisible({
      timeout: 10_000,
    });
    await compactBlock.getByRole("tab", { name: "Source" }).click();
    await expect(
      compactBlock.getByRole("textbox", { name: "Mermaid source" }),
    ).toHaveValue(validSource);
    await capture(page, "dark-compact-page-source-first");

    for (const worker of page.workers()) {
      await expect(worker.evaluate(() => true)).resolves.toBe(true);
    }
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
  }
});
