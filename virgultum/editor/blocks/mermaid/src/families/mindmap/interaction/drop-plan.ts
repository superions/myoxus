// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import type { Bound, IVec } from "@virgultum/global/gfx";

export type MindmapInsertPosition =
  | {
      type: "child";
      layoutDir: LayoutType.LEFT | LayoutType.RIGHT;
    }
  | {
      type: "sibling";
      layoutDir: LayoutType.LEFT | LayoutType.RIGHT;
      position: "prev" | "next";
    };

/** Search response zones in native child order, preserving first-hit priority. */
export function findMindmapDropTarget<Node>(
  root: Node,
  position: IVec,
  access: {
    children: (node: Node) => readonly Node[];
    bounds: (node: Node) => Bound;
    responseArea: (node: Node) => Bound | undefined;
    direction: (node: Node) => LayoutType;
  },
): Node | null {
  const find = (node: Node): Node | null => {
    const response = access.responseArea(node);
    if (!response) return null;
    const direction = access.direction(node);
    const bound = access.bounds(node);
    if (
      direction === LayoutType.BALANCE ||
      (direction === LayoutType.RIGHT && position[0] > bound.x + bound.w) ||
      (direction === LayoutType.LEFT && position[0] < bound.x)
    ) {
      for (const child of access.children(node)) {
        const result = find(child);
        if (result) return result;
      }
    }
    return response.containsPoint(position) ? node : null;
  };
  return find(root);
}

/** Balanced first-level left branches use the native reversed sibling order. */
export function planMindmapInsertion(
  position: IVec,
  bound: Bound,
  response: Bound | undefined,
  direction: LayoutType,
  balancedRootBranch: boolean,
): MindmapInsertPosition | null {
  if (!response?.containsPoint(position)) return null;
  const side =
    direction === LayoutType.BALANCE
      ? position[0] > bound.x + bound.w / 2
        ? LayoutType.RIGHT
        : LayoutType.LEFT
      : direction;
  if (
    bound.containsPoint(position) ||
    (direction === LayoutType.RIGHT
      ? position[0] > bound.x + bound.w
      : position[0] < bound.x)
  ) {
    return { type: "child", layoutDir: side };
  }
  const lower = position[1] > bound.y + bound.h / 2;
  return {
    type: "sibling",
    layoutDir: side,
    position:
      balancedRootBranch && side === LayoutType.LEFT
        ? lower
          ? "prev"
          : "next"
        : lower
          ? "next"
          : "prev",
  };
}
