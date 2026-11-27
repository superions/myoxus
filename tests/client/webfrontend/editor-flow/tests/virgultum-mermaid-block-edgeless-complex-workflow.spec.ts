// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  getAccountLocale,
  setAccountLocale,
} from "../../shared/user-preferences-helper";
import {
  assertScreenshotHasDiagramContent,
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "./virgultum-mermaid-block-doc-helpers";
import {
  edgelessFlowchartEdgeEndpointNodeIds,
  edgelessFlowchartEdgeLabel,
  edgelessFlowchartEdgeTargetNodeId,
  edgelessFlowchartGfxStats,
  edgelessFlowchartNodeBounds,
  edgelessFlowchartNodeLabels,
  flowchartNodeBounds,
  largestVisibleMermaidEdgelessFrame,
  renameEdgelessFlowchartNode,
  selectEdgelessFlowchartEdge,
} from "./virgultum-mermaid-block-edgeless-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "./virgultum-mermaid-block-http-helpers";
import { writeMermaidSource } from "./virgultum-mermaid-block-family-helpers";
import { mermaidOwnerIdentity } from "./virgultum-mermaid-block-page-helpers";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

const FLOWCHART_PAGE_MIN_READABLE_ZOOM = 0.5;
const FLOWCHART_PAGE_VIEWPORT_PADDING = 36;
const _FLOWCHART_PAGE_MIN_READABLE_ZOOM_ANCHOR =
  FLOWCHART_PAGE_MIN_READABLE_ZOOM;
const _FLOWCHART_PAGE_VIEWPORT_PADDING_ANCHOR = FLOWCHART_PAGE_VIEWPORT_PADDING;
async function nativeOwnerSource(owner: Locator): Promise<string> {
  return owner.evaluate((element) => {
    const block = element as unknown as {
      model?: { props?: { source?: { toString?: () => string } } };
    };
    return block.model?.props?.source?.toString?.() ?? "";
  });
}

async function importNativeEdgelessMermaid(
  page: Page,
  filePath: string,
  source: string,
): Promise<Locator> {
  await writeFile(filePath, source, "utf8");
  const countBefore = await page.locator("myoxus-edgeless-mermaid").count();
  await page.evaluate(() => {
    window.showOpenFilePicker = undefined;
  });
  await page
    .getByTestId("myoxus-mermaid-edgeless-toolbar-button")
    .click({ timeout: 10_000 });
  await expect(
    page.getByRole("searchbox", { name: "Diagram type", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("myoxus-mermaid-edgeless-import-mmd").click();
  await (await chooser).setFiles(filePath);
  await expect
    .poll(() => page.locator("myoxus-edgeless-mermaid").count())
    .toBe(countBefore + 1);
  await page.keyboard.press("Alt+1");
  return largestVisibleMermaidEdgelessFrame(page);
}

async function mermaidBlockSource(page: Page): Promise<string> {
  return page.evaluate(() => {
    const block = document.querySelector("myoxus-mermaid") as {
      model?: {
        props?: {
          source?: { toString?: () => string };
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              props?: {
                source?: { toString?: () => string };
              };
            };
          }>;
        };
      };
    } | null;
    const blockSource = block?.model?.props?.source?.toString?.();
    if (blockSource !== undefined) return blockSource;
    const ownerSource = block?.std?.store
      ?.getBlocksByFlavour?.("myoxus:mermaid")
      ?.at(0)
      ?.model?.props?.source?.toString?.();
    if (ownerSource !== undefined) return ownerSource;
    const root = document.querySelector("myoxus-edgeless-root") as {
      gfx?: {
        doc?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              props?: {
                source?: { toString?: () => string };
              };
            };
          }>;
        };
      };
    } | null;
    return (
      root?.gfx?.doc
        ?.getBlocksByFlavour?.("myoxus:mermaid")
        ?.at(0)
        ?.model?.props?.source?.toString?.() ?? ""
    );
  });
}

