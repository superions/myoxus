// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Locator, type Page } from "@playwright/test";

type MermaidSelectionProbe = {
  _visualSelectionAnchorKey(kind: "node" | "edge" | "subgraph"): string;
};

// Kept local because the helper is executable independently from the split
// declaration file. Browser behavior, not byte equality between test files,
// owns this endpoint contract.
const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const _FRONTEND_SOURCE_ANCHOR = FRONTEND;

// Re-declared from
// `virgultum-mermaid-block.spec.ts`
// lines 61-62. Consumed by
// `flowchartNodePoint`'s fallback
// geometry path. The source-anchor
// test (test #5b) asserts the
// literals match the main spec's
// bytes, catching drift. See file
// header "Why `FRONTEND` and the 2
// `FLOWCHART_PAGE_*` constants are
// re-declared here" for rationale.
const FLOWCHART_PAGE_MIN_READABLE_ZOOM = 0.5;
const FLOWCHART_PAGE_VIEWPORT_PADDING = 36;

export async function flowchartNodePoint(
  mermaidBlock: Locator,
  nodeId: string,
  xRatio = 0.5,
  yRatio = 0.5,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate(
    (element, args) => {
      const { minReadableZoom, targetNodeId, viewportPadding, xRatio, yRatio } =
        args;
      const block = element as unknown as {
        _gfxViewportBridge?: {
          getModelViewRect?: (xywh: string) => {
            height: number;
            left: number;
            top: number;
            width: number;
          } | null;
        };
        _getVisualNodeGfxModel?: (id: string) => {
          xywh?: string;
        } | null;
        model?: { xywh?: string };
        querySelector: Element["querySelector"];
      };
      const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
      const gfx = (
        viewport?.querySelector("myoxus-surface") as
          | {
              _gfx?: {
                viewport?: {
                  toViewCoord?: (x: number, y: number) => [number, number];
                };
              };
            }
          | null
          | undefined
      )?._gfx;
      const viewportRect = viewport?.getBoundingClientRect();
      const ownerXYWH = block.model?.xywh;
      const node = block._getVisualNodeGfxModel?.(targetNodeId);
      if (!ownerXYWH || !viewportRect) {
        throw new Error("Mermaid flowchart owner is not measurable");
      }
      if (!node?.xywh) {
        throw new Error(
          `Mermaid flowchart node ${targetNodeId} is not rendered`,
        );
      }
      const [frameX, frameY, frameW, frameH] = JSON.parse(ownerXYWH) as [
        number,
        number,
        number,
        number,
      ];
      const [nodeX, nodeY, nodeW, nodeH] = JSON.parse(node.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const modelX = nodeX + nodeW * xRatio;
      const modelY = nodeY + nodeH * yRatio;
      const scopedRect = block._gfxViewportBridge?.getModelViewRect?.(
        node.xywh,
      );
      if (scopedRect) {
        const layoutWidth =
          viewport instanceof HTMLElement ? viewport.offsetWidth : 0;
        const layoutHeight =
          viewport instanceof HTMLElement ? viewport.offsetHeight : 0;
        const scaleX = layoutWidth ? viewportRect.width / layoutWidth : 1;
        const scaleY = layoutHeight ? viewportRect.height / layoutHeight : 1;
        return {
          x: (scopedRect.left + scopedRect.width * xRatio) * scaleX,
          y: (scopedRect.top + scopedRect.height * yRatio) * scaleY,
        };
      }
      const viewPoint = gfx?.viewport?.toViewCoord?.(modelX, modelY);
      if (
        viewPoint &&
        Number.isFinite(viewPoint[0]) &&
        Number.isFinite(viewPoint[1])
      ) {
        return { x: viewPoint[0], y: viewPoint[1] };
      }
      const fitZoom = Math.min(
        (viewportRect.width - viewportPadding * 2) / frameW,
        (viewportRect.height - viewportPadding * 2) / frameH,
      );
      const zoom = Math.max(fitZoom, minReadableZoom);
      const visibleModelWidth = viewportRect.width / zoom;
      const visibleModelHeight = viewportRect.height / zoom;
      const fitsHorizontally =
        frameW * zoom <= viewportRect.width - viewportPadding * 2;
      const fitsVertically =
        frameH * zoom <= viewportRect.height - viewportPadding * 2;
      const centerX = fitsHorizontally
        ? frameX + frameW / 2
        : frameX + visibleModelWidth / 2 - viewportPadding / zoom;
      const centerY = fitsVertically
        ? frameY + frameH / 2
        : frameY + visibleModelHeight / 2 - viewportPadding / zoom;
      const viewportX = centerX - viewportRect.width / 2 / zoom;
      const viewportY = centerY - viewportRect.height / 2 / zoom;
      return {
        x: (modelX - viewportX) * zoom,
        y: (modelY - viewportY) * zoom,
      };
    },
    {
      minReadableZoom: FLOWCHART_PAGE_MIN_READABLE_ZOOM,
      targetNodeId: nodeId,
      viewportPadding: FLOWCHART_PAGE_VIEWPORT_PADDING,
      xRatio,
      yRatio,
    },
  );
}
export async function flowchartNodeViewBox(
  mermaidBlock: Locator,
  nodeId: string,
): Promise<{ height: number; width: number; x: number; y: number }> {
  const topLeft = await flowchartNodePoint(mermaidBlock, nodeId, 0, 0);
  const bottomRight = await flowchartNodePoint(mermaidBlock, nodeId, 1, 1);
  return {
    height: Math.abs(bottomRight.y - topLeft.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
  };
}

export async function flowchartModelPointFromViewPoint(
  mermaidBlock: Locator,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate((element, viewPoint) => {
    const block = element as unknown as {
      _getScopedModelPointFromClient?: (
        clientX: number,
        clientY: number,
      ) => { x: number; y: number } | null;
      querySelector: Element["querySelector"];
    };
    const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
    const rect = viewport?.getBoundingClientRect();
    if (!rect) throw new Error("Mermaid visual canvas is not visible");
    const modelPoint = block._getScopedModelPointFromClient?.(
      rect.left + viewPoint.x,
      rect.top + viewPoint.y,
    );
    if (!modelPoint) {
      throw new Error("Mermaid view point could not be mapped to the model");
    }
    return modelPoint;
  }, point);
}

export async function flowchartNodeModelPoint(
  mermaidBlock: Locator,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate((element, targetNodeId) => {
    const block = element as unknown as {
      _getVisualNodeGfxModel?: (id: string) => { xywh?: string } | null;
    };
    const xywh = block._getVisualNodeGfxModel?.(targetNodeId)?.xywh;
    if (!xywh) {
      throw new Error(`Mermaid flowchart node ${targetNodeId} is not rendered`);
    }
    const [x, y, width, height] = JSON.parse(xywh) as [
      number,
      number,
      number,
      number,
    ];
    return { x: x + width / 2, y: y + height / 2 };
  }, nodeId);
}

export async function flowchartDetailPoint(
  mermaidBlock: Locator,
  ownerNodeId: string,
  sourceKey: string,
  xRatio = 0.5,
  yRatio = 0.5,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate(
    (element, args) => {
      const { minReadableZoom, ownerNodeId, sourceKey, viewportPadding } = args;
      const block = element as unknown as {
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
      const gfx = (
        viewport?.querySelector("myoxus-surface") as
          | {
              _gfx?: {
                viewport?: {
                  toViewCoord?: (x: number, y: number) => [number, number];
                };
              };
            }
          | null
          | undefined
      )?._gfx;
      const viewportRect = viewport?.getBoundingClientRect();
      const owner = block.model;
      const fallbackSurface = block.std?.store
        ?.getBlocksByFlavour?.("myoxus:surface")
        ?.at(0)?.model;
      const surface = owner?.surface ?? fallbackSurface;
      if (!owner?.xywh || !viewportRect || !surface) {
        throw new Error("Mermaid flowchart owner is not measurable");
      }
      const detail = (owner.childIds ?? [])
        .map((id) => surface.getElementById?.(id))
        .find((candidate) => {
          if (
            candidate?.yMap?.get?.("mermaidRole") !==
            "mermaid-relationship-detail"
          ) {
            return false;
          }
          return (
            candidate.yMap.get("mermaidDetailOwnerNodeId") === ownerNodeId &&
            candidate.yMap.get("mermaidDetailSourceKey") === sourceKey
          );
        });
      if (!detail?.xywh) {
        throw new Error(
          `Mermaid Relationship detail ${ownerNodeId}.${sourceKey} is not rendered`,
        );
      }
      const [frameX, frameY, frameW, frameH] = JSON.parse(owner.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const [detailX, detailY, detailW, detailH] = JSON.parse(detail.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const modelX = detailX + detailW * args.xRatio;
      const modelY = detailY + detailH * args.yRatio;
      const viewPoint = gfx?.viewport?.toViewCoord?.(modelX, modelY);
      if (
        viewPoint &&
        Number.isFinite(viewPoint[0]) &&
        Number.isFinite(viewPoint[1])
      ) {
        return { x: viewPoint[0], y: viewPoint[1] };
      }
      const fitZoom = Math.min(
        (viewportRect.width - viewportPadding * 2) / frameW,
        (viewportRect.height - viewportPadding * 2) / frameH,
      );
      const zoom = Math.max(fitZoom, minReadableZoom);
      const visibleModelWidth = viewportRect.width / zoom;
      const visibleModelHeight = viewportRect.height / zoom;
      const fitsHorizontally =
        frameW * zoom <= viewportRect.width - viewportPadding * 2;
      const fitsVertically =
        frameH * zoom <= viewportRect.height - viewportPadding * 2;
      const centerX = fitsHorizontally
        ? frameX + frameW / 2
        : frameX + visibleModelWidth / 2 - viewportPadding / zoom;
      const centerY = fitsVertically
        ? frameY + frameH / 2
        : frameY + visibleModelHeight / 2 - viewportPadding / zoom;
      const viewportX = centerX - viewportRect.width / 2 / zoom;
      const viewportY = centerY - viewportRect.height / 2 / zoom;
      return {
        x: (modelX - viewportX) * zoom,
        y: (modelY - viewportY) * zoom,
      };
    },
    {
      minReadableZoom: FLOWCHART_PAGE_MIN_READABLE_ZOOM,
      ownerNodeId,
      sourceKey,
      viewportPadding: FLOWCHART_PAGE_VIEWPORT_PADDING,
      xRatio,
      yRatio,
    },
  );
}

export async function flowchartBlankPoint(
  mermaidBlock: Locator,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      _findVisualNodeByClientPoint?: (
        clientX: number,
        clientY: number,
      ) => string;
      querySelector: Element["querySelector"];
    };
    const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
    const rect = viewport?.getBoundingClientRect();
    if (!rect || !block._findVisualNodeByClientPoint) {
      throw new Error("Mermaid visual canvas hit-test is not available");
    }
    const candidates = [
      { x: 28, y: 28 },
      { x: 28, y: rect.height - 28 },
      { x: rect.width - 28, y: 28 },
      { x: rect.width - 28, y: rect.height - 28 },
      { x: rect.width / 2, y: 28 },
    ];
    const point = candidates.find(
      (candidate) =>
        !block._findVisualNodeByClientPoint!(
          rect.left + candidate.x,
          rect.top + candidate.y,
        ),
    );
    if (!point) throw new Error("No blank Mermaid visual canvas point found");
    return point;
  });
}
export async function mermaidOwnerIdentity(mermaidBlock: Locator): Promise<{
  blockId: string;
  childIds: string[];
  sourceHash: string;
}> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      model?: {
        childIds?: string[];
        id?: string;
        props?: {
          sourceHash?: string;
        };
      };
    };
    return {
      blockId: block.model?.id ?? "",
      childIds: [...(block.model?.childIds ?? [])],
      sourceHash: block.model?.props?.sourceHash ?? "",
    };
  });
}
export async function selectFlowchartEdge(
  mermaidBlock: Locator,
  visualCanvas: Locator,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const edgeProbe = await mermaidBlock.evaluate(
    (element, args) => {
      const block = element as unknown as {
        _gfxViewportBridge?: {
          toViewPoint?: (x: number, y: number) => { left: number; top: number };
        };
        _findVisualEdgeByModelPoint?: (x: number, y: number) => string;
        _getMermaidVisualModelForEditing?: () => {
          edges?: Array<{ id: string; source: string; target: string }>;
          nodes?: Array<{
            id: string;
            sequenceParticipantId?: string;
            stateSequenceRole?: string;
          }>;
        } | null;
        _getVisualNodeGfxModel?: (
          nodeId: string,
        ) => { xywh?: string } | null | undefined;
        _getVisualEdgeGfxModel?: (edgeId: string) =>
          | {
              absolutePath?: readonly (readonly [number, number])[];
            }
          | null
          | undefined;
        querySelector: Element["querySelector"];
      };
      const visualModel = block._getMermaidVisualModelForEditing?.();
      const nodesById = new Map(
        (visualModel?.nodes ?? []).map((node) => [node.id, node]),
      );
      const endpointParticipantId = (nodeId: string) => {
        const node = nodesById.get(nodeId);
        if (!node) return nodeId;
        if (node.stateSequenceRole === "sequence-participant") return node.id;
        return node.sequenceParticipantId || node.id;
      };
      const expectedEdge =
        visualModel?.edges?.find(
          (edge) =>
            endpointParticipantId(edge.source) === args.sourceNodeId &&
            endpointParticipantId(edge.target) === args.targetNodeId,
        ) ?? null;
      const expectedEdgeId = expectedEdge?.id ?? "";
      const selectedEdgeId =
        (element as unknown as MermaidSelectionProbe)._visualSelectionAnchorKey(
          "edge",
        ) ?? "";
      if (expectedEdgeId && selectedEdgeId === expectedEdgeId) {
        return { expectedEdgeId, selectedEdgeId, viewPoints: [] };
      }
      const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
      const gfx = (
        viewport?.querySelector("myoxus-surface") as
          | {
              _gfx?: {
                viewport?: {
                  toViewCoord?: (x: number, y: number) => [number, number];
                };
              };
            }
          | null
          | undefined
      )?._gfx;
      const source = block._getVisualNodeGfxModel?.(
        expectedEdge?.source ?? args.sourceNodeId,
      );
      const target = block._getVisualNodeGfxModel?.(
        expectedEdge?.target ?? args.targetNodeId,
      );
      if (
        !expectedEdgeId ||
        !source?.xywh ||
        !target?.xywh ||
        !gfx?.viewport?.toViewCoord ||
        !block._findVisualEdgeByModelPoint
      ) {
        return {
          expectedEdgeId,
          hasFindEdge: Boolean(block._findVisualEdgeByModelPoint),
          hasSource: Boolean(source?.xywh),
          hasTarget: Boolean(target?.xywh),
          hasToViewCoord: Boolean(gfx?.viewport?.toViewCoord),
          selectedEdgeId,
          viewPoints: [],
        };
      }
      const [sourceX, sourceY, sourceW, sourceH] = JSON.parse(source.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const [targetX, targetY, targetW, targetH] = JSON.parse(target.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const sourceCenter = {
        x: sourceX + sourceW / 2,
        y: sourceY + sourceH / 2,
      };
      const targetCenter = {
        x: targetX + targetW / 2,
        y: targetY + targetH / 2,
      };
      const path =
        block._getVisualEdgeGfxModel?.(expectedEdgeId)?.absolutePath ?? [];
      // Click the consumed route, including orthogonal bends. A straight chord
      // between node centers need not intersect the painted connection at all.
      const routeSamples = path.slice(1).flatMap((end, index) => {
        const start = path[index]!;
        return [0.5, 0.25, 0.75].map((ratio) => ({
          ratio,
          modelX: start[0] + (end[0] - start[0]) * ratio,
          modelY: start[1] + (end[1] - start[1]) * ratio,
        }));
      });
      const candidates = [
        ...routeSamples,
        ...[0.5, 0.42, 0.58, 0.34, 0.66].map((ratio) => ({
          ratio,
          modelX: sourceCenter.x + (targetCenter.x - sourceCenter.x) * ratio,
          modelY: sourceCenter.y + (targetCenter.y - sourceCenter.y) * ratio,
        })),
      ];
      const viewPoints = candidates
        .map(({ modelX, modelY, ratio }) => {
          const hitEdgeId = block._findVisualEdgeByModelPoint?.(modelX, modelY);
          const projected = block._gfxViewportBridge?.toViewPoint?.(
            modelX,
            modelY,
          );
          const view = projected
            ? ([projected.left, projected.top] as const)
            : gfx.viewport?.toViewCoord?.(modelX, modelY);
          if (
            hitEdgeId !== expectedEdgeId ||
            !view ||
            !Number.isFinite(view[0]) ||
            !Number.isFinite(view[1])
          ) {
            return null;
          }
          return {
            hitEdgeId,
            modelX,
            modelY,
            ratio,
            x: view[0],
            y: view[1],
          };
        })
        .filter(
          (
            point,
          ): point is {
            hitEdgeId: string;
            modelX: number;
            modelY: number;
            ratio: number;
            x: number;
            y: number;
          } => Boolean(point),
        );
      return { expectedEdgeId, selectedEdgeId, viewPoints };
    },
    { sourceNodeId, targetNodeId },
  );

  if (
    edgeProbe.expectedEdgeId &&
    edgeProbe.selectedEdgeId === edgeProbe.expectedEdgeId
  ) {
    return;
  }
  const debugSamples: unknown[] = [];
  for (const point of edgeProbe.viewPoints) {
    await visualCanvas.click({
      force: true,
      position: { x: point.x, y: point.y },
    });
    const debug = await mermaidBlock.evaluate((element, args) => {
      const block = element as unknown as {
        _findVisualEdgeByModelPoint?: (x: number, y: number) => string;
        _findVisualNodeByClientPoint?: (
          clientX: number,
          clientY: number,
        ) => string;
        _getScopedModelPointFromClient?: (
          clientX: number,
          clientY: number,
        ) => { x: number; y: number } | null;
        _scopedGfxNestedListenerElements?: EventTarget[];
        _scopedGfxViewportElement?: Element | null;
        querySelector: Element["querySelector"];
      };
      const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
      const rect = viewport?.getBoundingClientRect();
      if (!rect) return { ...args, reason: "viewport-missing" };
      const clientX = rect.left + args.x;
      const clientY = rect.top + args.y;
      const modelPoint = block._getScopedModelPointFromClient?.(
        clientX,
        clientY,
      );
      const target = document.elementFromPoint(
        clientX,
        clientY,
      ) as HTMLElement | null;
      return {
        ...args,
        clientX,
        clientY,
        edgeHit: modelPoint
          ? block._findVisualEdgeByModelPoint?.(modelPoint.x, modelPoint.y)
          : "",
        elementFromPoint: target
          ? {
              ariaLabel: target.getAttribute("aria-label"),
              className: String(target.className ?? ""),
              closestViewport: Boolean(
                target.closest(".myoxus-mermaid-gfx-viewport"),
              ),
              tagName: target.tagName,
              testId: target.dataset?.testid,
              viewportContainsTarget: Boolean(viewport?.contains(target)),
            }
          : null,
        modelPoint,
        nodeHit: block._findVisualNodeByClientPoint?.(clientX, clientY),
        scopedViewportAttached: block._scopedGfxViewportElement === viewport,
        listenerTargets:
          block._scopedGfxNestedListenerElements?.map((target) => ({
            isShadowRoot: target instanceof ShadowRoot,
            tagName: target instanceof Element ? target.tagName : "",
          })) ?? [],
        selectedEdgeId:
          (
            element as unknown as MermaidSelectionProbe
          )._visualSelectionAnchorKey("edge") ?? "",
        selectedNodeId:
          (
            element as unknown as MermaidSelectionProbe
          )._visualSelectionAnchorKey("node") ?? "",
      };
    }, point);
    debugSamples.push(debug);
    const selectedEdgeId =
      (debug as { selectedEdgeId?: string }).selectedEdgeId ?? "";
    if (selectedEdgeId === edgeProbe.expectedEdgeId) {
      return;
    }
  }

  const pointPairs = [
    [
      await flowchartNodePoint(mermaidBlock, sourceNodeId, 0.95, 0.5),
      await flowchartNodePoint(mermaidBlock, targetNodeId, 0.05, 0.5),
    ],
    [
      await flowchartNodePoint(mermaidBlock, sourceNodeId, 0.5, 0.95),
      await flowchartNodePoint(mermaidBlock, targetNodeId, 0.5, 0.05),
    ],
    [
      await flowchartNodePoint(mermaidBlock, sourceNodeId),
      await flowchartNodePoint(mermaidBlock, targetNodeId),
    ],
  ] as const;
  for (const [source, target] of pointPairs) {
    for (const ratio of [0.5, 0.42, 0.58, 0.34, 0.66]) {
      await visualCanvas.click({
        force: true,
        position: {
          x: source.x + (target.x - source.x) * ratio,
          y: source.y + (target.y - source.y) * ratio,
        },
      });
      const selectedEdgeId = await mermaidBlock.evaluate((element) => {
        return (
          (
            element as unknown as MermaidSelectionProbe
          )._visualSelectionAnchorKey("edge") ?? ""
        );
      });
      if (
        !edgeProbe.expectedEdgeId ||
        selectedEdgeId === edgeProbe.expectedEdgeId
      ) {
        return;
      }
    }
  }
  throw new Error(
    `Could not select Mermaid flowchart edge ${sourceNodeId}->${targetNodeId}: ${JSON.stringify({ edgeProbe, debugSamples })}`,
  );
}

export async function selectFlowchartNode(
  mermaidBlock: Locator,
  visualCanvas: Locator,
  nodeId: string,
): Promise<void> {
  const debugSamples: unknown[] = [];
  const ratios = [
    [0.5, 0.5],
    [0.32, 0.5],
    [0.68, 0.5],
    [0.5, 0.35],
    [0.5, 0.65],
  ] as const;
  for (const [rx, ry] of ratios) {
    let position = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
    await ensureFlowchartPointReachable(mermaidBlock, visualCanvas, position);
    position = await flowchartNodePoint(mermaidBlock, nodeId, rx, ry);
    await visualCanvas.click({ force: true, position });
    const selectedNodeId = await mermaidBlock.evaluate((element) => {
      return (
        (element as unknown as MermaidSelectionProbe)._visualSelectionAnchorKey(
          "node",
        ) ?? ""
      );
    });
    if (selectedNodeId === nodeId) {
      return;
    }
    debugSamples.push(
      await mermaidBlock.evaluate(
        (element, args) => {
          const block = element as unknown as {
            _findVisualNodeByClientPoint?: (
              clientX: number,
              clientY: number,
            ) => string;
            _findVisualSubgraphByModelPoint?: (x: number, y: number) => string;
            _findVisualSubgraphHeaderByModelPoint?: (
              x: number,
              y: number,
            ) => string;
            _getVisualNodeGfxModel?: (nodeId: string) => unknown;
            _getScopedModelPointFromClient?: (
              clientX: number,
              clientY: number,
            ) => { x: number; y: number } | null;
            querySelector: Element["querySelector"];
          };
          const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
          const rect = viewport?.getBoundingClientRect();
          if (!rect) return { ...args, reason: "viewport-missing" };
          const clientX = rect.left + args.position.x;
          const clientY = rect.top + args.position.y;
          const modelPoint = block._getScopedModelPointFromClient?.(
            clientX,
            clientY,
          );
          const target = document.elementFromPoint(
            clientX,
            clientY,
          ) as HTMLElement | null;
          return {
            ...args,
            clientX,
            clientY,
            elementFromPoint: target
              ? {
                  ariaLabel: target.getAttribute("aria-label"),
                  className: String(target.className ?? ""),
                  closestViewport: Boolean(
                    target.closest(".myoxus-mermaid-gfx-viewport"),
                  ),
                  tagName: target.tagName,
                  testId: target.dataset?.testid,
                  viewportContainsTarget: Boolean(viewport?.contains(target)),
                }
              : null,
            modelPoint,
            nodeModelFound: Boolean(
              block._getVisualNodeGfxModel?.(args.nodeId),
            ),
            nodeHit: block._findVisualNodeByClientPoint?.(clientX, clientY),
            selectedNodeId: (
              element as unknown as MermaidSelectionProbe
            )._visualSelectionAnchorKey("node"),
            selectedSubgraphId: (
              element as unknown as MermaidSelectionProbe
            )._visualSelectionAnchorKey("subgraph"),
            subgraphHeaderHit:
              modelPoint &&
              block._findVisualSubgraphHeaderByModelPoint?.(
                modelPoint.x,
                modelPoint.y,
              ),
            subgraphHit:
              modelPoint &&
              block._findVisualSubgraphByModelPoint?.(
                modelPoint.x,
                modelPoint.y,
              ),
          };
        },
        { nodeId, position, rx, ry },
      ),
    );
  }
  throw new Error(
    `Could not select Mermaid flowchart node ${nodeId}: ${JSON.stringify(
      debugSamples,
    )}`,
  );
}

/**
 * Keeps Page-mode GFX diagrams pointer-reachable after Workbench context opens.
 * A compact modal Drawer must close before canvas input. A desktop rail is part
 * of the workarea contract and therefore must remain open and pointer-reachable.
 */
export async function ensureFlowchartPointReachable(
  mermaidBlock: Locator,
  visualCanvas: Locator,
  point: { x: number; y: number },
): Promise<void> {
  const contextDrawer = mermaidBlock
    .page()
    .locator('[data-myoxus-ui-role="workbench-context-panel-drawer"]')
    .getByRole("dialog");
  if (await contextDrawer.isVisible().catch(() => false)) {
    await contextDrawer.getByRole("button", { name: "Close" }).click();
    await expect(contextDrawer).toBeHidden();
  }
  const box = await visualCanvas.boundingBox();
  if (!box) throw new Error("Mermaid visual canvas is not visible");
  const inset = 8;
  const reachable =
    point.x >= inset &&
    point.x <= box.width - inset &&
    point.y >= inset &&
    point.y <= box.height - inset;
  if (!reachable) {
    // The Facade role labels Autosize's root; its inner viewport owns scrolling.
    const scrollViewport = mermaidBlock
      .locator('[data-myoxus-ui-role="mermaid-page-scroll-viewport"]')
      .locator(".mantine-ScrollArea-viewport")
      .first();
    const position = () =>
      scrollViewport.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      }));
    const before = await position();
    await visualCanvas.hover({
      position: { x: box.width / 2, y: box.height / 2 },
    });
    await mermaidBlock
      .page()
      .mouse.wheel(point.x - box.width / 2, point.y - box.height / 2);
    const extent = await scrollViewport.evaluate((element) => ({
      width: element.scrollWidth,
      height: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
    }));
    await expect
      .poll(position, {
        message: `Scroll to ${JSON.stringify(point)} within ${JSON.stringify(extent)}`,
      })
      .not.toEqual(before);
  }
}

