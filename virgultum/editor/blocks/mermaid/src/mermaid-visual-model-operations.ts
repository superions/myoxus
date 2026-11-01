// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
} from "./families/runtime/gfx-model.js";
import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import {
  applyTypeOwnedMermaidCreatedSubgraphMembership,
  createMermaidGfxVisualEdge,
  createMermaidGfxVisualNode,
  createTypeOwnedMermaidGfxVisualSubgraph,
  reconnectMermaidGfxVisualEdge,
  resolveTypeOwnedMermaidGfxDeletionPlan,
  syncTypeOwnedMermaidSubgraphMembership,
} from "./families/runtime/gfx-graph-operations.js";

// Keep pure VisualModel mutations separate from editor Store/GFX commands so
// command orchestration cannot become the only testable source of model logic.
export function cloneMermaidVisualModel(model: MermaidVisualModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidVisualModel;
}

export function visualNodeWithLabel(
  node: MermaidVisualNode,
  label: string,
  preserveWhitespace = false,
): MermaidVisualNode {
  const nextLabel = preserveWhitespace ? label : label.trim() || node.id;
  if (!node.displayLabel) {
    return {
      ...node,
      label: nextLabel,
    };
  }
  const [, ...details] = node.displayLabel.split("\n");
  return {
    ...node,
    displayLabel: [nextLabel, ...details].join("\n"),
    label: nextLabel,
  };
}

export function syncMermaidVisualSubgraphMembership(model: MermaidVisualModel) {
  return syncTypeOwnedMermaidSubgraphMembership(model);
}

export function addMermaidVisualNode(
  model: MermaidVisualModel,
  shape?: MermaidVisualNodeShape,
  placement?: { centerX: number; centerY: number },
) {
  const next = cloneMermaidVisualModel(model);
  const node = createMermaidGfxVisualNode(next, shape, placement);
  if (!node) return next;
  next.nodes.push(node);
  return next;
}

export function getMermaidVisualSelectionDeletedNodeIds(
  model: MermaidVisualModel,
  selection: {
    edgeId?: string;
    nodeId?: string;
    nodeIds?: readonly string[];
    subgraphId?: string;
  },
) {
  const selectedNodeIds = new Set([
    ...(selection.nodeIds ?? []),
    ...(selection.nodeId ? [selection.nodeId] : []),
  ]);
  const familyPlan = resolveTypeOwnedMermaidGfxDeletionPlan(model, selection);
  if (!familyPlan) return selectedNodeIds;
  const remainingNodeIds = new Set(
    familyPlan.visualModel.nodes.map((node) => node.id),
  );
  for (const node of model.nodes) {
    if (!remainingNodeIds.has(node.id)) selectedNodeIds.add(node.id);
  }
  return selectedNodeIds;
}

function removeVisualNodes(model: MermaidVisualModel, nodeIds: Set<string>) {
  if (nodeIds.size === 0) return model;
  model.nodes = model.nodes.filter((node) => !nodeIds.has(node.id));
  model.edges = model.edges.filter(
    (edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target),
  );
  if (model.subgraphs) {
    for (const subgraph of model.subgraphs) {
      subgraph.nodeIds = subgraph.nodeIds.filter((id) => !nodeIds.has(id));
    }
  }
  return model;
}

export function addMermaidVisualSubgraph(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[] = [],
) {
  const next = cloneMermaidVisualModel(model);
  const typeOwnedSubgraph = createTypeOwnedMermaidGfxVisualSubgraph(
    next,
    selectedNodeIds,
  );
  if (!typeOwnedSubgraph) return next;
  next.subgraphs = [...(next.subgraphs ?? []), typeOwnedSubgraph];
  return syncMermaidVisualSubgraphMembership(
    applyTypeOwnedMermaidCreatedSubgraphMembership(
      next,
      typeOwnedSubgraph.id,
      selectedNodeIds,
    ),
  );
}

export function connectMermaidVisualNodes(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
) {
  const next = cloneMermaidVisualModel(model);
  const edge = createMermaidGfxVisualEdge(next, sourceId, targetId);
  if (edge) next.edges.push(edge);
  return next;
}

