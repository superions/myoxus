// SPDX-License-Identifier: AGPL-3.0-or-later
import { MermaidBlockSchema } from "@virgultum/model";
import type { BlockSnapshot, NodeProps } from "@virgultum/store";

/** A Source block is exported by its block adapter. Its derived Surface
 * primitives must not appear again as unrelated shape/connector paragraphs. */
export function managedSurfaceSnapshotChildren(
  snapshot: NodeProps<BlockSnapshot>,
) {
  while (snapshot.parent) snapshot = snapshot.parent;
  const ids = new Set<string>();
  const pending = [snapshot.node];
  while (pending.length) {
    const block = pending.pop()!;
    if (block.flavour === MermaidBlockSchema.model.flavour) {
      const children = block.props.childElementIds;
      if (children && typeof children === "object")
        Object.keys(children).forEach((id) => ids.add(id));
    }
    pending.push(...block.children);
  }
  return ids;
}
