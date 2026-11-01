// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getAccountColorMode,
  getAccountLocale,
  setAccountColorMode,
  setAccountLocale,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  assertLocatorUsesThemeBackground,
  assertScreenshotHasDiagramContent,
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "./virgultum-mermaid-block-doc-helpers";
import {
  connectFlowchartNodesViaContextMenu,
  flowchartNodeIds,
  flowchartSubgraphHeaderPoint,
  flowchartSubgraphNodeIds,
} from "./virgultum-mermaid-block-edgeless-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "./virgultum-mermaid-block-http-helpers";
import {
  dragFlowchartResizeHandle,
  flowchartBlankPoint,
  flowchartModelPointFromViewPoint,
  flowchartNodeModelPoint,
  flowchartNodePoint,
  flowchartNodeSize,
  flowchartNodeViewBox,
  renameFlowchartEdgeInline,
  renameFlowchartNodeInline,
  selectFlowchartEdge,
  selectFlowchartNode,
} from "./virgultum-mermaid-block-page-helpers";
import {
  MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
  MERMAID_BROWSER_QUANTITATIVE_GFX_FIXTURES,
  MERMAID_BROWSER_SOURCE_FIRST_FIXTURES,
  MERMAID_GANTT_JOURNEY_FIXTURE,
  MERMAID_PAGE_VIEWPORT_FLOWCHART_FIXTURE,
  MERMAID_STATE_JOURNEY_FIXTURE,
  MERMAID_BLOCK_JOURNEY_FIXTURE,
} from "./virgultum-mermaid-block-product-fixtures";

function requiredMermaidFixture<
  TFixture extends { readonly diagramType: string },
>(fixtures: readonly TFixture[], diagramType: string): TFixture {
  const fixture = fixtures.find(
    (candidate) => candidate.diagramType === diagramType,
  );
  if (!fixture) {
    throw new Error(`Missing Mermaid page-mode smoke fixture: ${diagramType}`);
  }
  return fixture;
}

async function radarVertexHitTarget(vertex: Locator) {
  type HitTarget = { radius: number; x: number; y: number };
  const hitArea = vertex.locator("circle.myoxus-data-radar-vertex-hitarea");
  let target: HitTarget | null = null;
  await expect
    .poll(
      async () => {
        target = await hitArea.evaluate((element) => {
          const circle = element as SVGCircleElement;
          const svg = circle.closest("svg") as SVGSVGElement | null;
          if (!svg) return null;
          const rect = svg.getBoundingClientRect();
          const viewBox = svg.viewBox.baseVal;
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            viewBox.width <= 0 ||
            viewBox.height <= 0
          )
            return null;
          const scaleX = rect.width / viewBox.width;
          const scaleY = rect.height / viewBox.height;
          return {
            radius: circle.r.baseVal.value * Math.min(scaleX, scaleY),
            x: rect.x + (circle.cx.baseVal.value - viewBox.x) * scaleX,
            y: rect.y + (circle.cy.baseVal.value - viewBox.y) * scaleY,
          };
        });
        return target?.radius ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(4);
  if (!target) throw new Error("Radar vertex hit area is not projected");
  expect(Number.isFinite(target.x)).toBe(true);
  expect(Number.isFinite(target.y)).toBe(true);
  return target;
}

const MERMAID_PAGE_MODE_MATRIX_SMOKE_FIXTURES = [
  requiredMermaidFixture(
    MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
    "sequenceDiagram",
  ),
  requiredMermaidFixture(
    MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
    "architecture",
  ),
  ...MERMAID_BROWSER_SOURCE_FIRST_FIXTURES,
] as const;

const MERMAID_PAGE_MODE_CHART_SMOKE_FIXTURE = requiredMermaidFixture(
  MERMAID_BROWSER_QUANTITATIVE_GFX_FIXTURES,
  "pie",
);

const MERMAID_XY_SOURCE = [
  "xychart-beta",
  '  title "Revenue"',
  "  x-axis [Jan, April, Feb, Q4]",
  '  y-axis "Revenue (USD)" 0 --> 10',
  '  bar "Expenses" [3, 4.5, 6, 8]',
  '  line "Revenue trend" [5.5, 7, 9.1, 9.5]',
].join("\n");

const MERMAID_RADAR_SOURCE = [
  "---",
  'title: "Radar readiness"',
  "config:",
  "  radar:",
  "    useMaxWidth: true",
  "    width: 760",
  "    height: 620",
  "---",
  "radar-beta :",
  "  accTitle: Operational readiness comparison",
  "  accDescr: Current and target readiness across delivery dimensions.",
  '  axis Speed["Delivery velocity"]',
  '  axis Quality["Shared capability"]',
  '  axis Cost["Cost efficiency"]',
  '  axis Security["Security readiness"]',
  '  axis Reliability["Service reliability"]',
  '  axis Maintainability["Long-term maintainability"]',
  '  curve Current["Current profile"] {4, 4, 2, 5, 6, 4}',
  '  curve Target["Target profile"] {6, 7, 5, 8, 9, 7}',
  "  showLegend true, ticks 7, max 10, min 1, graticule polygon",
].join("\n");

const MERMAID_TREEMAP_SOURCE = [
  "---",
  'title: "Portfolio allocation"',
  "---",
  "treemap-beta",
  '"Portfolio"',
  '  "Sales"',
  "",
  "    %% Account plan",
  '    "Enterprise": 30:::warm',
  '    "Enterprise": 40:::warm',
  '  "Research"',
  '    "Experiment": 6',
  '  "Empty"',
  "classDef warm fill:#c95f4f,color:#fff;",
  "classDef warm stroke:#722,border-width:2px;",
].join("\n");

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

type MermaidVisualModelSummary = {
  diagramType: string;
  edgeCount: number;
  nodeCount: number;
  source: string;
  subgraphCount: number;
};

type MermaidOwnerInventory = {
  childBounds: string[];
  childIds: string[];
  id: string;
  parentFlavor: string;
  parentId: string;
  source: string;
  xywh: string;
};

async function mermaidOwnerInventory(page: Page) {
  return page.evaluate(() => {
    const carrier = (document.querySelector("myoxus-edgeless-root") ??
      document.querySelector("myoxus-mermaid")) as {
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model: {
              childIds?: string[];
              id?: string;
              props?: { source?: { toString?: () => string } };
              surface?: {
                getElementById?: (id: string) => { xywh?: string } | null;
              };
              xywh?: string;
            };
          }>;
          getParent?: (model: unknown) => {
            flavour?: string;
            id?: string;
          } | null;
        };
      };
    } | null;
    const store = carrier?.std?.store;
    if (!store?.getBlocksByFlavour || !store.getParent) {
      throw new Error("Mermaid owner store is unavailable");
    }
    return store.getBlocksByFlavour("myoxus:mermaid").map(({ model }) => {
      const parent = store.getParent!(model);
      const childIds = [...(model.childIds ?? [])];
      return {
        childBounds: childIds.map(
          (id) => model.surface?.getElementById?.(id)?.xywh ?? "",
        ),
        childIds,
        id: model.id ?? "",
        parentFlavor: parent?.flavour ?? "",
        parentId: parent?.id ?? "",
        source: model.props?.source?.toString?.() ?? "",
        xywh: model.xywh ?? "",
      } satisfies MermaidOwnerInventory;
    });
  });
}

async function openMermaidEdgelessMenu(page: Page, query: string) {
  await page
    .getByTestId("myoxus-mermaid-edgeless-toolbar-button")
    .click({ timeout: 10_000 });
  await expect(
    page.locator("myoxus-menu input.myoxus-menu-search").last(),
  ).toBeFocused();
  await page.keyboard.type(query);
}

async function importMermaidFile(page: Page, filePath: string) {
  await page.evaluate(() => {
    window.showOpenFilePicker = undefined;
  });
  await openMermaidEdgelessMenu(page, "Import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("myoxus-mermaid-edgeless-import-mmd").click();
  await (await chooser).setFiles(filePath);
}

async function seedLegacyLinkedMermaidOwner(page: Page, ownerId: string) {
  return page.evaluate((id) => {
    const mermaid = [...document.querySelectorAll("myoxus-mermaid")].find(
      (candidate) =>
        (candidate as unknown as { model?: { id?: string } }).model?.id === id,
    ) as {
      std?: {
        store?: {
          addBlock?: (
            flavour: string,
            props: Record<string, unknown>,
            parentId: string,
          ) => string;
          getBlock?: (id: string) => {
            model: {
              props: { childElementIds?: Record<string, boolean> };
            };
          } | null;
          getBlocksByFlavour?: (flavour: string) => Array<{
            model: { id: string };
          }>;
        };
      };
      model?: {
        childIds?: string[];
        props?: { childElementIds?: Record<string, boolean> };
        xywh?: string;
        yBlock?: { set: (key: string, value: unknown) => void };
      };
    } | null;
    const store = mermaid?.std?.store;
    const owner = mermaid?.model;
    const surfaceId =
      store?.getBlocksByFlavour?.("myoxus:surface")[0]?.model.id;
    if (!store?.addBlock || !store.getBlock || !owner || !surfaceId) {
      throw new Error("Cannot provision Mermaid legacy owner seed");
    }
    const frameId = store.addBlock(
      "myoxus:frame",
      { xywh: owner.xywh },
      surfaceId,
    );
    const frame = store.getBlock(frameId)?.model;
    if (!frame || !owner.props || !owner.yBlock) {
      throw new Error("Cannot materialize Mermaid legacy frame seed");
    }
    frame.props.childElementIds = Object.fromEntries(
      (owner.childIds ?? []).map((childId) => [childId, true]),
    );
    owner.props.childElementIds = {};
    owner.yBlock.set("prop:reference", frameId);
    return frameId;
  }, ownerId);
}

async function hasBlock(page: Page, blockId: string) {
  return page.evaluate((id) => {
    const carrier = document.querySelector("myoxus-edgeless-root");
    const store = (
      carrier as {
        std?: { store?: { getBlock?: (id: string) => unknown } };
      } | null
    )?.std?.store;
    if (!store?.getBlock) throw new Error("Edgeless store is unavailable");
    return Boolean(store.getBlock(id));
  }, blockId);
}

function expectContainedBounds(owner: MermaidOwnerInventory) {
  const [ownerX, ownerY, ownerWidth, ownerHeight] = JSON.parse(owner.xywh) as [
    number,
    number,
    number,
    number,
  ];
  for (const serialized of owner.childBounds) {
    const [x, y, width, height] = JSON.parse(serialized) as [
      number,
      number,
      number,
      number,
    ];
    expect(x).toBeGreaterThanOrEqual(ownerX - 1);
    expect(y).toBeGreaterThanOrEqual(ownerY - 1);
    expect(x + width).toBeLessThanOrEqual(ownerX + ownerWidth + 1);
    expect(y + height).toBeLessThanOrEqual(ownerY + ownerHeight + 1);
  }
}

async function selectFacadeOption(
  page: Page,
  scope: Locator,
  label: string,
  option: string,
): Promise<void> {
  const control = scope.getByRole("combobox", { name: label });
  await expect(control).toBeEnabled({ timeout: 5_000 });
  await control.click();
  await page.getByRole("option", { exact: true, name: option }).click();
}

async function dragWithinLocator(
  page: Page,
  locator: Locator,
  source: { x: number; y: number },
  target: { x: number; y: number },
  steps = 5,
): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Mermaid visual canvas is not visible");
  await page.mouse.move(box.x + source.x, box.y + source.y);
  await page.mouse.down();
  await page.mouse.move(box.x + target.x, box.y + target.y, { steps });
  await page.mouse.up();
}

async function mermaidVisualModelSummary(
  mermaidBlock: Locator,
): Promise<MermaidVisualModelSummary> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      _getMermaidVisualModelForEditing?: () => {
        diagramType?: string;
        edges?: unknown[];
        nodes?: unknown[];
        subgraphs?: unknown[];
      } | null;
      model?: {
        props?: {
          source?: { toString?: () => string };
        };
      };
    };
    const model = block._getMermaidVisualModelForEditing?.();
    return {
      diagramType: model?.diagramType ?? "",
      edgeCount: model?.edges?.length ?? 0,
      nodeCount: model?.nodes?.length ?? 0,
      source: block.model?.props?.source?.toString?.() ?? "",
      subgraphCount: model?.subgraphs?.length ?? 0,
    };
  });
}

