// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MindmapLayoutType as LayoutType,
  MindmapDesign as MindmapStyle,
} from "./types.js";
import {
  mindmapNodeDesign,
  mindmapBranchDesign,
  mindmapConnectorMode,
} from "./designs.js";
import {
  resolveMermaidGfxTheme,
  resolveMermaidGfxHeadingFont,
  resolveMermaidGfxProjectionTheme,
} from "../../../mermaid-gfx-theme.js";
import { TextUtils } from "@virgultum/block-surface";
import { sourceValuesEqual } from "../../../engine/source-yaml.js";
import type { MermaidMindmapModel } from "../../../engine/mindmap/index.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import type {
  MindmapNodeAppearance,
  MindmapBranchAppearance,
} from "./designs.js";

export { MindmapLayoutType, MindmapDesign } from "./types.js";
export { StrokeStyle as MindmapStrokeStyle } from "@virgultum/model";
export type MindmapSettingsAction = {
  type: "settings";
  nativeConfig?: Partial<
    import("../../../engine/mindmap/commands/metadata-commands.js").MindmapNativeConfig
  >;
  layout?: LayoutType;
  design?: MindmapStyle;
  node?: { key: string; appearance: MindmapNodeAppearance | null };
  branch?: { key: string; appearance: MindmapBranchAppearance | null };
};

/** Layout, design and object appearance are projection data, never MMD syntax. */
export function changeMindmapProjection(
  visual: MermaidVisualModel,
  model: MermaidMindmapModel,
  action: MindmapSettingsAction,
) {
  const before = readMindmapProjectionOptions(visual);
  for (const edit of [action.node, action.branch]) {
    const appearance = edit?.appearance;
    if (!appearance) continue;
    if (
      (appearance.strokeWidth !== undefined &&
        (!Number.isFinite(appearance.strokeWidth) ||
          appearance.strokeWidth < 0)) ||
      ("fontSize" in appearance &&
        appearance.fontSize !== undefined &&
        (typeof appearance.fontSize !== "number" ||
          !Number.isFinite(appearance.fontSize) ||
          appearance.fontSize <= 0))
    )
      return null;
  }

  if (
    (action.layout !== undefined &&
      ![LayoutType.LEFT, LayoutType.RIGHT, LayoutType.BALANCE].includes(
        action.layout,
      )) ||
    (action.design !== undefined &&
      ![
        MindmapStyle.ONE,
        MindmapStyle.TWO,
        MindmapStyle.THREE,
        MindmapStyle.FOUR,
      ].includes(action.design)) ||
    [action.node, action.branch].some(
      (edit) =>
        edit && !model.nodes.some((node) => node.sourceKey === edit.key),
    ) ||
    (action.branch &&
      model.nodes.some(
        (node) => node.root && node.sourceKey === action.branch!.key,
      ))
  )
    return null;
  const nodeAppearance = new Map(before.nodeAppearance),
    branchAppearance = new Map(before.branchAppearance);
  if (action.node) {
    if (action.node.appearance)
      nodeAppearance.set(action.node.key, action.node.appearance);
    else nodeAppearance.delete(action.node.key);
  }
  if (action.branch) {
    if (action.branch.appearance)
      branchAppearance.set(action.branch.key, action.branch.appearance);
    else branchAppearance.delete(action.branch.key);
  }
  const options = {
    ...before,
    layout: action.layout ?? before.layout,
    design: action.design ?? before.design,
    nodeAppearance,
    branchAppearance,
  };
  return {
    options,
    changed:
      options.layout !== before.layout ||
      options.design !== before.design ||
      !sourceValuesEqual(
        [...nodeAppearance],
        [...(before.nodeAppearance ?? [])],
      ) ||
      !sourceValuesEqual(
        [...branchAppearance],
        [...(before.branchAppearance ?? [])],
      ),
  };
}

export function mindmapDesignPreview(design: MindmapStyle) {
  const theme = resolveMermaidGfxProjectionTheme();
  // Canvas accepts semantic property names; SVG paint attributes need var().
  const paint = (value: string | undefined) =>
    value?.startsWith("--") ? `var(${value})` : value;
  const node = (path: number[], root: boolean) => {
    const style = mindmapNodeDesign(design, path, root, "default", theme);
    return {
      ...style,
      color: paint(style.color),
      strokeColor: paint(style.strokeColor),
      fillColor: paint(style.fillColor),
    };
  };
  return {
    root: node([0], true),
    nodes: [0, 1, 2].map((index) => node([0, index], false)),
    branches: [0, 1, 2].map((index) => {
      const branch = mindmapBranchDesign(design, [0, index], theme);
      return {
        ...branch,
        stroke: paint(branch.stroke),
        mode: mindmapConnectorMode(branch.mode),
      };
    }),
  };
}

export function mindmapProjectionFingerprint(
  options: import("./layout.js").MindmapProjectionOptions,
) {
  return JSON.stringify([
    options.layout,
    options.design,
    [...(options.rootSides ?? [])],
    [...(options.collapsed ?? [])],
    [...(options.nodeAppearance ?? [])],
    [...(options.branchAppearance ?? [])],
  ]);
}

/** Choices retain server-owned paint references; RGB is only the local swatch label. */
export function mindmapAppearanceChoices() {
  const projected = resolveMermaidGfxProjectionTheme(),
    local = resolveMermaidGfxTheme();
  const roles = [
    "textColor",
    "secondaryTextColor",
    "primaryColor",
    "processingColor",
    "errorColor",
    "warningColor",
    "successColor",
    "surfaceColor",
    "secondarySurfaceColor",
    "processingSurfaceColor",
    "warningSurfaceColor",
    "successSurfaceColor",
  ] as const;
  const heading = resolveMermaidGfxHeadingFont();
  return {
    palette: roles.map((role) => ({
      value: projected[role],
      label: local[role],
      color: `var(${projected[role]})`,
    })),
    fonts: [
      ...new Set([
        local.typography.fontFamily,
        ...(heading ? [heading.fontFamily] : []),
      ]),
    ].map((value) => ({
      value,
      label: TextUtils.getFontFamilyName(value),
    })),
  };
}
