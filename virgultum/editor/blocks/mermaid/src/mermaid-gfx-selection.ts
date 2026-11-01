import { MERMAID_GFX_SUBGRAPH_ROLE } from "./families/runtime/gfx-element-roles.js";
import { MERMAID_GFX_DETAIL_ROLE } from "./families/runtime/gfx-element-roles.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxElementType,
  readMermaidGfxMeta,
  readMermaidGfxNodeId,
  readMermaidGfxRole,
  readMermaidGfxSubgraphId,
} from "./mermaid-gfx-metadata.js";

export type MermaidGfxSelectionIdentity = {
  edgeId: string;
  isEdgeConnector: boolean;
  isNodeShape: boolean;
  isSubgraphShape: boolean;
  nodeId: string;
  subgraphId: string;
  type: string;
};

export type MermaidGfxProjectionOwnerSelectionIntent<T = unknown> =
  | {
      kind: "edge";
      edgeId: string;
      model: T;
    }
  | {
      kind: "node";
      model: T;
      nodeId: string;
    }
  | {
      kind: "nodes";
      nodeIds: string[];
    }
  | {
      kind: "none";
    }
  | {
      kind: "subgraph";
      model: T;
      subgraphId: string;
    };

export function getMermaidGfxSelectionIdentity(
  model: unknown,
): MermaidGfxSelectionIdentity {
  const type = readMermaidGfxElementType(model);
  const nodeId = readMermaidGfxNodeId(model);
  const detailOwnerNodeId = readMermaidGfxMeta(
    model,
    "mermaidDetailOwnerNodeId",
  );
  const edgeId = readMermaidGfxEdgeId(model);
  const subgraphId = readMermaidGfxSubgraphId(model);
  const selectable =
    readMermaidGfxMeta(model, "mermaidNodeSelectable") !== "false";
  const subgraphSelectable =
    readMermaidGfxMeta(model, "mermaidSubgraphSelectable") !== "false";
  const isSubgraphShape =
    type === "shape" &&
    subgraphSelectable &&
    (readMermaidGfxRole(model) === MERMAID_GFX_SUBGRAPH_ROLE ||
      Boolean(subgraphId));
  const isRelationshipDetailShape =
    type === "shape" &&
    readMermaidGfxRole(model) === MERMAID_GFX_DETAIL_ROLE &&
    Boolean(detailOwnerNodeId);
  return {
    edgeId,
    isEdgeConnector:
      (type === "connector" ||
        readMermaidGfxRole(model) === MERMAID_GFX_DETAIL_ROLE) &&
      Boolean(edgeId),
    isNodeShape:
      type === "shape" &&
      !edgeId &&
      Boolean(nodeId || detailOwnerNodeId) &&
      !isSubgraphShape &&
      selectable,
    isSubgraphShape,
    nodeId: edgeId
      ? ""
      : isRelationshipDetailShape
        ? detailOwnerNodeId
        : nodeId,
    subgraphId,
    type,
  };
}

export function getMermaidGfxSelectedElementIds(
  selection:
    | {
        selectedElements?: ReadonlyArray<{ id?: string }>;
        selectedIds?: readonly string[];
      }
    | null
    | undefined,
) {
  return [
    ...(selection?.selectedIds ?? []),
    ...(selection?.selectedElements
      ?.map((element) => element.id)
      .filter((id): id is string => Boolean(id)) ?? []),
  ];
}

export function findMermaidGfxNodeModelByVisualId<T>({
  elementIds,
  getModel,
  includeHelperNodes = false,
  nodeId,
}: {
  elementIds: readonly string[];
  getModel: (id: string) => T | null | undefined;
  includeHelperNodes?: boolean;
  nodeId: string;
}) {
  for (const id of elementIds) {
    const model = getModel(id);
    const identity = getMermaidGfxSelectionIdentity(model);
    const isAddressableHelperNode =
      includeHelperNodes &&
      identity.type === "shape" &&
      Boolean(identity.nodeId) &&
      !identity.isSubgraphShape;
    if (
      (identity.isNodeShape || isAddressableHelperNode) &&
      identity.nodeId === nodeId
    ) {
      return model ?? null;
    }
  }

  return null;
}

export function findMermaidGfxEdgeModelByVisualId<T>({
  edgeId,
  elementIds,
  getModel,
}: {
  edgeId: string;
  elementIds: readonly string[];
  getModel: (id: string) => T | null | undefined;
}) {
  for (const id of elementIds) {
    const model = getModel(id);
    const identity = getMermaidGfxSelectionIdentity(model);
    // Endpoint-label shapes share edge identity for hits, but only the actual
    // connector owns the path, endpoint handles and reconnect geometry.
    if (
      identity.type === "connector" &&
      identity.isEdgeConnector &&
      identity.edgeId === edgeId
    ) {
      return model ?? null;
    }
  }

  return null;
}

export function findMermaidGfxSubgraphModelByVisualId<T>({
  elementIds,
  getModel,
  subgraphId,
}: {
  elementIds: readonly string[];
  getModel: (id: string) => T | null | undefined;
  subgraphId: string;
}) {
  for (const id of elementIds) {
    const model = getModel(id);
    const identity = getMermaidGfxSelectionIdentity(model);
    if (identity.isSubgraphShape && identity.subgraphId === subgraphId) {
      return model ?? null;
    }
  }

  return null;
}

export function resolveMermaidGfxProjectionOwnerSelectionIntent<T>(
  selectedModels: readonly T[],
): MermaidGfxProjectionOwnerSelectionIntent<T> {
  const selectedNodeIds = selectedModels
    .map((model) => getMermaidGfxSelectionIdentity(model).nodeId)
    .filter((nodeId) => Boolean(nodeId));
  if (selectedNodeIds.length >= 2) {
    return {
      kind: "nodes",
      nodeIds: selectedNodeIds,
    };
  }

  const model = selectedModels[0];
  if (!model) return { kind: "none" };

  const identity = getMermaidGfxSelectionIdentity(model);
  if (identity.type === "shape") {
    if (identity.isSubgraphShape) {
      return {
        kind: "subgraph",
        model,
        subgraphId: identity.subgraphId,
      };
    }

    if (!identity.isNodeShape || !identity.nodeId) {
      return { kind: "none" };
    }

    return {
      kind: "node",
      model,
      nodeId: identity.nodeId,
    };
  }

  if (identity.type === "connector") {
    return {
      edgeId: identity.edgeId,
      kind: "edge",
      model,
    };
  }

  return { kind: "none" };
}

export function shouldPreserveMermaidGfxNodeSelectionForManagedSubgraph({
  selectedNodeId,
  subgraphId,
  subgraphs,
}: {
  selectedNodeId: string;
  subgraphId: string;
  subgraphs?: ReadonlyArray<{
    id: string;
    nodeIds: readonly string[];
  }> | null;
}) {
  if (!selectedNodeId || !subgraphId) return false;
  return Boolean(
    subgraphs?.some(
      (subgraph) =>
        subgraph.id === subgraphId && subgraph.nodeIds.includes(selectedNodeId),
    ),
  );
}
