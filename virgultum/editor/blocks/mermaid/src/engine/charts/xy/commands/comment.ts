// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidXyComment,
  MermaidXyCommentAnchor,
  MermaidXyModel,
} from "../model.js";
import {
  invalidXyCommand,
  normalizedXyText,
  validXyCommand,
} from "./shared.js";

export type MermaidXyCommentCommand =
  | {
      anchor: MermaidXyCommentAnchor;
      position: MermaidXyComment["position"];
      text: string;
      type: "comment.add";
    }
  | { commentId: string; text: string; type: "comment.update" }
  | { commentId: string; type: "comment.delete" };

function anchorExists(model: MermaidXyModel, anchor: MermaidXyCommentAnchor) {
  if (anchor.kind === "diagram") return true;
  if (anchor.kind === "plot")
    return model.plots.some((plot) => plot.id === anchor.id);
  if (anchor.kind === "x-axis") return anchor.id === "xy-axis-x";
  if (anchor.kind === "y-axis") return anchor.id === "xy-axis-y";
  return ["title", "accessibilityTitle", "accessibilityDescription"].includes(
    anchor.id,
  );
}

export function validateMermaidXyCommentCommand(
  model: MermaidXyModel,
  command: MermaidXyCommentCommand,
) {
  if (command.type === "comment.add") {
    if (!normalizedXyText(command.text) || /\r|\n/.test(command.text))
      return invalidXyCommand("xy.comment-empty");
    if (!anchorExists(model, command.anchor))
      return invalidXyCommand("xy.comment-anchor-not-found");
    return validXyCommand({ kind: "diagram" });
  }
  const comment = model.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  if (!comment) return invalidXyCommand("xy.comment-not-found");
  const selection = { id: comment.id, kind: "comment" as const };
  if (command.type === "comment.update") {
    if (!normalizedXyText(command.text) || /\r|\n/.test(command.text))
      return invalidXyCommand("xy.comment-empty", selection);
    if (command.text.trim() === comment.text)
      return invalidXyCommand("xy.no-change", selection);
  }
  return validXyCommand(selection);
}
