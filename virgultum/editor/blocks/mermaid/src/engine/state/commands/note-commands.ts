// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel } from "../model.js";
import { nextStateSourceKey } from "../source-document.js";
import { stateObject } from "./state-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  stateRecord,
  stateNoChange,
  stateInsertAnchor,
  stateNewRecordPatch,
  stateTextValue,
  stateSourceIdValue,
  stateRecordGroup,
  stateMoveRecords,
  composeStateCommandResults,
  writeStatePatches,
  deleteStateRecords,
  type StateInsertAnchor,
  type StateWriteOptions,
} from "../writer.js";

export type StateNoteValue = {
  form: "inline" | "multiline" | "floating";
  text: string;
  target?: string;
  floatingId?: string;
  side: "left of" | "right of";
  anchor?: StateInsertAnchor;
};
function noteText(
  model: MermaidStateModel,
  value: StateNoteValue,
  indent: string,
) {
  if (value.form === "floating") {
    if (!value.floatingId || !stateSourceIdValue(value.floatingId, "floating"))
      return null;
    return `${indent}note "${stateTextValue(value.text).replaceAll('"', "#34;")}" as ${value.floatingId}`;
  }
  const target = value.target && stateObject(model, value.target);
  if (
    !target ||
    ("kind" in target && ["start", "end"].includes(target.kind)) ||
    !["left of", "right of"].includes(value.side)
  )
    return null;
  if (value.form === "inline")
    return `${indent}note ${value.side} ${target.id}: ${stateTextValue(value.text)}`;
  if (value.form !== "multiline" || /^\s*end\s+note\s*$/im.test(value.text))
    return null;
  const body = value.text
    .split(/\r\n|\r|\n/)
    .map((line) => `${indent}  ${line}`)
    .join(model.sourceDocument.newline);
  return `${indent}note ${value.side} ${target.id}${model.sourceDocument.newline}${body}${model.sourceDocument.newline}${indent}end note`;
}
export function addStateNote(
  model: MermaidStateModel,
  value: StateNoteValue,
  options: StateWriteOptions = {},
) {
  const at = stateInsertAnchor(model, value.anchor),
    key = nextStateSourceKey();
  const text = at && noteText(model, value, at.indent);
  if (!at || text === null)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(
    model,
    [stateNewRecordPatch(model, at.offset, text, key)],
    { ...options, selection: key, focus: key },
  );
}
export function editStateNote(
  model: MermaidStateModel,
  key: string,
  value: StateNoteValue,
  options: StateWriteOptions = {},
) {
  // Forms own different fields. Facade forms can retain empty values for the
  // hidden fields; those must not turn a text edit into a notation rewrite.
  const floatingId = value.form === "floating" ? value.floatingId : undefined;
  const stateId =
    value.form === "floating"
      ? undefined
      : value.target && stateObject(model, value.target)?.id;
  const note = model.notes.find((n) => n.id === key),
    r = note && stateRecord(model, key);
  const text = r && noteText(model, value, r.indent);
  if (!note || !r || text === null || text === undefined)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (
    value.text === stateDisplayText(note.label) &&
    value.form === note.form &&
    value.side === note.placement &&
    stateId === note.stateId &&
    floatingId === note.floatingId &&
    !value.anchor
  )
    return writeStatePatches(model, [], options);
  // Within the same form only owned fields change; whitespace and multiline
  // delimiters survive. A conscious form conversion owns this one note record.
  const patches = [];
  if (
    note.form === value.form &&
    note.placement === value.side &&
    note.stateId === stateId &&
    note.floatingId === floatingId &&
    r.values.text
  ) {
    const bodyIndent =
      value.form === "multiline"
        ? /^[ \t]*/.exec(
            model.sourceDocument.source.slice(
              model.sourceDocument.source.lastIndexOf(
                "\n",
                r.values.text.start - 1,
              ) + 1,
              r.values.text.start,
            ),
          )![0]
        : "";
    const encoded =
      value.form === "multiline"
        ? value.text.replaceAll(
            /\r\n|\r|\n/g,
            model.sourceDocument.newline + bodyIndent,
          )
        : stateTextValue(value.text).replaceAll(
            '"',
            value.form === "floating" ? "#34;" : '"',
          );
    if (value.text !== stateDisplayText(note.label))
      patches.push({ range: r.values.text, value: encoded });
  } else
    patches.push({
      range: r.range,
      value: text,
      identities: [[0, key]] as const,
    });
  let result = writeStatePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
  if (result.status === "rejected" || !value.anchor) return result;
  const next = result.model,
    at = stateInsertAnchor(next, value.anchor),
    group = stateRecordGroup(next, key);
  if (!at || !group)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  result = writeStatePatches(
    next,
    stateMoveRecords(next, group.records, at.offset),
    { ...options, baseSource: result.source, selection: key, focus: key },
  );
  return composeStateCommandResults(model, result, options);
}
export function deleteStateNote(
  model: MermaidStateModel,
  key: string,
  options: StateWriteOptions = {},
) {
  const note = model.notes.find((n) => n.id === key),
    record = note && stateRecord(model, key);
  if (!record) return stateNoChange(model, "invalid", m.stateMissingObject());
  return deleteStateRecords(model, [record], {
    ...options,
    commentTransfers: new Set(
      model.commentRecords.filter((c) => c.anchorId === key).map((c) => c.id),
    ),
  });
}

import { stateDisplayText } from "../source-document.js";
