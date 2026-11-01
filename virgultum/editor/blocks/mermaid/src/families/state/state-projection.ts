// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrokeStyle } from "@virgultum/model";
import {
  stateEffectiveDescriptions,
  type MermaidStateNode,
} from "../../engine/state/index.js";
import type { StateConfig } from "../../engine/state/config.js";
import type {
  MermaidVisualNode,
  MermaidVisualNodeDetail,
  MermaidVisualModel,
} from "../runtime/gfx-model.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { stateContentMetrics, stateDisplayText } from "./layout.js";
import {
  stateProjectionBinding,
  stateProjectedStyles,
  stateProjectedRadius,
  stateBackgroundForeground,
} from "./gfx-data.js";

export function projectStateNode(
  node: MermaidStateNode,
  config: StateConfig,
  styles: Readonly<Record<string, string>>,
  verticalFork = false,
): MermaidVisualNode {
  const metrics = stateContentMetrics(node, config, styles),
    body = stateEffectiveDescriptions(node).slice(1);
  return {
    id: node.sourceKey!,
    label: node.label,
    displayLabel: node.kind === "state" ? stateDisplayText(node.label) : "",
    labelEditable: false,
    shape:
      node.kind === "state"
        ? "rounded"
        : node.kind === "choice"
          ? "diamond"
          : node.kind === "fork" || node.kind === "join"
            ? "fork"
            : node.kind === "end"
              ? "doublecircle"
              : "circle",
    textAlign: "left",
    textVerticalAlign: "top",
    x: 0,
    y: 0,
    width:
      verticalFork && (node.kind === "fork" || node.kind === "join")
        ? metrics.height
        : metrics.width,
    height:
      verticalFork && (node.kind === "fork" || node.kind === "join")
        ? metrics.width
        : metrics.height,
    details: [
      ...body.map((d, order) => ({
        id: d.id,
        sourceKey: d.id,
        kind: "field" as const,
        label: stateDisplayText(d.text),
        value: d.text,
        order,
      })),
      ...(body.length
        ? [
            {
              id: `${node.sourceKey}:header-divider`,
              kind: "separator" as const,
              label: "",
              order: -1,
            },
          ]
        : []),
    ],
    familyData: createMermaidVisualFamilyData("state", {
      role: "node",
      nodeKind: node.kind,
      binding: {
        sourceKey: node.sourceKey,
        sourceId: node.id,
        role: "state",
        kind: node.kind,
        parentId: node.parentId ?? null,
        regionKey: node.regionKey ?? null,
        ...metrics,
        ...(verticalFork && (node.kind === "fork" || node.kind === "join")
          ? { width: metrics.height, height: metrics.width }
          : {}),
      },
      styles,
    }),
  };
}
export function stateNodeElementProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const binding = stateProjectionBinding(node),
    theme = resolveMermaidGfxProjectionTheme(),
    styles = projectMermaidSourceStyle(stateProjectedStyles(node)),
    foreground = stateBackgroundForeground(model, [node]) ?? theme.textColor,
    pseudo = binding?.role === "state" && binding.kind !== "state";
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    ...(node.shape === "rounded"
      ? { radius: stateProjectedRadius(model, node.width, node.height) }
      : {}),
    fontSize: binding?.fontSize ?? theme.typography.fontSize,
    padding: [binding?.padding ?? 0, binding?.padding ?? 0] as const,
    textDisplay: !pseudo,
    ...(pseudo && binding?.kind !== "choice"
      ? {
          fillColor: foreground,
          strokeColor: foreground,
          filled: binding?.kind !== "end",
          innerCircleFilled: binding?.kind === "end",
        }
      : {}),
    ...styles,
  };
}

/** Resizing cannot hide Source-owned text or distort a terminal's circular
 * notation. Free movement and larger authored bounds remain presentation. */
export function normalizeStateNodeDimensions(
  node: MermaidVisualNode,
): MermaidVisualNode {
  const content = stateProjectionBinding(node);
  const width = Math.max(node.width, content?.width ?? 0),
    height = Math.max(node.height, content?.height ?? 0);
  const terminal = content?.kind === "start" || content?.kind === "end";
  return {
    ...node,
    width: terminal ? Math.max(width, height) : width,
    height: terminal ? Math.max(width, height) : height,
  };
}
/** Detail rows are text on the parent's authored fill. They have no generic
 * shape chrome; shared relative bounds also anchor hit-testing and editing. */
export function stateDetailElementProjection(
  _model: unknown,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  const b = stateProjectionBinding(node);
  if (!b) throw new Error("State detail has no Source binding");
  const row = b.rows.find((r) => r.key === detail.sourceKey),
    separator = detail.kind === "separator",
    theme = resolveMermaidGfxProjectionTheme();
  return {
    offsetY: 0,
    relativeBound: {
      x: separator ? 0 : b.padding,
      y: separator ? b.headerHeight : (row?.y ?? b.headerHeight),
      width: node.width - (separator ? 0 : b.padding * 2),
      height: separator ? 1 : (row?.height ?? b.fontSize),
    },
    text: detail.label,
    textAlign: "left" as const,
    textVerticalAlign: "top" as const,
    fontSize: b.fontSize,
    padding: [0, 0] as const,
    ...projectMermaidSourceStyle(stateProjectedStyles(node)),
    fillColor: theme.borderColor,
    filled: separator,
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
    selectable: !separator,
    textDisplay: !separator,
  };
}
