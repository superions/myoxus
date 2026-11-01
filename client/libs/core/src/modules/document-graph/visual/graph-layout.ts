type GraphLayoutNode = {
  id: string;
  kind: "document" | "database";
};

type GraphLayoutEdge = {
  source: string;
  target: string;
};

type GraphPosition = { x: number; y: number };

/**
 * Projects the approved Variant B composition into React Flow geometry: one
 * selected focus card in the middle and its incoming/outgoing context on both
 * sides. React Flow remains the only graph renderer and interaction engine.
 */
export function layoutDocumentGraph(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  preferredCenterId?: string,
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  if (nodes.length === 0) return positions;

  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const center =
    nodes.find((node) => node.id === preferredCenterId) ??
    [...nodes].sort(
      (left, right) =>
        (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )[0];
  positions.set(center.id, { x: 0, y: 0 });

  const remaining = nodes.filter((node) => node.id !== center.id);
  const incomingIds = new Set(
    edges
      .filter((edge) => edge.target === center.id)
      .map((edge) => edge.source),
  );
  const outgoingIds = new Set(
    edges
      .filter((edge) => edge.source === center.id)
      .map((edge) => edge.target),
  );
  const left = remaining.filter((node) => incomingIds.has(node.id));
  const right = remaining.filter(
    (node) => !incomingIds.has(node.id) && outgoingIds.has(node.id),
  );
  for (const node of remaining) {
    if (left.includes(node) || right.includes(node)) continue;
    (left.length <= right.length ? left : right).push(node);
  }

  placeColumn(positions, left, -190);
  placeColumn(positions, right, 190);
  return positions;
}

function placeColumn(
  positions: Map<string, GraphPosition>,
  nodes: GraphLayoutNode[],
  x: number,
) {
  nodes
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((node, index) => {
      positions.set(node.id, {
        x,
        y: (index - (nodes.length - 1) / 2) * 280,
      });
    });
}
