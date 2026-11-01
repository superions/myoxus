// SPDX-License-Identifier: AGPL-3.0-or-later

import { nextC4SourceKey, type C4SourceRecord } from "../source-document.js";
import type { MermaidC4Model } from "../model.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4RecordEnd } from "../source-unit.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4CommentTarget = {
  sourceKey: string;
  position: "before" | "inline" | "after";
};
export function c4CommentText(record: C4SourceRecord) {
  return record.raw.replace(/^[ \t]*%%[ \t]?/, "");
}
/** Source has one comment per physical line; its real anchor comes from the scanner. */
export function c4CommentTargets(
  model: MermaidC4Model,
  commentKey?: string,
): C4CommentTarget[] {
  const records = model.sourceDocument.records,
    owners = records.filter(
      (r) =>
        !["comment", "blank", "frontmatter", "directive", "invalid"].includes(
          r.kind,
        ),
    );
  return owners.flatMap((r) => [
    { sourceKey: r.sourceKey, position: "before" } as const,
    ...(!records.some(
      (c) =>
        c.kind === "comment" &&
        c.sourceKey !== commentKey &&
        c.anchor?.sourceKey === r.sourceKey &&
        c.anchor.position === "inline",
    ) && !/[\r\n]/.test(r.raw)
      ? [{ sourceKey: r.sourceKey, position: "inline" } as const]
      : []),
    ...(r === owners.at(-1)
      ? [{ sourceKey: r.sourceKey, position: "after" } as const]
      : []),
  ]);
}
function deletion(record: C4SourceRecord): C4Patch {
  // An inline comment owns the line ending. Keep it so adjacent calls cannot merge.
  return {
    start: record.range.start,
    end:
      record.anchor?.position === "inline"
        ? record.range.end
        : c4RecordEnd(record),
    text: "",
  };
}
export function editC4Comment(
  model: MermaidC4Model,
  value: { sourceKey?: string; text: string; target: C4CommentTarget },
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === value.sourceKey && r.kind === "comment",
  );
  if (
    (value.sourceKey && !record) ||
    /[\r\n]/.test(value.text) ||
    !c4CommentTargets(model, value.sourceKey).some(
      (t) =>
        t.sourceKey === value.target.sourceKey &&
        t.position === value.target.position,
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  const key = record?.sourceKey ?? nextC4SourceKey();
  if (
    record?.anchor?.sourceKey === value.target.sourceKey &&
    record.anchor.position === value.target.position
  ) {
    if (c4CommentText(record) === value.text) return c4NoChange(model);
    const prefix = /^[ \t]*%%[ \t]?/.exec(record.raw)![0];
    const text =
      prefix +
      (prefix.endsWith("%%") && value.text.startsWith("{") ? " " : "") +
      value.text;
    try {
      return c4CommandResult(
        model,
        writeC4Patches(model, [
          { start: record.range.start, end: record.range.end, text },
        ]),
        key,
      );
    } catch (error) {
      if (!(error instanceof C4WriteError)) throw error;
      return c4NoChange(model, m.classPatchRejected());
    }
  }
  const anchor = model.sourceDocument.records.find(
    (r) => r.sourceKey === value.target.sourceKey,
  )!;
  const at =
    value.target.position === "before"
      ? anchor.range.start
      : value.target.position === "inline"
        ? anchor.range.end
        : c4RecordEnd(anchor);
  const newline = model.sourceDocument.newline;
  const prefix =
    value.target.position === "inline"
      ? " "
      : at > 0 && !/[\r\n]$/.test(model.sourceDocument.source.slice(0, at))
        ? newline
        : "";
  const text =
    prefix +
    (value.target.position === "inline" ? "" : anchor.indent) +
    "%% " +
    value.text +
    (value.target.position === "inline" ? "" : newline);
  const patches: C4Patch[] = [
    ...(record ? [deletion(record)] : []),
    {
      start: at,
      end: at,
      text,
      identities: [
        [value.target.position === "inline" ? 0 : prefix.length, key],
      ],
    },
  ];
  try {
    const next = writeC4Patches(model, patches),
      actual = next.model.sourceDocument.records.find(
        (r) => r.sourceKey === key,
      );
    if (
      actual?.kind !== "comment" ||
      actual.anchor?.sourceKey !== anchor.sourceKey ||
      actual.anchor.position !== value.target.position
    )
      return c4NoChange(model, m.classPatchRejected());
    return c4CommandResult(model, next, key);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export function removeC4Comment(
  model: MermaidC4Model,
  sourceKey: string,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey && r.kind === "comment",
  );
  if (!record) return c4NoChange(model, m.classPatchRejected());
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, [deletion(record)]),
      record.anchor?.sourceKey,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
