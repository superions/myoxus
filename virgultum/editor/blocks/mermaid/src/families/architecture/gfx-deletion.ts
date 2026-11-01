// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureModelFamilyData,
  architectureModelGfxData,
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import { fitArchitectureOwnerGroupsToDirectChildren } from "./owner-bounds.js";

export function deleteArchitectureGfxVisualSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  if (
    model.diagramType !== "architecture" ||
    !model.subgraphs?.some((subgraph) => subgraph.id === subgraphId)
  ) {
    return null;
  }
  const deletedSubgraph = model.subgraphs.find(
    (subgraph) => subgraph.id === subgraphId,
  )!;
  const deletedSourceId =
    architectureSubgraphGfxData(deletedSubgraph)?.sourceId || subgraphId;
  const replacementParentId =
    architectureSubgraphGfxData(deletedSubgraph)?.parentId ?? "";
  const groupAfterDeletion = (nodeId: string) => {
    const groupId = architectureNodeGfxData(
      model.nodes.find((node) => node.id === nodeId) ?? {
        familyData: undefined,
      },
    )?.groupId;
    return groupId === subgraphId ? replacementParentId : (groupId ?? "");
  };
  const next: MermaidVisualModel = {
    ...model,
    edges: model.edges.map((edge) => {
      const architecture = architectureEdgeGfxData(edge);
      const sourceGroupId = groupAfterDeletion(edge.source);
      const targetGroupId = groupAfterDeletion(edge.target);
      const fromGroup = Boolean(
        architecture?.fromGroup &&
        !(sourceGroupId && sourceGroupId === targetGroupId),
      );
      const toGroup = Boolean(
        architecture?.toGroup &&
        !(targetGroupId && targetGroupId === sourceGroupId),
      );
      return {
        ...edge,
        familyData: architecture
          ? architectureEdgeFamilyData({
              ...architecture,
              fromGroup,
              toGroup,
            })
          : edge.familyData,
        sourceAttachment: fromGroup ? sourceGroupId : undefined,
        targetAttachment: toGroup ? targetGroupId : undefined,
      };
    }),
    nodes: model.nodes.map((node) => ({
      ...node,
      familyData: node.familyData ? { ...node.familyData } : undefined,
    })),
    subgraphs: model.subgraphs
      .filter((subgraph) => subgraph.id !== subgraphId)
      .map((subgraph) => ({
        ...subgraph,
        familyData: subgraph.familyData
          ? { ...subgraph.familyData }
          : undefined,
        nodeIds: [...subgraph.nodeIds],
      })),
  };
  next.nodes = next.nodes.map((node) => {
    const architecture = architectureNodeGfxData(node);
    return architecture
      ? {
          ...node,
          familyData: architectureNodeFamilyData({
            ...architecture,
            groupId:
              architecture.groupId === subgraphId
                ? replacementParentId
                : architecture.groupId,
          }),
        }
      : node;
  });
  next.subgraphs = next.subgraphs?.map((subgraph) => {
    const architecture = architectureSubgraphGfxData(subgraph);
    return architecture
      ? {
          ...subgraph,
          familyData: architectureSubgraphFamilyData({
            ...architecture,
            parentId:
              architecture.parentId === subgraphId
                ? replacementParentId
                : architecture.parentId,
          }),
        }
      : subgraph;
  });
  const projected = architectureModelGfxData(model);
  return fitArchitectureOwnerGroupsToDirectChildren({
    ...next,
    familyData: projected
      ? architectureModelFamilyData(
          projected.alignments,
          projected.comments?.filter(
            (comment) =>
              comment.anchorKind !== "group" ||
              (comment.anchorId !== subgraphId &&
                comment.anchorId !== deletedSourceId),
          ),
          {
            config: projected.config,
            directives: projected.directives,
          },
        )
      : next.familyData,
  });
}

