// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarCommentCommand,
  MermaidRadarCommandSelection,
} from "./types.js";
import type { MermaidRadarCommentAnchor } from "../model.js";
import {
  radarInsertionAfterOwnedComments,
  radarInsertionBeforeRecord,
  radarNoChange,
  radarPatchedResult,
  radarRecord,
  radarRecordRemovalPatch,
} from "../writer.js";

function anchorRecord(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCommentCommand, { type: "comment.add" }>,
) {
  const { anchor } = command;
  if (anchor.kind === "diagram")
    return context.model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
  if (anchor.kind === "axis") {
    const axis = context.model.axes.find(
      (candidate) => candidate.id === anchor.id,
    );
    const record = axis
      ? radarRecord(context.model, axis.sourceRecordId)
      : undefined;
    return record?.kind === "axis" && record.axes.length === 1
      ? record
      : undefined;
  }
  if (anchor.kind === "curve") {
    const curve = context.model.curves.find(
      (candidate) => candidate.id === anchor.id,
    );
    const record = curve
      ? radarRecord(context.model, curve.sourceRecordId)
      : undefined;
    return record?.kind === "curve" && record.curves.length === 1
      ? record
      : undefined;
  }
  if (anchor.kind === "metadata")
    return context.model.sourceDocument.records.find(
      (record) => record.kind === "metadata" && record.field === anchor.id,
    );
  const record = radarRecord(context.model, anchor.id);
  return record?.kind === "options" ? record : undefined;
}

function anchorSelection(
  anchor: MermaidRadarCommentAnchor,
): MermaidRadarCommandSelection {
  if (anchor.kind === "axis" || anchor.kind === "curve")
    return { id: anchor.id, kind: anchor.kind };
  if (anchor.kind === "options") return { kind: "options" };
  return { kind: "diagram" };
}

export function applyMermaidRadarCommentCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarCommentCommand;
  if (command.type === "comment.add") {
    const text = command.text.trim();
    const anchor = anchorRecord(context, command);
    if (!text || /[\r\n]/.test(text) || !anchor)
      return radarNoChange(
        context.model,
        context.source,
        "radar.comment-invalid",
      );
    const line = `  %% ${text}`;
    const patch =
      command.position === "before"
        ? radarInsertionBeforeRecord(context.model, anchor, line)
        : radarInsertionAfterOwnedComments(context.model, anchor, line);
    return radarPatchedResult({
      model: context.model,
      patches: [patch],
      selectionAfter: anchorSelection(command.anchor),
      source: context.source,
    });
  }
  const comment = context.model.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  const owner = comment
    ? radarRecord(context.model, comment.sourceRecordId)
    : undefined;
  if (!comment || owner?.kind !== "comment")
    return radarNoChange(
      context.model,
      context.source,
      "radar.comment-missing",
    );
  if (command.type === "comment.delete")
    return radarPatchedResult({
      model: context.model,
      patches: [radarRecordRemovalPatch(context.model, owner)],
      selectionAfter: anchorSelection(comment.anchor),
      source: context.source,
    });
  if (command.type !== "comment.edit")
    return radarNoChange(
      context.model,
      context.source,
      "radar.command-invalid",
    );
  const text = command.text.trim();
  if (!text || /[\r\n]/.test(text))
    return radarNoChange(
      context.model,
      context.source,
      "radar.comment-invalid",
    );
  return radarPatchedResult({
    model: context.model,
    patches: [
      {
        range: owner.range,
        value: `${owner.raw.match(/^\s*/)?.[0] ?? ""}%% ${text}`,
      },
    ],
    selectionAfter: { id: comment.id, kind: "comment" },
    source: context.source,
  });
}
