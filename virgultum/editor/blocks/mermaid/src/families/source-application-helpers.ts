// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
} from "./runtime/gfx-model.js";

export function upsertVisualNodes<
  T extends {
    id: string;
    label: string;
    order: number;
    width: number;
    x: number;
    y: number;
  },
>(
  items: T[],
  visualModel: MermaidVisualModel,
  create: (node: MermaidVisualNode, order: number) => T,
) {
  // Preserve source-owned fields while applying the visual editor's geometry,
  // label and order. Family writers add their own semantic fields in `create`.
  const byId = new Map(items.map((item) => [item.id, item]));
  return visualModel.nodes.map((node, index) => {
    const existing = byId.get(node.id);
    return existing
      ? {
          ...existing,
          label: node.label || existing.label || node.id,
          order: index,
          width: node.width,
          x: node.x,
          y: node.y,
        }
      : create(node, index);
  });
}

export function upsertVisualEdges<
  T extends { id: string; label: string; order: number },
>(
  items: T[],
  visualModel: MermaidVisualModel,
  create: (edge: MermaidVisualEdge, order: number) => T,
) {
  // Edge endpoint semantics differ by family, so this helper only preserves
  // shared source fields; callers rewrite source/target and kind metadata.
  const byId = new Map(items.map((item) => [item.id, item]));
  return visualModel.edges.map((edge, index) => {
    const existing = byId.get(edge.id);
    return existing
      ? {
          ...existing,
          label: edge.label,
          order: index,
        }
      : create(edge, index);
  });
}
