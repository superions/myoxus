// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { flowchartSubgraphDescendantIds } from "./gfx-operations.js";
import {
  measureMermaidGfxText,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxTheme,
} from "../../mermaid-gfx-theme.js";
import { flowchartSubgraphElementStyle } from "./gfx-style-projection.js";

function boundsOverlap(first: MermaidVisualNode, second: MermaidVisualNode) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function centerInside(
  node: MermaidVisualNode,
  subgraph: MermaidVisualSubgraph,
) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  return (
    centerX >= subgraph.x &&
    centerX <= subgraph.x + subgraph.width &&
    centerY >= subgraph.y &&
    centerY <= subgraph.y + subgraph.height
  );
}

function expandSubgraphAroundMember(
  node: MermaidVisualNode,
  subgraph: MermaidVisualSubgraph,
  padding: number,
  headerHeight: number,
) {
  subgraph.width = Math.max(subgraph.width, node.width + padding * 2);
  subgraph.height = Math.max(
    subgraph.height,
    node.height + headerHeight + padding,
  );
  const contentLeft = subgraph.x + padding;
  if (node.x < contentLeft) {
    const expansion = contentLeft - node.x;
    subgraph.x -= expansion;
    subgraph.width += expansion;
  }
  const contentRight = subgraph.x + subgraph.width - padding;
  if (node.x + node.width > contentRight) {
    subgraph.width += node.x + node.width - contentRight;
  }
  const contentTop = subgraph.y + headerHeight;
  if (node.y < contentTop) {
    const expansion = contentTop - node.y;
    subgraph.y -= expansion;
    subgraph.height += expansion;
  }
  const contentBottom = subgraph.y + subgraph.height - padding;
  if (node.y + node.height > contentBottom) {
    subgraph.height += node.y + node.height - contentBottom;
  }
}

function moveOutsideAnchorOverlap(
  node: MermaidVisualNode,
  sourceNode: MermaidVisualNode,
  anchor: MermaidVisualNode,
  sourceAnchor: MermaidVisualNode,
) {
  const sourceNodeCenterX = sourceNode.x + sourceNode.width / 2;
  const sourceNodeCenterY = sourceNode.y + sourceNode.height / 2;
  const sourceAnchorCenterX = sourceAnchor.x + sourceAnchor.width / 2;
  const sourceAnchorCenterY = sourceAnchor.y + sourceAnchor.height / 2;
  const sourceDx = sourceNodeCenterX - sourceAnchorCenterX;
  const sourceDy = sourceNodeCenterY - sourceAnchorCenterY;
  if (Math.abs(sourceDx) >= Math.abs(sourceDy)) {
    if (sourceDx >= 0) {
      const sourceGap =
        sourceNodeCenterX - (sourceAnchor.x + sourceAnchor.width);
      const centerX =
        anchor.x + anchor.width + Math.max(sourceGap, node.width / 2);
      node.x = centerX - node.width / 2;
    } else {
      const sourceGap = sourceAnchor.x - sourceNodeCenterX;
      const centerX = anchor.x - Math.max(sourceGap, node.width / 2);
      node.x = centerX - node.width / 2;
    }
    node.y = anchor.y + (sourceNode.y - sourceAnchor.y);
    return;
  }
  if (sourceDy >= 0) {
    const sourceGap =
      sourceNodeCenterY - (sourceAnchor.y + sourceAnchor.height);
    const centerY =
      anchor.y + anchor.height + Math.max(sourceGap, node.height / 2);
    node.y = centerY - node.height / 2;
  } else {
    const sourceGap = sourceAnchor.y - sourceNodeCenterY;
    const centerY = anchor.y - Math.max(sourceGap, node.height / 2);
    node.y = centerY - node.height / 2;
  }
  node.x = anchor.x + (sourceNode.x - sourceAnchor.x);
}

function moveOutsideSourceSubgraph(
  node: MermaidVisualNode,
  sourceNode: MermaidVisualNode,
  subgraph: MermaidVisualSubgraph,
  sourceSubgraph: MermaidVisualSubgraph,
) {
  let centerX = node.x + node.width / 2;
  let centerY = node.y + node.height / 2;
  const sourceCenterX = sourceNode.x + sourceNode.width / 2;
  const sourceCenterY = sourceNode.y + sourceNode.height / 2;
  const sourceRight = sourceSubgraph.x + sourceSubgraph.width;
  const sourceBottom = sourceSubgraph.y + sourceSubgraph.height;
  if (sourceCenterX < sourceSubgraph.x) {
    centerX = subgraph.x - (sourceSubgraph.x - sourceCenterX);
  } else if (sourceCenterX > sourceRight) {
    centerX = subgraph.x + subgraph.width + (sourceCenterX - sourceRight);
  }
  if (sourceCenterY < sourceSubgraph.y) {
    centerY = subgraph.y - (sourceSubgraph.y - sourceCenterY);
  } else if (sourceCenterY > sourceBottom) {
    centerY = subgraph.y + subgraph.height + (sourceCenterY - sourceBottom);
  }
  node.x = centerX - node.width / 2;
  node.y = centerY - node.height / 2;
  if (!centerInside(node, subgraph)) return;
  const sourceLeftDistance = Math.abs(sourceCenterX - sourceSubgraph.x);
  const sourceRightDistance = Math.abs(sourceCenterX - sourceRight);
  const sourceTopDistance = Math.abs(sourceCenterY - sourceSubgraph.y);
  const sourceBottomDistance = Math.abs(sourceCenterY - sourceBottom);
  const nearestHorizontal = Math.min(sourceLeftDistance, sourceRightDistance);
  const nearestVertical = Math.min(sourceTopDistance, sourceBottomDistance);
  if (nearestHorizontal <= nearestVertical) {
    const exitRight = sourceRightDistance <= sourceLeftDistance;
    node.x = exitRight ? subgraph.x + subgraph.width : subgraph.x - node.width;
    return;
  }
  const exitBottom = sourceBottomDistance <= sourceTopDistance;
  node.y = exitBottom ? subgraph.y + subgraph.height : subgraph.y - node.height;
}

