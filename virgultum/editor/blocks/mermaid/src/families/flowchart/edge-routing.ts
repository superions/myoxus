// SPDX-License-Identifier: AGPL-3.0-or-later

import { semanticMermaidEdgeLabelPlacementForEndpoints } from "../runtime/gfx-element-projection.js";
import type {
  MermaidVisualDirection,
  MermaidVisualEdge,
  MermaidVisualEndpointPosition,
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { semanticMermaidEndpointPositionsBetween } from "../gfx-visual-model-helpers.js";

import type { MermaidFlowchartConnectionPortId } from "./connection-ports.js";

const PORT_POSITIONS = {
  east: [1, 0.5],
  north: [0.5, 0],
  south: [0.5, 1],
  west: [0, 0.5],
} as const satisfies Record<
  MermaidFlowchartConnectionPortId,
  MermaidVisualEndpointPosition
>;

function nodeCenter(node: MermaidVisualNode) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function portIdForPosition(
  position: MermaidVisualEndpointPosition | undefined,
) {
  return Object.entries(PORT_POSITIONS).find(
    ([, candidate]) =>
      candidate[0] === position?.[0] && candidate[1] === position?.[1],
  )?.[0] as MermaidFlowchartConnectionPortId | undefined;
}

function positionForPortId(portId: string | undefined) {
  return portId && portId in PORT_POSITIONS
    ? PORT_POSITIONS[portId as MermaidFlowchartConnectionPortId]
    : undefined;
}

function fanoutPortOrder(
  direction: MermaidVisualDirection,
): readonly MermaidFlowchartConnectionPortId[] {
  if (direction === "LR") return ["north", "east", "south", "west"];
  if (direction === "RL") return ["north", "west", "south", "east"];
  if (direction === "BT") return ["west", "north", "east", "south"];
  return ["west", "south", "east", "north"];
}

function preferredUnusedPort(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  preferred: MermaidFlowchartConnectionPortId | undefined,
) {
  const used = new Set(
    model.edges
      .filter((candidate) => candidate.source === edge.source)
      .map((candidate) => candidate.sourcePortId)
      .filter((portId): portId is string => Boolean(portId)),
  );
  return [preferred, ...fanoutPortOrder(model.direction)].find(
    (portId): portId is MermaidFlowchartConnectionPortId =>
      portId !== undefined && !used.has(portId),
  );
}

function fanoutPorts(
  direction: MermaidVisualDirection,
  count: number,
): readonly MermaidFlowchartConnectionPortId[] {
  const order = fanoutPortOrder(direction);
  if (count <= 1) return [];
  if (count === 2) return [order[0], order[2]];
  return order.slice(0, Math.min(count, order.length));
}

function edgeCrossAxis(
  edge: MermaidVisualEdge,
  nodes: ReadonlyMap<string, MermaidVisualNode>,
  direction: MermaidVisualDirection,
) {
  const center = nodes.get(edge.target);
  if (!center) return 0;
  const point = nodeCenter(center);
  return direction === "LR" || direction === "RL" ? point.y : point.x;
}

/**
 * Gives source-derived Flowcharts deterministic, direction-aware fanout
 * geometry without serializing projection data into Mermaid syntax. Explicit
 * ports selected by a user remain authoritative.
 */
export function routeFlowchartEdges(model: MermaidVisualModel) {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const sourcePortByEdgeId = new Map<
    string,
    MermaidFlowchartConnectionPortId
  >();
  const outgoing = new Map<string, MermaidVisualEdge[]>();
  for (const edge of model.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  for (const edges of outgoing.values()) {
    const sorted = [...edges].sort((left, right) => {
      const crossAxisDelta =
        edgeCrossAxis(left, nodes, model.direction) -
        edgeCrossAxis(right, nodes, model.direction);
      if (crossAxisDelta !== 0) return crossAxisDelta;
      return left.id.localeCompare(right.id);
    });
    const ports = fanoutPorts(model.direction, sorted.length);
    for (const [index, edge] of sorted.entries()) {
      const port = ports[index];
      if (port) sourcePortByEdgeId.set(edge.id, port);
    }
  }

  return {
    ...model,
    edges: model.edges.map((edge) => {
      const source = nodes.get(edge.source),
        target = nodes.get(edge.target);
      const inferred = semanticMermaidEndpointPositionsBetween(source, target);
      const horizontal = model.direction === "LR" || model.direction === "RL";
      const sign =
        model.direction === "BT" || model.direction === "RL" ? -1 : 1;
      const a = source && nodeCenter(source),
        b = target && nodeCenter(target);
      const reverse = a && b && (horizontal ? a.x - b.x : a.y - b.y) * sign > 0;
      // Feedback arrives at a side port instead of sharing the forward exit.
      // Existing endpoint choices still win, including explicit relayout.
      const feedbackPort: MermaidFlowchartConnectionPortId | undefined = reverse
        ? horizontal
          ? a.y >= b.y
            ? "south"
            : "north"
          : a.x >= b.x
            ? "east"
            : "west"
        : undefined;
      const routedSourcePort = sourcePortByEdgeId.get(edge.id);
      const loop = edge.source === edge.target;
      const loops = loop
        ? model.edges.filter(
            (candidate) =>
              candidate.source === edge.source &&
              candidate.target === edge.source,
          )
        : [];
      const loopPort =
        (loops.findIndex((candidate) => candidate.id === edge.id) + 1) /
        (loops.length + 1);
      // Reuse the native curve's same-face loop geometry. Opposite ports make
      // the overlap shortcut cross the body and hide its label behind the node.
      const loopSource: MermaidVisualEndpointPosition = [1, loopPort / 2];
      const loopTarget: MermaidVisualEndpointPosition = [1, 0.5 + loopPort / 2];
      const sourcePosition =
        edge.sourcePosition ??
        positionForPortId(edge.sourcePortId) ??
        (loop
          ? loopSource
          : routedSourcePort
            ? PORT_POSITIONS[routedSourcePort]
            : inferred.sourcePosition);
      const targetPosition =
        edge.targetPosition ??
        positionForPortId(edge.targetPortId) ??
        (loop ? loopTarget : undefined) ??
        (feedbackPort ? PORT_POSITIONS[feedbackPort] : undefined) ??
        inferred.targetPosition;
      return {
        ...edge,
        connectorMode: edge.connectorMode ?? (loop ? "curve" : "orthogonal"),
        labelPlacement:
          edge.labelPlacement ??
          semanticMermaidEdgeLabelPlacementForEndpoints({
            sourcePosition,
            targetPosition,
          }),
        sourcePortId:
          edge.sourcePortId ??
          (loop ? undefined : routedSourcePort) ??
          portIdForPosition(sourcePosition),
        sourcePosition,
        targetPortId: edge.targetPortId ?? portIdForPosition(targetPosition),
        targetPosition,
      };
    }),
  } satisfies MermaidVisualModel;
}

export function routeFlowchartCreatedEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const inferred = semanticMermaidEndpointPositionsBetween(
    nodes.get(edge.source),
    nodes.get(edge.target),
  );
  const sourcePortId = preferredUnusedPort(
    model,
    edge,
    portIdForPosition(inferred.sourcePosition),
  );
  const sourcePosition = sourcePortId
    ? PORT_POSITIONS[sourcePortId]
    : inferred.sourcePosition;
  const targetPosition = inferred.targetPosition;
  return {
    ...edge,
    connectorMode: "orthogonal" as const,
    labelPlacement: semanticMermaidEdgeLabelPlacementForEndpoints({
      sourcePosition,
      targetPosition,
    }),
    sourcePortId,
    sourcePosition,
    targetPortId: portIdForPosition(targetPosition),
    targetPosition,
  };
}
