import { mermaidMessages } from "../../i18n.js";
import {
  canStartMermaidGfxEdgeReconnect,
  canStartMermaidGfxNodeConnection,
  type MermaidGfxConnectionPreview,
  type MermaidGfxConnectionPortPoint,
  type MermaidGfxConnectionPreviewPoint,
  type MermaidGfxEdgeReconnectEndpoint,
  type MermaidGfxReconnectableEdge,
  resolveMermaidGfxEdgeReconnect,
  resolveMermaidGfxEdgeReconnectNodes,
  resolveMermaidGfxNodeConnection,
  resolveMermaidGfxNodeConnectionPreview as resolveMermaidGfxConnectionPreview,
} from "../../mermaid-gfx-connection.js";
import { resolveMermaidGfxContextNodeLabels } from "../../mermaid-gfx-context-menu.js";
import {
  createMermaidGfxMoveStart,
  type MermaidGfxMoveStart,
  moveMermaidGfxBoundByDirection,
} from "../../mermaid-gfx-move.js";
import {
  type MermaidGfxArrowDirection,
  mermaidGfxDirectionFromArrowKey,
} from "../../mermaid-gfx-node-selection.js";
import {
  createMermaidGfxResizeStart,
  type MermaidGfxResizableModel,
  type MermaidGfxResizeStart,
  type MermaidGfxResizeTargetKind,
  resizeMermaidGfxBoundByDirection,
  resizeMermaidViewportHeightByDirection,
  resolveMermaidGfxResizeTarget,
} from "../../mermaid-gfx-resize.js";
import type { MermaidVisualModel } from "./gfx-model.js";

export type MermaidGfxKeyboardConnectionIntent = {
  direction: MermaidGfxArrowDirection;
  sourceNodeId: string;
};

export type MermaidGfxNodeConnectionPointerStart = {
  sourceNodeId: string;
};

export type MermaidGfxKeyboardEdgeReconnectIntent = {
  direction: MermaidGfxArrowDirection;
  edgeId: string;
  endpoint: MermaidGfxEdgeReconnectEndpoint;
  fixedNodeId: string;
  movingNodeId: string;
};

export type MermaidGfxResizePointerStart = {
  start: MermaidGfxResizeStart;
  target: {
    id: string;
    kind: MermaidGfxResizeTargetKind;
    xywh: string;
  };
};

export type MermaidGfxSubgraphMovePointerStart = {
  start: MermaidGfxMoveStart;
  target: {
    id: string;
    kind: "subgraph";
    xywh: string;
  };
};

export type MermaidVisualViewportResizeStart = {
  height: number;
  y: number;
};

const MERMAID_GFX_KEYBOARD_RESIZE_STEP = 16;
const MERMAID_GFX_KEYBOARD_RESIZE_LARGE_STEP = 48;

export function resolveMermaidGfxNodeConnectionPreview({
  allowSelf = false,
  pointer,
  sourceHandle,
  sourceNodeId,
  targetHandle,
  targetNodeId,
}: {
  allowSelf?: boolean;
  pointer: MermaidGfxConnectionPreviewPoint | null;
  sourceHandle: MermaidGfxConnectionPreviewPoint | null;
  sourceNodeId: string;
  targetHandle: MermaidGfxConnectionPortPoint | null;
  targetNodeId: string;
}) {
  if (!sourceNodeId) return null;
  const target =
    targetNodeId && (allowSelf || targetNodeId !== sourceNodeId)
      ? (targetHandle ?? pointer)
      : pointer;
  return resolveMermaidGfxConnectionPreview({
    allowSelf,
    source: sourceHandle,
    sourcePort:
      sourceHandle && "id" in sourceHandle
        ? (sourceHandle as MermaidGfxConnectionPortPoint)
        : null,
    sourceNodeId,
    target,
    targetPort: target === targetHandle ? targetHandle : null,
    targetNodeId,
  });
}

export function resolveMermaidGfxNodeConnectionPointerUp({
  allowSelf = false,
  hitTargetNodeId,
  isReadonly,
  preview,
  sourceNodeId,
}: {
  allowSelf?: boolean;
  hitTargetNodeId: string;
  isReadonly: boolean;
  preview: MermaidGfxConnectionPreview | null;
  sourceNodeId: string;
}) {
  const targetNodeId = preview?.validTarget
    ? preview.targetNodeId
    : hitTargetNodeId;
  const connection = resolveMermaidGfxNodeConnection({
    allowSelf,
    isReadonly,
    sourceNodeId,
    targetNodeId,
  });
  return connection
    ? {
        ...connection,
        ...(preview?.sourcePortId && preview.sourcePosition
          ? {
              sourcePortId: preview.sourcePortId,
              sourcePosition: preview.sourcePosition,
            }
          : {}),
        ...(preview?.targetPortId && preview.targetPosition
          ? {
              targetPortId: preview.targetPortId,
              targetPosition: preview.targetPosition,
            }
          : {}),
      }
    : null;
}

