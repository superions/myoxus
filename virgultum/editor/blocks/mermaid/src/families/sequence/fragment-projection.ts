// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrokeStyle } from "@virgultum/model";
import type { MermaidSequenceModel } from "../../engine/sequence/index.js";
import type {
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import {
  sequenceNodeFamilyData,
  sequenceNodeBinding,
  sequenceObjectFamilyData,
} from "./gfx-data.js";
import { sequenceSpanFrame, type SequenceLayout } from "./layout.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import {
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../runtime/gfx-element-projection-defaults.js";

export function sequenceFragmentProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
) {
  const frames: MermaidVisualSubgraph[] = [],
    branches: MermaidVisualNode[] = [];
  const depth = (id: string): number => {
    let parent = model.sourceDocument.records.find(
        (r) => r.sourceKey === id,
      )?.parentId,
      result = 0;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      result++;
      parent = model.sourceDocument.records.find(
        (r) => r.sourceKey === parent,
      )?.parentId;
    }
    return result;
  };
  for (const fragment of model.controls) {
    const record = model.sourceDocument.records.find(
        (r) => r.sourceKey === fragment.id,
      )!,
      frame = sequenceSpanFrame(
        layout,
        record,
        depth(fragment.id) * layout.config.boxMargin,
      ),
      heading = `${fragment.kind}${fragment.label ? ` · ${fragment.label}` : ""}`;
    frames.push({
      ...frame,
      id: fragment.id,
      title: heading,
      displayLabel: "",
      nodeIds: [],
      parentId: record.parentId ?? undefined,
      familyData: sequenceObjectFamilyData({
        role: "fragment",
        sourceKey: fragment.id,
        fragmentKind: fragment.kind,
        label: fragment.label,
        headerHeight:
          Math.max(
            layout.config.labelBoxHeight,
            layout.typography.actor.lineHeight,
          ) +
          layout.config.boxTextMargin * 2,
      }),
    });
    for (const branch of fragment.branches) {
      const row = layout.rows.get(
        branch.kind === "primary" ? fragment.id : branch.id,
      );
      if (!row) continue;
      const text =
          branch.kind === "primary"
            ? heading
            : `${branch.kind}${branch.label ? ` · ${branch.label}` : ""}`,
        measured = measureMermaidGfxText(text, layout.typography.actor);
      branches.push({
        id: branch.id,
        label: branch.label,
        displayLabel: text,
        labelEditable: true,
        shape: "rect",
        x: frame.x,
        y: row.top,
        width: Math.max(
          frame.width,
          measured.width + layout.config.boxTextMargin * 2,
        ),
        height: row.bottom - row.top - layout.config.boxMargin,
        familyData: sequenceNodeFamilyData({
          role: "branch",
          sourceKey: branch.id,
          typography: layout.typography.actor,
          padding: layout.config.boxTextMargin,
        }),
        textAlign: "left",
      });
    }
  }
  return { frames, branches };
}
export function sequenceFragmentElementProjection() {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxSubgraphElement(),
    filled: false,
    textDisplay: false,
    selectable: false,
    radius: 0,
    strokeColor: theme.borderColor,
    strokeWidth: 1,
  };
}
export function sequenceBranchElementProjection(
  _model: unknown,
  node: MermaidVisualNode,
) {
  const theme = resolveMermaidGfxProjectionTheme();
  const typography = sequenceNodeBinding(node)?.typography;
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    fillColor: theme.surfaceColor,
    color: theme.textColor,
    strokeColor: theme.borderColor,
    strokeStyle: StrokeStyle.Dash,
    strokeWidth: 1,
    fontFamily: typography?.fontFamily,
    fontSize: typography?.fontSize,
    fontWeight: "bold",
    padding: [0, 0] as const,
  };
}
