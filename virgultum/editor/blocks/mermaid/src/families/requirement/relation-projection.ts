// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
} from "../runtime/gfx-model.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import {
  resolveMermaidGfxProjectionTheme,
  mermaidGfxTypographyForNode,
} from "../../mermaid-gfx-theme.js";
import {
  requirementEdgeGfxData,
  requirementEdgeFamilyData,
} from "./gfx-data.js";
import {
  distributeMermaidPorts,
  measuredMermaidEdgeRouting,
} from "../runtime/graph-ports.js";

/** Native Requirement relationships derive their notation from the Source type,
 * never a freely edited connector label or a stored generic arrow preset. */
export function projectRequirementRelation(
  edge: MermaidVisualEdge,
): MermaidVisualEdge {
  const kind = requirementEdgeGfxData(edge)?.relationKind ?? "satisfies",
    contains = kind === "contains";
  return {
    ...edge,
    // Same-side loops consume the native curve, not an orthogonal self-route.
    ...(edge.source === edge.target
      ? {
          connectorMode: "curve" as const,
        }
      : {}),
    label: `<<${kind}>>`,
    displayLabel: `<<${kind}>>`,
    labelEditable: false,
    sourceMarker: contains ? "circle-cross" : "none",
    targetMarker: contains ? "none" : "arrow",
    linkType: contains ? "open" : "arrow",
    style: contains ? "solid" : "dotted",
  };
}
export function projectRequirementConnectorElement(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxConnectorElement(
      projectRequirementRelation(edge),
    ),
    ...measuredMermaidEdgeRouting(model, edge, mermaidGfxTypographyForNode({})),
    routingObstacleKeys: model.nodes
      .filter((node) => node.id !== edge.source && node.id !== edge.target)
      .map((node) => node.id),
    labelObstacleKeys: model.nodes.map((node) => node.id),
    stroke: theme.secondaryTextColor,
  };
}

function boundarySide(position: readonly number[] | undefined) {
  if (!position || position.some((value) => value < 0 || value > 1))
    return undefined;
  return position[0] === 0
    ? "left"
    : position[0] === 1
      ? "right"
      : position[1] === 0
        ? "top"
        : position[1] === 1
          ? "bottom"
          : undefined;
}
function loopPosition(
  side: "left" | "right" | "top" | "bottom",
  offset: number,
): readonly [number, number] {
  return side === "left"
    ? [0, offset]
    : side === "right"
      ? [1, offset]
      : side === "top"
        ? [offset, 0]
        : [offset, 1];
}

/** Allocate by stable relation records, including reverse records. A port ID
 * or a position different from our last derivation remains a manual choice.
 * Legal loop ports occupy different positions on the same card side; keeping
 * opposite-side ports would draw the native curve through its owning card. */
export function routeRequirementRelations(
  model: MermaidVisualModel,
): MermaidVisualModel {
  const allocated = distributeMermaidPorts(model.edges, model.nodes);
  const matches = (
    position: readonly number[] | undefined,
    derived: readonly number[] | undefined,
  ) =>
    !position ||
    Boolean(
      derived && position[0] === derived[0] && position[1] === derived[1],
    );
  const center = model.nodes.length
    ? model.nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) /
      model.nodes.length
    : 0;
  return {
    ...model,
    edges: model.edges.map((edge, index) => {
      const data = requirementEdgeGfxData(edge);
      if (!data) return edge;
      const loop = edge.source === edge.target;
      const siblings = model.edges.filter(
        (other) => other.source === edge.source && other.target === edge.target,
      );
      const port =
        (siblings.findIndex((other) => other.id === edge.id) + 1) /
        (siblings.length + 1);
      const owner = model.nodes.find((node) => node.id === edge.source);
      let sourceDerived =
          !edge.sourcePortId &&
          matches(edge.sourcePosition, data.layoutSourcePosition),
        targetDerived =
          !edge.targetPortId &&
          matches(edge.targetPosition, data.layoutTargetPosition);
      const sourceSide = !sourceDerived && boundarySide(edge.sourcePosition),
        targetSide = !targetDerived && boundarySide(edge.targetPosition);
      const side =
        sourceSide ||
        targetSide ||
        (owner && owner.x + owner.width / 2 < center ? "left" : "right");
      if (loop) {
        sourceDerived ||= !sourceSide || sourceSide !== side;
        targetDerived ||=
          !targetSide ||
          targetSide !== side ||
          Boolean(
            edge.sourcePosition &&
            edge.targetPosition &&
            edge.sourcePosition[0] === edge.targetPosition[0] &&
            edge.sourcePosition[1] === edge.targetPosition[1],
          );
      }
      const derivedSource = loop
        ? loopPosition(side, port / 2)
        : allocated[index].sourcePosition;
      let derivedTarget = loop
        ? loopPosition(side, 0.5 + port / 2)
        : allocated[index].targetPosition;
      if (
        loop &&
        targetDerived &&
        edge.sourcePosition &&
        !sourceDerived &&
        matches(edge.sourcePosition, derivedTarget)
      )
        derivedTarget = loopPosition(side, port / 2);
      const { family: _family, ...payload } = data;
      return {
        ...projectRequirementRelation(edge),
        connectorMode: loop ? "curve" : "orthogonal",
        labelPlacement: "center",
        sourcePosition: sourceDerived ? derivedSource : edge.sourcePosition,
        targetPosition: targetDerived ? derivedTarget : edge.targetPosition,
        sourcePortId: sourceDerived ? undefined : edge.sourcePortId,
        targetPortId: targetDerived ? undefined : edge.targetPortId,
        familyData: requirementEdgeFamilyData({
          ...payload,
          layoutSourcePosition: sourceDerived ? derivedSource : undefined,
          layoutTargetPosition: targetDerived ? derivedTarget : undefined,
        }),
      };
    }),
  };
}