export async function renameFlowchartNodeInline(
  page: Page,
  mermaidBlock: Locator,
  visualCanvas: Locator,
  nodeId: string,
  label: string,
  options: { onEditorOpen?: () => Promise<void> } = {},
): Promise<void> {
  const inlineEditor = page
    .locator(
      ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor .inline-editor",
    )
    .first();
  let opened = false;
  const horizontalRatios = [0.5, 0.3, 0.7] as const;
  for (
    let attempt = 0;
    attempt < horizontalRatios.length && !opened;
    attempt += 1
  ) {
    const ratio = horizontalRatios[attempt];
    let point = await flowchartNodePoint(mermaidBlock, nodeId, ratio, 0.5);
    await ensureFlowchartPointReachable(mermaidBlock, visualCanvas, point);
    point = await flowchartNodePoint(mermaidBlock, nodeId, ratio, 0.5);
    const canvasBox = await visualCanvas.boundingBox();
    if (!canvasBox) {
      throw new Error(
        `Mermaid visual canvas is not visible for node ${nodeId}`,
      );
    }
    await page.mouse.dblclick(canvasBox.x + point.x, canvasBox.y + point.y);
    opened = await inlineEditor
      .isVisible({
        timeout: attempt === 0 ? 1_500 : attempt === 1 ? 3_000 : 10_000,
      })
      .catch(() => false);
  }
  if (!opened) {
    const point = await flowchartNodePoint(mermaidBlock, nodeId);
    const canvasBox = await visualCanvas.boundingBox();
    const debug = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y) as HTMLElement | null;
        return {
          className: element?.className ?? "",
          tagName: element?.tagName ?? "",
          text: element?.textContent?.slice(0, 120) ?? "",
        };
      },
      {
        x: (canvasBox?.x ?? 0) + point.x,
        y: (canvasBox?.y ?? 0) + point.y,
      },
    );
    const blockDebug = await mermaidBlock.evaluate(
      (element, payload) => {
        const block = element as unknown as {
          _getScopedGfxEditorHost?: () => Element | null;
          _findVisualNodeByClientPoint?: (
            clientX: number,
            clientY: number,
          ) => string;
          _getVisualNodeGfxModel?: (nodeId: string) =>
            | {
                constructor?: { name?: string };
                id?: string;
                text?: { toString?: () => string };
                type?: string;
                yMap?: { get?: (key: string) => unknown };
              }
            | null
            | undefined;
          querySelector: Element["querySelector"];
        };
        const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
        const viewportRect = viewport?.getBoundingClientRect();
        const clientX = (viewportRect?.left ?? 0) + payload.point.x;
        const clientY = (viewportRect?.top ?? 0) + payload.point.y;
        const editorHost = block._getScopedGfxEditorHost?.();
        const model = block._getVisualNodeGfxModel?.(payload.nodeId);
        return {
          editorHostHasMountPoint: Boolean(
            editorHost?.querySelector(".edgeless-mount-point"),
          ),
          editorHostTag: editorHost?.tagName ?? "",
          hasGetScopedGfxEditorHost: Boolean(block._getScopedGfxEditorHost),
          hasEdgelessRoot: Boolean(
            viewport?.querySelector("myoxus-edgeless-root"),
          ),
          hasMountPoint: Boolean(
            viewport?.querySelector(".edgeless-mount-point"),
          ),
          hitNodeId:
            block._findVisualNodeByClientPoint?.(clientX, clientY) ?? "",
          model: model
            ? {
                constructorName: model.constructor?.name ?? "",
                id: model.id ?? "",
                label: String(model.yMap?.get?.("mermaidNodeLabel") ?? ""),
                role: String(model.yMap?.get?.("mermaidRole") ?? ""),
                text: model.text?.toString?.() ?? "",
                type: model.type ?? "",
              }
            : null,
          viewportChildren: Array.from(viewport?.children ?? []).map(
            (child) => child.tagName,
          ),
          viewportTag: viewport?.tagName ?? "",
        };
      },
      { nodeId, point },
    );
    throw new Error(
      `Inline Mermaid shape text editor did not open for node ${nodeId}: ${JSON.stringify(
        { blockDebug, canvasBox, debug, point },
      )}`,
    );
  }

  await expect(inlineEditor).toBeVisible({ timeout: 10_000 });
  await inlineEditor.click();
  const focused = await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const inlineEditor = document.querySelector(
            ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor .inline-editor",
          );
          return (
            document.activeElement === inlineEditor ||
            Boolean(inlineEditor?.contains(document.activeElement))
          );
        }),
      { timeout: 5_000 },
    )
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
  if (!focused) {
    const focusDebug = await page.evaluate(() => {
      const inlineEditor = document.querySelector(
        ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor .inline-editor",
      ) as HTMLInputElement | HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      return {
        activeClassName: activeElement?.className ?? "",
        activeTagName: activeElement?.tagName ?? "",
        editorText:
          inlineEditor instanceof HTMLInputElement ||
          inlineEditor instanceof HTMLTextAreaElement
            ? inlineEditor.value
            : (inlineEditor?.textContent ?? ""),
        hasMermaidNodeEditor: Boolean(
          document.querySelector(".myoxus-mermaid-inline-node-editor"),
        ),
        hasShapeTextEditor: Boolean(
          document.querySelector("edgeless-shape-text-editor"),
        ),
      };
    });
    throw new Error(
      `Inline Mermaid shape text editor did not receive focus for node ${nodeId}: ${JSON.stringify(
        focusDebug,
      )}`,
    );
  }
  const isStableMermaidInput = await inlineEditor.evaluate((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.select();
      return true;
    }
    const richText = element.closest("rich-text") as
      | (HTMLElement & {
          inlineEditor?: { selectAll?: () => void };
        })
      | null;
    richText?.inlineEditor?.selectAll?.();
    return false;
  });
  await options.onEditorOpen?.();
  if (isStableMermaidInput) {
    await inlineEditor.fill(label);
    // The stable overlay owns a native input listener rather than a framework
    // value binding. Dispatch explicitly so the test exercises the same
    // source-sync contract even when Playwright optimizes a fill operation.
    await inlineEditor.dispatchEvent("input", { bubbles: true });
  } else {
    await inlineEditor.pressSequentially(label);
  }
  const postTypingDebug = await mermaidBlock.evaluate(
    (element, targetNodeId) => {
      const inlineEditor = document.querySelector(
        ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor .inline-editor",
      ) as HTMLInputElement | HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      const block = element as unknown as {
        _getVisualNodeGfxModel?: (nodeId: string) =>
          | {
              text?: { toString?: () => string };
              yMap?: { get?: (key: string) => unknown };
            }
          | null
          | undefined;
        model?: { props?: { source?: { toString?: () => string } } };
      };
      const model = block._getVisualNodeGfxModel?.(targetNodeId);
      return {
        activeClassName: activeElement?.className ?? "",
        activeTagName: activeElement?.tagName ?? "",
        inlineEditorText:
          inlineEditor instanceof HTMLInputElement ||
          inlineEditor instanceof HTMLTextAreaElement
            ? inlineEditor.value
            : (inlineEditor?.textContent ?? ""),
        modelText: model?.text?.toString?.() ?? "",
        nodeLabel: String(model?.yMap?.get?.("mermaidNodeLabel") ?? ""),
        selectedVisualNodeId:
          (
            element as unknown as MermaidSelectionProbe
          )._visualSelectionAnchorKey("node") ?? "",
        source: block.model?.props?.source?.toString?.() ?? "",
      };
    },
    nodeId,
  );
  await inlineEditor.press("Enter");
  await expect(
    page.locator(
      ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor",
    ),
  ).toHaveCount(0, { timeout: 10_000 });
  const synced = await expect
    .poll(
      async () => {
        return mermaidBlock.evaluate((element, expectedLabel) => {
          const block = element as unknown as {
            model?: { props?: { source?: { toString?: () => string } } };
          };
          return block.model?.props?.source
            ?.toString?.()
            .includes(expectedLabel);
        }, label);
      },
      { timeout: 10_000 },
    )
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
  if (!synced) {
    const finalDebug = await mermaidBlock.evaluate(
      (element, expectedNodeId) => {
        const block = element as unknown as {
          _getVisualNodeGfxModel?: (nodeId: string) =>
            | {
                text?: { toString?: () => string };
                yMap?: { get?: (key: string) => unknown };
              }
            | null
            | undefined;
          model?: { props?: { source?: { toString?: () => string } } };
        };
        const model = block._getVisualNodeGfxModel?.(expectedNodeId);
        return {
          modelText: model?.text?.toString?.() ?? "",
          nodeLabel: String(model?.yMap?.get?.("mermaidNodeLabel") ?? ""),
          source: block.model?.props?.source?.toString?.() ?? "",
        };
      },
      nodeId,
    );
    throw new Error(
      `Inline Mermaid shape rename did not sync source for node ${nodeId}: ${JSON.stringify(
        { finalDebug, label, postTypingDebug },
      )}`,
    );
  }
}

