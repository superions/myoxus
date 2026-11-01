// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFontString, measureTextInDOM, wrapText } from "@virgultum/gfx-text";
import {
  measureMermaidGfxText,
  measureMermaidGfxTextInk,
  mermaidGfxTypographyForNode,
} from "../../mermaid-gfx-theme.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
} from "../runtime/gfx-model.js";
import { mermaidGraphLayers } from "../runtime/graph-layout.js";
import { semanticMermaidEdgeLabelPlacementForEndpoints } from "../runtime/gfx-element-projection.js";
import { projectedRequirementStyle } from "./style-projection.js";
import {
  requirementEdgeFamilyData,
  requirementEdgeGfxData,
} from "./gfx-data.js";

export function requirementDetailText(detail: MermaidVisualNodeDetail) {
  return detail.value === undefined
    ? detail.label
    : `${detail.label}: ${detail.value}`;
}

/** Measure exactly the displayed strings, including physical line breaks and
 * native font overhang. Geometry may grow; neither Source nor font size changes.
 * The native shape renderer uses DOM line advance, not a fixed property row. */
export function requirementCardMetrics(node: MermaidVisualNode) {
  const sourceStyle = projectedRequirementStyle(node);
  const typography = mermaidGfxTypographyForNode(sourceStyle),
    padding = typography.lineHeight;
  const measure = (text: string, bold = false, width?: number) => {
    const type = {
      ...typography,
      fontWeight: bold
        ? (sourceStyle.fontWeight ?? "bold")
        : typography.fontWeight,
    };
    const { lineHeight, lineGap } = measureTextInDOM(
      type.fontFamily,
      type.fontSize,
      type.fontWeight,
    );
    const advance = Math.max(type.lineHeight, lineHeight + lineGap);
    const renderedText =
      width === undefined ? text : wrapText(text, getFontString(type), width);
    const content = measureMermaidGfxText(renderedText, {
      ...type,
      lineHeight: advance,
    });
    const ink = renderedText
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
      .map((line) => measureMermaidGfxTextInk(line, type));
    return {
      ...content,
      renderedText,
      width: Math.max(
        content.width,
        ...ink.map((line) => line.left + line.right),
      ),
    };
  };
  const rows = (node.details ?? []).filter(
    (detail) => detail.kind !== "separator",
  );
  const stereotype = rows[0],
    stereotypeSize = measure(
      stereotype ? requirementDetailText(stereotype) : "",
    );
  const name = measure(node.label, true),
    nameY = padding / 2 + stereotypeSize.height;
  const headerHeight = nameY + name.height + padding / 2;
  const width = Math.ceil(
    Math.max(
      node.width,
      name.width + padding * 2,
      stereotypeSize.width + padding * 2,
      ...rows.flatMap((detail) =>
        requirementDetailText(detail)
          .split(/\s+/)
          .map((word) => measure(word).width + padding * 2),
      ),
    ),
  );
  let y = headerHeight + padding / 4;
  const details = rows.map((detail, index) => {
    const content =
      index === 0
        ? stereotypeSize
        : measure(requirementDetailText(detail), false, width - padding * 2);
    const top = index === 0 ? padding / 2 : y;
    if (index) y += content.height + padding / 4;
    return {
      id: detail.id,
      x: padding,
      y: top,
      width: content.width,
      height: content.height,
      text: content.renderedText,
    };
  });
  return {
    typography,
    padding,
    nameY,
    headerHeight,
    details,
    width,
    height: Math.ceil(Math.max(headerHeight, y) + padding / 2),
  };
}

/** Only invalid overlaps need repair after measured text grows. Keep all other
 * authored positions; direction-aware deliberate layout has its own command. */
