// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ErCardinality,
  MermaidErRelationship,
} from "../../engine/er/index.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualEndpointMarker,
} from "../runtime/gfx-model.js";
import { erEdgeFamilyData } from "./gfx-data.js";
import { mermaidMessages as m } from "../../i18n.js";
import {
  endpointPointStyle,
  projectNeutralMermaidGfxConnectorElement,
} from "../runtime/gfx-element-projection-defaults.js";
import {
  measureMermaidGfxText,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { createConnectorEndpointMarker } from "@virgultum/gfx-connector";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { measuredMermaidEdgeRouting } from "../runtime/graph-ports.js";
const markers: Record<ErCardinality, MermaidVisualEndpointMarker> = {
  "exactly-one": "double-bar",
  "zero-or-one": "circle-bar",
  "one-or-many": "bar-crow-foot",
  "zero-or-many": "circle-crow-foot",
  "mermaid-parent": "none",
};
export function erCardinalityPointStyle(cardinality: ErCardinality) {
  return endpointPointStyle(markers[cardinality]);
}
/** The object form previews the same marker primitive as the GFX connector. */
export function createErCardinalityPreviewMarker(
  id: string,
  cardinality: ErCardinality,
  start: boolean,
) {
  return createConnectorEndpointMarker(
    id,
    erCardinalityPointStyle(cardinality),
    "currentColor",
    "var(--myoxus-background-primary-color)",
    2,
    start,
    1,
  );
}
export { distributeMermaidPorts as distributeErPorts } from "../runtime/graph-ports.js";
export function erRelationshipProjection(
  relation: MermaidErRelationship,
  ids: ReadonlyMap<string, string>,
  siblings: readonly MermaidErRelationship[] = [relation],
): MermaidVisualEdge {
  const parallels = siblings.filter(
      (r) =>
        (r.from === relation.from && r.to === relation.to) ||
        (r.from === relation.to && r.to === relation.from),
    ),
    index = parallels.findIndex((r) => r.sourceKey === relation.sourceKey),
    port = (index + 1) / (parallels.length + 1),
    loop = relation.from === relation.to,
    forward = relation.from.localeCompare(relation.to) <= 0;
  return {
    id: relation.sourceKey,
    source: ids.get(relation.from)!,
    target: ids.get(relation.to)!,
    label: relation.label,
    displayLabel: relation.label,
    labelEditable: false,
    labelPlacement: "top",
    sourceMarker: markers[relation.cardinalityA],
    targetMarker: markers[relation.cardinalityB],
    style: relation.identification === ".." ? "dotted" : "solid",
    connectorMode: loop ? "curve" : "orthogonal",
    sourcePosition: loop
      ? [1, port / 2]
      : parallels.length > 1
        ? [forward ? 1 : 0, port]
        : undefined,
    targetPosition: loop
      ? [1, 0.5 + port / 2]
      : parallels.length > 1
        ? [forward ? 0 : 1, port]
        : undefined,
    endpointLabels: {
      source:
        relation.cardinalityA === "mermaid-parent" ? m.erParentBadge() : "",
      target:
        relation.cardinalityB === "mermaid-parent" ? m.erParentBadge() : "",
    },
    familyData: erEdgeFamilyData(relation),
  };
}

export function erConnectorElementProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    fontSize =
      Number(
        (
          mermaidVisualFamilyPayload(model.familyData, "er")?.config as
            Record<string, unknown> | undefined
        )?.fontSize,
      ) || theme.typography.fontSize,
    typography = mermaidGfxTypographyForNode({ fontSize }, theme);
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    endpointScale: 1,
    routingObstacleKeys: model.nodes
      .filter((n) => n.id !== edge.source && n.id !== edge.target)
      .map((n) => n.id),
    routingObstacleRegions: Object.fromEntries(
      (model.subgraphs ?? [])
        .filter((g) => g.id !== edge.source && g.id !== edge.target)
        .map((g) => {
          const groupTypography = mermaidGfxTypographyForNode(
              projectMermaidSourceStyle(
                mermaidVisualFamilyPayload(g.familyData, "er")?.styles,
              ),
              theme,
            ),
            label = measureMermaidGfxText(
              g.displayLabel ?? g.title,
              groupTypography,
            ),
            padding = theme.typography.lineHeight / 4;
          return [
            g.id,
            [
              (g.width - label.width) / 2 - padding,
              theme.typography.lineHeight / 2,
              label.width + padding * 2,
              label.height,
            ] as const,
          ];
        }),
    ),
    // Match the existing measured connector label and its top anchor. Both
    // horizontal and vertical detours must keep the full label off cards.
    ...measuredMermaidEdgeRouting(model, edge, typography),
    stroke: theme.secondaryTextColor,
    fontSize,
  };
}
