// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { mermaidGfxLayoutMetrics } from "../../mermaid-gfx-theme.js";
import { resolveMermaidArchitectureConfig } from "../../engine/architecture/index.js";
import { fitArchitectureOwnerGroupsToDirectChildren } from "./owner-bounds.js";
import {
  architectureModelFamilyData,
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import { architectureConfiguredTypography } from "./layout/measurement.js";

function applyArchitectureAlignmentGeometry(
  model: MermaidVisualModel,
  members: readonly string[],
  direction: "column" | "row",
) {
  const nodes = model.nodes.map((node) => ({ ...node }));
  const subgraphs = (model.subgraphs ?? []).map((subgraph) => ({
    ...subgraph,
    nodeIds: [...subgraph.nodeIds],
  }));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const subgraphsById = new Map(
    subgraphs.map((subgraph) => [subgraph.id, subgraph]),
  );
  const groupIsInSubtree = (groupId: string, parentId: string) => {
    let currentId = groupId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      if (currentId === parentId) return true;
      visited.add(currentId);
      const current = subgraphsById.get(currentId);
      if (!current) break;
      currentId = architectureSubgraphGfxData(current)?.parentId ?? "";
    }
    return false;
  };
  const directGroupIdForNode = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    return node ? (architectureNodeGfxData(node)?.groupId ?? "") : "";
  };
  const alignedMemberGroupIds = members.map(directGroupIdForNode);
  const carrierGroupIdForNode = (nodeId: string) => {
    const groupId = directGroupIdForNode(nodeId);
    if (!groupId) return "";
    const alignedMembersInSubtree = alignedMemberGroupIds.filter(
      (memberGroupId) => groupIsInSubtree(memberGroupId, groupId),
    ).length;
    return alignedMembersInSubtree === 1 ? groupId : "";
  };
  const translateGroup = (groupId: string, deltaX: number, deltaY: number) => {
    for (const subgraph of subgraphs) {
      if (!groupIsInSubtree(subgraph.id, groupId)) continue;
      subgraph.x += deltaX;
      subgraph.y += deltaY;
    }
    for (const node of nodes) {
      const nodeGroupId = directGroupIdForNode(node.id);
      if (!nodeGroupId || !groupIsInSubtree(nodeGroupId, groupId)) continue;
      node.x += deltaX;
      node.y += deltaY;
    }
  };
  const carrierForNode = (nodeId: string) => {
    const node = nodesById.get(nodeId)!;
    const groupId = carrierGroupIdForNode(nodeId);
    const group = groupId ? subgraphsById.get(groupId) : undefined;
    return group
      ? {
          bottom: group.y + group.height,
          id: `group:${group.id}`,
          left: group.x,
          right: group.x + group.width,
          top: group.y,
        }
      : {
          bottom: node.y + node.height,
          id: `node:${node.id}`,
          left: node.x,
          right: node.x + node.width,
          top: node.y,
        };
  };
  const translateMember = (
    nodeId: string,
    deltaX: number,
    deltaY: number,
    moveCarrier: boolean,
  ) => {
    const groupId = carrierGroupIdForNode(nodeId);
    if (moveCarrier && groupId) translateGroup(groupId, deltaX, deltaY);
    else {
      const node = nodesById.get(nodeId)!;
      node.x += deltaX;
      node.y += deltaY;
    }
  };
  const metrics = mermaidGfxLayoutMetrics(
    architectureConfiguredTypography(
      resolveMermaidArchitectureConfig(
        architectureModelGfxData(model)?.config ?? {},
      ),
    ),
  );
  const first = nodesById.get(members[0]);
  if (!first) return model;
  const anchorCenterX = first.x + first.width / 2;
  const anchorCenterY = first.y + first.height / 2;
  const positionedCarriers = new Set([carrierForNode(first.id).id]);
  let previous = first;
  for (const memberId of members.slice(1)) {
    const member = nodesById.get(memberId);
    if (!member) continue;
    const previousCarrier = carrierForNode(previous.id);
    const memberCarrier = carrierForNode(member.id);
    const moveCarrier = !positionedCarriers.has(memberCarrier.id);
    if (direction === "row") {
      const nodeDeltaX =
        previous.x + previous.width + metrics.inlineGap - member.x;
      const carrierDeltaX =
        previousCarrier.right + metrics.inlineGap - memberCarrier.left;
      translateMember(
        member.id,
        moveCarrier ? Math.max(nodeDeltaX, carrierDeltaX) : nodeDeltaX,
        anchorCenterY - member.height / 2 - member.y,
        moveCarrier,
      );
    } else {
      const nodeDeltaY =
        previous.y + previous.height + metrics.blockGap - member.y;
      const carrierDeltaY =
        previousCarrier.bottom + metrics.blockGap - memberCarrier.top;
      translateMember(
        member.id,
        anchorCenterX - member.width / 2 - member.x,
        moveCarrier ? Math.max(nodeDeltaY, carrierDeltaY) : nodeDeltaY,
        moveCarrier,
      );
    }
    positionedCarriers.add(memberCarrier.id);
    previous = member;
  }
  return fitArchitectureOwnerGroupsToDirectChildren({
    ...model,
    nodes,
    subgraphs,
  });
}

export function alignArchitectureGfxNodes(
  model: MermaidVisualModel,
  members: readonly string[],
  direction: "column" | "row",
) {
  if (model.diagramType !== "architecture") return null;
  const nodeIds = new Set(model.nodes.map((node) => node.id));
  const uniqueMembers = [...new Set(members)].filter((id) => nodeIds.has(id));
  if (uniqueMembers.length < 2) return null;
  const current = architectureModelGfxData(model);
  const alignments = [...(current?.alignments ?? [])].map((alignment) => ({
    ...alignment,
    members: [...alignment.members],
  }));
  const existing = alignments.find(
    (alignment) =>
      alignment.members.length === uniqueMembers.length &&
      alignment.members.every(
        (member, index) => member === uniqueMembers[index],
      ),
  );
  if (existing) existing.direction = direction;
  else {
    const ids = new Set(alignments.map((alignment) => alignment.id));
    let index = alignments.length + 1;
    while (ids.has(`alignment-edit-${index}`)) index += 1;
    alignments.push({
      direction,
      id: `alignment-edit-${index}`,
      members: uniqueMembers,
      order: alignments.length,
    });
  }
  const aligned = applyArchitectureAlignmentGeometry(
    model,
    uniqueMembers,
    direction,
  );
  return {
    ...aligned,
    familyData: architectureModelFamilyData(alignments, current?.comments, {
      config: current?.config,
      directives: current?.directives,
    }),
  };
}
