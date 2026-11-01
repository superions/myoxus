import type { MermaidVisualModel } from "./families/runtime/gfx-model.js";

export type MermaidGfxPoint = {
  x: number;
  y: number;
};

type MermaidGfxPreviewProperty = "labelXYWH" | "xywh";

export function releaseMermaidGfxPreviewProperty(
  element: {
    pop(prop: MermaidGfxPreviewProperty): void;
    yMap: { get(prop: MermaidGfxPreviewProperty): unknown };
  },
  prop: MermaidGfxPreviewProperty,
) {
  Object.assign(element, { [prop]: element.yMap.get(prop) });
  element.pop(prop);
}

export function accumulateMermaidGfxNodeDrag(
  model: MermaidVisualModel,
  nodeId: string,
  dx: number,
  dy: number,
) {
  return {
    ...model,
    nodes: model.nodes.map((node) =>
      node.id === nodeId ? { ...node, x: node.x + dx, y: node.y + dy } : node,
    ),
  };
}

export function resolveMermaidGfxNodeDragDelta({
  lastPoint,
  minDelta = 0.5,
  nextPoint,
}: {
  lastPoint: MermaidGfxPoint | null;
  minDelta?: number;
  nextPoint: MermaidGfxPoint | null;
}) {
  if (!lastPoint || !nextPoint) return null;
  const dx = nextPoint.x - lastPoint.x;
  const dy = nextPoint.y - lastPoint.y;
  return {
    dx,
    dy,
    nextPoint,
    shouldMove: Math.abs(dx) >= minDelta || Math.abs(dy) >= minDelta,
  };
}

export function resolveMermaidGfxNodeDragEndSubgraph({
  draggedNodeId,
  subgraphs,
}: {
  draggedNodeId: string;
  subgraphs?: ReadonlyArray<{ id: string; nodeIds: readonly string[] }>;
}) {
  if (!draggedNodeId) return "";
  return (
    subgraphs?.find((subgraph) => subgraph.nodeIds.includes(draggedNodeId))
      ?.id ?? ""
  );
}
