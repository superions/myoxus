// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../families/runtime/gfx-model.js";
import { mermaidGraphLayers } from "../families/runtime/graph-layout.js";
import type { PendingFlowchartSubgraph } from "./flowchart-model.js";

const FLOWCHART_LAYOUT = {
  emphasizedNodeHeight: 108,
  estimatedGlyphWidth: 7,
  horizontalLayerGap: 300,
  horizontalNodeGap: 80,
  horizontalSubgraphBandGap: 320,
  horizontalWrapLimit: 560,
  maxNodeWidth: 300,
  minNodeWidth: 160,
  nodeHeight: 88,
  nodeTextInset: 104,
  primaryAxisOrigin: 96,
  verticalLayerGap: 190,
  verticalNodeGap: 88,
  verticalSubgraphBandGap: 260,
  verticalWrapLimit: 760,
} as const;

export function layoutFlowchartNodes(
  nodes: Array<Omit<MermaidVisualNode, "height" | "width" | "x" | "y">>,
  edges: readonly MermaidVisualEdge[],
  direction: MermaidVisualModel["direction"],
  measured?: {
    sizes: ReadonlyMap<string, Pick<MermaidVisualNode, "height" | "width">>;
    nodeGap: number;
    layerGap: number;
  },
): MermaidVisualNode[] {
  const horizontal = direction === "LR" || direction === "RL";
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const sortedBySourceOrder = (ids: string[]) =>
    ids.sort((a, b) => (nodeOrder.get(a) ?? 0) - (nodeOrder.get(b) ?? 0));
  const layer = mermaidGraphLayers(nodes, edges, { preferReachedNodes: true });
  const nodeSize = new Map<
    string,
    Pick<MermaidVisualNode, "height" | "width">
  >();

  for (const node of nodes) {
    const measuredSize = measured?.sizes.get(node.id);
    if (measuredSize) {
      nodeSize.set(node.id, measuredSize);
      continue;
    }
    nodeSize.set(node.id, {
      height:
        node.shape === "diamond" ||
        node.shape === "diam" ||
        node.shape === "hexagon" ||
        node.shape === "circle" ||
        node.shape === "doublecircle" ||
        node.shape === "f-circ" ||
        node.shape === "fr-circ" ||
        node.shape === "sm-circ"
          ? FLOWCHART_LAYOUT.emphasizedNodeHeight
          : FLOWCHART_LAYOUT.nodeHeight,
      width: Math.max(
        FLOWCHART_LAYOUT.minNodeWidth,
        Math.min(
          FLOWCHART_LAYOUT.maxNodeWidth,
          FLOWCHART_LAYOUT.nodeTextInset +
            node.label.length * FLOWCHART_LAYOUT.estimatedGlyphWidth,
        ),
      ),
    });
  }

  const maxLayer = Math.max(0, ...nodes.map((node) => layer.get(node.id) ?? 0));
  const rows = new Map<number, string[]>();
  for (const node of nodes) {
    const logicalLayer = layer.get(node.id) ?? 0;
    const physicalLayer =
      direction === "BT" || direction === "RL"
        ? maxLayer - logicalLayer
        : logicalLayer;
    rows.set(physicalLayer, [...(rows.get(physicalLayer) ?? []), node.id]);
  }
  for (const [row, ids] of rows) {
    rows.set(row, sortedBySourceOrder(ids));
  }

  const nodeGap =
    measured?.nodeGap ??
    (horizontal
      ? FLOWCHART_LAYOUT.horizontalNodeGap
      : FLOWCHART_LAYOUT.verticalNodeGap);
  const layerGap = horizontal
    ? FLOWCHART_LAYOUT.horizontalLayerGap
    : FLOWCHART_LAYOUT.verticalLayerGap;
  const crossAxisSize = (id: string) => {
    const size = nodeSize.get(id) ?? {
      height: FLOWCHART_LAYOUT.nodeHeight,
      width: FLOWCHART_LAYOUT.minNodeWidth,
    };
    return horizontal ? size.height : size.width;
  };
  const layerSpan = (ids: string[]) =>
    ids.reduce((sum, id) => sum + crossAxisSize(id), 0) +
    Math.max(0, ids.length - 1) * nodeGap;
  const wrapCrossAxisLimit = horizontal
    ? FLOWCHART_LAYOUT.horizontalWrapLimit
    : FLOWCHART_LAYOUT.verticalWrapLimit;
  const wrapLayer = (ids: string[]) => {
    // Measured product layout keeps a graph rank intact. A wide fanout is
    // navigated on the canvas rather than silently turned into later ranks.
    if (measured) return [ids];
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const id of ids) {
      const next = [...current, id];
      if (current.length > 0 && layerSpan(next) > wrapCrossAxisLimit) {
        chunks.push(current);
        current = [id];
      } else {
        current = next;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks.length > 0 ? chunks : [[]];
  };
  const layoutLayers = [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, ids]) => wrapLayer(ids));
  const crossAxisSpan = Math.max(0, ...layoutLayers.map(layerSpan));
  const coordinates = new Map<string, { x: number; y: number }>();
  let primaryCursor = 0;
  for (const [row, ids] of layoutLayers.entries()) {
    const primaryExtent = Math.max(
      0,
      ...ids.map((id) => {
        const size = nodeSize.get(id)!;
        return horizontal ? size.width : size.height;
      }),
    );
    const span = layerSpan(ids);
    let cursor = Math.max(0, (crossAxisSpan - span) / 2);
    for (const id of ids) {
      if (horizontal) {
        coordinates.set(id, {
          x: measured ? primaryCursor : row * layerGap,
          y: cursor + FLOWCHART_LAYOUT.primaryAxisOrigin,
        });
      } else {
        coordinates.set(id, {
          x: cursor,
          y:
            (measured ? primaryCursor : row * layerGap) +
            FLOWCHART_LAYOUT.primaryAxisOrigin,
        });
      }
      cursor += crossAxisSize(id) + nodeGap;
    }
    primaryCursor += primaryExtent + (measured?.layerGap ?? layerGap);
  }

  return nodes.map((node, index) => {
    const size = nodeSize.get(node.id) ?? {
      height: FLOWCHART_LAYOUT.nodeHeight,
      width: FLOWCHART_LAYOUT.minNodeWidth,
    };
    const coordinate = coordinates.get(node.id) ?? {
      x: horizontal ? index * layerGap : 0,
      y: horizontal
        ? FLOWCHART_LAYOUT.primaryAxisOrigin
        : index * layerGap + FLOWCHART_LAYOUT.primaryAxisOrigin,
    };
    return { ...node, ...size, ...coordinate };
  });
}

