// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  cloneSequenceModel,
  type MermaidSequenceModel,
  type MermaidSequenceMessageArrow,
} from "../model.js";

export function renameMermaidSequenceMessage(
  model: MermaidSequenceModel,
  messageId: string,
  label: string,
) {
  const next = cloneSequenceModel(model);
  const message = next.messages.find((candidate) => candidate.id === messageId);
  if (message) message.label = label.trim();
  return next;
}

export function addMermaidSequenceMessage(
  model: MermaidSequenceModel,
  from: string,
  to: string,
  {
    arrow = "->>",
    label = "",
  }: {
    arrow?: MermaidSequenceMessageArrow;
    label?: string;
  } = {},
) {
  const next = cloneSequenceModel(model);
  const order =
    Math.max(
      -1,
      ...next.activations.map((activation) => activation.order),
      ...next.backgrounds.flatMap((background) => [
        background.startOrder,
        background.endOrder,
      ]),
      ...next.controls.flatMap((control) => [
        control.startOrder,
        control.endOrder,
        ...control.branches.map((branch) => branch.startOrder),
      ]),
      ...next.messages.map((message) => message.order),
      ...next.notes.map((note) => note.order),
    ) + 1;
  const id = `message-${from}-${to}-${order + 1}`;
  next.messages.push({
    arrow,
    centralFrom: false,
    centralTo: false,
    from,
    id,
    label: label.trim(),
    order,
    to,
    y: 112 + order * 64,
  });
  return next;
}

export function setMermaidSequenceMessageArrow(
  model: MermaidSequenceModel,
  messageId: string,
  arrow: MermaidSequenceMessageArrow,
) {
  const next = cloneSequenceModel(model);
  const message = next.messages.find((candidate) => candidate.id === messageId);
  if (message) message.arrow = arrow;
  return next;
}

