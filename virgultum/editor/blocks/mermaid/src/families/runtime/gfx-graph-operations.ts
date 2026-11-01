// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidProductDiagramType } from "../../engine/product-types.js";
import {
  getMermaidGfxFamilyHooks,
  getMermaidGfxFamilyHooksForDiagramType,
} from "./gfx-family-hooks-registry.js";
import type { MermaidGfxSelectionDescriptor } from "./gfx-family-hooks-contract.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSubgraph,
} from "./gfx-model.js";

export type MermaidGfxShapePalette = {
  all: readonly MermaidVisualNodeShape[];
  core: readonly MermaidVisualNodeShape[];
};

const EMPTY_SHAPE_PALETTE: MermaidGfxShapePalette = {
  all: [],
  core: [],
};

export function isMermaidGraphGfxDiagramType(diagramType: string) {
  return (
    getMermaidGfxFamilyHooksForDiagramType(diagramType)?.graphEditor === true
  );
}

export function getMermaidGfxShapePalette(
  diagramType: MermaidProductDiagramType,
): MermaidGfxShapePalette {
  const palette =
    getMermaidGfxFamilyHooksForDiagramType(diagramType)?.shapePalette;
  if (typeof palette === "function") return palette(diagramType);
  return palette ?? EMPTY_SHAPE_PALETTE;
}

export function createMermaidGfxVisualNode(
  model: MermaidVisualModel,
  requestedShape?: MermaidVisualNodeShape,
  placement?: { readonly centerX: number; readonly centerY: number },
): MermaidVisualNode | null {
  return (
    getMermaidGfxFamilyHooks(model)?.createNode?.(
      model,
      requestedShape,
      placement,
    ) ?? null
  );
}

export function createMermaidGfxVisualEdge(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
  ports?: Readonly<{
    sourcePortId?: string;
    sourcePosition?: MermaidVisualEdge["sourcePosition"];
    targetPortId?: string;
    targetPosition?: MermaidVisualEdge["targetPosition"];
  }>,
): MermaidVisualEdge | null {
  const hooks = getMermaidGfxFamilyHooks(model);
  const edge = hooks?.createEdge?.(model, sourceId, targetId) ?? null;
  if (!edge) return null;
  const created = { ...edge, ...ports };
  return hooks?.patchEdge?.(model, created, {}) ?? created;
}

export function canConnectMermaidGfxVisualNodes(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.canConnectNodes?.(
      model,
      sourceId,
      targetId,
    ) ?? false
  );
}

export function reconnectMermaidGfxVisualEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  endpoint: "source" | "target",
  nodeId: string,
  port?: Readonly<{
    portId?: string;
    position?: MermaidVisualEdge["sourcePosition"];
  }>,
) {
  const hooks = getMermaidGfxFamilyHooks(model);
  const reconnected =
    hooks?.reconnectEdge?.(model, edge, endpoint, nodeId) ?? null;
  if (!reconnected) return null;
  const projected =
    endpoint === "source"
      ? {
          ...reconnected,
          sourcePortId: port?.portId,
          sourcePosition: port?.position,
        }
      : {
          ...reconnected,
          targetPortId: port?.portId,
          targetPosition: port?.position,
        };
  return hooks?.patchEdge?.(model, projected, {}) ?? projected;
}

export function normalizeMermaidGfxVisualNodeDimensions(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.normalizeNodeDimensions?.(node, model) ?? {
      ...node,
      height: Math.max(56, Math.round(node.height)),
      width: Math.max(96, Math.round(node.width)),
    }
  );
}

export function createTypeOwnedMermaidGfxVisualSubgraph(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[],
): MermaidVisualSubgraph | null {
  return (
    getMermaidGfxFamilyHooks(model)?.createSubgraph?.(model, selectedNodeIds) ??
    null
  );
}

export function applyTypeOwnedMermaidCreatedSubgraphMembership(
  model: MermaidVisualModel,
  subgraphId: string,
  selectedNodeIds: readonly string[],
) {
  return (
    getMermaidGfxFamilyHooks(model)?.applyCreatedSubgraphMembership?.(
      model,
      subgraphId,
      selectedNodeIds,
    ) ?? model
  );
}

export function syncTypeOwnedMermaidSubgraphMembership(
  model: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.syncSubgraphMembership?.(model) ?? model
  );
}

export function reparentTypeOwnedMermaidGfxNodes(
  model: MermaidVisualModel,
  nodeIds: readonly string[],
  subgraphId: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.reparentNodes?.(
      model,
      nodeIds,
      subgraphId,
    ) ?? null
  );
}

export function reparentTypeOwnedMermaidGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  parentId: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.reparentSubgraph?.(
      model,
      subgraphId,
      parentId,
    ) ?? null
  );
}

export function deleteTypeOwnedMermaidGfxVisualSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.deleteSubgraph?.(model, subgraphId) ?? null
  );
}

export function resolveTypeOwnedMermaidGfxDeletionPlan(
  model: MermaidVisualModel,
  selection: MermaidGfxSelectionDescriptor,
) {
  const visualModel =
    getMermaidGfxFamilyHooks(model)?.deleteSelection?.(model, selection) ??
    null;
  if (!visualModel) return null;

  const remainingNodeIds = new Set(visualModel.nodes.map(({ id }) => id));
  const remainingEdgeIds = new Set(visualModel.edges.map(({ id }) => id));
  const remainingSubgraphIds = new Set(
    visualModel.subgraphs?.map(({ id }) => id) ?? [],
  );
  const impact = new Set<string>();
  for (const node of model.nodes) {
    if (!remainingNodeIds.has(node.id)) impact.add(node.id);
  }
  for (const edge of model.edges) {
    if (!remainingEdgeIds.has(edge.id)) impact.add(edge.id);
  }
  for (const subgraph of model.subgraphs ?? []) {
    if (!remainingSubgraphIds.has(subgraph.id)) impact.add(subgraph.id);
  }

  const explicitlySelected = new Set([
    ...(selection.edgeIds ?? []),
    ...(selection.edgeId ? [selection.edgeId] : []),
    ...(selection.nodeIds ?? []),
    ...(selection.nodeId ? [selection.nodeId] : []),
    ...(selection.subgraphIds ?? []),
    ...(selection.subgraphId ? [selection.subgraphId] : []),
  ]);
  const requiresConfirmation = [...impact].some(
    (id) => !explicitlySelected.has(id),
  );

  // Confirmation and mutation must describe the same operation. A family may
  // prioritize one selected kind or cascade to related objects; deriving the
  // impact from its actual result prevents a parallel heuristic from claiming
  // that objects will be removed when the command keeps them.
  return impact.size > 0 ? { impact, requiresConfirmation, visualModel } : null;
}

export function duplicateTypeOwnedMermaidGfxSelection(
  model: MermaidVisualModel,
  nodeIds: readonly string[],
  offset: Readonly<{ x: number; y: number }>,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.duplicateSelection?.(
      model,
      nodeIds,
      offset,
    ) ?? null
  );
}

export function allowsMermaidGfxSelfConnections(model: MermaidVisualModel) {
  const value = getMermaidGfxFamilyHooks(model)?.allowsSelfConnections;
  if (typeof value === "function") return value(model);
  return value ?? false;
}
