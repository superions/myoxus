// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFontString, measureTextInDOM, wrapText } from "@virgultum/gfx-text";

import {
  mermaidGfxTypographyForNode,
  resolveMermaidGfxTheme,
} from "../../mermaid-gfx-theme.js";
import { readMermaidGfxMeta } from "../../mermaid-gfx-metadata.js";
import { toMermaidConnectorElementProps } from "../runtime/gfx-element-projection.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import type {
  MermaidVisualModel,
  MermaidVisualEdge,
} from "../runtime/gfx-model.js";
import { flowchartSubgraphElementStyle } from "./gfx-style-projection.js";

export function flowchartConnectorRoutingProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const line = resolveMermaidGfxTheme().typography.lineHeight;
  const parallels = model.edges.filter(
    (other) =>
      (other.source === edge.source && other.target === edge.target) ||
      (other.source === edge.target && other.target === edge.source),
  );
  const earlierEdges = model.edges.slice(
    0,
    model.edges.findIndex((other) => other.id === edge.id),
  );
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    endpointScale: 0.6,
    routingObstacleKeys: [
      ...model.nodes
        .filter((node) => node.id !== edge.source && node.id !== edge.target)
        .map((node) => node.id),
      ...earlierEdges.map((other) => other.id),
    ],
    routingObstacleRegions: Object.fromEntries(
      (model.subgraphs ?? [])
        .filter((group) => group.id !== edge.source && group.id !== edge.target)
        .map((group) => {
          const style = flowchartSubgraphElementStyle(model, group);
          const type = mermaidGfxTypographyForNode(style);
          const [top, inline] = style.padding;
          const lines = wrapText(
            group.displayLabel ?? group.title,
            getFontString(type),
            Math.max(1, group.width - inline * 2),
          ).split("\n").length;
          const metrics = measureTextInDOM(
            type.fontFamily,
            type.fontSize,
            type.fontWeight,
          );
          // Protect the native heading's painted lines, leaving its bottom
          // padding as an approach corridor for a member's top connection.
          // A fixed band can extend into that member and force an edge onto it.
          const height = top + lines * (metrics.lineHeight + metrics.lineGap);
          return [group.id, [0, 0, group.width, height] as const];
        }),
    ),
    routingClearance: line / 2,
    routingLaneOffset:
      (parallels.findIndex((other) => other.id === edge.id) -
        (parallels.length - 1) / 2) *
      line *
      2,
    // Earlier routes and labels have priority, avoiding cyclic layout updates.
    labelObstacleKeys: [
      ...model.nodes.map((node) => node.id),
      ...earlierEdges.map((other) => other.id),
    ],
  };
}

/** Routing is local presentation. Hydrate a cold owner even when its stored
 * Source, manual bounds and authored endpoints already match. */
export function flowchartConnectorRoutingMatches(
  model: MermaidVisualModel,
  elements: readonly unknown[],
  connectors: readonly unknown[],
) {
  const ids = new Map<string, string>();
  for (const element of [...elements, ...connectors]) {
    const key =
      readMermaidGfxMeta(element, "mermaidNodeId") ||
      readMermaidGfxMeta(element, "mermaidSubgraphId") ||
      readMermaidGfxMeta(element, "mermaidEdgeId");
    const id = (element as { id?: string }).id;
    if (key && id) ids.set(key, id);
  }
  return model.edges.every((edge) => {
    const connector = connectors.find(
      (element) => readMermaidGfxMeta(element, "mermaidEdgeId") === edge.id,
    ) as Record<string, unknown> | undefined;
    if (!connector) return false;
    const expected = toMermaidConnectorElementProps(
      edge,
      ids,
      undefined,
      flowchartConnectorRoutingProjection(model, edge),
    ) as Record<string, unknown>;
    return [
      "routingObstacleIds",
      "routingObstacleRegions",
      "routingClearance",
      "routingLaneOffset",
      "labelObstacleIds",
      "endpointScale",
    ].every(
      (key) => JSON.stringify(connector[key]) === JSON.stringify(expected[key]),
    );
  });
}
