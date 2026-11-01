// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidSequenceModel } from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import {
  sequenceAnchor,
  sequenceRecord,
  sequenceRecordEnd,
  sequenceNewRecordPatch,
  sequenceMoveRecords,
  sequenceSpan,
  sequenceNoChange,
  deleteSequenceRecords,
  composeSequenceCommandResults,
  writeSequencePatches,
  type SequenceCommandResult,
  type SequencePatch,
  type SequenceTimelineAnchor,
  type SequenceWriteOptions,
} from "../writer.js";
import { validSequenceParticipantId } from "./participant-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
export function addSequenceActivation(
  model: MermaidSequenceModel,
  value: {
    participantId: string;
    start: SequenceTimelineAnchor;
    end?: SequenceTimelineAnchor;
  },
  options: SequenceWriteOptions = {},
) {
  const start = sequenceAnchor(model, value.start),
    end = value.end ? sequenceAnchor(model, value.end) : undefined,
    key = nextSequenceSourceKey();
  if (
    !start ||
    (value.end && !end) ||
    !validSequenceParticipantId(value.participantId) ||
    (end && start.offset >= end.offset)
  )
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  const patches = [
    sequenceNewRecordPatch(
      model,
      start.offset,
      `${start.indent}activate ${value.participantId}`,
      key,
    ),
  ];
  if (end)
    patches.push(
      sequenceNewRecordPatch(
        model,
        end.offset,
        `${end.indent}deactivate ${value.participantId}`,
        nextSequenceSourceKey(),
      ),
    );
  return writeSequencePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
/** Boundaries may be separate statements or a message decoration. Moving an
 * embedded boundary moves its owning message; conversion must be explicit. */
export function editSequenceActivation(
  model: MermaidSequenceModel,
  key: string,
  value: {
    participantId?: string;
    start?: SequenceTimelineAnchor;
    end?: SequenceTimelineAnchor | null;
    separate?: boolean;
  },
  options: SequenceWriteOptions = {},
) {
  const interval = model.activationIntervals.find((a) => a.id === key);
  if (!interval)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const id = value.participantId ?? interval.participantId;
  if (!validSequenceParticipantId(id))
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  const patches: SequencePatch[] = [],
    removed = new Set<string>();
  for (const [bound, endpointId] of [
    ["start", interval.startId],
    ["end", interval.endId],
  ] as const) {
    if (!endpointId) continue;
    const endpoint = model.activations.find((a) => a.id === endpointId)!,
      record = sequenceRecord(model, endpoint.messageId ?? endpoint.id)!;
    const anchorValue = value[bound],
      target = anchorValue ? sequenceAnchor(model, anchorValue) : undefined;
    if (anchorValue && !target)
      return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
    if (bound === "end" && value.end === null) {
      if (endpoint.embedded)
        patches.push({ range: record.values.activation!, value: "" });
      else {
        patches.push({
          range: { start: record.range.start, end: sequenceRecordEnd(record) },
          value: "",
        });
        removed.add(record.sourceKey);
      }
      continue;
    }
    if (endpoint.embedded && value.separate) {
      patches.push({ range: record.values.activation!, value: "" });
      const offset = target?.offset ?? sequenceRecordEnd(record);
      patches.push(
        sequenceNewRecordPatch(
          model,
          offset,
          `${target?.indent ?? record.indent}${endpoint.kind} ${id}`,
          endpoint.id,
        ),
      );
    } else if (target) {
      const span = endpoint.embedded
        ? sequenceSpan(model, record.sourceKey)!
        : { records: [record] };
      const moves = sequenceMoveRecords(model, span.records, target.offset);
      // A moved statement owns its new participant token too; adjust its copied
      // bytes instead of overlapping an original-range edit with its deletion.
      if (id !== interval.participantId && moves.length) {
        const insert = moves.find((p) => p.value)!;
        const ref = endpoint.embedded
          ? record.values[endpoint.kind === "activate" ? "to" : "from"]!
          : record.values.id!;
        const origin = insert.identities!.find(
          ([, k]) => k === record.sourceKey,
        )![0];
        const at = origin + ref.start - record.range.start;
        insert.value =
          insert.value.slice(0, at) +
          id +
          insert.value.slice(at + ref.end - ref.start);
        insert.identities = insert.identities?.map(
          ([offset, key]) =>
            [
              offset > at ? offset + id.length - (ref.end - ref.start) : offset,
              key,
            ] as const,
        );
      }
      patches.push(...moves);
    } else if (id !== interval.participantId)
      patches.push({
        range:
          record.values[
            endpoint.embedded
              ? endpoint.kind === "activate"
                ? "to"
                : "from"
              : "id"
          ]!,
        value: id,
      });
  }
  if (value.end && !interval.endId) {
    const end = sequenceAnchor(model, value.end);
    if (!end)
      return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
    patches.push(
      sequenceNewRecordPatch(
        model,
        end.offset,
        `${end.indent}deactivate ${id}`,
        nextSequenceSourceKey(),
      ),
    );
  }
  return writeSequencePatches(model, patches, {
    ...options,
    removed,
    selection: key,
    focus: key,
    impact: {
      records: [{ id: key, kind: "activation", label: interval.participantId }],
    },
  });
}
export function deleteSequenceActivation(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const interval = model.activationIntervals.find((a) => a.id === key);
  if (!interval)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const comments = model.commentRecords.filter(
    (c) =>
      c.anchorKind === "activation" &&
      (c.anchorId === interval.startId || c.anchorId === interval.endId),
  );
  if (comments.length) {
    const cleared = deleteSequenceRecords(
      model,
      comments.flatMap((c) => sequenceRecord(model, c.id) ?? []),
      options,
    );
    if (cleared.status === "rejected") return cleared;
    const deleted = deleteSequenceActivation(cleared.model, key, {
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
  const patches: SequencePatch[] = [],
    removed = new Set<string>();
  for (const id of [interval.startId, interval.endId]) {
    const endpoint = model.activations.find((a) => a.id === id);
    if (!endpoint) continue;
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
  }
  return writeSequencePatches(model, patches, {
    ...options,
    removed,
    impact: {
      records: [{ id: key, kind: "activation", label: interval.participantId }],
    },
  });
}
