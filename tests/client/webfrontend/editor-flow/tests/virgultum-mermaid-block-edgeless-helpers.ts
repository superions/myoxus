// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `virgultum-mermaid-block-edgeless-helpers.ts`
 * — P-VIRG-ARCH-I-04i
 *
 * Edgeless + Toolbar + Viewport
 * Flowchart-Mermaid helpers
 * extracted from
 * `virgultum-mermaid-block.spec.ts`
 * (pre-I-04i lines 312-2125, ~1683 LoC
 * incl. dead `expectMermaidSourceMatch`
 * at 1642-1655).
 * The 28 functions here are
 * byte-for-byte identical to the
 * originals; the move is a
 * relocation, not a reimplementation.
 * (Of the 28 candidate functions
 * in the source range, 27 moved
 * here, 1 dead function was
 * removed per F-PRE-I04I-01, and
 * `withActionTimeout` was added
 * because all 4 of its callsites
 * live in this cluster. The 3
 * functions deferred from I-04h —
 * `connectFlowchartNodesViaContextMenu`,
 * `flowchartNodeBounds`,
 * `flowchartArrowKeyTowardNode` —
 * are included in this sibling
 * per F-I04H-01's plan.)
 *
 * **Why this file exists (slice
 * charter).** I-04i is the 4th
 * sub-slice of the I-04f..i cluster
 * split. I-04f landed first (HTTP/
 * Auth), I-04g second (Doc-Lifecycle
 * + Assertions), I-04h third
 * (Page-Mode-Flowchart, 8 funcs).
 * I-04i completes the helper-cluster
 * split with the Edgeless + Toolbar
 * + Viewport cluster: 24 native
 * I-04i functions plus the 3
 * functions deferred from I-04h.
 *
 * **Why 28 functions, no further
 * deferrals.** Unlike I-04h (which
 * had to defer 3 functions to I-04i
 * due to the `flowchartGfxStats`
 * forward-dep), I-04i's cluster is
 * the **target** of the deferred
 * functions and has only ONE
 * outbound cross-cluster dep:
 * `connectFlowchartNodesViaContextMenu`
 * calls `flowchartNodePoint` from
 * the I-04h sibling (resolved via
 * direct import, F-I04I-01). The
 * remaining 27 functions have no
 * cross-cluster calls. The cluster
 * DAG is therefore `I-04i → I-04h`
 * (one-way); I-04i is NOT a leaf
 * (F-I04I-01), but the cycle is
 * absent because I-04h never
 * imports from I-04i.
 *
 * **Why 0 re-declared constants.**
 * I-04i functions consume no
 * FRONTEND, GQL, API, FATAL_ERROR_
 * PATTERNS, FLOWCHART_PAGE_*,
 * COMPLEX_EXTERNAL_WORKFLOW_SOURCE,
 * or MOBILE_MERMAID_VISUAL_FIXTURES
 * constants from the main spec
 * (verified by per-function scan
 * 2026-06-12). The I-04i cluster
 * is self-contained for constants:
 * it operates only on `Locator`/
 * `Page` from `@playwright/test` and
 * the DOM/snapshot data those expose.
 *
 * **Why 0 re-declared types.**
 * I-04i functions do not consume
 * the `PermanentDeleteData` type
 * from the I-04g sibling. The 28
 * functions are pure geometry,
 * selectors, and assertions.
 *
 * **Helper-Spezifika (28 functions):**
 *
 * | Helper                                  | LoC | Verantwortung                                                 |
 * | --------------------------------------- | --- | ------------------------------------------------------------- |
 * | `edgelessFlowchartNodeBounds`           | 81  | Edgeless-Mode-Node-Bounds mit gfx.viewport.zoom               |
 * | `freeEdgelessFlowchartInsertPoint`      | 99  | Hit-Test fuer 4 Kandidaten-Punkte im Edgeless-Frame           |
 * | `selectEdgelessFlowchartEdge`           | 138 | 4-Ratio Click-Sweep fuer Edgeless-Edge-Select                 |
 * | `edgelessFlowchartEdgeTargetNodeId`     | 41  | Traverse visualElement-Edges zum Finden des Target-Node-Id    |
 * | `edgelessFlowchartEdgeLabel`            | 33  | Selector fuer Label-Element einer Edgeless-Edge               |
 * | `edgelessFlowchartGfxStats`             | 57  | Edgeless-Variante: connectorCount + nodeCount                  |
 * | `edgelessFlowchartNodeLabels`           | 55  | Edgeless-Mode-Label-Properties (visualProps.labels)            |
 * | `edgelessFlowchartNodeShapes`           | 61  | Edgeless-Mode-Shape-Properties (visualProps.shape)             |
 * | `edgelessFlowchartNodeVisualProps`      | 57  | Read visualProps aus YMap                                    |
 * | `largestVisibleMermaidEdgelessFrame`    | 14  | Findet den groessten sichtbaren Mermaid-Edgeless-Frame         |
 * | `selectEdgelessFlowchartNode`           | 16  | Click-Sweep mit hitTest + Label-Verify                        |
 * | `withActionTimeout`                     | 20  | Race a Playwright action against a labeled timeout            |
 * | `renameEdgelessFlowchartNode`           | 203 | F2-rename mit dblclick + Typing + Escape + Verify              |
 * | `setEdgelessShapeTool`                  | 12  | Click auf Shape-Tool-Button (default: "Square")                |
 * | `switchSelectedEdgelessShapeType`       | 18  | 2-Stage: Shape-Tool setzen + click auf bestehende Node         |
 * | `clickToolbarButtonWithPointer`         | 48  | Maus-Pointer-Position-Klick auf Toolbar-Button                 |
 * | `expectConnectorLabelEditorVisible`     | 115 | Connector-Label-Editor sichtbar? (mit debug info)              |
 * | `flowchartNodeIds`                      | 35  | Mermaid-Node-Ids in Document-Order                            |
 * | `flowchartGfxStats`                     | 52  | Page-Mode: connectorCount + nodeCount                          |
 * | `pageMermaidFlowchartSnapshot`          | 112 | Page-Mermaid: full Document-State-Snapshot                     |
 * | `pageMermaidViewportState`              | 31  | Page-Mermaid: viewport-zoom, scroll, center                    |
 * | `waitForPageMermaidViewport`            | 13  | 250ms wait for Page-Mermaid-Viewport-Render                    |
 * | `flowchartNodeLabels`                   | 55  | Page-Mode-Label-Properties (visualProps.labels)                |
 * | `flowchartSubgraphNodeIds`              | 71  | Subgraph-Node-Ids in Document-Order                           |
 * | `flowchartSubgraphHeaderPoint`          | 95  | Header-Element-Mid-Point fuer Subgraph-Node                    |
 * | `connectFlowchartNodesViaContextMenu`   | 167 | DEFERRED from I-04h: connects via right-click context menu    |
 * | `flowchartNodeBounds`                   | 72  | DEFERRED from I-04h: full Node-Bounds mit Subgraph-Filter     |
 * | `flowchartArrowKeyTowardNode`           | 15  | DEFERRED from I-04h: arrow-key Richtung zum Target-Node        |
 *
 * **Callers.** 27 of the 28
 * functions are called by main spec
 * (lines > 2125 in the post-I-04h
 * main spec, which now imports all
 * 28 from this sibling). Callsite
 * counts are split between main
 * spec (where the test() bodies
 * call them) and the I-04i sibling
 * itself (where the 3 deferred
 * functions call each other):
 *
 * | Helper                                  | Main spec | I-04i sibling | Total |
 * | --------------------------------------- | --------- | ------------- | ----- |
 * | `edgelessFlowchartNodeBounds`           | 5         | 2             | 7     |
 * | `freeEdgelessFlowchartInsertPoint`      | 1         | 0             | 1     |
 * | `selectEdgelessFlowchartEdge`           | 3         | 0             | 3     |
 * | `edgelessFlowchartEdgeTargetNodeId`     | 1         | 0             | 1     |
 * | `edgelessFlowchartEdgeLabel`            | 2         | 0             | 2     |
 * | `edgelessFlowchartGfxStats`             | 4         | 0             | 4     |
 * | `edgelessFlowchartNodeLabels`           | 2         | 1             | 3     |
 * | `edgelessFlowchartNodeShapes`           | 1         | 0             | 1     |
 * | `edgelessFlowchartNodeVisualProps`      | 3         | 0             | 3     |
 * | `largestVisibleMermaidEdgelessFrame`    | 1         | 0             | 1     |
 * | `selectEdgelessFlowchartNode`           | 1         | 0             | 1     |
 * | `withActionTimeout`                     | 0         | 4             | 4     |
 * | `renameEdgelessFlowchartNode`           | 2         | 0             | 2     |
 * | `setEdgelessShapeTool`                  | 1         | 0             | 1     |
 * | `switchSelectedEdgelessShapeType`       | 1         | 0             | 1     |
 * | `clickToolbarButtonWithPointer`         | 2         | 0             | 2     |
 * | `expectConnectorLabelEditorVisible`     | 2         | 0             | 2     |
 * | `flowchartNodeIds`                      | 11        | 0             | 11    |
 * | `flowchartGfxStats`                     | 4         | 2             | 6     |
 * | `pageMermaidFlowchartSnapshot`          | 2         | 0             | 2     |
 * | `pageMermaidViewportState`              | 0         | 1             | 1     |
 * | `waitForPageMermaidViewport`            | 1         | 0             | 1     |
 * | `flowchartNodeLabels`                   | 2         | 0             | 2     |
 * | `flowchartSubgraphNodeIds`              | 2         | 0             | 2     |
 * | `flowchartSubgraphHeaderPoint`          | 1         | 0             | 1     |
 * | `connectFlowchartNodesViaContextMenu`   | 2         | 0             | 2     |
 * | `flowchartNodeBounds`                   | 4         | 2             | 6     |
 * | `flowchartArrowKeyTowardNode`           | 2         | 0             | 2     |
 *
 * **Why this is the 3rd sibling
 * (after I-04f, I-04g) that imports
 * `expect` from `@playwright/
 * test`.** All 28 helpers call
 * `expect(...)` in their bodies
 * (assertions, polls, label
 * visibility checks). The sibling
 * uses `import { expect, type
 * Locator, type Page } from
 * "@playwright/test";` — mixed
 * runtime + type imports on one
 * line, matching the main-spec
 * pattern at lines 3-10.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md
 *      §I (P-VIRG-ARCH-I-04i)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04i closeout)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04h closeout for
 *      F-I04H-01 deferred-functions
 *      plan)
 */

