import { Bound } from "@virgultum/global/gfx";

export type MermaidGfxArrowDirection = "down" | "left" | "right" | "up";

export type MermaidGfxNodeSelectionState = {
  explicitOrder: readonly string[];
  lastExplicitNodeId: string;
  selectedNodeId: string;
  selectedOrder: readonly string[];
};

export type MermaidGfxNodeSelectionResult = {
  explicitOrder: string[];
  lastExplicitNodeId: string;
  selectedOrder: string[];
  unchanged?: boolean;
};

function toggleOrderedSelection(order: readonly string[], nodeId: string) {
  return order.includes(nodeId)
    ? order.filter((candidate) => candidate !== nodeId)
    : [...order, nodeId];
}

export function mermaidGfxDirectionFromArrowKey(
  key: string,
): MermaidGfxArrowDirection | "" {
  if (key === "ArrowRight") return "right";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowUp") return "up";
  return "";
}

export function mermaidGfxNodeCenter(xywh: string) {
  const bound = Bound.deserialize(xywh);
  return {
    x: bound.x + bound.w / 2,
    y: bound.y + bound.h / 2,
  };
}

export function findNearestMermaidGfxNodeInDirection({
  direction,
  excludedNodeIds = new Set(),
  fromNodeId,
  getNodeXywh,
  nodes,
}: {
  direction: MermaidGfxArrowDirection;
  excludedNodeIds?: ReadonlySet<string>;
  fromNodeId: string;
  getNodeXywh: (nodeId: string) => string | null | undefined;
  nodes: readonly { id: string }[];
}) {
  const originXywh = getNodeXywh(fromNodeId);
  if (!originXywh) return "";
  const origin = mermaidGfxNodeCenter(originXywh);

  let nearestNodeId = "";
  let nearestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.id === fromNodeId || excludedNodeIds.has(node.id)) continue;
    const xywh = getNodeXywh(node.id);
    if (!xywh) continue;
    const center = mermaidGfxNodeCenter(xywh);
    const dx = center.x - origin.x;
    const dy = center.y - origin.y;
    const axisDistance =
      direction === "right"
        ? dx
        : direction === "left"
          ? -dx
          : direction === "down"
            ? dy
            : -dy;
    if (axisDistance <= 8) continue;
    const crossDistance =
      direction === "right" || direction === "left"
        ? Math.abs(dy)
        : Math.abs(dx);
    const score = axisDistance + crossDistance * 1.8;
    if (score < nearestScore) {
      nearestScore = score;
      nearestNodeId = node.id;
    }
  }

  return nearestNodeId;
}

export function nextMermaidGfxSelectedNodeOrder(
  state: MermaidGfxNodeSelectionState,
  nodeId: string,
  additive = false,
) {
  if (!nodeId) return [...state.selectedOrder];
  if (additive) return toggleOrderedSelection(state.selectedOrder, nodeId);
  return [nodeId];
}

export function rememberMermaidGfxExplicitNodeSelection(
  state: MermaidGfxNodeSelectionState,
  nodeId: string,
  additive = false,
): MermaidGfxNodeSelectionResult {
  if (!nodeId) {
    return {
      explicitOrder: [...state.explicitOrder],
      lastExplicitNodeId: state.lastExplicitNodeId,
      selectedOrder: [...state.selectedOrder],
      unchanged: true,
    };
  }
  if (
    !additive &&
    state.lastExplicitNodeId === nodeId &&
    state.explicitOrder.at(-1) === nodeId
  ) {
    return {
      explicitOrder: [...state.explicitOrder],
      lastExplicitNodeId: state.lastExplicitNodeId,
      selectedOrder: [...state.explicitOrder],
      unchanged: true,
    };
  }

  const explicitOrder = additive
    ? toggleOrderedSelection(state.explicitOrder, nodeId)
    : [nodeId];
  const lastExplicitNodeId = explicitOrder.includes(nodeId)
    ? nodeId
    : (explicitOrder.at(-1) ?? "");

  return {
    explicitOrder,
    lastExplicitNodeId,
    selectedOrder: [...explicitOrder],
  };
}
