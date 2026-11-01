// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  computeFlowchartSubgraphBounds,
  layoutFlowchartNodes,
} from "../../engine/flowchart-geometry.js";
import {
  resolveMermaidGfxTheme,
  measureMermaidGfxText,
  mermaidGfxTypographyForNode,
} from "../../mermaid-gfx-theme.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { routeFlowchartEdges } from "./edge-routing.js";
import {
  flowchartNodeElementStyle,
  flowchartSubgraphElementStyle,
} from "./gfx-style-projection.js";
import {
  flowchartLabelTypography,
  measureFlowchartNode,
} from "./label-geometry.js";

/** Creation and explicit relayout share measured geometry. Replay and ordinary
 * formatting retain the stored candidate through projection reconciliation. */
export function layoutMeasuredFlowchart(
  model: MermaidVisualModel,
  { fromSource = false }: { fromSource?: boolean } = {},
): MermaidVisualModel {
  // A fresh grammar parse has only inferred ports. Choose them after sizing;
  // explicit relayout instead keeps the existing authored endpoint choices.
  const edges = fromSource
    ? model.edges.map((edge) => ({
        ...edge,
        sourcePortId: undefined,
        sourcePosition: undefined,
        targetPortId: undefined,
        targetPosition: undefined,
        labelPlacement: undefined,
      }))
    : model.edges;
  const line = resolveMermaidGfxTheme().typography.lineHeight;
  const sizes = new Map(
    model.nodes.map((node) => [
      node.id,
      measureFlowchartNode(
        node,
        flowchartLabelTypography(flowchartNodeElementStyle(model, node)),
      ),
    ]),
  );
  const nodes = layoutFlowchartNodes(model.nodes, edges, model.direction, {
    sizes,
    nodeGap: line * 2,
    layerGap: line * 3,
  });
  const groups = (model.subgraphs ?? []).map((group) => ({
    ...group,
    nodeIds: new Set(group.nodeIds),
  }));
  const groupMetrics = new Map(
    (model.subgraphs ?? []).map((group) => {
      const type = mermaidGfxTypographyForNode(
        flowchartSubgraphElementStyle(model, group),
      );
      const text = measureMermaidGfxText(
        group.displayLabel ?? group.title,
        type,
      );
      return [
        group.id,
        {
          padding: line,
          headerHeight: text.height + line,
          titleWidth: text.width,
        },
      ] as const;
    }),
  );
  for (const node of nodes) node.x += line * 4;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const horizontal = model.direction === "LR" || model.direction === "RL";
  const descendants = (id: string): Set<string> =>
    new Set([
      ...(groups.find((group) => group.id === id)?.nodeIds ?? []),
      ...groups
        .filter((group) => group.parentId === id)
        .flatMap((group) => [...descendants(group.id)]),
    ]);
  if (!horizontal) {
    // A heading consumes space above its first content rank. Keep the normal
    // connection gap outside it, including each level of nested headings.
    const headers = groups.flatMap((group) => {
      const ids = descendants(group.id);
      const first = Math.min(
        ...nodes.filter((node) => ids.has(node.id)).map((node) => node.y),
      );
      return Number.isFinite(first)
        ? [{ first, height: groupMetrics.get(group.id)!.headerHeight }]
        : [];
    });
    for (const node of nodes)
      node.y += headers.reduce(
        (shift, header) => shift + (header.first <= node.y ? header.height : 0),
        0,
      );
  }
  // Pack sibling groups across ranks. Keeping their main-axis coordinates
  // avoids the old large vertical bands that broke the graph's rank rhythm.
  const pack = (parentId?: string) => {
    const children = groups.filter((group) => group.parentId === parentId);
    for (const child of children) pack(child.id);
    const bounds = new Map(
      computeFlowchartSubgraphBounds(groups, nodes, groupMetrics).map(
        (group) => [group.id, group],
      ),
    );
    const memberSets: {
      ids: Set<string>;
      bound: Pick<MermaidVisualNode, "x" | "y" | "width" | "height">;
    }[] = children.map((group) => ({
      ids: descendants(group.id),
      bound: bounds.get(group.id)!,
    }));
    const grouped = new Set(memberSets.flatMap(({ ids }) => [...ids]));
    const direct = parentId
      ? (groups.find((group) => group.id === parentId)?.nodeIds ??
        new Set<string>())
      : new Set(nodes.map((node) => node.id));
    for (const id of direct) {
      const node = nodeById.get(id);
      if (!grouped.has(id) && node)
        memberSets.push({ ids: new Set([id]), bound: node });
    }
    const clusters = memberSets
      .map(({ ids, bound }) => {
        const members = [...ids].flatMap((id) =>
          nodeById.get(id) ? [nodeById.get(id)!] : [],
        );
        return {
          members,
          start: horizontal ? bound.y : bound.x,
          end: horizontal ? bound.y + bound.height : bound.x + bound.width,
          mainStart: horizontal ? bound.x : bound.y,
          mainEnd: horizontal ? bound.x + bound.width : bound.y + bound.height,
        };
      })
      .filter(({ members }) => members.length);
    if (parentId && clusters.length) {
      // Global ranks centre against every branch. A group's own ranks instead
      // follow its entry; nested groups move as one item so their layout stays intact.
      const rows = Map.groupBy(clusters, (cluster) => cluster.mainStart);
      const center = (row: typeof clusters) =>
        (Math.min(...row.map((item) => item.start)) +
          Math.max(...row.map((item) => item.end))) /
        2;
      const anchor = center(rows.get(Math.min(...rows.keys()))!);
      for (const row of rows.values()) {
        const shift = anchor - center(row);
        for (const cluster of row) {
          for (const node of cluster.members) {
            if (horizontal) node.y += shift;
            else node.x += shift;
          }
          cluster.start += shift;
          cluster.end += shift;
        }
      }
    }
    clusters.sort((a, b) => a.start - b.start);
    const placed: typeof clusters = [];
    for (const cluster of clusters) {
      const blockers = placed.filter(
        (other) =>
          other.mainStart < cluster.mainEnd &&
          other.mainEnd > cluster.mainStart &&
          other.end + line > cluster.start,
      );
      const shift = Math.max(
        0,
        ...blockers.map((other) => other.end + line - cluster.start),
      );
      for (const node of cluster.members) {
        if (horizontal) node.y += shift;
        else node.x += shift;
      }
      placed.push({
        ...cluster,
        start: cluster.start + shift,
        end: cluster.end + shift,
      });
    }
  };
  if (groups.length) pack();
  const subgraphs = computeFlowchartSubgraphBounds(groups, nodes, groupMetrics);
  const grouped = new Set(groups.flatMap((group) => [...group.nodeIds]));
  const incoming = Map.groupBy(edges, (edge) => edge.target);
  const outgoing = Map.groupBy(edges, (edge) => edge.source);
  const main = (node: MermaidVisualNode) => (horizontal ? node.x : node.y);
  const order = model.direction === "BT" || model.direction === "RL" ? -1 : 1;
  for (const node of [...nodes].sort((a, b) => (main(a) - main(b)) * order)) {
    if (grouped.has(node.id)) continue;
    const parents = incoming.get(node.id) ?? [];
    if (parents.length !== 1) continue;
    const parent = nodeById.get(parents[0].source);
    if (
      !parent ||
      (outgoing.get(parent.id)?.length ?? 0) !== 1 ||
      (main(node) - main(parent)) * order <= 0
    )
      continue;
    // An unbranched continuation follows its predecessor, including a group
    // exit. Keep the rank and skip alignment if it would crowd another object.
    const candidate = horizontal
      ? { ...node, y: parent.y + (parent.height - node.height) / 2 }
      : { ...node, x: parent.x + (parent.width - node.width) / 2 };
    if (
      [...nodes.filter((other) => other !== node), ...subgraphs].some(
        (other) =>
          candidate.x < other.x + other.width + line &&
          candidate.x + candidate.width + line > other.x &&
          candidate.y < other.y + other.height + line &&
          candidate.y + candidate.height + line > other.y,
      )
    )
      continue;
    node.x = candidate.x;
    node.y = candidate.y;
  }
  return routeFlowchartEdges({
    ...model,
    edges,
    nodes,
    subgraphs,
  });
}
