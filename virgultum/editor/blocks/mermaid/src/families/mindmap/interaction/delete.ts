// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mindmapSelectionSubtrees,
  type MermaidMindmapModel,
} from "../../../engine/mindmap/index.js";
import { mermaidMessages as m } from "../../../i18n.js";

/** The Source subtree includes hidden descendants and all owning records. */
export function mindmapDeleteImpact(
  model: MermaidMindmapModel,
  keys: readonly string[],
) {
  const trees = mindmapSelectionSubtrees(model, keys);
  if (!trees?.length) return null;
  const nodes = trees.flatMap((tree) => tree.nodes);
  const records = trees.flatMap((tree) => tree.records);
  return {
    nodes: nodes.length,
    branches: nodes.length - (trees.some((tree) => tree.root.root) ? 1 : 0),
    comments: records.filter((record) => record.kind === "comment").length,
    decorations: records.filter(
      (record) => record.kind === "icon" || record.kind === "class",
    ).length,
    parent: [
      ...new Set(
        trees.map(
          (tree) =>
            model.nodes.find((node) => node.id === tree.root.parentId)?.label ??
            m.chartRoot(),
        ),
      ),
    ].join(" · "),
  };
}
