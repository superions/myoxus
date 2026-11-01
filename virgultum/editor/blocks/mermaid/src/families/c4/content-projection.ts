// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  getFontString,
  getLineWidth,
  measureTextInDOM,
  wrapText,
} from "@virgultum/gfx-text";
import { mermaidPersonGeometry, StrokeStyle } from "@virgultum/model";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
} from "../runtime/gfx-model.js";
import type {
  MermaidGfxDetailElementProjection,
  MermaidGfxNodeElementProjection,
} from "../runtime/gfx-family-hooks-contract.js";
import { c4ProjectedContentStyle, c4NoPaint } from "./style-projection.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import {
  mermaidGfxLabelPadding,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import { c4NodeGfxData } from "./object-data.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import {
  c4ElementDisplayLabel,
  c4StereotypeLabel,
} from "./element-projection.js";
import { c4BoundaryHiddenBy } from "./boundary-projection.js";

type C4ContentRole = "label" | "stereotype" | "technology" | "description";

/** These carriers are presentation roles of one Source owner, not new records. */
export function projectC4MaterializedNode(
  node: MermaidVisualNode,
): MermaidVisualNode {
  const data = c4NodeGfxData(node);
  if (!data) return node;
  const roles: readonly [C4ContentRole, string][] = [
    ["label", node.label],
    ["stereotype", `[${c4StereotypeLabel(data.kind)}]`],
    ["technology", data.effectiveTechnology],
    ["description", data.description],
  ];
  return {
    ...node,
    displayLabel: c4ElementDisplayLabel({
      label: node.label,
      kind: data.kind,
      technology: data.effectiveTechnology,
      description: data.description,
    }),
    details: roles
      .filter(([, text]) => text)
      .map(([role, text], order) => ({
        id: `${node.id}:c4:${role}`,
        kind: "metadata",
        label: text,
        value: role,
        order,
      })),
  };
}

/** Body geometry protects the head, cylinder rims, endcap and component gutters. */
export function c4ContentRegion(node: MermaidVisualNode) {
  const theme = resolveMermaidGfxProjectionTheme();
  const configuredPadding = mermaidVisualFamilyPayload(
    node.familyData,
    "c4",
  )?.contentPadding;
  const [vertical, horizontal] =
    typeof configuredPadding === "number"
      ? [configuredPadding, configuredPadding]
      : mermaidGfxLabelPadding(theme);
  let x = 0,
    y = 0,
    width = node.width,
    height = node.height;
  if (node.shape === "person")
    ({ x, y, width, height } = mermaidPersonGeometry(
      node.width,
      node.height,
    ).textRegion);
  else if (node.shape === "database" || node.shape === "lin-cyl") {
    const rim = Math.min(16, node.height * 0.16);
    y += rim * 2;
    height -= rim * 3;
  } else if (node.shape === "h-cyl") {
    const cap = Math.min(24, node.width * 0.16);
    x += cap;
    width -= cap * 3;
  } else if (node.shape === "fr-rect") {
    x += node.width * 0.12;
    width -= node.width * 0.24;
  }
  return {
    x: x + horizontal,
    y: y + vertical,
    width: width - horizontal * 2,
    height: height - vertical * 2,
  };
}

function contentFont(detail: MermaidVisualNodeDetail) {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    ...theme.typography,
    fontSize:
      detail.value === "label"
        ? theme.typography.fontSize
        : theme.typography.minimumReadableFontSize,
  };
}

function contentRows(node: MermaidVisualNode) {
  const region = c4ContentRegion(node);
  let y = 0;
  const rows = (node.details ?? []).map((detail) => {
    const font = contentFont(detail),
      { fontSize } = font;
    const text = wrapText(
      detail.label,
      getFontString(font),
      Math.max(1, region.width),
    );
    const metrics = measureTextInDOM(
      font.fontFamily,
      fontSize,
      font.fontWeight,
    );
    const height =
      (metrics.lineHeight + metrics.lineGap) * text.split("\n").length;
    if (!Number.isFinite(height) || height < 0)
      throw new Error("C4 content requires finite renderer font metrics");
    const row = { detail, font, text, y, height };
    y += height;
    return row;
  });
  return { rows, region, height: y };
}

/** Use the renderer's metrics and prewrapped text in both persisted/local carriers. */
export function sizeC4ContentNode(node: MermaidVisualNode) {
  let sized = node;
  let minimumContentWidth = 1;
  for (const detail of node.details ?? []) {
    const font = getFontString(contentFont(detail));
    for (const character of new Set(Array.from(detail.label)))
      minimumContentWidth = Math.max(
        minimumContentWidth,
        getLineWidth(character, font),
      );
  }
  if (!Number.isFinite(minimumContentWidth))
    throw new Error("C4 content requires finite renderer glyph metrics");
  for (;;) {
    const overflow = minimumContentWidth - c4ContentRegion(sized).width;
    if (overflow <= 0) break;
    sized = { ...sized, width: Math.ceil(sized.width + overflow) };
  }
  // Head and corner reservations are bounded as height grows; each iteration
  // removes actual overflow until the final renderer region contains every row.
  for (;;) {
    const measured = contentRows(sized),
      overflow = measured.height - measured.region.height;
    if (overflow <= 0) break;
    sized = { ...sized, height: Math.ceil(sized.height + overflow) };
  }
  return sized;
}

export function projectC4NodeElement(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
): MermaidGfxNodeElementProjection {
  const theme = resolveMermaidGfxProjectionTheme(),
    external = c4NodeGfxData(node)?.kind.endsWith("_Ext");
  const style = c4ProjectedContentStyle(node);
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    hidden: !!c4BoundaryHiddenBy(model, node.id),
    textDisplay: false,
    fontSize: theme.typography.fontSize,
    ...(external
      ? {
          fillColor: theme.secondarySurfaceColor,
          strokeColor: theme.secondaryTextColor,
        }
      : {}),
    ...style,
    filled: !c4NoPaint(style.fillColor),
    ...(c4NoPaint(style.strokeColor) ? { strokeStyle: StrokeStyle.None } : {}),
  };
}

export function projectC4ContentElement(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
): MermaidGfxDetailElementProjection {
  const measured = contentRows(node),
    row = measured.rows.find((row) => row.detail.id === detail.id);
  if (!row) throw new Error("C4 content carrier has no owning role");
  const theme = resolveMermaidGfxProjectionTheme(),
    style = c4ProjectedContentStyle(node);
  return {
    offsetY: 0,
    relativeBound: {
      x: measured.region.x,
      y:
        measured.region.y +
        row.y +
        Math.max(0, (measured.region.height - measured.height) / 2),
      width: Math.max(1, measured.region.width),
      height: row.height,
    },
    text: row.text,
    textAlign: "center",
    textVerticalAlign: "top",
    fontFamily: row.font.fontFamily,
    fontSize: row.font.fontSize,
    fontWeight: row.font.fontWeight,
    fontStyle: row.font.fontStyle,
    color:
      (c4NoPaint(style.color) ? "transparent" : style.color) ??
      (detail.value === "stereotype" || detail.value === "technology"
        ? theme.secondaryTextColor
        : theme.textColor),
    filled: false,
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
    padding: [0, 0],
    hidden: !!c4BoundaryHiddenBy(model, node.id),
  };
}
