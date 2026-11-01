// SPDX-License-Identifier: AGPL-3.0-or-later

import { MindmapLayoutType as LayoutType } from "./types.js";

/** Direction overrides follow ancestors; balanced sides belong to root branches. */
export function mindmapLayoutDirection<Node>(
  node: Node | null | undefined,
  root: Node,
  fallback: LayoutType,
  access: {
    parent: (node: Node) => Node | null;
    overridden: (node: Node) => LayoutType | undefined;
    sides: () => { left: readonly Node[]; right: readonly Node[] };
  },
): LayoutType {
  let current = node;
  while (current) {
    const overridden = access.overridden(current);
    if (overridden !== undefined) return overridden;
    const parent = access.parent(current);
    if (parent === root) {
      const rootOverride = access.overridden(root);
      if (rootOverride !== undefined) return rootOverride;
      const sides = access.sides();
      return sides.left.includes(current)
        ? LayoutType.LEFT
        : sides.right.includes(current)
          ? LayoutType.RIGHT
          : fallback;
    }
    current = parent;
  }
  return fallback;
}

/** Ordered traversal reads children after visiting the parent, including any
 * collapse change performed by the consumer. It never changes the tree. */
export function* walkMindmapTree<Node>(
  root: Node | null,
  children: (node: Node) => readonly Node[],
  stopAt?: (node: Node) => boolean,
  parent: Node | null = null,
  path: readonly number[] = [0],
): Generator<{ node: Node; parent: Node | null; path: readonly number[] }> {
  if (!root) return;
  yield { node: root, parent, path };
  if (stopAt?.(root)) return;
  const descendants = children(root);
  const count = descendants.length;
  for (let index = 0; index < count; index++) {
    if (!(index in descendants)) continue;
    yield* walkMindmapTree(descendants[index], children, stopAt, root, [
      ...path,
      index,
    ]);
  }
}
