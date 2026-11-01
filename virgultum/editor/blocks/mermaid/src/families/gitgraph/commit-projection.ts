// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GitGraphCommitOccurrence } from "../../engine/gitgraph/index.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { gitGraphData, gitGraphBinding, gitGraphPayload } from "./gfx-data.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
export function gitGraphCommitShape(
  c: GitGraphCommitOccurrence,
): MermaidVisualNode["shape"] {
  const symbol = c.customType ?? c.type;
  return symbol === "HIGHLIGHT"
    ? "rect"
    : symbol === "REVERSE"
      ? "cross-circ"
      : symbol === "MERGE"
        ? "doublecircle"
        : symbol === "CHERRY_PICK"
          ? "cherry-pick"
          : "circle";
}
export function gitGraphCommitMark(
  c: GitGraphCommitOccurrence,
  x: number,
  y: number,
): MermaidVisualNode {
  return {
    id: c.sourceKey,
    label: c.sourceId || c.kind,
    displayLabel: "",
    labelEditable: false,
    shape: gitGraphCommitShape(c),
    x: x - 10,
    y: y - 10,
    width: 20,
    height: 20,
    familyData: gitGraphData({
      role: "commit",
      sourceKey: c.sourceKey,
      branch: c.branchId,
    }),
  };
}
export function projectGitGraphNode(
  model: import("../runtime/gfx-model.js").MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    binding = gitGraphBinding(node),
    guide = gitGraphPayload(node)?.authoringGuide === true,
    pill = binding?.role === "tag" || node.id.endsWith(":branch"),
    origin = node.id.endsWith(":origin"),
    marker =
      binding?.role === "commit" || binding?.role === "comment" || origin,
    branchColor = gitGraphBranchColor(model, binding?.branch),
    color =
      binding?.role === "comment" ? theme.secondaryTextColor : theme.textColor;
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    ...(pill ? { radius: 0.5 } : {}),
    hidden: binding?.role === "rail" && guide,
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.fontSize,
    fontWeight:
      binding?.role === "id" || binding?.role === "branch"
        ? "bold"
        : theme.typography.fontWeight,
    color: guide
      ? theme.secondaryTextColor
      : binding?.role === "branch" || binding?.role === "tag"
        ? branchColor
        : color,
    rotate: node.rotate ?? 0,
    fillColor: binding?.role === "rail" ? branchColor : theme.surfaceColor,
    strokeColor: guide ? theme.secondaryTextColor : branchColor,
    padding: pill
      ? binding?.role === "tag"
        ? ([
            theme.typography.lineHeight / 8,
            theme.typography.lineHeight / 3,
          ] as const)
        : ([
            theme.typography.lineHeight / 4,
            theme.typography.lineHeight / 2,
          ] as const)
      : ([0, 0] as const),
    filled: marker || pill || binding?.role === "rail",
    textDisplay:
      binding?.role !== "commit" && binding?.role !== "rail" && !origin,
    strokeWidth:
      marker ||
      (pill &&
        binding?.role === "branch" &&
        gitGraphPayload(node)?.active === true)
        ? 2
        : pill
          ? 1
          : 0,
    selectable: binding?.role !== "rail",
  };
}

/** Stable branch names choose semantic server-theme roles; no participant RGB
 * or theme-dependent value enters Source or a collaborative family binding. */
export function gitGraphBranchColor(
  model: import("../runtime/gfx-model.js").MermaidVisualModel,
  branch?: string,
) {
  const theme = resolveMermaidGfxProjectionTheme();
  // Surface readback and retained readonly graphics may enumerate children in
  // creation order. Only the Source-derived branch order chooses theme roles.
  const branches = gitGraphPayload(model)?.branches;
  const rank = Math.max(
    0,
    Array.isArray(branches) ? branches.indexOf(branch ?? "") : -1,
  );
  return [
    theme.primaryColor,
    theme.successColor,
    theme.processingColor,
    theme.warningColor,
  ][rank % 4]!;
}
