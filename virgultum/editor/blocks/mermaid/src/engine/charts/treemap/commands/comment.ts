// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapCommentAnchor, TreemapModel } from "../model.js";
import { treemapRecordRangeWithEnding } from "../source-document.js";
import { treemapNoChange, treemapPatchedResult } from "../writer.js";

export type TreemapCommentCommand =
  | {
      readonly type: "comment.add";
      readonly anchor: TreemapCommentAnchor;
      readonly text: string;
    }
  | {
      readonly type: "comment.update";
      readonly id: string;
      readonly text: string;
    }
  | { readonly type: "comment.delete"; readonly id: string };

function cleanComment(value: string) {
  const text = value.replaceAll(/\r\n|\r|\n/g, " ").trim();
  return text && !text.includes("%%") ? text : null;
}

export function applyTreemapCommentCommand(
  model: TreemapModel,
  command: TreemapCommentCommand,
) {
  if (command.type === "comment.add") {
    const text = cleanComment(command.text);
    if (!text) return treemapNoChange(model, "invalid-comment");
    const anchor = command.anchor;
    const target =
      anchor.kind === "node"
        ? model.nodes.find((node) => node.id === anchor.id)?.recordId
        : anchor.kind === "class-def"
          ? model.classDefs.find((item) => item.id === anchor.id)?.recordId
          : anchor.kind === "metadata"
            ? anchor.id
            : model.sourceDocument.records.find(
                (record) => record.kind === "header",
              )?.id;
    const record = model.sourceDocument.records.find(
      (candidate) => candidate.id === target,
    );
    if (!record) return treemapNoChange(model, "anchor-missing");
    const indent =
      anchor.kind === "node"
        ? (model.nodes.find((node) => node.id === anchor.id)?.indent ?? "")
        : (record.raw.match(/^[ \t]*/)?.[0] ?? "");
    const previous =
      model.sourceDocument.records[
        model.sourceDocument.records.findIndex(
          (candidate) => candidate.id === record.id,
        ) - 1
      ];
    const separator =
      previous && previous.kind !== "header" && previous.kind !== "blank"
        ? model.sourceDocument.newline
        : "";
    return treemapPatchedResult(
      model,
      [
        {
          range: { start: record.range.start, end: record.range.start },
          value: `${separator}${indent}%% ${text}${model.sourceDocument.newline}`,
        },
      ],
      null,
    );
  }
  const comment = model.comments.find(
    (candidate) => candidate.id === command.id,
  );
  const record = comment
    ? model.sourceDocument.records.find(
        (candidate) => candidate.id === comment.recordId,
      )
    : undefined;
  if (!comment || !record) return treemapNoChange(model, "comment-missing");
  if (command.type === "comment.delete")
    return treemapPatchedResult(
      model,
      [
        {
          range: treemapRecordRangeWithEnding(model.sourceDocument, record),
          value: "",
        },
      ],
      null,
    );
  const text = cleanComment(command.text);
  if (!text) return treemapNoChange(model, "invalid-comment");
  const indent = record.raw.match(/^[ \t]*/)?.[0] ?? "";
  return treemapPatchedResult(
    model,
    [{ range: record.range, value: `${indent}%% ${text}` }],
    { kind: "comment", id: comment.id },
    new Map([[record.range.start, record.id]]),
  );
}
