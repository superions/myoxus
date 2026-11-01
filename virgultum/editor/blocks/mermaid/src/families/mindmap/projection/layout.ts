// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MindmapLayoutType as LayoutType,
  MindmapDesign as MindmapStyle,
} from "./types.js";
import { mindmapStyleGetters } from "./style-getters.js";
import { Bound } from "@virgultum/global/gfx";
import { planMindmapLayout } from "./layout-plan.js";
import { measureTextInDOM } from "@virgultum/gfx-text";

import type {
  MermaidMindmapModel,
  MermaidMindmapNode,
} from "../../../engine/mindmap/index.js";
import {
  measureMermaidGfxText,
  measureMermaidGfxTextInk,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxProjectionTheme,
  resolveMermaidGfxHeadingFont,
  type MermaidGfxTypography,
} from "../../../mermaid-gfx-theme.js";
import type {
  MindmapNodeAppearance,
  MindmapBranchAppearance,
} from "./designs.js";
import {
  mindmapMarkdownRuns,
  mindmapIconResource,
  type MindmapTextRun,
} from "./decorations.js";

export type MindmapProjectionOptions = Readonly<{
  layout?: LayoutType;
  design?: MindmapStyle;
  rootSides?: ReadonlyMap<string, LayoutType.LEFT | LayoutType.RIGHT>;
  collapsed?: ReadonlySet<string>;
  nodeAppearance?: ReadonlyMap<string, MindmapNodeAppearance>;
  branchAppearance?: ReadonlyMap<string, MindmapBranchAppearance>;
}>;
export type MindmapMeasuredNode = {
  path: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  typography: MermaidGfxTypography;
  padding: readonly [number, number];
  runs: MindmapTextRun[];
  displayLabel: string;
  iconSize: number;
  collapseSize: number;
  textBox: { x: number; y: number; width: number; height: number };
};
export type MindmapLayout = {
  nodes: Map<string, MindmapMeasuredNode>;
  options: MindmapProjectionOptions;
  rootSides: Map<string, LayoutType.LEFT | LayoutType.RIGHT>;
};

