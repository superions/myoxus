// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "./types.js";

import { Bound, type SerializedXYWH } from "@virgultum/global/gfx";

export const NODE_VERTICAL_SPACING = 45;
export const NODE_HORIZONTAL_SPACING = 110;
export const NODE_FIRST_LEVEL_HORIZONTAL_SPACING = 200;

/** Geometry inputs are read-only; the native consumer owns applying the plan. */
export type MindmapLayoutAccess<Node> = {
  children: (node: Node) => readonly Node[];
  collapsed: (node: Node) => boolean;
  /** Unrotated element geometry is the layout write target. */
  bounds: (node: Node) => Bound;
  /** Rotated extents contribute to subtree measurement, not element positions. */
  measuredBounds: (node: Node) => Bound;
  sides: (root: Node) => {
    left: readonly Node[];
    right: readonly Node[];
  };
};

type TreeSize<Node> = {
  node: Node;
  bound: Bound;
  children: TreeSize<Node>[];
};

/** Preserve the native measured left/right/balanced algorithm without writes
 * to model elements. Ancestor positions come from this same transient plan. */
export function planMindmapLayout<Node>(
  root: Node,
  direction: LayoutType,
  access: MindmapLayoutAccess<Node>,
  path: readonly number[] = [0],
): Map<Node, SerializedXYWH> {
  const positions = new Map<Node, SerializedXYWH>();
  const bounds = (node: Node) => {
    const planned = positions.get(node);
    return planned ? Bound.deserialize(planned) : access.bounds(node);
  };
  const measure = (
    node: Node,
    firstLevel: boolean,
    descendants = access.children(node),
  ): TreeSize<Node> => {
    const current = access.measuredBounds(node);
    const bound = new Bound(current.x, current.y, current.w, current.h);
    const children: TreeSize<Node>[] = [];
    if (descendants.length && !access.collapsed(node)) {
      const childrenBound = descendants.reduce(
        (total, child) => {
          const size = measure(child, false);
          children.push(size);
          total.w = Math.max(total.w, size.bound.w);
          total.h +=
            total.h > 0 ? NODE_VERTICAL_SPACING + size.bound.h : size.bound.h;
          return total;
        },
        new Bound(0, 0, 0, 0),
      );
      bound.w +=
        childrenBound.w +
        (firstLevel
          ? NODE_FIRST_LEVEL_HORIZONTAL_SPACING
          : NODE_HORIZONTAL_SPACING);
      bound.h = Math.max(bound.h, childrenBound.h);
    }
    return { node, bound, children };
  };
  const place = (
    tree: TreeSize<Node>,
    side: LayoutType.LEFT | LayoutType.RIGHT,
    depth: number,
  ) => {
    const current = bounds(tree.node);
    const spacing =
      depth === 1
        ? NODE_FIRST_LEVEL_HORIZONTAL_SPACING
        : NODE_HORIZONTAL_SPACING;
    const currentX =
      side === LayoutType.RIGHT
        ? current.x + current.w + spacing
        : current.x - spacing;
    let currentY = current.y + (current.h - tree.bound.h) / 2;
    if (current.h >= tree.bound.h && tree.children.length) {
      currentY += (current.h - bounds(tree.children[0].node).h) / 2;
    }
    if (access.collapsed(tree.node)) return;
    for (const child of tree.children) {
      const childBounds = bounds(child.node);
      const x = side === LayoutType.RIGHT ? currentX : currentX - childBounds.w;
      const y = currentY + (child.bound.h - childBounds.h) / 2;
      positions.set(
        child.node,
        `[${x},${y},${childBounds.w},${childBounds.h}]`,
      );
      place(child, side, depth + 1);
      currentY += child.bound.h + NODE_VERTICAL_SPACING;
    }
  };
  if (direction === LayoutType.BALANCE) {
    const sides = access.sides(root);
    place(measure(root, true, sides.left), LayoutType.LEFT, path.length);
    place(measure(root, true, sides.right), LayoutType.RIGHT, 1);
  } else if (direction === LayoutType.LEFT || direction === LayoutType.RIGHT) {
    place(measure(root, true), direction, path.length);
  }
  return positions;
}
