// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidSequenceModel,
  SequenceComment,
} from "../../engine/sequence/index.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import { sequenceNodeBinding, sequenceNodeFamilyData } from "./gfx-data.js";
import type { SequenceLayout } from "./layout.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { projectNeutralMermaidGfxNodeElement } from "../runtime/gfx-element-projection-defaults.js";
export function sequenceNoteProjection(
  model: MermaidSequenceModel,
  layout: SequenceLayout,
): MermaidVisualNode[] {
  return model.notes.flatMap((note) => {
    const frame = layout.notes.get(note.id);
    return frame
      ? [
          {
            ...frame,
            id: note.id,
            label: note.label,
            displayLabel: frame.text,
            labelEditable: true,
            shape: "doc",
            textAlign: layout.config.noteAlign,
            familyData: sequenceNodeFamilyData({
              role: "note",
              sourceKey: note.id,
              typography: layout.typography.note,
              padding: layout.config.wrapPadding,
            }),
          },
        ]
      : [];
  });
}
export function sequenceNoteElementProjection(
  _model: unknown,
  node: MermaidVisualNode,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    binding = sequenceNodeBinding(node);
  return {
    ...projectNeutralMermaidGfxNodeElement(node),
    fillColor: theme.secondarySurfaceColor,
    color: theme.textColor,
    strokeColor: theme.borderColor,
    fontFamily: binding?.typography?.fontFamily,
    fontSize: binding?.typography?.fontSize,
    fontWeight: binding?.typography?.fontWeight,
    padding: [binding?.padding ?? 0, binding?.padding ?? 0] as const,
  };
}
export type SequenceCommentMarker = {
  key: string;
  anchor: Pick<SequenceComment, "anchorKind" | "anchorId" | "position">;
  left: number;
  top: number;
  count: number;
};
export function sequenceCommentMarkers(
  model: MermaidSequenceModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): SequenceCommentMarker[] {
  const groups = new Map<string, SequenceCommentMarker>();
  for (const comment of model.commentRecords) {
    const key = `${comment.anchorKind}:${comment.anchorId ?? ""}`,
      old = groups.get(key);
    if (old) {
      old.count++;
      continue;
    }
    let anchorId = comment.anchorId,
      kind: "diagram" | "edge" | "node" | "subgraph" =
        comment.anchorKind === "diagram" ? "diagram" : "node";
    const record = model.sourceDocument.records.find(
      (record) => record.sourceKey === anchorId,
    );
    if (comment.anchorKind === "record" && record?.ownerId)
      anchorId = model.participants.find(
        (p) => p.id === record.ownerId,
      )?.sourceKey;
    const interval = model.activationIntervals.find(
      (a) =>
        a.id === anchorId || a.startId === anchorId || a.endId === anchorId,
    );
    if (interval) anchorId = interval.id;
    if (model.messages.some((m) => m.id === anchorId)) kind = "edge";
    else if (
      model.controls.some((c) => c.id === anchorId) ||
      model.backgrounds.some((b) => b.id === anchorId)
    )
      kind = "subgraph";
    else if (record?.kind === "end") {
      anchorId = record.blockKey;
      kind = "subgraph";
    } else if (
      comment.anchorKind === "record" &&
      !record?.ownerId &&
      record?.branchId
    ) {
      anchorId = record.branchId;
      kind = "node";
    }
    const position = resolve(kind, anchorId);
    if (position)
      groups.set(key, {
        key,
        anchor: {
          anchorKind: comment.anchorKind,
          anchorId: comment.anchorId,
          position: comment.position,
        },
        count: 1,
        ...position,
      });
  }
  const diagram = resolve("diagram", undefined);
  if (diagram && !groups.has("diagram:"))
    groups.set("diagram:", {
      key: "diagram:",
      anchor: { anchorKind: "diagram", position: "before" },
      count: 0,
      ...diagram,
    });
  return [...groups.values()];
}
