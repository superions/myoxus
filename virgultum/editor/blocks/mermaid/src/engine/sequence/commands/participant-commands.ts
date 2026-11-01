// SPDX-License-Identifier: AGPL-3.0-or-later

import { cloneSequenceModel, type MermaidSequenceModel } from "../model.js";

export function renameMermaidSequenceParticipant(
  model: MermaidSequenceModel,
  participantId: string,
  label: string,
) {
  const next = cloneSequenceModel(model);
  const participant = next.participants.find(
    (candidate) => candidate.id === participantId,
  );
  if (participant) participant.label = label.trim() || participant.id;
  return next;
}

export function moveMermaidSequenceParticipant(
  model: MermaidSequenceModel,
  participantId: string,
  dx: number,
) {
  const next = cloneSequenceModel(model);
  const participant = next.participants.find(
    (candidate) => candidate.id === participantId,
  );
  if (participant) participant.x = Math.max(20, participant.x + dx);
  return next;
}

import type { SequenceParticipantType } from "../model.js";
import { SEQUENCE_PARTICIPANT_TYPES } from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import { readSourceYaml, sourceYamlFieldPatch } from "../../source-yaml.js";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  sequenceRecord,
  sequenceRecordEnd,
  sequenceRecordGroup,
  sequenceNewRecordPatch,
  sequenceMoveRecordGroups,
  sequenceTextValue,
  writeSequencePatches,
  sequenceNoChange,
  composeSequenceCommandResults,
  deleteSequenceRecords,
  sequenceImpact,
  type SequenceWriteOptions,
  type SequencePatch,
  type SequenceCommandResult,
} from "../writer.js";

