import { Bound } from "@virgultum/global/gfx";
import { getMermaidSubgraphCollapseBound } from "@virgultum/model";

import { getMermaidGfxSelectionIdentity } from "./mermaid-gfx-selection.js";
import { readMermaidGfxMeta } from "./mermaid-gfx-metadata.js";

type MermaidGfxHitModel = {
  type?: string;
  xywh?: string;
  hidden?: boolean;
  display?: boolean;
};

type MermaidGfxHitNode = {
  id: string;
  xywh?: string;
  hidden?: boolean;
};

type MermaidGfxHitEdge = {
  id: string;
  source: string;
  target: string;
  hidden?: boolean;
};

type MermaidGfxHitConnector = {
  hidden?: boolean;
  display?: boolean;
  absolutePath?: readonly unknown[];
  includesPoint?: (
    x: number,
    y: number,
    options?: { hitThreshold?: boolean },
  ) => boolean;
};

/** Drawing and both native/Page selection paths use the same visibility state. */
export function isMermaidGfxHitVisible(model: unknown) {
  const raw = model as MermaidGfxHitModel | null | undefined;
  return (
    !!raw &&
    raw.hidden !== true &&
    raw.display !== false &&
    readMermaidGfxMeta(raw, "hidden") !== "true" &&
    readMermaidGfxMeta(raw, "display") !== "false"
  );
}
function collapseBound(model: MermaidGfxHitModel, bound: Bound) {
  return getMermaidSubgraphCollapseBound({
    x: bound.x,
    y: bound.y,
    w: bound.w,
    h: bound.h,
    yMap: {
      get: (key) =>
        key === "mermaidSubgraphCollapsible"
          ? readMermaidGfxMeta(model, key) === "true"
          : readMermaidGfxMeta(model, key),
    },
  });
}

function isUnlabeledMarker(model: unknown) {
  const raw = model as
    { yMap?: { get?: (key: string) => unknown } } | null | undefined;
  return (
    raw?.yMap?.get?.("mermaidNodeDenseLabel") === true &&
    !String(raw?.yMap?.get?.("mermaidNodeDisplayLabel") ?? "").trim()
  );
}

function preferSemanticStateNode<T>(models: readonly T[]) {
  return models.find((model) => !isUnlabeledMarker(model)) ?? models[0];
}

function containsPoint(bound: Bound, x: number, y: number) {
  return (
    x >= bound.x &&
    x <= bound.x + bound.w &&
    y >= bound.y &&
    y <= bound.y + bound.h
  );
}

export function getMermaidGfxHitTestModels({
  elementIds,
  getModel,
}: {
  elementIds: readonly string[];
  getModel: (id: string) => unknown;
}) {
  return [...elementIds].reverse().map((id) => getModel(id));
}

export function findMermaidGfxNodeIdFromNativeHits(hits: unknown) {
  const hit = findMermaidGfxNodeModelFromNativeHits(hits);
  return hit ? getMermaidGfxSelectionIdentity(hit).nodeId : "";
}

export function findMermaidGfxNodeModelFromNativeHits<T = unknown>(
  hits: unknown,
): T | null {
  const hitModels = (Array.isArray(hits) ? hits : hits ? [hits] : []).reverse();
  const nodeModels = hitModels.filter(
    (model) =>
      isMermaidGfxHitVisible(model) &&
      getMermaidGfxSelectionIdentity(model).isNodeShape,
  ) as T[];
  return preferSemanticStateNode(nodeModels) ?? null;
}

export function findMermaidGfxNodeIdByModelPoint(
  models: readonly unknown[],
  x: number,
  y: number,
) {
  const model = findMermaidGfxNodeModelByModelPoint(models, x, y);
  return model ? getMermaidGfxSelectionIdentity(model).nodeId : "";
}

export function findMermaidGfxNodeModelByModelPoint<T = unknown>(
  models: readonly unknown[],
  x: number,
  y: number,
): T | null {
  const candidates: T[] = [];
  for (const model of models) {
    const raw = model as MermaidGfxHitModel | null | undefined;
    if (!isMermaidGfxHitVisible(raw) || raw?.type !== "shape" || !raw.xywh)
      continue;
    if (!containsPoint(Bound.deserialize(raw.xywh).expand(10), x, y)) continue;
    const identity = getMermaidGfxSelectionIdentity(raw);
    if (identity.isNodeShape && identity.nodeId) candidates.push(model as T);
  }
  return preferSemanticStateNode(candidates) ?? null;
}

