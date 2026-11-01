import { Bound } from "@virgultum/global/gfx";

import type { MermaidVisualEndpointPosition } from "./families/runtime/gfx-model.js";
import type { MermaidGfxNodeConnectionPort } from "./families/runtime/gfx-family-hooks-contract.js";

export type MermaidGfxModelPoint = {
  x: number;
  y: number;
};

export type MermaidGfxViewPoint = {
  left: number;
  top: number;
};

export type MermaidGfxViewRect = MermaidGfxViewPoint & {
  height: number;
  width: number;
};

// GFX handles are canvas interaction geometry, not product chrome. Diagrams
// with dense label/property boxes use their visual center for meaningful text,
// so reconnect handles need to sit outside that box while graph-like diagrams
// keep center handles for predictable endpoint targeting.
const MERMAID_DENSE_LABEL_NODE_HANDLE_OUTSET = 18;
const MERMAID_DENSE_LABEL_EDGE_HANDLE_OUTSET = 18;
const MERMAID_SUBGRAPH_MOVE_HANDLE_INSET = 8;
const MERMAID_SUBGRAPH_MOVE_HANDLE_MIN_HEIGHT = 28;
const MERMAID_SUBGRAPH_MOVE_HANDLE_MAX_HEIGHT = 56;
const MERMAID_DENSE_LABEL_NODE_HANDLE_TYPES = new Set([
  "sequenceDiagram",
  "stateDiagram",
  "stateDiagram-v2",
]);
const MERMAID_DENSE_LABEL_EDGE_HANDLE_TYPES = new Set([
  "classDiagram",
  "classDiagram-v2",
  "erDiagram",
  "requirementDiagram",
  "sequenceDiagram",
]);

export function mermaidGfxNodeHandlePoints({
  connectionPorts,
  denseLabelNode = false,
  diagramType,
  xywh,
}: {
  connectionPorts?: readonly MermaidGfxNodeConnectionPort[];
  denseLabelNode?: boolean;
  diagramType?: string;
  xywh: string;
}) {
  const bound = Bound.deserialize(xywh);
  const denseLabelHandles =
    denseLabelNode ||
    MERMAID_DENSE_LABEL_NODE_HANDLE_TYPES.has(diagramType ?? "");
  // An empty policy disables connections; only an absent policy gets the default port.
  const ports =
    connectionPorts ?? ([{ id: "connect", position: [1, 0.5] }] as const);
  return {
    connectPorts: ports.map((port) => ({
      id: port.id,
      position: port.position,
      x:
        bound.x +
        bound.w * port.position[0] +
        (denseLabelHandles && port.position[0] === 1
          ? MERMAID_DENSE_LABEL_NODE_HANDLE_OUTSET
          : 0),
      y: bound.y + bound.h * port.position[1],
    })),
    resize: {
      x: bound.x + bound.w,
      y: bound.y + bound.h,
    },
  };
}

export function mermaidGfxSubgraphResizeHandlePoint(xywh: string) {
  const bound = Bound.deserialize(xywh);
  return {
    x: bound.x + bound.w,
    y: bound.y + bound.h,
  };
}

export function mermaidGfxSubgraphMoveHandleRect(xywh: string) {
  const bound = Bound.deserialize(xywh);
  const inset = Math.min(MERMAID_SUBGRAPH_MOVE_HANDLE_INSET, bound.w / 4);
  const height = Math.min(
    bound.h,
    Math.max(
      MERMAID_SUBGRAPH_MOVE_HANDLE_MIN_HEIGHT,
      Math.min(MERMAID_SUBGRAPH_MOVE_HANDLE_MAX_HEIGHT, bound.h * 0.22),
    ),
  );
  return {
    height,
    width: Math.max(1, bound.w - inset * 2),
    x: bound.x + inset,
    y: bound.y,
  };
}