export function resolveMermaidGfxKeyboardConnectionIntent({
  isReadonly,
  key,
  selectedEdgeId,
  selectedNodeId,
  selectedSubgraphId,
}: {
  isReadonly: boolean;
  key: string;
  selectedEdgeId: string;
  selectedNodeId: string;
  selectedSubgraphId: string;
}): MermaidGfxKeyboardConnectionIntent | null {
  const direction = mermaidGfxDirectionFromArrowKey(key);
  if (
    !direction ||
    !canStartMermaidGfxNodeConnection({
      isReadonly,
      selectedEdgeId,
      selectedSubgraphId,
      sourceNodeId: selectedNodeId,
    })
  ) {
    return null;
  }

  return {
    direction,
    sourceNodeId: selectedNodeId,
  };
}

export function resolveMermaidGfxNodeConnectionPointerStart({
  isReadonly,
  selectedEdgeId,
  selectedNodeId,
  selectedSubgraphId,
}: {
  isReadonly: boolean;
  selectedEdgeId?: string;
  selectedNodeId: string;
  selectedSubgraphId?: string;
}): MermaidGfxNodeConnectionPointerStart | null {
  if (
    !canStartMermaidGfxNodeConnection({
      isReadonly,
      selectedEdgeId,
      selectedSubgraphId,
      sourceNodeId: selectedNodeId,
    })
  ) {
    return null;
  }

  return {
    sourceNodeId: selectedNodeId,
  };
}

export function resolveMermaidGfxKeyboardNodeConnection({
  isReadonly,
  sourceNodeId,
  targetNodeId,
}: {
  isReadonly: boolean;
  sourceNodeId: string;
  targetNodeId: string;
}) {
  return resolveMermaidGfxNodeConnection({
    isReadonly,
    sourceNodeId,
    targetNodeId,
  });
}

export function resolveMermaidGfxKeyboardEdgeReconnectIntent({
  edge,
  endpoint,
  isReadonly,
  key,
}: {
  edge: MermaidGfxReconnectableEdge | null | undefined;
  endpoint: MermaidGfxEdgeReconnectEndpoint;
  isReadonly: boolean;
  key: string;
}): MermaidGfxKeyboardEdgeReconnectIntent | null {
  const direction = mermaidGfxDirectionFromArrowKey(key);
  if (
    !direction ||
    !edge ||
    !canStartMermaidGfxEdgeReconnect({ edgeId: edge.id, isReadonly })
  ) {
    return null;
  }

  return {
    ...resolveMermaidGfxEdgeReconnectNodes({ edge, endpoint }),
    direction,
    edgeId: edge.id,
    endpoint,
  };
}

export function resolveMermaidGfxEdgeReconnectPointerStart({
  edgeId,
  endpoint,
  isReadonly,
}: {
  edgeId: string;
  endpoint: MermaidGfxEdgeReconnectEndpoint;
  isReadonly: boolean;
}) {
  if (!canStartMermaidGfxEdgeReconnect({ edgeId, isReadonly })) return null;
  return {
    edgeId,
    endpoint,
  };
}

export function resolveMermaidGfxEdgeReconnectToTarget({
  edgeId,
  endpoint,
  isReadonly,
  targetNodeId,
}: {
  edgeId: string;
  endpoint: MermaidGfxEdgeReconnectEndpoint | null;
  isReadonly: boolean;
  targetNodeId: string;
}) {
  return resolveMermaidGfxEdgeReconnect({
    edgeId,
    endpoint,
    isReadonly,
    targetNodeId,
  });
}

export function resolveMermaidGfxKeyboardResize({
  isReadonly,
  key,
  kind,
  nodeId,
  nodeModel,
  shiftKey,
  subgraphId,
  subgraphModel,
}: {
  isReadonly: boolean;
  key: string;
  kind: MermaidGfxResizeTargetKind;
  nodeId: string;
  nodeModel?: MermaidGfxResizableModel | null;
  shiftKey: boolean;
  subgraphId: string;
  subgraphModel?: MermaidGfxResizableModel | null;
}) {
  const direction = mermaidGfxDirectionFromArrowKey(key);
  if (!direction) return null;

  const target = resolveMermaidGfxResizeTarget({
    isReadonly,
    kind,
    nodeId,
    nodeModel,
    subgraphId,
    subgraphModel,
  });
  if (!target) return null;

  // Keyboard resizing is shared GFX interaction geometry, not product chrome.
  // Keep the increments here so the host does not branch on family sizing.
  const { height, width } = resizeMermaidGfxBoundByDirection({
    direction,
    step: shiftKey
      ? MERMAID_GFX_KEYBOARD_RESIZE_LARGE_STEP
      : MERMAID_GFX_KEYBOARD_RESIZE_STEP,
    xywh: target.xywh,
  });

  return {
    height,
    target,
    width,
  };
}

