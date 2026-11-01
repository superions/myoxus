// SPDX-License-Identifier: AGPL-3.0-or-later

import { c4ProjectedContentStyle, c4NoPaint } from "./style-projection.js";
import { C4_CALLS } from "../../engine/c4/runtime-contract.js";
import type {
  MermaidC4Boundary,
  MermaidC4Model,
} from "../../engine/c4/model.js";

import { getFontString, measureTextInDOM, wrapText } from "@virgultum/gfx-text";
import {
  mermaidGfxLabelPadding,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import type {
  MermaidVisualModel,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { c4BoundaryPresentation } from "./gfx-data.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { StrokeStyle } from "@virgultum/model";

export function c4BoundaryDisplayLabel(boundary: {
  label: string;
  kind: string;
  boundaryType: string;
  description: string;
}) {
  return [
    boundary.label,
    `[${boundary.kind}${boundary.boundaryType ? `: ${boundary.boundaryType}` : ""}]`,
    boundary.description,
  ]
    .filter(Boolean)
    .join("\n");
}
/** Declaration fields follow the call's slots, including injected and ignored values. */
export function c4BoundaryCallFields(kind: string) {
  const contract = C4_CALLS[kind];
  if (contract?.category !== "boundary") return [];
  return contract.slots.map((field, argumentIndex) => ({
    field,
    argumentIndex,
    effective: !contract.ignoredSlots?.includes(argumentIndex),
  }));
}
export function c4BoundarySourceData(
  model: MermaidC4Model,
  boundary: MermaidC4Boundary,
) {
  return {
    alias: boundary.alias,
    sourceKind: boundary.kind,
    nodeType: boundary.nodeType,
    parentAlias: boundary.parentId,
    elementAliases: model.elements
      .filter((e) => e.boundaryId === boundary.alias)
      .map((e) => e.alias),
    boundaryAliases: model.boundaries
      .filter((b) => b.parentId === boundary.alias)
      .map((b) => b.alias),
    declarations: model.occurrences.filter(
      (r) =>
        r.category === "boundary" &&
        r.selectionId === boundary.resolution?.selectionId,
    ),
    fields: c4BoundaryCallFields(boundary.kind),
  };
}

/** Header geometry uses the same font/wrapping contract as the materialized text. */
function c4BoundaryHeaderContent(
  boundary: Pick<
    MermaidVisualSubgraph,
    "width" | "title" | "displayLabel" | "familyData"
  >,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    [vertical, horizontal] = c4BoundaryLabelPadding();
  const font = { ...theme.typography, ...c4ProjectedContentStyle(boundary) };
  const text = wrapText(
    boundary.displayLabel ?? boundary.title,
    getFontString(font),
    Math.max(1, boundary.width - horizontal * 2),
  );
  const metrics = measureTextInDOM(
    font.fontFamily,
    font.fontSize,
    font.fontWeight,
  );
  // Native Boundary sprite reserves 48×48 geometry without drawing an image.
  const sprite = mermaidVisualFamilyPayload(boundary.familyData, "c4")
    ?.effectiveSprite
    ? 48
    : 0;
  const height = Math.ceil(
    text.split("\n").length * (metrics.lineHeight + metrics.lineGap) +
      vertical * 2 +
      sprite,
  );
  if (!Number.isFinite(height))
    throw new Error("C4 header requires finite renderer font metrics");
  return { text, height, padding: [vertical + sprite, horizontal] as const };
}
export function c4BoundaryHeaderHeight(
  boundary: Pick<
    MermaidVisualSubgraph,
    "width" | "title" | "displayLabel" | "familyData"
  >,
) {
  return c4BoundaryHeaderContent(boundary).height;
}
/** Renderer geometry reserves the shared glyph's hit rectangle from header text. */
export function c4BoundaryCollapseControlSize() {
  return resolveMermaidGfxProjectionTheme().typography.fontSize * 2;
}
export function c4BoundaryLabelPadding(): readonly [number, number] {
  const [vertical, horizontal] = mermaidGfxLabelPadding(
    resolveMermaidGfxProjectionTheme(),
  );
  return [vertical, horizontal + c4BoundaryCollapseControlSize()];
}
/** Native C4 boundary geometry and its shared collapse control. */
export function projectC4BoundaryElement(
  model: MermaidVisualModel,
  group: MermaidVisualSubgraph,
) {
  const content = c4BoundaryHeaderContent(group);
  const style = c4ProjectedContentStyle(group);
  const nativeNode = mermaidVisualFamilyPayload(
    group.familyData,
    "c4",
  )?.nativeNode;
  return {
    ...projectNeutralMermaidGfxSubgraphElement(),
    // These are native C4 document-body dimensions, separate from UI chrome.
    radius: Math.min(
      0.5,
      2.5 / Math.max(1, Math.min(group.width, group.height)),
    ),
    strokeWidth: 1,
    strokeStyle: nativeNode ? StrokeStyle.Solid : StrokeStyle.Dash,
    filled: !!style.fillColor && !c4NoPaint(style.fillColor),
    hidden: !!c4BoundaryHiddenBy(model, group.id),
    subgraphHeaderHeight: content.height,
    padding: content.padding,
    text: content.text,
    textDisplay: !!content.text,
    mermaidSubgraphCollapsible: true,
    mermaidSubgraphCollapsed: !!c4BoundaryPresentation(group.familyData)
      .collapsed,
    mermaidSubgraphCollapseControlSize: c4BoundaryCollapseControlSize(),
    ...style,
    ...(c4NoPaint(style.color) ? { color: "transparent" } : {}),
    ...(c4NoPaint(style.strokeColor) ? { strokeStyle: StrokeStyle.None } : {}),
  };
}
export function c4BoundaryHiddenBy(
  model: MermaidVisualModel,
  id: string,
): string | undefined {
  const groups = new Map((model.subgraphs ?? []).map((g) => [g.id, g]));
  const direct = groups.has(id)
    ? mermaidVisualFamilyPayload(groups.get(id)!.familyData, "c4")
        ?.sourceParentId
    : (model.subgraphs ?? []).find((g) => g.nodeIds.includes(id))?.id;
  let parent = typeof direct === "string" ? direct : undefined;
  const seen = new Set<string>();
  let collapsed: string | undefined;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const group = groups.get(parent);
    if (!group) break;
    if (c4BoundaryPresentation(group.familyData).collapsed) collapsed = parent;
    const next = mermaidVisualFamilyPayload(
      group.familyData,
      "c4",
    )?.sourceParentId;
    parent = typeof next === "string" ? next : undefined;
  }
  return collapsed;
}
/** Keep every semantic child and edge. Only projection attachments change; an
 * internal edge is hidden and an external edge retains its original endpoints. */
export function projectC4BoundaryPresentation(
  model: MermaidVisualModel,
): MermaidVisualModel {
  if (model.diagramType !== "c4") return model;
  return {
    ...model,
    subgraphs: model.subgraphs?.map((group) => {
      const p = c4BoundaryPresentation(group.familyData);
      return p.collapsed
        ? { ...group, height: c4BoundaryHeaderHeight(group) }
        : group;
    }),
    edges: model.edges.map((edge) => {
      const source = c4BoundaryHiddenBy(model, edge.source),
        target = c4BoundaryHiddenBy(model, edge.target);
      return { ...edge, sourceAttachment: source, targetAttachment: target };
    }),
  };
}
export function c4EdgeHidden(
  model: MermaidVisualModel,
  edge: MermaidVisualModel["edges"][number],
) {
  const source = c4BoundaryHiddenBy(model, edge.source),
    target = c4BoundaryHiddenBy(model, edge.target);
  return !!source && source === target;
}
/** A presentation command returns the existing model for no-op and null for an
 * invalid selection. It cannot write Source or remove a materialized child. */
export function setC4BoundaryCollapsed(
  model: MermaidVisualModel,
  selectionId: string,
  collapsed: boolean,
): MermaidVisualModel | null {
  if (model.diagramType !== "c4") return null;
  const group = model.subgraphs?.find((g) => g.id === selectionId);
  if (!group) return null;
  const p = c4BoundaryPresentation(group.familyData);
  if (!!p.collapsed === collapsed) return model;
  const expanded = p.expandedBounds;
  if (!collapsed && !expanded) return null;
  return projectC4BoundaryPresentation({
    ...model,
    subgraphs: model.subgraphs!.map((g) =>
      g.id !== selectionId
        ? g
        : {
            ...g,
            ...(collapsed || !expanded
              ? {}
              : { width: expanded.width, height: expanded.height }),
            familyData: createMermaidVisualFamilyData("c4", {
              ...mermaidVisualFamilyPayload(g.familyData, "c4"),
              collapsed,
              expandedBounds: collapsed
                ? { x: g.x, y: g.y, width: g.width, height: g.height }
                : { ...expanded!, x: g.x, y: g.y },
            }),
          },
    ),
  });
}
