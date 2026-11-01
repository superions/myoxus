// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttAppendAtEnd,
  ganttDeleteStatement,
  ganttNoChange,
  ganttPatchedResult,
  type GanttCommandResult,
} from "../writer.js";
import type { GanttComment, MermaidGanttModel } from "../types.js";

export type GanttCommentCommand =
  | {
      readonly type: "comment.add";
      readonly anchor: GanttComment["anchor"];
      readonly text: string;
    }
  | {
      readonly type: "comment.edit";
      readonly commentId: string;
      readonly text: string;
    }
  | { readonly type: "comment.delete"; readonly commentId: string };

function anchorRecordId(
  model: MermaidGanttModel,
  anchor: GanttComment["anchor"],
) {
  if (anchor.kind === "diagram") return null;
  if (anchor.kind === "section")
    return (
      model.sections.find((section) => section.id === anchor.id)?.recordId ??
      null
    );
  if (anchor.kind === "option")
    return (
      model.sourceDocument.statements.findLast(
        (statement) => statement.optionName === anchor.id,
      )?.id ?? null
    );
  return anchor.id;
}

export function applyGanttCommentCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttCommentCommand;
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  switch (command.type) {
    case "comment.add": {
      const text = command.text.trim();
      if (!text || /[\r\n]/.test(text))
        return ganttNoChange(model, "invalid-label");
      const recordId = anchorRecordId(model, command.anchor);
      const record = model.sourceDocument.statements.find(
        (statement) => statement.id === recordId,
      );
      const leadingComment = model.comments.find(
        (comment) =>
          comment.anchor.kind === command.anchor.kind &&
          comment.anchor.kind !== "diagram" &&
          command.anchor.kind !== "diagram" &&
          comment.anchor.id === command.anchor.id,
      );
      const first =
        model.sourceDocument.statements.find(
          (statement) => statement.id === leadingComment?.recordId,
        ) ?? record;
      // Object comments are a leading block separated from the previous
      // statement. Inserting after the object silently changes their owner.
      const patch =
        command.anchor.kind === "diagram"
          ? ganttAppendAtEnd(model, `%% ${text}`)
          : first && record
            ? {
                range: { start: first.range.start, end: first.range.start },
                value: `${model.sourceDocument.newline}${record.indent}%% ${text}${model.sourceDocument.newline}`,
              }
            : null;
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "comment.edit": {
      const comment = model.comments.find(
        (candidate) => candidate.id === command.commentId,
      );
      if (!comment) return ganttNoChange(model, "unknown-comment");
      const text = command.text.trim();
      if (!text || /[\r\n]/.test(text))
        return ganttNoChange(model, "invalid-label");
      const statement = model.sourceDocument.statements.find(
        (candidate) => candidate.id === comment.recordId,
      );
      if (!statement) return ganttNoChange(model, "conflict");
      // Edit the payload only; indentation and marker spacing belong to the
      // authored trivia, not to the comment editor's normalized text draft.
      const prefix = /^\s*%%\s*/.exec(statement.raw)?.[0];
      if (!prefix) return ganttNoChange(model, "conflict");
      const patch = {
        range: {
          start: statement.range.start + prefix.length,
          end: statement.range.end,
        },
        value: text,
      };
      return ganttPatchedResult(model, [patch], {
        id: comment.id,
        kind: "comment",
      });
    }
    case "comment.delete": {
      const comment = model.comments.find(
        (candidate) => candidate.id === command.commentId,
      );
      if (!comment) return ganttNoChange(model, "unknown-comment");
      const patch = ganttDeleteStatement(model, comment.recordId);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
  }
}