export function mermaidGfxEdgeHandlePoints({
  diagramType,
  sourcePosition,
  sourceXywh,
  targetPosition,
  targetXywh,
}: {
  diagramType?: string;
  sourcePosition?: MermaidVisualEndpointPosition;
  sourceXywh: string;
  targetPosition?: MermaidVisualEndpointPosition;
  targetXywh: string;
}) {
  const sourceBound = Bound.deserialize(sourceXywh);
  const targetBound = Bound.deserialize(targetXywh);
  const denseLabelHandles = MERMAID_DENSE_LABEL_EDGE_HANDLE_TYPES.has(
    diagramType ?? "",
  );
  const positionPoint = (
    bound: Bound,
    position: MermaidVisualEndpointPosition | undefined,
  ) =>
    position
      ? {
          x: bound.x + bound.w * position[0],
          y: bound.y + bound.h * position[1],
        }
      : null;
  const edgeHandleY = (bound: Bound) =>
    denseLabelHandles
      ? bound.y - MERMAID_DENSE_LABEL_EDGE_HANDLE_OUTSET
      : bound.y + bound.h / 2;
  return {
    source: positionPoint(sourceBound, sourcePosition) ?? {
      x: sourceBound.x + sourceBound.w / 2,
      y: edgeHandleY(sourceBound),
    },
    target: positionPoint(targetBound, targetPosition) ?? {
      x: targetBound.x + targetBound.w / 2,
      y: edgeHandleY(targetBound),
    },
  };
}

export function mermaidGfxNodeHandleViewPoints({
  connectionPorts,
  denseLabelNode,
  diagramType,
  toViewPoint,
  xywh,
}: {
  connectionPorts?: readonly MermaidGfxNodeConnectionPort[];
  denseLabelNode?: boolean;
  diagramType?: string;
  toViewPoint: (x: number, y: number) => MermaidGfxViewPoint | null;
  xywh: string;
}) {
  const points = mermaidGfxNodeHandlePoints({
    connectionPorts,
    denseLabelNode,
    diagramType,
    xywh,
  });
  const connectPorts = points.connectPorts.map((port) => {
    const point = toViewPoint(port.x, port.y);
    return point ? { ...point, id: port.id, position: port.position } : null;
  });
  const resize = toViewPoint(points.resize.x, points.resize.y);
  return connectPorts.every((port) => port !== null) && resize
    ? { connectPorts, resize }
    : null;
}

export function mermaidGfxSubgraphResizeHandleViewPoint({
  toViewPoint,
  xywh,
}: {
  toViewPoint: (x: number, y: number) => MermaidGfxViewPoint | null;
  xywh: string;
}) {
  const point = mermaidGfxSubgraphResizeHandlePoint(xywh);
  return toViewPoint(point.x, point.y);
}

export function mermaidGfxSubgraphMoveHandleViewRect({
  toViewPoint,
  xywh,
}: {
  toViewPoint: (x: number, y: number) => MermaidGfxViewPoint | null;
  xywh: string;
}): MermaidGfxViewRect | null {
  const rect = mermaidGfxSubgraphMoveHandleRect(xywh);
  const topLeft = toViewPoint(rect.x, rect.y);
  const bottomRight = toViewPoint(rect.x + rect.width, rect.y + rect.height);
  if (!topLeft || !bottomRight) return null;
  return {
    height: Math.abs(bottomRight.top - topLeft.top),
    left: Math.min(topLeft.left, bottomRight.left),
    top: Math.min(topLeft.top, bottomRight.top),
    width: Math.abs(bottomRight.left - topLeft.left),
  };
}

export function mermaidGfxEdgeHandleViewPoints({
  diagramType,
  sourcePosition,
  sourceXywh,
  targetPosition,
  targetXywh,
  toViewPoint,
}: {
  diagramType?: string;
  sourcePosition?: MermaidVisualEndpointPosition;
  sourceXywh: string;
  targetPosition?: MermaidVisualEndpointPosition;
  targetXywh: string;
  toViewPoint: (x: number, y: number) => MermaidGfxViewPoint | null;
}) {
  const points = mermaidGfxEdgeHandlePoints({
    diagramType,
    sourcePosition,
    sourceXywh,
    targetPosition,
    targetXywh,
  });
  const source = toViewPoint(points.source.x, points.source.y);
  const target = toViewPoint(points.target.x, points.target.y);
  return source && target ? { source, target } : null;
}
