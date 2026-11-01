// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolveMermaidBlockSource } from "../../engine/block/index.js";
export type BlockNativeRenderEdge = { id: string; [key: string]: unknown };
/** Native pair occurrence numbers are render transport only. Count visible
 * siblings too: filtering by endpoints would erase visible parallel edges. */
export function projectBlockNativeRenderEdges(
  source: string,
  edges: readonly BlockNativeRenderEdge[],
) {
  const model = resolveMermaidBlockSource(source).model;
  if (!model) return edges;
  const counts = new Map<string, number>(),
    hidden = new Set<string>();
  for (const e of model.edges) {
    const pair = `${e.from || "undefined"}-${e.to}`,
      count = (counts.get(pair) ?? 0) + 1;
    counts.set(pair, count);
    if (e.invisible) hidden.add(`${count}-${pair}`);
  }
  return edges.filter((e) => !hidden.has(e.id));
}
