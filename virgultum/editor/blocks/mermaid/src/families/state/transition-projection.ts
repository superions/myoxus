// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateTransition } from "../../engine/state/index.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import { stateDisplayText } from "./layout.js";
import {
  stateProjectionBinding,
  stateBackgroundForeground,
} from "./gfx-data.js";
/** An attached note occupies its owner's lateral exit. Route to a free face
 * through the existing ports instead of crossing the note or hiding the edge. */
export function stateNoteSafePorts(
  edges: readonly MermaidVisualEdge[],
  nodes: readonly MermaidVisualNode[],
  groups: readonly MermaidVisualSubgraph[],
): MermaidVisualEdge[] {
  const objects = new Map([...nodes, ...groups].map((n) => [n.id, n]));
  return edges.map((edge) => {
    const result = { ...edge };
    for (const end of ["source", "target"] as const) {
      const owner = objects.get(edge[end]),
        other = objects.get(edge[end === "source" ? "target" : "source"]),
        position = edge[end === "source" ? "sourcePosition" : "targetPosition"],
        sourceId = owner && stateProjectionBinding(owner)?.sourceId;
      if (!owner || !other || !position || !sourceId) continue;
      const note = nodes.find(
          (n) =>
            mermaidVisualFamilyPayload(n.familyData, "state")?.noteStateId ===
            sourceId,
        ),
        side =
          note &&
          mermaidVisualFamilyPayload(note.familyData, "state")?.notePlacement;
      if (!(
        (side === "left of" && position[0] === 0) ||
        (side === "right of" && position[0] === 1)
      ))
        continue;
      const bottom =
        edge.source === edge.target
          ? end === "target"
          : other.y + other.height / 2 >= owner.y + owner.height / 2;
      result[end === "source" ? "sourcePosition" : "targetPosition"] = [
        position[1],
        bottom ? 1 : 0,
      ];
    }
    return result;
  });
}
export function projectStateTransition(
  t: MermaidStateTransition,
  ids: ReadonlyMap<string, string>,
  siblings: readonly MermaidStateTransition[],
): MermaidVisualEdge {
  const parallels = siblings.filter(
      (r) =>
        (r.from === t.from && r.to === t.to) ||
        (r.to === t.from && r.from === t.to),
    ),
    index = parallels.findIndex((r) => r.id === t.id),
    port = (index + 1) / (parallels.length + 1),
    loop = t.from === t.to;
  return {
    id: t.id,
    source: ids.get(t.from)!,
    target: ids.get(t.to)!,
    label: t.label,
    displayLabel: stateDisplayText(t.label),
    labelEditable: false,
    labelPlacement: "top",
    linkType: "arrow",
    targetMarker: "arrow",
    style: "solid",
    connectorMode: loop ? "curve" : "orthogonal",
    ...(loop
      ? {
          sourcePosition: [1, port / 2] as const,
          targetPosition: [1, 0.5 + port / 2] as const,
        }
      : {}),
    familyData: createMermaidVisualFamilyData("state", {
      sourceKey: t.id,
      from: t.from,
      to: t.to,
      parentId: t.parentId ?? null,
      regionKey: t.regionKey ?? null,
    }),
  };
}
export function stateConnectorElementProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    parallels = model.edges.filter(
      (e) =>
        (e.source === edge.source && e.target === edge.target) ||
        (e.target === edge.source && e.source === edge.target),
    ),
    index = parallels.findIndex((e) => e.id === edge.id),
    text = measureMermaidGfxText(
      edge.displayLabel ?? edge.label,
      theme.typography,
    ),
    endpointScopes = new Set(
      (model.subgraphs ?? [])
        .filter((g) => g.id === edge.source || g.id === edge.target)
        .map((g) => stateProjectionBinding(g)?.sourceId),
    );
  const insideEndpoint = (parentId: string | null | undefined): boolean => {
    if (!parentId) return false;
    if (endpointScopes.has(parentId)) return true;
    const parent = model.subgraphs?.find(
      (g) => stateProjectionBinding(g)?.sourceId === parentId,
    );
    return Boolean(
      parent && insideEndpoint(stateProjectionBinding(parent)?.parentId),
    );
  };
  const foreground = stateBackgroundForeground(model, [
    model.nodes.find((n) => n.id === edge.source) ??
      model.subgraphs?.find((g) => g.id === edge.source) ??
      {},
    model.nodes.find((n) => n.id === edge.target) ??
      model.subgraphs?.find((g) => g.id === edge.target) ??
      {},
  ]);
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    // The shared arrow geometry is 15 units; State notation uses a small tip.
    endpointScale: 0.4,
    stroke: foreground ?? theme.secondaryTextColor,
    color: foreground ?? theme.textColor,
    // Earlier labels have priority. This directed dependency keeps parallel
    // and self-loop labels apart without mutually chasing one another.
    labelObstacleKeys: [
      ...model.nodes
        .filter((n) => stateProjectionBinding(n)?.role !== "region")
        .map((n) => n.id),
      ...model.edges
        .slice(
          0,
          model.edges.findIndex((e) => e.id === edge.id),
        )
        .map((e) => e.id),
    ],
    routingObstacleKeys: model.nodes
      .filter(
        (n) =>
          n.id !== edge.source &&
          n.id !== edge.target &&
          n.shape !== "text" &&
          stateProjectionBinding(n)?.role !== "region" &&
          !insideEndpoint(stateProjectionBinding(n)?.parentId),
      )
      .map((n) => n.id),
    // Composite bodies contain edges. Protect only the painted header, not
    // the entire container, so child relations can still cross its interior.
    routingObstacleRegions: Object.fromEntries(
      (model.subgraphs ?? [])
        .filter((g) => g.id !== edge.source && g.id !== edge.target)
        .map((g) => [
          g.id,
          [
            0,
            0,
            g.width,
            stateProjectionBinding(g)?.headerHeight ?? 0,
          ] as const,
        ]),
    ),
    routingClearance: Math.max(
      1,
      Math.min(text.height, theme.typography.lineHeight) / 4,
    ),
    routingLaneOffset:
      (index - (parallels.length - 1) / 2) * theme.typography.lineHeight * 2,
  };
}
