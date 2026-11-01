// SPDX-License-Identifier: AGPL-3.0-or-later

import { getMermaidFrontmatterTitle } from "../engine/diagram-types.js";
import type { MermaidVisualEdge } from "./runtime/gfx-model.js";
import type {
  MermaidVisualEndpointPosition,
  MermaidVisualNode,
} from "./runtime/gfx-model.js";
import { semanticMermaidEdgeLabelPlacementForEndpoints } from "./runtime/gfx-element-projection.js";

type MermaidSemanticSourceProjection = {
  readonly accessibilityDescription?: string;
  readonly accessibilityTitle?: string;
  readonly diagramTitle?: string;
  readonly directives: string[];
  readonly sourceAnnotations: string[];
};

function visualNodeCenter(node: MermaidVisualNode) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

export function semanticMermaidEndpointPositionsBetween(
  source: MermaidVisualNode | undefined,
  target: MermaidVisualNode | undefined,
): {
  sourcePosition?: MermaidVisualEndpointPosition;
  targetPosition?: MermaidVisualEndpointPosition;
} {
  if (!source || !target) return {};
  const sourceCenter = visualNodeCenter(source);
  const targetCenter = visualNodeCenter(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourcePosition: [1, 0.5], targetPosition: [0, 0.5] }
      : { sourcePosition: [0, 0.5], targetPosition: [1, 0.5] };
  }
  return dy >= 0
    ? { sourcePosition: [0.5, 1], targetPosition: [0.5, 0] }
    : { sourcePosition: [0.5, 0], targetPosition: [0.5, 1] };
}

export function mermaidVisualNodeIndex(nodes: readonly MermaidVisualNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function semanticMermaidEdge(
  edge: Parameters<typeof edgeToVisual>[0],
  nodes?: ReadonlyMap<string, MermaidVisualNode>,
) {
  const inferredEndpoints = semanticMermaidEndpointPositionsBetween(
    nodes?.get(edge.source),
    nodes?.get(edge.target),
  );
  const sourcePosition =
    edge.sourcePosition ?? inferredEndpoints.sourcePosition;
  const targetPosition =
    edge.targetPosition ?? inferredEndpoints.targetPosition;
  return edgeToVisual({
    ...edge,
    connectorMode: "straight",
    labelPlacement: semanticMermaidEdgeLabelPlacementForEndpoints({
      sourcePosition,
      targetPosition,
    }),
    sourcePosition,
    targetPosition,
  });
}

export function mermaidSemanticSourceProjection(
  model: MermaidSemanticSourceProjection,
  diagramTitleFallback = "",
) {
  return {
    accessibilityDescription: model.accessibilityDescription,
    accessibilityTitle: model.accessibilityTitle,
    diagramTitle:
      model.diagramTitle ||
      diagramTitleFallback ||
      getMermaidFrontmatterTitle(model.directives),
    sourceAnnotations: model.sourceAnnotations,
    sourcePreamble: model.directives,
  };
}

export function visualNode({
  details,
  displayLabel,
  familyData,
  height,
  id,
  label,
  labelEditable,
  shape,
  textAlign,
  textVerticalAlign,
  width,
  x,
  y,
}: MermaidVisualNode): MermaidVisualNode {
  return {
    details,
    displayLabel: displayLabel ?? label,
    familyData,
    height,
    id,
    label,
    labelEditable,
    shape,
    textAlign: textAlign ?? "center",
    textVerticalAlign: textVerticalAlign ?? "center",
    width,
    x,
    y,
  };
}

export function edgeToVisual({
  connectorMode,
  displayLabel,
  familyData,
  id,
  label,
  labelEditable,
  labelPlacement,
  linkType,
  source,
  sourceAttachment,
  sourceMarker,
  sourcePortId,
  sourcePosition,
  style,
  target,
  targetAttachment,
  targetMarker,
  targetPortId,
  targetPosition,
}: {
  connectorMode?: MermaidVisualEdge["connectorMode"];
  displayLabel?: string;
  familyData?: MermaidVisualEdge["familyData"];
  id: string;
  label?: string;
  labelEditable?: boolean;
  labelPlacement?: MermaidVisualEdge["labelPlacement"];
  linkType?: MermaidVisualEdge["linkType"];
  source: string;
  sourceAttachment?: string;
  sourceMarker?: MermaidVisualEdge["sourceMarker"];
  sourcePortId?: MermaidVisualEdge["sourcePortId"];
  sourcePosition?: MermaidVisualEdge["sourcePosition"];
  style?: MermaidVisualEdge["style"];
  target: string;
  targetAttachment?: string;
  targetMarker?: MermaidVisualEdge["targetMarker"];
  targetPortId?: MermaidVisualEdge["targetPortId"];
  targetPosition?: MermaidVisualEdge["targetPosition"];
}): MermaidVisualEdge {
  return {
    connectorMode,
    displayLabel,
    familyData,
    id,
    label: label ?? "",
    labelEditable,
    labelPlacement,
    linkType: linkType ?? "arrow",
    source,
    sourceAttachment,
    sourceMarker,
    sourcePortId,
    sourcePosition,
    style: style ?? "solid",
    target,
    targetAttachment,
    targetMarker,
    targetPortId,
    targetPosition,
  };
}
