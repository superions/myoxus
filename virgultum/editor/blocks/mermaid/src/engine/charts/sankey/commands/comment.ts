// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../model.js";
import { sankeyNoChange, sankeyPatchedResult } from "../writer.js";
import { sankeyOwnedLinkRange } from "./link.js";

export type SankeyCommentCommand =
  | {
      readonly type: "comment.add";
      readonly linkId?: string;
      readonly text: string;
    }
  | {
      readonly type: "comment.edit";
      readonly id: string;
      readonly text: string;
    }
  | { readonly type: "comment.delete"; readonly id: string };

export function applySankeyCommentCommand(
  model: SankeyModel,
  command: SankeyCommentCommand,
) {
  const { sourceDocument: document } = model;
  const text = command.type === "comment.delete" ? "" : command.text;
  if (
    command.type !== "comment.delete" &&
    (!text.trim() ||
      text.split(/\r\n|\r|\n/).some((line) => line.trimStart().startsWith("{")))
  )
    return sankeyNoChange(model, "comment-invalid");
  const encoded = text
    .split(/\r\n|\r|\n/)
    .map((line) => `%% ${line}`)
    .join(document.newline);
  if (command.type === "comment.add") {
    const anchor = command.linkId
      ? document.records.find(
          (record) => record.id === command.linkId && record.kind === "csv",
        )
      : document.records.find((record) => record.kind === "header");
    if (!anchor) return sankeyNoChange(model, "conflict");
    const owned = command.linkId
      ? sankeyOwnedLinkRange(model, command.linkId)
      : null;
    // Extend an existing bound block from its beginning. Inserting a blank
    // before the CSV row would detach every comment already owned by that row.
    const position = owned?.start ?? anchor.range.start;
    const result = sankeyPatchedResult(
      model,
      [
        {
          range: { start: position, end: position },
          value: `${command.linkId ? document.newline : ""}${encoded}${document.newline}`,
        },
      ],
      null,
    );
    const added = result.model.comments.find(
      (comment) => !model.comments.some((old) => old.id === comment.id),
    );
    return {
      ...result,
      selection: added ? { kind: "comment" as const, id: added.id } : null,
    };
  }
  const record = document.records.find(
    (record) => record.id === command.id && record.kind === "comment",
  );
  if (!record) return sankeyNoChange(model, "conflict");
  const indentation = record.raw.match(/^ */)?.[0] ?? "";
  return sankeyPatchedResult(
    model,
    [
      {
        range: record.range,
        value:
          command.type === "comment.delete"
            ? ""
            : encoded
                .split(document.newline)
                .map((line) => indentation + line)
                .join(document.newline),
      },
    ],
    command.type === "comment.delete"
      ? null
      : { kind: "comment", id: command.id },
  );
}
