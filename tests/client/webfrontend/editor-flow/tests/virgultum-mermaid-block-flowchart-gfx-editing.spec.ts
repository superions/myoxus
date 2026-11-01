// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "@playwright/test";

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
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "./virgultum-mermaid-block-doc-helpers";
import {
  connectFlowchartNodesViaContextMenu,
  flowchartArrowKeyTowardNode,
  flowchartGfxStats,
  flowchartNodeIds,
  flowchartNodeLabels,
} from "./virgultum-mermaid-block-edgeless-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "./virgultum-mermaid-block-http-helpers";
import {
  ensureFlowchartPointReachable,
  flowchartNodePoint,
  flowchartNodeSize,
  flowchartNodeViewBox,
  renameFlowchartNodeInline,
  selectFlowchartEdge,
  selectFlowchartNode,
} from "./virgultum-mermaid-block-page-helpers";

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

async function flowchartNodeModelPoint(
  mermaidBlock: import("@playwright/test").Locator,
  nodeId: string,
) {
  return mermaidBlock.evaluate((element, id) => {
    const block = element as unknown as {
      _getMermaidVisualModelForEditing?: () => {
        nodes?: Array<{ id: string; x: number; y: number }>;
      } | null;
    };
    const node = block
      ._getMermaidVisualModelForEditing?.()
      ?.nodes?.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Missing Flowchart node ${id}`);
    return { x: node.x, y: node.y };
  }, nodeId);
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

  test("Mermaid Flowchart handles support keyboard resize and connect", async ({
    context,
    page,
    request,
  }) => {
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => flowchartNodeIds(mermaidBlock)).toContain("C");

      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      await visualCanvas.click({
        force: true,
        position: await flowchartNodePoint(mermaidBlock, "C", 0.18, 0.5),
      });
      await expect(mermaidBlock.getByLabel("Selected node label")).toHaveCount(
        0,
      );

      const keyboardResizeBefore = await flowchartNodeSize(mermaidBlock, "C");
      const keyboardResizeHandle = mermaidBlock
        .locator(".myoxus-mermaid-gfx-resize-handle")
        .first();
      await keyboardResizeHandle.press("Shift+ArrowRight");
      await keyboardResizeHandle.press("Shift+ArrowDown");
      await expect
        .poll(async () => {
          const size = await flowchartNodeSize(mermaidBlock, "C");
          return (
            size.width > keyboardResizeBefore.width &&
            size.height > keyboardResizeBefore.height
          );
        })
        .toBe(true);
      const keyboardResizeAfter = await flowchartNodeSize(mermaidBlock, "C");
      expect(keyboardResizeAfter.width).toBeGreaterThan(
        keyboardResizeBefore.width,
      );
      expect(keyboardResizeAfter.height).toBeGreaterThan(
        keyboardResizeBefore.height,
      );

      const keyboardConnectHandle = mermaidBlock
        .locator(".myoxus-mermaid-gfx-connect-handle")
        .first();
      await keyboardConnectHandle.press("ArrowRight");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /C(?:\[(?:Done|Result)\])? edge-C-D-\d+@-->/,
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart nodes connect by dragging the inline connector handle", async ({
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        ["flowchart LR", "  A[Source]", "  B[Target]", "  C[Spare]"].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C"]);
      await expect
        .poll(() => flowchartGfxStats(mermaidBlock))
        .toMatchObject({
          connectorCount: 0,
          nodeCount: 3,
        });

      await visualCanvas.click({
        force: true,
        position: await flowchartNodePoint(mermaidBlock, "A", 0.5, 0.5),
      });
      const connectorHandle = mermaidBlock
        .locator(".myoxus-mermaid-gfx-connect-handle")
        .first();
      await expect(connectorHandle).toBeVisible({ timeout: 5_000 });

      const handleBox = await connectorHandle.boundingBox();
      const viewportBox = await visualCanvas.boundingBox();
      expect(handleBox).toBeTruthy();
      expect(viewportBox).toBeTruthy();
      const targetPoint = await flowchartNodePoint(mermaidBlock, "B", 0.5, 0.5);
      const targetClientPoint = {
        x: viewportBox!.x + targetPoint.x,
        y: viewportBox!.y + targetPoint.y,
      };

      await page.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(targetClientPoint.x, targetClientPoint.y, {
        steps: 10,
      });

      const preview = mermaidBlock
        .locator(".myoxus-mermaid-gfx-connection-preview")
        .first();
      await expect(preview).toBeVisible({ timeout: 5_000 });
      await expect(preview).toHaveAttribute("data-valid-target", "true");
      const previewScreenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-drag-connect-preview.png",
      );
      await page.screenshot({ path: previewScreenshotPath });
      await testInfo.attach("web-mermaid-flowchart-drag-connect-preview", {
        path: previewScreenshotPath,
        contentType: "image/png",
      });

      await page.mouse.up();
      await expect
        .poll(
          async () => (await flowchartGfxStats(mermaidBlock)).connectorCount,
        )
        .toBe(1);
      const connectedScreenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-drag-connect-result.png",
      );
      await page.screenshot({ path: connectedScreenshotPath });
      await testInfo.attach("web-mermaid-flowchart-drag-connect-result", {
        path: connectedScreenshotPath,
        contentType: "image/png",
      });

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Source\] edge-A-B-\d+@--> B\[Target\]/,
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart page GFX create, reconnect and delete remain undoable", async ({
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        ["flowchart TD", "  A[Start]", "  B[Step]", "  C[Result]"].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C"]);

      const nodeIdsBeforeCreate = await flowchartNodeIds(mermaidBlock);
      await mermaidBlock.getByRole("button", { name: "Node shapes" }).click();
      await page
        .getByRole("menuitem", { name: /Place decision on canvas/i })
        .click();
      await expect(
        page.getByRole("menu", { name: "Node shapes" }),
      ).toBeHidden();
      const visualBox = await visualCanvas.boundingBox();
      expect(visualBox).toBeTruthy();
      await page.mouse.click(
        visualBox!.x + Math.max(96, visualBox!.width * 0.25),
        visualBox!.y + Math.max(180, visualBox!.height * 0.72),
      );
      let createdNodeId = "";
      await expect
        .poll(async () => {
          const ids = await flowchartNodeIds(mermaidBlock);
          const added = ids.filter((id) => !nodeIdsBeforeCreate.includes(id));
          createdNodeId = added[0] ?? "";
          return added.length;
        })
        .toBe(1);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        new RegExp(`${createdNodeId}\\{Decision \\d+\\}`),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Z");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain(createdNodeId);
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Y");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toContain(createdNodeId);

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        ["flowchart TD", "  A[Start] --> B[Step]", "  C[Result]"].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      await mermaidBlock
        .locator('.myoxus-mermaid-gfx-edge-handle[data-endpoint="target"]')
        .press(await flowchartArrowKeyTowardNode(mermaidBlock, "B", "C"));
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Start\] edge-A-B-1@--> C\[Result\]/,
      );
      await expect(sourceEditor).not.toHaveValue(/A\[Start\] edge-A-B-1@--> B/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Z");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Start\] (?:edge-A-B-1@)?--> B\[Step\]/,
      );
      await expect(sourceEditor).not.toHaveValue(/A\[Start\] edge-A-B-1@--> C/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Y");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Start\] edge-A-B-1@--> C\[Result\]/,
      );

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartNode(mermaidBlock, visualCanvas, "B");
      await mermaidBlock.focus();
      await page.keyboard.press("Backspace");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain("B");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).not.toHaveValue(/B\[Step\]/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Z");
      await expect.poll(() => flowchartNodeIds(mermaidBlock)).toContain("B");
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Y");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain("B");

      const screenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-page-gfx-undo-redo.png",
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach("web-mermaid-flowchart-page-gfx-undo-redo", {
        path: screenshotPath,
        contentType: "image/png",
      });
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart ELK uses the same page GFX edit path without losing its header", async ({
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        ["flowchart-elk LR", "  A[Start] --> B[Done]", "  C[Later]"].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C"]);
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-diagram-type="flowchart-elk"][data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });

      const initialA = await flowchartNodePoint(mermaidBlock, "A");
      const initialModelA = await flowchartNodeModelPoint(mermaidBlock, "A");
      const viewportBox = await visualCanvas.boundingBox();
      if (!viewportBox) throw new Error("Missing Flowchart viewport bounds");
      await page.mouse.move(
        viewportBox!.x + initialA.x,
        viewportBox!.y + initialA.y,
      );
      await page.mouse.down();
      await page.mouse.move(
        viewportBox!.x + initialA.x,
        viewportBox!.y + initialA.y + 80,
        { steps: 8 },
      );
      await page.mouse.up();
      const movedModelA = await flowchartNodeModelPoint(mermaidBlock, "A");
      expect(Math.abs(movedModelA.y - initialModelA.y)).toBeGreaterThan(4);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);
      await expect(sourceEditor).toHaveValue(
        /A\[Start\] edge-A-B-1@--> B\[Done\]/,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C"]);

      await mermaidBlock
        .locator(
          '[data-myoxus-ui-role="mermaid-page-scroll-viewport"] .mantine-ScrollArea-viewport',
        )
        .first()
        .evaluate((element) => element.scrollTo(0, 0));
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      await mermaidBlock
        .locator('.myoxus-mermaid-gfx-edge-handle[data-endpoint="target"]')
        .press(await flowchartArrowKeyTowardNode(mermaidBlock, "B", "C"));
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);
      await expect(sourceEditor).toHaveValue(
        /A\[Start\] edge-A-B-1@--> C\[Later\]/,
      );
      await expect(sourceEditor).not.toHaveValue(/A\[Start\] edge-A-B-1@--> B/);

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await renameFlowchartNodeInline(
        page,
        mermaidBlock,
        visualCanvas,
        "C",
        "ELK result",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);
      await expect(sourceEditor).toHaveValue(/C\[ELK result\]/);

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const screenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-elk-page-gfx-edit.png",
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach("web-mermaid-flowchart-elk-page-gfx-edit", {
        path: screenshotPath,
        contentType: "image/png",
      });
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart ELK keeps large fan-out layouts readable after reconnect replay", async ({
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        [
          "flowchart-elk LR",
          "  A[Entry point] --> B[Detailed review checkpoint]",
          "  A --> C[Customer confirmation checkpoint]",
          "  A --> D[Operational readiness checkpoint]",
          "  A --> E[Compliance evidence checkpoint]",
          "  A --> F[Release decision checkpoint]",
          "  A --> G[Post release verification checkpoint]",
        ].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C", "D", "E", "F", "G"]);
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-diagram-type="flowchart-elk"][data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(() => flowchartGfxStats(mermaidBlock))
        .toMatchObject({ connectorCount: 6, nodeCount: 7 });

      const viewportBox = await visualCanvas.boundingBox();
      expect(viewportBox).toBeTruthy();
      const scrollHeight = await mermaidBlock
        .locator(
          '[data-myoxus-ui-role="mermaid-page-scroll-viewport"] .mantine-ScrollArea-viewport',
        )
        .first()
        .evaluate((element) => element.scrollHeight);
      for (const nodeId of ["A", "B", "D", "G"]) {
        const nodeBox = await flowchartNodeViewBox(mermaidBlock, nodeId);
        expect(nodeBox.width, `${nodeId} remains readable`).toBeGreaterThan(40);
        expect(nodeBox.height, `${nodeId} remains readable`).toBeGreaterThan(
          18,
        );
        expect(
          nodeBox.y,
          `${nodeId} stays inside the reachable scroll extent`,
        ).toBeGreaterThanOrEqual(-4);
        expect(
          nodeBox.y + nodeBox.height,
          `${nodeId} stays inside the reachable scroll extent`,
        ).toBeLessThanOrEqual(scrollHeight + 4);
      }

      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      await mermaidBlock
        .locator('.myoxus-mermaid-gfx-edge-handle[data-endpoint="target"]')
        .press(await flowchartArrowKeyTowardNode(mermaidBlock, "B", "G"));
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);
      await expect(sourceEditor).toHaveValue(
        /A(?:\[Entry point\])? edge-A-C-2@--> C(?:\[Customer confirmation checkpoint\])?(?:\s|$)/,
      );
      await expect(sourceEditor).toHaveValue(
        /C\[Customer confirmation checkpoint\]/,
      );
      await expect(sourceEditor).not.toHaveValue(
        /A(?:\[Entry point\])? edge-A-B-1@--> B(?:\[Detailed review checkpoint\])?(?:\s|$)/,
      );

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const replayedTarget = await flowchartNodeViewBox(mermaidBlock, "G");
      expect(replayedTarget.y + replayedTarget.height).toBeLessThanOrEqual(
        scrollHeight + 4,
      );
      const screenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-elk-large-layout-reconnect.png",
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(
        "web-mermaid-flowchart-elk-large-layout-reconnect",
        {
          path: screenshotPath,
          contentType: "image/png",
        },
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart connects ten visual GFX nodes through the context menu", async ({
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        [
          "flowchart TD",
          "  A([Start])",
          "  B{Check}",
          "  C[Prepare]",
          "  D[(Store)]",
          "  E[/Input/]",
          "  F[[Subroutine]]",
          "  G((Review))",
          "  H{{Gate}}",
          "  I[\\Manual\\]",
          "  J([Done])",
        ].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      await expect(visualCanvas).toBeVisible({ timeout: 10_000 });
      await expect(
        mermaidBlock
          .getByRole("toolbar", { name: "Mermaid diagram controls" })
          .getByRole("button", { exact: true, name: "Connect" }),
      ).toBeDisabled();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
      await expect
        .poll(() => flowchartGfxStats(mermaidBlock))
        .toMatchObject({
          connectorCount: 0,
          nodeCount: 10,
        });
      const connectButton = mermaidBlock
        .getByRole("toolbar", { name: "Mermaid diagram controls" })
        .getByRole("button", { exact: true, name: "Connect" });
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      await expect(connectButton).toBeEnabled();
      await visualCanvas.click({
        force: true,
        modifiers: ["Shift"],
        position: await flowchartNodePoint(mermaidBlock, "B"),
      });
      await visualCanvas.click({
        force: true,
        position: await flowchartNodePoint(mermaidBlock, "A"),
      });
      await connectButton.click();
      const connectionFeedback = mermaidBlock.locator(
        '[data-myoxus-ui-role="mermaid-flowchart-connection-feedback"]',
      );
      await expect(connectionFeedback).toHaveAccessibleName(
        /Press Escape to cancel/,
      );
      await page.keyboard.press("Escape");
      await expect(connectionFeedback).toHaveCount(0);
      await expect
        .poll(() => flowchartGfxStats(mermaidBlock))
        .toMatchObject({ connectorCount: 0 });

      await connectButton.click();
      await ensureFlowchartPointReachable(
        mermaidBlock,
        visualCanvas,
        await flowchartNodePoint(mermaidBlock, "J"),
      );
      await visualCanvas.click({
        force: true,
        position: await flowchartNodePoint(mermaidBlock, "J"),
      });
      await expect
        .poll(() => flowchartGfxStats(mermaidBlock))
        .toMatchObject({ connectorCount: 1 });
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      const viewportBox = await visualCanvas.boundingBox();
      if (!viewportBox) throw new Error("Missing Flowchart canvas bounds");
      const selectedNode = await flowchartNodeViewBox(mermaidBlock, "A");
      expect(selectedNode.x).toBeGreaterThanOrEqual(0);
      expect(selectedNode.x + selectedNode.width).toBeLessThanOrEqual(
        viewportBox.width,
      );
      for (const nodeId of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
        const node = await flowchartNodeViewBox(mermaidBlock, nodeId);
        expect(node.width, `${nodeId} must remain readable`).toBeGreaterThan(
          40,
        );
      }
      const initialScreenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-context-connect-ten-nodes-initial.png",
      );
      await page.screenshot({ path: initialScreenshotPath });
      await testInfo.attach(
        "web-mermaid-flowchart-context-connect-ten-nodes-initial",
        {
          path: initialScreenshotPath,
          contentType: "image/png",
        },
      );

      const chain = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
      for (let index = 0; index < chain.length - 1; index++) {
        await test.step(`connect ${chain[index]} -> ${chain[index + 1]}`, async () => {
          await connectFlowchartNodesViaContextMenu(
            page,
            mermaidBlock,
            visualCanvas,
            chain[index],
            chain[index + 1],
          );
        });
      }

      const stats = await flowchartGfxStats(mermaidBlock);
      expect(stats.nodeCount).toBe(10);
      expect(stats.connectorCount).toBe(10);
      expect(stats.shapeTypes.length).toBeGreaterThanOrEqual(3);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\(\[Start\]\) (?:edge-A-J-\d+@)?--> J\(\[Done\]\)/,
      );
      await expect(sourceEditor).toHaveValue(/A edge-A-B-\d+@--> B\{Check\}/);
      await expect(sourceEditor).toHaveValue(/B edge-B-C-\d+@--> C\[Prepare\]/);
      await expect(sourceEditor).toHaveValue(
        /C edge-C-D-\d+@--> D\[\(Store\)\]/,
      );
      await expect(sourceEditor).toHaveValue(
        /D edge-D-E-\d+@--> E\[\/Input\/\]/,
      );
      await expect(sourceEditor).toHaveValue(/I edge-I-J-\d+@--> J/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const screenshotPath = testInfo.outputPath(
        "web-mermaid-flowchart-context-connect-ten-nodes.png",
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach("web-mermaid-flowchart-context-connect-ten-nodes", {
        path: screenshotPath,
        contentType: "image/png",
      });

      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart edge handles support keyboard reconnect", async ({
    context,
    page,
    request,
  }) => {
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
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await sourceEditor.fill(
        ["flowchart LR", "  A[Source] --> B[Target]", "  C[Spare]"].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeLabels(mermaidBlock))
        .toMatchObject({
          A: "Source",
          B: "Target",
          C: "Spare",
        });

      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      const targetReconnectHandle = mermaidBlock.locator(
        '.myoxus-mermaid-gfx-edge-handle[data-endpoint="target"]',
      );
      await expect(targetReconnectHandle).toBeVisible({ timeout: 5_000 });
      await targetReconnectHandle.press(
        await flowchartArrowKeyTowardNode(mermaidBlock, "B", "C"),
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\[Source\] edge-A-B-1@--> C\[Spare\]/,
      );
      await expect(sourceEditor).not.toHaveValue(
        /A\[Source\] edge-A-B-1@--> B/,
      );

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "C");
      const sourceReconnectHandle = mermaidBlock.locator(
        '.myoxus-mermaid-gfx-edge-handle[data-endpoint="source"]',
      );
      await expect(sourceReconnectHandle).toBeVisible({ timeout: 5_000 });
      await sourceReconnectHandle.press(
        await flowchartArrowKeyTowardNode(mermaidBlock, "A", "B"),
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /B\[Target\] edge-A-B-1@--> C\[Spare\]/,
      );
      await expect(sourceEditor).not.toHaveValue(
        /A\[Source\] edge-A-B-1@--> C/,
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Flowchart source edits replace stale managed frame labels", async ({
    context,
    page,
    request,
  }) => {
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
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });

      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => flowchartNodeIds(mermaidBlock)).toContain("C");
      await selectFlowchartNode(mermaidBlock, visualCanvas, "C");
      const keyboardResizeHandle = mermaidBlock
        .locator(".myoxus-mermaid-gfx-resize-handle")
        .first();
      await keyboardResizeHandle.press("Shift+ArrowRight");

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toBeVisible();
      await sourceEditor.fill(
        [
          "flowchart LR",
          "  A[Keyboard source]",
          "  B[Keyboard target]",
          "  C[Keyboard spare]",
        ].join("\n"),
      );
      await page.waitForTimeout(450);
      await expect(sourceEditor).toHaveValue(/Keyboard source/);
      await expect(sourceEditor).not.toHaveValue(/Start/);

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeLabels(mermaidBlock))
        .toMatchObject({
          A: "Keyboard source",
          B: "Keyboard target",
          C: "Keyboard spare",
        });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/Keyboard target/);
      await expect(sourceEditor).not.toHaveValue(/Step/);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });
});
