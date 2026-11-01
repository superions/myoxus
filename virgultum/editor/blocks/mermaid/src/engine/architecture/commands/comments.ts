// SPDX-License-Identifier: AGPL-3.0-or-later

import { architectureCommentLine } from "../grammar.js";
import type {
  MermaidArchitectureComment,
  MermaidArchitectureModel,
} from "../model.js";
import type { MermaidArchitectureSourceDocument } from "../source-document.js";
import {
  architectureCommandResult,
  cloneArchitectureModel,
  refreshArchitectureSourceAnnotations,
  unchangedArchitectureCommand,
} from "./shared.js";

function architectureCommentText(value: string) {
  return value.trim().replace(/^%%\s*/, "");
}

function architectureCommentRecordLine(
  document: MermaidArchitectureSourceDocument,
  commentId: string,
) {
  const record = document.records.find((candidate) =>
    candidate.kind === "comment"
      ? candidate.id === commentId
      : candidate.commentId === commentId,
  );
  return record?.startLine;
}

function architectureCommentAnchorLine(
  document: MermaidArchitectureSourceDocument,
  anchor: Pick<MermaidArchitectureComment, "anchorId" | "anchorKind">,
) {
  if (anchor.anchorKind === "diagram") {
    return anchor.anchorId === "end"
      ? Math.max(0, document.lines.findLastIndex((line) => line.trim()) + 1)
      : (document.records.find((record) => record.kind === "header")
          ?.startLine ?? 0);
  }
  return document.records.find((record) => {
    if (anchor.anchorKind === "metadata") {
      return record.kind === "metadata" && record.field === anchor.anchorId;
    }
    return (
      record.kind === "statement" &&
      record.statementKind === anchor.anchorKind &&
      record.id === anchor.anchorId
    );
  })?.startLine;
}

export function addMermaidArchitectureComment(
  model: MermaidArchitectureModel,
  anchor: Pick<MermaidArchitectureComment, "anchorId" | "anchorKind"> &
    Partial<Pick<MermaidArchitectureComment, "position">>,
  value: string,
) {
  const text = architectureCommentText(value);
  if (!text) {
    return unchangedArchitectureCommand(
      model,
      anchor.anchorId
        ? { id: anchor.anchorId, kind: anchor.anchorKind }
        : { kind: "diagram" },
      "comment",
      "architecture.comment-empty",
    );
  }
  const next = cloneArchitectureModel(model);
  const comments = next.comments ?? [];
  let index = comments.length + 1;
  const ids = new Set(comments.map((comment) => comment.id));
  while (ids.has(`comment-${index}`)) index += 1;
  const comment: MermaidArchitectureComment = {
    ...anchor,
    id: `comment-${index}`,
    line: architectureCommentLine(text),
    position: anchor.position ?? "before",
  };
  const anchorLine = next.sourceDocument
    ? architectureCommentAnchorLine(next.sourceDocument, anchor)
    : undefined;
  const insertionIndex =
    next.sourceDocument && anchorLine !== undefined
      ? comments.findIndex((existing) => {
          const line = architectureCommentRecordLine(
            next.sourceDocument!,
            existing.id,
          );
          return line !== undefined && line >= anchorLine;
        })
      : -1;
  if (insertionIndex < 0) comments.push(comment);
  else comments.splice(insertionIndex, 0, comment);
  next.comments = comments;
  refreshArchitectureSourceAnnotations(next);
  return architectureCommandResult(
    next,
    true,
    { id: comment.id, kind: "comment" },
    "comment",
  );
}

export function updateMermaidArchitectureComment(
  model: MermaidArchitectureModel,
  commentId: string,
  value: string,
) {
  const next = cloneArchitectureModel(model);
  const comment = next.comments?.find(
    (candidate) => candidate.id === commentId,
  );
  const selectionAfter = { id: commentId, kind: "comment" } as const;
  if (!comment) {
    return unchangedArchitectureCommand(
      model,
      selectionAfter,
      "comment",
      "architecture.comment-not-found",
    );
  }
  const text = architectureCommentText(value);
  if (!text) {
    return unchangedArchitectureCommand(
      model,
      selectionAfter,
      "comment",
      "architecture.comment-empty",
    );
  }
  comment.line = architectureCommentLine(text);
  refreshArchitectureSourceAnnotations(next);
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(next, true, selectionAfter, "comment")
    : unchangedArchitectureCommand(
        model,
        selectionAfter,
        "comment",
        "architecture.no-change",
      );
}

export function deleteMermaidArchitectureComment(
  model: MermaidArchitectureModel,
  commentId: string,
) {
  const next = cloneArchitectureModel(model);
  const selectionAfter = { kind: "diagram" } as const;
  if (!next.comments?.some((comment) => comment.id === commentId)) {
    return unchangedArchitectureCommand(
      model,
      selectionAfter,
      "canvas",
      "architecture.comment-not-found",
    );
  }
  next.comments = (next.comments ?? []).filter(
    (comment) => comment.id !== commentId,
  );
  refreshArchitectureSourceAnnotations(next);
  return architectureCommandResult(next, true, selectionAfter, "canvas");
}
