// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { reconcileC4BoundaryPresentation } from "./gfx-data.js";
import { projectC4BoundaryPresentation } from "./boundary-projection.js";
import { sizeC4ContentNode } from "./content-projection.js";

/** Source identities survive insertions and removals. Geometry is presentation;
 * its content minimum is measured at the retained width, never at parser defaults. */
export function reconcileC4VisualProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  if (!canReuseStored) return parsed;
  parsed = reconcileC4BoundaryPresentation(parsed, stored);
  const nodes = new Map(stored.nodes.map((n) => [n.id, n]));
  const groups = new Map(stored.subgraphs?.map((g) => [g.id, g]));
  const edges = new Map(stored.edges.map((e) => [e.id, e]));
  return projectC4BoundaryPresentation({
    ...parsed,
    nodes: parsed.nodes.map((n) => {
      const old = nodes.get(n.id);
      if (!old) return n;
      const retained = {
        ...n,
        x: old.x,
        y: old.y,
        width: old.width,
        height: old.height,
      };
      return sizeC4ContentNode(retained);
    }),
    subgraphs: parsed.subgraphs?.map((g) => {
      const old = groups.get(g.id);
      return old
        ? { ...g, x: old.x, y: old.y, width: old.width, height: old.height }
        : g;
    }),
    edges: parsed.edges.map((e) => {
      const old = edges.get(e.id);
      return old && old.source === e.source && old.target === e.target
        ? {
            ...e,
            sourcePosition: old.sourcePosition,
            targetPosition: old.targetPosition,
            sourcePortId: old.sourcePortId,
            targetPortId: old.targetPortId,
            connectorMode: old.connectorMode,
            labelPlacement: old.labelPlacement,
          }
        : e;
    }),
  });
}