export function separateFlowchartSubgraphMemberBands(
  pending: PendingFlowchartSubgraph[],
  nodes: MermaidVisualNode[],
  direction: MermaidVisualModel["direction"],
) {
  if (pending.length <= 1) return nodes;

  const horizontal = direction === "LR" || direction === "RL";
  const nodeById = new Map(nodes.map((node) => [node.id, { ...node }]));
  const assignedNodeIds = new Set<string>();
  let cursor = FLOWCHART_LAYOUT.primaryAxisOrigin;
  const bandGap = horizontal
    ? FLOWCHART_LAYOUT.horizontalSubgraphBandGap
    : FLOWCHART_LAYOUT.verticalSubgraphBandGap;

  for (const subgraph of pending) {
    const memberIds = [...subgraph.nodeIds].filter(
      (nodeId) => nodeById.has(nodeId) && !assignedNodeIds.has(nodeId),
    );
    if (memberIds.length === 0) continue;

    const members = memberIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is MermaidVisualNode => Boolean(node));
    const left = Math.min(...members.map((node) => node.x));
    const top = Math.min(...members.map((node) => node.y));
    const right = Math.max(...members.map((node) => node.x + node.width));
    const bottom = Math.max(...members.map((node) => node.y + node.height));
    const shift = cursor - (horizontal ? left : top);

    for (const nodeId of memberIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      if (horizontal) node.x += shift;
      else node.y += shift;
      assignedNodeIds.add(nodeId);
    }

    cursor += (horizontal ? right - left : bottom - top) + bandGap;
  }

  return nodes.map((node) => nodeById.get(node.id) ?? node);
}

export function computeFlowchartSubgraphBounds(
  pending: PendingFlowchartSubgraph[],
  nodes: MermaidVisualNode[],
  metrics?: ReadonlyMap<
    string,
    { padding: number; headerHeight: number; titleWidth: number }
  >,
): MermaidVisualSubgraph[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const hasDirectMembers = new Set<string>();
  const computed = pending.map((subgraph, index) => {
    const measured = metrics?.get(subgraph.id);
    const padding = measured?.padding ?? 36;
    const headerHeight = measured?.headerHeight ?? 48;
    const members = [...subgraph.nodeIds]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is MermaidVisualNode => Boolean(node));
    if (members.length === 0) {
      return {
        direction: subgraph.direction,
        height: 180,
        id: subgraph.id,
        nodeIds: [],
        parentId: subgraph.parentId,
        title: subgraph.title,
        width: 260,
        x: 24 + index * 32,
        y: 24 + index * 32,
      };
    }
    hasDirectMembers.add(subgraph.id);
    const left = Math.min(...members.map((node) => node.x)) - padding;
    const top = Math.min(...members.map((node) => node.y)) - headerHeight;
    const right =
      Math.max(...members.map((node) => node.x + node.width)) + padding;
    const bottom =
      Math.max(...members.map((node) => node.y + node.height)) + padding;
    return {
      direction: subgraph.direction,
      height: Math.max(140, bottom - top),
      id: subgraph.id,
      nodeIds: members.map((node) => node.id),
      parentId: subgraph.parentId,
      title: subgraph.title,
      width: Math.max(
        measured ? measured.titleWidth + padding * 2 : 220,
        right - left,
      ),
      x: Math.max(0, left),
      y: Math.max(0, top),
    };
  });
  const computedById = new Map(
    computed.map((subgraph) => [subgraph.id, subgraph]),
  );
  for (let index = computed.length - 1; index >= 0; index -= 1) {
    const child = computed[index]!;
    if (!child.parentId) continue;
    const parent = computedById.get(child.parentId);
    if (!parent) continue;
    const measured = metrics?.get(parent.id);
    const padding = measured?.padding ?? 24;
    const parentRight = hasDirectMembers.has(parent.id)
      ? parent.x + parent.width
      : Number.NEGATIVE_INFINITY;
    const parentBottom = hasDirectMembers.has(parent.id)
      ? parent.y + parent.height
      : Number.NEGATIVE_INFINITY;
    const left = Math.min(
      hasDirectMembers.has(parent.id) ? parent.x : Number.POSITIVE_INFINITY,
      child.x - padding,
    );
    const top = Math.min(
      hasDirectMembers.has(parent.id) ? parent.y : Number.POSITIVE_INFINITY,
      child.y - (measured?.headerHeight ?? 40),
    );
    const right = Math.max(parentRight, child.x + child.width + padding);
    const bottom = Math.max(parentBottom, child.y + child.height + padding);
    parent.x = Math.max(0, left);
    parent.y = Math.max(0, top);
    parent.width = Math.max(
      measured ? measured.titleWidth + padding * 2 : 260,
      right - parent.x,
    );
    parent.height = Math.max(180, bottom - parent.y);
    hasDirectMembers.add(parent.id);
  }
  return computed;
}
