// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import { generateMermaidCommonMetadataLines } from "./common-metadata.js";
import {
  flowchartEdgeLabelSource,
  flowchartEdgeTokenSource,
  flowchartNodeSource,
  flowchartSubgraphSource,
} from "./flowchart.js";
import {
  flowchartModelData,
  type MermaidFlowchartComment,
} from "./flowchart-model.js";

function flowchartModelSyntax(
  model: Pick<MermaidVisualModel, "diagramType" | "familyData">,
) {
  return flowchartModelData(model).syntax;
}

function findFlowchartNode(model: MermaidVisualModel, id: string) {
  return model.nodes.find((node) => node.id === id) ?? null;
}

function hasFlowchartSubgraph(model: MermaidVisualModel, id: string) {
  return (model.subgraphs ?? []).some((subgraph) => subgraph.id === id);
}

function endpointSource(
  model: MermaidVisualModel,
  endpointId: string,
  emittedNodeIds: Set<string>,
) {
  const node = findFlowchartNode(model, endpointId);
  if (node) {
    return emittedNodeIds.has(node.id) ? node.id : flowchartNodeSource(node);
  }
  return hasFlowchartSubgraph(model, endpointId) ? endpointId : "";
}

export function generateMermaidSourceFromVisualModel(
  model: MermaidVisualModel,
) {
  const header =
    flowchartModelSyntax(model) ??
    (model.diagramType === "flowchart-elk" ? "flowchart-elk" : "flowchart");
  const lines = [
    ...(model.sourcePreamble ?? []),
    `${header} ${model.direction}`,
    ...generateMermaidCommonMetadataLines({
      accessibilityDescription: model.accessibilityDescription ?? "",
      accessibilityTitle: model.accessibilityTitle ?? "",
      // Mermaid flowcharts do not own a body-level `title` statement. The
      // shared title projection keeps this value in frontmatter instead;
      // emitting it here makes otherwise valid visual mutations source-only.
      diagramTitle: "",
    }),
    ...(model.sourceAnnotations ?? []),
  ];
  const connectedNodeIds = new Set<string>();
  const emittedEdgeIds = new Set<string>();
  const emittedNodeIds = new Set<string>();
  const emittedCommentIds = new Set<string>();
  const comments = flowchartModelData(model).comments;
  const emitComments = (
    anchorKind: MermaidFlowchartComment["anchorKind"],
    anchorId: string | undefined,
    indent = "  ",
  ) => {
    for (const comment of comments) {
      if (
        emittedCommentIds.has(comment.id) ||
        comment.anchorKind !== anchorKind ||
        comment.anchorId !== anchorId
      ) {
        continue;
      }
      lines.push(`${indent}${comment.line}`);
      emittedCommentIds.add(comment.id);
    }
  };
  const subgraphByNodeId = new Map<string, string>();
  for (const subgraph of model.subgraphs ?? []) {
    for (const nodeId of subgraph.nodeIds) {
      subgraphByNodeId.set(nodeId, subgraph.id);
    }
  }

  const subgraphsByParentId = new Map<
    string | undefined,
    NonNullable<MermaidVisualModel["subgraphs"]>
  >();
  for (const subgraph of model.subgraphs ?? []) {
    const siblings = subgraphsByParentId.get(subgraph.parentId) ?? [];
    siblings.push(subgraph);
    subgraphsByParentId.set(subgraph.parentId, siblings);
  }
  const emitSubgraph = (
    subgraph: NonNullable<MermaidVisualModel["subgraphs"]>[number],
    depth: number,
  ) => {
    const indent = "  ".repeat(depth);
    emitComments("subgraph", subgraph.id, indent);
    lines.push(`${indent}subgraph ${flowchartSubgraphSource(subgraph)}`);
    if (subgraph.direction && subgraph.direction !== model.direction) {
      lines.push(`${indent}  direction ${subgraph.direction}`);
    }
    const memberIds = new Set(subgraph.nodeIds);
    const internalEdges = model.edges.filter(
      (edge) => memberIds.has(edge.source) && memberIds.has(edge.target),
    );
    for (const edge of internalEdges) {
      const source = findFlowchartNode(model, edge.source);
      const target = findFlowchartNode(model, edge.target);
      if (!source || !target) continue;
      connectedNodeIds.add(source.id);
      connectedNodeIds.add(target.id);
      emittedNodeIds.add(source.id);
      emittedNodeIds.add(target.id);
      emittedEdgeIds.add(edge.id);
      emitComments("node", source.id, `${indent}  `);
      emitComments("node", target.id, `${indent}  `);
      emitComments("edge", edge.id, `${indent}  `);
      const label = edge.label
        ? `|${flowchartEdgeLabelSource(edge.label)}| `
        : "";
      lines.push(
        `${indent}  ${flowchartNodeSource(source)} ${flowchartEdgeTokenSource(edge)} ${label}${flowchartNodeSource(target)}`,
      );
    }
    for (const node of model.nodes) {
      if (
        memberIds.has(node.id) &&
        !connectedNodeIds.has(node.id) &&
        !emittedNodeIds.has(node.id)
      ) {
        emittedNodeIds.add(node.id);
        emitComments("node", node.id, `${indent}  `);
        lines.push(`${indent}  ${flowchartNodeSource(node)}`);
      }
    }
    for (const child of subgraphsByParentId.get(subgraph.id) ?? []) {
      emitSubgraph(child, depth + 1);
    }
    lines.push(`${indent}end`);
  };
  for (const subgraph of subgraphsByParentId.get(undefined) ?? []) {
    emitSubgraph(subgraph, 1);
  }

  for (const edge of model.edges) {
    if (emittedEdgeIds.has(edge.id)) continue;
    const source = endpointSource(model, edge.source, emittedNodeIds);
    const target = endpointSource(model, edge.target, emittedNodeIds);
    if (!source || !target) continue;
    const sourceNode = findFlowchartNode(model, edge.source);
    const targetNode = findFlowchartNode(model, edge.target);
    if (sourceNode) connectedNodeIds.add(sourceNode.id);
    if (targetNode) connectedNodeIds.add(targetNode.id);
    if (sourceNode) emitComments("node", sourceNode.id);
    if (targetNode) emitComments("node", targetNode.id);
    emitComments("edge", edge.id);
    const label = edge.label
      ? `|${flowchartEdgeLabelSource(edge.label)}| `
      : "";
    lines.push(
      `  ${source} ${flowchartEdgeTokenSource(edge)} ${label}${target}`,
    );
    if (sourceNode) emittedNodeIds.add(sourceNode.id);
    if (targetNode) emittedNodeIds.add(targetNode.id);
  }
  for (const node of model.nodes) {
    if (
      !connectedNodeIds.has(node.id) &&
      !emittedNodeIds.has(node.id) &&
      !subgraphByNodeId.has(node.id)
    ) {
      emitComments("node", node.id);
      lines.push(`  ${flowchartNodeSource(node)}`);
    }
  }
  for (const comment of comments) {
    if (
      comment.anchorKind !== "diagram" &&
      !emittedCommentIds.has(comment.id)
    ) {
      lines.push(`  ${comment.line}`);
    }
  }
  for (const statement of model.styleStatements ?? []) {
    lines.push(`  ${statement}`);
  }
  emitComments("diagram", undefined);
  return `${lines.join("\n")}\n`;
}
