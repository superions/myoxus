// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import type { MermaidClassNode } from "../../engine/class/index.js";
import { mermaidGraphLayers } from "../runtime/graph-layout.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
export function classNodeMetrics(
  node: MermaidClassNode,
  padding: number,
  hideEmpty: boolean,
  styles: Readonly<Record<string, string>> = {},
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    size = parseFloat(styles["font-size"] ?? ""),
    scale =
      Number.isFinite(size) && size > 0 ? size / theme.typography.fontSize : 1,
    type = {
      ...theme.typography,
      fontFamily: styles["font-family"] ?? theme.typography.fontFamily,
      fontSize: theme.typography.fontSize * scale,
      lineHeight: theme.typography.lineHeight * scale,
      letterSpacing: theme.typography.letterSpacing * scale,
      fontWeight: styles["font-weight"] ?? theme.typography.fontWeight,
      fontStyle: styles["font-style"] ?? theme.typography.fontStyle,
    };
  const header = [
    ...node.annotations.map((a) => `«${a}»`),
    `${node.label}${node.genericType ? `<${node.genericType}>` : ""}`,
  ].join("\n");
  const rowHeight = type.lineHeight + padding * 2;
  const headerHeight = Math.max(
    rowHeight,
    measureMermaidGfxText(header, type).height + padding * 2,
  );
  const width =
    Math.max(
      measureMermaidGfxText(header, type).width,
      ...node.members.map((m) => measureMermaidGfxText(m.raw, type).width),
    ) +
    padding * 4;
  const attributes = node.members.filter((m) => m.kind === "attribute").length,
    operations = node.members.length - attributes;
  const attributeHeight = attributes
    ? attributes * rowHeight
    : hideEmpty
      ? 0
      : rowHeight;
  const operationHeight = operations
    ? operations * rowHeight
    : hideEmpty
      ? 0
      : rowHeight;
  return {
    header,
    headerHeight,
    rowHeight,
    attributeHeight,
    operationHeight,
    width,
    height: headerHeight + attributeHeight + operationHeight + padding * 2,
  };
}
/** Cold placement only. Reconciliation retains authorized owner geometry. */
export function layoutClassNodes(
  nodes: MermaidVisualNode[],
  direction: string,
  edges: readonly { source: string; target: string; label: string }[],
  spacing = 50,
  nodeSpacing = 50,
) {
  const horizontal = direction === "LR" || direction === "RL";
  const reverse = direction === "RL" || direction === "BT";
  const layers = mermaidGraphLayers(nodes, edges);
  const maxLayer = Math.max(0, ...layers.values());
  const rows = new Map<number, MermaidVisualNode[]>();
  for (const node of nodes) {
    const rank = layers.get(node.id) ?? 0;
    const physical = reverse ? maxLayer - rank : rank;
    rows.set(physical, [...(rows.get(physical) ?? []), node]);
  }
  const typography = resolveMermaidGfxProjectionTheme().typography;
  const gap = Math.max(
    spacing,
    ...edges.map((edge) => {
      const label = measureMermaidGfxText(edge.label, typography);
      return (
        (horizontal ? label.width : label.height) + typography.lineHeight * 2
      );
    }),
  );
  const positions = new Map<string, { x: number; y: number }>();
  let primary = 48;
  for (const [, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    let cross = 48;
    for (const node of row) {
      positions.set(node.id, {
        x: horizontal ? primary : cross,
        y: horizontal ? cross : primary,
      });
      cross += (horizontal ? node.height : node.width) + nodeSpacing;
    }
    primary +=
      Math.max(...row.map((node) => (horizontal ? node.width : node.height))) +
      gap;
  }
  return nodes.map((node) => ({ ...node, ...positions.get(node.id) }));
}
