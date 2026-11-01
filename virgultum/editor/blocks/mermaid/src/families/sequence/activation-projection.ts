// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidSequenceModel } from "../../engine/sequence/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { sequenceNodeFamilyData } from "./gfx-data.js";
import { sequenceRowForActivation, type SequenceLayout } from "./layout.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { mermaidMessages as m } from "../../i18n.js";
import { sequenceForegroundAt } from "./background-projection.js";
export function sequenceActivationProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
): MermaidVisualNode[] {
  return model.activationIntervals.flatMap((interval) => {
    const participant = model.participants.find(
        (p) => p.id === interval.participantId,
      ),
      frame = layout.participants.get(interval.participantId),
      start = sequenceRowForActivation(layout, interval.startId),
      end = interval.endId && sequenceRowForActivation(layout, interval.endId);
    if (!participant || !frame || !start) return [];
    const bottom = end ? end.y : layout.timelineBottom;
    return [
      {
        id: interval.id,
        label: `${m.sequenceActivation()} · ${participant.label}`,
        labelEditable: false,
        shape: "rect",
        x:
          frame.x +
          frame.width / 2 -
          layout.config.activationWidth / 2 +
          (interval.depth * layout.config.activationWidth) / 2,
        y: start.y,
        width: Math.max(1, layout.config.activationWidth),
        height: Math.max(1, bottom - start.y),
        familyData: sequenceNodeFamilyData({
          role: "activation",
          sourceKey: interval.id,
          participantId: participant.id,
          participantKey: participant.sourceKey,
        }),
      },
    ];
  });
}
export function sequenceActivationElementProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    selectable: true,
    textDisplay: false,
    fillColor: theme.secondarySurfaceColor,
    strokeColor: sequenceForegroundAt(
      model,
      node.x + node.width / 2,
      node.y,
      theme.secondaryTextColor,
    ),
    strokeWidth: 1,
  };
}
