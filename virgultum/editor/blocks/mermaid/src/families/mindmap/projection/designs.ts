// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapDesign as MindmapStyle } from "./types.js";
import { mindmapStyleGetters } from "./style-getters.js";
import { ConnectorMode, StrokeStyle } from "@virgultum/model";
import type {
  MermaidGfxElementStyleProjection,
  MermaidGfxConnectorElementProjection,
} from "../../runtime/gfx-family-hooks-contract.js";
import type {
  MermaidGfxJsonObject,
  MermaidGfxJsonValue,
} from "../../runtime/gfx-family-data.js";
import type { MermaidGfxTheme } from "../../../mermaid-gfx-theme.js";
import type { MermaidMindmapShape } from "../../../engine/mindmap/index.js";

export type MindmapNodeAppearance = Pick<
  MermaidGfxElementStyleProjection,
  | "color"
  | "fillColor"
  | "filled"
  | "strokeColor"
  | "strokeWidth"
  | "strokeStyle"
  | "fontFamily"
  | "fontSize"
  | "fontStyle"
  | "fontWeight"
  | "textDecoration"
>;
export type MindmapBranchAppearance = Pick<
  MermaidGfxElementStyleProjection,
  "strokeColor" | "strokeWidth" | "strokeStyle"
>;
const branches = [
  "primaryColor",
  "errorColor",
  "warningColor",
  "processingColor",
  "successColor",
  "secondaryTextColor",
] as const;
const depths = ["warningColor", "successColor", "processingColor"] as const;
const fills = [
  "processingSurfaceColor",
  "successSurfaceColor",
  "warningSurfaceColor",
] as const;

/** Keep native hierarchy/geometry, but resolve every visible color through the
 * existing server-projected GFX palette and neutral theme roles. */
export function mindmapNodeDesign(
  design: MindmapStyle,
  path: number[],
  root: boolean,
  shape: MermaidMindmapShape,
  theme: MermaidGfxTheme,
  appearance: MindmapNodeAppearance = {},
): MermaidGfxElementStyleProjection & { radius: number } {
  const getter = mindmapStyleGetters[design],
    native = root ? getter.root : getter.getNodeStyle(path).node;
  const branch = theme[branches[(path[1] ?? 0) % branches.length]];
  let strokeColor = root ? theme.processingColor : branch;
  let fillColor = theme.surfaceColor,
    color = theme.textColor;
  if (design === MindmapStyle.TWO) {
    strokeColor = theme.textColor;
    fillColor = root
      ? theme.warningSurfaceColor
      : theme[fills[Math.min(Math.max(path.length - 2, 0), fills.length - 1)]];
    color = theme.textColor;
  } else if (design === MindmapStyle.THREE) {
    strokeColor = theme[depths[Math.max(path.length - 2, 0) % depths.length]];
    if (root) {
      fillColor = theme.warningSurfaceColor;
      color = theme.textColor;
    }
  }
  const explicit = shape !== "default";
  return {
    color,
    fillColor,
    strokeColor,
    filled: design === MindmapStyle.FOUR ? explicit : native.filled,
    strokeWidth: explicit
      ? Math.max(native.strokeWidth, 2)
      : native.strokeWidth,
    strokeStyle: StrokeStyle.Solid,
    radius:
      shape === "square"
        ? 0
        : shape === "rounded"
          ? Math.max(native.radius, 8)
          : native.radius,
    // Soft blur remains governed by the existing renderer's local feature flag.
    // Hard native shadows (blur=0) remain effective without changing awareness.
    shadow: native.shadow
      ? {
          blur: native.shadow.blur,
          offsetX: native.shadow.offsetX,
          offsetY: native.shadow.offsetY,
          color: native.shadow.blur === 0 ? theme.textColor : theme.borderColor,
        }
      : null,
    ...appearance,
  };
}

export function mindmapBranchDesign(
  design: MindmapStyle,
  path: number[],
  theme: MermaidGfxTheme,
  appearance: MindmapBranchAppearance = {},
): Required<
  Pick<
    MermaidGfxConnectorElementProjection,
    "stroke" | "strokeWidth" | "strokeStyle" | "mode"
  >
> {
  const native = mindmapStyleGetters[design].getNodeStyle(path).connector;
  const role =
    design === MindmapStyle.TWO
      ? "textColor"
      : design === MindmapStyle.THREE
        ? depths[Math.max(path.length - 2, 0) % depths.length]
        : branches[(path[1] ?? 0) % branches.length];
  return {
    stroke: appearance.strokeColor ?? theme[role],
    strokeWidth: appearance.strokeWidth ?? native.strokeWidth,
    strokeStyle: appearance.strokeStyle ?? native.strokeStyle,
    mode: native.mode,
  };
}

/** Only appearance roles are accepted: no second tree, XY or source shape. */
export function readMindmapAppearance(
  value: MermaidGfxJsonValue | undefined,
): MindmapNodeAppearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as MermaidGfxJsonObject;
  const result: {
    -readonly [Key in keyof MindmapNodeAppearance]: MindmapNodeAppearance[Key];
  } = {};
  for (const field of [
    "color",
    "fillColor",
    "strokeColor",
    "fontFamily",
    "fontWeight",
  ] as const) {
    const value = record[field];
    if (typeof value === "string" && value) result[field] = value;
  }
  if (record.fontStyle === "normal" || record.fontStyle === "italic")
    result.fontStyle = record.fontStyle;
  if (typeof record.filled === "boolean") result.filled = record.filled;
  if (
    typeof record.fontSize === "number" &&
    Number.isFinite(record.fontSize) &&
    record.fontSize > 0
  )
    result.fontSize = record.fontSize;
  if (
    typeof record.strokeWidth === "number" &&
    Number.isFinite(record.strokeWidth) &&
    record.strokeWidth >= 0
  )
    result.strokeWidth = record.strokeWidth;
  if (
    record.strokeStyle === StrokeStyle.Solid ||
    record.strokeStyle === StrokeStyle.Dash ||
    record.strokeStyle === StrokeStyle.None
  )
    result.strokeStyle = record.strokeStyle;
  if (record.textDecoration === "none" || record.textDecoration === "underline")
    result.textDecoration = record.textDecoration;
  return Object.freeze(result);
}

export function readMindmapAppearanceMap(
  value: MermaidGfxJsonValue | undefined,
) {
  const result = new Map<string, MindmapNodeAppearance>();
  if (Array.isArray(value))
    for (const entry of value) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const appearance = readMindmapAppearance(entry[1]);
      if (appearance) result.set(entry[0], appearance);
    }
  return result;
}

export function mindmapConnectorMode(mode: ConnectorMode) {
  return mode === ConnectorMode.Orthogonal
    ? ("orthogonal" as const)
    : mode === ConnectorMode.Curve
      ? ("curve" as const)
      : ("straight" as const);
}
