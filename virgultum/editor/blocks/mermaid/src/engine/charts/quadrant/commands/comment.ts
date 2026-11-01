// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidQuadrantCommentAnchor,
  MermaidQuadrantModel,
} from "../model.js";
import {
  changedQuadrantCommand,
  mutableQuadrantModel,
  nextQuadrantDraftId,
  unchangedQuadrantCommand,
} from "./shared.js";
import type {
  MermaidQuadrantCommandResult,
  MermaidQuadrantCommentCommand,
} from "./types.js";

function commentSelection(id: string) {
  return { id, kind: "comment" as const };
}

function validAnchor(
  model: MermaidQuadrantModel,
  anchor: MermaidQuadrantCommentAnchor,
) {
  if (!anchor || anchor.kind === "diagram") return true;
  if (anchor.kind === "point")
    return model.points.some((point) => point.id === anchor.id);
  if (anchor.kind === "classDef")
    return model.classes.some((classDef) => classDef.id === anchor.id);
  if (anchor.kind === "axis")
    return Object.values(model.axes).some((axis) => axis.id === anchor.id);
  return model.quadrantTexts.some((text) => text.id === anchor.id);
}

export function applyMermaidQuadrantCommentCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantCommentCommand,
): MermaidQuadrantCommandResult {
  if (command.type === "comment.add") {
    const text = command.text.trim().replace(/^%%\s*/, "");
    if (!text || !validAnchor(model, command.anchor))
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.comment-invalid",
      );
    const next = mutableQuadrantModel(model);
    const id = nextQuadrantDraftId(next, "comment");
    next.comments.push({
      anchor: { ...command.anchor },
      id,
      position: command.position,
      sourceRecordId: "",
      text,
    });
    return changedQuadrantCommand(next, command, commentSelection(id));
  }
  const current = model.comments.find(
    (comment) => comment.id === command.commentId,
  );
  if (!current)
    return unchangedQuadrantCommand(
      model,
      command,
      { kind: "diagram" },
      "quadrant.comment-not-found",
    );
  if (command.type === "comment.update") {
    const text = command.text.trim().replace(/^%%\s*/, "");
    if (!text)
      return unchangedQuadrantCommand(
        model,
        command,
        commentSelection(current.id),
        "quadrant.comment-empty",
      );
    if (text === current.text)
      return unchangedQuadrantCommand(
        model,
        command,
        commentSelection(current.id),
        "quadrant.no-change",
      );
    const next = mutableQuadrantModel(model);
    next.comments.find((comment) => comment.id === current.id)!.text = text;
    return changedQuadrantCommand(next, command, commentSelection(current.id));
  }
  const next = mutableQuadrantModel(model);
  next.comments = next.comments.filter((comment) => comment.id !== current.id);
  return changedQuadrantCommand(next, command, { kind: "diagram" });
}
