// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxProjectionOwnerSemanticStyles } from "../runtime/gfx-family-hooks-contract.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeStyleClass,
} from "./model-operations.js";
import { readFlowchartEdgeSemanticStyle } from "./gfx-style-projection.js";

function reconcileRetainedFlowchartStyles(
  model: MermaidVisualModel,
  previousModel: MermaidVisualModel | null | undefined,
) {
  const edgeIndexById = new Map(
    model.edges.map((edge, index) => [edge.id, index] as const),
  );
  const endpointIds = new Set([
    ...model.nodes.map((node) => node.id),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
    ...model.edges.flatMap((edge) => (edge.mermaidId ? [edge.mermaidId] : [])),
  ]);
  return (previousModel?.styleStatements ?? []).flatMap((statement) => {
    const linkStyle = statement.match(/^(linkStyle\s+)([0-9,\s]+)(\s+.+)$/i);
    if (linkStyle?.[1] && linkStyle[2] && linkStyle[3]) {
      const previousIndices = linkStyle[2]
        .split(",")
        .map((value) => Number(value.trim()));
      const nextIndices = linkStyle[2]
        .split(",")
        .map((value) => Number(value.trim()))
        .flatMap((previousIndex) => {
          const edgeId = previousModel?.edges[previousIndex]?.id;
          const nextIndex = edgeId ? edgeIndexById.get(edgeId) : undefined;
          return nextIndex === undefined ? [] : [nextIndex];
        });
      return nextIndices.length === previousIndices.length &&
        nextIndices.every((value, index) => value === previousIndices[index])
        ? [statement]
        : nextIndices.length
          ? [
              `${linkStyle[1]}${[...new Set(nextIndices)].join(",")}${linkStyle[3]}`,
            ]
          : [];
    }

    const style = statement.match(/^(style\s+)([A-Za-z0-9_][\w-]*)(\s+.+)$/i);
    if (style?.[2] && !endpointIds.has(style[2])) return [];
    const classStatement = statement.match(
      /^(class\s+)([A-Za-z0-9_,\s-]+?)(\s+[A-Za-z0-9_-]+\s*;?)$/i,
    );
    if (!classStatement?.[1] || !classStatement[2] || !classStatement[3]) {
      return [statement];
    }
    const ids = classStatement[2]
      .split(",")
      .map((id) => id.trim())
      .filter((id) => endpointIds.has(id));
    const previousIds = classStatement[2].split(",").map((id) => id.trim());
    return ids.length === previousIds.length
      ? [statement]
      : ids.length
        ? [`${classStatement[1]}${ids.join(",")}${classStatement[3]}`]
        : [];
  });
}

export function finalizeFlowchartProjectionOwnerReadback(
  model: MermaidVisualModel,
  previousModel: MermaidVisualModel | null | undefined,
  semanticStyles: MermaidGfxProjectionOwnerSemanticStyles,
) {
  const previousSubgraphs = new Map(
    (previousModel?.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  let next: MermaidVisualModel = {
    ...model,
    subgraphs: (model.subgraphs ?? []).map((subgraph) => ({
      ...subgraph,
      parentId: previousSubgraphs.get(subgraph.id)?.parentId,
    })),
    styleStatements: reconcileRetainedFlowchartStyles(model, previousModel),
  };
  const previouslyStyledNodeIds = new Set<string>();
  const previouslyStyledEdgeIds = new Set<string>();
  const desiredNodeStyles = new Map(
    semanticStyles.nodes.map(({ nodeId, styleName }) => [nodeId, styleName]),
  );
  const desiredEdgeStyles = new Map(
    semanticStyles.edges.flatMap(({ edgeIndex, styleName }) => {
      const edgeId = next.edges[edgeIndex]?.id;
      return edgeId ? [[edgeId, styleName] as const] : [];
    }),
  );
  for (const statement of previousModel?.styleStatements ?? []) {
    const classStatement =
      /^class\s+([A-Za-z0-9_,\s-]+?)\s+(neutral|accent|success|processing|warning|error)\s*;?$/i.exec(
        statement,
      );
    for (const nodeId of classStatement?.[1]?.split(",") ?? []) {
      previouslyStyledNodeIds.add(nodeId.trim());
    }
  }
  if (previousModel) {
    for (const edge of previousModel.edges) {
      if (readFlowchartEdgeSemanticStyle(previousModel, edge)) {
        previouslyStyledEdgeIds.add(edge.id);
      }
    }
  }
  for (const nodeId of previouslyStyledNodeIds) {
    if (!desiredNodeStyles.has(nodeId)) {
      next = setMermaidVisualNodeStyleClass(next, nodeId, "");
    }
  }
  for (const edgeId of previouslyStyledEdgeIds) {
    if (!desiredEdgeStyles.has(edgeId)) {
      next = setMermaidVisualEdgeStyleStatement(next, edgeId, "");
    }
  }
  for (const [nodeId, styleName] of desiredNodeStyles) {
    next = setMermaidVisualNodeStyleClass(next, nodeId, styleName);
  }
  for (const [edgeId, styleName] of desiredEdgeStyles) {
    next = setMermaidVisualEdgeStyleStatement(next, edgeId, styleName);
  }
  return next;
}
