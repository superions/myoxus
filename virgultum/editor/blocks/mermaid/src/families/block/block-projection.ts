import { projectNeutralMermaidGfxDetailElementStyle } from "../runtime/gfx-detail-projection.js";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pointInPolygon } from "@virgultum/global/gfx";
import { ShapeType, StrokeStyle } from "@virgultum/model";
import type { MermaidBlockDirection } from "../../engine/block/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { blockProjectionBinding } from "./gfx-data.js";
type Point = [number, number];
/** The pinned 11.17.2 blockArrow geometry is direction-set specific, including
 * its triangular multi-direction forms. Only this family interprets Directions;
 * neutral shapes receive bounded normalized technical points. */
export function blockArrowContour(
  directions: readonly MermaidBlockDirection[],
  width: number,
  height: number,
  padding: number,
): Point[] {
  const expanded = new Set(
      directions.flatMap((d) =>
        d === "x" ? ["right", "left"] : d === "y" ? ["up", "down"] : [d],
      ),
    ),
    key = ["right", "left", "up", "down"]
      .filter((d) => expanded.has(d))
      .join("|"),
    p = padding / 2,
    m = height / 2,
    w = width,
    h = height;
  let points: Point[];
  switch (key) {
    case "right|left|up|down":
      points = [
        [0, 0],
        [m, 0],
        [w / 2, 2 * p],
        [w - m, 0],
        [w, 0],
        [w, -h / 3],
        [w + 2 * p, -h / 2],
        [w, (-2 * h) / 3],
        [w, -h],
        [w - m, -h],
        [w / 2, -h - 2 * p],
        [m, -h],
        [0, -h],
        [0, (-2 * h) / 3],
        [-2 * p, -h / 2],
        [0, -h / 3],
      ];
      break;
    case "right|left|up":
      points = [
        [m, 0],
        [w - m, 0],
        [w, -h / 2],
        [w - m, -h],
        [m, -h],
        [0, -h / 2],
      ];
      break;
    case "right|left|down":
      points = [
        [0, 0],
        [m, -h],
        [w - m, -h],
        [w, 0],
      ];
      break;
    case "right|up|down":
      points = [
        [0, 0],
        [w, -m],
        [w, -h + m],
        [0, -h],
      ];
      break;
    case "left|up|down":
      points = [
        [w, 0],
        [0, -m],
        [0, -h + m],
        [w, -h],
      ];
      break;
    case "right|left":
      points = [
        [m, 0],
        [m, -p],
        [w - m, -p],
        [w - m, 0],
        [w, -h / 2],
        [w - m, -h],
        [w - m, -h + p],
        [m, -h + p],
        [m, -h],
        [0, -h / 2],
      ];
      break;
    case "up|down":
      points = [
        [w / 2, 0],
        [0, -p],
        [m, -p],
        [m, -h + p],
        [0, -h + p],
        [w / 2, -h],
        [w, -h + p],
        [w - m, -h + p],
        [w - m, -p],
        [w, -p],
      ];
      break;
    case "right|up":
      points = [
        [0, 0],
        [w, -m],
        [0, -h],
      ];
      break;
    case "right|down":
      points = [
        [0, 0],
        [w, 0],
        [0, -h],
      ];
      break;
    case "left|up":
      points = [
        [w, 0],
        [0, -m],
        [w, -h],
      ];
      break;
    case "left|down":
      points = [
        [w, 0],
        [0, 0],
        [w, -h],
      ];
      break;
    case "right":
      points = [
        [m, -p],
        [w - m, -p],
        [w - m, 0],
        [w, -h / 2],
        [w - m, -h],
        [w - m, -h + p],
        [m, -h + p],
      ];
      break;
    case "left":
      points = [
        [m, 0],
        [m, -p],
        [w - m, -p],
        [w - m, -h + p],
        [m, -h + p],
        [m, -h],
        [0, -h / 2],
      ];
      break;
    case "up":
      points = [
        [m, -p],
        [m, -h + p],
        [0, -h + p],
        [w / 2, -h],
        [w, -h + p],
        [w - m, -h + p],
        [w - m, -p],
      ];
      break;
    case "down":
      points = [
        [w / 2, 0],
        [0, -p],
        [m, -p],
        [m, -h + p],
        [w - m, -h + p],
        [w - m, -p],
        [w, -p],
      ];
      break;
    default:
      return [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
  }
  const minX = Math.min(...points.map((p) => p[0])),
    maxX = Math.max(...points.map((p) => p[0])),
    minY = Math.min(...points.map((p) => p[1])),
    maxY = Math.max(...points.map((p) => p[1]));
  return points.map(([x, y]) => [
    (x - minX) / Math.max(1, maxX - minX),
    (y - minY) / Math.max(1, maxY - minY),
  ]);
}
export function blockNodeElementProjection(
  _model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const payload = mermaidVisualFamilyPayload(node.familyData, "block"),
    theme = resolveMermaidGfxProjectionTheme();
  const styles = payload?.styles;
  const base = projectNeutralMermaidGfxNodeElement(node);
  const contour = payload?.contour;
  if (blockProjectionBinding(node)?.role === "space")
    return {
      ...base,
      textDisplay: false,
      filled: false,
      strokeWidth: 0,
      strokeStyle: StrokeStyle.None,
    };
  return {
    ...base,
    mermaidContour: Array.isArray(contour)
      ? (contour as unknown as Point[])
      : [],
    shapeType: Array.isArray(contour)
      ? ShapeType.MermaidBlockArrow
      : base.shapeType,
    textDisplay: !Array.isArray(contour),
    fontSize: theme.typography.fontSize,
    fontFamily: theme.typography.fontFamily,
    fontStyle: theme.typography.fontStyle,
    fontWeight: theme.typography.fontWeight,
    ...(styles && typeof styles === "object" && !Array.isArray(styles)
      ? projectMermaidSourceStyle(styles as Record<string, string>)
      : {}),
  };
}

/** A normalized inscribed label rectangle keeps triangular direction sets
 * readable at the measured font size, instead of centering on their diagonal. */
export function blockArrowTextBox(contour: Point[]) {
  let best = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    largest = 0;
  for (let xi = 1; xi < 10; xi++)
    for (let yi = 1; yi < 10; yi++) {
      const x = xi / 10,
        y = yi / 10;
      let low = 0,
        high = Math.min(x, 1 - x, y, 1 - y);
      for (let step = 0; step < 12; step++) {
        const half = (low + high) / 2;
        const corners: Point[] = [
          [x - half, y - half],
          [x + half, y - half],
          [x + half, y + half],
          [x - half, y + half],
        ];
        if (corners.every((p) => pointInPolygon(p, contour))) low = half;
        else high = half;
      }
      if (low > largest) {
        largest = low;
        best = { x: x - low, y: y - low, width: low * 2, height: low * 2 };
      }
    }
  return best;
}
export function blockDetailElementProjection(
  _model: MermaidVisualModel,
  node: MermaidVisualNode,
  detail: import("../runtime/gfx-model.js").MermaidVisualNodeDetail,
) {
  const payload = mermaidVisualFamilyPayload(node.familyData, "block"),
    raw = payload?.textBox;
  const box =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, number>)
      : { x: 0, y: 0, width: 1, height: 1 };
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxDetailElementStyle(),
    offsetY: 0,
    relativeBound: {
      x: box.x! * node.width,
      y: box.y! * node.height,
      width: box.width! * node.width,
      height: box.height! * node.height,
    },
    text: detail.label,
    fontSize: theme.typography.fontSize,
    fontFamily: theme.typography.fontFamily,
    fontStyle: theme.typography.fontStyle,
    fontWeight: theme.typography.fontWeight,
    padding: [0, 0] as const,
    textAlign: "center" as const,
    textVerticalAlign: "center" as const,
    ...projectMermaidSourceStyle(payload?.styles),
    // This child renders only text. Canvas ignores a zero lineWidth assignment;
    // None also prevents an inherited contour stroke from framing the label.
    filled: false,
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
  };
}
