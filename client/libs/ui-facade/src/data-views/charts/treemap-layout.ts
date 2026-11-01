// SPDX-License-Identifier: AGPL-3.0-or-later

import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

export type DataTreemapLayoutNodeInput = {
  readonly children?: readonly DataTreemapLayoutNodeInput[];
  readonly id: string;
  readonly label: string;
  readonly sourceOrder: number;
  readonly type: "leaf" | "section";
  readonly value: number;
};

export type DataTreemapLayoutNode = Omit<
  DataTreemapLayoutNodeInput,
  "children"
> & {
  readonly aggregate: number;
  readonly depth: number;
  readonly parentId: string | null;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
};

const SECTION_HEADER = 25;
const SECTION_INSET = 10;

function finite(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0;
}

/**
 * Mirrors Mermaid's synthetic root, value sort, squarify tile and section
 * insets. Source order is used only as the stable tie-breaker.
 */
export function computeDataTreemapLayout(input: {
  readonly data: readonly DataTreemapLayoutNodeInput[];
  readonly width: number;
  readonly height: number;
  readonly diagramPadding: number;
  readonly padding: number;
}) {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const synthetic: DataTreemapLayoutNodeInput = {
    id: "__myoxus_treemap_root__",
    label: "",
    sourceOrder: -1,
    type: "section",
    value: 0,
    children: input.data,
  };
  const root = hierarchy(synthetic)
    .sum((node) => (node.type === "leaf" ? Math.max(0, node.value) : 0))
    .sort(
      (left, right) =>
        (right.value ?? 0) - (left.value ?? 0) ||
        left.data.sourceOrder - right.data.sourceOrder,
    );
  const laidOut = treemap<DataTreemapLayoutNodeInput>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingOuter(Math.max(0, input.diagramPadding))
    .paddingInner(Math.max(0, input.padding))
    .paddingTop((node) =>
      node.depth > 0 && node.children?.length
        ? Math.min(
            SECTION_HEADER + SECTION_INSET,
            Math.max(0, node.y1 - node.y0),
          )
        : 0,
    )
    .paddingLeft((node) =>
      node.depth > 0 && node.children?.length
        ? Math.min(SECTION_INSET, Math.max(0, (node.x1 - node.x0) / 2))
        : 0,
    )
    .paddingRight((node) =>
      node.depth > 0 && node.children?.length
        ? Math.min(SECTION_INSET, Math.max(0, (node.x1 - node.x0) / 2))
        : 0,
    )
    .paddingBottom((node) =>
      node.depth > 0 && node.children?.length
        ? Math.min(SECTION_INSET, Math.max(0, node.y1 - node.y0))
        : 0,
    )
    .round(true)(root);
  return laidOut.descendants().flatMap<DataTreemapLayoutNode>((node) =>
    node.depth === 0
      ? []
      : [
          {
            id: node.data.id,
            label: node.data.label,
            sourceOrder: node.data.sourceOrder,
            type: node.data.type,
            value: node.data.value,
            aggregate: Math.max(0, node.value ?? 0),
            depth: node.depth - 1,
            parentId: node.parent?.depth ? node.parent.data.id : null,
            x0: finite(node.x0, width),
            x1: finite(node.x1, width),
            y0: finite(node.y0, height),
            y1: finite(node.y1, height),
          },
        ],
  );
}

export const DATA_TREEMAP_SECTION_HEADER = SECTION_HEADER;