export async function renameFlowchartDetailInline(
  page: Page,
  mermaidBlock: Locator,
  visualCanvas: Locator,
  ownerNodeId: string,
  sourceKey: string,
  label: string,
): Promise<void> {
  const inlineEditor = page
    .locator(
      ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor .inline-editor",
    )
    .first();
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    const point = await flowchartDetailPoint(
      mermaidBlock,
      ownerNodeId,
      sourceKey,
      0.18,
      0.5,
    );
    const canvasBox = await visualCanvas.boundingBox();
    if (!canvasBox) {
      throw new Error(
        `Mermaid visual canvas is not visible for detail ${ownerNodeId}.${sourceKey}`,
      );
    }
    await page.mouse.dblclick(canvasBox.x + point.x, canvasBox.y + point.y);
    opened = await inlineEditor
      .isVisible({ timeout: attempt === 0 ? 1_500 : 10_000 })
      .catch(() => false);
  }
  if (!opened) {
    const point = await flowchartDetailPoint(
      mermaidBlock,
      ownerNodeId,
      sourceKey,
      0.18,
      0.5,
    );
    throw new Error(
      `Inline Mermaid detail editor did not open for ${ownerNodeId}.${sourceKey}: ${JSON.stringify(
        point,
      )}`,
    );
  }

  await expect(inlineEditor).toBeVisible({ timeout: 10_000 });
  await inlineEditor.click();
  const isStableMermaidInput = await inlineEditor.evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      element.select();
      return true;
    }
    const richText = element.closest("rich-text") as
      | (HTMLElement & {
          inlineEditor?: { selectAll?: () => void };
        })
      | null;
    richText?.inlineEditor?.selectAll?.();
    return false;
  });
  if (isStableMermaidInput) {
    // `pressSequentially` treats a leading `+` as a keyboard chord in some
    // Chromium revisions. Fill the stable semantic overlay as text so Class
    // visibility markers reach the source writer byte-for-byte.
    await inlineEditor.fill(label);
    await inlineEditor.dispatchEvent("input", { bubbles: true });
  } else {
    await inlineEditor.pressSequentially(label);
  }
  await inlineEditor.press("Enter");
  await expect(
    page.locator(
      ".myoxus-mermaid-inline-node-editor, edgeless-shape-text-editor",
    ),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(
      async () =>
        mermaidBlock.evaluate((element, expectedLabel) => {
          const block = element as unknown as {
            model?: { props?: { source?: { toString?: () => string } } };
          };
          return block.model?.props?.source
            ?.toString?.()
            .includes(expectedLabel);
        }, label),
      { timeout: 10_000 },
    )
    .toBe(true);
}

