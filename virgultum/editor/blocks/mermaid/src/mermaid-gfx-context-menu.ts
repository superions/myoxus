export type MermaidGfxContextMenuSelectionAction = {
  additive: boolean;
  nodeId: string;
};

export type MermaidGfxContextMenuSelectionIntent = {
  canOpenMenu: boolean;
  menuNodeOrder: [string, string] | [];
  selectionAction: MermaidGfxContextMenuSelectionAction | null;
};

export function resolveMermaidGfxContextMenuSelection({
  explicitNodeOrder,
  nodeId,
  selectedNodeId,
  selectedNodeOrder,
}: {
  explicitNodeOrder: readonly string[];
  nodeId: string;
  selectedNodeId: string;
  selectedNodeOrder: readonly string[];
}): MermaidGfxContextMenuSelectionIntent {
  let selectionAction: MermaidGfxContextMenuSelectionAction | null = null;
  if (
    nodeId &&
    selectedNodeId &&
    selectedNodeId !== nodeId &&
    !selectedNodeOrder.includes(nodeId)
  ) {
    selectionAction = {
      additive: true,
      nodeId,
    };
  } else if (nodeId && selectedNodeOrder.length === 0) {
    selectionAction = {
      additive: false,
      nodeId,
    };
  }

  if (explicitNodeOrder.length !== 2) {
    return {
      canOpenMenu: false,
      menuNodeOrder: [],
      selectionAction,
    };
  }

  return {
    canOpenMenu: true,
    menuNodeOrder: [explicitNodeOrder[0], explicitNodeOrder[1]],
    selectionAction,
  };
}

export function resolveMermaidGfxContextMenuPosition({
  clientX,
  clientY,
  inset = 8,
  menuHeight = 48,
  menuWidth = 220,
  viewportRect,
}: {
  clientX: number;
  clientY: number;
  inset?: number;
  menuHeight?: number;
  menuWidth?: number;
  viewportRect: Pick<DOMRect, "height" | "left" | "top" | "width">;
}) {
  return {
    left: Math.max(
      inset,
      Math.min(clientX - viewportRect.left, viewportRect.width - menuWidth),
    ),
    top: Math.max(
      inset,
      Math.min(clientY - viewportRect.top, viewportRect.height - menuHeight),
    ),
  };
}

export function resolveMermaidGfxContextNodeLabels({
  nodeOrder,
  nodes,
}: {
  nodeOrder: readonly string[];
  nodes: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [sourceNodeId, targetNodeId] = nodeOrder;
  const source = nodes.find((node) => node.id === sourceNodeId);
  const target = nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) return null;

  return {
    sourceLabel: source.label || source.id,
    targetLabel: target.label || target.id,
  };
}

export function resolveMermaidGfxContextConnection({
  isReadonly,
  nodeOrder,
}: {
  isReadonly: boolean;
  nodeOrder: readonly string[];
}) {
  const [sourceNodeId, targetNodeId] = nodeOrder;
  if (
    isReadonly ||
    !sourceNodeId ||
    !targetNodeId ||
    sourceNodeId === targetNodeId
  ) {
    return null;
  }

  return {
    sourceNodeId,
    targetNodeId,
  };
}

export type MermaidGfxContextConnectionResult =
  | {
      edgeId: string;
      kind: "select-edge";
    }
  | {
      kind: "sync-target-node";
      targetNodeId: string;
    }
  | {
      kind: "none";
    };

export function resolveMermaidGfxContextConnectionResult({
  applied,
  edgeId,
  targetNodeId,
}: {
  applied: boolean;
  edgeId: string;
  targetNodeId: string;
}): MermaidGfxContextConnectionResult {
  if (!applied) return { kind: "none" };
  if (edgeId) {
    return {
      edgeId,
      kind: "select-edge",
    };
  }
  return {
    kind: "sync-target-node",
    targetNodeId,
  };
}
