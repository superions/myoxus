// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidSequenceModel,
  MermaidSequenceNotePlacement,
} from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import {
  sequenceAnchor,
  sequenceRecord,
  sequenceRecordGroup,
  sequenceNewRecordPatch,
  sequenceTextValue,
  writeSequencePatches,
  sequenceNoChange,
  reorderSequenceSpan,
  deleteSequenceRecords,
  type SequenceTimelineAnchor,
  type SequenceWriteOptions,
  type SequencePatch,
} from "../writer.js";
import { validSequenceParticipantId } from "./participant-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
export type SequenceNoteValue = {
  participantIds: string[];
  placement: MermaidSequenceNotePlacement;
  label: string;
  wrap?: boolean;
};
function validNote(value: SequenceNoteValue) {
  return (
    ["over", "left of", "right of"].includes(value.placement) &&
    value.participantIds.length > 0 &&
    value.participantIds.length <= (value.placement === "over" ? 2 : 1) &&
    value.participantIds.every(validSequenceParticipantId)
  );
}
function noteLine(value: SequenceNoteValue) {
  return `Note ${value.placement} ${value.participantIds.join(",")}: ${value.wrap === undefined ? "" : value.wrap ? "wrap:" : "nowrap:"}${sequenceTextValue(value.label)}`;
}
export function addSequenceNote(
  model: MermaidSequenceModel,
  value: SequenceNoteValue,
  anchor: SequenceTimelineAnchor = {},
  options: SequenceWriteOptions = {},
) {
  const at = sequenceAnchor(model, anchor),
    key = nextSequenceSourceKey();
  if (!at || !validNote(value))
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  return writeSequencePatches(
    model,
    [
      sequenceNewRecordPatch(
        model,
        at.offset,
        at.indent + noteLine(value),
        key,
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
export function editSequenceNote(
  model: MermaidSequenceModel,
  key: string,
  changes: Partial<SequenceNoteValue>,
  options: SequenceWriteOptions = {},
) {
  const note = model.notes.find((n) => n.id === key),
    record = sequenceRecord(model, key);
  if (!note || !record)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const value = { ...note, ...changes };
  if (!validNote(value))
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  if (
    value.placement === note.placement &&
    value.participantIds.join("\0") === note.participantIds.join("\0") &&
    value.label === note.label &&
    value.wrap === note.wrap
  )
    return sequenceNoChange(model);
  const patches: SequencePatch[] = [];
  if (
    value.placement !== note.placement ||
    value.participantIds.join("\0") !== note.participantIds.join("\0")
  ) {
    const first = record.values["anchor-0"]!,
      last = record.values[`anchor-${note.participantIds.length - 1}`]!;
    const placement = record.raw.toLowerCase().indexOf(note.placement);
    patches.push({
      range: { start: record.range.start + placement, end: last.end },
      value: `${value.placement} ${value.participantIds.join(",")}`,
    });
    if (!first)
      return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  }
  if (value.label !== note.label || value.wrap !== note.wrap) {
    const end =
      record.range.end -
      (/;\s*$/.test(record.raw)
        ? record.raw.length - record.raw.lastIndexOf(";")
        : 0);
    patches.push({
      range: record.values.label ?? { start: end, end },
      value: `${value.wrap === undefined ? "" : value.wrap ? "wrap:" : "nowrap:"}${sequenceTextValue(value.label)}`,
    });
  }
  return writeSequencePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export const reorderSequenceNote = reorderSequenceSpan;
export function deleteSequenceNote(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const group = sequenceRecordGroup(model, key);
  return group
    ? deleteSequenceRecords(model, group.records, options)
    : sequenceNoChange(model, "invalid", m.sequenceMissingObject());
}
