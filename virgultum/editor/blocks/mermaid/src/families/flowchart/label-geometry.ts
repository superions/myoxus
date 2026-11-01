// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFontString, wrapText } from "@virgultum/gfx-text";
import {
  measureMermaidGfxText,
  measureMermaidGfxTextInk,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxTheme,
  type MermaidGfxTypography,
} from "../../mermaid-gfx-theme.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";

/** A centered rectangle wholly inside the contour, before text clearance. */
function innerRatio(shape: MermaidVisualNode["shape"]) {
  if (shape === "diamond" || shape === "diam") return [0.65, 0.35] as const;
  if (
    [
      "circle",
      "doublecircle",
      "f-circ",
      "fr-circ",
      "sm-circ",
      "cross-circ",
    ].includes(shape)
  )
    return [Math.SQRT1_2, Math.SQRT1_2] as const;
  if (shape === "tri" || shape === "flip-tri") return [0.45, 0.35] as const;
  if (
    [
      "hexagon",
      "hourglass",
      "lean-l",
      "lean-r",
      "parallelogram",
      "trap-b",
      "trap-t",
      "trapezoid",
    ].includes(shape)
  )
    return [0.7, 0.7] as const;
  return [1, 1] as const;
}

export function flowchartLabelTypography(style: {
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
}) {
  const theme = resolveMermaidGfxTheme();
  return mermaidGfxTypographyForNode(
    {
      ...style,
      fontSize: style.fontSize ?? theme.typography.sectionFontSize,
    },
    theme,
  );
}

function labelClearance(
  type: MermaidGfxTypography,
  shape: MermaidVisualNode["shape"],
) {
  // The diamond's inscribed box already restricts both axes. A second full
  // inset needlessly splits short words inside otherwise sufficient contours.
  const scale = shape === "diamond" || shape === "diam" ? 0.5 : 1;
  return { x: (type.lineHeight * scale) / 2, y: (type.lineHeight * scale) / 4 };
}

export function measureFlowchartNode(
  node: MermaidVisualNode,
  type: MermaidGfxTypography,
) {
  const label = node.displayLabel ?? node.label;
  const text = wrapText(label, getFontString(type), type.fontSize * 12);
  const measured = measureMermaidGfxText(text, type);
  const inkWidth = Math.max(
    0,
    ...text.split("\n").map((line) => {
      const ink = measureMermaidGfxTextInk(line, type);
      return ink.left + ink.right;
    }),
  );
  const clearance = labelClearance(type, node.shape);
  const [rx, ry] = innerRatio(node.shape);
  let width = Math.max(
    type.lineHeight * 4,
    (Math.max(measured.width, inkWidth) + clearance.x * 2) / rx,
  );
  let height = Math.max(
    type.lineHeight * 2,
    (measured.height + clearance.y * 2) / ry,
  );
  if (rx === Math.SQRT1_2) width = height = Math.max(width, height);
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

/** Native Canvas and SVG use the same wrapped label and line height. Source
 * text and persisted manual geometry are never rewritten by this projection. */
export function projectFlowchartNodeLabel(
  node: MermaidVisualNode,
  type: MermaidGfxTypography,
) {
  const [rx, ry] = innerRatio(node.shape);
  const clearance = labelClearance(type, node.shape);
  const width = Math.max(1, node.width * rx - clearance.x * 2);
  const text = wrapText(
    node.displayLabel ?? node.label,
    getFontString(type),
    width,
  );
  // A retained/manual contour can wrap more lines than a fresh measured node.
  // Enclose that same centered block so opening its native editor does not
  // resize the contour merely to reproduce an already painted label.
  const height = Math.min(
    node.height,
    Math.max(
      1,
      node.height * ry - clearance.y * 2,
      measureMermaidGfxText(text, type).height,
    ),
  );
  return {
    runs: [
      {
        text,
        bold: false,
        italic: false,
      },
    ],
    box: {
      x: (node.width - width) / 2,
      y: (node.height - height) / 2,
      width,
      height,
    },
    lineHeight: type.lineHeight,
  };
}