export function deleteArchitectureGfxVisualSelection(
  model: MermaidVisualModel,
  selection: {
    readonly edgeId?: string;
    readonly edgeIds?: readonly string[];
    readonly nodeId?: string;
    readonly nodeIds?: readonly string[];
    readonly subgraphId?: string;
    readonly subgraphIds?: readonly string[];
  },
) {
  if (model.diagramType !== "architecture") return null;
  let next = model;
  let changed = false;
  const selectedSubgraphIds = new Set([
    ...(selection.subgraphIds ?? []),
    ...(selection.subgraphId ? [selection.subgraphId] : []),
  ]);
  for (const subgraphId of selectedSubgraphIds) {
    const deleted = deleteArchitectureGfxVisualSubgraph(next, subgraphId);
    if (!deleted) continue;
    next = deleted;
    changed = true;
  }
  const selectedEdgeIds = new Set([
    ...(selection.edgeIds ?? []),
    ...(selection.edgeId ? [selection.edgeId] : []),
  ]);
  const selectedNodeIds = new Set([
    ...(selection.nodeIds ?? []),
    ...(selection.nodeId ? [selection.nodeId] : []),
  ]);
  const selectedNodeSourceIds = new Set(
    next.nodes.flatMap((node) =>
      selectedNodeIds.has(node.id)
        ? [node.id, architectureNodeGfxData(node)?.sourceId].filter(
            (id): id is string => Boolean(id),
          )
        : [],
    ),
  );
  const hasSelectedEdge = next.edges.some((edge) =>
    selectedEdgeIds.has(edge.id),
  );
  const hasSelectedNode = next.nodes.some((node) =>
    selectedNodeIds.has(node.id),
  );
  if (!changed && !hasSelectedEdge && !hasSelectedNode) {
    return null;
  }
  if (!hasSelectedEdge && !hasSelectedNode) return next;
  const removedEdges = next.edges.filter(
    (edge) =>
      selectedEdgeIds.has(edge.id) ||
      selectedNodeIds.has(edge.source) ||
      selectedNodeIds.has(edge.target),
  );
  const removedEdgeSourceIds = new Set(
    removedEdges.flatMap((edge) =>
      [edge.id, architectureEdgeGfxData(edge)?.sourceId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
  const nodes = next.nodes.filter((node) => !selectedNodeIds.has(node.id));
  const edges = next.edges.filter(
    (edge) => !removedEdges.some((removed) => removed.id === edge.id),
  );
  const projected = architectureModelGfxData(next);
  const projectedAlignments = projected?.alignments ?? [];
  const alignments = projectedAlignments
    .map((alignment) => ({
      ...alignment,
      members: alignment.members.filter(
        (member) => !selectedNodeIds.has(member),
      ),
    }))
    .filter((alignment) => alignment.members.length >= 2);
  const retainedAlignmentIds = new Set(
    alignments.map((alignment) => alignment.id),
  );
  const removedAlignmentIds = new Set(
    projectedAlignments
      .filter((alignment) => !retainedAlignmentIds.has(alignment.id))
      .map((alignment) => alignment.id),
  );
  const comments = projected?.comments?.filter((comment) => {
    if (
      comment.anchorKind === "alignment" &&
      comment.anchorId &&
      removedAlignmentIds.has(comment.anchorId)
    ) {
      return false;
    }
    if (
      comment.anchorKind === "edge" &&
      comment.anchorId &&
      removedEdgeSourceIds.has(comment.anchorId)
    ) {
      return false;
    }
    return !comment.anchorId || !selectedNodeSourceIds.has(comment.anchorId);
  });
  return fitArchitectureOwnerGroupsToDirectChildren({
    ...next,
    edges,
    familyData: projected
      ? architectureModelFamilyData(alignments, comments, {
          config: projected.config,
          directives: projected.directives,
        })
      : next.familyData,
    nodes,
    subgraphs: next.subgraphs?.map((subgraph) => ({
      ...subgraph,
      nodeIds: subgraph.nodeIds.filter(
        (nodeId) => !selectedNodeIds.has(nodeId),
      ),
    })),
  });
}
