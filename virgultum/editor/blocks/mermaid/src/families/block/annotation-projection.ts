// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../../engine/block/index.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
export type BlockCommentMarker = {
  key: string;
  anchorKey?: string;
  left: number;
  top: number;
  count: number;
};
export function blockCommentMarkers(
  m: MermaidBlockDiagramModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): BlockCommentMarker[] {
  const result: BlockCommentMarker[] = [];
  for (const c of m.comments) {
    const node = [...m.nodes, ...m.groups].find((n) =>
        n.recordKeys.includes(c.anchorKey ?? ""),
      ),
      edge = m.edges.find((e) => e.sourceKey === c.anchorKey),
      space = m.spaces.find((s) => s.sourceKey === c.anchorKey),
      kind = edge
        ? "edge"
        : node && m.groups.some((g) => g.sourceKey === node.sourceKey)
          ? "subgraph"
          : node || space
            ? "node"
            : "diagram",
      position = resolve(
        kind,
        // Endpoint occurrences also reference their Connection record. The
        // comment owns that record, so resolve its Edge key before a Node key.
        edge?.sourceKey ?? node?.sourceKey ?? space?.sourceKey,
      );
    if (position)
      result.push({
        key: c.sourceKey,
        anchorKey: c.anchorKey,
        count: 1,
        ...position,
      });
  }
  return result;
}