function separateEdgeNodeOverlaps(
  model: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  const sourceNodesById = new Map(
    sourceModel.nodes.map((node) => [node.id, node]),
  );
  for (const edge of model.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const sourceSource = sourceNodesById.get(edge.source);
    const sourceTarget = sourceNodesById.get(edge.target);
    if (!source || !target || !sourceSource || !sourceTarget) continue;
    if (!boundsOverlap(source, target)) continue;
    moveOutsideAnchorOverlap(target, sourceTarget, source, sourceSource);
  }
}

function alignEdgeDirections(
  model: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  const sourceNodesById = new Map(
    sourceModel.nodes.map((node) => [node.id, node]),
  );
  for (const edge of model.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const sourceSource = sourceNodesById.get(edge.source);
    const sourceTarget = sourceNodesById.get(edge.target);
    if (!source || !target || !sourceSource || !sourceTarget) continue;
    const sourceMovesRight = sourceTarget.x > sourceSource.x;
    const sourceMovesLeft =
      sourceTarget.x + sourceTarget.width < sourceSource.x + sourceSource.width;
    const sourceMovesDown = sourceTarget.y > sourceSource.y;
    const sourceMovesUp =
      sourceTarget.y + sourceTarget.height <
      sourceSource.y + sourceSource.height;
    const violatesHorizontal =
      (sourceModel.direction === "LR" &&
        sourceMovesRight &&
        target.x < source.x + source.width) ||
      (sourceModel.direction === "RL" &&
        sourceMovesLeft &&
        target.x + target.width > source.x);
    const violatesVertical =
      ((sourceModel.direction === "TD" || sourceModel.direction === "TB") &&
        sourceMovesDown &&
        target.y < source.y + source.height) ||
      (sourceModel.direction === "BT" &&
        sourceMovesUp &&
        target.y + target.height > source.y);
    if (!violatesHorizontal && !violatesVertical) continue;
    moveOutsideAnchorOverlap(target, sourceTarget, source, sourceSource);
  }
}

function separateNodeOverlaps(
  model: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  for (
    let anchorIndex = 0;
    anchorIndex < sourceModel.nodes.length;
    anchorIndex++
  ) {
    const sourceAnchor = sourceModel.nodes[anchorIndex];
    const anchor = nodesById.get(sourceAnchor.id);
    if (!anchor) continue;
    for (
      let nodeIndex = anchorIndex + 1;
      nodeIndex < sourceModel.nodes.length;
      nodeIndex++
    ) {
      const sourceNode = sourceModel.nodes[nodeIndex];
      const node = nodesById.get(sourceNode.id);
      if (!node || !boundsOverlap(anchor, node)) continue;
      moveOutsideAnchorOverlap(node, sourceNode, anchor, sourceAnchor);
    }
  }
}

/**
 * Reconciles only Flowchart's source-layout invariants after native geometry
 * was preserved. Other Mermaid families must not inherit these graph rules.
 */
export function reconcileFlowchartProjectionOwnerGeometry(
  model: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  separateEdgeNodeOverlaps(model, sourceModel);
  alignEdgeDirections(model, sourceModel);
  separateNodeOverlaps(model, sourceModel);

  const sourceNodesById = new Map(
    sourceModel.nodes.map((node) => [node.id, node]),
  );
  const sourceSubgraphsById = new Map(
    (sourceModel.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  const padding = resolveMermaidGfxTheme().typography.lineHeight;
  for (const subgraph of model.subgraphs ?? []) {
    const sourceSubgraph = sourceSubgraphsById.get(subgraph.id);
    if (!sourceSubgraph) continue;
    const typography = mermaidGfxTypographyForNode(
      flowchartSubgraphElementStyle(sourceModel, sourceSubgraph),
    );
    const headerHeight =
      measureMermaidGfxText(
        sourceSubgraph.displayLabel ?? sourceSubgraph.title,
        typography,
      ).height + padding;
    const descendants = flowchartSubgraphDescendantIds(
      sourceModel,
      subgraph.id,
    );
    // Nested members belong inside every ancestor. Treating them as outside
    // nodes repeatedly ejects them and then expands their own group over siblings.
    const sourceMemberIds = new Set([
      ...sourceSubgraph.nodeIds,
      ...(sourceModel.subgraphs ?? [])
        .filter((group) => descendants.has(group.id))
        .flatMap((group) => group.nodeIds),
    ]);
    for (const nodeId of sourceSubgraph.nodeIds) {
      const node = model.nodes.find((candidate) => candidate.id === nodeId);
      const sourceNode = sourceNodesById.get(nodeId);
      if (!node || !sourceNode) continue;
      if (!centerInside(node, subgraph)) {
        node.x = subgraph.x + (sourceNode.x - sourceSubgraph.x);
        node.y = subgraph.y + (sourceNode.y - sourceSubgraph.y);
      }
      expandSubgraphAroundMember(node, subgraph, padding, headerHeight);
    }
    for (const node of model.nodes) {
      if (sourceMemberIds.has(node.id)) continue;
      const sourceNode = sourceNodesById.get(node.id);
      if (!sourceNode || !centerInside(node, subgraph)) continue;
      // Keep explicit source membership authoritative when a resized group
      // would otherwise swallow an outside node.
      moveOutsideSourceSubgraph(node, sourceNode, subgraph, sourceSubgraph);
    }
  }
  return model;
}