export function sequenceParticipant(model: MermaidSequenceModel, key: string) {
  return model.participants.find((p) => p.sourceKey === key || p.id === key);
}
export function validSequenceParticipantId(id: string) {
  return (
    Boolean(id.trim()) &&
    !/[<>:\r\n,;@#]/.test(id) &&
    !/^(?:end|else|and|option|participant|actor|create|destroy|sequenceDiagram)$/i.test(
      id.trim(),
    )
  );
}
export function sequenceParticipantDeclaration(
  p: { id: string; label?: string; type?: SequenceParticipantType },
  prefix = "participant",
) {
  const type = p.type ?? "participant",
    keyword = type === "actor" ? "actor" : prefix;
  return `${keyword} ${p.id}${type !== "actor" && type !== "participant" ? `@{type: ${type}}` : ""}${p.label !== undefined && p.label !== p.id ? ` as ${sequenceTextValue(p.label)}` : ""}`;
}
export function addSequenceParticipant(
  model: MermaidSequenceModel,
  value: {
    id: string;
    sourceKey?: string;
    label?: string;
    type?: SequenceParticipantType;
    boxId?: string | null;
  },
  options: SequenceWriteOptions = {},
) {
  if (
    !validSequenceParticipantId(value.id) ||
    (value.type && !SEQUENCE_PARTICIPANT_TYPES.includes(value.type))
  )
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  if (model.participants.some((p) => p.id === value.id))
    return sequenceNoChange(model, "invalid", m.sequenceIdCollision());
  const box = value.boxId
    ? model.backgrounds.find((b) => b.id === value.boxId && b.kind === "box")
    : undefined;
  if (value.boxId && !box)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const open = box ? sequenceRecord(model, box.id)! : undefined,
    close = open?.closeKey ? sequenceRecord(model, open.closeKey) : undefined;
  const key = value.sourceKey ?? nextSequenceSourceKey();
  if (
    model.sourceDocument.records.some((r) => r.sourceKey === key) ||
    model.participants.some((p) => p.sourceKey === key)
  )
    return sequenceNoChange(model, "invalid", m.sequenceIdCollision());
  const firstTimeline = model.sourceDocument.records.find(
    (r) => r.temporal && !r.parentId,
  );
  return writeSequencePatches(
    model,
    [
      sequenceNewRecordPatch(
        model,
        close?.range.start ??
          firstTimeline?.range.start ??
          model.sourceDocument.source.length,
        `${open ? open.indent + "  " : "  "}${sequenceParticipantDeclaration(value)}`,
        key,
      ),
    ],
    {
      ...options,
      participantKeys: new Map([[value.id, key]]),
      selection: key,
      focus: key,
    },
  );
}
/** ID edits patch typed references; alias and shape edits own only declarations.
 * Config CST patches preserve all opaque neighboring metadata. */
export function editSequenceParticipant(
  model: MermaidSequenceModel,
  key: string,
  changes: { id?: string; label?: string; type?: SequenceParticipantType },
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const p = sequenceParticipant(model, key);
  if (!p) return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (
    changes.type !== undefined &&
    changes.type !== p.type &&
    changes.label !== undefined &&
    changes.label !== p.label
  ) {
    const first = editSequenceParticipant(
      model,
      key,
      { id: changes.id, label: changes.label },
      options,
    );
    if (first.status === "rejected") return first;
    return composeSequenceCommandResults(
      model,
      editSequenceParticipant(
        first.model,
        p.sourceKey,
        { type: changes.type },
        { ...options, baseSource: undefined },
      ),
      options,
    );
  }
  const id = changes.id ?? p.id,
    patches: SequencePatch[] = [];
  if (
    (id !== p.id && !validSequenceParticipantId(id)) ||
    model.participants.some((n) => n !== p && n.id === id)
  )
    return sequenceNoChange(model, "invalid", m.sequenceIdCollision());
  if (changes.type && !SEQUENCE_PARTICIPANT_TYPES.includes(changes.type))
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  if (id !== p.id)
    for (const record of model.sourceDocument.records)
      for (const ref of record.references)
        if (ref.id === p.id) patches.push({ range: ref.range, value: id });
  const declarations = p.declarationKeys.flatMap((k) => {
    const r = sequenceRecord(model, k);
    return r ? [r] : [];
  });
  if (
    !declarations.length &&
    (changes.label !== undefined || changes.type !== undefined)
  ) {
    patches.push(
      sequenceNewRecordPatch(
        model,
        model.sourceDocument.records.find((r) => r.temporal && !r.parentId)
          ?.range.start ?? model.sourceDocument.source.length,
        `  ${sequenceParticipantDeclaration({ id, label: changes.label || p.label, type: changes.type ?? p.type })}`,
        nextSequenceSourceKey(),
      ),
    );
  }
  for (const record of declarations) {
    const config = record.values.config;
    const raw = config
      ? model.sourceDocument.source.slice(config.start, config.end)
      : "";
    const bodyStart = raw.indexOf("{") + 1,
      body = raw.slice(bodyStart, raw.lastIndexOf("}"));
    const yaml = config
      ? readSourceYaml(
          /[\r\n]/.test(body) ? body : raw.slice(bodyStart - 1),
          config.start + (/[\r\n]/.test(body) ? bodyStart : bodyStart - 1),
        )
      : null;
    if (changes.type !== undefined && changes.type !== p.type) {
      if (yaml) {
        const updates = sourceYamlFieldPatch(yaml, ["type"], changes.type);
        if (!updates)
          return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
        patches.push(...updates);
      } else {
        const at = record.values.id!.end;
        patches.push({
          range: { start: at, end: at },
          value: `@{type: ${changes.type}}`,
        });
      }
    }
    if (changes.label !== undefined && changes.label !== p.label) {
      if (record.values.label)
        patches.push({
          range: record.values.label,
          value: sequenceTextValue(changes.label || id),
        });
      else if (yaml && Object.hasOwn(yaml.values, "alias")) {
        const updates = sourceYamlFieldPatch(yaml, ["alias"], changes.label);
        if (!updates)
          return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
        patches.push(...updates);
      } else {
        const at = config?.end ?? record.values.id!.end;
        patches.push({
          range: { start: at, end: at },
          value: ` as ${sequenceTextValue(changes.label || id)}`,
        });
      }
    }
  }
  return writeSequencePatches(model, patches, {
    ...options,
    participantKeys: new Map([[id, p.sourceKey]]),
    selection: p.sourceKey,
    focus: p.sourceKey,
  });
}
export function moveSequenceParticipant(
  model: MermaidSequenceModel,
  key: string,
  value: { boxId?: string | null; beforeId?: string },
  options: SequenceWriteOptions = {},
) {
  const p = sequenceParticipant(model, key),
    target = value.beforeId
      ? sequenceParticipant(model, value.beforeId)
      : undefined;
  if (!p || (value.beforeId && !target))
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (p.createdBy)
    return sequenceNoChange(model, "invalid", m.sequenceLifecycle());
  const boxId = value.boxId !== undefined ? value.boxId : p.boxId;
  const box = boxId
    ? model.backgrounds.find((b) => b.id === boxId && b.kind === "box")
    : undefined;
  if (boxId && !box)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (target && target.boxId !== boxId)
    return sequenceNoChange(model, "invalid", m.sequenceScopeConflict());
  let prepared = sequenceNoChange(model);
  // Explicitly materialize implicit root declarations in their current Source
  // order before moving one. References alone otherwise register the actor
  // earlier than its moved declaration and silently defeat the gesture.
  for (const implicit of model.participants.filter(
    (p) => !p.createdBy && !p.declarationKeys.length,
  )) {
    prepared = editSequenceParticipant(
      prepared.model,
      implicit.sourceKey,
      { label: implicit.label },
      { ...options, baseSource: undefined },
    );
    if (prepared.status === "rejected")
      return sequenceNoChange(model, "invalid", prepared.diagnostic);
  }
  if (prepared.status === "rejected") return prepared;
  const base = prepared.model,
    current = sequenceParticipant(base, p.sourceKey)!;
  const declarations = current.declarationKeys;
  const close = box
    ? sequenceRecord(base, sequenceRecord(base, box.id)!.closeKey!)
    : undefined;
  const firstTemporal = base.sourceDocument.records.find((r) => r.temporal);
  const currentTarget = target
    ? sequenceParticipant(base, target.sourceKey)
    : undefined;
  const offset = currentTarget?.declarationKeys[0]
    ? sequenceRecord(base, currentTarget.declarationKeys[0])!.range.start
    : (close?.range.start ??
      firstTemporal?.range.start ??
      base.sourceDocument.source.length);
  const groups = declarations.map((declaration) =>
    sequenceRecordGroup(base, declaration)!,
  );
  const result = writeSequencePatches(
    base,
    sequenceMoveRecordGroups(base, groups, offset),
    {
      ...options,
      baseSource: undefined,
      selection: p.sourceKey,
      focus: p.sourceKey,
      impact: sequenceImpact(
        base,
        groups.flatMap((g) => g.records),
      ),
    },
  );
  return composeSequenceCommandResults(model, result, options);
}
export function sequenceParticipantDeleteImpact(
  model: MermaidSequenceModel,
  key: string,
) {
  const p = sequenceParticipant(model, key);
  if (!p) return { records: [] };
  const records = model.sourceDocument.records.filter((r) =>
    r.references.some((ref) => ref.id === p.id),
  );
  const keys = new Set(records.map((r) => r.sourceKey));
  for (const c of model.commentRecords)
    if (c.anchorId === p.sourceKey || (c.anchorId && keys.has(c.anchorId))) {
      const r = sequenceRecord(model, c.id);
      if (r) records.push(r);
    }
  return sequenceImpact(model, records);
}
export function deleteSequenceParticipant(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const impact = sequenceParticipantDeleteImpact(model, key);
  return deleteSequenceRecords(
    model,
    impact.records.flatMap((item) => {
      const r = sequenceRecord(model, item.id);
      return r ? [r] : [];
    }),
    { ...options, impact },
  );
}
export function setSequenceLifecycle(
  model: MermaidSequenceModel,
  key: string,
  value: { kind: "create" | "destroy"; messageId?: string },
  options: SequenceWriteOptions = {},
) {
  const p = sequenceParticipant(model, key),
    message = value.messageId
      ? model.messages.find((m) => m.id === value.messageId)
      : undefined;
  if (!p || (value.messageId && !message))
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (
    message &&
    (value.kind === "create"
      ? message.to !== p.id
      : ![message.from, message.to].includes(p.id))
  )
    return sequenceNoChange(model, "invalid", m.sequenceLifecycle());
  const existing = model.activations.find(
    (a) => a.participantId === p.id && a.kind === value.kind,
  );
  if (!message) {
    if (!existing) return sequenceNoChange(model);
    const record = sequenceRecord(model, existing.id)!;
    if (value.kind === "create") {
      const start =
        record.range.start + record.raw.toLowerCase().indexOf("create");
      return writeSequencePatches(
        model,
        [{ range: { start, end: start + "create".length }, value: "" }],
        { ...options, selection: p.sourceKey },
      );
    }
    const group = sequenceRecordGroup(model, record.sourceKey)!;
    return deleteSequenceRecords(model, group.records, {
      ...options,
      selection: p.sourceKey,
    });
  }
  if (existing?.messageId === message.id) return sequenceNoChange(model);
  const target = sequenceRecord(model, message.id)!;
  const declarations =
    value.kind === "create"
      ? p.declarationKeys.flatMap((k) => sequenceRecord(model, k) ?? [])
      : [];
  const metadata =
    value.kind === "create"
      ? model.sourceDocument.records.filter(
          (r) =>
            r.ownerId === p.id &&
            ["link", "properties", "details"].includes(r.kind) &&
            r.range.start < target.range.start,
        )
      : [];
  const owners = [
    existing ? sequenceRecord(model, existing.id)! : undefined,
    ...declarations,
    ...metadata,
  ].filter((r): r is NonNullable<typeof r> => Boolean(r));
  const groups = owners.map((r) => sequenceRecordGroup(model, r.sourceKey)!);
  const records = [...new Set(groups.flatMap((g) => g.records))].sort(
    (a, b) => a.range.start - b.range.start,
  );
  const life =
    value.kind === "create"
      ? declarations[0]
      : existing
        ? sequenceRecord(model, existing.id)
        : undefined;
  const lifeKey = life?.sourceKey ?? nextSequenceSourceKey();
  let text = life
    ? life.raw.replace(/^(\s*)create\s+/i, "$1")
    : target.indent +
      (value.kind === "create"
        ? sequenceParticipantDeclaration(p)
        : `destroy ${p.id}`);
  if (value.kind === "create") text = text.replace(/^(\s*)/, "$1create ");
  text += model.sourceDocument.newline;
  const identities: Array<readonly [number, string]> = [[0, lifeKey]];
  for (const record of records) {
    if (
      record.kind === "participant" ||
      record.kind === "create" ||
      record.sourceKey === existing?.id
    )
      continue;
    identities.push([text.length, record.sourceKey]);
    text += record.raw + (record.eol || model.sourceDocument.newline);
  }
  const patches: SequencePatch[] = [];
  for (const record of records) {
    const previous = patches.at(-1),
      end = sequenceRecordEnd(record);
    if (previous && previous.range.end >= record.range.start)
      previous.range.end = Math.max(previous.range.end, end);
    else patches.push({ range: { start: record.range.start, end }, value: "" });
  }
  const insertion = sequenceNewRecordPatch(
      model,
      target.range.start,
      text,
      lifeKey,
    ),
    prefix = insertion.identities![0]![0];
  insertion.value = insertion.value.slice(0, prefix) + text;
  insertion.identities = identities.map(
    ([offset, key]) => [offset + prefix, key] as const,
  );
  patches.push(insertion);
  const retained = new Set(identities.map(([, key]) => key));
  return writeSequencePatches(model, patches, {
    ...options,
    removed: new Set(
      records.filter((r) => !retained.has(r.sourceKey)).map((r) => r.sourceKey),
    ),
    participantKeys: new Map([[p.id, p.sourceKey]]),
    selection: p.sourceKey,
    focus: p.sourceKey,
    impact: sequenceImpact(model, [...records, target]),
  });
}
