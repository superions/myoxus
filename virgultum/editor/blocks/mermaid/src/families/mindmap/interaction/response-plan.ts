// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import { Bound } from "@virgultum/global/gfx";
import { walkMindmapTree } from "../projection/tree-access.js";
import type { MindmapLayoutAccess } from "../projection/layout-plan.js";
import {
  NODE_HORIZONTAL_SPACING,
  NODE_VERTICAL_SPACING,
} from "../projection/layout-plan.js";

/** Compute native response zones without writing to nodes or their models. */
export function planMindmapResponseAreas<Node>(
  root: Node,
  direction: LayoutType,
  access: MindmapLayoutAccess<Node> & {
    parent: (node: Node) => Node | null;
    responseArea: (node: Node) => Bound | undefined;
  },
): Map<Node, Bound> {
  const areas = new Map<Node, Bound>();
  // A collapsed root retains its children's previous transient zones. Native
  // balance adjustment still reads them, so never replace them with empty input.
  for (const { node } of walkMindmapTree(root, access.children)) {
    const previous = access.responseArea(node);
    if (previous)
      areas.set(
        node,
        new Bound(previous.x, previous.y, previous.w, previous.h),
      );
  }
  const onEdge = (node: Node, edge: "tail" | "head") => {
    let current = node;
    for (;;) {
      const parent = access.parent(current);
      if (!parent) return true;
      const children = access.children(parent);
      if (
        (edge === "tail" ? children[children.length - 1] : children[0]) !==
        current
      ) {
        return false;
      }
      current = parent;
    }
  };
  const fill = (node: Node, side: LayoutType, parent: Node | null) => {
    const bound = access.bounds(node);
    const measured = access.measuredBounds(node);
    if (!parent) {
      const width =
        measured.w +
        NODE_HORIZONTAL_SPACING * (side === LayoutType.BALANCE ? 2 : 1);
      areas.set(
        node,
        new Bound(
          side === LayoutType.BALANCE || side === LayoutType.LEFT
            ? measured.x - NODE_HORIZONTAL_SPACING
            : measured.x,
          measured.y,
          width,
          measured.h,
        ),
      );
      if (access.collapsed(node)) return;
      if (side === LayoutType.BALANCE) {
        const sides = access.sides(node);
        sides.right.forEach((child) => fill(child, LayoutType.RIGHT, node));
        sides.left.forEach((child) => fill(child, LayoutType.LEFT, node));
      } else access.children(node).forEach((child) => fill(child, side, node));
      return;
    }
    const siblings = access.children(parent);
    const index = siblings.indexOf(node);
    const isLast =
      index === (siblings.length || -1) - 1 && onEdge(node, "tail");
    const isFirst = index === 0 && onEdge(node, "head");
    const upper = NODE_VERTICAL_SPACING * (isFirst ? 2 : 0.5);
    const lower = NODE_VERTICAL_SPACING * (isLast ? 2 : 0.5);
    const parentBound = access.bounds(parent);
    const width =
      (side === LayoutType.RIGHT
        ? bound.x + bound.w - (parentBound.x + parentBound.w)
        : parentBound.x - bound.x) + NODE_HORIZONTAL_SPACING;
    const area = new Bound(
      side === LayoutType.RIGHT
        ? parentBound.x + parentBound.w
        : parentBound.x - width,
      bound.y - upper,
      width,
      measured.h + upper + lower,
    );
    areas.set(node, area);
    const children = access.children(node);
    if (children.length && !access.collapsed(node)) {
      let childrenArea: Bound | undefined;
      for (const child of children) {
        fill(child, side, node);
        const childArea = areas.get(child)!;
        childrenArea = childrenArea ? childrenArea.unite(childArea) : childArea;
      }
      area.h = childrenArea!.h;
      area.y = childrenArea!.y;
    }
  };
  if (
    ![LayoutType.LEFT, LayoutType.RIGHT, LayoutType.BALANCE].includes(direction)
  )
    return areas;
  fill(root, direction, null);
  if (direction !== LayoutType.BALANCE) return areas;
  const sides = access.sides(root);
  const total = (children: readonly Node[]) =>
    children.reduce<Bound | null>((area, node) => {
      const current = areas.get(node)!;
      return area ? area.unite(current) : current;
    }, null);
  const left = total(sides.left);
  const right = total(sides.right);
  if (!left || !right || left.h === right.h) return areas;
  const higher = left.h > right.h ? left : right;
  const expand = left.h > right.h ? sides.right : sides.left;
  const first = areas.get(expand[0]);
  if (first) {
    first.h += first.y - higher.y;
    first.y = higher.y;
  }
  const last = areas.get(expand[expand.length - 1]);
  if (last) last.h += higher.y + higher.h - last.y - last.h;
  return areas;
}