import { expect, type Locator, type Page } from "@playwright/test";

// F-I04I-01: 1 of the 3 I-04h-deferred
// functions (`connectFlowchartNodesViaContextMenu`)
// consumes `flowchartNodePoint` from
// the I-04h sibling. This is the first
// sibling-to-sibling import in the
// I-04f..i cluster split; the
// dependency direction is one-way
// (I-04i depends on I-04h, not
// vice versa), so the DAG stays
// acyclic. The I-04h sibling has no
// outbound dependencies on I-04i.
// See F-I04I-01 in the I-04i
// closeout for the architectural
// rationale.
import {
  flowchartNodePoint,
  ensureFlowchartPointReachable,
} from "./virgultum-mermaid-block-page-helpers";

export async function edgelessFlowchartNodeBounds(
  managedFrame: Locator,
  nodeId: string,
): Promise<{
  height: number;
  viewX: number;
  viewY: number;
  width: number;
  x: number;
  y: number;
}> {
  return managedFrame.evaluate((frameElement, targetNodeId) => {
    const frame = frameElement as unknown as {
      gfx?: {
        viewport?: {
          left?: number;
          top?: number;
          toViewCoord?: (x: number, y: number) => [number, number];
        };
      };
      model?: {
        childIds?: string[];
        childElements?: Array<{
          id?: string;
          xywh?: string;
          yMap?: { get?: (key: string) => unknown };
        }>;
        surface?: {
          getElementById?: (id: string) => {
            id?: string;
            xywh?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is NonNullable<typeof element> =>
          Boolean(element),
        ),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const node = elements
      .filter(
        (candidate) =>
          candidate.yMap?.get?.("mermaidRole") === "mermaid-flowchart-node",
      )
      .find((candidate, index) => {
        const nodeId =
          String(candidate.yMap?.get?.("mermaidNodeId") ?? "") ||
          `N${index + 1}`;
        return nodeId === targetNodeId;
      });
    if (!node?.xywh) {
      throw new Error(
        `Edgeless Mermaid flowchart node ${targetNodeId} has no GFX bounds`,
      );
    }
    const [x, y, width, height] = JSON.parse(node.xywh) as [
      number,
      number,
      number,
      number,
    ];
    const viewport = frame.gfx?.viewport;
    const [localViewX, localViewY] = viewport?.toViewCoord?.(
      x + width / 2,
      y + height / 2,
    ) ?? [0, 0];
    const viewX = localViewX + (viewport?.left ?? 0);
    const viewY = localViewY + (viewport?.top ?? 0);
    return { height, viewX, viewY, width, x, y };
  }, nodeId);
}

export async function freeEdgelessFlowchartInsertPoint(
  page: Page,
  managedFrame: Locator,
): Promise<{ x: number; y: number }> {
  const viewportSize = page.viewportSize() ?? { height: 720, width: 1280 };
  return managedFrame.evaluate((frameElement, viewport) => {
    const frame = frameElement as unknown as {
      gfx?: {
        grid?: {
          search?: (bound: {
            h: number;
            w: number;
            x: number;
            y: number;
          }) => Array<{
            id?: string;
            type?: string;
            yMap?: { get?: (key: string) => unknown };
          }>;
        };
        viewport?: {
          left?: number;
          top?: number;
          toViewCoord?: (x: number, y: number) => [number, number];
        };
      };
      model?: {
        id?: string;
        xywh?: string;
      };
    };
    const rawFrameBound = frame.model?.xywh;
    const viewportController = frame.gfx?.viewport;
    const gridController = frame.gfx?.grid;
    if (
      !rawFrameBound ||
      !viewportController?.toViewCoord ||
      !gridController?.search
    ) {
      throw new Error("Managed Mermaid frame GFX viewport/grid is unavailable");
    }
    const [frameX, frameY, frameW, frameH] = JSON.parse(rawFrameBound) as [
      number,
      number,
      number,
      number,
    ];
    const step = 96;
    const shapeW = 120;
    const shapeH = 100;
    const candidates: Array<{ x: number; y: number }> = [];
    for (let y = frameY + 96; y <= frameY + frameH - shapeH - 96; y += step) {
      for (let x = frameX + 96; x <= frameX + frameW - shapeW - 96; x += step) {
        candidates.push({ x, y });
      }
    }
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const candidate of candidates) {
      const [viewX, viewY] = viewportController.toViewCoord(
        candidate.x,
        candidate.y,
      );
      const clientX = viewX + (frame.gfx?.viewport?.left ?? 0);
      const clientY = viewY + (frame.gfx?.viewport?.top ?? 0);
      if (
        clientX < 280 ||
        clientY < 112 ||
        clientX > viewport.width - 120 ||
        clientY > viewport.height - 170
      ) {
        continue;
      }
      const center = {
        x: candidate.x + shapeW / 2,
        y: candidate.y + shapeH / 2,
      };
      const hits = gridController
        .search({
          h: shapeH + 56,
          w: shapeW + 56,
          x: center.x - shapeW / 2 - 28,
          y: center.y - shapeH / 2 - 28,
        })
        .filter((element) => {
          if (element.id === frame.model?.id) return false;
          if (
            element.yMap?.get?.("mermaidRole") === "mermaid-flowchart-subgraph"
          ) {
            return false;
          }
          return true;
        });
      if (hits.length === 0) {
        return { x: clientX, y: clientY };
      }
    }
    throw new Error("No free visible insertion point found in Mermaid frame");
  }, viewportSize);
}

export async function selectEdgelessFlowchartEdge(
  page: Page,
  managedFrame: Locator,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<{ edgeElementId: string; edgeId: string }> {
  const selection = await managedFrame.evaluate(
    (frameElement, args) => {
      type FrameElement = {
        id: string;
        props?: Record<string, unknown>;
        source?: { id?: string };
        target?: { id?: string };
        type?: string;
        yMap?: { get?: (key: string) => unknown };
      };
      const frame = frameElement as unknown as {
        model?: {
          childIds?: string[];
          childElements?: FrameElement[];
          surface?: {
            getElementById?: (id: string) => FrameElement | null;
          };
          store?: { transact?: (callback: () => void) => void };
        };
      };
      const childElements = frame.model?.childElements ?? [];
      const childIds = frame.model?.childIds ?? [];
      const elements = [
        ...childElements,
        ...childIds
          .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
          .filter((element): element is FrameElement => Boolean(element)),
      ].filter(
        (element, index, all) =>
          all.findIndex((candidate) => candidate.id === element.id) === index,
      );
      const source = elements.find(
        (candidate) =>
          candidate.yMap?.get?.("mermaidNodeId") === args.sourceNodeId,
      );
      const target = elements.find(
        (candidate) =>
          candidate.yMap?.get?.("mermaidNodeId") === args.targetNodeId,
      );
      const connector = elements.find((candidate) => {
        const sourceId =
          candidate.source?.id ??
          (candidate.props?.source as { id?: string } | undefined)?.id;
        const targetId =
          candidate.target?.id ??
          (candidate.props?.target as { id?: string } | undefined)?.id;
        const type = candidate.type ?? candidate.props?.type;
        const role =
          candidate.yMap?.get?.("mermaidRole") ?? candidate.props?.mermaidRole;
        const edgeId =
          candidate.yMap?.get?.("mermaidEdgeId") ??
          candidate.props?.mermaidEdgeId;
        return (
          sourceId === source?.id &&
          targetId === target?.id &&
          (type === "connector" ||
            role === "mermaid-flowchart-edge" ||
            typeof edgeId === "string")
        );
      });
      if (!source || !target || !connector) {
        const details = elements.map((candidate) => ({
          edgeId:
            candidate.yMap?.get?.("mermaidEdgeId") ??
            candidate.props?.mermaidEdgeId,
          id: candidate.id,
          nodeId:
            candidate.yMap?.get?.("mermaidNodeId") ??
            candidate.props?.mermaidNodeId,
          role:
            candidate.yMap?.get?.("mermaidRole") ??
            candidate.props?.mermaidRole,
          source:
            candidate.source?.id ??
            (candidate.props?.source as { id?: string } | undefined)?.id,
          target:
            candidate.target?.id ??
            (candidate.props?.target as { id?: string } | undefined)?.id,
          type: candidate.type ?? candidate.props?.type,
        }));
        throw new Error(
          `Cannot select Mermaid edge ${args.sourceNodeId} -> ${args.targetNodeId}: ${JSON.stringify(details)}`,
        );
      }
      const edgelessRoot = document.querySelector("myoxus-edgeless-root") as {
        gfx?: { selection?: { set?: (selection: unknown) => void } };
      } | null;
      edgelessRoot?.gfx?.selection?.set?.({ elements: [connector.id] });
      return {
        edgeElementId: connector.id,
        edgeId: String(connector.yMap?.get?.("mermaidEdgeId") ?? connector.id),
      };
    },
    { sourceNodeId, targetNodeId },
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const edgelessRoot = document.querySelector(
            "myoxus-edgeless-root",
          ) as {
            gfx?: { selection?: { selectedIds?: string[] } };
          } | null;
          return edgelessRoot?.gfx?.selection?.selectedIds ?? [];
        }),
      {
        message: `Mermaid edge ${sourceNodeId}->${targetNodeId} must become the active GFX selection`,
        timeout: 10_000,
      },
    )
    .toContain(selection.edgeElementId);
  await page.waitForTimeout(350);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const edgelessRoot = document.querySelector(
            "myoxus-edgeless-root",
          ) as {
            gfx?: { selection?: { selectedIds?: string[] } };
          } | null;
          return edgelessRoot?.gfx?.selection?.selectedIds ?? [];
        }),
      {
        message: `Mermaid edge ${sourceNodeId}->${targetNodeId} GFX selection must stay stable before toolbar interaction`,
        timeout: 5_000,
      },
    )
    .toEqual([selection.edgeElementId]);
  return selection;
}

