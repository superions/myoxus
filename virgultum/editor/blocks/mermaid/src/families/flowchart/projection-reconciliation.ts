// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateMermaidSourceFromVisualModel } from "../../engine/flowchart-writer.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { layoutMeasuredFlowchart } from "./layout.js";
import { parseMermaidSourceToVisualModel } from "../../engine/flowchart.js";

/** Flowchart family metadata (syntax and comments) belongs to Source. Retained
 * owner metadata must not turn a valid Flowchart ↔ ELK edit into a stale carrier. */
export function readFlowchartSourceProjection(
  source: string,
  stored: MermaidVisualModel,
) {
  const parsed = parseMermaidSourceToVisualModel(source).model;
  return parsed ? { ...stored, familyData: parsed.familyData } : null;
}

export function reconcileFlowchartVisualProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  if (!canReuseStored)
    return layoutMeasuredFlowchart(parsed, { fromSource: true });
  const candidate = {
    ...stored,
    direction: parsed.direction,
    sourceAnnotations: parsed.sourceAnnotations,
    sourcePreamble: parsed.sourcePreamble,
    styleStatements: parsed.styleStatements,
    familyData: parsed.familyData,
  };
  if (
    candidate.nodes.length !== parsed.nodes.length ||
    candidate.edges.length !== parsed.edges.length ||
    (candidate.subgraphs?.length ?? 0) !== (parsed.subgraphs?.length ?? 0)
  ) {
    return layoutMeasuredFlowchart(parsed, { fromSource: true });
  }
  try {
    return generateMermaidSourceFromVisualModel(candidate) ===
      generateMermaidSourceFromVisualModel(parsed)
      ? candidate
      : layoutMeasuredFlowchart(parsed, { fromSource: true });
  } catch {
    return layoutMeasuredFlowchart(parsed, { fromSource: true });
  }
}

export function canonicalizeFlowchartProjectionAfterSourceWrite(
  reparsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  const requestedNodes = new Map(
    requested.nodes.map((node) => [node.id, node]),
  );
  const requestedEdges = new Map(
    requested.edges.map((edge) => [edge.id, edge]),
  );
  const requestedSubgraphs = new Map(
    (requested.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  return {
    ...reparsed,
    edges: reparsed.edges.map((edge) => {
      const projection = requestedEdges.get(edge.id);
      return projection
        ? {
            ...projection,
            ...edge,
            sourcePortId: projection.sourcePortId,
            sourcePosition: projection.sourcePortId
              ? projection.sourcePosition
              : edge.sourcePosition,
            targetPortId: projection.targetPortId,
            targetPosition: projection.targetPortId
              ? projection.targetPosition
              : edge.targetPosition,
          }
        : edge;
    }),
    nodes: reparsed.nodes.map((node) => {
      const geometry = requestedNodes.get(node.id);
      return geometry
        ? {
            ...geometry,
            ...node,
            height: geometry.height,
            width: geometry.width,
            x: geometry.x,
            y: geometry.y,
          }
        : node;
    }),
    subgraphs: (reparsed.subgraphs ?? []).map((subgraph) => {
      const geometry = requestedSubgraphs.get(subgraph.id);
      return geometry
        ? {
            ...geometry,
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
