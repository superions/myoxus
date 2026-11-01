// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "./gfx-model.js";

function cloneModel(model: MermaidVisualModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidVisualModel;
}

function subgraphBounds(model: MermaidVisualModel, nodeIds: string[]) {
  const nodes = model.nodes.filter((node) => nodeIds.includes(node.id));
  if (nodes.length === 0) {
    return { height: 220, width: 300, x: 24, y: 24 };
  }
  const left = Math.min(...nodes.map((node) => node.x)) - 36;
  const top = Math.min(...nodes.map((node) => node.y)) - 52;
  const right = Math.max(...nodes.map((node) => node.x + node.width)) + 36;
  const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + 40;
  return {
    height: Math.max(160, bottom - top),
    width: Math.max(240, right - left),
    x: Math.max(0, left),
    y: Math.max(0, top),
  };
}

export function createNeutralGfxSubgraph(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[],
  titlePrefix: string,
): MermaidVisualSubgraph {
  const existingIds = new Set([
    ...model.nodes.map((node) => node.id),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
  ]);
  let index = existingIds.size + 1;
  while (existingIds.has(`SG${index}`)) index += 1;
  const id = `SG${index}`;
  const validNodeIds = new Set(model.nodes.map((node) => node.id));
  const nodeIds = [...new Set(selectedNodeIds)].filter((nodeId) =>
    validNodeIds.has(nodeId),
  );
  return {
    ...subgraphBounds(model, nodeIds),
    direction: model.direction,
    id,
    nodeIds,
    title: `${titlePrefix} ${index}`,
  };
}

function isNodeCenterInsideSubgraph(
  node: MermaidVisualNode,
  subgraph: MermaidVisualSubgraph,
) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  return (
    centerX >= subgraph.x &&
    centerX <= subgraph.x + subgraph.width &&
    centerY >= subgraph.y &&
    centerY <= subgraph.y + subgraph.height
  );
}

export function syncSpatialGfxSubgraphMembership(model: MermaidVisualModel) {
  for (const subgraph of model.subgraphs ?? []) {
    subgraph.nodeIds = model.nodes
      .filter((node) => isNodeCenterInsideSubgraph(node, subgraph))
      .map((node) => node.id);
  }
  return model;
}

export function reconnectNeutralGfxEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  endpoint: "source" | "target",
  nodeId: string,
  canConnect: (
    model: MermaidVisualModel,
    source: string,
    target: string,
  ) => boolean,
) {
  const source = endpoint === "source" ? nodeId : edge.source;
  const target = endpoint === "target" ? nodeId : edge.target;
  if (!canConnect(model, source, target)) return null;
  return {
    ...edge,
    source,
    sourceAttachment: endpoint === "source" ? undefined : edge.sourceAttachment,
    target,
    targetAttachment: endpoint === "target" ? undefined : edge.targetAttachment,
  };
}

export function deleteNeutralGfxSelection(
  model: MermaidVisualModel,
  selection: {
    readonly edgeId?: string;
    readonly nodeId?: string;
    readonly nodeIds?: readonly string[];
    readonly subgraphId?: string;
  },
) {
  const next = cloneModel(model);
  if (selection.subgraphId) {
    next.subgraphs = (next.subgraphs ?? []).filter(
      (subgraph) => subgraph.id !== selection.subgraphId,
    );
    next.edges = next.edges.filter(
      (edge) =>
        edge.source !== selection.subgraphId &&
        edge.target !== selection.subgraphId,
    );
  }
  if (selection.edgeId) {
    next.edges = next.edges.filter((edge) => edge.id !== selection.edgeId);
  }
  const selectedNodeIds = new Set([
    ...(selection.nodeIds ?? []),
    ...(selection.nodeId ? [selection.nodeId] : []),
  ]);
  if (selectedNodeIds.size > 0) {
    next.nodes = next.nodes.filter((node) => !selectedNodeIds.has(node.id));
    next.edges = next.edges.filter(
      (edge) =>
        !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target),
    );
    for (const subgraph of next.subgraphs ?? []) {
      subgraph.nodeIds = subgraph.nodeIds.filter(
        (nodeId) => !selectedNodeIds.has(nodeId),
      );
    }
  }
  return next;
}