export async function edgelessFlowchartEdgeTargetNodeId(
  managedFrame: Locator,
  edgeElementId: string,
): Promise<string> {
  return managedFrame.evaluate((frameElement, targetEdgeElementId) => {
    type FrameElement = {
      id: string;
      source?: { id?: string };
      target?: { id?: string };
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const edge = elements.find(
      (candidate) => candidate.id === targetEdgeElementId,
    );
    const targetElementId = edge?.target?.id ?? "";
    const target = elements.find(
      (candidate) => candidate.id === targetElementId,
    );
    return String(target?.yMap?.get?.("mermaidNodeId") ?? "");
  }, edgeElementId);
}

export async function edgelessFlowchartEdgeEndpointNodeIds(
  managedFrame: Locator,
  edgeElementId: string,
): Promise<{ source: string; target: string }> {
  return managedFrame.evaluate((frameElement, targetEdgeElementId) => {
    type FrameElement = {
      id: string;
      props?: {
        source?: { id?: string };
        target?: { id?: string };
      };
      source?: { id?: string };
      target?: { id?: string };
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const edge = elements.find(
      (candidate) => candidate.id === targetEdgeElementId,
    );
    const endpointNodeId = (elementId: string) => {
      const endpoint = elements.find((candidate) => candidate.id === elementId);
      return String(endpoint?.yMap?.get?.("mermaidNodeId") ?? "");
    };
    return {
      source: endpointNodeId(edge?.source?.id ?? edge?.props?.source?.id ?? ""),
      target: endpointNodeId(edge?.target?.id ?? edge?.props?.target?.id ?? ""),
    };
  }, edgeElementId);
}

export async function edgelessFlowchartEdgeLabel(
  managedFrame: Locator,
  edgeElementId: string,
): Promise<string> {
  return managedFrame.evaluate((frameElement, targetEdgeElementId) => {
    type FrameElement = {
      id: string;
      text?: { toString?: () => string } | string;
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const edge =
      childElements.find((candidate) => candidate.id === targetEdgeElementId) ??
      childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .find(
          (candidate): candidate is FrameElement =>
            Boolean(candidate) && candidate.id === targetEdgeElementId,
        );
    return typeof edge?.text === "string"
      ? edge.text
      : (edge?.text?.toString?.() ?? "");
  }, edgeElementId);
}

export async function edgelessFlowchartGfxStats(
  managedFrame: Locator,
): Promise<{
  connectorCount: number;
  detailRowCount: number;
  nodeCount: number;
  shapeTypes: string[];
}> {
  return managedFrame.evaluate((frameElement) => {
    type FrameElement = {
      id: string;
      shapeType?: string;
      type?: string;
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const detailRows = elements.filter(
      (candidate) =>
        candidate.type === "shape" &&
        candidate.yMap?.get?.("mermaidRole") === "mermaid-relationship-detail",
    );
    const nodeShapes = elements
      .filter((candidate) => {
        const role = candidate.yMap?.get?.("mermaidRole");
        return (
          candidate.type === "shape" &&
          role !== "mermaid-flowchart-subgraph" &&
          role !== "mermaid-relationship-detail"
        );
      })
      .map((candidate) =>
        String(
          candidate.yMap?.get?.("mermaidNodeShape") ??
            candidate.shapeType ??
            "",
        ),
      )
      .filter(Boolean);
    return {
      connectorCount: elements.filter(
        (candidate) => candidate.type === "connector",
      ).length,
      detailRowCount: detailRows.length,
      nodeCount: nodeShapes.length,
      shapeTypes: [...new Set(nodeShapes)].sort(),
    };
  });
}

export async function edgelessFlowchartNodeLabels(
  managedFrame: Locator,
): Promise<Record<string, string>> {
  return managedFrame.evaluate((frameElement) => {
    type FrameElement = {
      id: string;
      props?: Record<string, unknown>;
      text?: { toString?: () => string } | string;
      type?: string;
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    return Object.fromEntries(
      elements
        .filter((candidate) => {
          const role = candidate.yMap?.get?.("mermaidRole");
          return (
            candidate.type === "shape" && role === "mermaid-flowchart-node"
          );
        })
        .map((candidate, index) => {
          const nodeId =
            String(
              candidate.yMap?.get?.("mermaidNodeId") ??
                candidate.props?.mermaidNodeId ??
                "",
            ) || `N${index + 1}`;
          const text =
            typeof candidate.text === "string"
              ? candidate.text
              : (candidate.text?.toString?.() ?? "");
          return [nodeId, text];
        }),
    );
  });
}

export async function edgelessFlowchartDetailLabels(
  managedFrame: Locator,
): Promise<Record<string, string>> {
  return managedFrame.evaluate((frameElement) => {
    type FrameElement = {
      id: string;
      props?: Record<string, unknown>;
      text?: { toString?: () => string } | string;
      type?: string;
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    return Object.fromEntries(
      elements
        .filter(
          (candidate) =>
            candidate.type === "shape" &&
            candidate.yMap?.get?.("mermaidRole") ===
              "mermaid-relationship-detail",
        )
        .map((candidate) => {
          const ownerId = String(
            candidate.yMap?.get?.("mermaidDetailOwnerNodeId") ??
              candidate.props?.mermaidDetailOwnerNodeId ??
              "",
          );
          const sourceKey = String(
            candidate.yMap?.get?.("mermaidDetailSourceKey") ??
              candidate.props?.mermaidDetailSourceKey ??
              "",
          );
          const detailId = String(
            candidate.yMap?.get?.("mermaidDetailId") ??
              candidate.props?.mermaidDetailId ??
              candidate.id,
          );
          const text =
            typeof candidate.text === "string"
              ? candidate.text
              : (candidate.text?.toString?.() ?? "");
          return [`${ownerId}.${sourceKey || detailId}`, text];
        }),
    );
  });
}

export async function edgelessFlowchartNodeShapes(
  managedFrame: Locator,
): Promise<Record<string, string>> {
  return managedFrame.evaluate((frameElement) => {
    type FrameElement = {
      id: string;
      props?: Record<string, unknown>;
      radius?: number;
      shapeType?: string;
      type?: string;
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const visualShape = (shape: FrameElement) => {
      const shapeType = String(shape.shapeType ?? "");
      if (shapeType === "diamond") return "diamond";
      if (shapeType === "ellipse") return "circle";
      if (shapeType === "triangle") return "tri";
      if (shapeType === "rect")
        return (shape.radius ?? 0) > 0 ? "rounded" : "rect";
      return String(shape.yMap?.get?.("mermaidNodeShape") ?? shapeType);
    };
    return Object.fromEntries(
      elements
        .filter(
          (candidate) =>
            candidate.type === "shape" &&
            candidate.yMap?.get?.("mermaidRole") !==
              "mermaid-flowchart-subgraph",
        )
        .map((candidate, index) => {
          const nodeId =
            String(
              candidate.yMap?.get?.("mermaidNodeId") ??
                candidate.props?.mermaidNodeId ??
                "",
            ) || `N${index + 1}`;
          return [nodeId, visualShape(candidate)];
        }),
    );
  });
}

export async function edgelessFlowchartNodeVisualProps(
  managedFrame: Locator,
  nodeId: string,
): Promise<Record<string, unknown>> {
  return managedFrame.evaluate((frameElement, targetNodeId) => {
    type FrameElement = {
      color?: string;
      fillColor?: string;
      fontFamily?: string;
      id: string;
      props?: Record<string, unknown>;
      shapeStyle?: string;
      shapeType?: string;
      strokeColor?: string;
      textAlign?: string;
      textVerticalAlign?: string;
      type?: string;
      yMap?: { get?: (key: string) => unknown };
    };
    const frame = frameElement as unknown as {
      model?: {
        childIds?: string[];
        childElements?: FrameElement[];
        surface?: {
          getElementById?: (id: string) => FrameElement | null;
        };
      };
    };
    const elements = [
      ...(frame.model?.childElements ?? []),
      ...(frame.model?.childIds ?? [])
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is FrameElement => Boolean(element)),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const node = elements.find(
      (candidate) =>
        candidate.type === "shape" &&
        String(candidate.yMap?.get?.("mermaidNodeId") ?? "") === targetNodeId,
    );
    if (!node) return {};
    return {
      color: node.color ?? node.props?.color,
      fillColor: node.fillColor ?? node.props?.fillColor,
      fontFamily: node.fontFamily ?? node.props?.fontFamily,
      mermaidNodeShape: node.yMap?.get?.("mermaidNodeShape"),
      shapeStyle: node.shapeStyle ?? node.props?.shapeStyle,
      shapeType: node.shapeType ?? node.props?.shapeType,
      strokeColor: node.strokeColor ?? node.props?.strokeColor,
      textAlign: node.textAlign ?? node.props?.textAlign,
      textVerticalAlign:
        node.textVerticalAlign ?? node.props?.textVerticalAlign,
    };
  }, nodeId);
}

export async function largestVisibleMermaidEdgelessFrame(
  page: Page,
): Promise<Locator> {
  const frameIndex = await page.locator("myoxus-frame").evaluateAll(
    (frames) =>
      frames
        .map((frame, index) => {
          const rect = frame.getBoundingClientRect();
          return { area: rect.width * rect.height, index };
        })
        .sort((a, b) => b.area - a.area)[0]?.index ?? 0,
  );
  return page.locator("myoxus-frame").nth(frameIndex);
}

export async function selectEdgelessFlowchartNode(
  page: Page,
  managedFrame: Locator,
  nodeId: string,
): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  const bounds = await edgelessFlowchartNodeBounds(managedFrame, nodeId);
  await page.mouse.click(bounds.viewX, bounds.viewY);
}

/**
 * Race a Playwright action against a timeout, surfacing a labeled error
 * instead of letting the call site hang. All `withActionTimeout` callsites
 * live in the I-04i cluster (Edgeless interaction helpers), so the helper
 * stays co-located with its consumers.
 */
export async function withActionTimeout<T>(
  action: Promise<T>,
  label: string,
  timeout = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function renameEdgelessFlowchartNode(
  page: Page,
  managedFrame: Locator,
  nodeId: string,
  label: string,
): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  const bounds = await edgelessFlowchartNodeBounds(managedFrame, nodeId);
  await withActionTimeout(
    page.mouse.dblclick(bounds.viewX, bounds.viewY),
    `double-click Edgeless node ${nodeId}`,
  );
  const textEditor = page.locator("edgeless-shape-text-editor rich-text");
  const opened = await textEditor
    .isVisible({ timeout: 10_000 })
    .catch(() => false);
  if (!opened) {
    const debug = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y) as HTMLElement | null;
        return {
          className: element?.className ?? "",
          tagName: element?.tagName ?? "",
          text: element?.textContent?.slice(0, 120) ?? "",
        };
      },
      { x: bounds.viewX, y: bounds.viewY },
    );
    const frameDebug = await managedFrame.evaluate(
      (frameElement, payload) => {
        const frame = frameElement as unknown as {
          gfx?: {
            getElementByPoint?: (
              x: number,
              y: number,
              options?: Record<string, unknown>,
            ) =>
              | { id?: string; type?: string }
              | Array<{ id?: string; type?: string }>
              | null;
            grid?: {
              search?: (bound: {
                h: number;
                w: number;
                x: number;
                y: number;
              }) => Array<{ id?: string; type?: string }>;
            };
            selection?: {
              selectedElements?: Array<{ id?: string; type?: string }>;
            };
            viewport?: {
              left?: number;
              top?: number;
              toModelCoord?: (x: number, y: number) => [number, number];
              toViewCoord?: (x: number, y: number) => [number, number];
              zoom?: number;
            };
          };
          model?: {
            childIds?: string[];
            childElements?: Array<{
              fillColor?: string;
              id?: string;
              index?: string;
              shapeType?: string;
              strokeColor?: string;
              type?: string;
              xywh?: string;
              yMap?: { get?: (key: string) => unknown };
            }>;
            surface?: {
              getElementById?: (id: string) => {
                fillColor?: string;
                id?: string;
                index?: string;
                shapeType?: string;
                strokeColor?: string;
                type?: string;
                xywh?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          };
        };
        const childElements = frame.model?.childElements ?? [];
        const childIds = frame.model?.childIds ?? [];
        const elements = [
          ...childElements,
          ...childIds
            .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
            .filter((element): element is NonNullable<typeof element> =>
              Boolean(element),
            ),
        ].filter(
          (element, index, all) =>
            all.findIndex((candidate) => candidate.id === element.id) === index,
        );
        const node = elements.find(
          (candidate) =>
            String(candidate.yMap?.get?.("mermaidNodeId") ?? "") ===
            payload.nodeId,
        );
        const nodeBound = node?.xywh
          ? (JSON.parse(node.xywh) as [number, number, number, number])
          : null;
        const nodeCenter = nodeBound
          ? {
              x: nodeBound[0] + nodeBound[2] / 2,
              y: nodeBound[1] + nodeBound[3] / 2,
            }
          : null;
        const gridHits = nodeCenter
          ? frame.gfx?.grid
              ?.search?.({
                h: 2,
                w: 2,
                x: nodeCenter.x - 1,
                y: nodeCenter.y - 1,
              })
              ?.map((element) => ({ id: element.id, type: element.type }))
          : null;
        const pickedAtCenter = nodeCenter
          ? frame.gfx?.getElementByPoint?.(nodeCenter.x, nodeCenter.y, {
              all: true,
              hitThreshold: 10,
            })
          : null;
        const modelAtPoint =
          frame.gfx?.viewport?.toModelCoord?.(payload.viewX, payload.viewY) ??
          null;
        return {
          gridHits,
          modelAtPoint,
          node: node
            ? {
                fillColor: node.fillColor,
                id: node.id,
                index: node.index,
                mermaidNodeId: node.yMap?.get?.("mermaidNodeId"),
                role: node.yMap?.get?.("mermaidRole"),
                shapeType: node.shapeType,
                strokeColor: node.strokeColor,
                type: node.type,
                xywh: node.xywh,
              }
            : null,
          nodeCenter,
          pickedAtCenter: Array.isArray(pickedAtCenter)
            ? pickedAtCenter.map((element) => ({
                id: element.id,
                type: element.type,
              }))
            : pickedAtCenter
              ? { id: pickedAtCenter.id, type: pickedAtCenter.type }
              : null,
          selected: frame.gfx?.selection?.selectedElements?.map((element) => ({
            id: element.id,
            type: element.type,
          })),
          viewport: {
            left: frame.gfx?.viewport?.left,
            top: frame.gfx?.viewport?.top,
            zoom: frame.gfx?.viewport?.zoom,
          },
        };
      },
      { nodeId, viewX: bounds.viewX, viewY: bounds.viewY },
    );
    throw new Error(
      `Edgeless shape text editor did not open for Mermaid node ${nodeId}: ${JSON.stringify(
        { bounds, debug, frameDebug },
      )}`,
    );
  }
  const inlineEditor = page
    .locator("edgeless-shape-text-editor .inline-editor")
    .first();
  await expect(inlineEditor).toBeVisible({ timeout: 10_000 });
  await withActionTimeout(
    inlineEditor.click({ timeout: 10_000 }),
    `focus visible Edgeless node ${nodeId} inline text editor`,
  );
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await withActionTimeout(
    // Native Edgeless RichText commits through keyboard/composition handlers.
    // `insertText` can bypass those handlers for freshly restored frame
    // children, leaving the visible editor open but the GFX Y.Text unchanged.
    page.keyboard.type(label, { delay: 5 }),
    `type Edgeless node ${nodeId} label`,
  );
  await expect.poll(async () => inlineEditor.textContent()).toContain(label);
  const activeEditorDebug = await inlineEditor.evaluate((element) => {
    const host = element.closest("edgeless-shape-text-editor") as
      | (HTMLElement & {
          element?: {
            id?: string;
            text?: { toString?: () => string } | string;
            yMap?: { get?: (key: string) => unknown };
          };
        })
      | null;
    const model = host?.element;
    return {
      editorText: element.textContent ?? "",
      modelId: model?.id ?? "",
      modelLabel: model?.yMap?.get?.("mermaidNodeLabel") ?? null,
      modelNodeId: model?.yMap?.get?.("mermaidNodeId") ?? null,
      modelText:
        typeof model?.text === "string"
          ? model.text
          : (model?.text?.toString?.() ?? ""),
    };
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("edgeless-shape-text-editor")).toHaveCount(0, {
    timeout: 10_000,
  });
  try {
    await expect
      .poll(async () => {
        const labels = await edgelessFlowchartNodeLabels(managedFrame);
        return labels[nodeId] ?? JSON.stringify(labels);
      })
      .toBe(label);
  } catch (error) {
    const debug = await managedFrame.evaluate((frameElement, targetNodeId) => {
      type FrameElement = {
        id?: string;
        props?: Record<string, unknown>;
        text?: { toString?: () => string } | string;
        type?: string;
        yMap?: { get?: (key: string) => unknown };
      };
      const frame = frameElement as unknown as {
        model?: {
          childIds?: string[];
          childElements?: FrameElement[];
          surface?: {
            getElementById?: (id: string) => FrameElement | null;
          };
        };
      };
      const childElements = frame.model?.childElements ?? [];
      const childIds = frame.model?.childIds ?? [];
      const elements = [
        ...childElements,
        ...childIds
          .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
          .filter((element): element is FrameElement => Boolean(element)),
      ].filter(
        (element, index, all) =>
          all.findIndex((candidate) => candidate.id === element.id) === index,
      );
      return elements
        .filter(
          (candidate) =>
            candidate.type === "shape" &&
            String(candidate.yMap?.get?.("mermaidNodeId") ?? "") ===
              targetNodeId,
        )
        .map((candidate) => ({
          id: candidate.id,
          label: candidate.yMap?.get?.("mermaidNodeLabel"),
          displayLabel: candidate.yMap?.get?.("mermaidNodeDisplayLabel"),
          role: candidate.yMap?.get?.("mermaidRole"),
          text:
            typeof candidate.text === "string"
              ? candidate.text
              : (candidate.text?.toString?.() ?? ""),
        }));
    }, nodeId);
    throw new Error(
      `Edgeless Mermaid node ${nodeId} label did not commit: ${JSON.stringify({
        activeEditorDebug,
        bounds,
        targetDebug: debug,
      })}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function setEdgelessShapeTool(page: Page, shapeLabel = "Square") {
  const shapeToolButton = page.locator(
    "edgeless-toolbar-widget edgeless-toolbar-button.edgeless-shape-button",
  );
  await expect(shapeToolButton).toBeVisible({ timeout: 10_000 });
  await shapeToolButton.click({ position: { x: 5, y: 5 }, timeout: 10_000 });
  const shapeButton = page
    .locator("edgeless-slide-menu edgeless-tool-icon-button")
    .filter({ hasText: shapeLabel });
  await expect(shapeButton).toBeVisible({ timeout: 10_000 });
  await shapeButton.click({ timeout: 10_000 });
}

export async function switchSelectedEdgelessShapeType(
  page: Page,
  shapeLabel:
    "Diamond" | "Ellipse" | "Rounded rectangle" | "Square" | "Triangle",
) {
  const toolbar = page
    .locator(
      'editor-toolbar[data-myoxus-floating-toolbar="true"], myoxus-toolbar-widget editor-toolbar',
    )
    .last();
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  await toolbar.getByLabel("Switch shape type").first().click();
  await toolbar.getByLabel(shapeLabel).click();
}

export async function clickToolbarButtonWithPointer(
  page: Page,
  locator: Locator,
  expectedLabel?: string,
) {
  await expect(locator).toBeVisible({ timeout: 10_000 });
  const innerTarget = locator.locator(".icon-container").first();
  const clickTarget = (await innerTarget.count()) > 0 ? innerTarget : locator;
  await expect(clickTarget).toBeVisible({ timeout: 10_000 });
  const box = await clickTarget.boundingBox();
  expect(box, "toolbar button must have a pointer target").toBeTruthy();
  const center = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  };
  const hitTarget = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    const button = element?.closest?.("editor-icon-button,[role='button']");
    const path: string[] = [];
    let current: Element | null = element;
    while (current && path.length < 8) {
      path.push(
        `${current.localName}${current.dataset.testid ? `[data-testid="${current.dataset.testid}"]` : ""}${current.getAttribute("aria-label") ? `[aria-label="${current.getAttribute("aria-label")}"]` : ""}${current.className ? `.${String(current.className).replace(/\s+/g, ".")}` : ""}`,
      );
      current = current.parentElement;
    }
    return {
      buttonAriaLabel: button?.getAttribute("aria-label") ?? null,
      buttonTestId: button.dataset.testid ?? null,
      localName: element?.localName ?? null,
      path,
    };
  }, center);
  expect(
    hitTarget.path.some((entry) => entry.startsWith("editor-icon-button")),
    `toolbar pointer target must hit the editor icon button, got ${JSON.stringify(hitTarget)}`,
  ).toBe(true);
  if (expectedLabel) {
    expect(
      hitTarget.buttonAriaLabel,
      `toolbar pointer target must hit ${expectedLabel}, got ${JSON.stringify(hitTarget)}`,
    ).toBe(expectedLabel);
  }
  await withActionTimeout(
    clickTarget.click({ force: true, timeout: 10_000 }),
    "click floating GFX toolbar button with pointer",
  );
}

export async function expectConnectorLabelEditorVisible(
  page: Page,
  managedFrame: Locator,
  edgeElementId: string,
) {
  const connectorLabelEditor = page
    .locator("edgeless-connector-label-editor rich-text")
    .first();
  try {
    await expect(connectorLabelEditor).toBeVisible({ timeout: 10_000 });
  } catch (error) {
    const debug = await page.evaluate((targetEdgeElementId) => {
      const root = document.querySelector("myoxus-edgeless-root") as {
        gfx?: {
          selection?: {
            selectedElements?: Array<{
              id?: string;
              text?: { toString?: () => string } | string;
              type?: string;
              yMap?: { get?: (key: string) => unknown };
            }>;
            selectedIds?: string[];
          };
        };
      } | null;
      const toolbars = Array.from(
        document.querySelectorAll(
          'editor-toolbar[data-myoxus-floating-toolbar="true"]',
        ),
      ).map((toolbar) => {
        const rect = toolbar.getBoundingClientRect();
        return {
          ariaLabels: Array.from(toolbar.querySelectorAll("[aria-label]")).map(
            (element) => element.getAttribute("aria-label"),
          ),
          open: Object.hasOwn(toolbar.dataset, "open"),
          rect: {
            height: Math.round(rect.height),
            width: Math.round(rect.width),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
          },
        };
      });
      const selectedElements = root?.gfx?.selection?.selectedElements ?? [];
      return {
        activeElement: document.activeElement?.localName ?? null,
        editorCount: document.querySelectorAll(
          "edgeless-connector-label-editor",
        ).length,
        selectedIds: root?.gfx?.selection?.selectedIds ?? [],
        selectedElements: selectedElements.map((element) => ({
          edgeId: element.yMap?.get?.("mermaidEdgeId") ?? null,
          id: element.id,
          hasText: Boolean(element.text),
          text:
            typeof element.text === "string"
              ? element.text
              : (element.text?.toString?.() ?? null),
          type: element.type,
        })),
        targetEdgeElementId,
        toolbars,
      };
    }, edgeElementId);
    const frameDebug = await managedFrame.evaluate(
      (frameElement, targetEdgeElementId) => {
        type FrameElement = {
          id: string;
          text?: { toString?: () => string } | string;
          type?: string;
          yMap?: { get?: (key: string) => unknown };
        };
        const frame = frameElement as unknown as {
          model?: {
            childIds?: string[];
            childElements?: FrameElement[];
            surface?: {
              getElementById?: (id: string) => FrameElement | null;
            };
          };
        };
        const elements = [
          ...(frame.model?.childElements ?? []),
          ...(frame.model?.childIds ?? [])
            .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
            .filter((element): element is FrameElement => Boolean(element)),
        ];
        const connector = elements.find(
          (element) => element.id === targetEdgeElementId,
        );
        return {
          childCount: elements.length,
          connector: connector
            ? {
                edgeId: connector.yMap?.get?.("mermaidEdgeId") ?? null,
                hasText: Boolean(connector.text),
                id: connector.id,
                text:
                  typeof connector.text === "string"
                    ? connector.text
                    : (connector.text?.toString?.() ?? null),
                type: connector.type,
              }
            : null,
        };
      },
      edgeElementId,
    );
    throw new Error(
      `Connector label editor did not open: ${JSON.stringify({ debug, frameDebug })}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return connectorLabelEditor;
}

export async function flowchartNodeIds(
  mermaidBlock: Locator,
): Promise<string[]> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            type?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                type?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    };
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    return (owner?.childIds ?? [])
      .map((id) => surface?.getElementById?.(id))
      .filter((candidate) => candidate?.type === "shape")
      .map((candidate) => String(candidate?.yMap?.get?.("mermaidNodeId") ?? ""))
      .filter(Boolean);
  });
}

export async function flowchartGfxStats(mermaidBlock: Locator): Promise<{
  connectorCount: number;
  detailRowCount: number;
  nodeCount: number;
  shapeTypes: string[];
}> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            type?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                type?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    };
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    const elements = (owner?.childIds ?? [])
      .map((id) => surface?.getElementById?.(id))
      .filter(Boolean);
    const detailRows = elements.filter(
      (candidate) =>
        candidate?.type === "shape" &&
        String(candidate.yMap?.get?.("mermaidRole") ?? "") ===
          "mermaid-relationship-detail",
    );
    const nodeShapes = elements
      .filter((candidate) => {
        const role = String(candidate?.yMap?.get?.("mermaidRole") ?? "");
        return (
          candidate?.type === "shape" &&
          role !== "mermaid-flowchart-subgraph" &&
          role !== "mermaid-relationship-detail"
        );
      })
      .map((candidate) =>
        String(candidate?.yMap?.get?.("mermaidNodeShape") ?? ""),
      )
      .filter(Boolean);
    const connectors = elements.filter(
      (candidate) =>
        candidate?.type === "connector" &&
        String(candidate.yMap?.get?.("mermaidRole") ?? "") ===
          "mermaid-flowchart-edge",
    );
    return {
      connectorCount: connectors.length,
      detailRowCount: detailRows.length,
      nodeCount: nodeShapes.length,
      shapeTypes: [...new Set(nodeShapes)].sort(),
    };
  });
}

