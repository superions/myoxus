// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrokeStyle, PointStyle } from "@virgultum/model";
import type { MermaidBlockEdge } from "../../engine/block/index.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { distributeMermaidPorts } from "../runtime/graph-ports.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import { blockProjectionBinding } from "./gfx-data.js";
import { readMermaidGfxMeta } from "../../mermaid-gfx-metadata.js";
import { toMermaidConnectorElementProps } from "../runtime/gfx-element-projection.js";
export function projectBlockConnection(
  e: MermaidBlockEdge,
  ids: ReadonlyMap<string, string>,
  siblings: readonly MermaidBlockEdge[],
): MermaidVisualEdge {
  const parallels = siblings.filter(
      (x) =>
        (x.from === e.from && x.to === e.to) ||
        (x.from === e.to && x.to === e.from),
    ),
    index = parallels.findIndex((x) => x.sourceKey === e.sourceKey),
    port = (index + 1) / (parallels.length + 1),
    loop = e.from === e.to;
  return {
    id: e.sourceKey,
    source: ids.get(e.from)!,
    target: ids.get(e.to)!,
    label: e.label,
    displayLabel: e.label,
    labelEditable: false,
    style: e.style,
    sourceMarker: e.sourceMarker,
    targetMarker: e.targetMarker,
    labelPlacement: "top",
    connectorMode: loop ? "curve" : "orthogonal",
    ...(loop
      ? {
          sourcePosition: [port / 2, 1] as const,
          targetPosition: [0.5 + port / 2, 1] as const,
        }
      : {}),
    familyData: createMermaidVisualFamilyData("block", {
      binding: {
        role: "connection",
        sourceKey: e.sourceKey,
        sourceId: "",
        parentKey: e.parentKey,
      },
      token: e.token,
      invisible: e.invisible,
    }),
  };
}
/** Tight same-row slots cannot contain a horizontal relation label. Route in
 * the lower grid channel instead, retaining distinct shared port fractions. */
