// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  sankey,
  sankeyCenter,
  sankeyJustify,
  sankeyLeft,
  sankeyLinkHorizontal,
  sankeyRight,
  type SankeyGraph,
  type SankeyLink,
  type SankeyNode,
} from "d3-sankey";

export type DataSankeyLayoutNodeInput = {
  readonly id: string;
  readonly label: string;
};

export type DataSankeyLayoutLinkInput = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly value: number;
};

type LayoutNode = DataSankeyLayoutNodeInput;
type LayoutLink = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly value: number;
};

export type DataSankeyLayoutNode = LayoutNode & {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly value: number;
};

export type DataSankeyLayoutLink = DataSankeyLayoutLinkInput & {
  readonly path: string;
  readonly width: number;
  readonly y0: number;
  readonly y1: number;
};

export type DataSankeyLayout = {
  readonly links: readonly DataSankeyLayoutLink[];
  readonly nodes: readonly DataSankeyLayoutNode[];
};

const alignments = {
  center: sankeyCenter,
  justify: sankeyJustify,
  left: sankeyLeft,
  right: sankeyRight,
} as const;

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Computes the sole Sankey geometry projection. An all-zero graph uses
 * positive layout-only weights to obtain finite positions; returned widths and
 * all caller-visible values always come from the real data.
 */
export function computeDataSankeyLayout(input: {
  readonly alignment: keyof typeof alignments;
  readonly height: number;
  readonly links: readonly DataSankeyLayoutLinkInput[];
  readonly nodePadding: number;
  readonly nodeWidth: number;
  readonly nodes: readonly DataSankeyLayoutNodeInput[];
  readonly width: number;
}): DataSankeyLayout {
  const allZero =
    input.links.length > 0 && input.links.every((link) => link.value === 0);
  const graph: SankeyGraph<LayoutNode, LayoutLink> = {
    nodes: input.nodes.map((node) => ({ ...node })),
    links: input.links.map((link) => ({
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      value: allZero ? 1 : link.value,
    })),
  };
  const projected = sankey<LayoutNode, LayoutLink>()
    .nodeId((node) => node.id)
    .nodeAlign(alignments[input.alignment])
    .nodeWidth(Math.max(1, input.nodeWidth))
    .nodePadding(Math.max(0, input.nodePadding))
    .extent([
      [0, 0],
      [Math.max(1, input.width), Math.max(1, input.height)],
    ])(graph);
  const linkPath = sankeyLinkHorizontal<LayoutNode, LayoutLink>();
  const linksById = new Map(input.links.map((link) => [link.id, link]));
  return {
    nodes: projected.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      value: allZero ? 0 : finite(node.value ?? 0),
      x0: finite(node.x0 ?? 0),
      x1: finite(node.x1 ?? 0),
      y0: finite(node.y0 ?? 0),
      y1: finite(node.y1 ?? 0),
    })),
    links: projected.links.flatMap((link) => {
      const original = linksById.get(link.id);
      const path = linkPath(link as SankeyLink<LayoutNode, LayoutLink>);
      const source = link.source as SankeyNode<LayoutNode, LayoutLink>;
      const target = link.target as SankeyNode<LayoutNode, LayoutLink>;
      return original && path
        ? [
            {
              ...original,
              path,
              width: original.value === 0 ? 0 : finite(link.width ?? 0),
              y0: finite(link.y0 ?? source.y0 ?? 0),
              y1: finite(link.y1 ?? target.y0 ?? 0),
            },
          ]
        : [];
    }),
  };
}