export async function flowchartConnectorEndpointStyles(
  mermaidBlock: Locator,
): Promise<
  Array<{
    erCardinality: string;
    frontEndpointStyle: string;
    label: string;
    rearEndpointStyle: string;
  }>
> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            frontEndpointStyle?: string;
            rearEndpointStyle?: string;
            text?: { toString?: () => string } | string;
            type?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                frontEndpointStyle?: string;
                rearEndpointStyle?: string;
                text?: { toString?: () => string } | string;
                type?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    };
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    return (owner?.childIds ?? [])
      .map((id) => surface?.getElementById?.(id))
      .filter(
        (
          candidate,
        ): candidate is {
          frontEndpointStyle?: string;
          rearEndpointStyle?: string;
          text?: { toString?: () => string } | string;
          type?: string;
          yMap?: { get?: (key: string) => unknown };
        } =>
          candidate?.type === "connector" &&
          String(candidate.yMap?.get?.("mermaidRole") ?? "") ===
            "mermaid-flowchart-edge",
      )
      .map((connector) => ({
        erCardinality: String(
          connector.yMap?.get?.("mermaidEdgeErCardinality") ?? "",
        ),
        frontEndpointStyle: String(connector.frontEndpointStyle ?? ""),
        label:
          typeof connector.text === "string"
            ? connector.text
            : (connector.text?.toString?.() ?? ""),
        rearEndpointStyle: String(connector.rearEndpointStyle ?? ""),
      }));
  });
}