export function separateRequirementCards(nodes: readonly MermaidVisualNode[]) {
  const gap = mermaidGfxTypographyForNode({}).lineHeight;
  const placed: MermaidVisualNode[] = [];
  for (const node of nodes) {
    let y = node.y;
    for (;;) {
      const collision = placed.find(
        (other) =>
          node.x < other.x + other.width &&
          node.x + node.width > other.x &&
          y < other.y + other.height &&
          y + node.height > other.y,
      );
      if (!collision) break;
      y = collision.y + collision.height + gap;
    }
    placed.push(y === node.y ? node : { ...node, y });
  }
  return placed;
}

/** Shared stable ranks own cycles and disconnected roots; this family supplies
 * measured card bounds and label clearance. Calling it is an explicit layout,
 * not a camera operation or an incidental consequence of an object edit. */
export function layoutRequirementGraph(
  model: MermaidVisualModel,
): MermaidVisualModel {
  if (!model.nodes.length) return model;
  const horizontal = model.direction === "LR" || model.direction === "RL",
    reverse = model.direction === "RL" || model.direction === "BT";
  const ranks = mermaidGraphLayers(model.nodes, model.edges),
    lastRank = Math.max(...ranks.values());
  const rows = new Map<number, MermaidVisualNode[]>();
  for (const node of model.nodes) {
    const rank = ranks.get(node.id) ?? 0,
      physical = reverse ? lastRank - rank : rank;
    rows.set(physical, [...(rows.get(physical) ?? []), node]);
  }
  const typography = mermaidGfxTypographyForNode({}),
    crossGap = typography.lineHeight * 2;
  const gap = Math.max(
    crossGap,
    ...model.edges.map((edge) => {
      const label = measureMermaidGfxText(
        edge.displayLabel ?? edge.label,
        typography,
      );
      return (horizontal ? label.width : label.height) + crossGap;
    }),
  );
  const x = Math.min(...model.nodes.map((node) => node.x)),
    y = Math.min(...model.nodes.map((node) => node.y));
  let primary = horizontal ? x : y;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    let cross = horizontal ? y : x;
    for (const node of row) {
      positions.set(node.id, {
        x: horizontal ? primary : cross,
        y: horizontal ? cross : primary,
      });
      cross += (horizontal ? node.height : node.width) + crossGap;
    }
    primary +=
      Math.max(...row.map((node) => (horizontal ? node.width : node.height))) +
      gap;
  }
  const defaults = {
    TB: [
      [0.5, 1],
      [0.5, 0],
    ],
    BT: [
      [0.5, 0],
      [0.5, 1],
    ],
    LR: [
      [1, 0.5],
      [0, 0.5],
    ],
    RL: [
      [0, 0.5],
      [1, 0.5],
    ],
  } as const;
  const [sourcePosition, targetPosition] =
    defaults[(model.direction ?? "TB") as keyof typeof defaults] ?? defaults.TB;
  const matches = (
    position: readonly number[] | undefined,
    derived: readonly number[] | undefined,
  ) =>
    !position ||
    Boolean(
      derived && position[0] === derived[0] && position[1] === derived[1],
    );
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node, ...positions.get(node.id) })),
    edges: model.edges.map((edge) => {
      const data = requirementEdgeGfxData(edge);
      if (!data || edge.source === edge.target) return edge;
      const { family: _family, ...payload } = data;
      const sourceDerived =
          !edge.sourcePortId &&
          matches(edge.sourcePosition, data.layoutSourcePosition),
        targetDerived =
          !edge.targetPortId &&
          matches(edge.targetPosition, data.layoutTargetPosition);
      return {
        ...edge,
        sourcePosition: sourceDerived ? sourcePosition : edge.sourcePosition,
        targetPosition: targetDerived ? targetPosition : edge.targetPosition,
        labelPlacement:
          sourceDerived && targetDerived
            ? semanticMermaidEdgeLabelPlacementForEndpoints({
                sourcePosition,
                targetPosition,
              })
            : edge.labelPlacement,
        familyData: requirementEdgeFamilyData({
          ...payload,
          layoutSourcePosition: sourceDerived ? sourcePosition : undefined,
          layoutTargetPosition: targetDerived ? targetPosition : undefined,
        }),
      };
    }),
  };
}