export function distributeBlockConnectionPorts(
  edges: readonly MermaidVisualEdge[],
  nodes: readonly MermaidVisualNode[],
  groups: readonly MermaidVisualSubgraph[] = [],
) {
  const distributed = distributeMermaidPorts(edges, nodes, groups);
  return distributed.map((edge) => {
    if (edge.source === edge.target) return edge;
    const a = nodes.find((n) => n.id === edge.source),
      b = nodes.find((n) => n.id === edge.target);
    if (
      !a ||
      !b ||
      blockProjectionBinding(a)?.parentKey !==
        blockProjectionBinding(b)?.parentKey
    )
      return edge;
    if (
      Math.abs(a.y + a.height / 2 - b.y - b.height / 2) >
      Math.min(a.height, b.height) / 4
    )
      return edge;
    const left = a.x < b.x ? a : b,
      right = a.x < b.x ? b : a,
      gap = right.x - left.x - left.width,
      text = measureMermaidGfxText(
        edge.label,
        resolveMermaidGfxProjectionTheme().typography,
      ),
      blocked = nodes.some(
        (n) =>
          n.id !== a.id &&
          n.id !== b.id &&
          blockProjectionBinding(n)?.role === "block" &&
          n.x < right.x &&
          n.x + n.width > left.x + left.width &&
          n.y < left.y + left.height &&
          n.y + n.height > left.y,
      );
    return (edge.label && gap < text.width) || blocked
      ? {
          ...edge,
          labelPlacement: "center" as const,
          sourcePosition: [edge.sourcePosition?.[1] ?? 0.5, 1] as const,
          targetPosition: [edge.targetPosition?.[1] ?? 0.5, 1] as const,
        }
      : edge;
  });
}
export function blockConnectorElementProjection(
  model: MermaidVisualModel,
  e: MermaidVisualEdge,
) {
  if (mermaidVisualFamilyPayload(e.familyData, "block")?.invisible)
    return {
      ...projectNeutralMermaidGfxConnectorElement(e),
      textDisplay: false,
      strokeStyle: StrokeStyle.None,
      strokeWidth: 0,
      frontEndpointStyle: PointStyle.None,
      rearEndpointStyle: PointStyle.None,
    };
  const t = resolveMermaidGfxProjectionTheme(),
    text = measureMermaidGfxText(e.label, t.typography),
    parallels = model.edges.filter(
      (x) =>
        (x.source === e.source && x.target === e.target) ||
        (x.source === e.target && x.target === e.source),
    ),
    index = parallels.findIndex((x) => x.id === e.id);
  const endpointScopes = new Set(
    model.subgraphs
      ?.filter((g) => g.id === e.source || g.id === e.target)
      .map((g) =>
        String(mermaidVisualFamilyPayload(g.familyData, "block")?.bodyKey),
      ),
  );
  const inside = (parent: string | null | undefined): boolean => {
    if (!parent) return false;
    if (endpointScopes.has(parent)) return true;
    const g = model.subgraphs?.find(
      (g) =>
        mermaidVisualFamilyPayload(g.familyData, "block")?.bodyKey === parent,
    );
    return Boolean(g && inside(blockProjectionBinding(g)?.parentKey));
  };
  return {
    ...projectNeutralMermaidGfxConnectorElement(e),
    endpointScale: 0.4,
    labelObstacleKeys: [
      ...model.nodes
        .filter((n) => blockProjectionBinding(n)?.role === "block")
        .map((n) => n.id),
      ...model.edges
        .slice(
          0,
          model.edges.findIndex((x) => x.id === e.id),
        )
        .map((x) => x.id),
    ],
    routingObstacleKeys: model.nodes
      .filter(
        (n) =>
          n.id !== e.source &&
          n.id !== e.target &&
          blockProjectionBinding(n)?.role === "block" &&
          !inside(blockProjectionBinding(n)?.parentKey),
      )
      .map((n) => n.id),
    routingObstacleRegions: Object.fromEntries(
      (model.subgraphs ?? [])
        .filter((g) => g.id !== e.source && g.id !== e.target)
        .map((g) => [
          g.id,
          [
            0,
            0,
            g.width,
            Number(
              mermaidVisualFamilyPayload(g.familyData, "block")?.headerHeight,
            ) || 0,
          ] as const,
        ]),
    ),
    routingClearance: Math.max(
      1,
      Math.min(text.height, t.typography.lineHeight) / 4,
    ),
    routingLaneOffset:
      (index - (parallels.length - 1) / 2) * t.typography.lineHeight * 2,
  };
}

/** Routing and label obstacles are renderer-local Surface properties. A cold
 * owner must hydrate them even when persisted Source and geometry still match. */
export function blockConnectorPresentationMatches(
  model: MermaidVisualModel,
  elements: readonly unknown[],
  connectors: readonly unknown[],
) {
  const ids = new Map<string, string>();
  for (const element of [...elements, ...connectors]) {
    const key =
      readMermaidGfxMeta(element, "mermaidNodeId") ||
      readMermaidGfxMeta(element, "mermaidSubgraphId") ||
      readMermaidGfxMeta(element, "mermaidEdgeId");
    const id = (element as { id?: string }).id;
    if (key && id) ids.set(key, id);
  }
  return model.edges.every((edge) => {
    const connector = connectors.find(
      (element) => readMermaidGfxMeta(element, "mermaidEdgeId") === edge.id,
    ) as Record<string, unknown> | undefined;
    if (!connector) return false;
    const expected = toMermaidConnectorElementProps(
      edge,
      ids,
      undefined,
      blockConnectorElementProjection(model, edge),
    ) as Record<string, unknown>;
    return [
      "labelObstacleIds",
      "routingObstacleIds",
      "routingObstacleRegions",
      "routingClearance",
      "routingLaneOffset",
      "endpointScale",
    ].every(
      (key) =>
        expected[key] === undefined ||
        JSON.stringify(connector[key]) === JSON.stringify(expected[key]),
    );
  });
}