export async function pageMermaidFlowchartSnapshot(page: Page): Promise<{
  connectorCount: number;
  detailRowCount: number;
  details: Record<
    string,
    { height: number; label: string; width: number; x: number; y: number }
  >;
  nodeCount: number;
  nodes: Record<
    string,
    { height: number; label: string; width: number; x: number; y: number }
  >;
  shapeTypes: string[];
  source: string;
}> {
  return page.evaluate(() => {
    const block = document.querySelector("myoxus-mermaid") as {
      model?: {
        childIds?: string[];
        props?: { source?: { toString?: () => string } };
        surface?: {
          getElementById?: (id: string) => {
            shapeType?: string;
            text?: { toString?: () => string } | string;
            type?: string;
            xywh?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                shapeType?: string;
                text?: { toString?: () => string } | string;
                type?: string;
                xywh?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    } | null;
    if (!block) throw new Error("Page Mermaid block is missing");
    const owner = block.model;
    const fallbackSurface = block.std?.store
      ?.getBlocksByFlavour?.("myoxus:surface")
      ?.at(0)?.model;
    const surface = owner?.surface ?? fallbackSurface;
    const elements = (owner?.childIds ?? [])
      .map((id) => surface?.getElementById?.(id))
      .filter(Boolean);
    const nodes: Record<
      string,
      { height: number; label: string; width: number; x: number; y: number }
    > = {};
    const details: Record<
      string,
      { height: number; label: string; width: number; x: number; y: number }
    > = {};
    const shapeTypes: string[] = [];
    let connectorCount = 0;
    let detailRowCount = 0;
    for (const element of elements) {
      const role = String(element?.yMap?.get?.("mermaidRole") ?? "");
      if (element?.type === "connector" && role === "mermaid-flowchart-edge") {
        connectorCount++;
        continue;
      }
      if (
        element?.type === "shape" &&
        role === "mermaid-relationship-detail" &&
        element.xywh
      ) {
        const ownerId = String(
          element.yMap?.get?.("mermaidDetailOwnerNodeId") ?? "",
        );
        const sourceKey =
          String(element.yMap?.get?.("mermaidDetailSourceKey") ?? "") ||
          String(element.yMap?.get?.("mermaidDetailId") ?? "");
        const detailId = String(element.yMap?.get?.("mermaidDetailId") ?? "");
        const [x, y, width, height] = JSON.parse(element.xywh) as [
          number,
          number,
          number,
          number,
        ];
        const label =
          typeof element.text === "string"
            ? element.text
            : (element.text?.toString?.() ?? "");
        const semanticKey = `${ownerId}.${sourceKey}`;
        const detailKey = `${ownerId}.${detailId || sourceKey}`;
        details[Object.hasOwn(details, semanticKey) ? detailKey : semanticKey] =
          { height, label, width, x, y };
        detailRowCount++;
        continue;
      }
      if (
        element?.type !== "shape" ||
        role === "mermaid-flowchart-subgraph" ||
        role === "mermaid-relationship-detail" ||
        !element.xywh
      ) {
        continue;
      }
      const nodeId = String(element.yMap?.get?.("mermaidNodeId") ?? "");
      if (!nodeId) continue;
      const [x, y, width, height] = JSON.parse(element.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const label =
        typeof element.text === "string"
          ? element.text
          : (element.text?.toString?.() ?? "");
      if (Object.hasOwn(nodes, nodeId)) {
        throw new Error(
          `Duplicate Mermaid flowchart node in page mode: ${nodeId}`,
        );
      }
      nodes[nodeId] = { height, label, width, x, y };
      shapeTypes.push(
        String(
          element.yMap?.get?.("mermaidNodeShape") ?? element.shapeType ?? "",
        ),
      );
    }
    return {
      connectorCount,
      detailRowCount,
      details,
      nodeCount: Object.keys(nodes).length,
      nodes,
      shapeTypes: [...new Set(shapeTypes.filter(Boolean))].sort(),
      source: block.model?.props?.source?.toString?.() ?? "",
    };
  });
}

export async function pageMermaidViewportState(page: Page): Promise<{
  blockVisible: boolean;
  viewportVisible: boolean;
  viewportHeight: number;
  viewportWidth: number;
}> {
  return page.evaluate(() => {
    const block = document.querySelector("myoxus-mermaid") as {
      renderRoot?: ParentNode;
    } | null;
    const viewport =
      block?.renderRoot?.querySelector?.(".myoxus-mermaid-gfx-viewport") ??
      (block as unknown as HTMLElement | null)?.querySelector?.(
        ".myoxus-mermaid-gfx-viewport",
      );
    const blockRect =
      block instanceof HTMLElement
        ? block.getBoundingClientRect()
        : ({ height: 0, width: 0 } as DOMRect);
    const viewportRect =
      viewport instanceof HTMLElement
        ? viewport.getBoundingClientRect()
        : ({ height: 0, width: 0 } as DOMRect);
    return {
      blockVisible: blockRect.width > 0 && blockRect.height > 0,
      viewportVisible: viewportRect.width > 0 && viewportRect.height > 0,
      viewportHeight: Math.round(viewportRect.height),
      viewportWidth: Math.round(viewportRect.width),
    };
  });
}

export async function waitForPageMermaidViewport(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastState: Awaited<ReturnType<typeof pageMermaidViewportState>> | null =
    null;
  while (Date.now() < deadline) {
    lastState = await pageMermaidViewportState(page);
    if (lastState.blockVisible && lastState.viewportVisible) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Page Mermaid GFX viewport did not become visible: ${JSON.stringify(lastState)}`,
  );
}

export async function flowchartNodeLabels(
  mermaidBlock: Locator,
): Promise<Record<string, string>> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            props?: Record<string, unknown>;
            text?: { toString?: () => string } | string;
            type?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                props?: Record<string, unknown>;
                text?: { toString?: () => string } | string;
                type?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    };
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    return Object.fromEntries(
      (owner?.childIds ?? [])
        .map((id) => surface?.getElementById?.(id))
        .filter((candidate) => candidate?.type === "shape")
        .map((candidate) => {
          const nodeId = String(
            candidate?.yMap?.get?.("mermaidNodeId") ??
              candidate?.props?.mermaidNodeId ??
              "",
          );
          const label =
            String(
              candidate?.yMap?.get?.("mermaidLabel") ??
                candidate?.props?.mermaidLabel ??
                "",
            ) ||
            (typeof candidate?.text === "string"
              ? candidate.text
              : (candidate?.text?.toString?.() ?? ""));
          return [nodeId, label];
        })
        .filter(([nodeId]) => nodeId),
    );
  });
}

export async function flowchartSubgraphNodeIds(
  mermaidBlock: Locator,
  subgraphId: string,
): Promise<string[]> {
  return mermaidBlock.evaluate((element, targetSubgraphId) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            type?: string;
            xywh?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                type?: string;
                xywh?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
    };
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    const elements = (owner?.childIds ?? []).map((id) =>
      surface?.getElementById?.(id),
    );
    const subgraph = elements.find(
      (candidate) =>
        candidate?.type === "shape" &&
        candidate.yMap?.get?.("mermaidSubgraphId") === targetSubgraphId,
    );
    if (!subgraph?.xywh) {
      throw new Error(`Mermaid flowchart subgraph ${targetSubgraphId} missing`);
    }
    const [subgraphX, subgraphY, subgraphW, subgraphH] = JSON.parse(
      subgraph.xywh,
    ) as [number, number, number, number];
    return elements
      .filter(
        (candidate) =>
          candidate?.type === "shape" &&
          Boolean(candidate.yMap?.get?.("mermaidNodeId")) &&
          candidate.xywh,
      )
      .filter((candidate) => {
        const [x, y, width, height] = JSON.parse(candidate!.xywh!) as [
          number,
          number,
          number,
          number,
        ];
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        return (
          centerX >= subgraphX &&
          centerX <= subgraphX + subgraphW &&
          centerY >= subgraphY &&
          centerY <= subgraphY + subgraphH
        );
      })
      .map((candidate) => String(candidate?.yMap?.get?.("mermaidNodeId") ?? ""))
      .filter(Boolean);
  }, subgraphId);
}

export async function flowchartSubgraphHeaderPoint(
  mermaidBlock: Locator,
  subgraphId: string,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate((element, targetSubgraphId) => {
    const block = element as unknown as {
      _gfxViewportBridge?: {
        getModelViewRect?: (xywh: string) => {
          height: number;
          left: number;
          top: number;
          width: number;
        } | null;
      };
      model?: {
        childIds?: string[];
        surface?: {
          getElementById?: (id: string) => {
            id: string;
            xywh?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
        xywh?: string;
      };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: {
              getElementById?: (id: string) => {
                id: string;
                xywh?: string;
                yMap?: { get?: (key: string) => unknown };
              } | null;
            };
          }>;
        };
      };
      querySelector: Element["querySelector"];
    };
    const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
    const viewportRect = viewport?.getBoundingClientRect();
    const owner = block.model;
    const surface =
      owner?.surface ??
      block.std?.store?.getBlocksByFlavour?.("myoxus:surface")?.at(0)?.model;
    const subgraph = (owner?.childIds ?? [])
      .map((id) => surface?.getElementById?.(id))
      .find(
        (candidate) =>
          candidate?.yMap?.get?.("mermaidSubgraphId") === targetSubgraphId,
      );
    if (!subgraph?.xywh) {
      throw new Error(
        `Mermaid flowchart subgraph ${targetSubgraphId} is not rendered`,
      );
    }
    const [subgraphX, subgraphY, subgraphW] = JSON.parse(subgraph.xywh) as [
      number,
      number,
      number,
      number,
    ];
    const modelX = subgraphX + Math.min(48, Math.max(20, subgraphW / 4));
    const modelY = subgraphY + 20;
    const scopedRect = block._gfxViewportBridge?.getModelViewRect?.(
      subgraph.xywh,
    );
    if (scopedRect) {
      return {
        x: scopedRect.left + Math.min(48, Math.max(20, scopedRect.width / 4)),
        y: scopedRect.top + Math.min(20, scopedRect.height / 2),
      };
    }
    const surfaceElement = viewport?.querySelector("myoxus-surface") as
      | {
          _gfx?: {
            viewport?: {
              toViewCoord?: (x: number, y: number) => [number, number];
            };
          };
        }
      | null
      | undefined;
    const liveViewport = surfaceElement?._gfx?.viewport;
    if (liveViewport?.toViewCoord) {
      const [x, y] = liveViewport.toViewCoord(modelX, modelY);
      return { x, y };
    }
    if (!owner?.xywh || !viewportRect) {
      throw new Error("Mermaid flowchart subgraph owner is not measurable");
    }
    const [ownerX, ownerY, ownerWidth, ownerHeight] = JSON.parse(
      owner.xywh,
    ) as [number, number, number, number];
    const padding = 36;
    const zoom = Math.min(
      (viewportRect.width - padding * 2) / ownerWidth,
      (viewportRect.height - padding * 2) / ownerHeight,
    );
    const centerX = ownerX + ownerWidth / 2;
    const centerY = ownerY + ownerHeight / 2;
    const viewportX = centerX - viewportRect.width / 2 / zoom;
    const viewportY = centerY - viewportRect.height / 2 / zoom;
    return {
      x: (modelX - viewportX) * zoom,
      y: (modelY - viewportY) * zoom,
    };
  }, subgraphId);
}

export async function connectFlowchartNodesViaContextMenu(
  page: Page,
  mermaidBlock: Locator,
  visualCanvas: Locator,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const selectedNodeOrder = () =>
    mermaidBlock.evaluate((block) => {
      const raw = block as unknown as { _explicitVisualNodeOrder?: string[] };
      return raw._visualSelectionKeys?.("node") ?? [];
    });
  const contextPanel = mermaidBlock.locator(
    '[data-myoxus-ui-role="workbench-context-panel-shell"]',
  );
  const contextDrawer = page
    .locator('[data-myoxus-ui-role="workbench-context-panel-drawer"]')
    .getByRole("dialog");
  if (await contextDrawer.isVisible().catch(() => false)) {
    await contextDrawer.getByRole("button", { name: "Close" }).click();
    await expect(contextDrawer).toBeHidden();
  }
  if (await contextPanel.isVisible().catch(() => false)) {
    await contextPanel.getByRole("button", { name: "Close" }).click();
    await expect(contextPanel).toBeHidden();
  }
  if ((await selectedNodeOrder()).length > 0) {
    await page.keyboard.press("Escape");
    await expect.poll(selectedNodeOrder).toEqual([]);
  }
  const connectorCountBefore = (await flowchartGfxStats(mermaidBlock))
    .connectorCount;
  const clickCanvasPoint = async (
    point: { x: number; y: number },
    options: { button?: "left" | "right" } = {},
  ) => {
    const box = await visualCanvas.boundingBox();
    expect(
      box,
      "Mermaid GFX viewport must be visible for pointer input",
    ).toBeTruthy();
    await page.mouse.click(box!.x + point.x, box!.y + point.y, {
      button: options.button ?? "left",
    });
  };
  const scrollCanvasPointIntoView = async (point: { x: number; y: number }) => {
    const box = await visualCanvas.boundingBox();
    const viewport = page.viewportSize();
    expect(
      box,
      "Mermaid GFX viewport must be visible before scrolling to a node",
    ).toBeTruthy();
    expect(viewport, "Playwright viewport must be measurable").toBeTruthy();
    const clientY = box!.y + point.y;
    const targetY = Math.max(120, Math.round(viewport!.height * 0.58));
    if (clientY < 96 || clientY > viewport!.height - 96) {
      await page.mouse.wheel(0, clientY - targetY);
      await page.waitForTimeout(120);
    }
  };
  const clickNodeUntilOrder = async (
    nodeId: string,
    expectedOrder: string[],
  ) => {
    const attempts: Array<Record<string, unknown>> = [];
    const ratios = [
      [0.5, 0.5],
      [0.3, 0.35],
      [0.7, 0.35],
      [0.35, 0.65],
      [0.65, 0.65],
    ] as const;
    for (const [rx, ry] of ratios) {
      let point: { x: number; y: number };
      if (expectedOrder.length === 2) {
        let sourcePoint = await flowchartNodePoint(
          mermaidBlock,
          expectedOrder[0],
        );
        await scrollCanvasPointIntoView(sourcePoint);
        await ensureFlowchartPointReachable(
          mermaidBlock,
          visualCanvas,
          sourcePoint,
        );
        sourcePoint = await flowchartNodePoint(mermaidBlock, expectedOrder[0]);
        await page.keyboard.down("Shift");
        try {
          await clickCanvasPoint(sourcePoint);
        } finally {
          await page.keyboard.up("Shift");
        }
        const sourceSelected = await expect
          .poll(selectedNodeOrder, { timeout: 1_000 })
          .toEqual([expectedOrder[0]])
          .then(() => true)
          .catch(() => false);
        if (!sourceSelected) continue;

        // Selecting the source opens the Workbench inspector and can resize
        // the Page canvas. Resolve the target only after that real layout
        // transition; pre-inspector coordinates are stale for dense graphs.
        point = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
        await scrollCanvasPointIntoView(point);
        await ensureFlowchartPointReachable(mermaidBlock, visualCanvas, point);
        const retainedOrder = await selectedNodeOrder();
        if (
          retainedOrder.length !== 1 ||
          retainedOrder[0] !== expectedOrder[0]
        ) {
          sourcePoint = await flowchartNodePoint(
            mermaidBlock,
            expectedOrder[0],
          );
          await page.keyboard.down("Shift");
          try {
            await clickCanvasPoint(sourcePoint);
          } finally {
            await page.keyboard.up("Shift");
          }
          await expect
            .poll(selectedNodeOrder, { timeout: 1_000 })
            .toEqual([expectedOrder[0]]);
        }
        point = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
      } else {
        point = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
        await scrollCanvasPointIntoView(point);
        await ensureFlowchartPointReachable(mermaidBlock, visualCanvas, point);
        point = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
      }
      const beforeClick = await mermaidBlock.evaluate(
        (block, args) => {
          const raw = block as unknown as {
            _visualSelectionKeys?: (kind: "node") => string[];
            _findVisualNodeByClientPoint?: (
              clientX: number,
              clientY: number,
            ) => string;
            _selectedVisualNodeId?: string;
            _selectedVisualNodeOrder?: string[];
            querySelector: Element["querySelector"];
          };
          const viewport = raw.querySelector(".myoxus-mermaid-gfx-viewport");
          const rect = viewport?.getBoundingClientRect();
          const clientX = (rect?.left ?? 0) + args.point.x;
          const clientY = (rect?.top ?? 0) + args.point.y;
          const element = document.elementFromPoint(
            clientX,
            clientY,
          ) as HTMLElement | null;
          return {
            clientX,
            clientY,
            elementClass: element?.className ?? "",
            elementTag: element?.tagName ?? "",
            explicitOrder: raw._visualSelectionKeys?.("node") ?? [],
            hitNodeId:
              raw._findVisualNodeByClientPoint?.(clientX, clientY) ?? "",
            point: args.point,
            ratio: args.ratio,
            scrollY: window.scrollY,
            selectedNodeId: raw._selectedVisualNodeId ?? "",
            selectedOrder: raw._selectedVisualNodeOrder ?? [],
            viewportRect: rect
              ? {
                  bottom: rect.bottom,
                  height: rect.height,
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                }
              : null,
            viewportSize: {
              height: window.innerHeight,
              width: window.innerWidth,
            },
          };
        },
        { point, ratio: [rx, ry] },
      );
      if (expectedOrder.length === 2) {
        await page.keyboard.down("Shift");
        try {
          await clickCanvasPoint(point);
        } finally {
          await page.keyboard.up("Shift");
        }
      } else {
        await clickCanvasPoint(point);
      }
      const matched = await expect
        .poll(selectedNodeOrder, { timeout: 1_000 })
        .toEqual(expectedOrder)
        .then(() => true)
        .catch(() => false);
      if (matched) return point;
      attempts.push({
        ...beforeClick,
        afterOrder: await selectedNodeOrder(),
      });
    }
    throw new Error(
      `Could not select Mermaid flowchart node ${nodeId} as ${JSON.stringify(
        expectedOrder,
      )}: ${JSON.stringify(attempts)}`,
    );
  };

  await clickNodeUntilOrder(sourceNodeId, [sourceNodeId]);
  const target = await clickNodeUntilOrder(targetNodeId, [
    sourceNodeId,
    targetNodeId,
  ]);
  await clickCanvasPoint(target, { button: "right" });
  const contextMenu = mermaidBlock.locator(".myoxus-mermaid-gfx-context-menu");
  const menuVisible = await contextMenu
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (!menuVisible) {
    const debug = await mermaidBlock.evaluate((block) => {
      const raw = block as unknown as {
        _visualSelectionKeys?: (kind: "node") => string[];
        _selectedVisualNodeId?: string;
        _selectedVisualNodeOrder?: string[];
        _visualContextMenu?: unknown;
      };
      return {
        contextMenuInDom: Boolean(
          block.querySelector(".myoxus-mermaid-gfx-context-menu"),
        ),
        selectedVisualNodeId: raw._selectedVisualNodeId ?? "",
        selectedVisualNodeOrder: raw._selectedVisualNodeOrder ?? [],
        explicitVisualNodeOrder: raw._visualSelectionKeys?.("node") ?? [],
        visualContextMenu: raw._visualContextMenu ?? null,
      };
    });
    throw new Error(
      `Mermaid context connect menu did not open for ${sourceNodeId}->${targetNodeId}: ${JSON.stringify(debug)}`,
    );
  }
  const contextAction = contextMenu.getByRole("menuitem").first();
  await expect(contextAction).toContainText(/->/);
  await contextAction.click({ timeout: 5_000 });
  await expect
    .poll(async () => (await flowchartGfxStats(mermaidBlock)).connectorCount)
    .toBe(connectorCountBefore + 1);
}

export async function flowchartNodeBounds(
  mermaidBlock: Locator,
  nodeId: string,
): Promise<{ height: number; width: number; x: number; y: number }> {
  return mermaidBlock.evaluate((element, targetNodeId) => {
    const block = element as unknown as {
      _getVisualNodeGfxModel?: (id: string) => {
        xywh?: string;
        yMap?: { get?: (key: string) => unknown };
      } | null;
    };
    const node = block._getVisualNodeGfxModel?.(targetNodeId);
    if (!node?.xywh) {
      throw new Error(
        `Mermaid flowchart node ${targetNodeId} has no GFX bounds`,
      );
    }
    const [x, y, width, height] = JSON.parse(node.xywh) as [
      number,
      number,
      number,
      number,
    ];
    return { height, width, x, y };
  }, nodeId);
}

export async function flowchartArrowKeyTowardNode(
  mermaidBlock: Locator,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<"ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"> {
  const source = await flowchartNodeBounds(mermaidBlock, sourceNodeId);
  const target = await flowchartNodeBounds(mermaidBlock, targetNodeId);
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "ArrowRight" : "ArrowLeft";
  }
  return dy >= 0 ? "ArrowDown" : "ArrowUp";
}
