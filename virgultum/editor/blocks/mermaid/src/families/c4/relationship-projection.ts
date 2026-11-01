// SPDX-License-Identifier: AGPL-3.0-or-later

import { C4_CALLS } from "../../engine/c4/runtime-contract.js";
import type {
  MermaidVisualModel,
  MermaidVisualEdge,
} from "../runtime/gfx-model.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import { c4EdgeHidden } from "./boundary-projection.js";
import {
  c4BoundaryHiddenBy,
  c4BoundaryHeaderHeight,
} from "./boundary-projection.js";
import { c4ProjectedContentStyle, c4NoPaint } from "./style-projection.js";
import { measureTextInDOM } from "@virgultum/gfx-text";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import type {
  MermaidC4Model,
  MermaidC4Relationship,
} from "../../engine/c4/model.js";

export function c4RelationshipDisplayLabel(value: {
  label: string;
  technology: string;
  description: string;
  dynamicStep?: number;
}) {
  return [
    value.dynamicStep ? `${value.dynamicStep}: ${value.label}` : value.label,
    value.technology,
    value.description,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Actual Source colors feed the common connector and its label consumer. */
export function projectC4RelationshipElement(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const { strokeColor, ...textStyle } = c4ProjectedContentStyle(edge);
  if (c4NoPaint(textStyle.color)) textStyle.color = "transparent";
  const font = {
    ...resolveMermaidGfxProjectionTheme().typography,
    ...textStyle,
  };
  const lineHeight = measureTextInDOM(
    font.fontFamily,
    font.fontSize,
    font.fontWeight,
  ).lineHeight;
  const nodes = model.nodes.filter((n) => !c4BoundaryHiddenBy(model, n.id));
  const index = model.edges.findIndex((e) => e.id === edge.id);
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    hidden: c4EdgeHidden(model, edge),
    ...textStyle,
    endpointScale: 0.4,
    labelLineHeight: lineHeight,
    labelObstacleKeys: [
      ...nodes.map((n) => n.id),
      ...model.edges.slice(0, index).map((e) => e.id),
    ],
    routingObstacleKeys: nodes
      .filter((n) => n.id !== edge.source && n.id !== edge.target)
      .map((n) => n.id),
    routingObstacleRegions: Object.fromEntries(
      (model.subgraphs ?? [])
        .filter(
          (g) =>
            g.id !== (edge.sourceAttachment ?? edge.source) &&
            g.id !== (edge.targetAttachment ?? edge.target) &&
            !c4BoundaryHiddenBy(model, g.id),
        )
        .map((g) => [
          g.id,
          [0, 0, g.width, c4BoundaryHeaderHeight(g)] as const,
        ]),
    ),
    routingClearance: Math.max(
      1,
      (lineHeight * (edge.displayLabel ?? edge.label).split("\n").length) / 2,
    ),
    ...(strokeColor
      ? { stroke: c4NoPaint(strokeColor) ? "transparent" : strokeColor }
      : {}),
  };
}
/** Repeated declarations share a visible pair; each record retains its own field effect. */
export function c4RelationshipRecords(
  model: MermaidC4Model,
  relationship: MermaidC4Relationship,
) {
  if (!relationship.resolution) return [];
  return model.occurrences.filter(
    (r) =>
      r.category === "relationship" &&
      r.selectionId === relationship.resolution?.selectionId,
  );
}

/** Native marker comparisons consume the final DB value, including text-form overrides. */
export function c4RelationshipLinkType(relationship: MermaidC4Relationship) {
  const type = relationship.resolution
    ? relationship.resolution.fields.type
    : C4_CALLS[relationship.kind]?.nativeType;
  return type === "birel"
    ? ("bidirectional" as const)
    : type === "rel_b"
      ? ("reverse" as const)
      : undefined;
}

/** Record controls consume the real receiving slots, including ignored RelIndex and extras. */
export function c4RelationshipRecordFields(
  model: MermaidC4Model,
  sourceKey: string,
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey && r.kind === "relationship",
  );
  if (!record?.arguments || !record.callKind) return [];
  const contract = C4_CALLS[record.callKind];
  return record.arguments.flatMap((argument, index) => {
    const slot = contract.slots[index];
    if (slot === "from" || slot === "to") return [];
    return [
      {
        index,
        argument,
        field: argument.named || argument.key ? argument.key : (slot ?? ""),
        ignored: slot === "index" || index >= contract.slots.length,
      },
    ];
  });
}
