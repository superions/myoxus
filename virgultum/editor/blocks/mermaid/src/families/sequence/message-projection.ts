// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidSequenceModel,
  SequenceArrowMarker,
} from "../../engine/sequence/index.js";
import { createConnectorEndpointMarker } from "@virgultum/gfx-connector";
import { endpointPointStyle } from "../runtime/gfx-element-projection-defaults.js";
import { SEQUENCE_ARROW_MAP } from "../../engine/sequence/index.js";
import type {
  MermaidVisualEdge,
  MermaidVisualEndpointMarker,
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  sequenceObjectFamilyData,
  sequenceFamilyPayload,
  sequenceNodeBinding,
} from "./gfx-data.js";
import type { SequenceLayout } from "./layout.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { sequenceForegroundAt } from "./background-projection.js";
const MARKERS: Record<SequenceArrowMarker, MermaidVisualEndpointMarker> = {
  none: "none",
  filled: "triangle",
  open: "arrow",
  cross: "cross",
  "filled-top": "half-filled-top",
  "filled-bottom": "half-filled-bottom",
  "open-top": "half-open-top",
  "open-bottom": "half-open-bottom",
};
/** Semantic endpoints are Participant keys. Attachments are their single derived
 * Lifeline; endpoint fractions are measured against that line, never cards. */
export function sequenceMessageProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
  nodes: readonly MermaidVisualNode[],
): MermaidVisualEdge[] {
  const participants = new Map(model.participants.map((p) => [p.id, p])),
    lifelines = new Map(
      nodes
        .filter((n) => sequenceNodeBinding(n)?.role === "lifeline")
        .map((n) => [sequenceNodeBinding(n)!.participantId!, n]),
    );
  return model.messages.flatMap((message) => {
    const from = participants.get(message.from),
      to = participants.get(message.to),
      a = lifelines.get(message.from),
      b = lifelines.get(message.to),
      row = layout.rows.get(message.id);
    if (!from || !to || !a || !b || !row) return [];
    const self = message.from === message.to,
      start = row.y,
      end = self
        ? Math.min(
            row.bottom - layout.config.boxMargin,
            start + layout.config.messageMargin,
          )
        : start,
      position = (line: MermaidVisualNode, y: number) =>
        [self ? 1 : 0.5, (y - line.y) / line.height] as const,
      arrow = SEQUENCE_ARROW_MAP[message.arrow];
    return [
      {
        id: message.id,
        label: message.label,
        displayLabel: layout.labels.get(message.id),
        labelEditable: true,
        source: from.sourceKey,
        target: to.sourceKey,
        sourceAttachment: a.id,
        targetAttachment: b.id,
        sourcePosition: position(a, start),
        targetPosition: position(b, end),
        sourceMarker: MARKERS[arrow.start],
        targetMarker: MARKERS[arrow.end],
        style: arrow.dotted ? "dotted" : "solid",
        connectorMode: self
          ? layout.config.rightAngles
            ? "orthogonal"
            : "curve"
          : "straight",
        labelPlacement: "top",
        familyData: sequenceObjectFamilyData({
          sourceKey: message.id,
          arrow: message.arrow,
          from: message.from,
          to: message.to,
          centralFrom: message.centralFrom,
          centralTo: message.centralTo,
          activation: message.activation,
          wrap: message.wrap,
          rowKey: message.id,
          self,
          typography: layout.typography.message,
          align: layout.config.messageAlign,
        }),
      },
    ];
  });
}
export function sequenceMessageElementProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const data = sequenceFamilyPayload(edge),
    theme = resolveMermaidGfxProjectionTheme(),
    typography = data?.typography as unknown as
      SequenceLayout["typography"]["message"] | undefined,
    source = model.nodes.find((node) => node.id === edge.sourceAttachment),
    target = model.nodes.find((node) => node.id === edge.targetAttachment),
    color =
      source && target
        ? sequenceForegroundAt(
            model,
            (source.x + source.width / 2 + target.x + target.width / 2) / 2,
            source.y + (edge.sourcePosition?.[1] ?? 0) * source.height,
            theme.textColor,
          )
        : theme.textColor;
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    fontFamily: typography?.fontFamily,
    fontSize: typography?.fontSize,
    fontWeight: typography?.fontWeight,
    labelLineHeight: typography?.lineHeight,
    labelOffsetDistance:
      data?.align === "left" ? 0.2 : data?.align === "right" ? 0.8 : 0.5,
    labelTextAlign:
      data?.align === "left"
        ? ("left" as const)
        : data?.align === "right"
          ? ("right" as const)
          : ("center" as const),
    color,
    stroke: color,
    strokeWidth: 2,
    endpointScale: 0.8,
    frontEndpointCircle: data?.centralFrom === true,
    rearEndpointCircle: data?.centralTo === true,
  };
}

/** Forms show the actual connector marker primitive at its native scale. */
export function createSequenceArrowPreviewMarker(
  id: string,
  arrow: import("../../engine/sequence/model.js").MermaidSequenceMessageArrow,
  start: boolean,
) {
  const marker = SEQUENCE_ARROW_MAP[arrow][start ? "start" : "end"];
  return createConnectorEndpointMarker(
    id,
    endpointPointStyle(MARKERS[marker]),
    "currentColor",
    "transparent",
    2,
    start,
    0.8,
  );
}
