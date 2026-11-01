// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

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
import { writeMermaidSource } from "../../editor-flow/tests/virgultum-mermaid-block-family-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "../../editor-flow/tests/virgultum-mermaid-block-http-helpers";
import { MERMAID_PAGE_VIEWPORT_FLOWCHART_FIXTURE } from "../../editor-flow/tests/virgultum-mermaid-block-product-fixtures";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "output/playwright/phase-3b-page-viewport",
);

let cookies: string[] = [];
let originalColorMode: UserColorMode | null = null;
let originalLocale: string | null = null;
let provisionedDocument: { docId: string; workspaceId: string } | null = null;

async function selectZoom(
  page: Page,
  block: Locator,
  option: "100%" | "150%" | "Auto",
) {
  const select = block.getByRole("combobox", { name: "Diagram zoom" });
  await select.click();
  await page.getByRole("option", { exact: true, name: option }).click();
  await expect(select).toHaveValue(option);
}

async function capture(page: Page, name: string) {
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, `${name}.png`),
  });
}

async function readGfxCamera(block: Locator) {
  return block.locator("myoxus-surface").evaluate((element) => {
    const viewport = (
      element as HTMLElement & {
        _gfx?: {
          viewport?: {
            centerX?: number;
            centerY?: number;
            zoom?: number;
          };
        };
      }
    )._gfx?.viewport;
    if (
      !Number.isFinite(viewport?.centerX) ||
      !Number.isFinite(viewport?.centerY) ||
      !Number.isFinite(viewport?.zoom)
    ) {
      throw new Error("Mermaid GFX camera is not measurable");
    }
    return {
      centerX: viewport.centerX!,
      centerY: viewport.centerY!,
      zoom: viewport.zoom!,
    };
  });
}

test.beforeAll(async ({ request }) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const target = { cookies, gqlEndpoint: GQL, request };
  originalColorMode = await getAccountColorMode(target);
  originalLocale = await getAccountLocale(target);
  await setAccountLocale(target, "en");
});

test.afterAll(async ({ request }) => {
  if (!cookies.length) return;
  const target = { cookies, gqlEndpoint: GQL, request };
  await setAccountLocale(target, originalLocale);
  await setAccountColorMode(target, originalColorMode);
});

test.afterEach(async ({ request }) => {
  if (!provisionedDocument) return;
  const { docId, workspaceId } = provisionedDocument;
  provisionedDocument = null;
  await cleanupDoc(workspaceId, cookies, docId, request);
});

test("Phase 3B repository fixture keeps a matched Page viewport matrix", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await injectCookies(context, cookies);
  await suppressOpenInApp(context);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const preferences = { cookies, gqlEndpoint: GQL, request };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await setAccountColorMode(preferences, "light");
  await page.setViewportSize({ height: 900, width: 1440 });
  const docId = await createDisposableDoc(page, workspaceId);
  provisionedDocument = { docId, workspaceId };
  await typeSlashCommand(page, "/mermaid");
  await page.getByTestId("slash-menu-item-mermaid-flowchart-basic").click();
  const documentUrl = `${FRONTEND}/workspace/${workspaceId}/${docId}?mode=page`;
  const block = page.locator("myoxus-mermaid").first();
  await expect(block).toBeVisible({ timeout: 20_000 });
  const viewMode = block.getByRole("radio", { name: "View" });
  if (!(await viewMode.isChecked())) {
    await block.getByText("View", { exact: true }).click();
  }

  await block.getByText("Source", { exact: true }).click();
  const sourceEditor = block.getByRole("textbox", { name: "Mermaid source" });
  await writeMermaidSource(
    sourceEditor,
    MERMAID_PAGE_VIEWPORT_FLOWCHART_FIXTURE.source,
  );
  await block.getByText("View", { exact: true }).click();

  const viewport = block
    .locator(
      '[data-myoxus-ui-role="mermaid-page-scroll-viewport"] .mantine-ScrollArea-viewport',
    )
    .first();
  await expect(viewport).toBeVisible({ timeout: 15_000 });

  await selectZoom(page, block, "100%");
  await capture(page, "fixture-flowchart-light-desktop-100");

  await selectZoom(page, block, "150%");
  const fixedOverflow = await viewport.evaluate((element) => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
  }));
  expect(fixedOverflow.x).toBeGreaterThan(0);
  expect(fixedOverflow.y).toBeGreaterThan(0);
  const initialPosition = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  const initialCamera = await readGfxCamera(block);
  await viewport.evaluate((element) =>
    element.scrollTo(element.scrollWidth, element.scrollHeight),
  );
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({
        x: Math.abs(
          element.scrollLeft - (element.scrollWidth - element.clientWidth),
        ),
        y: Math.abs(
          element.scrollTop - (element.scrollHeight - element.clientHeight),
        ),
      })),
    )
    .toEqual({ x: 0, y: 0 });
  await expect
    .poll(async () => {
      const camera = await readGfxCamera(block);
      return {
        x: Math.round(
          Math.abs(camera.centerX - initialCamera.centerX) * camera.zoom,
        ),
        y: Math.round(
          Math.abs(camera.centerY - initialCamera.centerY) * camera.zoom,
        ),
      };
    })
    .toEqual({
      x: Math.round(fixedOverflow.x - initialPosition.x),
      y: Math.round(fixedOverflow.y - initialPosition.y),
    });
  const edgeCamera = await readGfxCamera(block);
  const edgePosition = await viewport.evaluate(
    (element) => `${element.scrollLeft}:${element.scrollTop}`,
  );
  await capture(page, "fixture-flowchart-light-desktop-150-edge");

  await block.getByRole("button", { name: "Center diagram" }).click();
  const edgeCameraKey = `${edgeCamera.centerX}:${edgeCamera.centerY}`;
  await expect
    .poll(async () => {
      const camera = await readGfxCamera(block);
      return `${camera.centerX}:${camera.centerY}`;
    })
    .not.toBe(edgeCameraKey);
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => `${element.scrollLeft}:${element.scrollTop}`,
      ),
    )
    .not.toBe(edgePosition);
  const centeredCamera = await readGfxCamera(block);
  expect(centeredCamera.zoom).toBeCloseTo(edgeCamera.zoom);

  await setAccountColorMode(preferences, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ height: 900, width: 640 });
  await page.goto(documentUrl, { waitUntil: "load", timeout: 30_000 });
  const compactBlock = page.locator("myoxus-mermaid").first();
  await expect(compactBlock).toBeVisible({ timeout: 20_000 });
  const compactVisual = compactBlock.getByRole("radio", { name: "Visual" });
  if (!(await compactVisual.isChecked())) {
    await compactBlock.getByText("Visual", { exact: true }).click();
  }
  await selectZoom(page, compactBlock, "Auto");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await capture(page, "fixture-flowchart-system-dark-compact-auto");

  for (const worker of page.workers()) {
    await expect(worker.evaluate(() => true)).resolves.toBe(true);
  }
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
