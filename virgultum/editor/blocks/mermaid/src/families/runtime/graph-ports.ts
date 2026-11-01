// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidVisualEdge,
  MermaidVisualNode,
  MermaidVisualSubgraph,
  MermaidVisualModel,
} from "./gfx-model.js";
import {
  measureMermaidGfxText,
  type MermaidGfxTypography,
} from "../../mermaid-gfx-theme.js";

/** Shared ER/Requirement lane clearance includes the complete rendered label,
 * not just a port index or the semantic endpoint pair. */
export function measuredMermaidEdgeRouting(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  typography: MermaidGfxTypography,
) {
  const parallels = model.edges.filter(
    (other) =>
      (other.source === edge.source && other.target === edge.target) ||
      (other.source === edge.target && other.target === edge.source),
  );
  const index = parallels.findIndex((other) => other.id === edge.id);
  const clearance = Math.max(
    36,
    ...parallels.map((other) => {
      const label = measureMermaidGfxText(
        other.displayLabel ?? other.label,
        typography,
      );
      return Math.max(
        (label.width + typography.lineHeight) / 2,
        (label.height + typography.lineHeight / 4) * 1.5,
      );
    }),
  );
  return {
    routingClearance:
      clearance + typography.lineHeight / 2 + index * typography.lineHeight * 2,
    routingLaneOffset:
      (index - (parallels.length - 1) / 2) * typography.lineHeight * 2,
  };
}
/** Allocate every incident edge a distinct port on its actual geometric side.
 * Self-loop ports already occupy separate halves of the same side. */
export function distributeMermaidPorts(
  edges: readonly MermaidVisualEdge[],
  nodes: readonly MermaidVisualNode[],
  groups: readonly MermaidVisualSubgraph[] = [],
): MermaidVisualEdge[] {
  const bounds = new Map([...nodes, ...groups].map((n) => [n.id, n]));
  const buckets = new Map<
    string,
    { edge: string; end: "source" | "target"; side: string }[]
  >();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    for (const end of ["source", "target"] as const) {
      const owner = bounds.get(edge[end]),
        other = bounds.get(edge[end === "source" ? "target" : "source"]);
      if (!owner || !other) continue;
      const dx = other.x + other.width / 2 - owner.x - owner.width / 2,
        dy = other.y + other.height / 2 - owner.y - owner.height / 2,
        side =
          Math.abs(dx) >= Math.abs(dy)
            ? dx >= 0
              ? "right"
              : "left"
            : dy >= 0
              ? "bottom"
              : "top",
        key = `${owner.id}:${side}`;
      buckets.set(key, [
        ...(buckets.get(key) ?? []),
        { edge: edge.id, end, side },
      ]);
    }
  }
  const positions = new Map<string, readonly [number, number]>();
  for (const bucket of buckets.values()) {
    bucket.forEach(({ edge, end, side }, index) => {
      const port = (index + 1) / (bucket.length + 1);
      positions.set(
        `${edge}:${end}`,
        side === "right"
          ? [1, port]
          : side === "left"
            ? [0, port]
            : side === "bottom"
              ? [port, 1]
              : [port, 0],
      );
    });
  }
  return edges.map((edge) => ({
    ...edge,
    sourcePosition: positions.get(`${edge.id}:source`) ?? edge.sourcePosition,
    targetPosition: positions.get(`${edge.id}:target`) ?? edge.targetPosition,
  }));
}