export function deleteMermaidVisualSelection(
  model: MermaidVisualModel,
  selection: {
    edgeId?: string;
    nodeId?: string;
    nodeIds?: readonly string[];
    subgraphId?: string;
  },
) {
  const next = cloneMermaidVisualModel(model);
  const typeOwned = resolveTypeOwnedMermaidGfxDeletionPlan(next, selection);
  if (typeOwned) return typeOwned.visualModel;
  const deletedNodeIds = getMermaidVisualSelectionDeletedNodeIds(
    next,
    selection,
  );
  if (selection.subgraphId) {
    next.subgraphs = (next.subgraphs ?? []).filter(
      (subgraph) => subgraph.id !== selection.subgraphId,
    );
    next.edges = next.edges.filter(
      (edge) =>
        edge.source !== selection.subgraphId &&
        edge.target !== selection.subgraphId,
    );
    return removeVisualNodes(next, deletedNodeIds);
  }
  if (selection.edgeId) {
    next.edges = next.edges.filter((edge) => edge.id !== selection.edgeId);
    return removeVisualNodes(next, deletedNodeIds);
  }
  if (deletedNodeIds.size > 0) {
    return removeVisualNodes(next, deletedNodeIds);
  }
  return next;
}

export function renameMermaidVisualSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  title: string,
) {
  const typeOwned =
    getMermaidGfxFamilyHooks(model)?.subgraphInlineRename?.(
      model,
      subgraphId,
      title,
    ) ?? null;
  if (typeOwned) return typeOwned;
  const next = cloneMermaidVisualModel(model);
  const subgraph = next.subgraphs?.find(
    (candidate) => candidate.id === subgraphId,
  );
  if (subgraph) {
    subgraph.title = title.trim() || subgraph.id;
  }
  return next;
}

export function setMermaidVisualSubgraphDirection(
  model: MermaidVisualModel,
  subgraphId: string,
  direction: MermaidVisualModel["direction"] | "",
) {
  const next = cloneMermaidVisualModel(model);
  const subgraph = next.subgraphs?.find(
    (candidate) => candidate.id === subgraphId,
  );
  if (subgraph) subgraph.direction = direction || undefined;
  return next;
}

export function resizeMermaidVisualSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  width: number,
  height: number,
) {
  const next = cloneMermaidVisualModel(model);
  const subgraph = next.subgraphs?.find(
    (candidate) => candidate.id === subgraphId,
  );
  if (subgraph && Number.isFinite(width) && Number.isFinite(height)) {
    subgraph.width = Math.max(180, Math.round(width));
    subgraph.height = Math.max(120, Math.round(height));
  }
  return syncMermaidVisualSubgraphMembership(next);
}

export function renameMermaidVisualNode(
  model: MermaidVisualModel,
  nodeId: string,
  label: string,
) {
  const typeOwned =
    getMermaidGfxFamilyHooks(model)?.nodeInlineRename?.(model, nodeId, label) ??
    null;
  if (typeOwned) return typeOwned;
  const next = cloneMermaidVisualModel(model);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (node) {
    Object.assign(node, visualNodeWithLabel(node, label));
  }
  return next;
}

export function setMermaidVisualNodeShape(
  model: MermaidVisualModel,
  nodeId: string,
  shape: MermaidVisualNodeShape,
) {
  const next = cloneMermaidVisualModel(model);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (node) {
    node.shape = shape;
    node.height = Math.max(shape === "diamond" ? 104 : 64, node.height);
    node.width = Math.max(shape === "diamond" ? 140 : 120, node.width);
  }
  return next;
}

export function renameMermaidVisualEdge(
  model: MermaidVisualModel,
  edgeId: string,
  label: string,
) {
  const typeOwned =
    getMermaidGfxFamilyHooks(model)?.edgeInlineRename?.(model, edgeId, label) ??
    null;
  if (typeOwned) return typeOwned;
  const next = cloneMermaidVisualModel(model);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  if (edge) {
    edge.label = label.trim();
  }
  return next;
}

export function reconnectMermaidVisualEdge(
  model: MermaidVisualModel,
  edgeId: string,
  endpoint: "source" | "target",
  nodeId: string,
) {
  const next = cloneMermaidVisualModel(model);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!edge || !node) return next;
  const reconnected = reconnectMermaidGfxVisualEdge(
    next,
    edge,
    endpoint,
    node.id,
  );
  if (!reconnected) return cloneMermaidVisualModel(model);
  next.edges = next.edges.map((candidate) =>
    candidate.id === edge.id ? reconnected : candidate,
  );
  return next;
}

export function moveMermaidVisualNode(
  model: MermaidVisualModel,
  nodeId: string,
  dx: number,
  dy: number,
) {
  const next = cloneMermaidVisualModel(model);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (node) {
    node.x += dx;
    node.y += dy;
  }
  return syncMermaidVisualSubgraphMembership(next);
}

export function resizeMermaidVisualNode(
  model: MermaidVisualModel,
  nodeId: string,
  width: number,
  height: number,
) {
  const next = cloneMermaidVisualModel(model);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (node && Number.isFinite(width) && Number.isFinite(height)) {
    node.width = Math.max(96, Math.round(width));
    node.height = Math.max(56, Math.round(height));
  }
  return syncMermaidVisualSubgraphMembership(next);
}
