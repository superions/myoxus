// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
} from "../runtime/gfx-model.js";
import type { MermaidGfxNodeConnectionPort } from "../runtime/gfx-family-hooks-contract.js";
import {
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureEdgeLinkType,
  architectureGroupIdForVisualNode,
  architectureNodeGfxData,
  architecturePortPosition,
} from "./gfx-data.js";
import {
  mermaidVisualNodeIndex,
  semanticMermaidEdge,
} from "../gfx-visual-model-helpers.js";

export const architectureGfxAllowsSelfConnections = true;

export const ARCHITECTURE_GFX_CONNECTION_PORTS = [
  { id: "L", position: [0, 0.5] },
  { id: "R", position: [1, 0.5] },
  { id: "T", position: [0.5, 0] },
  { id: "B", position: [0.5, 1] },
] as const satisfies readonly MermaidGfxNodeConnectionPort[];

export function architectureGfxNodeConnectionPorts() {
  return ARCHITECTURE_GFX_CONNECTION_PORTS;
}

function architecturePortForPosition(
  position: MermaidVisualEdge["sourcePosition"],
  fallback: string,
) {
  if (position?.[0] === 0 && position[1] === 0.5) return "L";
  if (position?.[0] === 1 && position[1] === 0.5) return "R";
  if (position?.[0] === 0.5 && position[1] === 0) return "T";
  if (position?.[0] === 0.5 && position[1] === 1) return "B";
  return fallback;
}

export function projectArchitectureGfxVisualEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  patch: Readonly<{ familyData?: MermaidVisualEdge["familyData"] }>,
) {
  if (model.diagramType !== "architecture") return edge;
  const architecture = architectureEdgeGfxData(edge);
  if (!architecture) return edge;
  const explicitArchitecture = patch.familyData
    ? architectureEdgeGfxData({ familyData: patch.familyData })
    : undefined;
  const semantic = explicitArchitecture ?? architecture;
  const fromPort = explicitArchitecture
    ? semantic.fromPort
    : architecturePortForPosition(edge.sourcePosition, semantic.fromPort);
  const toPort = explicitArchitecture
    ? semantic.toPort
    : architecturePortForPosition(edge.targetPosition, semantic.toPort);
  const familyData = architectureEdgeFamilyData({
    ...semantic,
    fromPort,
    sourceId: semantic.sourceId || edge.id,
    toPort,
  });
  const sourceAttachment = semantic.fromGroup
    ? architectureGroupIdForVisualNode(model, edge.source) || undefined
    : undefined;
  const targetAttachment = semantic.toGroup
    ? architectureGroupIdForVisualNode(model, edge.target) || undefined
    : undefined;
  return {
    ...edge,
    familyData,
    linkType: architectureEdgeLinkType({
      fromArrow: semantic.fromArrow,
      toArrow: semantic.toArrow,
    }),
    sourceAttachment,
    sourcePortId: fromPort,
    sourcePosition: architecturePortPosition(fromPort),
    targetAttachment,
    targetPortId: toPort,
    targetPosition: architecturePortPosition(toPort),
  };
}

export function canConnectArchitectureGfxNodes(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
) {
  const source = model.nodes.find((node) => node.id === sourceId);
  const target = model.nodes.find((node) => node.id === targetId);
  return Boolean(
    source &&
    target &&
    architectureNodeGfxData(source) &&
    architectureNodeGfxData(target),
  );
}

export function createArchitectureGfxVisualEdge(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
): MermaidVisualEdge | null {
  if (!canConnectArchitectureGfxNodes(model, sourceId, targetId)) return null;
  let index = model.edges.length + 1;
  const edgeIds = new Set(model.edges.map((edge) => edge.id));
  while (edgeIds.has(`edge-${sourceId}-${targetId}-${index}`)) index += 1;
  const edgeId = `edge-${sourceId}-${targetId}-${index}`;
  const familyData = architectureEdgeFamilyData({ sourceId: edgeId });
  return semanticMermaidEdge(
    {
      familyData,
      id: edgeId,
      label: "",
      linkType: architectureEdgeLinkType({
        fromArrow: false,
        toArrow: true,
      }),
      source: sourceId,
      sourcePortId: "R",
      sourcePosition: architecturePortPosition("R"),
      style: "solid",
      target: targetId,
      targetPortId: "L",
      targetPosition: architecturePortPosition("L"),
    },
    mermaidVisualNodeIndex(model.nodes),
  );
}

export function reconnectArchitectureGfxVisualEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  endpoint: "source" | "target",
  nodeId: string,
): MermaidVisualEdge | null {
  const source = endpoint === "source" ? nodeId : edge.source;
  const target = endpoint === "target" ? nodeId : edge.target;
  if (!canConnectArchitectureGfxNodes(model, source, target)) return null;
  const architecture = architectureEdgeGfxData(edge);
  if (!architecture) return null;
  const sourceGroup = architectureGroupIdForVisualNode(model, source);
  const targetGroup = architectureGroupIdForVisualNode(model, target);
  const sameGroup = Boolean(sourceGroup && sourceGroup === targetGroup);
  return {
    ...edge,
    familyData: architectureEdgeFamilyData({
      ...architecture,
      fromGroup:
        endpoint === "source" || sameGroup ? false : architecture.fromGroup,
      toGroup:
        endpoint === "target" || sameGroup ? false : architecture.toGroup,
    }),
    source,
    sourceAttachment: endpoint === "source" ? undefined : edge.sourceAttachment,
    target,
    targetAttachment: endpoint === "target" ? undefined : edge.targetAttachment,
  };
}

/**
 * Reprojects Architecture endpoint attachments after a membership mutation.
 * Relations keep their identity and endpoints. A group marker is removed only
 * when its semantic carrier no longer exists or both endpoints now share that
 * carrier, because Mermaid cannot represent that group attachment there.
 */
export function reconcileArchitectureGfxRelationAttachments(
  model: MermaidVisualModel,
) {
  if (model.diagramType !== "architecture") return model;
  return {
    ...model,
    edges: model.edges.map((edge) => {
      const architecture = architectureEdgeGfxData(edge);
      if (!architecture) return edge;
      const sourceGroup = architectureGroupIdForVisualNode(model, edge.source);
      const targetGroup = architectureGroupIdForVisualNode(model, edge.target);
      const sameGroup = Boolean(sourceGroup && sourceGroup === targetGroup);
      const semantic = {
        ...architecture,
        fromGroup: Boolean(sourceGroup) && !sameGroup && architecture.fromGroup,
        toGroup: Boolean(targetGroup) && !sameGroup && architecture.toGroup,
      };
      return projectArchitectureGfxVisualEdge(
        model,
        { ...edge, familyData: architectureEdgeFamilyData(semantic) },
        { familyData: architectureEdgeFamilyData(semantic) },
      );
    }),
  };
}
