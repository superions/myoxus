// SPDX-License-Identifier: AGPL-3.0-or-later
/** Stable cold-layout layers with Source-order tiebreaks. Flowchart can prefer
 * the reached entry path when breaking cycles; self edges never advance a layer.
 * Geometry and semantic containment stay with callers. */
export function mermaidGraphLayers(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string }[],
  { preferReachedNodes = false }: { preferReachedNodes?: boolean } = {},
): Map<string, number> {
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const layer = new Map<string, number>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
    layer.set(node.id, 0);
  }
  for (const edge of edges) {
    if (
      edge.source === edge.target ||
      !nodeOrder.has(edge.source) ||
      !nodeOrder.has(edge.target)
    )
      continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const sortedBySourceOrder = (ids: string[]) =>
    ids.sort((a, b) => (nodeOrder.get(a) ?? 0) - (nodeOrder.get(b) ?? 0));
  const processed = new Set<string>();
  let queue = sortedBySourceOrder(
    nodes
      .filter((node) => (indegree.get(node.id) ?? 0) === 0)
      .map((node) => node.id),
  );
  while (processed.size < nodes.length) {
    if (queue.length === 0) {
      const nextCycleBreak = nodes
        .filter((node) => !processed.has(node.id))
        .sort((a, b) => {
          if (preferReachedNodes) {
            // Continue an established entry path through its feedback cycle.
            // Declaration order can put grouped descendants before that entry.
            const reachedDelta =
              Number((layer.get(b.id) ?? 0) > 0) -
              Number((layer.get(a.id) ?? 0) > 0);
            if (reachedDelta) return reachedDelta;
          }
          const indegreeDelta =
            (indegree.get(a.id) ?? 0) - (indegree.get(b.id) ?? 0);
          if (indegreeDelta !== 0) return indegreeDelta;
          return (nodeOrder.get(a.id) ?? 0) - (nodeOrder.get(b.id) ?? 0);
        })[0];
      if (!nextCycleBreak) break;
      queue = [nextCycleBreak.id];
      indegree.set(nextCycleBreak.id, 0);
    }

    const id = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    for (const targetId of outgoing.get(id) ?? []) {
      if (processed.has(targetId)) continue;
      layer.set(
        targetId,
        Math.max(layer.get(targetId) ?? 0, (layer.get(id) ?? 0) + 1),
      );
      indegree.set(targetId, Math.max(0, (indegree.get(targetId) ?? 0) - 1));
      if ((indegree.get(targetId) ?? 0) === 0 && !queue.includes(targetId)) {
        queue.push(targetId);
        queue = sortedBySourceOrder(queue);
      }
    }
  }

  return layer;
}
