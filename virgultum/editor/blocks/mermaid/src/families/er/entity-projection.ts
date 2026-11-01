// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrokeStyle } from "@virgultum/model";
import type { MermaidErEntity } from "../../engine/er/index.js";
import type {
  MermaidVisualNode,
  MermaidVisualNodeDetail,
} from "../runtime/gfx-model.js";
import { erProjectionBinding, erProjectedStyles } from "./gfx-data.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { mermaidMessages as m } from "../../i18n.js";
/** Each field column projects through the same row source key. Geometry-only
 * separator/header children are explicitly excluded from semantic selection. */
export function erAttributeDetails(
  entity: MermaidErEntity,
): MermaidVisualNodeDetail[] {
  return [
    {
      id: `${entity.sourceKey}:identity`,
      kind: "metadata",
      label: entity.id,
      order: 0,
    },
    ...[m.erName(), m.erType(), m.erKeys()].map((label, column) => ({
      id: `${entity.sourceKey}:column:${column}`,
      kind: "metadata" as const,
      label,
      order: column + 1,
    })),
    ...entity.attributes.flatMap((a, row) => [
      ...[a.name, `${a.type}${a.optional ? "?" : ""}`].map((label, column) => ({
        id: column === 0 ? a.id : `${a.id}:column:${column}`,
        sourceKey: a.id,
        kind: "field" as const,
        label,
        order: row * 3 + column,
      })),
      ...(a.keys.length ? a.keys : [""]).map((label, index) => ({
        id: `${a.id}:key:${index}`,
        sourceKey: a.id,
        kind: "field" as const,
        label,
        order: row * 3 + 2,
      })),
    ]),
    {
      id: `${entity.sourceKey}:header-separator`,
      kind: "separator",
      label: "",
      order: 0,
    },
    {
      id: `${entity.sourceKey}:column-separator`,
      kind: "separator",
      label: "",
      order: 1,
    },
  ];
}
export function erNodeElementProjection(
  _model: unknown,
  node: MermaidVisualNode,
) {
  const b = erProjectionBinding(node),
    theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    fontSize: b?.fontSize ?? theme.typography.fontSize,
    fontWeight: "bold",
    strokeColor: theme.borderColor,
    padding: [b?.padding ?? 0, b?.padding ?? 0] as const,
    ...projectMermaidSourceStyle(erProjectedStyles(node)),
  };
}
export function erDetailElementProjection(
  _model: unknown,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  const b = erProjectionBinding(node);
  if (!b) throw new Error("ER detail has no source binding");
  const theme = resolveMermaidGfxProjectionTheme(),
    identity = detail.id.endsWith(":identity"),
    header = detail.kind === "metadata" && !identity,
    separator = detail.kind === "separator",
    keyBadge =
      detail.kind === "field" &&
      detail.id.includes(":key:") &&
      Boolean(detail.label),
    keyIndex = keyBadge
      ? Number(detail.id.slice(detail.id.lastIndexOf(":") + 1))
      : 0,
    keySiblings = (node.details ?? []).filter(
      (d) => d.sourceKey === detail.sourceKey && d.id.includes(":key:"),
    ),
    badgeTypography = {
      ...theme.typography,
      fontSize: b.fontSize,
      fontWeight: "bold",
    },
    badgePadding = b.fontSize / 2,
    badgeOffset = keySiblings
      .slice(0, keyIndex)
      .reduce(
        (sum, d) =>
          sum +
          measureMermaidGfxText(d.label, badgeTypography).width +
          badgePadding * 3,
        0,
      ),
    column = header ? detail.order - 1 : detail.order % 3,
    row = Math.floor(detail.order / 3),
    badgeHeight = Math.min(b.rowHeight, b.fontSize + badgePadding * 3),
    sourceStyle = projectMermaidSourceStyle(erProjectedStyles(node));
  const x =
      identity || separator
        ? 0
        : b.columns.slice(0, column).reduce((a, v) => a + v, 0),
    width = identity || separator ? node.width : b.columns[column]!;
  const y = identity
    ? b.headerHeight / 2
    : separator
      ? detail.order === 0
        ? b.headerHeight
        : b.headerHeight + b.rowHeight
      : header
        ? b.headerHeight
        : b.headerHeight + b.rowHeight * (row + 1);
  return {
    offsetY: 0,
    relativeBound: {
      x: x + (separator ? 0 : b.padding) + (keyBadge ? badgeOffset : 0),
      y: y + (keyBadge ? (b.rowHeight - badgeHeight) / 2 : 0),
      width: keyBadge
        ? measureMermaidGfxText(detail.label, badgeTypography).width +
          badgePadding * 2
        : Math.max(1, width - (separator ? 0 : b.padding * 2)),
      height: separator
        ? 1
        : identity
          ? b.headerHeight / 2
          : keyBadge
            ? badgeHeight
            : b.rowHeight,
    },
    text: detail.label,
    textAlign: "left" as const,
    textVerticalAlign: "center" as const,
    fontSize: b.fontSize,
    fontWeight: header || keyBadge ? "bold" : theme.typography.fontWeight,
    color: identity || header ? theme.secondaryTextColor : theme.textColor,
    ...sourceStyle,
    ...(keyBadge && !Object.hasOwn(erProjectedStyles(node) ?? {}, "color")
      ? { color: theme.textColor }
      : {}),
    fillColor: separator
      ? theme.borderColor
      : keyBadge
        ? theme.secondarySurfaceColor
        : theme.surfaceColor,
    radius: keyBadge ? 0.12 : 0,
    filled: separator || keyBadge,
    selectable: detail.kind === "field",
    textDisplay: !separator,
    padding: keyBadge
      ? ([badgePadding, badgePadding] as const)
      : ([0, 0] as const),
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
  };
}