import {
  isMermaidSequenceMessageArrow,
  isSequenceMessageParticipantId,
} from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  sequenceRecord,
  sequenceRecordEnd,
  sequenceRecordGroup,
  sequenceAnchor,
  sequenceNewRecordPatch,
  sequenceTextValue,
  sequenceNoChange,
  deleteSequenceRecords,
  composeSequenceCommandResults,
  sequenceImpact,
  writeSequencePatches,
  reorderSequenceSpan,
  type SequenceTimelineAnchor,
  type SequenceWriteOptions,
  type SequencePatch,
  type SequenceCommandResult,
} from "../writer.js";
import { validSequenceParticipantId } from "./participant-commands.js";
import { deleteSequenceActivation } from "./activation-commands.js";
export type SequenceMessageValue = {
  sourceKey?: string;
  from: string;
  to: string;
  arrow: MermaidSequenceMessageArrow;
  label: string;
  centralFrom: boolean;
  centralTo: boolean;
  activation?: "+" | "-";
  wrap?: boolean;
};
export function sourceSequenceMessage(value: SequenceMessageValue) {
  return `${value.from}${value.centralFrom ? "()" : ""}${value.arrow}${value.activation ?? ""}${value.centralTo ? "()" : ""}${value.to}: ${value.wrap === undefined ? "" : value.wrap ? "wrap:" : "nowrap:"}${sequenceTextValue(value.label)}`;
}
function validMessage(value: SequenceMessageValue) {
  return (
    validSequenceParticipantId(value.from) &&
    isSequenceMessageParticipantId(value.from) &&
    validSequenceParticipantId(value.to) &&
    isSequenceMessageParticipantId(value.to) &&
    isMermaidSequenceMessageArrow(value.arrow) &&
    (!value.activation || (!value.centralFrom && !value.centralTo))
  );
}
function messageDiagnostic(value: SequenceMessageValue) {
  return value.activation && (value.centralFrom || value.centralTo)
    ? m.sequenceCentralActivationConflict()
    : m.sequencePatchRejected();
}
export function addSequenceMessage(
  model: MermaidSequenceModel,
  value: SequenceMessageValue,
  anchor: SequenceTimelineAnchor = {},
  options: SequenceWriteOptions = {},
) {
  const target = sequenceAnchor(model, anchor),
    key = value.sourceKey ?? nextSequenceSourceKey();
  if (
    !target ||
    !validMessage(value) ||
    model.sourceDocument.records.some((r) => r.sourceKey === key)
  )
    return sequenceNoChange(model, "invalid", messageDiagnostic(value));
  return writeSequencePatches(
    model,
    [
      sequenceNewRecordPatch(
        model,
        target.offset,
        target.indent + sourceSequenceMessage(value),
        key,
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
export function editSequenceMessage(
  model: MermaidSequenceModel,
  key: string,
  changes: Partial<SequenceMessageValue>,
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const message = model.messages.find((n) => n.id === key),
    record = sequenceRecord(model, key);
  if (!message || !record)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  // Stable keys survive conversion to separate statements. Ownership follows
  // the current embedded Message binding, never the spelling of an old key.
  const embedded = model.activations.find(
    (a) => a.embedded && a.messageId === key,
  );
  const interval =
    embedded &&
    model.activationIntervals.find(
      (interval) =>
        interval.startId === embedded.id || interval.endId === embedded.id,
    );
  if (
    interval &&
    Object.hasOwn(changes, "activation") &&
    changes.activation !== message.activation
  ) {
    const cleared = deleteSequenceActivation(model, interval.id, options);
    if (cleared.status === "rejected") return cleared;
    const edited = editSequenceMessage(cleared.model, key, changes, {
      ...options,
      baseSource: undefined,
    });
    return composeSequenceCommandResults(
      model,
      { ...edited, impact: cleared.impact },
      options,
    );
  }
  const value = { ...message, ...changes },
    patches: SequencePatch[] = [];
  if (!validMessage(value))
    return sequenceNoChange(model, "invalid", messageDiagnostic(value));
  for (const end of ["from", "to"] as const)
    if (value[end] !== message[end])
      patches.push({ range: record.values[end]!, value: value[end] });
  const affected = [record];
  if (interval) {
    const start = interval.startId === embedded!.id,
      field = start ? "to" : "from",
      otherId = start ? interval.endId : interval.startId;
    if (value[field] !== message[field] && otherId) {
      const endpoint = model.activations.find((a) => a.id === otherId)!;
      const other = sequenceRecord(model, endpoint.messageId ?? endpoint.id)!;
      patches.push({
        range:
          other.values[
            endpoint.embedded
              ? endpoint.kind === "activate"
                ? "to"
                : "from"
              : "id"
          ]!,
        value: value[field],
      });
      affected.push(other);
    }
  }
  if (value.arrow !== message.arrow)
    patches.push({ range: record.values.arrow!, value: value.arrow });
  for (const field of ["centralFrom", "centralTo", "activation"] as const) {
    if (value[field] === message[field]) continue;
    const offset =
      field === "centralFrom"
        ? record.values.arrow!.start
        : field === "centralTo"
          ? record.values.to!.start
          : record.values.arrow!.end;
    patches.push({
      range: record.values[field] ?? { start: offset, end: offset },
      value:
        field === "activation"
          ? (value.activation ?? "")
          : value[field]
            ? "()"
            : "",
    });
  }
  if (value.label !== message.label || value.wrap !== message.wrap) {
    const text = `${value.wrap === undefined ? "" : value.wrap ? "wrap:" : "nowrap:"}${sequenceTextValue(value.label)}`;
    const range = record.values.label ?? {
      start:
        record.range.end -
        (/;\s*$/.test(record.raw)
          ? record.raw.length - record.raw.lastIndexOf(";")
          : 0),
      end:
        record.range.end -
        (/;\s*$/.test(record.raw)
          ? record.raw.length - record.raw.lastIndexOf(";")
          : 0),
    };
    patches.push({ range, value: text });
  }
  const result = writeSequencePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
    impact: sequenceImpact(model, affected),
  });
  return { ...result, impact: sequenceImpact(model, affected) };
}
export function flipSequenceMessage(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const message = model.messages.find((n) => n.id === key);
  return message
    ? editSequenceMessage(
        model,
        key,
        {
          from: message.to,
          to: message.from,
          centralFrom: message.centralTo,
          centralTo: message.centralFrom,
        },
        options,
      )
    : sequenceNoChange(model, "invalid", m.sequenceMissingObject());
}
export const reorderSequenceMessage = reorderSequenceSpan;
export function deleteSequenceMessage(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const message = model.messages.find((n) => n.id === key),
    group = sequenceRecordGroup(model, key);
  if (!message || !group)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const embedded = model.activations.find(
    (a) => a.embedded && a.messageId === key && a.kind === "activate",
  );
  const interval =
    embedded &&
    model.activationIntervals.find((a) => a.startId === embedded.id);
  const destroyed = model.activations.filter(
    (a) => a.messageId === key && a.kind === "destroy",
  );
  const owners = new Set([interval?.endId, ...destroyed.map((a) => a.id)]);
  const extras = model.commentRecords.filter(
    (c) =>
      c.anchorId &&
      owners.has(c.anchorId) &&
      !group.records.some((r) => r.sourceKey === c.id),
  );
  if (extras.length) {
    const cleared = deleteSequenceRecords(
      model,
      extras.flatMap((c) => sequenceRecord(model, c.id) ?? []),
      options,
    );
    if (cleared.status === "rejected") return cleared;
    const deleted = deleteSequenceMessage(cleared.model, key, {
      ...options,
      baseSource: undefined,
    });
    return composeSequenceCommandResults(
      model,
      {
        ...deleted,
        impact: {
          records: [...cleared.impact.records, ...deleted.impact.records],
        },
      },
      options,
    );
  }
  const patches: SequencePatch[] = [{ range: group.range, value: "" }],
    removed = new Set(group.records.map((r) => r.sourceKey));
  const impact = sequenceImpact(model, group.records).records.map((r) => ({
    ...r,
  }));
  if (interval?.endId) {
    const endpoint = model.activations.find((a) => a.id === interval.endId)!;
    const record = sequenceRecord(model, endpoint.messageId ?? endpoint.id)!;
    if (endpoint.embedded)
      patches.push({ range: record.values.activation!, value: "" });
    else {
      patches.push({
        range: { start: record.range.start, end: sequenceRecordEnd(record) },
        value: "",
      });
      removed.add(record.sourceKey);
    }
    impact.push({
      id: endpoint.id,
      kind: "activation",
      label: endpoint.participantId,
    });
  }
  for (const lifecycle of model.activations.filter(
    (a) => a.messageId === key && (a.kind === "create" || a.kind === "destroy"),
  )) {
    const r = sequenceRecord(model, lifecycle.id)!;
    if (lifecycle.kind === "create") {
      const start = r.range.start + r.raw.toLowerCase().indexOf("create");
      patches.push({
        range: { start, end: start + "create".length },
        value: "",
      });
    } else {
      patches.push({
        range: { start: r.range.start, end: sequenceRecordEnd(r) },
        value: "",
      });
      removed.add(r.sourceKey);
    }
    impact.push({
      id: lifecycle.id,
      kind: lifecycle.kind === "create" ? "create" : "destroy",
      label: lifecycle.participantId,
    });
  }
  return writeSequencePatches(model, patches, {
    ...options,
    removed,
    impact: { records: impact },
  });
}