export async function renameFlowchartEdgeInline(
  page: Page,
  mermaidBlock: Locator,
  visualCanvas: Locator,
  sourceNodeId: string,
  targetNodeId: string,
  label: string,
): Promise<void> {
  await selectFlowchartEdge(
    mermaidBlock,
    visualCanvas,
    sourceNodeId,
    targetNodeId,
  );
  const editPoint = await mermaidBlock.evaluate(
    (element, args) => {
      const block = element as unknown as {
        _findVisualEdgeByModelPoint?: (x: number, y: number) => string;
        _getMermaidVisualModelForEditing?: () => {
          edges?: Array<{ id: string; source: string; target: string }>;
          nodes?: Array<{
            id: string;
            sequenceParticipantId?: string;
            stateSequenceRole?: string;
          }>;
        } | null;
        _getVisualNodeGfxModel?: (
          nodeId: string,
        ) => { xywh?: string } | null | undefined;
        querySelector: Element["querySelector"];
      };
      const visualModel = block._getMermaidVisualModelForEditing?.();
      const endpointParticipantId = (nodeId: string) => {
        const node = visualModel?.nodes?.find(
          (candidate) => candidate.id === nodeId,
        );
        if (!node) return nodeId;
        if (node.stateSequenceRole === "sequence-participant") return node.id;
        return node.sequenceParticipantId || node.id;
      };
      const selectedEdgeId =
        (element as unknown as MermaidSelectionProbe)._visualSelectionAnchorKey(
          "edge",
        ) ?? "";
      const matchingEdges =
        visualModel?.edges?.filter(
          (candidate) =>
            endpointParticipantId(candidate.source) === args.sourceNodeId &&
            endpointParticipantId(candidate.target) === args.targetNodeId,
        ) ?? [];
      const edge =
        matchingEdges.find((candidate) => candidate.id === selectedEdgeId) ??
        matchingEdges[0] ??
        null;
      const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
      const gfx = (
        viewport?.querySelector("myoxus-surface") as
          | {
              _gfx?: {
                viewport?: {
                  toViewCoord?: (x: number, y: number) => [number, number];
                };
              };
            }
          | null
          | undefined
      )?._gfx;
      const source = block._getVisualNodeGfxModel?.(
        edge?.source ?? args.sourceNodeId,
      );
      const target = block._getVisualNodeGfxModel?.(
        edge?.target ?? args.targetNodeId,
      );
      if (
        !edge ||
        !source?.xywh ||
        !target?.xywh ||
        !gfx?.viewport?.toViewCoord ||
        !block._findVisualEdgeByModelPoint
      ) {
        throw new Error(
          `Inline edge edit point unavailable: ${JSON.stringify({
            edge,
            hasFindEdge: Boolean(block._findVisualEdgeByModelPoint),
            hasSource: Boolean(source?.xywh),
            hasTarget: Boolean(target?.xywh),
            hasToViewCoord: Boolean(gfx?.viewport?.toViewCoord),
            selectedEdgeId,
          })}`,
        );
      }
      const [sourceX, sourceY, sourceW, sourceH] = JSON.parse(source.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const [targetX, targetY, targetW, targetH] = JSON.parse(target.xywh) as [
        number,
        number,
        number,
        number,
      ];
      const sourceCenter = {
        x: sourceX + sourceW / 2,
        y: sourceY + sourceH / 2,
      };
      const targetCenter = {
        x: targetX + targetW / 2,
        y: targetY + targetH / 2,
      };
      for (const ratio of [0.5, 0.42, 0.58, 0.34, 0.66]) {
        const modelX =
          sourceCenter.x + (targetCenter.x - sourceCenter.x) * ratio;
        const modelY =
          sourceCenter.y + (targetCenter.y - sourceCenter.y) * ratio;
        if (block._findVisualEdgeByModelPoint(modelX, modelY) !== edge.id) {
          continue;
        }
        const view = gfx.viewport.toViewCoord(modelX, modelY);
        return { modelX, modelY, x: view[0], y: view[1] };
      }
      throw new Error(`No inline edit hit point found for edge ${edge.id}`);
    },
    { sourceNodeId, targetNodeId },
  );

  const connectorLabelEditor = page
    .locator("edgeless-connector-label-editor rich-text")
    .first();
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    const canvasBox = await visualCanvas.boundingBox();
    if (!canvasBox) {
      throw new Error(
        `Mermaid visual canvas is not visible for edge ${sourceNodeId} -> ${targetNodeId}`,
      );
    }
    await page.mouse.dblclick(
      canvasBox.x + editPoint.x,
      canvasBox.y + editPoint.y,
    );
    opened = await connectorLabelEditor
      .isVisible({ timeout: attempt === 0 ? 1_500 : 10_000 })
      .catch(() => false);
  }
  if (!opened) {
    const canvasBox = await visualCanvas.boundingBox();
    const debug = await mermaidBlock.evaluate(
      (element, args) => {
        const block = element as unknown as {
          _getScopedModelPointFromClient?: (
            clientX: number,
            clientY: number,
          ) => { x: number; y: number } | null;
          _findVisualEdgeByModelPoint?: (x: number, y: number) => string;
          _findVisualNodeByClientPoint?: (
            clientX: number,
            clientY: number,
          ) => string;
          _getScopedGfxEditorHost?: () => Element | null;
          _getVisualEdgeGfxModel?: (edgeId: string) =>
            | {
                constructor?: { name?: string };
                id?: string;
                isLocked?: () => boolean;
                labelEditing?: boolean;
                text?: { toString?: () => string };
              }
            | null
            | undefined;
          _scopedGfxNestedListenerElements?: EventTarget[];
        };
        const selectedEdgeId =
          (
            element as unknown as MermaidSelectionProbe
          )._visualSelectionAnchorKey("edge") ?? "";
        const connector = block._getVisualEdgeGfxModel?.(selectedEdgeId);
        const clientModelPoint = block._getScopedModelPointFromClient?.(
          args.clientX,
          args.clientY,
        );
        const target = document.elementFromPoint(
          args.clientX,
          args.clientY,
        ) as HTMLElement | null;
        return {
          connector: connector
            ? {
                constructorName: connector.constructor?.name ?? "",
                id: connector.id ?? "",
                isLocked: connector.isLocked?.() ?? null,
                labelEditing: connector.labelEditing ?? null,
                text: connector.text?.toString?.() ?? "",
              }
            : null,
          clientHit: clientModelPoint
            ? {
                edgeId:
                  block._findVisualEdgeByModelPoint?.(
                    clientModelPoint.x,
                    clientModelPoint.y,
                  ) ?? "",
                modelX: clientModelPoint.x,
                modelY: clientModelPoint.y,
                nodeId:
                  block._findVisualNodeByClientPoint?.(
                    args.clientX,
                    args.clientY,
                  ) ?? "",
              }
            : null,
          hasConnectorEditor: Boolean(
            document.querySelector("edgeless-connector-label-editor"),
          ),
          hostTag: block._getScopedGfxEditorHost?.()?.tagName ?? "",
          hostHasMountPoint: Boolean(
            block
              ._getScopedGfxEditorHost?.()
              ?.querySelector(".edgeless-mount-point"),
          ),
          listenerTargets:
            block._scopedGfxNestedListenerElements?.map((target) => ({
              isShadowRoot: target instanceof ShadowRoot,
              tagName: target instanceof Element ? target.tagName : "",
            })) ?? [],
          targetHasListener: Boolean(
            target && block._scopedGfxNestedListenerElements?.includes(target),
          ),
          selectedEdgeId,
          target: target
            ? {
                ariaLabel: target.getAttribute("aria-label"),
                className: String(target.className ?? ""),
                tagName: target.tagName,
                text: target.textContent?.slice(0, 120) ?? "",
              }
            : null,
        };
      },
      {
        clientX: (canvasBox?.x ?? 0) + editPoint.x,
        clientY: (canvasBox?.y ?? 0) + editPoint.y,
      },
    );
    throw new Error(
      `Inline Mermaid connector label editor did not open for edge ${sourceNodeId} -> ${targetNodeId}: ${JSON.stringify(
        { debug, editPoint },
      )}`,
    );
  }
  await expect(connectorLabelEditor).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const richText = document.querySelector(
            "edgeless-connector-label-editor rich-text",
          );
          return (
            document.activeElement === richText ||
            Boolean(richText?.contains(document.activeElement))
          );
        }),
      { timeout: 5_000 },
    )
    .toBe(true);
  await connectorLabelEditor.click();
  await connectorLabelEditor.evaluate((element, nextLabel) => {
    // The product path under test is opening the native connector RichText
    // editor from the visible edge. Use the editor API for deterministic text
    // replacement; synthetic key streams can be interrupted by managed-frame
    // reconciliation in browser smoke runs before all characters arrive.
    type InlineEditorLike = {
      deleteText?: (range: { index: number; length: number }) => void;
      getInlineRange?: () => { index: number; length: number } | null;
      insertText?: (
        range: { index: number; length: number },
        text: string,
      ) => void;
      selectAll?: () => void;
      setInlineRange?: (range: { index: number; length: number }) => void;
      yTextLength?: number;
    };
    const inlineEditor = (
      element as HTMLElement & {
        inlineEditor?: InlineEditorLike;
      }
    ).inlineEditor;
    if (!inlineEditor) {
      throw new Error("Connector label rich-text inline editor is unavailable");
    }
    const length = inlineEditor.yTextLength ?? 0;
    inlineEditor.selectAll?.();
    inlineEditor.deleteText?.({ index: 0, length });
    inlineEditor.insertText?.({ index: 0, length: 0 }, nextLabel);
    inlineEditor.setInlineRange?.({ index: nextLabel.length, length: 0 });
  }, label);
  await page.keyboard.press("Escape");
  const canvasBox = await visualCanvas.boundingBox();
  if (canvasBox) {
    await page.mouse.click(canvasBox.x + 4, canvasBox.y + 4);
  }
  await expect(page.locator("edgeless-connector-label-editor")).toHaveCount(0, {
    timeout: 10_000,
  });
  const finalSource = await expect
    .poll(
      async () =>
        mermaidBlock.evaluate((element) => {
          const block = element as unknown as {
            model?: { props?: { source?: { toString?: () => string } } };
          };
          return block.model?.props?.source?.toString?.() ?? "";
        }),
      { timeout: 10_000 },
    )
    .toContain(label)
    .then(
      () => "",
      async () =>
        mermaidBlock.evaluate((element) => {
          const block = element as unknown as {
            _getVisualEdgeGfxModel?: (edgeId: string) =>
              | {
                  text?: { toString?: () => string };
                }
              | null
              | undefined;
            model?: { props?: { source?: { toString?: () => string } } };
          };
          const edgeId =
            (
              element as unknown as MermaidSelectionProbe
            )._visualSelectionAnchorKey("edge") ?? "";
          return JSON.stringify({
            edgeId,
            source: block.model?.props?.source?.toString?.() ?? "",
            text:
              block._getVisualEdgeGfxModel?.(edgeId)?.text?.toString?.() ?? "",
          });
        }),
    );
  if (finalSource) {
    throw new Error(
      `Inline Mermaid connector label edit did not sync source for ${sourceNodeId} -> ${targetNodeId}: ${finalSource}`,
    );
  }
}