export function resolveMermaidGfxResizePointerStart({
  isReadonly,
  kind,
  nodeId,
  nodeModel,
  pointer,
  subgraphId,
  subgraphModel,
}: {
  isReadonly: boolean;
  kind: MermaidGfxResizeTargetKind;
  nodeId: string;
  nodeModel?: MermaidGfxResizableModel | null;
  pointer: { x: number; y: number } | null;
  subgraphId: string;
  subgraphModel?: MermaidGfxResizableModel | null;
}): MermaidGfxResizePointerStart | null {
  if (!pointer) return null;
  const target = resolveMermaidGfxResizeTarget({
    isReadonly,
    kind,
    nodeId,
    nodeModel,
    subgraphId,
    subgraphModel,
  });
  if (!target) return null;

  return {
    start: createMermaidGfxResizeStart({
      pointer,
      xywh: target.xywh,
    }),
    target,
  };
}

export function resolveMermaidGfxKeyboardSubgraphMove({
  isReadonly,
  key,
  shiftKey,
  subgraphId,
  subgraphModel,
}: {
  isReadonly: boolean;
  key: string;
  shiftKey: boolean;
  subgraphId: string;
  subgraphModel?: MermaidGfxResizableModel | null;
}) {
  const direction = mermaidGfxDirectionFromArrowKey(key);
  if (!direction) return null;
  const target = resolveMermaidGfxResizeTarget({
    isReadonly,
    kind: "subgraph",
    nodeId: "",
    nodeModel: null,
    subgraphId,
    subgraphModel,
  });
  if (!target) return null;
  const { x, y } = moveMermaidGfxBoundByDirection({
    direction,
    step: shiftKey
      ? MERMAID_GFX_KEYBOARD_RESIZE_LARGE_STEP
      : MERMAID_GFX_KEYBOARD_RESIZE_STEP,
    xywh: target.xywh,
  });
  return { target, x, y };
}

export function resolveMermaidGfxSubgraphMovePointerStart({
  isReadonly,
  pointer,
  subgraphId,
  subgraphModel,
}: {
  isReadonly: boolean;
  pointer: { x: number; y: number } | null;
  subgraphId: string;
  subgraphModel?: MermaidGfxResizableModel | null;
}): MermaidGfxSubgraphMovePointerStart | null {
  if (!pointer) return null;
  const target = resolveMermaidGfxResizeTarget({
    isReadonly,
    kind: "subgraph",
    nodeId: "",
    nodeModel: null,
    subgraphId,
    subgraphModel,
  });
  if (!target) return null;
  return {
    start: createMermaidGfxMoveStart({
      pointer,
      xywh: target.xywh,
    }),
    target: {
      id: target.id,
      kind: "subgraph",
      xywh: target.xywh,
    },
  };
}

export function resolveMermaidVisualViewportResizeKeydown({
  currentHeight,
  isReadonly,
  key,
  shiftKey,
  step,
}: {
  currentHeight: number;
  isReadonly: boolean;
  key: string;
  shiftKey: boolean;
  step: number;
}) {
  if (isReadonly) return null;
  const direction = mermaidGfxDirectionFromArrowKey(key);
  if (!direction) return null;
  return resizeMermaidViewportHeightByDirection({
    currentHeight,
    direction,
    step: shiftKey ? step * 2 : step,
  });
}

export function resolveMermaidVisualViewportResizePointerStart({
  currentHeight,
  isReadonly,
  pointerClientY,
}: {
  currentHeight: number;
  isReadonly: boolean;
  pointerClientY: number;
}): MermaidVisualViewportResizeStart | null {
  if (isReadonly) return null;
  return {
    height: currentHeight,
    y: pointerClientY,
  };
}

export function resolveMermaidVisualViewportResizePointerMove({
  pointerClientY,
  start,
}: {
  pointerClientY: number;
  start: MermaidVisualViewportResizeStart | null;
}) {
  if (!start) return null;
  return start.height + pointerClientY - start.y;
}

export function resolveMermaidGfxContextMenuLabel({
  nodeOrder,
  nodes,
}: {
  nodeOrder: ReadonlyArray<string>;
  nodes: MermaidVisualModel["nodes"];
}) {
  const labels = resolveMermaidGfxContextNodeLabels({
    nodeOrder,
    nodes,
  });
  if (!labels) return "";
  return mermaidMessages.visualConnectSelected(
    labels.sourceLabel,
    labels.targetLabel,
  );
}