function runTypography(base: MermaidGfxTypography, run: MindmapTextRun) {
  return {
    ...base,
    fontWeight: run.bold ? "bold" : base.fontWeight,
    fontStyle: run.italic ? "italic" : base.fontStyle,
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapRuns(
  runs: readonly MindmapTextRun[],
  typography: MermaidGfxTypography,
  maximum: number,
) {
  const result: MindmapTextRun[] = [];
  let width = 0;
  for (const run of runs) {
    const type = runTypography(typography, run);
    let text = "",
      segment = "",
      precedingWidth = width;
    const newline = () => {
      text += "\n";
      segment = "";
      precedingWidth = width = 0;
    };
    for (const token of run.text.split(/(\s+)/)) {
      if (!token) continue;
      if (
        !token.includes("\n") &&
        width &&
        precedingWidth + measureMermaidGfxText(segment + token, type).width >
          maximum
      )
        newline();
      for (const { segment: character } of graphemes.segment(token)) {
        if (character === "\n") {
          newline();
          continue;
        }
        if (
          width &&
          precedingWidth +
            measureMermaidGfxText(segment + character, type).width >
            maximum
        )
          newline();
        if (!width && /[ \t]/.test(character)) continue;
        segment += character;
        text += character;
        width = precedingWidth + measureMermaidGfxText(segment, type).width;
      }
    }
    result.push({ ...run, text });
  }
  return result;
}

/** Native subtree planning operates on measured carriers, with no model writes. */
export function layoutMindmapTree(
  model: MermaidMindmapModel,
  options: MindmapProjectionOptions = {},
): MindmapLayout {
  const theme = resolveMermaidGfxProjectionTheme(),
    getter = mindmapStyleGetters[options.design ?? MindmapStyle.ONE];
  const heading =
    options.design === MindmapStyle.FOUR
      ? resolveMermaidGfxHeadingFont()
      : undefined;
  const nodes = new Map<string, MindmapMeasuredNode>();
  const children = new Map<MermaidMindmapNode, MermaidMindmapNode[]>();
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const paths = new Map<string, number[]>();
  const childCounts = new Map<string, number>();
  for (const node of model.nodes)
    if (node.parentId)
      childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  for (const node of model.nodes) {
    const parent = node.parentId ? byId.get(node.parentId)! : null;
    const siblings = parent ? (children.get(parent) ?? []) : [];
    const path = parent ? [...paths.get(parent.id)!, siblings.length] : [0];
    paths.set(node.id, path);
    if (parent) {
      siblings.push(node);
      children.set(parent, siblings);
    }
    const native = node.root ? getter.root : getter.getNodeStyle(path).node;
    const appearance = options.nodeAppearance?.get(node.sourceKey);
    const initial = mermaidGfxTypographyForNode(
      {
        fontFamily:
          appearance?.fontFamily ??
          heading?.fontFamily ??
          theme.typography.fontFamily,
        fontSize:
          appearance?.fontSize ??
          (theme.typography.fontSize * native.fontSize) / 16,
        fontWeight: appearance?.fontWeight ?? String(native.fontWeight),
        fontStyle: appearance?.fontStyle ?? heading?.fontStyle,
      },
      theme,
    );
    const measured = measureTextInDOM(
      initial.fontFamily,
      initial.fontSize,
      initial.fontWeight,
    );
    const typography = {
      ...initial,
      letterSpacing: 0,
      lineHeight: Math.max(
        initial.fontSize,
        measured.lineHeight + measured.lineGap,
      ),
    };
    // Native technical padding/hit geometry is independent of application chrome.
    const padding = native.padding as readonly [number, number];
    const iconSize = mindmapIconResource(node.icon) ? typography.lineHeight : 0;
    const collapseStyle = getter.getNodeStyle(path);
    const collapseSize = childCounts.get(node.id)
      ? options.collapsed?.has(node.sourceKey)
        ? collapseStyle.expandButton.width
        : collapseStyle.collapseButton.width
      : 0;
    const maximum = typography.lineHeight * 14;
    const runs = wrapRuns(mindmapMarkdownRuns(node.label), typography, maximum);
    const displayLabel = runs.map((run) => run.text).join("");
    let lineWidth = 0,
      contentWidth = 0,
      inkLeft = 0,
      inkRight = 0,
      inkHeight = typography.lineHeight;
    const finishLine = () => {
      contentWidth = Math.max(
        contentWidth,
        lineWidth + 2 * Math.max(-inkLeft, inkRight - lineWidth, 0),
      );
      lineWidth = inkLeft = inkRight = 0;
    };
    for (const run of runs)
      for (const [index, line] of run.text.split("\n").entries()) {
        if (index) finishLine();
        const type = runTypography(typography, run);
        const ink = measureMermaidGfxTextInk(line, type);
        inkLeft = Math.min(inkLeft, lineWidth - ink.left);
        inkRight = Math.max(inkRight, lineWidth + ink.right);
        lineWidth += ink.advance;
        inkHeight = Math.max(inkHeight, ink.ascent + ink.descent);
      }
    finishLine();
    typography.lineHeight = Math.max(typography.lineHeight, inkHeight);
    const iconGap = iconSize ? typography.lineHeight / 4 : 0;
    let width = Math.max(
      typography.lineHeight * 2,
      contentWidth + padding[1] * 2 + iconSize + iconGap + collapseSize,
    );
    let height =
      Math.max(
        displayLabel.split("\n").length *
          Math.max(typography.lineHeight, inkHeight),
        iconSize,
      ) +
      padding[0] * 2;
    // Protect the measured content rectangle inside the actual silhouette. Shape
    // expansion never widens the text slot into the cloud/burst/ellipse corners.
    const contentWidthWithChrome = width;
    const contentHeight = height;
    if (node.shape === "circle") {
      width = height = Math.hypot(width, height);
    } else if (node.shape === "hexagon") {
      width /= 0.64;
    } else if (node.shape === "cloud" || node.shape === "bang") {
      width /= 0.64;
      height /= 0.5;
    }
    width = Math.ceil(width);
    height = Math.ceil(height);
    const insetX = (width - contentWidthWithChrome) / 2;
    const insetY = (height - contentHeight) / 2;
    const textBox = {
      // Collapse handles are outside the shape. Keep their existing width
      // reserve symmetric around the label/icon group instead of shifting it left.
      x: insetX + padding[1] + collapseSize / 2 + iconSize + iconGap,
      y: insetY + padding[0],
      width:
        contentWidthWithChrome -
        padding[1] * 2 -
        iconSize -
        iconGap -
        collapseSize,
      height: contentHeight - padding[0] * 2,
    };
    nodes.set(node.sourceKey, {
      path,
      x: 0,
      y: 0,
      width,
      height,
      typography,
      padding,
      runs,
      displayLabel,
      iconSize,
      collapseSize,
      textBox,
    });
  }
  const root = model.nodes[0];
  const liveKeys = new Set(model.nodes.map((node) => node.sourceKey));
  const rootSides = new Map(
    [...(options.rootSides ?? [])].filter(([key]) => liveKeys.has(key)),
  );
  if (!root) return { nodes, options, rootSides };
  const branches = children.get(root) ?? [];
  if (!rootSides.size) {
    const split = Math.ceil(branches.length / 2);
    for (const [index, branch] of branches.entries())
      rootSides.set(
        branch.sourceKey,
        index < split ? LayoutType.RIGHT : LayoutType.LEFT,
      );
  } else
    for (const branch of branches)
      if (!rootSides.has(branch.sourceKey)) {
        const right = branches.filter(
          (node) => rootSides.get(node.sourceKey) === LayoutType.RIGHT,
        ).length;
        const left = branches.filter(
          (node) => rootSides.get(node.sourceKey) === LayoutType.LEFT,
        ).length;
        rootSides.set(
          branch.sourceKey,
          right <= left ? LayoutType.RIGHT : LayoutType.LEFT,
        );
      }
  const bound = (node: MermaidMindmapNode) => {
    const size = nodes.get(node.sourceKey)!;
    return new Bound(0, 0, size.width, size.height);
  };
  const planned = planMindmapLayout(root, options.layout ?? LayoutType.RIGHT, {
    children: (node) => children.get(node) ?? [],
    collapsed: (node) => options.collapsed?.has(node.sourceKey) ?? false,
    bounds: bound,
    measuredBounds: bound,
    sides: () => ({
      left: branches
        .filter((node) => rootSides.get(node.sourceKey) === LayoutType.LEFT)
        .reverse(),
      right: branches.filter(
        (node) => rootSides.get(node.sourceKey) === LayoutType.RIGHT,
      ),
    }),
  });
  const minX = Math.min(
    0,
    ...[...planned.values()].map((value) => Bound.deserialize(value).x),
  );
  const minY = Math.min(
    0,
    ...[...planned.values()].map((value) => Bound.deserialize(value).y),
  );
  for (const node of model.nodes) {
    const size = nodes.get(node.sourceKey)!,
      raw = planned.get(node);
    const position = raw ? Bound.deserialize(raw) : bound(node);
    size.x = position.x - minX;
    size.y = position.y - minY;
  }
  return { nodes, options, rootSides };
}