test.describe("Virgultum Mermaid block", () => {
  test.describe.configure({ timeout: 120_000 });
  let localeCookies: string[] = [];
  let originalLocale: string | null = null;

  test.beforeAll(async ({ request }) => {
    localeCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    const target = {
      request,
      gqlEndpoint: `${API}/graphql`,
      cookies: localeCookies,
    };
    originalLocale = await getAccountLocale(target);
    await setAccountLocale(target, "en");
  });

  test.afterAll(async ({ request }) => {
    const restoreCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    try {
      await setAccountLocale(
        { request, gqlEndpoint: `${API}/graphql`, cookies: restoreCookies },
        originalLocale,
      );
    } finally {
      await signOutViaApi(request, API, restoreCookies);
    }
  });

  test("Mermaid managed Flowchart frame is visible across page and edgeless modes", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
        runtimeErrors.push(`console: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });

    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-flowchart-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await writeMermaidSource(
        sourceEditor,
        "flowchart TD\n  A[Page mode] --> B[Canvas mode]\n  C[Review mode]",
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const pageModeNodeBeforeEdgeless = await flowchartNodeBounds(
        mermaidBlock,
        "A",
      );
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      const pageModeIdentityBeforeEdgeless =
        await mermaidOwnerIdentity(mermaidBlock);
      expect(pageModeIdentityBeforeEdgeless.blockId).toBeTruthy();
      expect(pageModeIdentityBeforeEdgeless.childIds.length).toBeGreaterThan(0);
      expect(pageModeIdentityBeforeEdgeless.sourceHash).toBeTruthy();
      await expect(mermaidBlock.locator("[data-mermaid-hit-edge]")).toHaveCount(
        0,
      );
      await expect(mermaidBlock.locator("[data-mermaid-hit-node]")).toHaveCount(
        0,
      );

      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless(?:$|&)/, {
        timeout: 20_000,
      });
      await expect(page.locator("myoxus-edgeless-root").first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator("myoxus-frame")).toHaveCount(0);
      await expect(
        page.locator("myoxus-edgeless-note myoxus-mermaid").first(),
      ).toBeVisible({ timeout: 20_000 });
      const managedFrame = await importNativeEdgelessMermaid(
        page,
        testInfo.outputPath("edgeless-flowchart.mmd"),
        "flowchart TD\n  A[Page mode] --> B[Canvas mode]\n  C[Review mode]",
      );
      await expect(managedFrame).toBeVisible({ timeout: 20_000 });
      const managedFrameBox = await managedFrame.boundingBox();
      expect(managedFrameBox?.width).toBeGreaterThan(120);
      expect(managedFrameBox?.height).toBeGreaterThan(90);
      await assertScreenshotHasDiagramContent(
        page,
        {
          height: Math.max(90, managedFrameBox!.height - 24),
          width: Math.max(120, managedFrameBox!.width - 24),
          x: managedFrameBox!.x + 12,
          y: managedFrameBox!.y + 12,
        },
        "edgeless Mermaid native owner",
        80,
      );

      const edgelessNodeBeforeDrag = await edgelessFlowchartNodeBounds(
        managedFrame,
        "A",
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("v");
      await page.mouse.move(
        edgelessNodeBeforeDrag.viewX,
        edgelessNodeBeforeDrag.viewY,
      );
      await page.mouse.down();
      await page.mouse.move(
        edgelessNodeBeforeDrag.viewX + 96,
        edgelessNodeBeforeDrag.viewY + 48,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.waitForTimeout(250);
      const edgelessNodeAfterDrag = await edgelessFlowchartNodeBounds(
        managedFrame,
        "A",
      );
      expect(edgelessNodeAfterDrag.x).toBeGreaterThan(
        edgelessNodeBeforeDrag.x + 24,
      );
      expect(edgelessNodeAfterDrag.y).toBeGreaterThan(
        edgelessNodeBeforeDrag.y + 12,
      );
      const edgeSelection = await selectEdgelessFlowchartEdge(
        page,
        managedFrame,
        "A",
        "B",
      );
      expect(edgeSelection.edgeId).toContain("edge-A-B");
      const selectionToolbar = page.getByRole("toolbar", {
        name: "Selection toolbar",
      });
      await expect(selectionToolbar).toBeVisible({ timeout: 10_000 });
      await selectionToolbar
        .getByRole("button", { name: "Selected edge label" })
        .click();
      const edgeLabelInput = page.getByRole("textbox", {
        name: "Selected edge label",
      });
      await expect(edgeLabelInput).toBeVisible({ timeout: 10_000 });
      await edgeLabelInput.fill("edgeless path");
      await edgeLabelInput.press("Enter");
      await expect
        .poll(() =>
          edgelessFlowchartEdgeLabel(managedFrame, edgeSelection.edgeElementId),
        )
        .toBe("edgeless path");
      await selectEdgelessFlowchartEdge(page, managedFrame, "A", "B");
      const targetConnectorHandle = page
        .locator("edgeless-connector-handle .line-end")
        .first();
      await expect(targetConnectorHandle).toBeVisible({ timeout: 10_000 });
      const beforeRetargetScreenshotPath = testInfo.outputPath(
        "web-mermaid-edgeless-selected-edge-handle.png",
      );
      await page.screenshot({ path: beforeRetargetScreenshotPath });
      await testInfo.attach("web-mermaid-edgeless-selected-edge-handle", {
        path: beforeRetargetScreenshotPath,
        contentType: "image/png",
      });
      const handleBox = await targetConnectorHandle.boundingBox();
      expect(handleBox).toBeTruthy();
      expect(Math.round(handleBox!.width)).toBeGreaterThanOrEqual(20);
      expect(Math.round(handleBox!.height)).toBeGreaterThanOrEqual(20);
      const reviewNodeTarget = await edgelessFlowchartNodeBounds(
        managedFrame,
        "C",
      );
      const sourceBeforeReconnect = await nativeOwnerSource(managedFrame);
      await page.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(reviewNodeTarget.viewX, reviewNodeTarget.viewY, {
        steps: 8,
      });
      await page.mouse.up();
      await expect
        .poll(() =>
          edgelessFlowchartEdgeTargetNodeId(
            managedFrame,
            edgeSelection.edgeElementId,
          ),
        )
        .toBe("C");
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .not.toBe(sourceBeforeReconnect);
      const sourceAfterReconnect = await nativeOwnerSource(managedFrame);
      expect(sourceAfterReconnect).toMatch(
        /A\[Page mode\]\s+(?:[\w-]+@)?-->\s+\|edgeless path\|\s+C\[Review mode\]/,
      );
      expect(sourceAfterReconnect).toContain("B[Canvas mode]");
      await page.keyboard.press("Control+Z");
      await expect
        .poll(() =>
          edgelessFlowchartEdgeTargetNodeId(
            managedFrame,
            edgeSelection.edgeElementId,
          ),
        )
        .toBe("B");
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toBe(sourceBeforeReconnect);
      await page.keyboard.press("Control+Y");
      await expect
        .poll(() =>
          edgelessFlowchartEdgeTargetNodeId(
            managedFrame,
            edgeSelection.edgeElementId,
          ),
        )
        .toBe("C");
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toBe(sourceAfterReconnect);

      const edgelessScreenshotPath = testInfo.outputPath(
        "web-mermaid-edgeless-managed-frame.png",
      );
      await page.screenshot({ path: edgelessScreenshotPath });
      await testInfo.attach("web-mermaid-edgeless-managed-frame", {
        path: edgelessScreenshotPath,
        contentType: "image/png",
      });

      await page.getByTestId("switch-page-mode-button").click();
      await expect(page).toHaveURL(/\?mode=page(?:$|&)|\/[^?]+$/, {
        timeout: 20_000,
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 20_000 });
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(async () => (await flowchartNodeBounds(mermaidBlock, "A")).x)
        .toBeCloseTo(pageModeNodeBeforeEdgeless.x, 0);
      const pageModeIdentityAfterEdgeless =
        await mermaidOwnerIdentity(mermaidBlock);
      expect(pageModeIdentityAfterEdgeless.blockId).toBe(
        pageModeIdentityBeforeEdgeless.blockId,
      );
      expect(pageModeIdentityAfterEdgeless.childIds).toEqual(
        pageModeIdentityBeforeEdgeless.childIds,
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Page mode\] --> B\[Canvas mode\]/,
      );
      await expect(sourceEditor).toHaveValue(/C\[Review mode\]/);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart ELK keeps its editable GFX model across page and edgeless modes", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
        runtimeErrors.push(`console: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });

    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-flowchart-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await writeMermaidSource(
        sourceEditor,
        "flowchart-elk TD\n  A[Page mode] --> B[Canvas mode]\n  C[Review mode]",
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-diagram-type="flowchart-elk"][data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      const pageModeIdentityBeforeEdgeless =
        await mermaidOwnerIdentity(mermaidBlock);
      expect(pageModeIdentityBeforeEdgeless.blockId).toBeTruthy();
      expect(pageModeIdentityBeforeEdgeless.childIds.length).toBeGreaterThan(0);
      expect(pageModeIdentityBeforeEdgeless.sourceHash).toBeTruthy();
      await expect
        .poll(() => mermaidBlockSource(page))
        .toContain("flowchart-elk TD");

      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless(?:$|&)/, {
        timeout: 20_000,
      });
      await expect(page.locator("myoxus-edgeless-root").first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator("myoxus-frame")).toHaveCount(0);
      await expect(
        page.locator("myoxus-edgeless-note myoxus-mermaid").first(),
      ).toBeVisible({ timeout: 20_000 });
      const managedFrame = await importNativeEdgelessMermaid(
        page,
        testInfo.outputPath("edgeless-flowchart-elk.mmd"),
        "flowchart-elk TD\n  A[Page mode] --> B[Canvas mode]\n  C[Review mode]",
      );
      await expect(managedFrame).toBeVisible({ timeout: 20_000 });
      const managedFrameBox = await managedFrame.boundingBox();
      expect(managedFrameBox?.width).toBeGreaterThan(120);
      expect(managedFrameBox?.height).toBeGreaterThan(90);
      await assertScreenshotHasDiagramContent(
        page,
        {
          height: Math.max(90, managedFrameBox!.height - 24),
          width: Math.max(120, managedFrameBox!.width - 24),
          x: managedFrameBox!.x + 12,
          y: managedFrameBox!.y + 12,
        },
        "edgeless Flowchart ELK native owner",
        80,
      );
      await expect
        .poll(() => edgelessFlowchartGfxStats(managedFrame))
        .toMatchObject({ connectorCount: 1, nodeCount: 3 });
      await expect
        .poll(() => edgelessFlowchartNodeLabels(managedFrame))
        .toMatchObject({
          A: "Page mode",
          B: "Canvas mode",
          C: "Review mode",
        });

      await renameEdgelessFlowchartNode(
        page,
        managedFrame,
        "A",
        "ELK page mode",
      );
      await expect
        .poll(() => edgelessFlowchartNodeLabels(managedFrame))
        .toHaveProperty("A", "ELK page mode");
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toMatch(
          /flowchart-elk TD\n\s*A\[ELK page mode\]\s+(?:[\w-]+@)?-->\s+B\[Canvas mode\]/,
        );

      const edgeSelection = await selectEdgelessFlowchartEdge(
        page,
        managedFrame,
        "A",
        "B",
      );
      expect(edgeSelection.edgeId).toContain("edge-A-B");
      const sourceBeforeReconnect = await nativeOwnerSource(managedFrame);
      const reviewNodeTarget = await edgelessFlowchartNodeBounds(
        managedFrame,
        "C",
      );
      const dragNativeEndpointToReviewNode = async (
        endpointSelector: ".line-end" | ".line-start",
      ) => {
        await selectEdgelessFlowchartEdge(page, managedFrame, "A", "B");
        const connectorHandle = page
          .locator(`edgeless-connector-handle ${endpointSelector}`)
          .first();
        await expect(connectorHandle).toBeVisible({ timeout: 10_000 });
        const handleBox = await connectorHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        await page.mouse.move(
          handleBox!.x + handleBox!.width / 2,
          handleBox!.y + handleBox!.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(reviewNodeTarget.viewX, reviewNodeTarget.viewY, {
          steps: 8,
        });
        await page.mouse.up();
        await page.waitForTimeout(250);
        const endpoints = await edgelessFlowchartEdgeEndpointNodeIds(
          managedFrame,
          edgeSelection.edgeElementId,
        );
        return endpoints.source === "C" || endpoints.target === "C";
      };
      const hasReviewEndpoint =
        (await dragNativeEndpointToReviewNode(".line-end")) ||
        (await dragNativeEndpointToReviewNode(".line-start"));
      expect(hasReviewEndpoint).toBe(true);
      await expect
        .poll(async () => {
          const endpoints = await edgelessFlowchartEdgeEndpointNodeIds(
            managedFrame,
            edgeSelection.edgeElementId,
          );
          return endpoints.source === "C" || endpoints.target === "C";
        })
        .toBe(true);
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .not.toBe(sourceBeforeReconnect);
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toContain("flowchart-elk TD");
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toMatch(
          /(?:A\[ELK page mode\]\s+(?:[\w-]+@)?-->\s+C\[Review mode\]|C\[Review mode\]\s+(?:[\w-]+@)?-->\s+B\[Canvas mode\])/,
        );
      await expect
        .poll(() => nativeOwnerSource(managedFrame))
        .toContain("B[Canvas mode]");
      await expect
        .poll(() => edgelessFlowchartGfxStats(managedFrame))
        .toMatchObject({ connectorCount: 1, nodeCount: 3 });
      await expect
        .poll(() => edgelessFlowchartNodeLabels(managedFrame))
        .toMatchObject({
          A: "ELK page mode",
          B: "Canvas mode",
          C: "Review mode",
        });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      const edgelessScreenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-elk-edgeless-gfx-edit.png",
      );
      await page.screenshot({ path: edgelessScreenshotPath });
      await testInfo.attach("web-mermaid-flowchart-elk-edgeless-gfx-edit", {
        path: edgelessScreenshotPath,
        contentType: "image/png",
      });

      await page.getByTestId("switch-page-mode-button").click();
      await expect(page).toHaveURL(/\?mode=page(?:$|&)|\/[^?]+$/, {
        timeout: 20_000,
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 20_000 });
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-diagram-type="flowchart-elk"][data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      const pageModeIdentityAfterEdgeless =
        await mermaidOwnerIdentity(mermaidBlock);
      expect(pageModeIdentityAfterEdgeless.blockId).toBe(
        pageModeIdentityBeforeEdgeless.blockId,
      );
      expect(pageModeIdentityAfterEdgeless.childIds).toEqual(
        pageModeIdentityBeforeEdgeless.childIds,
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk TD/);
      await expect(sourceEditor).toHaveValue(
        /A\[Page mode\] --> B\[Canvas mode\]/,
      );
      await expect(sourceEditor).toHaveValue(/C\[Review mode\]/);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("switches a surface-owned catalog Flowchart from Edgeless to Page, renders editable GFX with snap toggle, and returns to Edgeless intact", async ({
    context,
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
        runtimeErrors.push(`console: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });

    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    let docId: string | undefined;

    try {
      await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByRole("button", { name: /Flowchart|Flussdiagramm/i })
        .first()
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/workspace/${workspaceId}/(?!diagrams)[^/?]+`),
        {
          timeout: 30_000,
        },
      );
      docId = new URL(page.url()).pathname.split("/").pop();
      expect(docId).toBeTruthy();

      const surfaceEditor = page.locator("myoxus-edgeless-root").first();
      await expect(surfaceEditor).toBeVisible({ timeout: 25_000 });

      await page.getByTestId("switch-page-mode-button").click();
      await expect(page).toHaveURL(/\?mode=page(?:$|&)|\/[^?]+$/, {
        timeout: 20_000,
      });
      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 20_000 });
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-diagram-type="flowchart"][data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Snap to grid|Am Raster ausrichten/i,
        }),
      ).toBeVisible({ timeout: 10_000 });
      const visiblePageTitleCount = await page.evaluate(() => {
        const el = document.querySelector("myoxus-mermaid") as {
          _getScopedGfxController?: () => {
            surface?: {
              elementModels?: Array<{
                id: string;
                yMap?: { get?: (key: string) => unknown };
              }>;
            };
            surfaceComponent?: {
              renderer?: {
                isElementLocallyExcluded?: (id: string) => boolean;
              };
            };
          } | null;
        } | null;
        const gfx = el?._getScopedGfxController?.();
        const models = gfx?.surface?.elementModels;
        const renderer = gfx?.surfaceComponent?.renderer;
        if (!models || !renderer?.isElementLocallyExcluded) return -1;
        return models.filter(
          (model) =>
            model.yMap?.get?.("mermaidRole") === "mermaid-diagram-title" &&
            !renderer.isElementLocallyExcluded!(model.id),
        ).length;
      });
      expect(visiblePageTitleCount).toBe(0);

      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless/, { timeout: 20_000 });
      await expect(surfaceEditor).toBeVisible({ timeout: 20_000 });
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });
});
