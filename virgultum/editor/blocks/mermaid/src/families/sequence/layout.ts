// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFontString, measureTextInDOM, wrapText } from "@virgultum/gfx-text";
import type {
  MermaidSequenceModel,
  MermaidSequenceNote,
  SequenceConfig,
  SequenceSourceRecord,
} from "../../engine/sequence/index.js";
import { readSequenceConfig } from "../../engine/sequence/index.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
  type MermaidGfxTypography,
} from "../../mermaid-gfx-theme.js";

export type SequenceFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SequenceRow = {
  key: string;
  y: number;
  top: number;
  bottom: number;
  parentId: string | null;
  branchId: string | null;
};
export type SequenceLayout = {
  config: SequenceConfig;
  typography: Record<"actor" | "message" | "note", MermaidGfxTypography>;
  participants: Map<string, SequenceFrame>;
  notes: Map<string, SequenceFrame & { text: string }>;
  rows: Map<string, SequenceRow>;
  labels: Map<string, string>;
  numbering: Map<string, number>;
  timelineTop: number;
  timelineBottom: number;
  width: number;
  height: number;
};
function sequenceTypography(
  config: SequenceConfig,
  role: "actor" | "message" | "note",
): MermaidGfxTypography {
  const base = resolveMermaidGfxProjectionTheme().typography,
    authoredSize = config[`${role}FontSize`],
    fontFamily = config[`${role}FontFamily`] || base.fontFamily,
    fontWeight = String(config[`${role}FontWeight`]);
  let fontSize =
    typeof authoredSize === "number" ? authoredSize : Number(authoredSize);
  if (!Number.isFinite(fontSize)) {
    // Resolve authored CSS units against the same live document environment.
    // parseFloat(1.2rem) would silently project a 1.2px label.
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.style.fontSize = authoredSize as string;
    document.documentElement.append(probe);
    try {
      fontSize = parseFloat(getComputedStyle(probe).fontSize);
    } finally {
      probe.remove();
    }
  }
  const metrics = measureTextInDOM(fontFamily, fontSize, fontWeight);
  return {
    ...base,
    fontFamily,
    fontSize,
    fontWeight,
    // Shape and connector renderers advance by the measured line box plus
    // its gap; using glyph height alone clips multiline notes and headers.
    lineHeight: metrics.lineHeight + metrics.lineGap,
    letterSpacing: 0,
  };
}
export function sequenceWrappedText(
  text: string,
  wrap: boolean,
  width: number,
  typography: MermaidGfxTypography,
) {
  return wrap
    ? wrapText(text, getFontString(typography), Math.max(1, width))
    : text;
}
export function sequenceRowForActivation(layout: SequenceLayout, key: string) {
  return (
    layout.rows.get(key) ?? layout.rows.get(key.replace(/:activation$/, ""))
  );
}
function noteWidth(
  note: MermaidSequenceNote,
  participants: Map<string, SequenceFrame>,
  config: SequenceConfig,
  typography: MermaidGfxTypography,
) {
  const anchors = note.participantIds.flatMap((id) =>
    participants.has(id) ? [participants.get(id)!] : [],
  );
  const measured =
    (note.wrap ?? config.wrap)
      ? 0
      : measureMermaidGfxText(note.label, typography).width +
        config.wrapPadding * 2;
  return Math.max(
    measured,
    anchors.length > 1 && note.placement === "over"
      ? Math.abs(
          anchors[0]!.x +
            anchors[0]!.width / 2 -
            anchors[1]!.x -
            anchors[1]!.width / 2,
        ) + config.actorMargin
      : config.width,
  );
}
/** Geometry is derived from Source order and measured renderer text. It never
 * infers a semantic reorder from persisted X/Y or a passive reprojection. */
