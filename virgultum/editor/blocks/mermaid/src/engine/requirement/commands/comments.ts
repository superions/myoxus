// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import { nextRequirementSourceKey } from "../source-document.js";
import {
  requirementNoChange,
  requirementRecordEnd,
  writeRequirementPatches,
  type RequirementWriteOptions,
} from "../writer.js";

export type RequirementCommentAnchor = {
  key?: string;
  position: "before" | "after";
};
export type RequirementComment = {
  key: string;
  text: string;
  anchor: RequirementCommentAnchor;
};
/** Comments stay at their literal Source occurrence. Body comments follow their
 * next property (or enclosing object); preamble comments belong to the diagram. */
export function requirementComments(
  model: MermaidRequirementModel,
): RequirementComment[] {
  const records = model.sourceDocument?.records ?? [];
  return records.flatMap((record, index) => {
    if (record.kind !== "comment") return [];
    const next = records
      .slice(index + 1)
      .find((next) => !["blank", "comment"].includes(next.kind));
    const previous = records
      .slice(0, index)
      .findLast((previous) => !["blank", "comment"].includes(previous.kind));
    const body =
      record.blockKey &&
      records.find((candidate) => candidate.sourceKey === record.blockKey);
    const diagram =
      !body &&
      !records
        .slice(0, index)
        .some((previous) =>
          [
            "object-open",
            "relation",
            "style",
            "style-assignment",
            "style-definition",
            "inline-class",
          ].includes(previous.kind),
        );
    const anchor: RequirementCommentAnchor = diagram
      ? { position: "after" }
      : body
        ? next && next.blockKey === record.blockKey && next.kind === "property"
          ? { key: next.sourceKey, position: "before" }
          : { key: body.sourceKey, position: "after" }
        : next
          ? { key: next.sourceKey, position: "before" }
          : { key: previous?.sourceKey, position: "after" };
    return [
      {
        key: record.sourceKey,
        text: record.raw
          .slice(record.indent.length)
          .replace(/^(?:%%|%|#) ?/, ""),
        anchor,
      },
    ];
  });
}
export type RequirementCommentCommand =
  | { type: "add"; anchor: RequirementCommentAnchor; text: string }
  | { type: "edit"; key: string; text: string }
  | { type: "delete"; key: string };

/** A comment action is one minimal checked record write, never a serializer
 * pass that relocates comments or discards ignored Source providers. */
export function editRequirementComment(
  model: MermaidRequirementModel,
  command: RequirementCommentCommand,
  options: RequirementWriteOptions = {},
) {
  const document = model.sourceDocument;
  if (!document) return requirementNoChange(model, "invalid");
  if (
    command.type !== "delete" &&
    (!command.text.trim() ||
      /[\r\n]/.test(command.text) ||
      command.text.trimStart().startsWith("{"))
  )
    return requirementNoChange(model, "invalid");
  if (command.type !== "add") {
    const record = document.records.find(
      (record) => record.sourceKey === command.key && record.kind === "comment",
    );
    if (!record) return requirementNoChange(model, "invalid");
    if (command.type === "delete")
      return writeRequirementPatches(
        model,
        [
          {
            range: {
              start: record.range.start,
              end: requirementRecordEnd(record),
            },
            value: "",
          },
        ],
        { ...options, removed: new Set([record.sourceKey]) },
      );
    const marker =
      /^(%%|%|#)/.exec(record.raw.slice(record.indent.length))?.[0] ?? "%%";
    return writeRequirementPatches(
      model,
      [
        {
          range: {
            start: record.range.start + record.indent.length + marker.length,
            end: record.range.end,
          },
          value: ` ${command.text}`,
        },
      ],
      options,
    );
  }
  const anchor = command.anchor,
    record = document.records.find((record) =>
      anchor.key ? record.sourceKey === anchor.key : record.kind === "header",
    );
  if (!record) return requirementNoChange(model, "invalid");
  const close =
    record.kind === "object-open" &&
    document.records.find(
      (candidate) =>
        candidate.kind === "object-close" &&
        candidate.blockKey === record.sourceKey,
    );
  const offset = !anchor.key
    ? requirementRecordEnd(record)
    : record.kind === "object-open" && anchor.position === "after" && close
      ? close.range.start
      : anchor.position === "before"
        ? record.range.start
        : requirementRecordEnd(record);
  const indent =
    record.kind === "object-open" && anchor.position === "after"
      ? (document.records.find(
          (candidate) =>
            candidate.blockKey === record.sourceKey &&
            candidate.kind === "property",
        )?.indent ?? `${record.indent}  `)
      : record.indent;
  const prefix =
    offset > 0 && !/[\r\n]$/.test(document.source.slice(0, offset))
      ? document.newline
      : "";
  const key = nextRequirementSourceKey();
  return writeRequirementPatches(
    model,
    [
      {
        range: { start: offset, end: offset },
        value: `${prefix}${indent}%% ${command.text}${document.newline}`,
        identities: [[prefix.length, key]],
      },
    ],
    options,
  );
}