export function findMermaidGfxEdgeIdByModelPoint({
  connectors,
  edges,
  nodes,
  x,
  y,
}: {
  connectors?: readonly unknown[];
  edges: readonly MermaidGfxHitEdge[];
  nodes: readonly MermaidGfxHitNode[];
  x: number;
  y: number;
}) {
  let hasRenderedConnectorPath = false;
  const hiddenEdges = new Set<string>();
  for (const candidate of connectors ?? []) {
    const connector = candidate as MermaidGfxHitConnector;
    const identity = getMermaidGfxSelectionIdentity(connector);
    if (!identity.isEdgeConnector || !identity.edgeId) continue;
    if ((connector.absolutePath?.length ?? 0) >= 2) {
      hasRenderedConnectorPath = true;
    }
    if (!isMermaidGfxHitVisible(connector)) {
      hiddenEdges.add(identity.edgeId);
      continue;
    }
    if (connector.includesPoint?.(x, y, { hitThreshold: true })) {
      return identity.edgeId;
    }
  }

  // The connector manager owns the actual straight, curved or orthogonal path.
  // Once that path exists, a center-to-center chord would make empty canvas
  // selectable while missing visible elbow segments.
  if (hasRenderedConnectorPath) return "";

  const nodeBounds = new Map<string, Bound>();
  for (const node of nodes) {
    if (node.hidden || !node.xywh) continue;
    const bound = Bound.deserialize(node.xywh);
    nodeBounds.set(node.id, bound);
  }

  let closestEdgeId = "";
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    if (edge.hidden || hiddenEdges.has(edge.id)) continue;
    const sourceBound = nodeBounds.get(edge.source);
    const targetBound = nodeBounds.get(edge.target);
    if (!sourceBound || !targetBound) continue;

    const sourceX = sourceBound.x + sourceBound.w / 2;
    const sourceY = sourceBound.y + sourceBound.h / 2;
    const targetX = targetBound.x + targetBound.w / 2;
    const targetY = targetBound.y + targetBound.h / 2;
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0) continue;

    const projection = Math.max(
      0,
      Math.min(1, ((x - sourceX) * dx + (y - sourceY) * dy) / lengthSquared),
    );
    if (projection < 0.18 || projection > 0.82) continue;
    const projectedX = sourceX + projection * dx;
    const projectedY = sourceY + projection * dy;
    const distance = Math.hypot(x - projectedX, y - projectedY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestEdgeId = edge.id;
    }
  }

  return closestDistance <= 18 ? closestEdgeId : "";
}

export function findMermaidGfxSubgraphIdByModelPoint(
  models: readonly unknown[],
  x: number,
  y: number,
) {
  let closest: { area: number; id: string } | null = null;
  for (const model of models) {
    const raw = model as MermaidGfxHitModel | null | undefined;
    if (!isMermaidGfxHitVisible(raw) || raw?.type !== "shape" || !raw.xywh)
      continue;
    const identity = getMermaidGfxSelectionIdentity(raw);
    if (!identity.isSubgraphShape) continue;
    const bound = Bound.deserialize(raw.xywh);
    if (!containsPoint(bound.expand(8), x, y)) continue;
    const area = bound.w * bound.h;
    if (!closest || area < closest.area) {
      closest = { area, id: identity.subgraphId };
    }
  }
  return closest?.id ?? "";
}

export function findMermaidGfxSubgraphHeaderIdByModelPoint(
  models: readonly unknown[],
  x: number,
  y: number,
) {
  let closest: { area: number; id: string } | null = null;
  for (const model of models) {
    const raw = model as MermaidGfxHitModel | null | undefined;
    if (!isMermaidGfxHitVisible(raw) || raw?.type !== "shape" || !raw.xywh)
      continue;
    const identity = getMermaidGfxSelectionIdentity(raw);
    if (!identity.isSubgraphShape) continue;
    const bound = Bound.deserialize(raw.xywh);
    const collapse = collapseBound(raw, bound);
    if (collapse && containsPoint(Bound.from(collapse), x, y)) continue;
    const measuredHeader = Number(
      readMermaidGfxMeta(raw, "mermaidSubgraphHeaderHeight"),
    );
    const headerHeight =
      measuredHeader > 0
        ? Math.min(bound.h, measuredHeader)
        : Math.min(44, Math.max(30, bound.h * 0.18));
    if (
      x >= bound.x - 8 &&
      x <= bound.x + bound.w + 8 &&
      y >= bound.y - 8 &&
      y <= bound.y + headerHeight
    ) {
      const area = bound.w * bound.h;
      if (!closest || area < closest.area) {
        closest = { area, id: identity.subgraphId };
      }
    }
  }
  return closest?.id ?? "";
}

/** Collapse is its own technical hit, independent of header edit and resize. */
export function findMermaidGfxSubgraphCollapseIdByModelPoint(
  models: readonly unknown[],
  x: number,
  y: number,
) {
  let closest: { area: number; id: string } | null = null;
  for (const model of models) {
    const raw = model as MermaidGfxHitModel | null | undefined;
    if (!isMermaidGfxHitVisible(raw) || raw?.type !== "shape" || !raw.xywh)
      continue;
    const identity = getMermaidGfxSelectionIdentity(raw);
    if (!identity.isSubgraphShape) continue;
    const bound = Bound.deserialize(raw.xywh),
      collapse = collapseBound(raw, bound);
    if (!collapse || !containsPoint(Bound.from(collapse), x, y)) continue;
    const area = bound.w * bound.h;
    if (!closest || area < closest.area)
      closest = { area, id: identity.subgraphId };
  }
  return closest?.id ?? "";
}