export function layoutSequence(model: MermaidSequenceModel): SequenceLayout {
  const { config } = readSequenceConfig(model.sourceDocument),
    typography = {
      actor: sequenceTypography(config, "actor"),
      message: sequenceTypography(config, "message"),
      note: sequenceTypography(config, "note"),
    },
    used = new Set([
      ...model.messages.flatMap((m) => [m.from, m.to]),
      ...model.notes.flatMap((n) => n.participantIds),
      ...model.activations.map((a) => a.participantId),
    ]),
    visible = model.participants.filter(
      (p) => !config.hideUnusedParticipants || used.has(p.id),
    ),
    participants = new Map<string, SequenceFrame>();
  const header = Math.max(
      config.height,
      typography.actor.lineHeight * 3 + config.wrapPadding * 2,
    ),
    boxHeader = model.backgrounds.some((b) => b.kind === "box")
      ? Math.max(config.labelBoxHeight, typography.actor.lineHeight) +
        config.boxTextMargin * 2
      : 0;
  let x = config.diagramMarginX + config.boxMargin;
  for (const p of visible) {
    const text = sequenceWrappedText(
        p.label,
        p.wrap ?? config.wrap,
        config.width - config.wrapPadding * 2,
        typography.actor,
      ),
      content = measureMermaidGfxText(text, typography.actor),
      identity =
        p.id === p.label
          ? 0
          : measureMermaidGfxText(p.id, typography.actor).width,
      width = Math.max(
        config.width,
        content.width + config.wrapPadding * 2,
        identity + config.wrapPadding * 2,
      ),
      height = Math.max(
        header,
        content.height +
          typography.actor.lineHeight * 2 +
          config.wrapPadding * 2,
      );
    participants.set(p.id, {
      x,
      y: config.diagramMarginY + boxHeader,
      width,
      height,
    });
    x += width + config.actorMargin;
  }
  // Non-wrapped labels expand the relevant lane span, not a global font fit.
  for (const message of model.messages) {
    const a = participants.get(message.from),
      b = participants.get(message.to);
    if (!a || !b || a === b || (message.wrap ?? config.wrap)) continue;
    const left = Math.min(a.x + a.width / 2, b.x + b.width / 2),
      right = Math.max(a.x + a.width / 2, b.x + b.width / 2),
      needed =
        measureMermaidGfxText(message.label, typography.message).width +
        config.wrapPadding * 2 +
        typography.message.fontSize * 2,
      delta = needed - (right - left);
    if (delta > 0)
      for (const p of participants.values())
        if (p.x + p.width / 2 >= right) p.x += delta;
  }
  const timelineTop =
      Math.max(
        config.diagramMarginY + header + boxHeader,
        ...[...participants.values()].map((p) => p.y + p.height),
      ) + config.messageMargin,
    rows = new Map<string, SequenceRow>(),
    labels = new Map<string, string>(),
    numbering = new Map<string, number>(),
    notes = new Map<string, SequenceFrame & { text: string }>();
  let y = timelineTop,
    number = 0,
    step = 1,
    numberingEnabled = false;
  const messageByKey = new Map(model.messages.map((m) => [m.id, m])),
    noteByKey = new Map(model.notes.map((n) => [n.id, n]));
  for (const record of model.sourceDocument.records) {
    if (record.kind === "autonumber") {
      const fields = record.raw.trim().split(/\s+/);
      numberingEnabled = fields[1] !== "off";
      if (numberingEnabled) {
        if (Number(fields[1])) number = Number(fields[1]);
        if (Number(fields[2])) step = Number(fields[2]);
      }
      continue;
    }
    if (!record.temporal) continue;
    const message = messageByKey.get(record.sourceKey),
      note = noteByKey.get(record.sourceKey);
    let height = config.messageMargin;
    if (message) {
      const a = participants.get(message.from),
        b = participants.get(message.to),
        available =
          a && b
            ? Math.max(
                config.width,
                Math.abs(a.x + a.width / 2 - b.x - b.width / 2) -
                  config.wrapPadding * 2,
              )
            : config.width;
      if (numberingEnabled || config.showSequenceNumbers)
        numbering.set(message.id, number || 1);
      const numbered = numbering.has(message.id)
          ? `${numbering.get(message.id)}. ${message.label}`
          : message.label,
        text = sequenceWrappedText(
          numbered,
          message.wrap ?? config.wrap,
          available,
          typography.message,
        );
      labels.set(message.id, text);
      height =
        (measureMermaidGfxText(text, typography.message).height +
          typography.message.lineHeight / 4) *
          1.5 +
        config.messageMargin +
        (message.from === message.to ? config.messageMargin : 0);
      number = (number || 1) + step;
    } else if (note) {
      const width = noteWidth(note, participants, config, typography.note),
        text = sequenceWrappedText(
          note.label,
          note.wrap ?? config.wrap,
          width - config.wrapPadding * 2,
          typography.note,
        );
      labels.set(note.id, text);
      height =
        measureMermaidGfxText(text, typography.note).height +
        config.wrapPadding * 2 +
        config.noteMargin * 2;
    } else if (["fragment", "branch", "rect"].includes(record.kind)) {
      const value =
        model.controls.find((c) => c.id === record.sourceKey)?.label ??
        model.controls
          .flatMap((c) => c.branches)
          .find((b) => b.id === record.sourceKey)?.label ??
        "";
      height =
        Math.max(
          config.labelBoxHeight,
          measureMermaidGfxText(value, typography.actor).height,
        ) +
        config.boxTextMargin * 2 +
        config.boxMargin;
    } else if (record.kind === "end") height = config.boxMargin * 2;
    else if (["create", "destroy"].includes(record.kind))
      height = config.boxMargin;
    const created = model.participants
      .filter((p) => p.createdBy === record.sourceKey)
      .flatMap((p) =>
        participants.has(p.id) ? [participants.get(p.id)!] : [],
      );
    if (created.length)
      height = Math.max(
        height,
        ...created.map((frame) => frame.height + config.messageMargin),
      );
    const row = {
      key: record.sourceKey,
      top: y,
      bottom: y + Math.max(1, height),
      y: y + Math.max(1, height) / 2,
      parentId: record.parentId,
      branchId: record.branchId,
    };
    // A message label owns the space above its line; self loops use the lower
    // half of their own row instead of crossing the next temporal statement.
    if (message)
      row.y =
        row.top +
        measureMermaidGfxText(labels.get(message.id)!, typography.message)
          .height *
          1.5 +
        (typography.message.lineHeight * 3) / 8 +
        config.messageMargin / 2;
    if (created.length)
      row.y = Math.max(
        row.y,
        row.top +
          Math.max(...created.map((frame) => frame.height)) / 2 +
          config.messageMargin / 2,
      );
    rows.set(record.sourceKey, row);
    y = row.bottom;
  }
  const timelineBottom = Math.max(
      timelineTop + 1,
      y + config.messageMargin + config.bottomMarginAdj,
    ),
    width = Math.max(
      config.width + config.diagramMarginX * 2,
      ...[...participants.values()].map(
        (p) => p.x + p.width + config.diagramMarginX + config.boxMargin,
      ),
    );
  for (const p of model.participants) {
    const frame = participants.get(p.id),
      created = p.createdBy && rows.get(p.createdBy);
    if (frame && created) frame.y = created.y - frame.height / 2;
  }
  for (const note of model.notes) {
    const row = rows.get(note.id),
      anchors = note.participantIds.flatMap((id) =>
        participants.has(id) ? [participants.get(id)!] : [],
      );
    if (!row || !anchors.length) continue;
    const width = noteWidth(note, participants, config, typography.note),
      height = row.bottom - row.top - config.noteMargin * 2,
      center = anchors[0]!.x + anchors[0]!.width / 2,
      left =
        note.placement === "left of"
          ? center - config.noteMargin - width
          : note.placement === "right of"
            ? center + config.noteMargin
            : anchors.length > 1
              ? Math.min(...anchors.map((a) => a.x + a.width / 2)) -
                config.actorMargin / 2
              : center - width / 2;
    notes.set(note.id, {
      x: left,
      y: row.top + config.noteMargin,
      width,
      height,
      text: labels.get(note.id)!,
    });
  }
  return {
    config,
    typography,
    participants,
    notes,
    rows,
    labels,
    numbering,
    timelineTop,
    timelineBottom,
    width: Math.max(
      width,
      ...[...notes.values()].map((n) => n.x + n.width + config.diagramMarginX),
    ),
    height:
      timelineBottom +
      (config.mirrorActors ? header + config.boxMargin : 0) +
      config.diagramMarginY,
  };
}
export function sequenceSpanFrame(
  layout: SequenceLayout,
  record: SequenceSourceRecord,
  inset: number,
): SequenceFrame {
  const start = layout.rows.get(record.sourceKey),
    end = record.closeKey ? layout.rows.get(record.closeKey) : undefined,
    left = layout.config.diagramMarginX + inset,
    top = start?.top ?? layout.timelineTop,
    bottom =
      end?.bottom ??
      start?.bottom ??
      top + layout.config.labelBoxHeight + layout.config.boxMargin * 2;
  return {
    x: left,
    y: top,
    width: Math.max(
      layout.config.labelBoxWidth,
      layout.width - layout.config.diagramMarginX * 2 - inset * 2,
    ),
    height: Math.max(layout.config.labelBoxHeight, bottom - top),
  };
}
