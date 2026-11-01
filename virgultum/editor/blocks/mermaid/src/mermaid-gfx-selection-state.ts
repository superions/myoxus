import type { MermaidVisualNodeShape } from "./families/runtime/gfx-model.js";

export type MermaidGfxVisualPoint = { left: number; top: number };

export type MermaidGfxSelectionPatch = {
  isConnectingVisualNodes?: boolean;
  pendingVisualInsertShape?: MermaidVisualNodeShape | null;
  visualSelection?: {
    readonly editKeys: readonly string[];
    readonly kind: "edge" | "node" | "subgraph";
  };
  visualContextMenu?: MermaidGfxVisualPoint | null;
};

export function clearMermaidGfxSelectionPatch(): MermaidGfxSelectionPatch {
  return {
    isConnectingVisualNodes: false,
    pendingVisualInsertShape: null,
    visualSelection: { editKeys: [], kind: "node" },
    visualContextMenu: null,
  };
}

export function selectMermaidGfxSubgraphPatch(
  subgraphId: string,
): MermaidGfxSelectionPatch {
  return {
    isConnectingVisualNodes: false,
    pendingVisualInsertShape: null,
    visualSelection: { editKeys: [subgraphId], kind: "subgraph" },
    visualContextMenu: null,
  };
}

export function selectMermaidGfxEdgePatch(
  edgeId: string,
): MermaidGfxSelectionPatch {
  return {
    pendingVisualInsertShape: null,
    visualSelection: { editKeys: [edgeId], kind: "edge" },
    visualContextMenu: null,
  };
}

export function selectMermaidGfxNodePairPatch(
  nodeIds: readonly [string, string],
): MermaidGfxSelectionPatch {
  return selectMermaidGfxNodesPatch(nodeIds);
}

export function selectMermaidGfxNodesPatch(
  nodeIds: readonly string[],
): MermaidGfxSelectionPatch {
  return {
    visualSelection: { editKeys: [...nodeIds], kind: "node" },
  };
}

export function selectMermaidGfxNodePatch({
  nodeId,
  nodeOrder,
}: {
  nodeId: string;
  nodeOrder: readonly string[];
}): MermaidGfxSelectionPatch {
  return {
    visualSelection: {
      editKeys: nodeId ? [...nodeOrder] : [],
      kind: "node",
    },
    visualContextMenu: null,
  };
}

export function connectMermaidGfxSelectionPatch(
  targetNodeId: string,
): MermaidGfxSelectionPatch {
  return {
    visualSelection: { editKeys: [targetNodeId], kind: "node" },
    visualContextMenu: null,
  };
}

export function insertMermaidGfxNodeSelectionPatch(
  nodeId: string,
): MermaidGfxSelectionPatch {
  return {
    pendingVisualInsertShape: null,
    visualSelection: { editKeys: [nodeId], kind: "node" },
  };
}

export function toggleMermaidGfxPendingNodeInsertPatch({
  currentShape,
  shape,
}: {
  currentShape: MermaidVisualNodeShape | null;
  shape: MermaidVisualNodeShape;
}): MermaidGfxSelectionPatch {
  return {
    pendingVisualInsertShape: currentShape === shape ? null : shape,
    visualSelection: { editKeys: [], kind: "node" },
    visualContextMenu: null,
  };
}
