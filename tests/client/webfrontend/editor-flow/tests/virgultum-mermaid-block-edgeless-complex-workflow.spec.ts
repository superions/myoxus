// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Page, test } from "@playwright/test";

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
  clickToolbarButtonWithPointer,
  edgelessFlowchartEdgeEndpointNodeIds,
  edgelessFlowchartEdgeLabel,
  edgelessFlowchartEdgeTargetNodeId,
  edgelessFlowchartGfxStats,
  edgelessFlowchartNodeBounds,
  edgelessFlowchartNodeLabels,
  expectConnectorLabelEditorVisible,
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
      await expect(
        page.locator("myoxus-edgeless-note myoxus-mermaid"),
      ).toBeHidden();
      await expect(
        page.locator(
          "myoxus-edgeless-note [data-testid='edgeless-note-container']",
        ),
      ).toHaveCount(0);
      const frameIndex = await page.locator("myoxus-frame").evaluateAll(
        (frames) =>
          frames
            .map((frame, index) => {
              const rect = frame.getBoundingClientRect();
              return { area: rect.width * rect.height, index };
            })
            .sort((a, b) => b.area - a.area)[0]?.index ?? 0,
      );
      const managedFrame = page.locator("myoxus-frame").nth(frameIndex);
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
        "edgeless Mermaid managed frame",
        80,
      );

      const edgelessNodeBeforeDrag = await edgelessFlowchartNodeBounds(
        managedFrame,
        "A",
      );
      expect(edgelessNodeBeforeDrag.x).toBeCloseTo(
        pageModeNodeBeforeEdgeless.x,
        0,
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
      const connectorToolbar = page
        .locator(
          'editor-toolbar[data-myoxus-floating-toolbar="true"], myoxus-toolbar-widget editor-toolbar',
        )
        .last();
      const addConnectorLabelButton = connectorToolbar
        .getByLabel("Edit label")
        .first();
      await clickToolbarButtonWithPointer(
        page,
        addConnectorLabelButton,
        "Edit label",
      );
      await expectConnectorLabelEditorVisible(
        page,
        managedFrame,
        edgeSelection.edgeElementId,
      );
      await page.keyboard.type("edgeless path", { delay: 10 });
      await page.keyboard.press("Escape");
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
      expect(handleBox!.width).toBeGreaterThanOrEqual(20);
      expect(handleBox!.height).toBeGreaterThanOrEqual(20);
      const reviewNodeTarget = await edgelessFlowchartNodeBounds(
        managedFrame,
        "C",
      );
      const sourceBeforeReconnect = await mermaidBlockSource(page);
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
        .poll(() => mermaidBlockSource(page))
        .not.toBe(sourceBeforeReconnect);
      const sourceAfterReconnect = await mermaidBlockSource(page);
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
        .poll(() => mermaidBlockSource(page))
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
        .poll(() => mermaidBlockSource(page))
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
        .toBeGreaterThan(pageModeNodeBeforeEdgeless.x + 24);
      await expect
        .poll(async () => (await flowchartNodeBounds(mermaidBlock, "A")).y)
        .toBeGreaterThan(pageModeNodeBeforeEdgeless.y + 12);
      const pageModeIdentityAfterEdgeless =
        await mermaidOwnerIdentity(mermaidBlock);
      expect(pageModeIdentityAfterEdgeless.blockId).toBe(
        pageModeIdentityBeforeEdgeless.blockId,
      );
      expect(pageModeIdentityAfterEdgeless.childIds).toEqual(
        pageModeIdentityBeforeEdgeless.childIds,
      );
      expect(pageModeIdentityAfterEdgeless.sourceHash).not.toBe(
        pageModeIdentityBeforeEdgeless.sourceHash,
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Page mode\] -->\s+\|edgeless path\|\s+C\[Review mode\]/,
      );
      await expect(sourceEditor).toHaveValue(/B\[Canvas mode\]/);
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
      await expect(
        page.locator("myoxus-edgeless-note myoxus-mermaid"),
      ).toBeHidden();
      const managedFrame = await largestVisibleMermaidEdgelessFrame(page);
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
        "edgeless Flowchart ELK managed frame",
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
        .poll(() => mermaidBlockSource(page))
        .toMatch(
          /flowchart-elk TD\n\s*A\[ELK page mode\]\s+-->\s+B\[Canvas mode\]/,
        );

      const edgeSelection = await selectEdgelessFlowchartEdge(
        page,
        managedFrame,
        "A",
        "B",
      );
      expect(edgeSelection.edgeId).toContain("edge-A-B");
      const sourceBeforeReconnect = await mermaidBlockSource(page);
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
        .poll(() => mermaidBlockSource(page))
        .not.toBe(sourceBeforeReconnect);
      await expect
        .poll(() => mermaidBlockSource(page))
        .toContain("flowchart-elk TD");
      await expect
        .poll(() => mermaidBlockSource(page))
        .toMatch(
          /(?:A\[ELK page mode\]\s+-->\s+C\[Review mode\]|C\[Review mode\]\s+-->\s+B\[Canvas mode\])/,
        );
      await expect
        .poll(() => mermaidBlockSource(page))
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
      expect(pageModeIdentityAfterEdgeless.sourceHash).not.toBe(
        pageModeIdentityBeforeEdgeless.sourceHash,
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk TD/);
      await expect(sourceEditor).toHaveValue(
        /(?:A\[ELK page mode\]\s+-->\s+C\[Review mode\]|C\[Review mode\]\s+-->\s+B\[Canvas mode\])/,
      );
      await expect(sourceEditor).toHaveValue(/A\[ELK page mode\]/);
      await expect(sourceEditor).toHaveValue(/B\[Canvas mode\]/);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });
});
