import { mermaidMessages as messages } from "../../i18n.js";
import { blockBodyGeometry } from "./layout.js";
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../../engine/block/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { blockStyles, blockTypography } from "./grid-projection.js";
import type { layoutBlockModel } from "./layout.js";
export function projectBlockComposites(
  m: MermaidBlockDiagramModel,
  layout: ReturnType<typeof layoutBlockModel>,
) {
  return m.groups.map((g) => {
    const geometry = layout.objects.get(g.sourceKey)!,
      styles = blockStyles(m, g),
      type = blockTypography(styles);
    return {
      id: g.sourceKey,
      title: g.label,
      displayLabel: g.label || (g.explicitId ? g.id : messages.blockGroup()),
      ...blockBodyGeometry(geometry),
      parentId: m.groups.find((p) => p.bodyKey === g.parentKey)?.sourceKey,
      nodeIds: [...m.nodes, ...m.spaces]
        .filter((n) => n.parentKey === g.bodyKey)
        .map((n) => n.sourceKey),
      familyData: createMermaidVisualFamilyData("block", {
        binding: {
          role: "composite",
          sourceKey: g.sourceKey,
          sourceId: g.id,
          parentKey: g.parentKey,
        },
        bodyKey: g.bodyKey,
        gridX: geometry.x,
        gridY: geometry.y,
        columns: Number.isFinite(g.columns) ? g.columns : null,
        span: Number.isFinite(g.span) ? g.span : null,
        padding: layout.padding,
        styles,
        headerHeight: type.lineHeight + layout.padding * 2,
      }),
    };
  });
}
export function blockCompositeElementProjection(
  _m: MermaidVisualModel,
  g: NonNullable<MermaidVisualModel["subgraphs"]>[number],
) {
  const p = mermaidVisualFamilyPayload(g.familyData, "block"),
    styles = projectMermaidSourceStyle(p?.styles);
  return {
    ...projectNeutralMermaidGfxSubgraphElement(),
    subgraphHeaderHeight: Number(p?.headerHeight) || 0,
    padding: [Number(p?.padding) || 0, Number(p?.padding) || 0] as const,
    ...styles,
    filled: Boolean(styles.fillColor),
  };
}