async function expectMermaidGfxVisualModel(
  mermaidBlock: Locator,
  expected: {
    diagramType: string;
    minEdges?: number;
    minNodes?: number;
    minSubgraphs?: number;
  },
) {
  await expect(
    mermaidBlock.locator(
      '.myoxus-mermaid-gfx-editor[data-mermaid-gfx-editable="true"]',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(mermaidBlock.getByLabel("Template")).toHaveCount(0);
  await expect
    .poll(
      async () => (await mermaidVisualModelSummary(mermaidBlock)).diagramType,
    )
    .toBe(expected.diagramType);
  await expect
    .poll(async () => (await mermaidVisualModelSummary(mermaidBlock)).nodeCount)
    .toBeGreaterThanOrEqual(expected.minNodes ?? 0);
  await expect
    .poll(async () => (await mermaidVisualModelSummary(mermaidBlock)).edgeCount)
    .toBeGreaterThanOrEqual(expected.minEdges ?? 0);
  await expect
    .poll(
      async () => (await mermaidVisualModelSummary(mermaidBlock)).subgraphCount,
    )
    .toBeGreaterThanOrEqual(expected.minSubgraphs ?? 0);
}

async function writeMermaidSource(sourceEditor: Locator, source: string) {
  await expect(sourceEditor).toBeVisible({ timeout: 10_000 });
  await sourceEditor.fill(source);
  await sourceEditor.blur();
  await expect(sourceEditor).toHaveValue(
    new RegExp(`${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
}

test.describe("Virgultum Mermaid block", () => {
  test.describe.configure({ timeout: 120_000 });
  let localeCookies: string[] = [];
  let originalLocale: string | null = null;
  let ganttCleanup: ((request: APIRequestContext) => Promise<void>) | undefined;

  test.afterEach(async ({ request }) => {
    // Teardown owns resource cleanup before request-fixture disposal, including
    // when the bounded Gantt journey exhausts its independent body deadline.
    try {
      await ganttCleanup?.(request);
    } finally {
      ganttCleanup = undefined;
    }
  });

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

  test("Mermaid slash command inserts a visual editor and keeps source/preview behind the source tab", async ({
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
    const preferenceTarget = { request, gqlEndpoint: GQL, cookies };
    const originalColorMode = await getAccountColorMode(preferenceTarget);
    await setAccountColorMode(preferenceTarget, "dark");
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");

      const mermaidMenuItem = page.getByTestId(
        "slash-menu-item-mermaid-flowchart-basic",
      );
      await expect(mermaidMenuItem).toBeVisible({ timeout: 5_000 });
      await mermaidMenuItem.click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("myoxus-mermaid")).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-editor").first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-viewport").first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-viewport myoxus-surface"),
      ).toHaveCount(1);
      await expect(
        mermaidBlock.locator(
          ".myoxus-mermaid-gfx-viewport edgeless-toolbar-widget",
        ),
      ).toHaveCount(0);
      await expect(mermaidBlock.locator("myoxus-frame")).toHaveCount(0);
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await expect(mermaidBlock.locator("[data-mermaid-hit-edge]")).toHaveCount(
        0,
      );
      await expect(mermaidBlock.locator("[data-mermaid-hit-node]")).toHaveCount(
        0,
      );
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-hit-layer"),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-visual-canvas"),
      ).toHaveCount(0);
      await expect(mermaidBlock.locator(".myoxus-mermaid-source")).toHaveCount(
        0,
      );
      await expect(mermaidBlock.locator(".myoxus-mermaid-preview")).toHaveCount(
        0,
      );
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-structured-row"),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-controls"),
      ).toHaveCount(0);
      await expect(mermaidBlock.getByLabel("Template")).toHaveCount(0);
      await expect(
        mermaidBlock.getByRole("toolbar", { name: "Mermaid diagram controls" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        mermaidBlock.getByRole("button", { exact: true, name: "Add node" }),
      ).toBeEnabled();
      await expect(
        mermaidBlock.getByRole("button", { exact: true, name: "Decision" }),
      ).toHaveCount(0);
      await expect(
        mermaidBlock
          .getByRole("toolbar", { name: "Mermaid diagram controls" })
          .getByRole("button", { exact: true, name: "Connect" }),
      ).toBeDisabled();
      await mermaidBlock.getByRole("button", { name: "Node shapes" }).click();
      await expect(
        page.getByRole("menuitem", { name: /Place process on canvas/i }),
      ).toBeEnabled();
      const placeDecisionButton = page.getByRole("menuitem", {
        name: /Place decision on canvas/i,
      });
      await expect(placeDecisionButton).toBeEnabled();
      await page.keyboard.press("Escape");

      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      await assertLocatorUsesThemeBackground(
        visualCanvas,
        "inline Mermaid GFX viewport in dark theme",
      );
      let firstNodePoint = await flowchartNodePoint(mermaidBlock, "A");
      const initialVisualBox = await visualCanvas.boundingBox();
      expect(initialVisualBox).toBeTruthy();
      await assertScreenshotHasDiagramContent(
        page,
        {
          height: 92,
          width: 140,
          x: Math.max(
            initialVisualBox!.x,
            initialVisualBox!.x + firstNodePoint.x - 70,
          ),
          y: Math.max(
            initialVisualBox!.y,
            initialVisualBox!.y + firstNodePoint.y - 46,
          ),
        },
        "inline Mermaid initial GFX node",
        300,
      );
      const darkCanvasScreenshotPath = testInfo.outputPath(
        "web-mermaid-inline-dark-canvas.png",
      );
      await page.screenshot({ path: darkCanvasScreenshotPath });
      await testInfo.attach("web-mermaid-inline-dark-canvas", {
        path: darkCanvasScreenshotPath,
        contentType: "image/png",
      });
      const nodeIdsBeforePlacement = await flowchartNodeIds(mermaidBlock);
      await mermaidBlock.getByRole("button", { name: "Node shapes" }).click();
      await page
        .getByRole("menuitem", { name: /Place decision on canvas/i })
        .click();
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-inserting-shape="true"]',
        ),
      ).toBeVisible();
      expect(await flowchartNodeIds(mermaidBlock)).toEqual(
        nodeIdsBeforePlacement,
      );
      const decisionPlacementPoint = {
        x: Math.max(96, initialVisualBox!.width * 0.24),
        y: Math.max(180, initialVisualBox!.height * 0.72),
      };
      const decisionPlacementModelPoint =
        await flowchartModelPointFromViewPoint(
          mermaidBlock,
          decisionPlacementPoint,
        );
      await page.mouse.click(
        initialVisualBox!.x + decisionPlacementPoint.x,
        initialVisualBox!.y + decisionPlacementPoint.y,
      );
      let insertedNodeId = "";
      await expect
        .poll(async () => {
          const afterPlacement = await flowchartNodeIds(mermaidBlock);
          const added = afterPlacement.filter(
            (nodeId) => !nodeIdsBeforePlacement.includes(nodeId),
          );
          insertedNodeId = added[0] ?? "";
          return added.length;
        })
        .toBe(1);
      const insertedDecisionModelPoint = await flowchartNodeModelPoint(
        mermaidBlock,
        insertedNodeId,
      );
      expect(
        Math.hypot(
          insertedDecisionModelPoint.x - decisionPlacementModelPoint.x,
          insertedDecisionModelPoint.y - decisionPlacementModelPoint.y,
        ),
      ).toBeLessThan(48);
      await mermaidBlock.getByRole("button", { name: "Close" }).click();
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        new RegExp(`${insertedNodeId}\\{Decision \\d+\\}`),
      );
      await sourceEditor.fill(
        "flowchart TD\n  A[Start]\n  B[Step]\n  C[Result]",
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain(insertedNodeId);
      firstNodePoint = await flowchartNodePoint(mermaidBlock, "A");
      const resultPointBeforeLeftDrag = await flowchartNodePoint(
        mermaidBlock,
        "C",
      );
      await visualCanvas.dragTo(visualCanvas, {
        sourcePosition: resultPointBeforeLeftDrag,
        targetPosition: {
          x: resultPointBeforeLeftDrag.x - 120,
          y: resultPointBeforeLeftDrag.y,
        },
      });
      await expect
        .poll(async () => (await flowchartNodePoint(mermaidBlock, "C")).x)
        .toBeLessThan(resultPointBeforeLeftDrag.x - 40);
      const resultLeftDragScreenshotPath = testInfo.outputPath(
        "web-mermaid-result-left-drag.png",
      );
      await page.screenshot({ path: resultLeftDragScreenshotPath });
      await testInfo.attach("web-mermaid-result-left-drag", {
        path: resultLeftDragScreenshotPath,
        contentType: "image/png",
      });
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-shape-swatch"),
      ).toHaveCount(0);
      const shapeMenu = mermaidBlock.getByRole("button", {
        name: "Node shapes",
      });
      await expect(shapeMenu).toBeVisible();
      await shapeMenu.click();
      const shapeActions = page.getByRole("menuitem", {
        name: /Change selected node to/i,
      });
      await expect(shapeActions.first()).toBeVisible();
      expect(await shapeActions.count()).toBeGreaterThanOrEqual(20);
      const expandedPaletteScreenshotPath = testInfo.outputPath(
        "web-mermaid-expanded-shape-palette.png",
      );
      await page.screenshot({ path: expandedPaletteScreenshotPath });
      await testInfo.attach("web-mermaid-expanded-shape-palette", {
        path: expandedPaletteScreenshotPath,
        contentType: "image/png",
      });
      await page.keyboard.press("Escape");
      await visualCanvas.click({
        force: true,
        position: await flowchartBlankPoint(mermaidBlock),
      });
      await shapeMenu.click();
      await expect(
        page.getByRole("menuitem", {
          name: /Place process on canvas/i,
        }),
      ).toBeEnabled();
      await page.keyboard.press("Escape");
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      await expect(
        mermaidBlock.locator(
          '[data-myoxus-ui-role="mermaid-flowchart-inspector"]',
        ),
      ).toBeVisible();
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(mermaidBlock)).source,
        )
        .toContain("A[Start]");
      await shapeMenu.click();
      const decisionShapeButton = page.getByRole("menuitem", {
        exact: true,
        name: "Change selected node to Decision",
      });
      await expect(decisionShapeButton).toBeEnabled();
      await decisionShapeButton.click();
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(mermaidBlock)).source,
        )
        .toContain("A{Start}");
      await expect(mermaidBlock.getByLabel("Selected node label")).toHaveCount(
        0,
      );
      await renameFlowchartNodeInline(
        page,
        mermaidBlock,
        visualCanvas,
        "A",
        "Inline reviewed start",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/Inline reviewed start/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      firstNodePoint = await flowchartNodePoint(mermaidBlock, "A");
      const sizeBeforeResize = await flowchartNodeSize(mermaidBlock, "A");
      const resizeHandle = mermaidBlock
        .locator(".myoxus-mermaid-gfx-resize-handle")
        .first();
      await expect(resizeHandle).toBeVisible({ timeout: 5_000 });
      await dragFlowchartResizeHandle(page, resizeHandle, visualCanvas, {
        x: firstNodePoint.x + 130,
        y: firstNodePoint.y + 88,
      });
      await expect
        .poll(async () => {
          const size = await flowchartNodeSize(mermaidBlock, "A");
          return (
            size.width > sizeBeforeResize.width &&
            size.height > sizeBeforeResize.height
          );
        })
        .toBe(true);
      const sizeAfterResize = await flowchartNodeSize(mermaidBlock, "A");
      expect(sizeAfterResize.width).toBeGreaterThan(sizeBeforeResize.width);
      expect(sizeAfterResize.height).toBeGreaterThan(sizeBeforeResize.height);

      await connectFlowchartNodesViaContextMenu(
        page,
        mermaidBlock,
        visualCanvas,
        "A",
        "B",
      );
      await renameFlowchartEdgeInline(
        page,
        mermaidBlock,
        visualCanvas,
        "A",
        "B",
        "review path",
      );
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      await selectFacadeOption(
        page,
        mermaidBlock,
        "Selected edge type",
        "Cross",
      );

      const visualBox = await mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first()
        .boundingBox();
      expect(visualBox).toBeTruthy();
      await assertScreenshotHasDiagramContent(
        page,
        {
          height: Math.max(100, visualBox!.height - 24),
          width: Math.max(140, visualBox!.width - 24),
          x: visualBox!.x + 12,
          y: visualBox!.y + 12,
        },
        "inline Mermaid flowchart visual editor",
      );

      await expect(mermaidBlock.getByLabel("Selected edge label")).toHaveCount(
        0,
      );
      const targetReconnectHandle = mermaidBlock.locator(
        '.myoxus-mermaid-gfx-edge-handle[data-endpoint="target"]',
      );
      await expect(targetReconnectHandle).toBeVisible({ timeout: 5_000 });
      await targetReconnectHandle.dragTo(visualCanvas, {
        targetPosition: await flowchartNodePoint(mermaidBlock, "C"),
      });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\{Inline reviewed start\} --x \|review path\| C\[Result\]/,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "C");
      await mermaidBlock.focus();
      await page.keyboard.press("Delete");

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/Inline reviewed start/);
      await expect(sourceEditor).toHaveValue(/A\{Inline reviewed start\}/);
      await expect(sourceEditor).not.toHaveValue(/-->/);
      await expect(sourceEditor).not.toHaveValue(/--x/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Z");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /A\{Inline reviewed start\} --x \|review path\| C\[Result\]/,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Y");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/A\{Inline reviewed start\}/);
      await expect(sourceEditor).not.toHaveValue(/--x/);

      await sourceEditor.fill(
        "flowchart TD\n  A[Keep] --> B[Remove]\n  C[Standalone]",
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect.poll(() => flowchartNodeIds(mermaidBlock)).toContain("B");
      await expect(mermaidBlock.getByLabel("Selected edge label")).toHaveCount(
        0,
      );
      await selectFlowchartNode(mermaidBlock, visualCanvas, "B");
      await expect(mermaidBlock.getByLabel("Selected node label")).toHaveCount(
        0,
      );
      await mermaidBlock.focus();
      await page.keyboard.press("Backspace");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain("B");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/A\[Keep\]/);
      await expect(sourceEditor).toHaveValue(/C\[Standalone\]/);
      await expect(sourceEditor).not.toHaveValue(/B\[Remove\]/);
      await expect(sourceEditor).not.toHaveValue(/-->/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Z");
      await expect.poll(() => flowchartNodeIds(mermaidBlock)).toContain("B");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/A\[Keep\] --> B\[Remove\]/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.focus();
      await page.keyboard.press("Control+Y");
      await expect
        .poll(() => flowchartNodeIds(mermaidBlock))
        .not.toContain("B");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).not.toHaveValue(/B\[Remove\]/);
      await expect(sourceEditor).not.toHaveValue(/-->/);

      await expect(mermaidBlock.locator(".myoxus-mermaid-preview")).toHaveCount(
        0,
      );

      await sourceEditor.fill(
        [
          "flowchart TD",
          "  subgraph SG [Review lane]",
          "    A[Draft]",
          "  end",
          "  B[Outside]",
        ].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() => flowchartSubgraphNodeIds(mermaidBlock, "SG"))
        .toEqual(["A"]);
      await visualCanvas.dragTo(visualCanvas, {
        sourcePosition: await flowchartNodePoint(mermaidBlock, "B"),
        targetPosition: await flowchartNodePoint(mermaidBlock, "A"),
      });
      await expect
        .poll(() => flowchartSubgraphNodeIds(mermaidBlock, "SG"), {
          timeout: 10_000,
        })
        .toEqual(["A", "B"]);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/subgraph SG \[Review lane\]/);
      await expect(sourceEditor).toHaveValue(/A\[Draft\]/);
      await expect(sourceEditor).toHaveValue(/B\[Outside\]/);
      await expect(sourceEditor).toHaveValue(/end/);
      await expect(mermaidBlock.locator(".myoxus-mermaid-preview")).toHaveCount(
        0,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const subgraphPoint = await flowchartSubgraphHeaderPoint(
        mermaidBlock,
        "SG",
      );
      await visualCanvas.click({
        force: true,
        position: subgraphPoint,
      });
      await expect(mermaidBlock.getByLabel("Selected group title")).toBeEnabled(
        { timeout: 5_000 },
      );
      await mermaidBlock.getByLabel("Selected group title").fill("QA lane");
      await mermaidBlock
        .getByLabel("Selected group title")
        .dispatchEvent("change", { bubbles: true, cancelable: true });
      await expect(
        mermaidBlock.getByLabel("Selected group direction"),
      ).toHaveCount(0);
      const subgraphResize = mermaidBlock
        .locator(".myoxus-mermaid-gfx-subgraph-resize-handle")
        .first();
      await expect(subgraphResize).toBeVisible({ timeout: 5_000 });
      await subgraphResize.dragTo(visualCanvas, {
        targetPosition: { x: 360, y: 320 },
      });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/subgraph SG \[QA lane\]/);
      await expect(sourceEditor).not.toHaveValue(/direction LR/);
      await expect(mermaidBlock.locator(".myoxus-mermaid-preview")).toHaveCount(
        0,
      );

      await sourceEditor.fill(
        [
          "flowchart LR",
          "  A[Start] e_review@--> B[Review]",
          "  classDef active fill:#eef2ff,stroke:#4f46e5,color:#111827;",
          "  class A,B active;",
          "  linkStyle 0 stroke:#4f46e5,stroke-width:2px;",
        ].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await renameFlowchartNodeInline(
        page,
        mermaidBlock,
        visualCanvas,
        "A",
        "Styled start",
      );
      await selectFlowchartNode(mermaidBlock, visualCanvas, "A");
      await selectFacadeOption(
        page,
        mermaidBlock,
        "Selected node style",
        "Accent",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/A\[Styled start\] e_review@-->/);
      await expect(sourceEditor).toHaveValue(/class A accent/);
      await expect(sourceEditor).toHaveValue(/classDef active/);
      await expect(sourceEditor).toHaveValue(/linkStyle 0/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await selectFlowchartEdge(mermaidBlock, visualCanvas, "A", "B");
      await expect(
        mermaidBlock.getByLabel("Selected edge visual style"),
      ).toBeEnabled({ timeout: 5_000 });
      await selectFacadeOption(
        page,
        mermaidBlock,
        "Selected edge visual style",
        "Success",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /linkStyle 0 stroke:#059669,stroke-width:2px;/,
      );

      await sourceEditor.fill("flowchart-elk LR\n  A[Start] --> B[Done]");
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(
        mermaidBlock.locator(
          '.myoxus-mermaid-gfx-editor[data-mermaid-gfx-editable="true"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/flowchart-elk LR/);

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(mermaidBlock.locator(".myoxus-mermaid-source")).toHaveCount(
        0,
      );

      await mermaidBlock.evaluate((element) => {
        const block = element as unknown as {
          std?: { store?: { readonly?: boolean } };
        };
        if (!block.std?.store) throw new Error("Missing Mermaid store");
        block.std.store.readonly = true;
      });
      await expect(
        mermaidBlock.getByRole("button", { name: "Add node" }),
      ).toBeDisabled();
      await expect(
        mermaidBlock.getByRole("button", { name: "Connect" }),
      ).toBeDisabled();
      await expect(
        mermaidBlock.getByRole("button", { name: "Node shapes" }),
      ).toBeDisabled();
      await expect(
        mermaidBlock.getByRole("button", { name: "More actions" }),
      ).toBeDisabled();
      await expect(visualCanvas).toBeVisible();
      await mermaidBlock.evaluate((element) => {
        const block = element as unknown as {
          std?: { store?: { readonly?: boolean } };
        };
        if (!block.std?.store) throw new Error("Missing Mermaid store");
        block.std.store.readonly = false;
      });
      await expect(
        mermaidBlock.getByRole("button", { name: "Add node" }),
      ).toBeEnabled();

      // Keep this page-level smoke focused on the source/visual tab contract.
      // The family-specific browser specs exercise the complete Mermaid matrix
      // with richer interaction assertions; duplicating the full matrix here
      // makes the single page smoke exceed its user-visible failure budget.
      for (const fixture of MERMAID_PAGE_MODE_MATRIX_SMOKE_FIXTURES) {
        await mermaidBlock.getByText("Source", { exact: true }).click();
        await writeMermaidSource(sourceEditor, fixture.source);
        await mermaidBlock.getByText("Visual", { exact: true }).click();
        await expectMermaidGfxVisualModel(mermaidBlock, fixture);
        await expect(
          mermaidBlock.locator(".myoxus-mermaid-structured-editor"),
        ).toHaveCount(0);
      }

      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await setAccountColorMode(preferenceTarget, originalColorMode);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Timeline keeps event edits, native output, history and Edgeless reload in one journey", async ({
    context,
    page,
    request,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        runtimeErrors.push(message.text());
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
    ganttCleanup = async (cleanupRequest) => {
      try {
        if (docId)
          await cleanupDoc(workspaceId, cookies, docId, cleanupRequest);
      } finally {
        await signOutViaApi(cleanupRequest, API, cookies);
      }
    };
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`);
    await page.getByTestId("diagram-type-timeline").click();
    await page.getByTestId("create-selected-diagram-button").click();
    await expect(page).toHaveURL(
      new RegExp(`/workspace/${workspaceId}/(?!diagrams)[^/?]+`),
      { timeout: 30_000 },
    );
    docId = new URL(page.url()).pathname.split("/").at(-1);
    if (!docId)
      throw new Error("Timeline catalog creation has no document route");
    await page.getByTestId("switch-page-mode-button").click();
    const block = page.locator("myoxus-mermaid").first();
    const sourceEditor = block.getByRole("textbox", {
      name: "Mermaid source",
      exact: true,
    });
    const mode = block.locator(
      "[data-myoxus-ui-role=mermaid-editor-mode-control]",
    );
    const fixture =
      "timeline LR\naccTitle: Accessible Timeline\naccDescr: Retained description\n  title Timeline journey\n  P : A\n  %% retained section anchor\n  section S\n  Q : B : D\n  section S\n  R : C\n  section Empty\n";
    await mode.getByText("Source", { exact: true }).click();
    await writeMermaidSource(sourceEditor, fixture);
    await mode.getByText("Visual", { exact: true }).click();
    const beta = block
      .locator('[data-timeline-kind="event"]')
      .filter({ hasText: /^B$/ });
    await beta.click();
    await beta.press("F2");
    const label = block.getByRole("textbox", { name: "Label", exact: true });
    await label.fill("Beta");
    await label.press("Enter");
    const renamed = fixture.replace("Q : B :", "Q : Beta :");
    await mode.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(renamed);
    await block.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(sourceEditor).toHaveValue(fixture);
    await block.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(sourceEditor).toHaveValue(renamed);
    await mode.getByText("Visual", { exact: true }).click();
    const event = block
      .locator('[data-timeline-kind="event"]')
      .filter({ hasText: /^Beta$/ });
    const eventId = await event.getAttribute("data-timeline-id");
    if (!eventId) throw new Error("Timeline event has no identity");
    const grip = block.locator(`[data-timeline-drag-id="${eventId}"]`);
    await grip.press("Space");
    await grip.press("ArrowRight");
    await grip.press("ArrowRight");
    await grip.press("Enter");
    await mode.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).not.toHaveValue(renamed);
    const moved = await sourceEditor.inputValue();
    expect(moved).toContain(
      "  P : A\n  %% retained section anchor\n  section S\n",
    );
    expect(moved.match(/Beta/g)).toHaveLength(1);
    await block.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(sourceEditor).toHaveValue(renamed);
    await block.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(sourceEditor).toHaveValue(moved);
    await mode.getByText("View", { exact: true }).click();
    const svg = block.locator(
      ".myoxus-mermaid-display-preview svg[aria-roledescription=timeline]",
    );
    await expect(svg).toBeVisible();
    // Native output, not parser counts, disproves the duplicate-section and
    // lost-unsectioned renderer regression in the actual consumed entrypoint.
    for (const value of ["A", "Beta", "D", "C"])
      await expect(
        svg.locator("text").filter({ hasText: new RegExp(`^${value}$`) }),
      ).toHaveCount(1);
    await expect(svg.locator("title")).toHaveText("Accessible Timeline");
    await expect(svg.locator("desc")).toHaveText("Retained description");
    await mode.getByText("Visual", { exact: true }).click();
    await page.getByTestId("switch-edgeless-mode-button").click();
    const note = page.locator("myoxus-edgeless-note").filter({ has: block });
    await note.dblclick({ position: { x: 20, y: 70 } });
    const delta = block
      .locator('[data-timeline-kind="event"]')
      .filter({ hasText: /^D$/ });
    await delta.click();
    await delta.press("F2");
    await label.fill("Delta");
    await label.press("Enter");
    await block
      .locator('[data-timeline-kind="event"]')
      .filter({ hasText: /^Delta$/ })
      .press("Control+z");
    await expect(delta).toBeVisible();
    await delta.press("Control+Shift+z");
    await expect(
      block
        .locator('[data-timeline-kind="event"]')
        .filter({ hasText: /^Delta$/ }),
    ).toBeVisible();
    expect(
      await block
        .locator("[data-myoxus-ui-role=mermaid-editor-mode-control]")
        .count(),
    ).toBe(0);
    await page.getByTestId("header-dropDownButton").click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).hover();
    const downloading = page.waitForEvent("download");
    await page.getByTestId("export-to-mermaid-source").click();
    const downloadedPath = await (await downloading).path();
    if (!downloadedPath) throw new Error("Timeline source export has no file");
    const exported = await readFile(downloadedPath, "utf8");
    expect(exported).toBe(moved.replace(/: D(?=\s|$)/, ": Delta"));
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
      for (const key of await caches.keys())
        if (key.toLowerCase().includes("myoxus")) await caches.delete(key);
    });
    await page.reload();
    await expect(
      block
        .locator('[data-timeline-kind="event"]')
        .filter({ hasText: /^Delta$/ }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("switch-page-mode-button").click();
    await mode.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(exported);
    expect(runtimeErrors).toEqual([]);
  });

  test("Mermaid Gantt keeps task, marker, dependency, history and Edgeless edits in one journey", async ({
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

    const fixtureSource = MERMAID_GANTT_JOURNEY_FIXTURE.source
      .replace(
        "Prototype : pr1, milestone, after des1, 0d",
        "Prototype : pr1, milestone, 2026-09-12, 0d",
      )
      .replace(
        "  Security review :",
        "  Validation : val1, after int1, 1d\n  Security review :",
      )
      .replace(
        "  Release marker :",
        "  Combined : combo, after des1, until sec1\n  No duration : n1, after des1\n  Release marker :",
      )
      .replace("YYYY-MM-DD", "DD/MM/YYYY HH:mm:ss.SSS")
      .replaceAll(/2026-(\d{2})-(\d{2})/g, "$2/$1/2026 08:00:00.123")
      .concat(
        '\n  click des1 href "/help"\n  %% callback note\n  click des1 call notify("first", "second")\n',
      );
    let docId: string | undefined;
    ganttCleanup = async (cleanupRequest) => {
      try {
        if (docId)
          await cleanupDoc(workspaceId, cookies, docId, cleanupRequest);
      } finally {
        await signOutViaApi(cleanupRequest, API, cookies);
      }
    };
    // The catalog's acknowledged creation boundary must retain diagram kind,
    // native exports and the same persisted source as both editor consumers.
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`);
    await page.getByTestId("diagram-type-gantt").click();
    await page.getByTestId("create-selected-diagram-button").click();
    // Catalog navigation follows the existing 30-second registration ACK
    // boundary, not the default five-second synchronous assertion window.
    await expect(page).toHaveURL(
      new RegExp(`/workspace/${workspaceId}/(?!diagrams)[^/?]+`),
      { timeout: 30_000 },
    );
    docId = new URL(page.url()).pathname.split("/").at(-1);
    if (!docId)
      throw new Error("Catalog creation did not return a document route");
    await page.getByTestId("switch-page-mode-button").click();

    const mermaidBlock = page.locator("myoxus-mermaid").first();
    const sourceEditor = mermaidBlock.getByRole("textbox", {
      name: "Mermaid source",
    });
    await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await writeMermaidSource(sourceEditor, fixtureSource);
    await mermaidBlock.getByText("Visual", { exact: true }).click();

    // The whole fixture renders through the shared Gantt surface: two
    // sections, bars, a milestone, a `vert` marker and every dependency.
    await expect(
      mermaidBlock.getByRole("button", { name: "Design", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(mermaidBlock.locator(".myoxus-gantt-milestone")).toHaveCount(
      1,
    );
    await expect(
      mermaidBlock.locator('[data-testid^="gantt-bar-"]'),
    ).toHaveCount(10);
    await expect(
      mermaidBlock.locator('[data-testid^="gantt-marker-"]'),
    ).toHaveCount(1);
    await expect(
      mermaidBlock.locator(".myoxus-gantt-dependency-hit"),
    ).toHaveCount(7);

    // Edit exactly one of multiple bindings and the task id in one history
    // entry. Cancel and invalid arguments cannot write partial metadata.
    const bindingBar = mermaidBlock.getByRole("button", {
      name: "Design",
      exact: true,
    });
    await bindingBar.press("Shift+Enter");
    const bindingDialog = page
      .getByRole("dialog")
      .filter({ hasText: "Schedule" });
    await bindingDialog
      .getByRole("combobox", { name: "Binding", exact: true })
      .click();
    await page.getByRole("option", { name: "2 · notify", exact: true }).click();
    await bindingDialog
      .getByRole("textbox", { name: "Callback name", exact: true })
      .fill("notifyUpdated");
    await bindingDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await bindingBar.press("Shift+Enter");
    await bindingDialog
      .getByRole("combobox", { name: "Binding", exact: true })
      .click();
    await page.getByRole("option", { name: "2 · notify", exact: true }).click();
    await expect(
      bindingDialog.getByRole("textbox", {
        name: "Callback name",
        exact: true,
      }),
    ).toHaveValue("notify");
    await bindingDialog
      .getByRole("textbox", { name: "Argument 2", exact: true })
      .fill('bad"quote');
    await expect(
      bindingDialog.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await bindingDialog
      .getByRole("textbox", { name: "Argument 2", exact: true })
      .fill("changed, value");
    await bindingDialog
      .getByRole("textbox", { name: "Callback name", exact: true })
      .fill("notifyUpdated");
    await bindingDialog
      .getByRole("textbox", { name: "Task ID", exact: true })
      .fill("design11a");
    await bindingDialog
      .getByRole("textbox", { name: "Start", exact: true })
      .last()
      .fill("09:00:00");
    await bindingDialog
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    const bindingSource = fixtureSource
      .replaceAll("des1", "design11a")
      .replace(
        'notify("first", "second")',
        'notifyUpdated("first", "changed, value")',
      )
      .replace(
        "Design : design11a, 04/09/2026 08:00:00.123",
        "Design : design11a, 04/09/2026 09:00:00.123",
      );
    await expect(sourceEditor).toHaveValue(bindingSource);
    await mermaidBlock
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(sourceEditor).toHaveValue(fixtureSource);
    await mermaidBlock
      .getByRole("button", { name: "Redo", exact: true })
      .click();
    await expect(sourceEditor).toHaveValue(bindingSource);
    await mermaidBlock
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await mermaidBlock.getByText("Visual", { exact: true }).click();

    // A pointer drag on the bar's end resize handle commits a resize that
    // keeps the start and only moves the end boundary, and Undo restores it.
    const requirementsBar = mermaidBlock
      .locator('[data-testid^="gantt-bar-"]')
      .filter({ hasText: "Requirements" });
    const requirementsId = await requirementsBar.getAttribute("data-testid");
    const endHandle = mermaidBlock.locator(
      `[data-testid="${requirementsId}"] .myoxus-gantt-resize-handle[data-edge="end"]`,
    );
    await endHandle.scrollIntoViewIfNeeded();
    const endBox = await endHandle.boundingBox();
    if (!endBox) throw new Error("Gantt end resize handle is not projected");
    await page.mouse.move(
      endBox.x + endBox.width / 2,
      endBox.y + endBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(endBox.x + 120, endBox.y + endBox.height / 2);
    await page.mouse.move(endBox.x + 170, endBox.y + endBox.height / 2);
    await page.mouse.up();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).not.toHaveValue(fixtureSource);
    const resizedSource = await sourceEditor.inputValue();
    const resizedRequirements = resizedSource.match(
      /^  Requirements : .*$/m,
    )?.[0];
    expect(resizedRequirements).toMatch(
      /^  Requirements : req1, 01\/09\/2026 08:00:00\.123, \d{2}\/09\/2026 \d{2}:\d{2}:\d{2}\.123$/,
    );
    expect(resizedRequirements).not.toBe(
      "  Requirements : req1, 01/09/2026 08:00:00.123, 04/09/2026 08:00:00.123",
    );
    expect(
      resizedRequirements!.split(", ").at(-1)! > "04/09/2026 08:00:00.123",
    ).toBe(true);
    expect(resizedSource).toBe(
      fixtureSource.replace(/^  Requirements : .*$/m, resizedRequirements!),
    );
    await mermaidBlock.getByRole("button", { name: "Undo" }).click();
    await expect(sourceEditor).toHaveValue(fixtureSource);

    // 11.15: opening the anchored schedule popover on a bound task and
    // closing it without an edit must not create a source/history commit
    // (Apply stays disabled because nothing actually changed).
    await mermaidBlock.getByText("Visual", { exact: true }).click();
    const implementationBar = mermaidBlock.getByRole("button", {
      name: "Implementation",
      exact: true,
    });
    await implementationBar.press("Shift+Enter");
    const scheduleDialog = page
      .getByRole("dialog")
      .filter({ hasText: "Schedule" });
    await expect(scheduleDialog).toBeVisible({ timeout: 10_000 });
    await expect(
      scheduleDialog.getByRole("button", { name: "Apply" }),
    ).toBeDisabled();
    await expect(scheduleDialog).not.toContainText("after des1");
    await expect(
      scheduleDialog.getByRole("checkbox", { name: "Design", exact: true }),
    ).toBeChecked();
    await scheduleDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(scheduleDialog).toHaveCount(0);
    // The next full-source equality also proves that this unchanged bound
    // popover did not commit, without another Source/Visual render cycle.
    const noDurationBar = mermaidBlock.getByRole("button", {
      name: "No duration",
      exact: true,
    });
    await noDurationBar.press("Shift+Enter");
    await expect(
      scheduleDialog.getByRole("textbox", { name: "Duration", exact: true }),
    ).toHaveValue("");
    await expect(
      scheduleDialog.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await scheduleDialog
      .getByRole("textbox", { name: "Label", exact: true })
      .fill("No duration renamed");
    await scheduleDialog
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(
      fixtureSource.replace("No duration :", "No duration renamed :"),
    );
    await mermaidBlock
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(sourceEditor).toHaveValue(fixtureSource);

    // 11.18: an end resize of a bound (after) task keeps the reference and
    // writes the duration directly without opening the conversion dialog.
    await mermaidBlock.getByText("Visual", { exact: true }).click();
    const implId = await implementationBar.getAttribute("data-testid");
    const implEndHandle = mermaidBlock.locator(
      `[data-testid="${implId}"] .myoxus-gantt-resize-handle[data-edge="end"]`,
    );
    await implEndHandle.scrollIntoViewIfNeeded();
    const implEndBox = await implEndHandle.boundingBox();
    if (!implEndBox)
      throw new Error("Gantt bound end resize handle is not projected");
    await page.mouse.move(
      implEndBox.x + implEndBox.width / 2,
      implEndBox.y + implEndBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      implEndBox.x + 140,
      implEndBox.y + implEndBox.height / 2,
    );
    await page.mouse.move(
      implEndBox.x + 220,
      implEndBox.y + implEndBox.height / 2,
    );
    await page.mouse.up();
    // No conversion dialog was offered for a free bound end resize.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await mermaidBlock.getByText("Source", { exact: true }).click();
    const boundResizeSource = await sourceEditor.inputValue();
    expect(boundResizeSource).toContain("Implementation : imp1, after des1,");
    expect(boundResizeSource).not.toContain(
      "Implementation : imp1, after des1, 6d",
    );
    await mermaidBlock.getByRole("button", { name: "Undo" }).click();
    await expect(sourceEditor).toHaveValue(fixtureSource);

    // A keyboard move on the explicit Design task preserves its decimal
    // duration and never rounds it to whole days.
    await mermaidBlock.getByText("Visual", { exact: true }).click();
    const designBar = mermaidBlock.getByRole("button", {
      name: "Design",
      exact: true,
    });
    await designBar.focus();
    await designBar.press("Shift+Enter");
    const startTime = scheduleDialog
      .getByRole("textbox", { name: "Start", exact: true })
      .nth(1);
    await startTime.fill("09:99:00");
    await expect(scheduleDialog).toContainText("Unreadable time 09:99:00");
    await expect(
      scheduleDialog.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await expect(startTime).toHaveValue("09:99:00");
    await scheduleDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await designBar.press("Alt+ArrowRight");
    await designBar.press("Enter");
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(
      fixtureSource.replace(
        "Design : des1, 04/09/2026 08:00:00.123",
        "Design : des1, 04/09/2026 09:00:00.123",
      ),
    );
    const afterMove = await sourceEditor.inputValue();
    await mermaidBlock.getByRole("button", { name: "Undo" }).click();
    await expect(sourceEditor).toHaveValue(fixtureSource);
    await mermaidBlock.getByRole("button", { name: "Redo" }).click();
    await expect(sourceEditor).toHaveValue(afterMove);
    await mermaidBlock.getByText("Visual", { exact: true }).click();

    // 11.16: the global selection delete and the anchored popover delete open
    // the same dependency-impact decision naming the concrete predecessor.
    const dependencyHit = mermaidBlock.getByRole("button", {
      name: "Design → Implementation",
      exact: true,
    });
    await dependencyHit.press("Enter");
    await mermaidBlock
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete dependency",
    });
    await expect(deleteDialog).toBeVisible({ timeout: 10_000 });
    await expect(deleteDialog).toContainText("Before:");
    await expect(
      deleteDialog.getByRole("button", { name: "Delete" }),
    ).toBeDisabled();
    for (const radio of await deleteDialog.getByRole("radio").all())
      await expect(radio).not.toBeChecked();
    await expect(deleteDialog).toContainText("Integration");
    await expect(deleteDialog).toContainText("Validation");
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(deleteDialog).toHaveCount(0);
    await expect(dependencyHit).toBeFocused();
    await dependencyHit.press("Delete");
    await deleteDialog
      .getByText("Keep after previous task", { exact: true })
      .first()
      .click();
    await deleteDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(
      afterMove.replace(
        "Implementation : imp1, after des1, 6d",
        "Implementation : imp1, 6d",
      ),
    );
    await mermaidBlock
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(sourceEditor).toHaveValue(afterMove);

    await mermaidBlock.getByText("Visual", { exact: true }).click();
    await mermaidBlock
      .getByRole("button", { name: "Design → Combined", exact: true })
      .press("Enter");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const beforeStart = (
      await deleteDialog
        .getByText(/^Before:/)
        .first()
        .innerText()
    )
      .replace(/^Before: /, "")
      .split(" → ")[0];
    for (const radio of await deleteDialog.getByRole("radio").all())
      await expect(radio).not.toBeChecked();
    await deleteDialog
      .getByText("Materialize resolved dates", { exact: true })
      .first()
      .click();
    await deleteDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(
      afterMove.replace(
        "Combined : combo, after des1, until sec1",
        `Combined : combo, ${beforeStart}, until sec1`,
      ),
    );
    await mermaidBlock
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(sourceEditor).toHaveValue(afterMove);

    await mermaidBlock.getByText("Visual", { exact: true }).click();
    await page.getByTestId("switch-edgeless-mode-button").click();
    // Page-to-Edgeless retains the canvas viewport. Use the native fit action
    // before pointer work so offscreen rows cannot miss the reorder grip.
    const fitToScreen = page.getByRole("button", {
      name: "Fit to screen",
      exact: true,
    });
    if (!(await fitToScreen.isVisible()))
      await page
        .getByRole("button", { name: "Toggle Zoom Toolbar", exact: true })
        .click();
    await fitToScreen.click();
    await page.keyboard.press("Escape");
    const note = page
      .locator("myoxus-edgeless-note")
      .filter({ has: mermaidBlock });
    await expect(note).toBeVisible();
    await note.dblclick({ position: { x: 35, y: 40 } });
    await designBar.click();
    const designId = await designBar.getAttribute("data-testid");
    const designGrip = mermaidBlock.getByTestId(
      designId!.replace("gantt-bar-", "gantt-task-reorder-"),
    );
    await expect(designGrip).toBeVisible();
    await expect(
      mermaidBlock.getByRole("radiogroup", {
        name: "Mermaid diagram controls",
      }),
    ).toHaveCount(0);
    await designBar.press("Shift+Enter");
    await scheduleDialog
      .getByRole("combobox", { name: "Schedule", exact: true })
      .click();
    await scheduleDialog
      .getByRole("option", { name: "Until tasks", exact: true })
      .click();
    await expect(scheduleDialog).toBeVisible();
    await scheduleDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(scheduleDialog).toHaveCount(0);
    await expect(designBar).toBeFocused();
    await expect(designGrip).toBeVisible();
    // Source edits and history may replace a statement identity. Resolve the
    // current actor instead of reusing the earlier resize's record ID.
    const targetId = await implementationBar.getAttribute("data-testid");
    const targetGrip = mermaidBlock.getByTestId(
      targetId!.replace("gantt-bar-", "gantt-task-reorder-"),
    );
    const targetSectionId = await targetGrip
      .locator("..")
      .getAttribute("data-section-id");
    const from = await designGrip.boundingBox();
    const to = await targetGrip.boundingBox();
    if (!from || !to)
      throw new Error("Edgeless reorder anchors are not visible");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(designGrip.locator("..")).toHaveAttribute(
      "data-section-id",
      targetSectionId!,
    );
    await expect(scheduleDialog).toHaveCount(0);

    await mermaidBlock
      .getByRole("button", { name: "Dependency", exact: true })
      .click();
    await designBar.click();
    await mermaidBlock
      .getByRole("button", { name: "Integration", exact: true })
      .click();
    const createdEdge = mermaidBlock.getByRole("button", {
      name: "Design → Integration",
      exact: true,
    });
    await createdEdge.press("ArrowLeft");
    await mermaidBlock
      .getByRole("button", { name: "Requirements", exact: true })
      .click();
    await designBar.press("Alt+ArrowRight");
    await designBar.press("Enter");
    await designBar.press("Control+z");
    await designBar.press("Control+Shift+z");
    const designLine = afterMove.match(/^  Design : .*$/m)![0];
    const finalSource = afterMove
      .replace(`${designLine}\n`, "")
      .replace("  section Delivery\n", `  section Delivery\n${designLine}\n`)
      .replace(
        "Design : des1, 04/09/2026 09:00:00.123",
        "Design : des1, 04/09/2026 10:00:00.123",
      )
      .replace(
        "Integration : int1, after imp1,",
        "Integration : int1, after imp1 req1,",
      );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await note.click({ position: { x: 15, y: 70 } });
    const exportMmd = page.getByRole("button", {
      name: "Export .mmd",
      exact: true,
    });
    await expect(exportMmd).toBeVisible();
    const downloading = page.waitForEvent("download");
    await exportMmd.click();
    const downloadedPath = await (await downloading).path();
    if (!downloadedPath) throw new Error("Edgeless export has no file");
    expect(await readFile(downloadedPath, "utf8")).toBe(finalSource);

    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).hover();
    const nativeSvg = page.getByRole("menuitem", {
      name: "Mermaid SVG",
      exact: true,
    });
    await expect(nativeSvg).toBeVisible();
    const imageDownloading = page.waitForEvent("download");
    await nativeSvg.click();
    const svgPath = await (await imageDownloading).path();
    if (!svgPath) throw new Error("Native export has no file");
    const svg = await readFile(svgPath, "utf8");
    expect(svg).toContain('aria-roledescription="gantt"');
    expect(svg).not.toMatch(/NaN|Infinity|gantt-dependency-/);

    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
      for (const key of await caches.keys())
        if (key.toLowerCase().includes("myoxus")) await caches.delete(key);
    });

    await page.reload();
    await expect(
      page.getByText("Loading document content, please wait a moment."),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page
        .locator("myoxus-mermaid")
        .first()
        .getByRole("button", { name: "Design", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("switch-page-mode-button").click();
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await expect(sourceEditor).toHaveValue(finalSource);
    await expect(runtimeErrors).toEqual([]);
  });

  test("Mermaid Pie restores text and chart in Edgeless and survives reload", async ({
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
      await page.getByTestId("slash-menu-item-mermaid-pie-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(
        sourceEditor,
        MERMAID_PAGE_MODE_CHART_SMOKE_FIXTURE.source,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(mermaidBlock.getByTestId("data-pie-chart")).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-editor"),
      ).toHaveCount(0);

      const selectedPieControls = mermaidBlock.getByRole("button", {
        name: "Done: 4",
      });
      await expect(selectedPieControls).toHaveCount(2);
      await selectedPieControls.first().click();
      await expect(selectedPieControls.first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(selectedPieControls.nth(1)).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const pieValue = page.getByRole("textbox", {
        name: "Selected pie value: Done",
      });
      await expect(pieValue).toBeVisible();
      await pieValue.fill("5");
      await pieValue.press("Enter");
      await expect(
        mermaidBlock.getByRole("button", { name: "Done: 5" }),
      ).toHaveCount(2);

      const pieDataToggle = mermaidBlock.getByRole("button", { name: "Data" });
      await pieDataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toBeVisible();
      await pieDataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toHaveCount(0);

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/"Done"\s*:\s*5/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();

      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await expect(
        mermaidBlock.getByRole("button", { name: "Done: 4" }),
      ).toHaveCount(2);
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();
      await expect(
        mermaidBlock.getByRole("button", { name: "Done: 5" }),
      ).toHaveCount(2);

      await page.reload();
      await expect(
        page.getByText("Loading document content, please wait a moment."),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(mermaidBlock).toBeVisible({ timeout: 30_000 });
      await expect(mermaidBlock.getByTestId("data-pie-chart")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        mermaidBlock.getByRole("button", { name: "Done: 5" }),
      ).toHaveCount(2);
      // Extend this persisted editor journey at the history boundary: a named
      // snapshot must restore both rich text and diagram content, not replay
      // old Yjs bytes into a live document that retains the newer values.
      await typeSlashCommand(page, "History state A");
      const text = page.locator("rich-text [contenteditable=true]").filter({
        hasText: "History state A",
      });
      const sidebarToggle = page.getByTestId("context-panel-toggle");
      if ((await sidebarToggle.getAttribute("aria-expanded")) !== "true") {
        await sidebarToggle.click();
      }
      await page.getByTestId("header-dropDownButton").click();
      await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
      const versionTool = page.getByTestId("workbench-tool-menu-activity");
      if ((await versionTool.getAttribute("data-checked")) !== "true") {
        await versionTool.focus();
        await page.keyboard.press("Enter");
      }
      await expect(versionTool).toHaveAttribute("data-checked", "true");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("document-versions-empty")).toBeVisible();
      await page
        .getByRole("button", { name: "Create the first version", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Label", exact: true })
        .fill("History A");
      const captured = page.waitForResponse(
        (response) =>
          response.request().postData()?.includes("createDocumentVersion") ===
          true,
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const capture = await (await captured).json();
      expect(capture.errors).toBeUndefined();
      const version = capture.data.createDocumentVersion;
      await expect(page.locator('[aria-label^="Version:"]')).toHaveText(
        `Version ${version.label}`,
      );

      await text.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" changed to B");
      await mermaidBlock
        .getByRole("button", { name: "Done: 5" })
        .first()
        .click();
      await pieValue.fill("6");
      await pieValue.press("Enter");
      await expect(page.locator('[aria-label^="Version:"]')).toHaveText(
        `Version ${version.label} (changed)`,
      );

      await page
        .locator("label")
        .filter({ has: page.getByText("Edgeless", { exact: true }) })
        .click();
      await expect(page.locator("myoxus-edgeless-root")).toBeVisible();
      await expect(page).toHaveURL(/mode=edgeless/);
      await page.getByTestId("header-dropDownButton").click();
      await page
        .getByRole("menuitem", { name: "View history version", exact: true })
        .click();
      await page.getByTestId("history-named-version-select").click();
      await page
        .getByRole("option", { name: version.label, exact: true })
        .click();
      const preview = page.locator("myoxus-mermaid").last();
      await expect(preview.getByTestId("data-pie-chart")).toBeVisible();
      await expect(
        preview.locator('svg path[aria-label="Done: 5"]'),
      ).toBeVisible();
      await expect(
        preview.locator('svg path[aria-label="Done: 6"]'),
      ).toHaveCount(0);
      await expect(
        page.getByText("History state A", { exact: true }),
      ).toBeVisible();
      await expect(text).toHaveText("History state A changed to B");
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByTestId("confirm-restore-history-button").click();
      await expect(
        page.getByRole("button", { name: "Back to doc", exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(/mode=edgeless/);
      await expect(page.locator("myoxus-edgeless-root")).toBeVisible();
      await expect(text).toHaveText("History state A");
      await expect(
        mermaidBlock.locator('svg path[aria-label="Done: 5"]'),
      ).toBeVisible();
      await expect(
        mermaidBlock.locator('svg path[aria-label="Done: 6"]'),
      ).toHaveCount(0);
      await page.reload();
      await expect(text).toHaveText("History state A");
      await expect(
        mermaidBlock.locator('svg path[aria-label="Done: 5"]'),
      ).toBeVisible();
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid XY keeps point edits, exact source, history, data, View, and direct Edgeless reload in one journey", async ({
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
      await page.getByTestId("slash-menu-item-mermaid-xychart-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, MERMAID_XY_SOURCE);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(() =>
          page
            .locator(
              'body > div[id^="dmyoxus-mermaid-"], body > div[id^="imyoxus-mermaid-"]',
            )
            .count(),
        )
        .toBe(0);

      const pointAtSix = mermaidBlock.getByRole("button", {
        name: /Expenses · Bar 1 · Feb · 3: 6\./,
      });
      await expect(pointAtSix).toBeVisible({ timeout: 10_000 });
      await pointAtSix.click();
      await pointAtSix.press("ArrowUp");
      await pointAtSix.press("Enter");
      const pointAtSixPointOne = mermaidBlock.getByRole("button", {
        name: /Expenses · Bar 1 · Feb · 3: 6\.1\./,
      });
      await expect(pointAtSixPointOne).toBeVisible();

      const dataToggle = mermaidBlock.getByRole("button", { name: "Data" });
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Category" }),
      ).toBeVisible();
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Category" }),
      ).toHaveCount(0);

      const changedSource = MERMAID_XY_SOURCE.replace(
        "[3, 4.5, 6, 8]",
        "[3, 4.5, 6.1, 8]",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(changedSource);
      await mermaidBlock.getByText("Visual", { exact: true }).click();

      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await expect(pointAtSix).toBeVisible();
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();
      await expect(pointAtSixPointOne).toBeVisible();

      await page.reload();
      await expect(
        page.getByText("Loading document content, please wait a moment."),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(pointAtSixPointOne).toBeVisible({ timeout: 30_000 });

      await mermaidBlock.getByText("View", { exact: true }).click();
      await expect(
        mermaidBlock.getByRole("button", {
          name: "Expenses · Bar 1 · Feb · 3: 6.1",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        mermaidBlock.getByRole("button", { name: "Add plot" }),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.getByRole("button", { name: "Data" }),
      ).toHaveCount(0);

      await page.goto(
        `${FRONTEND}/workspace/${workspaceId}/${docId}?mode=edgeless`,
      );
      await expect(page.getByRole("radio", { name: "Edgeless" })).toBeChecked({
        timeout: 30_000,
      });
      await expect(
        page
          .locator("myoxus-mermaid")
          .first()
          .getByTestId("data-composite-chart"),
      ).toBeVisible({ timeout: 30_000 });
      const embeddedHost = page.locator("myoxus-mermaid").first();
      const embeddedNote = page.locator("myoxus-edgeless-note").filter({
        has: embeddedHost,
      });
      const embeddedActions = embeddedHost.locator(
        '[data-myoxus-ui-role="mermaid-embedded-actions"]',
      );
      await expect(embeddedActions).toHaveCount(0);
      await embeddedNote.dblclick();
      await expect(
        embeddedNote.locator('[data-testid="edgeless-note-container"]'),
      ).toHaveAttribute("data-editing", "true");
      await embeddedHost.getByTestId("data-composite-chart").click();
      await expect(embeddedActions).toBeVisible({ timeout: 10_000 });
      await expect(
        embeddedActions.getByRole("button", { name: "Add plot" }),
      ).toBeVisible();
      const actionBounds = await embeddedActions.boundingBox();
      const nativeToolbarBounds = await page
        .locator("edgeless-toolbar-widget")
        .boundingBox();
      expect(actionBounds).not.toBeNull();
      expect(nativeToolbarBounds).not.toBeNull();
      expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(
        nativeToolbarBounds!.y,
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Radar keeps visible vertex and option edits, exact source, history, data, View, and reload in one Page journey", async ({
    context,
    page,
    request,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text)))
        runtimeErrors.push(`console: ${text}`);
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
      await page.getByTestId("slash-menu-item-mermaid-radar-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, MERMAID_RADAR_SOURCE);
      await mermaidBlock.getByText("Visual", { exact: true }).click();

      const valueFour = mermaidBlock.getByRole("button", {
        name: /Current profile.*Delivery velocity.*: 4\./,
      });
      await expect(valueFour).toBeVisible({ timeout: 10_000 });

      const beforeDrag = await radarVertexHitTarget(valueFour);
      await page.mouse.move(beforeDrag.x, beforeDrag.y);
      await page.mouse.down();
      await page.mouse.move(beforeDrag.x, beforeDrag.y - 40, { steps: 6 });
      const dragPreview = mermaidBlock.getByRole("button", {
        name: /Current profile.*Delivery velocity.*: [5-9]\./,
      });
      await expect(dragPreview).toBeVisible();
      const previewTarget = await radarVertexHitTarget(dragPreview);
      expect(previewTarget.y).toBeLessThan(beforeDrag.y - 5);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(valueFour).toBeVisible();
      const cancelledTarget = await radarVertexHitTarget(valueFour);
      expect(cancelledTarget.y).toBeGreaterThan(previewTarget.y + 5);

      await valueFour.press("ArrowUp");
      const valueFive = mermaidBlock.getByRole("button", {
        name: /Current profile.*Delivery velocity.*: 5\./,
      });
      await expect(valueFive).toBeVisible();
      await valueFive.press("Enter");
      await expect(valueFive).toBeVisible();

      const vertexSource = MERMAID_RADAR_SOURCE.replace(
        "{4, 4, 2, 5, 6, 4}",
        "{5, 4, 2, 5, 6, 4}",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(vertexSource);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await expect(valueFour).toBeVisible();
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();
      await expect(valueFive).toBeVisible();

      await mermaidBlock.getByRole("button", { name: "Appearance" }).click();
      const appearance = page.getByRole("dialog", { name: "Appearance" });
      await expect(appearance).toBeVisible();
      await appearance.getByRole("textbox", { name: "Ticks" }).fill("6");
      await appearance.getByRole("button", { name: "Apply" }).click();
      const optionSource = vertexSource.replace("ticks 7", "ticks 6");
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(optionSource);
      await mermaidBlock.getByText("Visual", { exact: true }).click();

      const dataToggle = mermaidBlock.getByRole("button", { name: "Data" });
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toBeVisible();
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toHaveCount(0);

      await page.reload();
      await expect(
        page.getByText("Loading document content, please wait a moment."),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(valueFive).toBeVisible({ timeout: 30_000 });
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toHaveCount(0);

      await mermaidBlock.getByText("View", { exact: true }).click();
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Current profile.*Delivery velocity.*: 5\./,
        }),
      ).toBeVisible();
      await expect(
        mermaidBlock.getByRole("button", { name: "Add axis" }),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.getByRole("button", { name: "Data" }),
      ).toHaveCount(0);

      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless(?:$|&)/, {
        timeout: 20_000,
      });
      const embeddedHost = page.locator("myoxus-mermaid").first();
      const embeddedNote = page.locator("myoxus-edgeless-note").filter({
        has: embeddedHost,
      });
      const embeddedActions = embeddedHost.locator(
        '[data-myoxus-ui-role="mermaid-embedded-actions"]',
      );
      await expect(embeddedActions).toHaveCount(0);
      await embeddedNote.dblclick();
      await expect(
        embeddedNote.locator('[data-testid="edgeless-note-container"]'),
      ).toHaveAttribute("data-editing", "true");
      await embeddedHost.getByTestId("data-radar-chart").click();
      await expect(embeddedActions).toBeVisible({ timeout: 10_000 });

      const embeddedValueFive = embeddedHost.getByRole("button", {
        name: /Current profile.*Delivery velocity.*: 5\./,
      });
      const embeddedBefore = await radarVertexHitTarget(embeddedValueFive);
      await page.mouse.move(embeddedBefore.x, embeddedBefore.y);
      await page.mouse.down();
      await page.mouse.move(embeddedBefore.x, embeddedBefore.y - 30, {
        steps: 6,
      });
      const embeddedPreview = embeddedHost.getByRole("button", {
        name: /Current profile.*Delivery velocity.*: [6-9]\./,
      });
      await expect(embeddedPreview).toBeVisible();
      const embeddedPreviewTarget = await radarVertexHitTarget(embeddedPreview);
      expect(embeddedPreviewTarget.y).toBeLessThan(embeddedBefore.y - 5);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(embeddedValueFive).toBeVisible();
      await expect(
        embeddedNote.locator('[data-testid="edgeless-note-container"]'),
      ).toHaveAttribute("data-editing", "true");
      await expect(embeddedActions).toBeVisible();
      await expect(
        embeddedHost.getByText(
          "The Radar change is not valid for the current source.",
        ),
      ).toHaveCount(0);

      await embeddedValueFive.press("ArrowUp");
      await expect(
        embeddedHost.getByRole("button", {
          name: /Current profile.*Delivery velocity.*: 6\./,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(embeddedValueFive).toBeVisible();
      await expect(embeddedActions).toBeVisible();

      await embeddedActions.getByRole("button", { name: "Data" }).click();
      await expect(
        embeddedHost.getByRole("table", { name: "Data" }),
      ).toBeVisible();
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(embeddedHost)).source,
        )
        .toBe(optionSource);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Treemap keeps hierarchy edits, exact source, history, and embedded Edgeless operation in one journey", async ({
    context,
    page,
    request,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text)))
        runtimeErrors.push(`console: ${text}`);
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
      await page.getByTestId("slash-menu-item-mermaid-treemap-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, MERMAID_TREEMAP_SOURCE);
      await mermaidBlock.getByText("Visual", { exact: true }).click();

      const chart = mermaidBlock.getByTestId("data-treemap-chart");
      const sales = chart.getByRole("button", { name: "Sales, 70" });
      const enterprise30 = chart.getByRole("button", {
        name: "Enterprise, 30",
      });
      await expect(sales).toBeVisible({ timeout: 10_000 });
      await sales.locator(".myoxus-data-treemap-label").click();
      await expect(sales).toHaveAttribute("aria-pressed", "true");
      await enterprise30.click();
      await expect(enterprise30).toHaveAttribute("aria-pressed", "true");

      await enterprise30.dblclick();
      const labelEditor = mermaidBlock.getByRole("textbox", {
        name: "Node label",
      });
      await labelEditor.fill("Growth");
      await mermaidBlock.getByRole("button", { name: "Apply" }).click();
      const growth30 = chart.getByRole("button", { name: "Growth, 30" });
      await expect(growth30).toBeVisible();

      await growth30.locator(".myoxus-data-treemap-value").click();
      const valueEditor = mermaidBlock.getByRole("textbox", { name: "Value" });
      await valueEditor.fill("35");
      await mermaidBlock.getByRole("button", { name: "Apply" }).click();
      const growth35 = chart.getByRole("button", { name: "Growth, 35" });
      await expect(growth35).toBeVisible();

      await mermaidBlock.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("button", { name: "Move", exact: true }).click();
      const moveDialog = page.getByRole("dialog", { name: "Move" });
      await moveDialog.getByRole("combobox", { name: "Parent" }).click();
      await page.getByRole("option", { name: "Research" }).click();
      await moveDialog.getByRole("button", { name: "Move" }).click();
      await expect(
        chart.getByRole("button", { name: "Research, 41" }),
      ).toBeVisible();

      await mermaidBlock.getByRole("button", { name: "Data" }).click();
      const dataTree = mermaidBlock.locator(
        '[data-myoxus-ui-role="data-tree"]',
      );
      await expect(dataTree).toBeVisible();
      const growthRow = dataTree.locator(
        '[data-chart-item-id]:has([title="Growth"])',
      );
      await growthRow
        .getByRole("button", { name: "Move" })
        .press("Alt+ArrowUp");

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /  "Research"\n\n    %% Account plan\n    "Growth": 35:::warm\n    "Experiment": 6/,
      );
      await expect(sourceEditor).toHaveValue(
        /classDef warm fill:#c95f4f,color:#fff;\nclassDef warm stroke:#722,border-width:2px;/,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(
        /  "Research"\n    "Experiment": 6\n\n    %% Account plan\n    "Growth": 35:::warm/,
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();

      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless(?:$|&)/, {
        timeout: 20_000,
      });
      const embeddedHost = page.locator("myoxus-mermaid").first();
      const embeddedNote = page.locator("myoxus-edgeless-note").filter({
        has: embeddedHost,
      });
      const embeddedActions = embeddedHost.locator(
        '[data-myoxus-ui-role="mermaid-embedded-actions"]',
      );
      await expect(embeddedActions).toHaveCount(0);
      await embeddedNote.dblclick();
      await expect(
        embeddedNote.locator('[data-testid="edgeless-note-container"]'),
      ).toHaveAttribute("data-editing", "true");
      await embeddedHost.getByTestId("data-treemap-chart").click();
      await expect(embeddedActions).toBeVisible({ timeout: 10_000 });
      await expect(
        embeddedHost.getByText("Source", { exact: true }),
      ).toHaveCount(0);

      const embeddedChart = embeddedHost.getByTestId("data-treemap-chart");
      const embeddedResearch = embeddedChart.getByRole("button", {
        name: "Research, 41",
      });
      const embeddedGrowth35 = embeddedChart.getByRole("button", {
        name: "Growth, 35",
      });
      const embeddedSales40 = embeddedChart.getByRole("button", {
        name: "Sales, 40",
      });
      const growthNodeId =
        await embeddedGrowth35.getAttribute("data-chart-node-id");
      const salesNodeId =
        await embeddedSales40.getAttribute("data-chart-node-id");
      expect(growthNodeId).toBeTruthy();
      expect(salesNodeId).toBeTruthy();
      await embeddedResearch.locator(".myoxus-data-treemap-label").click();
      await expect(embeddedResearch).toHaveAttribute("aria-pressed", "true");
      await embeddedGrowth35.click();
      await embeddedGrowth35.press("F2");
      const embeddedLabel = embeddedHost.getByRole("textbox", {
        name: "Node label",
      });
      await embeddedLabel.fill("Growth plan");
      await embeddedHost.getByRole("button", { name: "Apply" }).click();
      const embeddedGrowthPlan35 = embeddedChart.getByRole("button", {
        name: "Growth plan, 35",
      });
      await embeddedGrowthPlan35.locator(".myoxus-data-treemap-value").click();
      await embeddedHost.getByRole("textbox", { name: "Value" }).fill("36");
      await embeddedHost.getByRole("button", { name: "Apply" }).click();

      await embeddedActions
        .getByRole("button", { name: "More actions" })
        .click();
      await page.getByRole("button", { name: "Move", exact: true }).click();
      const embeddedMoveDialog = page.getByRole("dialog", { name: "Move" });
      await embeddedMoveDialog
        .getByRole("combobox", { name: "Parent" })
        .click();
      await page.getByRole("option", { name: "Sales" }).click();
      await embeddedMoveDialog.getByRole("button", { name: "Move" }).click();
      const embeddedGrowthPlan36 = embeddedChart.getByRole("button", {
        name: "Growth plan, 36",
      });
      await expect(embeddedGrowthPlan36).toHaveAttribute(
        "data-chart-node-id",
        growthNodeId!,
      );
      await expect(
        embeddedChart.getByRole("button", { name: "Sales, 76" }),
      ).toHaveAttribute("data-chart-node-id", salesNodeId!);

      await embeddedActions.getByRole("button", { name: "Data" }).click();
      const embeddedDataDrawer = page.locator(
        '[data-myoxus-ui-role="workbench-context-panel-drawer"]',
      );
      const embeddedDataTree = embeddedDataDrawer.locator(
        '[data-myoxus-ui-role="data-tree"]',
      );
      await expect(embeddedDataTree).toBeVisible();
      const embeddedSalesRow = embeddedDataTree.locator(
        `[data-chart-item-id="${salesNodeId}"]`,
      );
      await embeddedSalesRow.locator("..").press("ArrowRight");
      const embeddedGrowthRow = embeddedDataTree.locator(
        `[data-chart-item-id="${growthNodeId}"]`,
      );
      await expect(embeddedGrowthRow).toBeVisible();
      await embeddedGrowthRow
        .locator(".myoxus-drag-handle")
        .press("Alt+ArrowUp");

      await embeddedDataDrawer.getByRole("button", { name: "Close" }).click();
      await expect(embeddedDataDrawer).toBeHidden();
      await embeddedHost.press("Control+z");
      await expect
        .poll(async () => (await mermaidOwnerInventory(page))[0]?.source)
        .toContain(
          '  "Sales"\n    "Enterprise": 40:::warm\n\n    %% Account plan\n    "Growth plan": 36:::warm',
        );
      await embeddedHost.press("Control+Shift+z");
      await expect
        .poll(async () => (await mermaidOwnerInventory(page))[0]?.source)
        .toContain(
          '  "Sales"\n\n    %% Account plan\n    "Growth plan": 36:::warm\n    "Enterprise": 40:::warm',
        );
      await page.reload();
      await expect(
        page.getByText("Loading document content, please wait a moment."),
      ).toHaveCount(0, { timeout: 30_000 });
      const reloadedDiagram = page.getByRole("region", {
        name: "Portfolio allocation",
      });
      await expect(reloadedDiagram).toBeVisible({ timeout: 30_000 });
      await expect(reloadedDiagram).toContainText(/Growth plan.*36/);

      const [owner] = await mermaidOwnerInventory(page);
      expect(owner).toBeDefined();
      expect(owner!.source).toContain(
        '  "Sales"\n\n    %% Account plan\n    "Growth plan": 36:::warm\n    "Enterprise": 40:::warm',
      );
      expect(owner!.source).toContain(
        "classDef warm fill:#c95f4f,color:#fff;\nclassDef warm stroke:#722,border-width:2px;",
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Quadrant keeps point input, source, history, data, View, and reload in one Page journey", async ({
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
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(
        sourceEditor,
        [
          "quadrantChart",
          "  x-axis Low impact --> High impact",
          "  y-axis Low effort -->",
          "  quadrant-1 Strategic bets",
          "  quadrant-2 Quick wins",
          "  quadrant-3 Defer",
          "  quadrant-4 Maintenance",
          "  Migration: [0.51, 0.5]",
        ].join("\n"),
      );
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect(mermaidBlock.getByTestId("data-scatter-chart")).toBeVisible({
        timeout: 10_000,
      });

      const point = mermaidBlock.getByRole("button", {
        name: /Migration, X 0\.51, Y 0\.5/,
      });
      await point.click();
      await expect(point).toHaveAttribute("aria-pressed", "true");
      await point.press("ArrowRight");
      await point.press("Enter");
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Migration, X 0\.52, Y 0\.5/,
        }),
      ).toBeVisible();

      const dataToggle = mermaidBlock.getByRole("button", { name: "Data" });
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toBeVisible();
      await dataToggle.click();
      await expect(
        mermaidBlock.getByRole("table", { name: "Data" }),
      ).toHaveCount(0);

      await mermaidBlock.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(/Migration:\s*\[0\.52, 0\.5\]/);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Migration, X 0\.51, Y 0\.5/,
        }),
      ).toBeVisible();
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Migration, X 0\.52, Y 0\.5/,
        }),
      ).toBeVisible();

      await page.reload();
      await expect(
        page.getByText("Loading document content, please wait a moment."),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(mermaidBlock.getByTestId("data-scatter-chart")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        mermaidBlock.getByRole("button", {
          name: /Migration, X 0\.52, Y 0\.5/,
        }),
      ).toBeVisible();

      await mermaidBlock.getByText("View", { exact: true }).click();
      await expect(
        mermaidBlock.getByTestId("data-scatter-chart"),
      ).toBeVisible();
      await expect(
        mermaidBlock.getByRole("button", { name: "Add point" }),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.getByRole("button", { name: "Data" }),
      ).toHaveCount(0);
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Page keeps one zoom and scroll owner across fixed, centered, and Auto navigation", async ({
    context,
    page,
    request,
  }, testInfo) => {
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
    const flowchartImportPath = testInfo.outputPath("phase-3d-flowchart.mmd");
    const pieImportPath = testInfo.outputPath("phase-3d-pie.mmd");
    const invalidImportPath = testInfo.outputPath("phase-3d-invalid.mmd");
    try {
      await page.setViewportSize({ width: 1100, height: 500 });
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-flowchart-basic").click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await mermaidBlock.getByText("Source", { exact: true }).click();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const source = MERMAID_PAGE_VIEWPORT_FLOWCHART_FIXTURE.source;
      await writeMermaidSource(sourceEditor, source);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expectMermaidGfxVisualModel(mermaidBlock, {
        diagramType: "flowchart",
        minEdges: 15,
        minNodes: 16,
      });

      const scrollViewport = mermaidBlock
        .locator(
          '[data-myoxus-ui-role="mermaid-page-scroll-viewport"] .mantine-ScrollArea-viewport',
        )
        .first();
      await expect(scrollViewport).toBeVisible({ timeout: 10_000 });
      await selectFacadeOption(page, mermaidBlock, "Diagram zoom", "150%");
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("150%");

      const viewportMetrics = () =>
        scrollViewport.evaluate((element) => ({
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight,
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop,
          scrollWidth: element.scrollWidth,
        }));
      await expect
        .poll(async () => {
          const metrics = await viewportMetrics();
          return metrics.scrollWidth - metrics.clientWidth;
        })
        .toBeGreaterThan(40);

      await scrollViewport.evaluate((element) => element.scrollTo(0, 0));
      const viewportBox = await scrollViewport.boundingBox();
      expect(viewportBox).toBeTruthy();
      const browserViewport = page.viewportSize();
      expect(browserViewport).toBeTruthy();
      const wheelPoint = {
        x: Math.min(
          viewportBox!.x + viewportBox!.width / 2,
          browserViewport!.width - 8,
        ),
        y: Math.min(
          viewportBox!.y + viewportBox!.height / 2,
          browserViewport!.height - 8,
        ),
      };
      expect(wheelPoint.x).toBeGreaterThan(viewportBox!.x);
      expect(wheelPoint.y).toBeGreaterThan(viewportBox!.y);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.wheel(220, 180);
      await expect
        .poll(async () => {
          const metrics = await viewportMetrics();
          return metrics.scrollLeft > 0;
        })
        .toBe(true);
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("150%");

      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 120);
      await page.keyboard.up("Control");
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("140%");
      await mermaidBlock.focus();
      await page.keyboard.press("ControlOrMeta+Equal");
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("150%");

      await scrollViewport.evaluate((element) =>
        element.scrollTo(element.scrollWidth, element.scrollHeight),
      );
      await expect
        .poll(async () => {
          const metrics = await viewportMetrics();
          return Math.abs(
            metrics.scrollLeft - (metrics.scrollWidth - metrics.clientWidth),
          );
        })
        .toBeLessThan(2);
      const farNode = await flowchartNodePoint(mermaidBlock, "Done5");
      const gfxViewportBox = await mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first()
        .boundingBox();
      expect(gfxViewportBox).toBeTruthy();
      expect(farNode.x).toBeGreaterThan(0);
      expect(farNode.x).toBeLessThan(gfxViewportBox!.width);

      const parentScrollBefore = await scrollViewport.evaluate((element) => {
        let parent = element.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          if (
            parent.scrollHeight > parent.clientHeight + 1 &&
            /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
          ) {
            if (parent.scrollTop >= parent.scrollHeight - parent.clientHeight) {
              parent.scrollTop = Math.max(0, parent.scrollTop - 120);
            }
            return parent.scrollTop;
          }
          parent = parent.parentElement;
        }
        throw new Error("Missing scrollable document ancestor");
      });
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.wheel(0, 240);
      await expect
        .poll(() =>
          scrollViewport.evaluate((element) => {
            let parent = element.parentElement;
            while (parent) {
              const style = getComputedStyle(parent);
              if (
                parent.scrollHeight > parent.clientHeight + 1 &&
                /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
              ) {
                return parent.scrollTop;
              }
              parent = parent.parentElement;
            }
            return -1;
          }),
        )
        .toBeGreaterThan(parentScrollBefore);

      const sourceBeforeCenter = (await mermaidVisualModelSummary(mermaidBlock))
        .source;
      await mermaidBlock
        .getByRole("button", { name: "Center diagram" })
        .click();
      const centeredViewportBox = await mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first()
        .boundingBox();
      expect(centeredViewportBox).toBeTruthy();
      const centeredNodeBoxes = await Promise.all(
        (await flowchartNodeIds(mermaidBlock)).map((nodeId) =>
          flowchartNodeViewBox(mermaidBlock, nodeId),
        ),
      );
      const centeredContent = {
        bottom: Math.max(...centeredNodeBoxes.map((box) => box.y + box.height)),
        left: Math.min(...centeredNodeBoxes.map((box) => box.x)),
        right: Math.max(...centeredNodeBoxes.map((box) => box.x + box.width)),
        top: Math.min(...centeredNodeBoxes.map((box) => box.y)),
      };
      expect(
        Math.abs(
          (centeredContent.left + centeredContent.right) / 2 -
            centeredViewportBox!.width / 2,
        ),
      ).toBeLessThan(centeredViewportBox!.width * 0.08);
      expect(
        Math.abs(
          (centeredContent.top + centeredContent.bottom) / 2 -
            centeredViewportBox!.height / 2,
        ),
      ).toBeLessThan(centeredViewportBox!.height * 0.12);
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("150%");
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );

      const fixedOverflow = await viewportMetrics().then((metrics) => ({
        x: metrics.scrollWidth - metrics.clientWidth,
        y: metrics.scrollHeight - metrics.clientHeight,
      }));
      await selectFacadeOption(page, mermaidBlock, "Diagram zoom", "Auto");
      await expect(
        mermaidBlock.getByRole("combobox", { name: "Diagram zoom" }),
      ).toHaveValue("Auto");
      await expect
        .poll(async () => {
          const metrics = await viewportMetrics();
          const overflowX = metrics.scrollWidth - metrics.clientWidth;
          const overflowY = metrics.scrollHeight - metrics.clientHeight;
          return (
            overflowX < fixedOverflow.x &&
            overflowY < fixedOverflow.y &&
            metrics.scrollLeft >= 0 &&
            metrics.scrollLeft <= overflowX + 1 &&
            metrics.scrollTop >= 0 &&
            metrics.scrollTop <= overflowY + 1
          );
        })
        .toBe(true);
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );

      await selectFacadeOption(page, mermaidBlock, "Diagram zoom", "150%");
      const diagramToolbar = mermaidBlock.getByRole("toolbar", {
        name: "Mermaid diagram controls",
      });
      await diagramToolbar
        .getByRole("button", { exact: true, name: "Center diagram" })
        .click();
      const addGroupButton = diagramToolbar.getByRole("button", {
        exact: true,
        name: "Add group",
      });
      await expect(addGroupButton).toBeDisabled();
      const groupBase = await mermaidBlock.evaluate((element) => {
        const block = element as unknown as {
          _getMermaidVisualModelForEditing?: () => {
            edges: Array<{ source: string; target: string }>;
            nodes: Array<{ id: string; label: string }>;
          } | null;
        };
        const visualModel = block._getMermaidVisualModelForEditing?.();
        if (!visualModel) {
          throw new Error("Centered Flowchart model is unavailable");
        }
        const base = visualModel.nodes.find((node) => node.label === "Plan");
        if (!base)
          throw new Error("Flowchart grouping base node is unavailable");
        return base;
      });
      await mermaidBlock
        .getByRole("button", { exact: true, name: groupBase.label })
        .focus();
      await page.keyboard.press("Space");
      await expect(addGroupButton).toBeDisabled();
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const visualCanvas = mermaidBlock
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      await mermaidBlock.focus();
      await page.keyboard.press("Escape");
      await diagramToolbar
        .getByRole("radio", { exact: true, name: "Selection box" })
        .click();
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const groupCandidate = await mermaidBlock.evaluate((element, baseId) => {
        const block = element as unknown as {
          _getMermaidVisualModelForEditing?: () => {
            edges: Array<{ source: string; target: string }>;
            nodes: Array<{ id: string; label: string }>;
          } | null;
          _getVisualNodeGfxModel?: (id: string) => { xywh?: string } | null;
          _gfxViewportBridge?: {
            getModelViewRect?: (xywh: string) => {
              height: number;
              left: number;
              top: number;
              width: number;
            } | null;
          };
          querySelector: Element["querySelector"];
        };
        const visualModel = block._getMermaidVisualModelForEditing?.();
        const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
        if (!visualModel || !(viewport instanceof HTMLElement)) {
          throw new Error("Flowchart selection owner is not measurable");
        }
        const candidate = visualModel.nodes
          .filter(({ id }) => id !== baseId)
          .flatMap((node) => {
            const xywh = block._getVisualNodeGfxModel?.(node.id)?.xywh;
            const rect = xywh
              ? block._gfxViewportBridge?.getModelViewRect?.(xywh)
              : null;
            if (
              !rect ||
              rect.left < 16 ||
              rect.top < 16 ||
              rect.left + rect.width > viewport.clientWidth - 16 ||
              rect.top + rect.height > viewport.clientHeight - 16
            ) {
              return [];
            }
            const clearance = Math.min(
              rect.left,
              rect.top,
              viewport.clientWidth - rect.left - rect.width,
              viewport.clientHeight - rect.top - rect.height,
            );
            return [{ node, rect, clearance }];
          })
          .sort((left, right) => right.clearance - left.clearance)[0];
        if (!candidate) {
          throw new Error("Flowchart lacks a fully visible selection target");
        }
        const selectedIds = new Set([baseId, candidate.node.id]);
        return {
          candidate: candidate.node,
          internalEdgeCount: visualModel.edges.filter(
            (edge) =>
              selectedIds.has(edge.source) && selectedIds.has(edge.target),
          ).length,
          rect: {
            height: candidate.rect.height,
            width: candidate.rect.width,
            x: candidate.rect.left,
            y: candidate.rect.top,
          },
        };
      }, groupBase.id);
      const groupPair = {
        base: groupBase,
        candidate: groupCandidate.candidate,
        internalEdgeCount: groupCandidate.internalEdgeCount,
      };
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );
      const candidateBox = groupCandidate.rect;
      const visualCanvasBox = await visualCanvas.boundingBox();
      if (!visualCanvasBox)
        throw new Error("Flowchart canvas is not measurable");
      await dragWithinLocator(
        page,
        visualCanvas,
        {
          x: Math.max(1, candidateBox.x - 12),
          y: Math.max(1, candidateBox.y - 12),
        },
        {
          x: Math.min(
            visualCanvasBox.width - 1,
            candidateBox.x + candidateBox.width + 12,
          ),
          y: Math.min(
            visualCanvasBox.height - 1,
            candidateBox.y + candidateBox.height + 12,
          ),
        },
      );
      const selectedNodeOutlines = mermaidBlock.locator(
        '.myoxus-mermaid-gfx-selection-outline[data-selection-kind="node"]',
      );
      await expect(selectedNodeOutlines).toHaveCount(1);
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );
      expect(
        await selectedNodeOutlines.first().getAttribute("data-selection-id"),
      ).toBe(groupPair.candidate.id);
      await mermaidBlock
        .getByRole("button", { exact: true, name: groupPair.base.label })
        .focus();
      await page.keyboard.press("Space");
      await expect(selectedNodeOutlines).toHaveCount(2);
      expect(
        await selectedNodeOutlines.evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("data-selection-id") ?? "")
            .sort(),
        ),
      ).toEqual([groupPair.base.id, groupPair.candidate.id].sort());
      await expect(
        diagramToolbar.getByRole("button", {
          name: /^Delete diagram objects \(\d+\)$/,
        }),
      ).toBeEnabled();
      await expect(addGroupButton).toBeEnabled();
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        sourceBeforeCenter,
      );

      await addGroupButton.click();
      const createdGroupTitle = mermaidBlock.getByLabel("Selected group title");
      await expect(createdGroupTitle).toBeFocused();
      await expect(createdGroupTitle).toHaveValue(/^Group \d+$/);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      const groupedSource = await sourceEditor.inputValue();
      expect(groupedSource).toContain("subgraph");
      expect(groupedSource).toContain(groupPair.base.label);
      expect(groupedSource).toContain(groupPair.candidate.label);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const undoButton = diagramToolbar.getByRole("button", {
        exact: true,
        name: "Undo",
      });
      const redoButton = diagramToolbar.getByRole("button", {
        exact: true,
        name: "Redo",
      });
      await expect(undoButton).toBeEnabled();
      await undoButton.click();
      await expect
        .poll(() =>
          mermaidVisualModelSummary(mermaidBlock).then(({ source }) => source),
        )
        .not.toContain("subgraph");
      const canonicalSource = (await mermaidVisualModelSummary(mermaidBlock))
        .source;
      await expect(redoButton).toBeEnabled();
      await redoButton.click();
      await expect
        .poll(() =>
          mermaidVisualModelSummary(mermaidBlock).then(({ source }) => source),
        )
        .toBe(groupedSource);
      await expect(undoButton).toBeEnabled();
      await undoButton.click();
      await expect
        .poll(() =>
          mermaidVisualModelSummary(mermaidBlock).then(({ source }) => source),
        )
        .toBe(canonicalSource);
      await diagramToolbar
        .getByRole("radio", { exact: true, name: "Pointer" })
        .click();
      await mermaidBlock.focus();
      await page.keyboard.press("Escape");
      await expect(selectedNodeOutlines).toHaveCount(0);
      await mermaidBlock
        .getByRole("button", { exact: true, name: groupPair.base.label })
        .focus();
      await page.keyboard.press("Space");
      await mermaidBlock
        .getByRole("button", { exact: true, name: groupPair.candidate.label })
        .focus();
      await page.keyboard.press("Space");
      await expect(selectedNodeOutlines).toHaveCount(2);
      expect(
        await selectedNodeOutlines.evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("data-selection-id") ?? "")
            .sort(),
        ),
      ).toEqual([groupPair.base.id, groupPair.candidate.id].sort());
      // Keyboard selection makes its anchor visible on the next animation
      // frame. Measure the drag point only after that owning viewport update.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const baseBeforeDrag = await flowchartNodeModelPoint(
        mermaidBlock,
        groupPair.base.id,
      );
      const candidateBeforeDrag = await flowchartNodeModelPoint(
        mermaidBlock,
        groupPair.candidate.id,
      );
      const basePoint = await flowchartNodePoint(
        mermaidBlock,
        groupPair.base.id,
      );
      await dragWithinLocator(page, visualCanvas, basePoint, {
        x: basePoint.x + 24,
        y: basePoint.y + 12,
      });
      await expect
        .poll(async () => {
          const baseAfterDrag = await flowchartNodeModelPoint(
            mermaidBlock,
            groupPair.base.id,
          );
          const candidateAfterDrag = await flowchartNodeModelPoint(
            mermaidBlock,
            groupPair.candidate.id,
          );
          const baseDelta = {
            x: baseAfterDrag.x - baseBeforeDrag.x,
            y: baseAfterDrag.y - baseBeforeDrag.y,
          };
          const candidateDelta = {
            x: candidateAfterDrag.x - candidateBeforeDrag.x,
            y: candidateAfterDrag.y - candidateBeforeDrag.y,
          };
          return (
            Math.hypot(baseDelta.x, baseDelta.y) > 4 &&
            Math.abs(baseDelta.x - candidateDelta.x) < 1 &&
            Math.abs(baseDelta.y - candidateDelta.y) < 1
          );
        })
        .toBe(true);
      await mermaidBlock.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(() => mermaidVisualModelSummary(mermaidBlock))
        .toMatchObject({ edgeCount: 15, nodeCount: 16 });
      await expect
        .poll(async () => {
          const base = await flowchartNodeModelPoint(
            mermaidBlock,
            groupPair.base.id,
          );
          const candidate = await flowchartNodeModelPoint(
            mermaidBlock,
            groupPair.candidate.id,
          );
          return (
            Math.abs(base.x - baseBeforeDrag.x) < 1 &&
            Math.abs(base.y - baseBeforeDrag.y) < 1 &&
            Math.abs(candidate.x - candidateBeforeDrag.x) < 1 &&
            Math.abs(candidate.y - candidateBeforeDrag.y) < 1
          );
        })
        .toBe(true);
      expect((await mermaidVisualModelSummary(mermaidBlock)).source).toBe(
        canonicalSource,
      );

      await expect(selectedNodeOutlines).toHaveCount(2);
      await visualCanvas.focus();
      await page.keyboard.press("ControlOrMeta+D");
      await expect
        .poll(() => mermaidVisualModelSummary(mermaidBlock))
        .toMatchObject({
          edgeCount: 15 + groupPair.internalEdgeCount,
          nodeCount: 18,
        });
      await mermaidBlock.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(() => mermaidVisualModelSummary(mermaidBlock))
        .toMatchObject({
          edgeCount: 15,
          nodeCount: 16,
          source: canonicalSource,
        });

      await mermaidBlock.focus();
      await page.keyboard.press("Escape");
      await expect(selectedNodeOutlines).toHaveCount(0);
      await mermaidBlock
        .getByRole("button", { exact: true, name: "Plan" })
        .focus();
      await page.keyboard.press("Space");
      await mermaidBlock
        .getByRole("button", { exact: true, name: "Build" })
        .focus();
      await page.keyboard.press("Space");
      await expect(selectedNodeOutlines).toHaveCount(2);
      await page.keyboard.press("ControlOrMeta+D");
      await expect
        .poll(() => mermaidVisualModelSummary(mermaidBlock))
        .toMatchObject({ edgeCount: 16, nodeCount: 18 });
      await mermaidBlock.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(() => mermaidVisualModelSummary(mermaidBlock))
        .toMatchObject({
          edgeCount: 15,
          nodeCount: 16,
          source: canonicalSource,
        });

      const architectureFixture = requiredMermaidFixture(
        MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
        "architecture",
      );
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, architectureFixture.source);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expectMermaidGfxVisualModel(mermaidBlock, {
        diagramType: "architecture",
        minEdges: architectureFixture.minEdges,
        minNodes: architectureFixture.minNodes,
        minSubgraphs: architectureFixture.minSubgraphs,
      });
      await visualCanvas.evaluate((element) =>
        element.scrollIntoView({ block: "start", inline: "nearest" }),
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const architectureNodeId = (await flowchartNodeIds(mermaidBlock))[0];
      if (!architectureNodeId) {
        throw new Error("Architecture drag target is unavailable");
      }
      const architectureNodeBeforeDrag = await flowchartNodeModelPoint(
        mermaidBlock,
        architectureNodeId,
      );
      const architectureNodeDragPoint = await flowchartNodePoint(
        mermaidBlock,
        architectureNodeId,
      );
      const architectureCanvasBox = await visualCanvas.boundingBox();
      if (!architectureCanvasBox) {
        throw new Error("Architecture canvas is not measurable");
      }
      await page.mouse.move(
        architectureCanvasBox.x + architectureNodeDragPoint.x,
        architectureCanvasBox.y + architectureNodeDragPoint.y,
      );
      await page.mouse.down();
      await expect
        .poll(() =>
          mermaidBlock.evaluate(
            (element) =>
              (
                element as unknown as {
                  _gfxViewportInteraction?: { _dragNodeId?: string };
                }
              )._gfxViewportInteraction?._dragNodeId ?? "",
          ),
        )
        .toBe(architectureNodeId);
      await page.mouse.move(
        architectureCanvasBox.x + architectureNodeDragPoint.x + 24,
        architectureCanvasBox.y + architectureNodeDragPoint.y + 12,
        { steps: 5 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => {
          const point = await flowchartNodeModelPoint(
            mermaidBlock,
            architectureNodeId,
          );
          return Math.hypot(
            point.x - architectureNodeBeforeDrag.x,
            point.y - architectureNodeBeforeDrag.y,
          );
        })
        .toBeGreaterThan(4);
      const architectureNodeAfterDrag = await flowchartNodeModelPoint(
        mermaidBlock,
        architectureNodeId,
      );
      await page.waitForTimeout(500);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const architectureNodeAfterSource = await flowchartNodeModelPoint(
        mermaidBlock,
        architectureNodeId,
      );
      expect(
        Math.hypot(
          architectureNodeAfterSource.x - architectureNodeAfterDrag.x,
          architectureNodeAfterSource.y - architectureNodeAfterDrag.y,
        ),
      ).toBeLessThan(1);
      await mermaidBlock.getByText("View", { exact: true }).click();
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      const architectureNodeAfterView = await flowchartNodeModelPoint(
        mermaidBlock,
        architectureNodeId,
      );
      expect(
        Math.hypot(
          architectureNodeAfterView.x - architectureNodeAfterDrag.x,
          architectureNodeAfterView.y - architectureNodeAfterDrag.y,
        ),
      ).toBeLessThan(1);

      const flowchartFixture = await readFile(
        path.join(
          process.cwd(),
          "todo/assets/mermaid-phase-3d-owner-fixture-20260825.mmd",
        ),
        "utf8",
      );
      const pieFixture = await readFile(
        path.join(
          process.cwd(),
          "todo/assets/mermaid-phase-3d-pie-fixture-20260826.mmd",
        ),
        "utf8",
      );
      await writeFile(flowchartImportPath, flowchartFixture, "utf8");
      await writeFile(pieImportPath, pieFixture, "utf8");
      await writeFile(invalidImportPath, "flowchart TD\n  A[broken", "utf8");

      await mermaidBlock.focus();
      await page.keyboard.press("Escape");
      await expect(selectedNodeOutlines).toHaveCount(0);
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, flowchartFixture);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(async () =>
          (await mermaidVisualModelSummary(mermaidBlock)).source.trimEnd(),
        )
        .toBe(flowchartFixture.trimEnd());
      const embeddedActionsSource = `---
title: Release approval
---
flowchart LR
  subgraph release ["Release pipeline"]
    build[Build artifact] edge-build-review-1@--> review{Approved?}
    review{Approved?} edge-review-deploy-2@--> |yes| deploy([Deploy production])
    review{Approved?} edge-review-fix-3@--> |no| fix([Fix findings])
  end`;
      await mermaidBlock.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, embeddedActionsSource);
      await mermaidBlock.getByText("Visual", { exact: true }).click();
      await expect
        .poll(async () =>
          (await mermaidVisualModelSummary(mermaidBlock)).source.trimEnd(),
        )
        .toBe(embeddedActionsSource.trimEnd());
      const embeddedBlockId = await mermaidBlock.evaluate(
        (element) =>
          (element as unknown as { model?: { id?: string } }).model?.id ?? "",
      );
      const embeddedPageOwner = (await mermaidOwnerInventory(page)).find(
        ({ id }) => id === embeddedBlockId,
      );
      expect(embeddedPageOwner).toBeDefined();
      expect(embeddedPageOwner!.parentFlavor).toBe("myoxus:note");
      const legacyFrameId = await seedLegacyLinkedMermaidOwner(
        page,
        embeddedBlockId,
      );

      await page.setViewportSize({ width: 1280, height: 720 });
      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect(page).toHaveURL(/\?mode=edgeless(?:$|&)/, {
        timeout: 20_000,
      });
      await expect(
        page.getByRole("button", { name: "Fold page block" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open in Page" }),
      ).toBeVisible();
      const embeddedEdgelessOwner = (await mermaidOwnerInventory(page)).find(
        ({ id }) => id === embeddedBlockId,
      );
      expect(embeddedEdgelessOwner).toEqual(embeddedPageOwner);
      await expect.poll(() => hasBlock(page, legacyFrameId)).toBe(false);
      expectContainedBounds(embeddedEdgelessOwner!);
      const embeddedHost = page.locator(
        `myoxus-edgeless-note myoxus-mermaid[data-block-id="${embeddedBlockId}"]`,
      );
      await expect(embeddedHost).toHaveCount(1);
      await expect(
        embeddedHost.getByText("Source", { exact: true }),
      ).toHaveCount(0);
      await expect(
        embeddedHost.getByText("Visual", { exact: true }),
      ).toHaveCount(0);
      await expect(embeddedHost.getByText("View", { exact: true })).toHaveCount(
        0,
      );

      const embeddedCoordinateRoundtrip = await embeddedHost.evaluate(
        (element) => {
          const block = element as unknown as {
            _getVisualNodeGfxModel?: (id: string) => { xywh?: string } | null;
            _gfxViewportBridge?: {
              getModelPointFromClient?: (
                clientX: number,
                clientY: number,
              ) => { x: number; y: number } | null;
              getModelViewRect?: (xywh: string) => {
                height: number;
                left: number;
                top: number;
                width: number;
              } | null;
            };
            querySelector: Element["querySelector"];
          };
          const node = block._getVisualNodeGfxModel?.("review");
          const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
          const viewportRect = viewport?.getBoundingClientRect();
          const viewportWidth =
            viewport instanceof HTMLElement ? viewport.offsetWidth : 0;
          const viewportHeight =
            viewport instanceof HTMLElement ? viewport.offsetHeight : 0;
          const viewRect = node?.xywh
            ? block._gfxViewportBridge?.getModelViewRect?.(node.xywh)
            : null;
          if (
            !node?.xywh ||
            !viewportRect ||
            !viewportWidth ||
            !viewportHeight ||
            !viewRect
          ) {
            return null;
          }
          const [x, y, width, height] = JSON.parse(node.xywh) as [
            number,
            number,
            number,
            number,
          ];
          const modelPoint =
            block._gfxViewportBridge?.getModelPointFromClient?.(
              viewportRect.left +
                (viewRect.left + viewRect.width / 2) *
                  (viewportRect.width / viewportWidth),
              viewportRect.top +
                (viewRect.top + viewRect.height / 2) *
                  (viewportRect.height / viewportHeight),
            );
          return modelPoint
            ? Math.hypot(
                modelPoint.x - (x + width / 2),
                modelPoint.y - (y + height / 2),
              )
            : null;
        },
      );
      expect(embeddedCoordinateRoundtrip).not.toBeNull();
      expect(embeddedCoordinateRoundtrip!).toBeLessThan(1);

      const embeddedViewport = embeddedHost
        .locator(".myoxus-mermaid-gfx-viewport")
        .first();
      const embeddedNote = page.locator("myoxus-edgeless-note").filter({
        has: page.locator(`myoxus-mermaid[data-block-id="${embeddedBlockId}"]`),
      });
      const clickEmbeddedNode = async () => {
        const activatePoint = await flowchartNodePoint(embeddedHost, "review");
        const viewportBox = await embeddedViewport.boundingBox();
        if (!viewportBox) {
          throw new Error("Embedded Mermaid viewport is not measurable");
        }
        await page.mouse.click(
          viewportBox.x + activatePoint.x,
          viewportBox.y + activatePoint.y,
        );
      };
      // The generic Note mask owns the outer transitions. Only after the
      // established Note double-click enters edit can its child consume a
      // pointer and become the active embedded diagram owner.
      await embeddedNote.dblclick();
      await expect(
        embeddedNote.locator('[data-testid="edgeless-note-container"]'),
      ).toHaveAttribute("data-editing", "true");
      await clickEmbeddedNode();
      const embeddedActions = embeddedHost.locator(
        '[data-myoxus-ui-role="mermaid-embedded-actions"]',
      );
      await expect(embeddedActions).toBeVisible({ timeout: 10_000 });
      await expect(
        embeddedHost.getByText("Source", { exact: true }),
      ).toHaveCount(0);
      await expect(
        embeddedHost.getByText("Inspector", { exact: true }),
      ).toHaveCount(0);

      const embeddedSourceBeforeActions = (
        await mermaidVisualModelSummary(embeddedHost)
      ).source;
      const embeddedNodeCountBeforeInsert = (
        await mermaidVisualModelSummary(embeddedHost)
      ).nodeCount;
      await embeddedActions
        .getByRole("button", { name: "Add element" })
        .click();
      const embeddedInsertPoint = await flowchartBlankPoint(embeddedHost);
      const embeddedViewportBox = await embeddedViewport.boundingBox();
      if (!embeddedViewportBox) {
        throw new Error("Embedded Mermaid viewport is not measurable");
      }
      await page.mouse.click(
        embeddedViewportBox.x + embeddedInsertPoint.x,
        embeddedViewportBox.y + embeddedInsertPoint.y,
      );
      const insertedNodeLabel = embeddedHost.getByRole("textbox", {
        name: "Selected node label",
      });
      await expect(insertedNodeLabel).toBeVisible({ timeout: 5_000 });
      await insertedNodeLabel.fill("Embedded QA node");
      await insertedNodeLabel.press("Enter");
      await expect
        .poll(async () => mermaidVisualModelSummary(embeddedHost))
        .toMatchObject({ nodeCount: embeddedNodeCountBeforeInsert + 1 });
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(embeddedHost)).source,
        )
        .toContain("Embedded QA node");
      await embeddedHost.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(embeddedHost)).source,
        )
        .toBe(embeddedSourceBeforeActions);

      const selectEmbeddedNodes = async (nodeIds: readonly string[]) => {
        const boxes = await Promise.all(
          nodeIds.map((nodeId) => flowchartNodeViewBox(embeddedHost, nodeId)),
        );
        const left = Math.min(...boxes.map((box) => box.x)) - 8;
        const top = Math.min(...boxes.map((box) => box.y)) - 8;
        const right = Math.max(...boxes.map((box) => box.x + box.width)) + 8;
        const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + 8;
        await embeddedActions
          .getByRole("radio", { name: "Selection box" })
          .click();
        await dragWithinLocator(
          page,
          embeddedViewport,
          { x: left, y: top },
          { x: right, y: bottom },
          8,
        );
      };

      await selectEmbeddedNodes(["build", "review"]);
      const embeddedGroup = embeddedActions.getByRole("button", {
        name: "Add group",
      });
      await expect(embeddedGroup).toBeEnabled();
      await embeddedGroup.click();
      const embeddedGroupTitle = embeddedHost.getByRole("textbox", {
        name: "Selected group title",
      });
      await expect(embeddedGroupTitle).toBeVisible({ timeout: 5_000 });
      await expect
        .poll(async () => mermaidVisualModelSummary(embeddedHost))
        .toMatchObject({ subgraphCount: 2 });
      await embeddedGroupTitle.press("Escape");
      await embeddedHost.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(embeddedHost)).source,
        )
        .toBe(embeddedSourceBeforeActions);

      await page.keyboard.press("Escape");
      await selectEmbeddedNodes(["deploy", "fix"]);
      const embeddedConnect = embeddedActions.getByRole("button", {
        name: "Connect",
      });
      await expect(embeddedConnect).toBeEnabled();
      await embeddedConnect.click();
      await expect
        .poll(async () => mermaidVisualModelSummary(embeddedHost))
        .toMatchObject({ edgeCount: 4 });
      await embeddedHost.focus();
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(
          async () => (await mermaidVisualModelSummary(embeddedHost)).source,
        )
        .toBe(embeddedSourceBeforeActions);

      for (let escapeCount = 0; escapeCount < 4; escapeCount += 1) {
        if (!(await embeddedActions.isVisible())) break;
        await page.keyboard.press("Escape");
      }
      await expect(embeddedActions).toBeHidden();
      const embeddedNoteState = () =>
        embeddedHost.evaluate((element) => {
          const model = (
            element as unknown as {
              model?: {
                id?: string;
                props?: { source?: { toString?: () => string } };
                store?: {
                  getParent?: (model: unknown) => {
                    id?: string;
                    xywh?: string;
                  } | null;
                };
              };
            }
          ).model;
          const note = model?.store?.getParent?.(model);
          return {
            id: note?.id ?? "",
            source: model?.props?.source?.toString?.() ?? "",
            xywh: note?.xywh ?? "",
          };
        });
      const noteBeforeResize = await embeddedNoteState();
      const resizeHandle = page
        .locator('edgeless-selected-rect .handle[aria-label="bottom-right"]')
        .first();
      await expect(resizeHandle).toBeVisible();
      const resizeHandleBox = await resizeHandle.boundingBox();
      if (!resizeHandleBox) {
        throw new Error("Embedded Mermaid Note resize handle is unavailable");
      }
      await page.mouse.move(
        resizeHandleBox.x + resizeHandleBox.width / 2,
        resizeHandleBox.y + resizeHandleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        resizeHandleBox.x + resizeHandleBox.width / 2 + 24,
        resizeHandleBox.y + resizeHandleBox.height / 2 + 18,
        { steps: 6 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => (await embeddedNoteState()).xywh)
        .not.toBe(noteBeforeResize.xywh);
      const noteAfterResize = await embeddedNoteState();
      expect(noteAfterResize.source).toBe(embeddedSourceBeforeActions);

      const embeddedNoteBox = await embeddedNote.boundingBox();
      if (!embeddedNoteBox) {
        throw new Error("Embedded Mermaid Note is not measurable");
      }
      await page.mouse.move(
        embeddedNoteBox.x + embeddedNoteBox.width / 2,
        embeddedNoteBox.y + 72,
      );
      await page.mouse.down();
      await page.mouse.move(
        embeddedNoteBox.x + embeddedNoteBox.width / 2 + 28,
        embeddedNoteBox.y + 90,
        { steps: 6 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => (await embeddedNoteState()).xywh)
        .not.toBe(noteAfterResize.xywh);
      const noteAfterMove = await embeddedNoteState();
      expect(noteAfterMove.source).toBe(embeddedSourceBeforeActions);
      expect(noteAfterMove.id).toBe(noteBeforeResize.id);

      await page.reload();
      if (!/\?mode=edgeless(?:$|&)/.test(page.url())) {
        await page.getByTestId("switch-edgeless-mode-button").click();
      }
      const reloadedEmbeddedHost = page.locator(
        `myoxus-edgeless-note myoxus-mermaid[data-block-id="${embeddedBlockId}"]`,
      );
      await expect(reloadedEmbeddedHost).toHaveCount(1, { timeout: 15_000 });
      const reloadedNoteState = await embeddedNoteState();
      expect(reloadedNoteState).toEqual(noteAfterMove);

      const beforeNativeIds = new Set(
        (await mermaidOwnerInventory(page)).map(({ id }) => id),
      );
      await openMermaidEdgelessMenu(page, "Flowchart");
      await page
        .getByTestId("myoxus-mermaid-edgeless-template-flowchart-basic")
        .click();
      await expect
        .poll(async () =>
          Boolean(
            (await mermaidOwnerInventory(page)).find(
              ({ id }) => !beforeNativeIds.has(id),
            ),
          ),
        )
        .toBe(true);
      const nativeOwners = (await mermaidOwnerInventory(page)).filter(
        ({ id }) => !beforeNativeIds.has(id),
      );
      expect(nativeOwners).toHaveLength(1);
      expect(nativeOwners[0]!.parentFlavor).toBe("myoxus:surface");
      expect(nativeOwners[0]!.childIds.length).toBeGreaterThan(0);
      expectContainedBounds(nativeOwners[0]!);
      await expect(
        page.getByRole("button", { name: "Export .mmd" }),
      ).toBeVisible();
      const nativeDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export .mmd" }).click();
      const nativeDownloadPath = await (await nativeDownload).path();
      expect(nativeDownloadPath).not.toBeNull();
      if (!nativeDownloadPath) throw new Error("Native export has no path");
      expect((await readFile(nativeDownloadPath, "utf8")).trimEnd()).toBe(
        nativeOwners[0]!.source.trimEnd(),
      );

      await openMermaidEdgelessMenu(page, "Pie");
      await page
        .getByTestId("myoxus-mermaid-edgeless-template-pie-basic")
        .click();
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).filter(({ source }) =>
              source.startsWith("pie"),
            ).length,
        )
        .toBe(1);
      const pieMenuOwner = (await mermaidOwnerInventory(page)).find(
        ({ source }) => source.startsWith("pie"),
      )!;
      expect(pieMenuOwner.parentFlavor).toBe("myoxus:note");
      expect(pieMenuOwner.childIds).toEqual([]);

      const beforeFlowchartImport = new Set(
        (await mermaidOwnerInventory(page)).map(({ id }) => id),
      );
      await importMermaidFile(page, flowchartImportPath);
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).filter(
              ({ id }) => !beforeFlowchartImport.has(id),
            ).length,
        )
        .toBe(1);
      const importedFlowchart = (await mermaidOwnerInventory(page)).find(
        ({ id }) => !beforeFlowchartImport.has(id),
      )!;
      expect(importedFlowchart.parentFlavor).toBe("myoxus:surface");
      expect(importedFlowchart.source.trimEnd()).toBe(
        flowchartFixture.trimEnd(),
      );
      await page.keyboard.press("Alt+1");
      await expect(
        page.getByRole("button", { name: "Export .mmd" }),
      ).toBeVisible();
      const importDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export .mmd" }).click();
      const importDownloadPath = await (await importDownload).path();
      expect(importDownloadPath).not.toBeNull();
      if (!importDownloadPath) throw new Error("Imported export has no path");
      expect((await readFile(importDownloadPath, "utf8")).trimEnd()).toBe(
        flowchartFixture.trimEnd(),
      );

      const beforePieImport = new Set(
        (await mermaidOwnerInventory(page)).map(({ id }) => id),
      );
      await importMermaidFile(page, pieImportPath);
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).filter(
              ({ id }) => !beforePieImport.has(id),
            ).length,
        )
        .toBe(1);
      const importedPie = (await mermaidOwnerInventory(page)).find(
        ({ id }) => !beforePieImport.has(id),
      )!;
      expect(importedPie.parentFlavor).toBe("myoxus:note");
      expect(importedPie.childIds).toEqual([]);
      expect(importedPie.source.trimEnd()).toBe(pieFixture.trimEnd());

      const beforeInvalidImport = await mermaidOwnerInventory(page);
      await importMermaidFile(page, invalidImportPath);
      await expect(
        page.getByText("Mermaid file could not be imported"),
      ).toBeVisible();
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(beforeInvalidImport.length);
    } finally {
      await Promise.all(
        [flowchartImportPath, pieImportPath, invalidImportPath].map((file) =>
          unlink(file).catch(() => undefined),
        ),
      );
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Kanban keeps source, membership and comments across history and reload", async ({
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
    const preferenceTarget = { request, gqlEndpoint: GQL, cookies };
    const originalLocale = await getAccountLocale(preferenceTarget);
    await setAccountLocale(preferenceTarget, "en");
    const originalColorMode = await getAccountColorMode(preferenceTarget);
    await setAccountColorMode(preferenceTarget, "dark");
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");

      const kanbanMenuItem = page.getByTestId(
        "slash-menu-item-mermaid-kanban-basic",
      );
      await expect(kanbanMenuItem).toBeVisible({ timeout: 5_000 });
      await expect(kanbanMenuItem).toContainText("Create a Mermaid diagram");
      await expect(kanbanMenuItem).not.toContainText(
        /Browser-tested|Experimental|Stable visual editor/i,
      );
      await kanbanMenuItem.click();

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await expect(
        mermaidBlock.getByTestId("mermaid-kanban-board"),
      ).toBeVisible();
      await expect(
        mermaidBlock.getByRole("radio", { name: "Visual" }),
      ).toBeChecked();
      await expect(
        mermaidBlock.getByText("Visual", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("myoxus-database")).toHaveCount(0);
      const mode = mermaidBlock.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture =
        '---\ntitle: "Retention board"\nconfig: {kanban: {sectionWidth: 240, retained: "foreign"}}\n---\nKANBAN\n  todo[To do]\n    %% moves with the idless card\n    ["Same"]@{assigned: "QA", retained: "keep"}\n\n%% position stays\n  done[Done]\n    other((Same))';
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      const board = mermaidBlock.getByTestId("mermaid-kanban-board");
      const todo = board.getByRole("group", { name: "To do", exact: true });
      const idlessCard = todo.locator("[data-card-id]").first();
      const id = await idlessCard.getAttribute("data-card-id");
      if (!id) throw new Error("Kanban card has no session identity");
      await idlessCard
        .getByRole("button", { name: "Same", exact: true })
        .dblclick();
      await idlessCard
        .getByRole("textbox", { name: "Same", exact: true })
        .fill("Changed");
      await idlessCard
        .getByRole("textbox", { name: "Same", exact: true })
        .press("Enter");
      const changedCard = board.locator(`[data-card-id="${id}"]`);
      await expect(changedCard).toContainText("Changed");
      const grip = changedCard.getByRole("button", {
        name: "Move card: Changed",
        exact: true,
      });
      await grip.press("Enter");
      await grip.press("ArrowRight");
      await grip.press("ArrowDown");
      await grip.press("Enter");
      await expect(
        board
          .getByRole("group", { name: "Done", exact: true })
          .locator(`[data-card-id="${id}"]`),
      ).toBeVisible();
      await mode.getByText("Source", { exact: true }).click();
      const moved =
        fixture.replace(
          '    %% moves with the idless card\n    ["Same"]@{assigned: "QA", retained: "keep"}\n',
          "",
        ) +
        '\n    %% moves with the idless card\n    ["Changed"]@{assigned: "QA", retained: "keep"}';
      await expect(sourceEditor).toHaveValue(moved);
      await mermaidBlock
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      await expect(sourceEditor).toHaveValue(
        fixture.replace('["Same"]', '["Changed"]'),
      );
      await mermaidBlock
        .getByRole("button", { name: "Redo", exact: true })
        .click();
      await expect(sourceEditor).toHaveValue(moved);
      await page.reload();
      await mermaidBlock.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(moved);
      await mode.getByText("View", { exact: true }).click();
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-display-preview svg"),
      ).toBeVisible();
      await expect(board).toHaveCount(0);
      await mode.getByText("Visual", { exact: true }).click();

      const screenshotPath = testInfo.outputPath(
        "web-mermaid-kanban-board-facade.png",
      );
      await page.screenshot({ fullPage: true, path: screenshotPath });
      await testInfo.attach("web-mermaid-kanban-board-facade", {
        path: screenshotPath,
        contentType: "image/png",
      });
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await setAccountColorMode(preferenceTarget, originalColorMode);
      await setAccountLocale(preferenceTarget, originalLocale);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Sequence keeps temporal source, activation bindings and comments through history, reload and Edgeless", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
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
      await page.getByTestId("slash-menu-item-mermaid-sequence-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture = [
        "---",
        "title: Sequence regression",
        "config:",
        "  sequence:",
        "    mirrorActors: false",
        "---",
        "sequenceDiagram",
        "box rgb(235, 245, 255) Services",
        "participant User",
        "participant API",
        "participant Worker",
        "end",
        "User->>+API: Dispatch",
        "API-->>-User: Accepted",
        "User->>API: Follow up",
        "par Audit",
        "  %% Child comment",
        "  API->>Worker: Persist",
        "and Notify",
        "  Worker-->>User: Notify",
        "end",
        "",
      ].join("\n");
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await selectFacadeOption(page, block, "Diagram zoom", "100%");
      await block
        .getByRole("button", { name: "Center diagram", exact: true })
        .click();
      const read = async () => (await mermaidOwnerInventory(page))[0];
      await expect.poll(async () => (await read()).source).toBe(fixture);
      // Click the actual line inside the authored Box. A background hit would
      // open a Box form instead of the consuming Message controls below.
      const point = await block.evaluate((element) => {
        const host = element as HTMLElement & {
          model: {
            surface: {
              elementModels: Array<{
                type: string;
                text?: { toString(): string };
                xywh: string;
              }>;
            };
          };
        };
        const line = host.model.surface.elementModels.find(
          (item) =>
            item.type === "connector" && item.text?.toString() === "Dispatch",
        )!;
        const surface = host.querySelector("myoxus-surface") as HTMLElement & {
          _gfx: {
            viewport: { viewportX: number; viewportY: number; zoom: number };
          };
        };
        const viewport = host
          .querySelector(".myoxus-mermaid-gfx-viewport")!
          .getBoundingClientRect();
        const camera = surface._gfx.viewport;
        const [x, y, width] = JSON.parse(line.xywh) as number[];
        return {
          x: viewport.left + (x + width / 4 - camera.viewportX) * camera.zoom,
          y: viewport.top + (y - camera.viewportY) * camera.zoom,
        };
      });
      await page.mouse.dblclick(point.x, point.y);
      const message = page.getByRole("dialog", {
        name: "Message",
        exact: true,
      });
      await selectFacadeOption(page, message, "Target node", "Worker");
      await message
        .getByRole("button", { name: "Preview change", exact: true })
        .first()
        .click();
      expect((await read()).source).toBe(fixture);
      await message
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click();
      expect((await read()).source).toBe(fixture);
      await block
        .getByRole("button", { name: "Dispatch", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await selectFacadeOption(page, message, "Target node", "Worker");
      await message
        .getByRole("button", { name: "Apply change", exact: true })
        .first()
        .click();
      const reconnected = fixture
        .replace("User->>+API: Dispatch", "User->>+Worker: Dispatch")
        .replace("API-->>-User: Accepted", "Worker-->>-User: Accepted");
      await expect.poll(async () => (await read()).source).toBe(reconnected);
      await block
        .getByRole("button", { name: "Follow up", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await message
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click();
      const order = page.getByRole("button", {
        name: "Source order",
        exact: true,
      });
      await order.press("ArrowUp");
      expect((await read()).source).toBe(reconnected);
      await order.press("Enter");
      const reordered = reconnected.replace(
        "Worker-->>-User: Accepted\nUser->>API: Follow up\n",
        "User->>API: Follow up\nWorker-->>-User: Accepted\n",
      );
      await expect.poll(async () => (await read()).source).toBe(reordered);
      await block.getByRole("button", { name: "Audit", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("textbox", { name: "Label", exact: true })
        .first()
        .fill("Reviewed audit");
      await page
        .getByRole("button", { name: "Apply change", exact: true })
        .first()
        .click();
      const fragmented = reordered.replace("par Audit", "par Reviewed audit");
      await expect.poll(async () => (await read()).source).toBe(fragmented);
      await block
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Comments", exact: true })
        .click();
      const marker = block.locator(
        '[data-myoxus-ui-role="mermaid-sequence-comment-marker"]',
      );
      await marker
        .getByRole("button", { name: "Comments (1)", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Comments", exact: true })
        .first()
        .fill("Persisted audit boundary");
      await page
        .getByRole("button", { name: "Apply change", exact: true })
        .first()
        .click();
      const edited = fragmented.replace(
        "%% Child comment",
        "%% Persisted audit boundary",
      );
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(source).toHaveValue(fragmented);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(source).toHaveValue(edited);
      const owner = await read();
      await page.evaluate(async (id) => {
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
        if (!workspace || !id) throw new Error("No active Sequence document");
        const signal = AbortSignal.timeout(20_000);
        await workspace.engine.doc.waitForSynced(id, signal);
        await workspace.engine.doc.waitForSynced(workspace.id, signal);
      }, docId);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await mode.getByText("Visual", { exact: true }).click();
      await page.getByTestId("switch-edgeless-mode-button").click();
      const note = page.locator(".myoxus-note-mask").first();
      await note.dblclick({ position: { x: 35, y: 40 } });
      await expect(
        page.getByTestId("edgeless-note-container").first(),
      ).toHaveAttribute("data-editing", "true");
      const followup = block.getByRole("button", {
        name: "Follow up",
        exact: true,
      });
      await followup.focus();
      await expect(
        block.locator('[data-myoxus-ui-role="mermaid-embedded-actions"]'),
      ).toBeVisible();
      await followup.focus();
      await page.keyboard.press("Enter");
      await message
        .getByRole("textbox", { name: "Label", exact: true })
        .fill("Embedded follow up");
      await message
        .getByRole("button", { name: "Apply change", exact: true })
        .first()
        .click();
      await expect(source).toHaveCount(0);
      await expect(mode).toHaveCount(0);
      const embedded = edited.replace(
        "User->>API: Follow up",
        "User->>API: Embedded follow up",
      );
      await expect.poll(async () => (await read()).source).toBe(embedded);
      expect((await read()).id).toBe(owner.id);
      expect((await read()).parentId).toBe(owner.parentId);
      await page.screenshot({
        path: testInfo.outputPath("sequence-embedded.png"),
      });
      await page.getByTestId("switch-page-mode-button").click();
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(embedded);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Requirement keeps creation, field and connection writes through delete, history and reload", async ({
    context,
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
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
      await typeSlashCommand(page, "/requirement");
      await page
        .getByTestId("slash-menu-item-mermaid-requirement-basic")
        .click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture = requiredMermaidFixture(
        MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
        "requirementDiagram",
      ).source;
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("button", { name: "req1", exact: true }),
      ).toBeAttached();
      const readSource = async () =>
        (await mermaidVisualModelSummary(block)).source;
      await expect.poll(readSource).toBe(fixture);

      await block
        .getByRole("button", { name: "Add node", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "requirement", exact: true })
        .click();
      const viewport = block.locator(".myoxus-mermaid-gfx-viewport");
      // Placement must hit blank canvas, not an existing card's object control.
      await viewport.click({ position: { x: 40, y: 40 } });
      await page
        .getByRole("textbox", { name: "Selected node label", exact: true })
        .fill("audit");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      const created = `${fixture}\n  requirement audit {\n  }\n`;
      await expect.poll(readSource).toBe(created);

      const audit = block.getByRole("button", { name: "audit", exact: true });
      await audit.press("Enter");
      await page
        .getByRole("textbox", { name: "Requirement text", exact: true })
        .fill("Consumer proof");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const edited = created.replace(
        "  requirement audit {\n  }",
        "  requirement audit {\n    text: Consumer proof\n  }",
      );
      await expect.poll(readSource).toBe(edited);
      await block.getByRole("button", { name: "Connect", exact: true }).click();
      await selectFacadeOption(page, page.getByRole("dialog"), "Target", "ui");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      const connected = `${edited}  audit - satisfies -> ui\n`;
      await expect.poll(readSource).toBe(connected);
      await expect(
        block.getByRole("button", { name: "<<satisfies>>", exact: true }),
      ).toBeAttached();

      await viewport.focus();
      await page.keyboard.press("Escape");
      await audit.press("Space");
      await block.getByRole("button", { name: "Delete", exact: true }).click();
      const impact = page.getByRole("dialog");
      await expect(impact).toContainText("audit - satisfies -> ui");
      await impact.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(readSource).toBe(`${fixture}\n`);
      await expect(audit).toHaveCount(0);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(readSource).toBe(connected);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect.poll(readSource).toBe(`${fixture}\n`);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(readSource).toBe(connected);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await expect.poll(readSource).toBe(connected);
      await audit.press("Enter");
      await expect(
        page.getByRole("textbox", { name: "Requirement text", exact: true }),
      ).toHaveValue("Consumer proof");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Class keeps member and composition edits through reconnect, history and reload", async ({
    context,
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
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
      await page.getByTestId("slash-menu-item-mermaid-class-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture =
        'classDiagram\nclass Order {\n  +id: UUID\n}\nclass OrderItem\nclass Repository\nOrder "1" *-- "1..*" OrderItem : contains\nclick Order call opaqueCallback "Keep callback"\n';
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await selectFacadeOption(page, block, "Diagram zoom", "70%");
      await block
        .getByRole("button", { name: "Center diagram", exact: true })
        .click();
      await block
        .getByRole("button", { name: "+id: UUID", exact: true })
        .press("Enter");
      const member = page.getByRole("dialog", { name: "Member", exact: true });
      await member
        .getByRole("textbox", { name: "Mermaid name", exact: true })
        .fill("orderId");
      await member.getByRole("button", { name: "Save", exact: true }).click();
      const memberSource = fixture.replace("+id: UUID", "+orderId: UUID");
      await expect(
        block.getByRole("button", { name: "+orderId: UUID", exact: true }),
      ).toHaveCount(1);
      await block
        .getByRole("button", { name: "contains", exact: true })
        .press("Enter");
      await page.keyboard.press("Escape");
      const handle = block.getByRole("button", {
        name: "Reconnect edge target",
        exact: true,
      });
      await expect(handle).toBeVisible();
      const target = await block.evaluate((element) => {
        const host = element as HTMLElement & {
          _getMermaidVisualModelForEditing(): {
            nodes: Array<{ id: string; label: string }>;
          };
          _getVisualNodeGfxModel(id: string): { xywh: string };
          _gfxViewportBridge: {
            getViewportElement(): HTMLElement;
            getModelViewRect(xywh: string): {
              left: number;
              top: number;
              width: number;
              height: number;
            };
          };
        };
        const node = host
          ._getMermaidVisualModelForEditing()
          .nodes.find((node) => node.label === "Repository")!;
        const viewport = host._gfxViewportBridge
          .getViewportElement()
          .getBoundingClientRect();
        const bound = host._gfxViewportBridge.getModelViewRect(
          host._getVisualNodeGfxModel(node.id).xywh,
        );
        return {
          x: viewport.left + bound.left + bound.width / 2,
          y: viewport.top + bound.top + bound.height / 2,
        };
      });
      const start = await handle.boundingBox();
      if (!start) throw new Error("Class target handle has no rendered bounds");
      await page.mouse.move(
        start.x + start.width / 2,
        start.y + start.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.mouse.up();
      const edited = memberSource.replace(
        '*-- "1..*" OrderItem',
        '*-- "1..*" Repository',
      );
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(source).toHaveValue(memberSource);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(source).toHaveValue(edited);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("button", { name: "+orderId: UUID", exact: true }),
      ).toHaveCount(1);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid ER keeps attribute and comment edits through reconnect, history, reload and embedded Edgeless", async ({
    context,
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
    });
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    const preferenceTarget = { request, gqlEndpoint: GQL, cookies };
    const originalLocale = await getAccountLocale(preferenceTarget);
    await setAccountLocale(preferenceTarget, "en");
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-er-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture =
        '---\ntitle: "Commerce records"\nconfig: {er: {fontSize: 14}, retained: "foreign"}\n---\nerDiagram\n  direction LR\n  CUSTOMER {\n    uuid id PK\n  }\n  ORDER {\n    uuid id PK\n    %% Owning account\n    uuid customer_id FK\n  }\n  PRODUCT {\n    uuid id PK\n  }\n  CUSTOMER ||--o{ ORDER : places\n  ORDER }o..|o PRODUCT : includes';
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await selectFacadeOption(page, block, "Diagram zoom", "70%");
      await block
        .getByRole("button", { name: "Center diagram", exact: true })
        .click();
      const attribute = block.getByRole("button", {
        name: "customer_id",
        exact: true,
      });
      await attribute.focus();
      await page.keyboard.press("Enter");
      const attributeForm = page.getByRole("dialog", {
        name: "Attribute",
        exact: true,
      });
      await attributeForm
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("discarded");
      await attributeForm
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await attribute.focus();
      await page.keyboard.press("Enter");
      await attributeForm
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("customer_ref");
      await attributeForm
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const attributeSource = fixture.replace(
        "uuid customer_id FK",
        "uuid customer_ref FK",
      );
      await block
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Comments", exact: true })
        .click();
      const marker = block.locator(
        '[data-myoxus-ui-role="mermaid-er-comment-marker"]',
      );
      await expect(marker).toHaveCount(1);
      // The SVG path is the actual pointer target; its button must bypass canvas selection.
      await marker.locator("svg path").first().click();
      await page
        .getByRole("textbox", { name: "Comments", exact: true })
        .first()
        .fill("Owning account reference");
      await page
        .getByRole("button", { name: "Save", exact: true })
        .first()
        .click();
      const commentSource = attributeSource.replace(
        "%% Owning account",
        "%% Owning account reference",
      );
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(commentSource);
      await mode.getByText("Visual", { exact: true }).click();
      await block.getByRole("button", { name: "places", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("dialog", { name: "Relationship", exact: true })
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      const ownerBefore = (await mermaidOwnerInventory(page))[0];
      expect(ownerBefore.source).toBe(commentSource);
      const handle = block.getByRole("button", {
        name: "Reconnect edge target",
        exact: true,
      });
      await expect(handle).toBeVisible();
      const target = await block.evaluate((element) => {
        const host = element as HTMLElement & {
          _getMermaidVisualModelForEditing(): {
            nodes: Array<{ id: string; label: string }>;
          };
          _getVisualNodeGfxModel(id: string): { xywh: string };
          _gfxViewportBridge: {
            getViewportElement(): HTMLElement;
            getModelViewRect(xywh: string): {
              left: number;
              top: number;
              width: number;
              height: number;
            };
          };
        };
        const node = host
          ._getMermaidVisualModelForEditing()
          .nodes.find((node) => node.label === "PRODUCT")!;
        const viewport = host._gfxViewportBridge
          .getViewportElement()
          .getBoundingClientRect();
        const bound = host._gfxViewportBridge.getModelViewRect(
          host._getVisualNodeGfxModel(node.id).xywh,
        );
        return {
          x: viewport.left + bound.left + bound.width / 2,
          y: viewport.top + bound.top + bound.height / 2,
        };
      });
      const start = await handle.boundingBox();
      if (!start) throw new Error("ER target handle has no rendered bounds");
      await page.mouse.move(
        start.x + start.width / 2,
        start.y + start.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      expect((await mermaidOwnerInventory(page))[0].source).toBe(commentSource);
      await page.mouse.up();
      const edited = commentSource.replace(
        "CUSTOMER ||--o{ ORDER : places",
        "CUSTOMER ||--o{ PRODUCT : places",
      );
      await expect
        .poll(async () =>
          block.evaluate((element) => {
            const host = element as HTMLElement & {
              _getMermaidVisualModelForEditing(): {
                nodes: Array<{ id: string; label: string }>;
                edges: Array<{ id: string; label: string }>;
              };
              _getVisualNodeGfxModel(id: string): { id: string };
              _getVisualEdgeGfxModel(id: string): {
                source: { id: string };
                target: { id: string };
                frontEndpointStyle: string;
                rearEndpointStyle: string;
              };
            };
            const model = host._getMermaidVisualModelForEditing();
            const connector = host._getVisualEdgeGfxModel(
              model.edges.find((edge) => edge.label === "places")!.id,
            );
            const nodeId = (label: string) =>
              host._getVisualNodeGfxModel(
                model.nodes.find((node) => node.label === label)!.id,
              ).id;
            return {
              source: connector.source.id === nodeId("CUSTOMER"),
              target: connector.target.id === nodeId("PRODUCT"),
              front: connector.frontEndpointStyle,
              rear: connector.rearEndpointStyle,
            };
          }),
        )
        .toEqual({
          source: true,
          target: true,
          front: "DoubleBar",
          rear: "CircleCrowFoot",
        });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(source).toHaveValue(commentSource);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(source).toHaveValue(edited);
      // Reload after native document acknowledgement, not just local Source readback.
      await page.evaluate(async (id) => {
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
        if (!workspace || !id) throw new Error("No active ER document");
        const signal = AbortSignal.timeout(20_000);
        await workspace.engine.doc.waitForSynced(id, signal);
        await workspace.engine.doc.waitForSynced(workspace.id, signal);
      }, docId);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await mode.getByText("Visual", { exact: true }).click();
      await page
        .getByRole("radio", { name: "Edgeless", exact: true })
        .locator("..")
        .click();
      await page.locator("myoxus-edgeless-root").waitFor({ state: "visible" });
      // Open the containing Note through its normal canvas gesture, then edit its real object.
      const noteMask = page.locator(".myoxus-note-mask").first();
      await noteMask.click({ position: { x: 35, y: 40 } });
      await noteMask.dblclick({ position: { x: 35, y: 40 } });
      await expect(
        page.locator('[data-testid="edgeless-note-container"]').first(),
      ).toHaveAttribute("data-editing", "true");
      const customer = block.getByRole("button", {
        name: "CUSTOMER",
        exact: true,
      });
      await customer.focus();
      // Activation replaces the passive projection, including its focus proxy.
      await expect(
        block.locator('[data-myoxus-ui-role="mermaid-embedded-actions"]'),
      ).toBeVisible();
      await customer.focus();
      await expect(customer).toBeFocused();
      await page.keyboard.press("Enter");
      await page
        .getByRole("dialog", { name: "Entity ID", exact: true })
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await block
        .getByRole("button", { name: "customer_ref", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await attributeForm
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("customer_account_id");
      await attributeForm
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await expect(source).toHaveCount(0);
      await expect(mode).toHaveCount(0);
      const embedded = await mermaidOwnerInventory(page);
      expect(embedded).toHaveLength(1);
      expect(embedded[0]).toMatchObject({
        id: ownerBefore.id,
        parentId: ownerBefore.parentId,
        parentFlavor: "myoxus:note",
        source: edited.replace(
          "uuid customer_ref FK",
          "uuid customer_account_id FK",
        ),
      });
      expect(embedded[0].childIds).toEqual(ownerBefore.childIds);
      await page
        .getByRole("radio", { name: "Page", exact: true })
        .locator("..")
        .click();
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(embedded[0].source);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await setAccountLocale(preferenceTarget, originalLocale);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Block keeps Source grids, free geometry, notation and identities across history, reload and Edgeless", async ({
    context,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
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
    const importedPath = testInfo.outputPath("block-import.mmd");
    try {
      await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`);
      await page.getByTestId("diagram-category-planning").click();
      await page.getByTestId("diagram-type-block").click();
      await page.getByTestId("create-selected-diagram-button").click();
      await expect(page).toHaveURL(
        new RegExp(`/workspace/${workspaceId}/(?!diagrams)[^/?]+`),
        { timeout: 30_000 },
      );
      docId = new URL(page.url()).pathname.split("/").at(-1);
      if (!docId) throw new Error("Block catalog creation has no document");
      // Replace our own catalog example through its owner action, then build
      // the Page reference. Diagram metadata and native exports remain owned
      // by the same persisted catalog document.
      await expect(
        page.getByRole("button", { name: "Export .mmd", exact: true }),
      ).toBeVisible();
      const deleteExample = page.getByTestId("delete");
      if (!(await deleteExample.isVisible()))
        await page.getByRole("button", { name: "More", exact: true }).click();
      await deleteExample.click();
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(0);
      await page.getByTestId("switch-page-mode-button").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, MERMAID_BLOCK_JOURNEY_FIXTURE);
      await mode.getByText("Visual", { exact: true }).click();
      await selectFacadeOption(page, block, "Diagram zoom", "70%");
      const ownerId = (await mermaidOwnerInventory(page))[0].id;
      const currentSource = async () =>
        (await mermaidOwnerInventory(page)).find((o) => o.id === ownerId)!
          .source;
      const actions = block.locator(
        '[data-myoxus-ui-role="mermaid-block-actions"]',
      );
      const point = async (label: string) =>
        block.evaluate((element, label) => {
          const host = element as unknown as {
            _getMermaidVisualModelForEditing(): {
              nodes: { id: string; label: string; x: number; y: number }[];
            };
            _getVisualNodeGfxModel(id: string): { xywh: string };
            _gfxViewportBridge: {
              getModelViewRect(xywh: string): {
                left: number;
                top: number;
                width: number;
                height: number;
              };
              getClientPointFromView(p: { left: number; top: number }): {
                left: number;
                top: number;
              };
            };
          };
          const n = host
            ._getMermaidVisualModelForEditing()
            .nodes.find((n) => n.label === label);
          if (!n) throw new Error(`Block ${label} is missing`);
          const xywh = host._getVisualNodeGfxModel(n.id).xywh;
          const r = host._gfxViewportBridge.getModelViewRect(xywh);
          const p = host._gfxViewportBridge.getClientPointFromView(r);
          return {
            key: n.id,
            xywh,
            x: p.left + r.width / 2,
            y: p.top + r.height / 2,
          };
        }, label);
      const openBlock = async (label: string) => {
        const p = await point(label);
        await page.mouse.click(p.x, p.y);
        const form = page.getByRole("dialog", { name: "Block", exact: true });
        await form.getByRole("button", { name: "Block", exact: true }).click();
        await expect(
          form.getByRole("textbox", { name: "Mermaid ID", exact: true }),
        ).toBeVisible();
        return form;
      };
      await expect(
        block.getByRole("button", { name: /Space · 0/ }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("block-page-grid.png"),
      });
      const original = await point("Request input");
      await page.mouse.move(original.x, original.y);
      await page.mouse.down();
      await page.mouse.move(original.x + 42, original.y - 28, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => (await point("Request input")).xywh)
        .not.toBe(original.xywh);
      expect(await currentSource()).toBe(MERMAID_BLOCK_JOURNEY_FIXTURE);
      const moved = await point("Request input");
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect
        .poll(async () => (await point("Request input")).xywh)
        .toBe(original.xywh);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect
        .poll(async () => (await point("Request input")).xywh)
        .toBe(moved.xywh);
      await page.mouse.dblclick(moved.x, moved.y);
      let form = page.getByRole("dialog", { name: "Block", exact: true });
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("Request intake");
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .press("Enter");
      const renamed = MERMAID_BLOCK_JOURNEY_FIXTURE.replace(
        'input(["Request input"])',
        'input(["Request intake"])',
      );
      await expect.poll(currentSource).toBe(renamed);
      expect((await point("Request intake")).key).toBe(original.key);
      expect((await point("Request intake")).xywh).toBe(moved.xywh);
      form = await openBlock("Request intake");
      await form
        .getByRole("textbox", { name: "Mermaid ID", exact: true })
        .fill("intake");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const identified = renamed.replace(/\binput\b/g, "intake");
      await expect.poll(currentSource).toBe(identified);
      expect((await point("Request intake")).key).toBe(original.key);
      // Confirmed local Columns reflow preserves the freely positioned root block.
      await actions
        .getByRole("button", { name: "Grid columns", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Grid columns", exact: true });
      await selectFacadeOption(page, form, "Parent", "Storage");
      await form.getByLabel("Grid columns", { exact: true }).fill("-1");
      await form.getByLabel("Grid columns", { exact: true }).press("Tab");
      await expect(
        form.getByLabel("Grid columns", { exact: true }),
      ).toHaveValue("-1");
      await expect(
        form.getByRole("checkbox", { name: "Automatic", exact: true }),
      ).not.toBeChecked();
      await expect(
        form.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      expect(await currentSource()).toBe(identified);
      await form.getByLabel("Grid columns", { exact: true }).fill("2");
      const localBefore = await point("Audit log");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("confirm-modal-confirm")).toBeVisible();
      expect(await currentSource()).toBe(identified);
      await page.getByTestId("confirm-modal-cancel").click();
      await expect
        .poll(async () => (await point("Audit log")).xywh)
        .toBe(localBefore.xywh);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("confirm-modal-confirm").click();
      await expect
        .poll(currentSource)
        .toBe(identified.replace("columns 1", "columns 2"));
      expect((await point("Request intake")).xywh).toBe(moved.xywh);
      const aligned = await currentSource();
      // Appearance commits finish their local drafts; one document Undo must
      // restore the Source rather than dismiss a stale floating form first.
      await actions
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Appearance", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Appearance", exact: true });
      await form.getByLabel("Padding", { exact: true }).fill("16");
      await form
        .getByRole("button", { name: "Save", exact: true })
        .first()
        .click();
      await page.getByTestId("confirm-modal-confirm").click();
      await expect
        .poll(currentSource)
        .toBe(aligned.replace("padding: 12", "padding: 16"));
      await expect(form).toBeHidden();
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(aligned);
      await actions
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Accessibility", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Accessibility", exact: true });
      await expect(form).toContainText("Publication pipeline");
      await expect(form.locator("input,textarea")).toHaveCount(0);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      // Space:0 is a source object; inserting it neither erases it nor creates a cell.
      await actions.getByRole("button", { name: "Space", exact: true }).click();
      form = page.getByRole("dialog", { name: "Space", exact: true });
      await form.getByLabel("Column span", { exact: true }).fill("0");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("confirm-modal-confirm").click();
      await expect
        .poll(async () => (await currentSource()).match(/space:0/g)?.length)
        .toBe(2);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(aligned);
      // Explicit empty creation and deletion do not invent a child.
      await actions
        .getByRole("button", { name: "Empty composite", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Empty composite", exact: true });
      await form
        .getByRole("textbox", { name: "Mermaid ID", exact: true })
        .fill("Review");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(currentSource).toContain("block:Review");
      const empty = await currentSource();
      expect(empty).toMatch(/block:Review[^\n]*\n\s*columns auto\n\s*end/);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(aligned);
      // Cancelled notation preview has no Source or History effect.
      await actions
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Connect", exact: true });
      await selectFacadeOption(page, form, "Reconnect edge source", "Publish");
      await selectFacadeOption(page, form, "Reconnect edge target", "Publish");
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("confirmed retry");
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await currentSource()).toBe(aligned);
      await actions
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Connect", exact: true });
      await selectFacadeOption(page, form, "Reconnect edge source", "Publish");
      await selectFacadeOption(page, form, "Reconnect edge target", "Publish");
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("confirmed retry");
      await expect(
        form.getByText("Connection notation: --->", { exact: true }),
      ).toBeVisible();
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(currentSource)
        .toBe(`${aligned}  publish -- "confirmed retry" ---> publish\n`);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(aligned);
      const bodies = (await mermaidOwnerInventory(page)).find(
        (o) => o.id === ownerId,
      )!;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(block.locator(".myoxus-mermaid-gfx-editor")).toBeVisible({
        timeout: 15_000,
      });
      await expect.poll(currentSource).toBe(aligned);
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).find((o) => o.id === ownerId)!
              .childIds,
        )
        .toEqual(bodies.childIds);
      await expect
        .poll(async () => (await point("Request intake")).xywh)
        .toBe(moved.xywh);
      await mode.getByText("View", { exact: true }).click();
      await expect(actions).toHaveCount(0);
      await expect(
        block.getByRole("button", { name: /Space · 0/ }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("block-page-view.png"),
      });
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, `${aligned}\nblock:Broken\n columns 2`);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("status", {
          name: "Last valid Mermaid preview",
          exact: true,
        }),
      ).toContainText("end");
      const invalid = await currentSource();
      await page.getByTestId("switch-edgeless-mode-button").click();
      await expect.poll(currentSource).toBe(invalid);
      await expect(source).toHaveCount(0);
      await page.getByTestId("switch-page-mode-button").click();
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, aligned);
      await mode.getByText("Visual", { exact: true }).click();
      await page.getByTestId("switch-edgeless-mode-button").click();
      const mask = page.locator(".myoxus-note-mask").first();
      await mask.click({ position: { x: 35, y: 40 } });
      await mask.dblclick({ position: { x: 35, y: 40 } });
      await expect(
        page.locator('[data-testid="edgeless-note-container"]').first(),
      ).toHaveAttribute("data-editing", "true");
      await block
        .getByRole("button", { name: "Request intake", exact: true })
        .focus();
      await expect(
        block.getByRole("button", { name: "Request intake", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      form = page.getByRole("dialog", { name: "Block", exact: true });
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("Embedded intake");
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .press("Enter");
      const embedded = aligned.replace(
        'intake(["Request intake"])',
        'intake(["Embedded intake"])',
      );
      await expect.poll(currentSource).toBe(embedded);
      await expect(source).toHaveCount(0);
      await expect(mode).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("block-embedded-edited.png"),
      });
      const oldOwners = new Set(
        (await mermaidOwnerInventory(page)).map((o) => o.id),
      );
      await writeFile(importedPath, embedded, "utf8");
      await importMermaidFile(page, importedPath);
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).filter(
              (o) => !oldOwners.has(o.id),
            ).length,
        )
        .toBe(1);
      const native = (await mermaidOwnerInventory(page)).find(
        (o) => !oldOwners.has(o.id),
      )!;
      expect(native.parentFlavor).toBe("myoxus:surface");
      expect(native.source).toBe(embedded);
      await page.keyboard.press("Alt+1");
      await expect(
        page.getByRole("button", { name: "Export .mmd", exact: true }),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export .mmd", exact: true })
        .click();
      const exported = await (await download).path();
      if (!exported) throw new Error("Block export has no path");
      expect(await readFile(exported, "utf8")).toBe(embedded);
      await page
        .getByRole("button", { name: "Open menu", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Export", exact: true }).hover();
      const svgExport = page.getByRole("menuitem", {
        name: "Mermaid SVG",
        exact: true,
      });
      await expect(svgExport).toBeVisible();
      const svgDownloading = page.waitForEvent("download");
      await svgExport.click();
      const svgPath = await (await svgDownloading).path();
      if (!svgPath) throw new Error("Block SVG export has no path");
      const svg = await readFile(svgPath, "utf8");
      expect(svg).toContain('aria-roledescription="block"');
      expect(svg).not.toMatch(/NaN|Infinity/);
      // The native SVG consumer omits the invisible pair while retaining both
      // visible parallel occurrences, rather than hiding every related edge.
      expect(svg).toContain('id="1-intake-validate"');
      expect(svg).toContain('id="2-intake-validate"');
      expect(svg).not.toContain('id="1-intake-publish"');
      const nativeBlock = page.locator(
        `myoxus-edgeless-mermaid[data-block-id="${native.id}"]`,
      );
      const nativePoint = await nativeBlock.evaluate((element) => {
        const host = element as unknown as {
          model: {
            childElements: {
              type: string;
              xywh: string;
              text?: { toString(): string };
            }[];
          };
          gfx: {
            viewport: {
              toViewCoord(x: number, y: number): number[];
              boundingClientRect: DOMRect;
            };
          };
        };
        const body = host.model.childElements.find(
          (child) =>
            child.type === "shape" &&
            child.text?.toString() === "Embedded intake",
        );
        if (!body) throw new Error("Native intake body is missing");
        const [x, y, w, h] = JSON.parse(body.xywh) as number[];
        const viewport = host.gfx.viewport;
        const p = viewport.toViewCoord(x + w / 2, y + h / 2);
        return {
          x: p[0] + viewport.boundingClientRect.left,
          y: p[1] + viewport.boundingClientRect.top,
        };
      });
      await page.mouse.click(nativePoint.x, nativePoint.y);
      await page.keyboard.press("Enter");
      form = page.getByRole("dialog", { name: "Block", exact: true });
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .fill("Native intake");
      await form
        .getByRole("textbox", { name: "Display name", exact: true })
        .press("Enter");
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).find((o) => o.id === native.id)!
              .source,
        )
        .toBe(
          embedded.replace(
            'intake(["Embedded intake"])',
            'intake(["Native intake"])',
          ),
        );
      expect(await currentSource()).toBe(embedded);
      await expect
        .poll(() =>
          nativeBlock.evaluate(
            (host: any) => document.activeElement === host.std.host,
          ),
        )
        .toBe(true);
      const nativeGeometry = () =>
        nativeBlock.evaluate((element) => {
          const host = element as unknown as {
            model: {
              props: { source: { toString(): string } };
              childElements: {
                id: string;
                type: string;
                xywh: string;
                mermaidNodeId?: string;
                text?: { toString(): string };
              }[];
            };
            gfx: {
              viewport: {
                zoom: number;
                boundingClientRect: DOMRect;
                toViewCoord(x: number, y: number): number[];
              };
            };
          };
          const children = host.model.childElements
            .filter((c) => c.type === "shape")
            .map((c) => ({
              id: c.id,
              label: c.text?.toString(),
              key: c.mermaidNodeId,
              bounds: JSON.parse(c.xywh) as [number, number, number, number],
            }));
          const storage = children.find((c) => c.label === "Storage")!;
          const object = children.find((c) => c.label === "Object store")!;
          const viewport = host.gfx.viewport;
          const p = viewport.toViewCoord(
            storage.bounds[0] + storage.bounds[2] / 2,
            storage.bounds[1] + 18,
          );
          const guide = viewport.toViewCoord(
            object.bounds[0],
            object.bounds[1],
          );
          return {
            source: host.model.props.source.toString(),
            children,
            point: {
              x: p[0] + viewport.boundingClientRect.left,
              y: p[1] + viewport.boundingClientRect.top,
            },
            guide: {
              key: object.key,
              left: guide[0] + viewport.boundingClientRect.left,
              top: guide[1] + viewport.boundingClientRect.top,
            },
          };
        });
      // Rename can change the fitted owner dimensions. Navigate back to the
      // complete diagram before targeting a composite outside the current view.
      await page.keyboard.press("Alt+1");
      await page.evaluate(async () => {
        for (let frame = 0; frame < 12; frame++)
          await new Promise(requestAnimationFrame);
      });
      const nativeBefore = await nativeGeometry();
      await page.mouse.click(nativeBefore.point.x, nativeBefore.point.y);
      await expect
        .poll(() =>
          nativeBlock.evaluate((host: any) =>
            host.gfx.selection.selectedElements.map((c: any) =>
              c.text?.toString(),
            ),
          ),
        )
        .toEqual(["Storage"]);
      await page.keyboard.press("Alt+2");
      // A live camera update must move the actual SVG overlay, independently
      // of Source/selection changes that would otherwise conceal stale anchors.
      await expect
        .poll(async () => {
          const g = (await nativeGeometry()).guide;
          const rect = await page
            .locator(`svg[data-mermaid-grid-key="${g.key}"]`)
            .boundingBox();
          return rect
            ? Math.abs(rect.x - g.left) + Math.abs(rect.y - g.top)
            : Infinity;
        })
        .toBeLessThan(1);
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(
          async () =>
            (await nativeGeometry()).children.find(
              (c) => c.label === "Object store",
            )!.bounds[0],
        )
        .toBe(
          nativeBefore.children.find((c) => c.label === "Object store")!
            .bounds[0] + 1,
        );
      const nativeMoved = await nativeGeometry();
      expect(nativeMoved.source).toBe(nativeBefore.source);
      for (const label of ["Storage", "Object store", "Audit log"]) {
        const old = nativeBefore.children.find((c) => c.label === label)!;
        const next = nativeMoved.children.find((c) => c.id === old.id)!;
        expect(next.bounds).toEqual([
          old.bounds[0] + 1,
          ...old.bounds.slice(1),
        ]);
      }
      expect(
        nativeMoved.children.find((c) => c.label === "Native intake")!.bounds,
      ).toEqual(
        nativeBefore.children.find((c) => c.label === "Native intake")!.bounds,
      );
      await page.reload();
      await expect
        .poll(async () => (await nativeGeometry()).children)
        .toEqual(nativeMoved.children);
      expect((await nativeGeometry()).source).toBe(nativeBefore.source);
      await page.screenshot({
        path: testInfo.outputPath("block-native-imported.png"),
      });
      expect(errors).toEqual([]);
    } finally {
      await unlink(importedPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid State keeps ordered descriptions, scope, notes and comments across history, reload and Edgeless", async ({
    context,
    page,
    request,
  }, testInfo) => {
    // This single journey includes retained Note activation and a second cold
    // load for the native invalid owner; keep its complete cleanup bounded.
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text())) ||
          /Failed to deserialize xywh|undefined.*not valid JSON/.test(
            message.text(),
          ))
      )
        errors.push(message.text());
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
    const importedPath = testInfo.outputPath("state-import.mmd");
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-state-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const currentSource = async () =>
        (await mermaidOwnerInventory(page)).find(
          (owner) => owner.id === ownerId,
        )!.source;
      const open = async (name: string, kind: string) => {
        await block.getByRole("button", { name, exact: true }).focus();
        await page.keyboard.press("Enter");
        const form = page.getByRole("dialog", { name: kind, exact: true });
        await expect(
          form.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeVisible();
        return form;
      };
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, MERMAID_STATE_JOURNEY_FIXTURE);
      await mode.getByText("Visual", { exact: true }).click();
      await selectFacadeOption(page, block, "Diagram zoom", "50%");
      await block
        .getByRole("button", { name: "Center diagram", exact: true })
        .click();
      const ownerId = (await mermaidOwnerInventory(page))[0].id;
      const firstBody =
        "Collect publication request and requested output options";
      let form = await open(firstBody, "State description");
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .fill(`${firstBody} — reviewed`);
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .press("Enter");
      const descriptionSource = MERMAID_STATE_JOURNEY_FIXTURE.replace(
        `Draft: ${firstBody}`,
        `Draft: ${firstBody} — reviewed`,
      );
      await expect.poll(currentSource).toBe(descriptionSource);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(MERMAID_STATE_JOURNEY_FIXTURE);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect.poll(currentSource).toBe(descriptionSource);

      // Each parallel/self relation has its own record and controls, including composite endpoints.
      await block
        .getByRole("button", { name: "Transition", exact: true })
        .click();
      form = page.getByRole("dialog", { name: "Transition", exact: true });
      await selectFacadeOption(
        page,
        form,
        "Source endpoint",
        "Request draft · Draft",
      );
      await selectFacadeOption(
        page,
        form,
        "Target endpoint",
        "Request draft · Draft",
      );
      await form
        .getByRole("textbox", { name: "Selected edge label", exact: true })
        .fill("review loop");
      await form
        .getByRole("button", { name: "Preview change", exact: true })
        .click();
      expect(await currentSource()).toBe(descriptionSource);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(currentSource)
        .toContain("Draft --> Draft: review loop");
      form = await open("review loop", "Transition");
      const loopSource = await currentSource();
      await selectFacadeOption(
        page,
        form,
        "Target endpoint",
        "Release processing · Release",
      );
      await form
        .getByRole("button", { name: "Preview change", exact: true })
        .click();
      expect(await currentSource()).toBe(loopSource);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        form.getByRole("textbox", { name: "Selected edge label", exact: true }),
      ).toHaveCount(0);
      expect(await currentSource()).toBe(loopSource);
      // Exercise the actual endpoint grips against a Composite header. Form
      // reconnect alone would miss both the shared hit-test and command guard.
      const compositePoint = () =>
        block.evaluate((element) => {
          const host = element as HTMLElement & {
            _getMermaidVisualModelForEditing(): {
              subgraphs: Array<{ id: string; title: string }>;
            };
            _getVisualSubgraphGfxModel(id: string): { xywh: string };
            _gfxViewportBridge: {
              getViewportElement(): HTMLElement;
              getModelViewRect(xywh: string): { left: number; top: number };
            };
          };
          const group = host
            ._getMermaidVisualModelForEditing()
            .subgraphs.find((group) => group.title === "Release processing")!;
          const viewport = host._gfxViewportBridge
            .getViewportElement()
            .getBoundingClientRect();
          const bound = host._gfxViewportBridge.getModelViewRect(
            host._getVisualSubgraphGfxModel(group.id).xywh,
          );
          return {
            x: viewport.left + bound.left + 8,
            y: viewport.top + bound.top + 13,
            panX: bound.left - viewport.width / 2,
            panY: bound.top - 35,
            centerX: viewport.left + viewport.width / 2,
            centerY: viewport.top + viewport.height / 2,
            visible:
              bound.left + 8 >= 0 &&
              bound.left + 8 < viewport.width &&
              bound.top + 13 >= 0 &&
              bound.top + 13 < viewport.height,
          };
        });
      for (const endpoint of ["target", "source"] as const) {
        form = await open("review loop", "Transition");
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(
          form.getByRole("textbox", {
            name: "Selected edge label",
            exact: true,
          }),
        ).toHaveCount(0);
        const pan = await compositePoint();
        await page.mouse.move(pan.centerX, pan.centerY);
        await page.mouse.wheel(pan.panX, pan.panY);
        await expect
          .poll(async () => (await compositePoint()).visible)
          .toBe(true);
        const target = await compositePoint();
        const grip = block.getByRole("button", {
          name: `Reconnect edge ${endpoint}`,
          exact: true,
        });
        const start = await grip.boundingBox();
        if (!start)
          throw new Error("State reconnect grip has no rendered bounds");
        await page.mouse.move(
          start.x + start.width / 2,
          start.y + start.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 8 });
        expect(await currentSource()).toBe(loopSource);
        await page.mouse.up();
        await expect
          .poll(currentSource)
          .toBe(
            loopSource.replace(
              "Draft --> Draft: review loop",
              endpoint === "target"
                ? "Draft --> Release: review loop"
                : "Release --> Draft: review loop",
            ),
          );
        await block.getByRole("button", { name: "Undo", exact: true }).click();
        await expect.poll(currentSource).toBe(loopSource);
      }
      form = await open("review loop", "Transition");
      await selectFacadeOption(
        page,
        form,
        "Target endpoint",
        "Published release · Published",
      );
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const reconnectSource = loopSource.replace(
        "Draft --> Draft: review loop",
        "Draft --> Published: review loop",
      );
      await expect.poll(currentSource).toBe(reconnectSource);

      form = await open("Queue", "State");
      await selectFacadeOption(
        page,
        form,
        "Region",
        "Release processing · Region 2",
      );
      await form.getByRole("button", { name: "Move", exact: true }).click();
      expect(await currentSource()).toBe(reconnectSource);
      await page.getByTestId("confirm-modal-cancel").click();
      await expect(page.getByTestId("confirm-modal-cancel")).toBeHidden();
      expect(await currentSource()).toBe(reconnectSource);
      await form.getByRole("button", { name: "Move", exact: true }).click();
      await page.getByTestId("confirm-modal-confirm").click();
      const scopedSource = await currentSource();
      expect(scopedSource).not.toBe(reconnectSource);
      await page.keyboard.press("Escape");
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(reconnectSource);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect.poll(currentSource).toBe(scopedSource);

      form = await open("Rollback remains available", "Note");
      await form
        .getByRole("textbox", { name: "Note", exact: true })
        .fill("Rollback remains available after review");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const noteSource = scopedSource.replace(
        'note "Rollback remains available"',
        'note "Rollback remains available after review"',
      );
      await expect.poll(currentSource).toBe(noteSource);
      form = await open("Rollback remains available after review", "Note");
      await form.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByTestId("confirm-modal-confirm").click();
      await expect(page.getByTestId("confirm-modal-confirm")).toBeHidden();
      await expect.poll(currentSource).not.toContain('note "Rollback remains');
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(currentSource).toBe(noteSource);
      form = await open("schema valid", "Transition");
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        form.getByRole("textbox", { name: "Selected edge label", exact: true }),
      ).toHaveCount(0);
      await block
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Comments", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const marker = block
        .locator('[data-myoxus-ui-role="mermaid-state-comment-marker"]')
        .filter({
          has: page.locator('button[aria-label*="schema valid"]'),
        });
      // The comment marker's real pointer target opens the anchored source record.
      await marker.getByRole("button").click();
      await page
        .getByRole("textbox", { name: "Comments", exact: true })
        .first()
        .fill("Schema validation was reviewed.");
      await page
        .getByRole("button", { name: "Save", exact: true })
        .first()
        .click();
      const edited = noteSource.replace(
        "This comment belongs to the schema validation state.",
        "Schema validation was reviewed.",
      );
      await expect.poll(currentSource).toBe(edited);
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: testInfo.outputPath("state-page-edited.png"),
      });
      const geometryBefore = (await mermaidOwnerInventory(page)).find(
        (owner) => owner.id === ownerId,
      )!;
      await page.evaluate(async (id) => {
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
        if (!workspace || !id) throw new Error("No active State document");
        const signal = AbortSignal.timeout(20_000);
        await workspace.engine.doc.waitForSynced(id, signal);
        await workspace.engine.doc.waitForSynced(workspace.id, signal);
      }, docId);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      const reloaded = (await mermaidOwnerInventory(page)).find(
        (owner) => owner.id === ownerId,
      )!;
      expect(reloaded.childIds).toEqual(geometryBefore.childIds);
      expect(reloaded.childBounds).toEqual(geometryBefore.childBounds);
      // First moves after reload consume retained geometry. This also catches
      // rebasing watcher-owned connector bounds from an absent Y.Map field.
      await mode.getByText("Visual", { exact: true }).click();
      const statePoint = (id: string) =>
        block.evaluate((element, id) => {
          const host = element as HTMLElement & {
            _getMermaidVisualModelForEditing(): {
              nodes: Array<{
                id: string;
                familyData: { payload: { binding: { sourceId: string } } };
              }>;
            };
            _getVisualNodeGfxModel(id: string): { xywh: string };
            _gfxViewportBridge: {
              getViewportElement(): HTMLElement;
              getModelViewRect(xywh: string): {
                left: number;
                top: number;
                width: number;
                height: number;
              };
            };
          };
          const node = host
            ._getMermaidVisualModelForEditing()
            .nodes.find(
              (node) => node.familyData.payload.binding.sourceId === id,
            )!;
          const xywh = host._getVisualNodeGfxModel(node.id).xywh;
          const geometry = JSON.parse(xywh) as number[];
          const rect = host._gfxViewportBridge.getModelViewRect(xywh);
          const viewport = host._gfxViewportBridge
            .getViewportElement()
            .getBoundingClientRect();
          return {
            key: node.id,
            geometry,
            zoom: rect.width / geometry[2],
            x: viewport.left + rect.left + rect.width / 2,
            y: viewport.top + rect.top + Math.min(rect.height / 2, 10),
            panX: rect.left - 70,
            panY: rect.top - 70,
            visible:
              rect.left + rect.width / 2 >= 0 &&
              rect.left + rect.width / 2 < viewport.width &&
              viewport.top + rect.top + Math.min(rect.height / 2, 10) >=
                Math.max(viewport.top, 0) &&
              viewport.top + rect.top + Math.min(rect.height / 2, 10) <
                Math.min(viewport.bottom, innerHeight),
            centerX: viewport.left + viewport.width / 2,
            centerY:
              (Math.max(viewport.top, 0) +
                Math.min(viewport.bottom, innerHeight)) /
              2,
          };
        }, id);
      for (const id of ["Draft", "Published", "Schema"]) {
        const before = await statePoint(id);
        await page.mouse.move(before.centerX, before.centerY);
        await page.mouse.wheel(before.panX, before.panY);
        await expect
          .poll(async () => (await statePoint(id)).visible)
          .toBe(true);
        const point = await statePoint(id);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 14, point.y + 10, { steps: 6 });
        await page.mouse.up();
        await expect
          .poll(async () => (await statePoint(id)).geometry[0])
          .toBeCloseTo(before.geometry[0] + 14 / point.zoom, 1);
        const moved = await statePoint(id);
        expect(moved.geometry[1]).toBeCloseTo(
          before.geometry[1] + 10 / point.zoom,
          1,
        );
        expect(moved.key).toBe(before.key);
        expect(await currentSource()).toBe(edited);
        await block.getByRole("button", { name: "Undo", exact: true }).click();
        await expect
          .poll(async () => (await statePoint(id)).geometry)
          .toEqual(before.geometry);
      }
      await mode.getByText("Source", { exact: true }).click();
      // Invalid Source retains its owner and exposes a concrete read-only last-valid projection.
      await writeMermaidSource(source, `${edited}\nstate Broken {`);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("status", {
          name: "Last valid Mermaid preview",
          exact: true,
        }),
      ).toContainText("Broken: }");
      await expect(
        block.getByRole("button", { name: "State", exact: true }).first(),
      ).toHaveCount(0);
      const invalidSource = await currentSource();
      await page.getByTestId("switch-edgeless-mode-button").click();
      const invalidMask = page.locator(".myoxus-note-mask").first();
      await invalidMask.click({ position: { x: 35, y: 40 } });
      await invalidMask.dblclick({ position: { x: 35, y: 40 } });
      await block.locator(".myoxus-mermaid-gfx-viewport").click({
        position: { x: 40, y: 50 },
      });
      // An opened retained Note stays readable; readonly must not force its
      // active viewport back to the passive whole-diagram thumbnail.
      await expect
        .poll(async () => (await statePoint("Draft")).zoom)
        .toBeGreaterThanOrEqual(1);
      await expect.poll(currentSource).toBe(invalidSource);
      await expect(source).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("state-embedded-invalid-active.png"),
      });
      await page.getByTestId("switch-page-mode-button").click();
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(
        source,
        edited.replace("stateDiagram-v2", "stateDiagram"),
      );
      await mode.getByText("Visual", { exact: true }).click();
      form = await open(`${firstBody} — reviewed`, "State description");
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .fill(`${firstBody} — v1 reviewed`);
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .press("Enter");
      const v1 = edited
        .replace("stateDiagram-v2", "stateDiagram")
        .replace(`${firstBody} — reviewed`, `${firstBody} — v1 reviewed`);
      await expect.poll(currentSource).toBe(v1);
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, edited);
      await mode.getByText("Visual", { exact: true }).click();

      await page
        .getByRole("radio", { name: "Edgeless", exact: true })
        .locator("..")
        .click();
      await page.locator("myoxus-edgeless-root").waitFor({ state: "visible" });
      const noteMask = page.locator(".myoxus-note-mask").first();
      await noteMask.click({ position: { x: 35, y: 40 } });
      await noteMask.dblclick({ position: { x: 35, y: 40 } });
      await expect(
        page.locator('[data-testid="edgeless-note-container"]').first(),
      ).toHaveAttribute("data-editing", "true");
      const heading = block.getByRole("button", {
        name: "Request draft",
        exact: true,
      });
      await heading.focus();
      await expect(
        block.locator('[data-myoxus-ui-role="mermaid-embedded-actions"]'),
      ).toBeVisible();
      await heading.focus();
      await page.keyboard.press("Enter");
      form = page.getByRole("dialog", { name: "State", exact: true });
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      // The dense Note is taller than the desktop viewport. A keyboard-only
      // edit would miss a 3E toolbar below the excerpt or behind the root dock.
      await block
        .locator('[data-myoxus-ui-role="mermaid-embedded-actions"]')
        .getByRole("button", { name: "State", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          block.evaluate((element) => {
            const host = element as unknown as {
              _pendingVisualInsertShape: unknown;
              _pendingVisualNodePlacement: unknown;
              _isActiveEmbeddedGfxEditor(): boolean;
            };
            return {
              active: host._isActiveEmbeddedGfxEditor(),
              pending: Boolean(
                host._pendingVisualInsertShape ||
                host._pendingVisualNodePlacement,
              ),
            };
          }),
        )
        .toEqual({ active: true, pending: false });
      expect(await currentSource()).toBe(edited);
      const description = block.getByRole("button", {
        name: `${firstBody} — reviewed`,
        exact: true,
      });
      await description.focus();
      await expect(
        block.locator('[data-myoxus-ui-role="mermaid-embedded-actions"]'),
      ).toBeVisible();
      await description.focus();
      await page.keyboard.press("Enter");
      form = page.getByRole("dialog", {
        name: "State description",
        exact: true,
      });
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .fill(`${firstBody} — embedded reviewed`);
      await form
        .getByRole("textbox", { name: "State description", exact: true })
        .press("Enter");
      const embeddedSource = edited.replace(
        `${firstBody} — reviewed`,
        `${firstBody} — embedded reviewed`,
      );
      await expect.poll(currentSource).toBe(embeddedSource);
      await expect(source).toHaveCount(0);
      await expect(mode).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("state-embedded-edited.png"),
      });
      const ownersBeforeImport = new Set(
        (await mermaidOwnerInventory(page)).map((owner) => owner.id),
      );
      await writeFile(importedPath, embeddedSource, "utf8");
      await importMermaidFile(page, importedPath);
      await expect
        .poll(
          async () =>
            (await mermaidOwnerInventory(page)).filter(
              (owner) => !ownersBeforeImport.has(owner.id),
            ).length,
        )
        .toBe(1);
      const native = (await mermaidOwnerInventory(page)).find(
        (owner) => !ownersBeforeImport.has(owner.id),
      )!;
      expect(native.parentFlavor).toBe("myoxus:surface");
      expect(native.source).toBe(embeddedSource);
      const nativeBlock = page.locator(
        `myoxus-edgeless-mermaid[data-block-id="${native.id}"]`,
      );
      const nativeBodyGeometry = () =>
        nativeBlock.evaluate((element) => {
          const host = element as unknown as {
            model: {
              childElements: { id: string; type: string; xywh: string }[];
            };
          };
          // Connector bounds belong to the local routing watcher. Retention
          // protects the persisted bodies, not an outgoing derived path cache.
          return host.model.childElements
            .filter((child) => child.type !== "connector")
            .map(({ id, xywh }) => ({ id, xywh }));
        });
      const originalNativeBodies = await nativeBodyGeometry();
      await page.keyboard.press("Alt+1");
      await expect(
        page.getByRole("button", { name: "Export .mmd", exact: true }),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export .mmd", exact: true })
        .click();
      const exportPath = await (await download).path();
      if (!exportPath) throw new Error("State export has no path");
      expect(await readFile(exportPath, "utf8")).toBe(embeddedSource);
      await page.screenshot({
        path: testInfo.outputPath("state-native-imported.png"),
      });
      // Provision an invalid native Source without inventing an Edgeless
      // Source editor. Cold load must keep its children and refresh the notice
      // when the retained Source's asynchronous validation settles.
      const nativeInvalidSource = `${embeddedSource}\nstate Broken {`;
      await page.locator("myoxus-edgeless-root").evaluate(
        (element, { id, invalidSource, retainedSource }) => {
          const root = element as unknown as {
            std: {
              store: {
                getBlock(id: string): {
                  model: {
                    props: {
                      source: {
                        length: number;
                        replace(
                          index: number,
                          length: number,
                          value: string,
                        ): void;
                      };
                    };
                  };
                };
                updateBlock(
                  model: unknown,
                  props: { lastValidSource: string },
                ): void;
                captureSync(): void;
              };
            };
          };
          const store = root.std.store;
          const model = store.getBlock(id).model;
          store.captureSync();
          store.updateBlock(model, { lastValidSource: retainedSource });
          model.props.source.replace(
            0,
            model.props.source.length,
            invalidSource,
          );
          store.captureSync();
        },
        {
          id: native.id,
          invalidSource: nativeInvalidSource,
          retainedSource: embeddedSource,
        },
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(nativeBlock.getByRole("alert")).toContainText(
        "Last valid Mermaid preview",
      );
      const nativePoint = () =>
        nativeBlock.evaluate((element) => {
          const host = element as unknown as {
            model: { xywh: string };
            gfx: {
              viewport: {
                toViewCoord(x: number, y: number): number[];
                boundingClientRect: DOMRect;
              };
            };
          };
          const [x, y] = JSON.parse(host.model.xywh) as number[];
          const viewport = host.gfx.viewport;
          const point = viewport.toViewCoord(x + 3, y + 3);
          return {
            x: viewport.boundingClientRect.left + point[0],
            y: viewport.boundingClientRect.top + point[1],
          };
        });
      const nativeBeforePan = await nativePoint();
      await page.mouse.move(1100, 450);
      await page.mouse.wheel(nativeBeforePan.x - 850, nativeBeforePan.y - 420);
      await expect
        .poll(async () => (await nativePoint()).x)
        .toBeCloseTo(850, 0);
      const nativeHit = await nativePoint();
      await page.mouse.click(nativeHit.x, nativeHit.y);
      await expect
        .poll(() =>
          page.locator("myoxus-edgeless-root").evaluate(
            (element) =>
              (
                element as unknown as {
                  gfx: { selection: { selectedIds: string[] } };
                }
              ).gfx.selection.selectedIds,
          ),
        )
        .toEqual([native.id]);
      // The Page hover fill used to hide every retained child on selection.
      await expect
        .poll(() =>
          page.locator("myoxus-drag-handle-widget").evaluate((element) => {
            const rect = element.shadowRoot?.querySelector(
              ".myoxus-drag-hover-rect",
            );
            if (!rect) throw new Error("Drag hover rectangle is unavailable");
            return getComputedStyle(rect).display;
          }),
        )
        .toBe("none");
      const retainedNative = (await mermaidOwnerInventory(page)).find(
        (owner) => owner.id === native.id,
      )!;
      expect(retainedNative.source).toBe(nativeInvalidSource);
      expect(retainedNative.childIds).toEqual(native.childIds);
      expect(await nativeBodyGeometry()).toEqual(originalNativeBodies);
      await page.screenshot({
        path: testInfo.outputPath("state-native-invalid-cold.png"),
      });
      expect(errors).toEqual([]);
    } finally {
      await unlink(importedPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Packet keeps multirow boundaries and exact source across history, reload and embedded Edgeless", async ({
    context,
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        errors.push(message.text());
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
      await page.getByTestId("slash-menu-item-mermaid-packet-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture =
        '---\nconfig: {packet: {bitsPerRow: 32, bitWidth: 24}}\n---\npacket-beta\n  title Transport\n  %% Version comment\n  0-3: "Version"\n  +8: "Traffic class"\n  12-31: "Flow label"\n  %% Transport comment\n  +16: "Payload length"\n  +8: "Next header"\n  56-71: "Hop limit"\n  +24: "Destination prefix"';
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(block.locator("[data-packet-row]")).toHaveCount(3);
      const hop = block
        .locator('[data-myoxus-ui-role="packet-bit-field"]')
        .filter({ hasText: "Hop limit" });
      await expect(hop).toHaveCount(2);
      await hop.first().click();
      const boundary = (bit: number) =>
        block.getByRole("button", {
          name: `Hop limit: boundary before bit ${bit}`,
          exact: true,
        });
      await boundary(72).press("ArrowRight");
      await boundary(73).press("Escape");
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await hop.first().click();
      await boundary(72).press("ArrowRight");
      await boundary(73).press("Enter");
      const edited = fixture
        .replace("56-71:", "56-72:")
        .replace("+24:", "+23:");
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(source).toHaveValue(fixture);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(source).toHaveValue(edited);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(edited);
      const invalid =
        'packet-beta\n  title Invalid gap\n  0-3: "Version"\n  8-15: "Length"';
      await writeMermaidSource(source, invalid);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("button", { name: "Add field", exact: true }),
      ).toBeDisabled();
      await expect(block.locator("[data-packet-boundary-left]")).toHaveCount(0);
      await expect(block.getByRole("alert").first()).toBeVisible();
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(invalid);
      await writeMermaidSource(source, edited);
      await mode.getByText("Visual", { exact: true }).click();
      await expect(
        block.getByRole("button", { name: "Add field", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("radio", { name: "Edgeless", exact: true })
        .locator("..")
        .click();
      await page
        .locator("myoxus-edgeless-note")
        .dblclick({ position: { x: 120, y: 100 } });
      await hop.first().click();
      await expect(
        block.getByRole("button", { name: "Add field", exact: true }),
      ).toBeEnabled();
      await expect(
        block.getByRole("textbox", { name: "Mermaid source", exact: true }),
      ).toHaveCount(0);
      await boundary(73).press("ArrowRight");
      await boundary(74).press("Enter");
      await page
        .getByRole("radio", { name: "Page", exact: true })
        .locator("..")
        .click();
      await mode.getByText("Source", { exact: true }).click();
      await expect(source).toHaveValue(
        edited.replace("56-72:", "56-73:").replace("+23:", "+22:"),
      );
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid Journey keeps exact source and membership across draft, history and reload", async ({
    context,
    page,
    request,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message.text()))
      )
        runtimeErrors.push(message.text());
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    const preferenceTarget = { request, gqlEndpoint: GQL, cookies };
    const originalLocale = await getAccountLocale(preferenceTarget);
    await setAccountLocale(preferenceTarget, "en");
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-journey-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        "[data-myoxus-ui-role=mermaid-editor-mode-control]",
      );
      const sourceEditor = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      const fixture =
        '---\ntitle: "Retention journey"\nconfig: {journey: {width: 210, retained: "foreign"}}\n---\n%%{init: {"journey": {"height": 70}}}%%\njourney\n  accTitle: Recovery\n  section Same\n    %% travels with the first duplicate\n    Same: 2.50e0: QA, QA: retained\n\n%% position stays\n\n  section Same\n    Same: 4: Support';
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(sourceEditor, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      const map = block.getByTestId("mermaid-journey-map");
      await expect(map).toBeVisible();
      await block
        .getByRole("button", { name: "Add section", exact: true })
        .click();
      const draft = block.getByRole("textbox");
      await draft.fill("Cancelled section");
      await draft.press("Escape");
      await mode.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(fixture);
      await mode.getByText("Visual", { exact: true }).click();
      const first = map.locator("[data-step-id]").first();
      const id = await first.getAttribute("data-step-id");
      if (!id) throw new Error("Journey step has no session identity");
      const selected = map.locator(`[data-step-id="${id}"]`);
      await selected.click({ position: { x: 10, y: 70 } });
      await expect(selected).toHaveAttribute("data-selected", "true");
      await selected.press("Enter");
      await page
        .getByRole("textbox", { name: "Score", exact: true })
        .fill("2.75");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(selected).toBeFocused();
      const grip = selected.getByRole("button", {
        name: "Move step: Same",
        exact: true,
      });
      await grip.press("Space");
      await grip.press("ArrowRight");
      await grip.press("ArrowDown");
      await expect(map.locator("path[stroke-dasharray]")).toHaveCount(1);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(map.locator("path[stroke-dasharray]")).toHaveCount(0);
      await expect(grip).toHaveAttribute("aria-pressed", "false");
      await mode.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(fixture);
      await mode.getByText("Visual", { exact: true }).click();
      await grip.press("Space");
      await grip.press("ArrowRight");
      await grip.press("ArrowDown");
      await grip.press("Enter");
      await expect(
        map
          .locator("[data-section-id]")
          .last()
          .locator(`[data-step-id="${id}"]`),
      ).toBeVisible();
      const moved =
        fixture.replace(
          "    %% travels with the first duplicate\n    Same: 2.50e0: QA, QA: retained\n",
          "",
        ) +
        "\n    %% travels with the first duplicate\n    Same: 2.50e0: QA, QA: retained";
      await mode.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(moved);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(sourceEditor).toHaveValue(fixture);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect(sourceEditor).toHaveValue(moved);
      await page.reload();
      await block.waitFor({ state: "visible" });
      await mode.getByText("Source", { exact: true }).click();
      await expect(sourceEditor).toHaveValue(moved);
      await mode.getByText("View", { exact: true }).click();
      await expect(
        block.locator(".myoxus-mermaid-display-preview svg"),
      ).toBeVisible();
      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await setAccountLocale(preferenceTarget, originalLocale);
      await signOutViaApi(request, API, cookies);
    }
  });
  test("Mermaid C4 keeps Type focus, Source bindings, native geometry and Clipboard through history", async ({
    context,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    let docId: string | undefined;
    let imported = false;

    const file = testInfo.outputPath("c4-import.mmd");
    const fixture = [
      "---",
      "title: C4 regression",
      "---",
      "C4Container",
      'UpdateElementStyle(api, $bgColor="red")',
      '  System_Boundary(team, "Team") {',
      "    %% retained API record",
      '    Container( "api", "Initial API", "Rust")',
      '    UpdateElementStyle(api, $descr="Owns requests")',
      '    Container( "api", "API", "Rust")',
      '    ContainerDb(cache, "Cache", "Redis")',
      "  }",
      '  Person(user, "User")',
      '  Rel(user, api, "Uses")',
      "",
    ].join("\n");
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-c4-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, fixture);
      await mode.getByText("Visual", { exact: true }).click();
      const api = block
        .getByRole("button", { name: "API", exact: true })
        .and(block.locator('[data-object-kind="node"]'));
      await expect(api).toBeVisible();
      const ownerId = (await mermaidOwnerInventory(page))[0].id;
      const current = async () =>
        (await mermaidOwnerInventory(page)).find((o) => o.id === ownerId)!;
      const before = await current();
      expect(before.childIds.length).toBeGreaterThan(3);
      await api.press("Enter");
      let form = page.getByRole("dialog").filter({
        has: page.getByRole("combobox", { name: "Type", exact: true }),
      });
      await selectFacadeOption(page, form, "Type", "ContainerDb");
      await expect(form).toBeVisible();
      await form.getByRole("combobox", { name: "Type", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(form).toBeVisible();
      await form
        .getByRole("button", { name: "Preview change", exact: true })
        .click();
      expect((await current()).source).toBe(fixture);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(form).toBeHidden();
      expect(await current()).toEqual(before);
      await api.press("Enter");
      form = page.getByRole("dialog").filter({
        has: page.getByRole("combobox", { name: "Type", exact: true }),
      });
      await selectFacadeOption(page, form, "Type", "ContainerDb");
      await form.getByRole("button", { name: "Apply", exact: true }).click();
      const changed = fixture.replace(
        'Container( "api", "API"',
        'ContainerDb( "api", "API"',
      );
      await expect.poll(async () => (await current()).source).toBe(changed);
      expect((await current()).childIds).toEqual(before.childIds);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(current).toEqual(before);
      await block.getByRole("button", { name: "Redo", exact: true }).click();
      await expect.poll(async () => (await current()).source).toBe(changed);
      const beforeEmpty = await current();
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(source, "C4Container\n");
      await mode.getByText("Visual", { exact: true }).click();
      await expect.poll(async () => (await current()).childIds).toEqual([]);
      await block.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(current).toEqual(beforeEmpty);
      // Cold reload checks persisted history, after the normal sync engine has
      // acknowledged this document and its workspace inventory.
      await page.evaluate(async (id) => {
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
        if (!workspace) throw new Error("No active workspace");
        const signal = AbortSignal.timeout(20_000);
        await workspace.engine.doc.waitForSynced(id, signal);
        await workspace.engine.doc.waitForSynced(workspace.id, signal);
      }, docId);
      await page.reload();
      await expect(api).toBeVisible();
      await expect.poll(current).toEqual(beforeEmpty);
      await page.getByTestId("switch-edgeless-mode-button").click();
      const mask = page.locator(".myoxus-note-mask").first();
      await mask.click({ position: { x: 35, y: 40 } });
      await mask.dblclick({ position: { x: 35, y: 40 } });
      await api.press("Enter");
      form = page.getByRole("dialog").filter({
        has: page.getByRole("combobox", { name: "Type", exact: true }),
      });
      await selectFacadeOption(page, form, "Type", "ContainerQueue");
      await expect(form).toBeVisible();
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await current()).source).toBe(changed);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await writeFile(file, changed, "utf8");
      imported = true;
      await importMermaidFile(page, file);
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(2);
      const native = (await mermaidOwnerInventory(page)).find(
        (o) => o.id !== ownerId,
      )!;
      expect(native.source).toBe(changed);
      const nativePoint = async (whole = false, id = native.id) =>
        page.evaluate(
          ({ id, whole }) => {
            const root = document.querySelector(
              "myoxus-edgeless-root",
            ) as unknown as {
              std: {
                store: {
                  getBlock(id: string): {
                    model: {
                      xywh: string;
                      childElements: Array<{
                        xywh: string;
                        yMap: { get(key: string): unknown };
                      }>;
                    };
                  };
                };
              };
              gfx: {
                viewport: {
                  boundingClientRect: { left: number; top: number };
                  toViewCoord(x: number, y: number): number[];
                };
              };
            };
            const m = root.std.store.getBlock(id).model;
            const e = m.childElements.find(
              (e) =>
                e.yMap.get("mermaidRole") === "mermaid-flowchart-node" &&
                e.yMap.get("mermaidNodeLabel") === "API",
            );
            if (!e) throw new Error("Native C4 API body is missing");
            const b = JSON.parse(whole ? m.xywh : e.xywh) as number[];
            const v = root.gfx.viewport.boundingClientRect;
            const p = root.gfx.viewport.toViewCoord(
              whole ? b[0] + b[2] - 12 : b[0] + b[2] / 2,
              whole ? b[1] + b[3] - 12 : b[1] + b[3] / 2,
            );
            return { x: p[0] + v.left, y: p[1] + v.top };
          },
          { id, whole },
        );
      let point = await nativePoint();
      await page.mouse.click(point.x, point.y);
      const handle = page.locator('.handle[aria-label="bottom-right"]').first();
      const h = await handle.boundingBox();
      if (!h) throw new Error("Native C4 resize handle is missing");
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 55, h.y + h.height / 2 + 35, {
        steps: 8,
      });
      const mid = (await mermaidOwnerInventory(page)).find(
        (o) => o.id === native.id,
      )!;
      expect(mid.source).toBe(changed);
      expect(mid.childBounds).not.toEqual(native.childBounds);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect
        .poll(async () =>
          (await mermaidOwnerInventory(page)).find((o) => o.id === native.id),
        )
        .toEqual(native);
      await page.keyboard.press("Alt+1");
      point = await nativePoint(true);
      expect(point.x).toBeLessThan(page.viewportSize()!.width);
      expect(point.y).toBeLessThan(page.viewportSize()!.height);
      await page.mouse.click(point.x, point.y);
      await expect
        .poll(() =>
          page.locator("myoxus-edgeless-root").evaluate(
            (element) =>
              (
                element as unknown as {
                  gfx: { selection: { selectedIds: string[] } };
                }
              ).gfx.selection.selectedIds,
          ),
        )
        .toEqual([native.id]);
      await page.locator("myoxus-edgeless-root").press("Control+c");
      await page.locator("myoxus-edgeless-root").press("Control+v");
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(3);
      const copied = (await mermaidOwnerInventory(page)).find(
        (o) => o.id !== native.id && o.id !== ownerId,
      )!;
      expect(copied.source).toBe(changed);
      expect(copied.childIds).toHaveLength(native.childIds.length);
      expect(copied.childIds.every((id) => !native.childIds.includes(id))).toBe(
        true,
      );
      await page.keyboard.press("Alt+1");
      point = await nativePoint(false, copied.id);
      await page.mouse.click(point.x, point.y);
      await page
        .getByRole("button", { name: "API", exact: true })
        .last()
        .click();
      form = page.getByRole("dialog").filter({
        has: page.getByRole("combobox", { name: "Type", exact: true }),
      });
      await expect(
        form.getByRole("combobox", { name: "Type", exact: true }),
      ).toHaveValue("ContainerDb");
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(
        (await mermaidOwnerInventory(page)).find((o) => o.id === copied.id)!
          .source,
      ).toBe(changed);
      await expect(
        page.locator(
          "iframe#rspack-dev-server-client-overlay, iframe#webpack-dev-server-client-overlay",
        ),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      if (imported) await unlink(file);
      await signOutViaApi(request, API, cookies);
    }
  });

  test("Mermaid GitGraph keeps empty-branch focus, minimal Source patches, history and native Clipboard", async ({
    context,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
    let docId: string | undefined;
    let imported = false;
    const file = testInfo.outputPath("gitgraph-import.mmd");
    const fixture = [
      "---",
      "title: GitGraph regression",
      "---",
      "gitGraph LR:",
      '  commit id:"base" msg:"Initial shell" tag:"v0.1"',
      "  branch feature",
      '  commit id:"feature-work" msg:"Direct editor" tag:"editor"',
      "  checkout main",
      '  merge feature id:"merged" type:HIGHLIGHT tag:"release"',
      '  cherry-pick id:"feature-work" tag:"backport"',
      '  commit id:"release" msg:"Release notes" tag:"docs" tag:"stable"',
      "",
    ].join("\n");
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page
        .getByTestId("slash-menu-item-mermaid-gitgraph-basic")
        .click({ noWaitAfter: true });
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
      );
      const source = block.getByRole("textbox", {
        name: "Mermaid source",
        exact: true,
      });
      await mode
        .getByText("Source", { exact: true })
        .click({ noWaitAfter: true });
      const emptyMain =
        'gitGraph LR:\n  branch feature\n  commit id:"only-feature" msg:"Main remains empty"\n';
      await writeMermaidSource(source, emptyMain);
      await mode
        .getByText("Visual", { exact: true })
        .click({ noWaitAfter: true });
      const onlyFeature = block.getByRole("button", {
        name: /^Commit · only-feature ·/,
      });
      await onlyFeature.focus();
      await onlyFeature.press("Enter");
      let form = page.getByRole("dialog").filter({
        has: page.getByRole("textbox", { name: "Message", exact: true }),
      });
      await form
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ noWaitAfter: true });
      await expect(onlyFeature).toBeFocused();
      await onlyFeature.press("ArrowUp");
      const main = block.getByRole("button", { name: /^Branch · main ·/ });
      await expect(main).toBeFocused();
      await block
        .getByRole("button", { name: "Commit", exact: true })
        .click({ noWaitAfter: true });
      form = page.getByRole("dialog").filter({
        has: page.getByRole("textbox", { name: "Message", exact: true }),
      });
      await expect(
        form.getByRole("combobox", { name: "Sequence location", exact: true }),
      ).toHaveValue("1 · Branch · main");
      await form
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ noWaitAfter: true });
      await main.focus();
      await main.press("Home");
      const origin = block.getByRole("button", { name: /^Origin · main ·/ });
      await expect(origin).toBeFocused();
      await origin.press("ArrowDown");
      await expect(onlyFeature).toBeFocused();
      await mode
        .getByText("Source", { exact: true })
        .click({ noWaitAfter: true });
      await expect(source).toHaveValue(emptyMain);
      await writeMermaidSource(source, fixture);
      await mode
        .getByText("Visual", { exact: true })
        .click({ noWaitAfter: true });
      const ownerId = (await mermaidOwnerInventory(page))[0].id;
      const current = async () =>
        (await mermaidOwnerInventory(page)).find((o) => o.id === ownerId)!;
      const before = await current();
      const feature = block.getByRole("button", {
        name: /^Commit · feature-work ·/,
      });
      await feature.focus();
      await feature.press(" ");
      const stableTag = block.getByRole("button", {
        name: /^Tags · stable · 2 ·/,
      });
      await stableTag.focus();
      await stableTag.press("Enter");
      form = page.getByRole("dialog").filter({
        has: page.getByRole("textbox", { name: "Message", exact: true }),
      });
      await expect(
        form.getByRole("textbox", { name: "Message", exact: true }),
      ).toHaveValue("Release notes");
      await expect(form).toContainText(
        "Head / parents: Generated value — read only",
      );
      await expect(
        form.getByRole("textbox", { name: "Tags", exact: true }).nth(1),
      ).toBeFocused();
      await form
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Reviewed release notes");
      await selectFacadeOption(page, form, "Type", "REVERSE");
      await form
        .getByRole("button", { name: "Preview change", exact: true })
        .click({ noWaitAfter: true });
      expect((await current()).source).toBe(fixture);
      await form
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ noWaitAfter: true });
      await expect(stableTag).toBeFocused();
      expect(await current()).toEqual(before);
      await stableTag.press("ArrowLeft");
      const cherry = block.getByRole("button", {
        name: /^Cherry-pick · cherry-pick ·/,
      });
      await expect(cherry).toBeFocused();
      await cherry.press("ArrowRight");
      await expect(
        block.getByRole("button", { name: /^Commit · release ·/ }),
      ).toBeFocused();
      await feature.focus();
      await feature.press("Delete");
      const deletion = page.getByRole("dialog", {
        name: "Delete",
        exact: true,
      });
      await expect(deletion).toContainText("commit · feature-work");
      await expect(deletion).not.toContainText("commit · release");
      await deletion
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ noWaitAfter: true });
      await expect(feature).toBeFocused();
      expect(await current()).toEqual(before);
      await feature.press("Enter");
      form = page.getByRole("dialog").filter({
        has: page.getByRole("textbox", { name: "Message", exact: true }),
      });
      await form
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Reviewed direct editor");
      await form
        .getByRole("button", { name: "Apply change", exact: true })
        .click({ noWaitAfter: true });
      const changed = fixture.replace(
        'msg:"Direct editor"',
        'msg:"Reviewed direct editor"',
      );
      await expect.poll(async () => (await current()).source).toBe(changed);
      expect((await current()).childIds).toEqual(before.childIds);
      await block
        .getByRole("button", { name: "Undo", exact: true })
        .click({ noWaitAfter: true });
      await expect.poll(current).toEqual(before);
      await block
        .getByRole("button", { name: "Redo", exact: true })
        .click({ noWaitAfter: true });
      await expect.poll(async () => (await current()).source).toBe(changed);
      const persisted = await current();
      await page.evaluate(async (id) => {
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
        if (!workspace) throw new Error("No active workspace");
        const signal = AbortSignal.timeout(20_000);
        await workspace.engine.doc.waitForSynced(id, signal);
        await workspace.engine.doc.waitForSynced(workspace.id, signal);
      }, docId);
      await page.reload();
      await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
        timeout: 20_000,
      });
      await expect(feature).toBeVisible();
      await expect.poll(current).toEqual(persisted);
      await page.getByTestId("switch-edgeless-mode-button").click();
      const mask = page.locator(".myoxus-note-mask").first();
      await mask.click({ position: { x: 35, y: 40 } });
      await mask.dblclick({ position: { x: 35, y: 40 } });
      await feature.focus();
      await feature.press("Enter");
      form = page.getByRole("dialog").filter({
        has: page.getByRole("textbox", { name: "Message", exact: true }),
      });
      await form
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Cancelled embedded draft");
      await form
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ noWaitAfter: true });
      expect((await current()).source).toBe(changed);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await writeFile(file, changed, "utf8");
      imported = true;
      await importMermaidFile(page, file);
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(2);
      const native = (await mermaidOwnerInventory(page)).find(
        (o) => o.id !== ownerId,
      )!;
      expect(native.source).toBe(changed);
      await page.keyboard.press("Alt+1");
      const point = await page.evaluate((id) => {
        const root = document.querySelector(
          "myoxus-edgeless-root",
        ) as unknown as {
          std: { store: { getBlock(id: string): { model: { xywh: string } } } };
          gfx: {
            viewport: {
              boundingClientRect: { left: number; top: number };
              toViewCoord(x: number, y: number): number[];
            };
          };
        };
        const b = JSON.parse(
          root.std.store.getBlock(id).model.xywh,
        ) as number[];
        const v = root.gfx.viewport.boundingClientRect;
        const p = root.gfx.viewport.toViewCoord(
          b[0] + b[2] - 12,
          b[1] + b[3] - 12,
        );
        return { x: p[0] + v.left, y: p[1] + v.top };
      }, native.id);
      await page.mouse.click(point.x, point.y);
      await expect
        .poll(() =>
          page.locator("myoxus-edgeless-root").evaluate(
            (element) =>
              (
                element as unknown as {
                  gfx: { selection: { selectedIds: string[] } };
                }
              ).gfx.selection.selectedIds,
          ),
        )
        .toEqual([native.id]);
      await page
        .locator("myoxus-edgeless-root")
        .press("Control+c", { noWaitAfter: true });
      await page
        .locator("myoxus-edgeless-root")
        .press("Control+v", { noWaitAfter: true });
      await expect
        .poll(async () => (await mermaidOwnerInventory(page)).length)
        .toBe(3);
      const copy = (await mermaidOwnerInventory(page)).find(
        (o) => o.id !== ownerId && o.id !== native.id,
      )!;
      expect(copy.source).toBe(changed);
      expect(copy.childIds).toHaveLength(native.childIds.length);
      expect(copy.childIds.every((id) => !native.childIds.includes(id))).toBe(
        true,
      );
      expectContainedBounds(copy);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      if (imported) await unlink(file);
      await signOutViaApi(request, API, cookies);
    }
  });
  test("Mermaid Mindmap keeps collapse handles, hidden descendants and Source bindings through history", async ({
    context,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    const fixture = "mindmap\nroot\n  leaf1\n  leaf2\n  leaf3\n    leaf4\n";
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid");
      await page.getByTestId("slash-menu-item-mermaid-mindmap-basic").click();
      const block = page.locator("myoxus-mermaid").first();
      const mode = block.locator(
        '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
      );
      await mode.getByText("Source", { exact: true }).click();
      await writeMermaidSource(
        block.getByRole("textbox", { name: "Mermaid source", exact: true }),
        fixture,
      );
      await mode.getByText("Visual", { exact: true }).click();
      const root = block.getByRole("button", { name: "root", exact: true });
      const branch = block.getByRole("button", { name: "leaf3", exact: true });
      const leaf = block.getByRole("button", { name: "leaf4", exact: true });
      const collapse = block.locator(
        'button[data-mindmap-handle-key][aria-label="Collapse"]',
      );
      const expand = block.locator(
        'button[data-mindmap-handle-key][aria-label="Expand"]',
      );
      const ownerId = (await mermaidOwnerInventory(page))[0].id;
      const source = async () =>
        (await mermaidOwnerInventory(page)).find(
          (owner) => owner.id === ownerId,
        )!.source;
      // Selected/focused parents expose the real consuming handle.
      await root.focus();
      await root.press("Space");
      await expect(collapse).toBeVisible();
      await collapse.click();
      await expect(branch).toHaveCount(0);
      await expect(leaf).toHaveCount(0);
      await expect(expand).toBeVisible();
      expect(await source()).toBe(fixture);
      await page.screenshot({
        path: testInfo.outputPath("mindmap-root-collapsed.png"),
      });
      await expand.click();
      await expect(leaf).toBeAttached();
      // Hover also exposes a parent handle without changing tree selection.
      await page.locator("editor-host").first().focus();
      const key = await branch.getAttribute("data-mermaid-edit-key");
      if (!key) throw new Error("Mindmap branch has no Source binding");
      const point = await flowchartNodePoint(block, key);
      const viewport = await block
        .locator(".myoxus-mermaid-gfx-viewport")
        .boundingBox();
      if (!viewport) throw new Error("Mindmap viewport has no rendered bounds");
      await page.mouse.move(viewport.x + point.x, viewport.y + point.y);
      await expect(collapse).toBeVisible();
      await collapse.click();
      await expect(branch).toBeAttached();
      await expect(leaf).toHaveCount(0);
      await expect(expand).toBeVisible();
      expect(await source()).toBe(fixture);
      await page.locator("editor-host").first().focus();
      await page.keyboard.press("Control+z");
      await expect(leaf).toBeAttached();
      await page.keyboard.press("Control+Shift+z");
      await expect(leaf).toHaveCount(0);
      await root.focus();
      await collapse.click();
      await expect(branch).toHaveCount(0);
      // A hidden collapsed descendant cannot leave an interactive orphan handle.
      await expect(expand).toHaveCount(1);
      expect(await source()).toBe(fixture);
      expect(errors).toEqual([]);
    } finally {
      if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
      await signOutViaApi(request, API, cookies);
    }
  });
});
