// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidSequenceModel } from "../../engine/sequence/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { sequenceObjectFamilyData, sequenceFamilyPayload } from "./gfx-data.js";
import { sequenceSpanFrame, type SequenceLayout } from "./layout.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
/** Transparent temporal glyphs need the foreground of their painted backdrop,
 * not the app surface. Reuse the source-fill contrast token so mode changes
 * neither persist a viewer's RGB nor alter authored colors. */
export function sequenceForegroundAt(
  model: MermaidVisualModel,
  x: number,
  y: number,
  fallback: string,
) {
  for (const group of [...(model.subgraphs ?? [])].reverse()) {
    const data = sequenceFamilyPayload(group);
    if (
      !["box", "rect"].includes(String(data?.role)) ||
      x < group.x ||
      x > group.x + group.width ||
      y < group.y ||
      y > group.y + group.height ||
      typeof data?.color !== "string" ||
      !data.color
    )
      continue;
    const foreground = projectMermaidSourceStyle({ fill: data.color }).color;
    if (foreground) return foreground;
  }
  return fallback;
}
export function sequenceBackgroundProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
): MermaidVisualSubgraph[] {
  return model.backgrounds.map((background) => {
    const record = model.sourceDocument.records.find(
        (r) => r.sourceKey === background.id,
      )!,
      participants = background.participantIds.flatMap((id) =>
        layout.participants.has(id) ? [layout.participants.get(id)!] : [],
      ),
      headerHeight =
        Math.max(
          layout.config.labelBoxHeight,
          layout.typography.actor.lineHeight,
        ) +
        layout.config.boxTextMargin * 2,
      x = participants.length
        ? Math.min(...participants.map((p) => p.x)) - layout.config.boxMargin
        : layout.config.diagramMarginX,
      width = participants.length
        ? Math.max(...participants.map((p) => p.x + p.width)) +
          layout.config.boxMargin -
          x
        : layout.config.width + layout.config.boxMargin * 2,
      frame =
        background.kind === "box"
          ? {
              x,
              y: layout.config.diagramMarginY,
              width,
              height: layout.height - layout.config.diagramMarginY * 2,
            }
          : sequenceSpanFrame(layout, record, layout.config.boxMargin);
    return {
      ...frame,
      id: background.id,
      title: background.label,
      displayLabel:
        background.label ||
        (background.kind === "box" ? m.sequenceBox() : m.sequenceRect()),
      nodeIds:
        background.kind === "box"
          ? model.participants
              .filter((p) => p.boxId === background.id)
              .map((p) => p.sourceKey)
          : [],
      parentId: record.parentId ?? undefined,
      familyData: sequenceObjectFamilyData({
        role: background.kind,
        sourceKey: background.id,
        color: background.color,
        label: background.label,
        headerHeight,
        typography: layout.typography.actor,
      }),
    };
  });
}
/** Background fill has no semantic hit area. The existing subgraph header is
 * its explicit selection target; messages and activation bars stay in front. */
export function sequenceBackgroundElementProjection(
  _model: unknown,
  group: MermaidVisualSubgraph,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    payload = group.familyData?.payload,
    color = payload?.color;
  return {
    ...projectNeutralMermaidGfxSubgraphElement(),
    filled: true,
    textDisplay: true,
    radius: 0,
    fillColor: theme.secondarySurfaceColor,
    color: theme.secondaryTextColor,
    strokeColor: theme.borderColor,
    strokeWidth: 1,
    ...(typeof color === "string" && color
      ? projectMermaidSourceStyle({ fill: color })
      : {}),
  };
}
