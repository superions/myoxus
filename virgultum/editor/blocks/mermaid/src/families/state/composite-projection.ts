// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel } from "../../engine/state/index.js";
import type { StateConfig } from "../../engine/state/config.js";
import type {
  MermaidVisualNode,
  MermaidVisualSubgraph,
  MermaidVisualModel,
} from "../runtime/gfx-model.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import {
  stateContentMetrics,
  stateDisplayText,
  type StateLayoutFrame,
} from "./layout.js";
import {
  stateProjectionBinding,
  stateProjectedStyles,
  stateProjectedRadius,
} from "./gfx-data.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
export function projectStateComposites(
  model: MermaidStateModel,
  nodes: readonly MermaidVisualNode[],
  frames: ReadonlyMap<string, StateLayoutFrame>,
  config: StateConfig,
  styles: (id: string) => Readonly<Record<string, string>>,
): MermaidVisualSubgraph[] {
  const ids = new Map(model.composites.map((c) => [c.id, c.sourceKey!]));
  return model.composites.map((c) => {
    const metrics = stateContentMetrics(c, config, styles(c.id));
    return {
      id: c.sourceKey!,
      title: c.label,
      displayLabel: stateDisplayText(c.label),
      direction: c.direction,
      parentId: c.parentId ? ids.get(c.parentId) : undefined,
      nodeIds: nodes
        .filter((n) => stateProjectionBinding(n)?.parentId === c.id)
        .map((n) => n.id),
      ...frames.get(c.sourceKey!)!,
      familyData: createMermaidVisualFamilyData("state", {
        binding: {
          sourceKey: c.sourceKey,
          sourceId: c.id,
          role: "composite",
          parentId: c.parentId ?? null,
          regionKey: c.regionKey ?? null,
          ...metrics,
        },
        styles: styles(c.id),
      }),
    };
  });
}
export function projectStateRegions(
  model: MermaidStateModel,
  frames: ReadonlyMap<string, StateLayoutFrame>,
  config: StateConfig,
): MermaidVisualNode[] {
  return model.regions.map((r) => {
    const f = frames.get(r.id)!;
    return {
      id: r.id,
      label: "",
      displayLabel: "",
      labelEditable: false,
      shape: "rect" as const,
      ...f,
      y: f.y - config.dividerMargin / 2,
      height: 1,
      familyData: createMermaidVisualFamilyData("state", {
        binding: {
          sourceKey: r.id,
          sourceId: r.id,
          role: "region",
          parentId: r.compositeId,
          regionKey: r.id,
          fontSize: config.fontSize,
          padding: 0,
          headerHeight: 0,
          rows: [],
        },
      }),
    };
  });
}
export function stateCompositeElementProjection(
  model: MermaidVisualModel,
  group: MermaidVisualSubgraph,
) {
  const b = stateProjectionBinding(group);
  return {
    ...projectNeutralMermaidGfxSubgraphElement(),
    radius: stateProjectedRadius(model, group.width, group.height),
    subgraphHeaderHeight: b?.headerHeight,
    fontSize: b?.fontSize,
    padding: [b?.padding ?? 0, b?.padding ?? 0] as const,
    ...projectMermaidSourceStyle(stateProjectedStyles(group)),
  };
}
export function stateRegionElementProjection() {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    fillColor: theme.borderColor,
    strokeWidth: 0,
    textDisplay: false,
    filled: true,
  };
}
