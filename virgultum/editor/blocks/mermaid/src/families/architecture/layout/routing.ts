// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureModel } from "../../../engine/architecture/index.js";
import { resolveMermaidGfxTheme } from "../../../mermaid-gfx-theme.js";
import {
  mermaidVisualNodeIndex,
  semanticMermaidEdge,
} from "../../gfx-visual-model-helpers.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
} from "../../runtime/gfx-model.js";
import {
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureEdgeLinkType,
  architecturePortPosition,
} from "../gfx-data.js";
import type { ArchitectureRelationMeasurement } from "./measurement.js";

function architecturePortVector(port: string) {
  if (port === "L") return { x: -1, y: 0 };
  if (port === "R") return { x: 1, y: 0 };
  if (port === "T") return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

export function applyArchitectureEdgeDirections(
  model: MermaidArchitectureModel,
  nodesById: ReadonlyMap<string, MermaidVisualNode>,
  moveTarget: (
    source: MermaidVisualNode,
    target: MermaidVisualNode,
    deltaX: number,
    deltaY: number,
  ) => void,
  idealDistance: number,
  elasticity: number,
  measurements: ReadonlyMap<string, ArchitectureRelationMeasurement>,
) {
  for (const edge of [...model.edges].sort(
    (left, right) => left.order - right.order,
  )) {
    const source = nodesById.get(edge.from);
    const target = nodesById.get(edge.to);
    if (!source || !target || source === target) continue;
    const sourcePort = architecturePortVector(edge.fromPort);
    const targetPort = architecturePortVector(edge.toPort);
    const directionX = sourcePort.x - targetPort.x;
    const directionY = sourcePort.y - targetPort.y;
    const sourceCenterX = source.x + source.width / 2;
    const sourceCenterY = source.y + source.height / 2;
    const targetCenterX = target.x + target.width / 2;
    const targetCenterY = target.y + target.height / 2;
    const measured = measurements.get(edge.id);
    const directionalLabelExtent =
      directionX === 0
        ? (measured?.labelHeight ?? 0)
        : directionY === 0
          ? (measured?.labelWidth ?? 0)
          : Math.max(measured?.labelHeight ?? 0, measured?.labelWidth ?? 0);
    const relationClearance = measured
      ? directionalLabelExtent + measured.markerExtent + measured.portExtent * 2
      : 0;
    const routedDistance = Math.max(idealDistance, relationClearance);
    const inlineDistance = (source.width + target.width) / 2 + routedDistance;
    const blockDistance = (source.height + target.height) / 2 + routedDistance;
    if (directionX > 0 && targetCenterX < sourceCenterX + inlineDistance) {
      moveTarget(
        source,
        target,
        (sourceCenterX + inlineDistance - target.width / 2 - target.x) *
          elasticity,
        0,
      );
    } else if (
      directionX < 0 &&
      targetCenterX > sourceCenterX - inlineDistance
    ) {
      moveTarget(
        source,
        target,
        (sourceCenterX - inlineDistance - target.width / 2 - target.x) *
          elasticity,
        0,
      );
    }
    if (directionY > 0 && targetCenterY < sourceCenterY + blockDistance) {
      moveTarget(
        source,
        target,
        0,
        (sourceCenterY + blockDistance - target.height / 2 - target.y) *
          elasticity,
      );
    } else if (
      directionY < 0 &&
      targetCenterY > sourceCenterY - blockDistance
    ) {
      moveTarget(
        source,
        target,
        0,
        (sourceCenterY - blockDistance - target.height / 2 - target.y) *
          elasticity,
      );
    }
  }
}

export function projectArchitectureGfxRelations(
  model: MermaidArchitectureModel,
  nodes: readonly MermaidVisualNode[],
) {
  const groupByMember = new Map<string, string>();
  for (const service of model.services) {
    if (service.groupId) groupByMember.set(service.id, service.groupId);
  }
  for (const junction of model.junctions) {
    if (junction.groupId) groupByMember.set(junction.id, junction.groupId);
  }
  const nodesById = mermaidVisualNodeIndex(nodes);
  return model.edges.map((edge) =>
    semanticMermaidEdge(
      {
        familyData: architectureEdgeFamilyData({
          fromArrow: edge.fromArrow,
          fromGroup: edge.fromGroup,
          fromPort: edge.fromPort,
          sourceId: edge.id,
          toArrow: edge.toArrow,
          toGroup: edge.toGroup,
          toPort: edge.toPort,
        }),
        id: edge.id,
        label: edge.label,
        linkType: architectureEdgeLinkType(edge),
        source: edge.from,
        sourceAttachment: edge.fromGroup
          ? groupByMember.get(edge.from)
          : undefined,
        sourcePortId: edge.fromPort,
        sourcePosition: architecturePortPosition(edge.fromPort),
        target: edge.to,
        targetAttachment: edge.toGroup ? groupByMember.get(edge.to) : undefined,
        targetPortId: edge.toPort,
        targetPosition: architecturePortPosition(edge.toPort),
      },
      nodesById,
    ),
  );
}

function architectureParallelRelations(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const endpoints = [edge.source, edge.target].sort().join("\u0000");
  return model.edges.filter(
    (candidate) =>
      [candidate.source, candidate.target].sort().join("\u0000") === endpoints,
  );
}

export function architectureGfxRelationLabelOffset(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  if (model.diagramType !== "architecture") return null;
  const siblings = architectureParallelRelations(model, edge);
  const index = siblings.findIndex((candidate) => candidate.id === edge.id);
  if (index < 0 || (siblings.length === 1 && edge.source !== edge.target)) {
    return null;
  }
  const spacing = resolveMermaidGfxTheme().typography.lineHeight;
  if (edge.source === edge.target) {
    return { x: spacing * (index + 1), y: -spacing * (index + 1) };
  }
  const centerOffset = index - (siblings.length - 1) / 2;
  const architecture = architectureEdgeGfxData(edge);
  const horizontal =
    architecture?.fromPort === "L" ||
    architecture?.fromPort === "R" ||
    architecture?.toPort === "L" ||
    architecture?.toPort === "R";
  return horizontal
    ? { x: 0, y: centerOffset * spacing }
    : { x: centerOffset * spacing, y: 0 };
}
