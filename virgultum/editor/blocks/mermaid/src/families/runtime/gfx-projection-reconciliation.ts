// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "./gfx-model.js";

export function reconcileMatchingMermaidGfxGeometry(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  if (!canReuseStored) return parsed;
  const storedNodes = new Map(stored.nodes.map((node) => [node.id, node]));
  const storedEdges = new Map(stored.edges.map((edge) => [edge.id, edge]));
  const storedSubgraphs = new Map(
    (stored.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  if (
    parsed.nodes.some((node) => !storedNodes.has(node.id)) ||
    parsed.edges.some((edge) => !storedEdges.has(edge.id)) ||
    (parsed.subgraphs ?? []).some(
      (subgraph) => !storedSubgraphs.has(subgraph.id),
    ) ||
    stored.nodes.length !== parsed.nodes.length ||
    stored.edges.length !== parsed.edges.length ||
    (stored.subgraphs?.length ?? 0) !== (parsed.subgraphs?.length ?? 0)
  ) {
    return parsed;
  }
  return {
    ...parsed,
    edges: parsed.edges.map((edge) => {
      const geometry = storedEdges.get(edge.id);
      return geometry
        ? {
            ...edge,
            connectorMode: geometry.connectorMode,
            labelPlacement: geometry.labelPlacement,
            sourcePortId: geometry.sourcePortId,
            sourcePosition: geometry.sourcePosition,
            targetPortId: geometry.targetPortId,
            targetPosition: geometry.targetPosition,
          }
        : edge;
    }),
    nodes: parsed.nodes.map((node) => {
      const geometry = storedNodes.get(node.id);
      return geometry
        ? {
            ...node,
            height: geometry.height,
            width: geometry.width,
            x: geometry.x,
            y: geometry.y,
          }
        : node;
    }),
    subgraphs: (parsed.subgraphs ?? []).map((subgraph) => {
      const geometry = storedSubgraphs.get(subgraph.id);
      return geometry
        ? {
            ...subgraph,
            height: geometry.height,
            width: geometry.width,
            x: geometry.x,
            y: geometry.y,
          }
        : subgraph;
    }),
  };
}
