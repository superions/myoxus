// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as m } from "../../i18n.js";
import { ShapeType, StrokeStyle } from "@virgultum/model";
import type {
  MermaidSequenceModel,
  SequenceParticipantType,
} from "../../engine/sequence/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
} from "../runtime/gfx-model.js";
import { sequenceNodeBinding, sequenceNodeFamilyData } from "./gfx-data.js";
import { sequenceWrappedText, type SequenceLayout } from "./layout.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
import { sequenceForegroundAt } from "./background-projection.js";

const PARTICIPANT_SHAPES: Record<
  SequenceParticipantType,
  MermaidVisualNode["shape"]
> = {
  actor: "stadium",
  boundary: "fr-rect",
  collections: "st-rect",
  control: "fr-circ",
  database: "database",
  entity: "lin-rect",
  participant: "rect",
  queue: "h-cyl",
};
export function sequenceParticipantProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
): MermaidVisualNode[] {
  return model.participants.flatMap((p) => {
    const frame = layout.participants.get(p.id);
    if (!frame) return [];
    const details: MermaidVisualNodeDetail[] = [
        {
          id: `${p.sourceKey}:type`,
          kind: "metadata",
          label: m.sequenceParticipantType(p.type),
          order: 0,
        },
        ...(p.label === p.id
          ? []
          : [
              {
                id: `${p.sourceKey}:identity`,
                kind: "metadata" as const,
                label: p.id,
                order: 1,
              },
            ]),
      ],
      node: MermaidVisualNode = {
        ...frame,
        id: p.sourceKey,
        label: p.label,
        displayLabel: sequenceWrappedText(
          p.label,
          p.wrap ?? layout.config.wrap,
          frame.width - layout.config.wrapPadding * 2,
          layout.typography.actor,
        ),
        labelEditable: true,
        shape: PARTICIPANT_SHAPES[p.type],
        details,
        familyData: sequenceNodeFamilyData({
          role: "participant",
          sourceKey: p.sourceKey,
          participantId: p.id,
          participantKey: p.sourceKey,
          participantType: p.type,
          typography: layout.typography.actor,
          padding: layout.config.wrapPadding,
        }),
      },
      top = p.createdBy ? frame.y + frame.height / 2 : frame.y + frame.height,
      destroyed = p.destroyedBy && layout.rows.get(p.destroyedBy),
      bottom = destroyed ? destroyed.y : layout.timelineBottom,
      lifeline: MermaidVisualNode = {
        id: `${p.sourceKey}:lifeline`,
        label: p.label,
        labelEditable: false,
        shape: "rect",
        x: frame.x + frame.width / 2 - 1,
        y: top,
        width: 2,
        height: Math.max(1, bottom - top),
        familyData: sequenceNodeFamilyData({
          role: "lifeline",
          sourceKey: p.sourceKey,
          participantId: p.id,
          participantKey: p.sourceKey,
        }),
      };
    const result = [node, lifeline];
    if (layout.config.mirrorActors && !p.destroyedBy)
      result.push({
        ...node,
        id: `${p.sourceKey}:mirror`,
        y: layout.timelineBottom,
        familyData: sequenceNodeFamilyData({
          ...sequenceNodeBinding(node)!,
          mirror: true,
        }),
      });
    if (destroyed)
      result.push({
        id: `${p.sourceKey}:destroy`,
        label: "×",
        labelEditable: false,
        shape: "text",
        x: frame.x + frame.width / 2 - layout.typography.actor.fontSize,
        y: destroyed.y - layout.typography.actor.fontSize,
        width: layout.typography.actor.fontSize * 2,
        height: layout.typography.actor.fontSize * 2,
        familyData: sequenceNodeFamilyData({
          role: "lifecycle",
          sourceKey: p.sourceKey,
          participantKey: p.sourceKey,
          participantId: p.id,
        }),
      });
    return result;
  });
}
export function sequenceParticipantElementProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const binding = sequenceNodeBinding(node),
    theme = resolveMermaidGfxProjectionTheme();
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    color: theme.textColor,
    fillColor: theme.surfaceColor,
    strokeColor: theme.borderColor,
    fontFamily: binding?.typography?.fontFamily,
    fontSize: binding?.typography?.fontSize,
    fontWeight: binding?.typography?.fontWeight,
    padding: [binding?.padding ?? 0, binding?.padding ?? 0] as const,
    ...(binding?.role === "lifeline"
      ? {
          selectable: true,
          textDisplay: false,
          filled: false,
          strokeStyle: StrokeStyle.Dash,
          strokeColor: sequenceForegroundAt(
            model,
            node.x + node.width / 2,
            node.y,
            theme.secondaryTextColor,
          ),
          strokeWidth: 1,
        }
      : {}),
    ...(binding?.role === "lifecycle"
      ? { filled: false, strokeWidth: 0, textDisplay: true }
      : {}),
  };
}
export function sequenceParticipantDetailProjection(
  _model: unknown,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  const binding = sequenceNodeBinding(node),
    theme = resolveMermaidGfxProjectionTheme(),
    typography = binding?.typography ?? theme.typography,
    padding = binding?.padding ?? 0,
    height = typography.lineHeight;
  return {
    offsetY: 0,
    relativeBound: {
      x: padding,
      y: detail.order === 0 ? padding / 2 : node.height - height - padding / 2,
      width: node.width - padding * 2,
      height,
    },
    text: detail.label,
    textAlign: "center" as const,
    textVerticalAlign: "center" as const,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize * 0.85,
    fontWeight: detail.order === 0 ? "bold" : typography.fontWeight,
    color: theme.secondaryTextColor,
    shapeType: ShapeType.MermaidText,
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
    padding: [0, 0] as const,
    filled: false,
    selectable: false,
  };
}
