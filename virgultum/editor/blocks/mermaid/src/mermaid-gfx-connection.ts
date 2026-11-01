export function canStartMermaidGfxNodeConnection({
  isReadonly,
  selectedEdgeId = "",
  selectedSubgraphId = "",
  sourceNodeId,
}: {
  isReadonly: boolean;
  selectedEdgeId?: string;
  selectedSubgraphId?: string;
  sourceNodeId: string;
}) {
  return (
    !isReadonly &&
    Boolean(sourceNodeId) &&
    !selectedEdgeId &&
    !selectedSubgraphId
  );
}

export function resolveMermaidGfxNodeConnection({
  allowSelf = false,
  isReadonly,
  sourceNodeId,
  targetNodeId,
}: {
  allowSelf?: boolean;
  isReadonly: boolean;
  sourceNodeId: string;
  targetNodeId: string;
}) {
  if (
    isReadonly ||
    !sourceNodeId ||
    !targetNodeId ||
    (!allowSelf && sourceNodeId === targetNodeId)
  ) {
    return null;
  }

  return {
    sourceNodeId,
    targetNodeId,
  };
}

export type MermaidGfxConnectionPreviewPoint = {
  left: number;
  top: number;
};

export type MermaidGfxConnectionPortPoint = MermaidGfxConnectionPreviewPoint & {
  id: string;
  position: readonly [number, number];
};

export type MermaidGfxConnectionPreview = {
  source: MermaidGfxConnectionPreviewPoint;
  sourcePortId?: string;
  sourcePosition?: readonly [number, number];
  target: MermaidGfxConnectionPreviewPoint;
  targetNodeId: string;
  targetPortId?: string;
  targetPosition?: readonly [number, number];
  validTarget: boolean;
};

export function resolveMermaidGfxNodeConnectionPreview({
  allowSelf = false,
  source,
  sourcePort,
  sourceNodeId,
  target,
  targetPort,
  targetNodeId,
}: {
  allowSelf?: boolean;
  source: MermaidGfxConnectionPreviewPoint | null;
  sourcePort?: MermaidGfxConnectionPortPoint | null;
  sourceNodeId: string;
  target: MermaidGfxConnectionPreviewPoint | null;
  targetPort?: MermaidGfxConnectionPortPoint | null;
  targetNodeId: string;
}): MermaidGfxConnectionPreview | null {
  if (!source || !target || !sourceNodeId) return null;

  return {
    source,
    ...(sourcePort
      ? { sourcePortId: sourcePort.id, sourcePosition: sourcePort.position }
      : {}),
    target,
    targetNodeId,
    ...(targetPort
      ? { targetPortId: targetPort.id, targetPosition: targetPort.position }
      : {}),
    validTarget: Boolean(
      targetNodeId && (allowSelf || targetNodeId !== sourceNodeId),
    ),
  };
}

export type MermaidGfxConnectionResultSelection =
  | {
      edgeId: string;
      kind: "edge";
    }
  | {
      kind: "clear-node";
    };

export function resolveMermaidGfxConnectionResultSelection({
  edgeId,
}: {
  edgeId: string;
}): MermaidGfxConnectionResultSelection {
  if (edgeId) {
    return {
      edgeId,
      kind: "edge",
    };
  }

  return {
    kind: "clear-node",
  };
}

export type MermaidGfxEdgeReconnectEndpoint = "source" | "target";

export type MermaidGfxReconnectableEdge = {
  id: string;
  source: string;
  target: string;
};

export function canStartMermaidGfxEdgeReconnect({
  edgeId,
  isReadonly,
}: {
  edgeId: string;
  isReadonly: boolean;
}) {
  return !isReadonly && Boolean(edgeId);
}

export function resolveMermaidGfxEdgeReconnectNodes({
  edge,
  endpoint,
}: {
  edge: MermaidGfxReconnectableEdge;
  endpoint: MermaidGfxEdgeReconnectEndpoint;
}) {
  return {
    fixedNodeId: endpoint === "source" ? edge.target : edge.source,
    movingNodeId: endpoint === "source" ? edge.source : edge.target,
  };
}

export function resolveMermaidGfxEdgeReconnect({
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
  if (isReadonly || !edgeId || !endpoint || !targetNodeId) return null;
  return {
    edgeId,
    endpoint,
    targetNodeId,
  };
}