export async function flowchartNodeSize(
  mermaidBlock: Locator,
  nodeId: string,
): Promise<{ height: number; width: number }> {
  return mermaidBlock.evaluate((element, targetNodeId) => {
    const block = element as unknown as {
      _getVisualNodeGfxModel?: (id: string) => { xywh?: string } | null;
    };
    const node = block._getVisualNodeGfxModel?.(targetNodeId);
    if (!node?.xywh) {
      throw new Error(`Mermaid flowchart node ${targetNodeId} has no GFX size`);
    }
    const [, , width, height] = JSON.parse(node.xywh) as [
      number,
      number,
      number,
      number,
    ];
    return { height, width };
  }, nodeId);
}
export async function dragFlowchartResizeHandle(
  page: Page,
  resizeHandle: Locator,
  visualCanvas: Locator,
  targetPosition: { x: number; y: number },
): Promise<void> {
  const handleBox = await resizeHandle.boundingBox();
  const canvasBox = await visualCanvas.boundingBox();
  expect(
    handleBox,
    "Mermaid Flowchart resize handle must be visible before dragging",
  ).toBeTruthy();
  expect(
    canvasBox,
    "Mermaid Flowchart GFX viewport must be visible before dragging",
  ).toBeTruthy();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBox!.x + targetPosition.x,
    canvasBox!.y + targetPosition.y,
    { steps: 8 },
  );
  await page.mouse.up();
}
