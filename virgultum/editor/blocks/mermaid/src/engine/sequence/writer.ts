// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidSequenceBackground,
  MermaidSequenceMessageArrow,
  MermaidSequenceModel,
  MermaidSequenceParticipant,
} from "./model.js";

function messageArrowToken(arrow: MermaidSequenceMessageArrow) {
  return arrow;
}
function sequenceBackgroundLine(background: MermaidSequenceBackground) {
  if (background.kind === "rect") {
    return `rect ${background.color}`;
  }
  const value = [background.color, background.label].filter(Boolean).join(" ");
  return `box${value ? ` ${value}` : ""}`;
}

function quoteIfNeeded(value: string) {
  return /^[A-Za-z_][\w -]*$/.test(value)
    ? value
    : `"${value.replace(/"/g, '\\"')}"`;
}
export function generateMermaidSequenceSource(model: MermaidSequenceModel) {
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    model.headerLine || "sequenceDiagram",
  ];
  if (model.diagramTitle) lines.push(`  title: ${model.diagramTitle}`);
  if (model.accessibilityTitle) {
    lines.push(`  accTitle: ${model.accessibilityTitle}`);
  }
  if (model.accessibilityDescription) {
    if (model.accessibilityDescription.includes("\n")) {
      lines.push("  accDescr {");
      lines.push(
        ...model.accessibilityDescription
          .split("\n")
          .map((line) => `    ${line}`),
      );
      lines.push("  }");
    } else {
      lines.push(`  accDescr: ${model.accessibilityDescription}`);
    }
  }
  if (model.autonumberLine) lines.push(`  ${model.autonumberLine}`);
  const participants = [...model.participants].sort(
    (a, b) => a.order - b.order,
  );
  const participantLine = (participant: MermaidSequenceParticipant) => {
    const label =
      participant.label && participant.label !== participant.id
        ? ` as ${quoteIfNeeded(participant.label)}`
        : "";
    return `  ${participant.kind} ${participant.id}${participant.config}${label}`;
  };
  const createdParticipantIds = new Set(
    model.activations
      .filter((activation) => activation.kind === "create")
      .map((activation) => activation.participantId),
  );
  const boxedParticipantIds = new Set<string>();
  const participantLinkLines = (participant: MermaidSequenceParticipant) =>
    participant.links.map(
      (link) => `  link ${participant.id}: ${link.label} @ ${link.url}`,
    );
  const participantMetadataLines = (
    participant: MermaidSequenceParticipant,
  ) => [
    ...(Object.keys(participant.properties).length
      ? [
          `  properties ${participant.id}: ${JSON.stringify(participant.properties)}`,
        ]
      : []),
    ...(participant.detailsId
      ? [`  details ${participant.id}: ${participant.detailsId}`]
      : []),
  ];
  for (const box of [...model.backgrounds]
    .filter((background) => background.kind === "box")
    .sort((a, b) => a.order - b.order)) {
    lines.push(`  ${sequenceBackgroundLine(box)}`);
    for (const participantId of box.participantIds) {
      const participant = participants.find(
        (candidate) => candidate.id === participantId,
      );
      if (!participant) continue;
      boxedParticipantIds.add(participant.id);
      lines.push(`    ${participantLine(participant).trimStart()}`);
    }
    lines.push("  end");
  }
  for (const participant of participants) {
    if (
      !boxedParticipantIds.has(participant.id) &&
      !createdParticipantIds.has(participant.id)
    ) {
      lines.push(participantLine(participant));
    }
  }
  for (const participant of participants) {
    if (!createdParticipantIds.has(participant.id)) {
      lines.push(...participantLinkLines(participant));
      lines.push(...participantMetadataLines(participant));
    }
  }
  const statements = [
    ...model.backgrounds
      .filter((background) => background.kind === "rect")
      .flatMap((background) => [
        {
          background,
          kind: "background-start" as const,
          order: background.startOrder,
        },
        {
          background,
          kind: "background-end" as const,
          order: background.endOrder,
        },
      ]),
    ...model.controls.flatMap((control) => [
      {
        control,
        kind: "control-start" as const,
        order: control.startOrder,
      },
      ...control.branches
        .filter((branch) => branch.kind !== "primary")
        .map((branch) => ({
          branch,
          control,
          kind: "control-branch" as const,
          order: branch.startOrder,
        })),
      {
        control,
        kind: "control-end" as const,
        order: control.endOrder,
      },
    ]),
    ...model.messages.map((message) => ({
      kind: "message" as const,
      order: message.order,
      value: message,
    })),
    ...model.notes.map((note) => ({
      kind: "note" as const,
      order: note.order,
      value: note,
    })),
    ...model.activations
      .filter((activation) => !activation.embedded)
      .map((activation) => ({
        kind: "activation" as const,
        order: activation.order,
        value: activation,
      })),
  ].sort((a, b) => {
    const priority = {
      "control-start": 0,
      "background-start": 0,
      "control-branch": 1,
      message: 2,
      note: 2,
      activation: 2,
      "control-end": 3,
      "background-end": 4,
    }[a.kind];
    const otherPriority = {
      "control-start": 0,
      "background-start": 0,
      "control-branch": 1,
      message: 2,
      note: 2,
      activation: 2,
      "control-end": 3,
      "background-end": 4,
    }[b.kind];
    return a.order - b.order || priority - otherPriority;
  });

  const activeStructures: Array<{
    id: string;
    kind: "background" | "control";
  }> = [];
  const linePrefix = (depth: number) => "  ".repeat(Math.max(1, depth + 1));

  for (const statement of statements) {
    if (statement.kind === "background-start") {
      lines.push(
        `${linePrefix(activeStructures.length)}${sequenceBackgroundLine(statement.background)}`,
      );
      activeStructures.push({
        id: statement.background.id,
        kind: "background",
      });
      continue;
    }
    if (statement.kind === "control-start") {
      const { control } = statement;
      lines.push(
        `${linePrefix(activeStructures.length)}${control.kind}${control.label ? ` ${control.label}` : ""}`,
      );
      activeStructures.push({ id: control.id, kind: "control" });
      continue;
    }
    if (statement.kind === "control-branch") {
      const { branch, control } = statement;
      const depth = Math.max(
        0,
        activeStructures.findLastIndex((item) => item.id === control.id) >= 0
          ? activeStructures.findLastIndex((item) => item.id === control.id)
          : activeStructures.length - 1,
      );
      lines.push(
        `${linePrefix(depth)}${branch.kind}${branch.label ? ` ${branch.label}` : ""}`,
      );
      continue;
    }
    if (statement.kind === "control-end") {
      const controlIndex = activeStructures.findLastIndex(
        (item) => item.id === statement.control.id,
      );
      const depth =
        controlIndex >= 0
          ? controlIndex
          : Math.max(0, activeStructures.length - 1);
      if (controlIndex >= 0) activeStructures.splice(controlIndex);
      lines.push(`${linePrefix(depth)}end`);
      continue;
    }
    if (statement.kind === "background-end") {
      const backgroundIndex = activeStructures.findLastIndex(
        (item) => item.id === statement.background.id,
      );
      const depth =
        backgroundIndex >= 0
          ? backgroundIndex
          : Math.max(0, activeStructures.length - 1);
      if (backgroundIndex >= 0) activeStructures.splice(backgroundIndex);
      lines.push(`${linePrefix(depth)}end`);
      continue;
    }
    if (statement.kind === "message") {
      const message = statement.value;
      lines.push(
        `${linePrefix(activeStructures.length)}${message.from}${message.centralFrom ? "()" : ""}${messageArrowToken(message.arrow)}${message.activation ?? ""}${message.centralTo ? "()" : ""}${message.to}: ${message.label}`,
      );
      continue;
    }
    if (statement.kind === "note") {
      const note = statement.value;
      lines.push(
        `${linePrefix(activeStructures.length)}Note ${note.placement} ${note.participantIds.join(",")}: ${note.label}`,
      );
      continue;
    }
    const activation = statement.value;
    if (activation.kind === "create") {
      const participant = participants.find(
        (candidate) => candidate.id === activation.participantId,
      );
      if (participant) {
        lines.push(
          `${linePrefix(activeStructures.length)}create ${participantLine(participant).trimStart()}`,
        );
        lines.push(
          ...participantLinkLines(participant).map(
            (linkLine) =>
              `${linePrefix(activeStructures.length)}${linkLine.trimStart()}`,
          ),
        );
        lines.push(
          ...participantMetadataLines(participant).map(
            (metadataLine) =>
              `${linePrefix(activeStructures.length)}${metadataLine.trimStart()}`,
          ),
        );
      }
      continue;
    }
    lines.push(
      `${linePrefix(activeStructures.length)}${activation.kind} ${activation.participantId}`,
    );
  }
  lines.push(...model.passthroughLines.filter((line) => line.trim()));
  return `${lines.join("\n")}\n`;
}

import { mermaidMessages as messages } from "../../i18n.js";
import { resolveMermaidSequenceSource } from "./parser.js";
import { sequenceSourceDiagnostic } from "./diagnostics.js";
import type { SequenceSourceRecord } from "./source-document.js";
import type { SourceValuePatch } from "../source-yaml.js";

export type SequencePatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type SequenceImpact = {
  records: readonly { id: string; kind: string; label: string }[];
};
export type SequenceCommandResult = {
  status: "changed" | "rejected" | "no-op";
  changed: boolean;
  source: string;
  model: MermaidSequenceModel;
  patches: readonly SequencePatch[];
  reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly" | "cancelled";
  diagnostic?: string;
  selection?: string;
  focus?: string;
  remap: ReadonlyMap<string, string>;
  impact: SequenceImpact;
};
export type SequenceWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  participantKeys?: ReadonlyMap<string, string>;
  primaryBranchKeys?: ReadonlyMap<string, string>;
  commentAnchors?: ReadonlyMap<
    string,
    Pick<
      import("./model.js").SequenceComment,
      "anchorKind" | "anchorId" | "position"
    >
  >;
  commentTransfers?: ReadonlySet<string>;
  selection?: string;
  focus?: string;
  impact?: SequenceImpact;
};
export function sequenceNoChange(
  model: MermaidSequenceModel,
  reason: SequenceCommandResult["reason"] = "no-change",
  diagnostic?: string,
): SequenceCommandResult {
  return {
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    changed: false,
    source: model.sourceDocument.source,
    model,
    patches: [],
    reason,
    diagnostic,
    remap: new Map(),
    impact: { records: [] },
  };
}
/** Exact basis validation and candidate reparse precede the sole host transaction.
 * Reserved record starts carry identity across equal signatures and moved units. */
export function writeSequencePatches(
  model: MermaidSequenceModel,
  patches: readonly SequencePatch[],
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return sequenceNoChange(model, "cancelled");
  if (options.readonly) return sequenceNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return sequenceNoChange(
      model,
      "conflict",
      messages.sequenceSourceConflict(),
    );
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>(),
    reserved = new Set<string>();
  let next = "",
    cursor = 0;
  for (const patch of sorted) {
    if (
      !Number.isSafeInteger(patch.range.start) ||
      !Number.isSafeInteger(patch.range.end) ||
      patch.range.start < cursor ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length
    )
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(id))
        return sequenceNoChange(
          model,
          "invalid",
          messages.sequencePatchRejected(),
        );
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return sequenceNoChange(model);
  for (const record of model.sourceDocument.records) {
    if (
      reserved.has(record.sourceKey) ||
      options.removed?.has(record.sourceKey)
    )
      continue;
    let offset = record.range.start,
      removed = false;
    for (const patch of sorted) {
      if (patch.range.start > record.range.start) break;
      if (
        patch.range.end > patch.range.start &&
        record.range.start >= patch.range.start &&
        record.range.start < patch.range.end
      ) {
        if (
          patch.range.start === record.range.start &&
          patch.value &&
          patch.range.end <= record.range.end
        )
          break;
        removed = true;
        break;
      }
      offset += patch.value.length - (patch.range.end - patch.range.start);
    }
    if (!removed) mapping.set(offset, record.sourceKey);
  }
  const resolution = resolveMermaidSequenceSource(
    next,
    options.commentTransfers?.size
      ? {
          ...model,
          commentRecords: model.commentRecords.filter(
            (c) => !options.commentTransfers!.has(c.id),
          ),
        }
      : model,
    mapping,
    options.participantKeys,
    options.primaryBranchKeys,
    options.commentAnchors,
  );
  if (!resolution.model)
    return sequenceNoChange(
      model,
      "invalid",
      resolution.diagnostics[0]
        ? sequenceSourceDiagnostic(resolution.diagnostics[0])
        : messages.sequencePatchRejected(),
    );
  const keys = new Set(resolution.document.records.map((r) => r.sourceKey));
  for (const record of model.sourceDocument.records)
    if (!options.removed?.has(record.sourceKey) && !keys.has(record.sourceKey))
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
  for (const comment of model.commentRecords) {
    if (
      options.removed?.has(comment.id) ||
      options.commentTransfers?.has(comment.id)
    )
      continue;
    const retained = resolution.model.commentRecords.find(
      (c) => c.id === comment.id,
    );
    if (
      !retained ||
      retained.anchorKind !== comment.anchorKind ||
      retained.anchorId !== comment.anchorId ||
      retained.position !== comment.position
    )
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
  }
  const remap = new Map<string, string>();
  for (const key of keys) remap.set(key, key);
  for (const branch of resolution.model.controls.flatMap((c) => c.branches))
    remap.set(branch.id, branch.id);
  for (const node of model.participants) {
    const retained = resolution.model.participants.find(
      (n) => n.sourceKey === node.sourceKey,
    );
    if (retained) remap.set(node.sourceKey, retained.sourceKey);
  }
  return {
    status: "changed",
    changed: true,
    source: next,
    model: resolution.model,
    patches: sorted,
    reason: "applied",
    selection: options.selection,
    focus: options.focus,
    remap,
    impact: options.impact ?? { records: [] },
  };
}
export function sequenceRecord(model: MermaidSequenceModel, key: string) {
  return model.sourceDocument.records.find((r) => r.sourceKey === key);
}
export function sequenceRecordEnd(record: SequenceSourceRecord) {
  return record.range.end + record.eol.length;
}
export function sequenceRecordGroup(model: MermaidSequenceModel, key: string) {
  const record = sequenceRecord(model, key);
  if (!record) return null;
  const aliases = new Set([
    key,
    record.primaryBranchKey,
    ...model.activations
      .filter((a) => a.embedded && a.messageId === key)
      .map((a) => a.id),
  ]);
  const comments = model.commentRecords.filter(
    (c) => c.anchorId && aliases.has(c.anchorId),
  );
  const records = [
    record,
    ...comments.flatMap((c) => {
      const r = sequenceRecord(model, c.id);
      return r ? [r] : [];
    }),
  ].sort((a, b) => a.range.start - b.range.start);
  const start = records[0]!.range.start,
    end = sequenceRecordEnd(records.at(-1)!);
  return {
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.start < end,
    ),
    range: { start, end },
  };
}
export function sequenceNewRecordPatch(
  model: MermaidSequenceModel,
  offset: number,
  text: string,
  key?: string,
): SequencePatch {
  const source = model.sourceDocument.source,
    newline = model.sourceDocument.newline;
  const previous = model.sourceDocument.records.findLast(
    (record) => sequenceRecordEnd(record) <= offset && record.kind !== "blank",
  );
  const prefix =
    (offset > 0 && !/[\r\n]/.test(source[offset - 1]!) ? newline : "") +
    (previous?.kind === "comment" &&
    !text.trimStart().startsWith("%%") &&
    !/[\r\n]{2}$/.test(source.slice(0, offset))
      ? newline
      : "");
  const suffix =
    offset < source.length || /[\r\n]$/.test(source) ? newline : "";
  return {
    range: { start: offset, end: offset },
    value: prefix + text + suffix,
    identities: key ? [[prefix.length, key]] : undefined,
  };
}
/** Move one lexical unit; only a required EOF separator may be added. */
export function sequenceMoveRecords(
  model: MermaidSequenceModel,
  records: readonly SequenceSourceRecord[],
  offset: number,
): SequencePatch[] {
  const start = records[0]!.range.start,
    end = sequenceRecordEnd(records.at(-1)!);
  if (offset >= start && offset <= end) return [];
  let value = model.sourceDocument.source.slice(start, end);
  const newline = model.sourceDocument.newline;
  const insertion = sequenceNewRecordPatch(
    model,
    offset,
    value,
    records[0]!.sourceKey,
  );
  const prefix = insertion.value.slice(0, insertion.identities![0]![0]);
  if (offset < model.sourceDocument.source.length && !/[\r\n]$/.test(value))
    value += newline;
  return [
    { range: { start, end }, value: "" },
    {
      range: { start: offset, end: offset },
      value: prefix + value,
      identities: records.map(
        (r) => [prefix.length + r.range.start - start, r.sourceKey] as const,
      ),
    },
  ];
}

/** Collapse preparatory lexical materialization and the requested operation into
 * original-basis record patches. The host still receives exactly one command. */
export function composeSequenceCommandResults(
  original: MermaidSequenceModel,
  result: SequenceCommandResult,
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  if (result.status === "rejected")
    return {
      ...result,
      source: original.sourceDocument.source,
      model: original,
      patches: [],
    };
  const old = original.sourceDocument.records,
    next = result.model.sourceDocument.records;
  const indices = new Map(
    old.map((record, index) => [record.sourceKey, index]),
  );
  const anchors: { old: SequenceSourceRecord; next: SequenceSourceRecord }[] =
    [];
  let last = -1;
  for (const record of next) {
    const index = indices.get(record.sourceKey);
    if (index === undefined || index <= last) continue;
    const previous = old[index]!;
    if (previous.raw !== record.raw || previous.eol !== record.eol) continue;
    anchors.push({ old: previous, next: record });
    last = index;
  }
  const patches: SequencePatch[] = [];
  let start = 0,
    nextStart = 0;
  const boundaries = anchors.map((anchor) => ({
    oldStart: anchor.old.range.start,
    oldEnd: sequenceRecordEnd(anchor.old),
    nextStart: anchor.next.range.start,
    nextEnd: sequenceRecordEnd(anchor.next),
  }));
  boundaries.push({
    oldStart: original.sourceDocument.source.length,
    oldEnd: original.sourceDocument.source.length,
    nextStart: result.source.length,
    nextEnd: result.source.length,
  });
  for (const anchor of boundaries) {
    const end = anchor.oldStart,
      nextEnd = anchor.nextStart;
    const value = result.source.slice(nextStart, nextEnd);
    if (original.sourceDocument.source.slice(start, end) !== value)
      patches.push({
        range: { start, end },
        value,
        identities: next
          .filter((r) => r.range.start >= nextStart && r.range.start < nextEnd)
          .map((r) => [r.range.start - nextStart, r.sourceKey] as const),
      });
    start = anchor.oldEnd;
    nextStart = anchor.nextEnd;
  }
  const retained = new Set(next.map((r) => r.sourceKey));
  return writeSequencePatches(original, patches, {
    ...options,
    removed: new Set(
      old.filter((r) => !retained.has(r.sourceKey)).map((r) => r.sourceKey),
    ),
    participantKeys: new Map(
      result.model.participants.map((n) => [n.id, n.sourceKey]),
    ),
    primaryBranchKeys: new Map(
      result.model.controls.map((c) => [c.id, c.branches[0]!.id]),
    ),
    commentAnchors: new Map(result.model.commentRecords.map((c) => [c.id, c])),
    // Only a deliberately removed owner boundary can transfer a retained comment.
    commentTransfers: new Set([
      ...(options.commentTransfers ?? []),
      ...original.commentRecords
        .filter(
          (comment) =>
            comment.anchorId &&
            !retained.has(comment.anchorId) &&
            retained.has(comment.id),
        )
        .map((comment) => comment.id),
    ]),
    selection: result.selection,
    focus: result.focus,
    impact: result.impact,
  });
}

export type SequenceTimelineAnchor = {
  key?: string;
  position?: "before" | "after";
};
export function sequenceAnchor(
  model: MermaidSequenceModel,
  anchor: SequenceTimelineAnchor = {},
) {
  const record = anchor.key ? sequenceRecord(model, anchor.key) : undefined;
  if (anchor.key && !record) return null;
  const offset = record
    ? anchor.position === "after"
      ? sequenceRecordEnd(record)
      : record.range.start
    : model.sourceDocument.source.length;
  const following = model.sourceDocument.records.find(
    (r) => r.range.start >= offset,
  );
  return {
    record,
    offset,
    indent: following?.indent ?? record?.indent ?? "  ",
    parentId: following?.parentId ?? null,
    branchId: following?.branchId ?? null,
  };
}
export function sequenceSpan(model: MermaidSequenceModel, key: string) {
  const record = sequenceRecord(model, key);
  if (!record) return null;
  const group = sequenceRecordGroup(model, key)!;
  let start = group.range.start,
    end = group.range.end;
  if (record.closeKey) {
    const close = sequenceRecord(model, record.closeKey);
    if (!close) return null;
    end = sequenceRecordEnd(close);
  }
  if (record.kind === "message") {
    const lifecycle = model.activations.filter(
      (a) =>
        a.messageId === key && (a.kind === "create" || a.kind === "destroy"),
    );
    for (const item of lifecycle)
      start = Math.min(start, sequenceRecordGroup(model, item.id)!.range.start);
  }
  const records = model.sourceDocument.records.filter(
    (r) => r.range.start >= start && r.range.start < end,
  );
  return { records, range: { start, end } };
}
export function sequenceImpact(
  model: MermaidSequenceModel,
  records: readonly SequenceSourceRecord[],
): SequenceImpact {
  return {
    records: records
      .filter((r) => !["blank", "end"].includes(r.kind))
      .map((r) => {
        const participant = model.participants.find((p) => p.id === r.ownerId),
          message = model.messages.find((m) => m.id === r.sourceKey),
          note = model.notes.find((n) => n.id === r.sourceKey),
          fragment = model.controls.find((c) => c.id === r.sourceKey),
          branch = model.controls
            .flatMap((c) => c.branches)
            .find((b) => b.id === r.sourceKey),
          background = model.backgrounds.find((b) => b.id === r.sourceKey),
          comment = model.commentRecords.find((c) => c.id === r.sourceKey);
        const label = message
          ? `${model.participants.find((p) => p.id === message.from)?.label ?? message.from} → ${model.participants.find((p) => p.id === message.to)?.label ?? message.to}: ${message.label}`
          : (note?.label ??
            fragment?.label ??
            branch?.label ??
            background?.label ??
            comment?.text ??
            participant?.label ??
            model.diagramTitle);
        return { id: r.sourceKey, kind: r.kind, label };
      }),
  };
}
/** Reorder is an explicit lexical span, never a layout-derived X/Y sort. The
 * candidate parser validates activation and lifecycle effects before a commit. */
export function reorderSequenceSpan(
  model: MermaidSequenceModel,
  key: string,
  anchor: SequenceTimelineAnchor,
  options: SequenceWriteOptions = {},
) {
  const span = sequenceSpan(model, key),
    target = sequenceAnchor(model, anchor),
    record = sequenceRecord(model, key);
  if (!span || !target || !record)
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  const at = target.record;
  if (
    record.parentId !== target.parentId ||
    record.branchId !== target.branchId
  )
    return sequenceNoChange(model, "invalid", messages.sequenceScopeConflict());
  if (record.closeKey && at?.blockKey === key && anchor.position === "after")
    return sequenceNoChange(model);
  return writeSequencePatches(
    model,
    sequenceMoveRecords(model, span.records, target.offset),
    {
      ...options,
      selection: key,
      focus: key,
      impact: sequenceImpact(model, span.records),
    },
  );
}
export function deleteSequenceRecords(
  model: MermaidSequenceModel,
  records: readonly SequenceSourceRecord[],
  options: SequenceWriteOptions = {},
) {
  const sorted = [...new Set(records)].sort(
      (a, b) => a.range.start - b.range.start,
    ),
    patches: SequencePatch[] = [];
  const selected = new Set(sorted.map((r) => r.sourceKey));
  for (const r of sorted) {
    const previous = patches.at(-1),
      end =
        r.kind === "comment" &&
        model.sourceDocument.records.some(
          (other) =>
            other.range.line === r.range.line &&
            other.range.end <= r.range.start &&
            !selected.has(other.sourceKey),
        )
          ? r.range.end
          : sequenceRecordEnd(r);
    if (previous && previous.range.end >= r.range.start)
      previous.range.end = Math.max(previous.range.end, end);
    else patches.push({ range: { start: r.range.start, end }, value: "" });
  }
  return writeSequencePatches(model, patches, {
    ...options,
    removed: new Set(sorted.map((r) => r.sourceKey)),
    impact: options.impact ?? sequenceImpact(model, sorted),
  });
}
export function sequenceTextValue(value: string) {
  return value
    .replaceAll(/\r\n|\r|\n/g, "<br/>")
    .replaceAll(/[#%;]/g, (c) => `#${c.charCodeAt(0)};`);
}

/** Move explicitly selected lexical units together. Repeated declarations must
 * leave their old box in the same candidate that enters the new one. */
export function sequenceMoveRecordGroups(
  model: MermaidSequenceModel,
  groups: readonly {
    records: readonly SequenceSourceRecord[];
    range: { start: number; end: number };
  }[],
  offset: number,
): SequencePatch[] {
  if (!groups.length) return [];
  if (groups.some((g) => offset >= g.range.start && offset <= g.range.end))
    return [];
  const sorted = [...groups].sort((a, b) => a.range.start - b.range.start),
    units: typeof sorted = [];
  for (const group of sorted) {
    const previous = units.at(-1);
    if (previous && previous.range.end >= group.range.start) {
      previous.range = {
        start: previous.range.start,
        end: Math.max(previous.range.end, group.range.end),
      };
      previous.records = model.sourceDocument.records.filter(
        (r) =>
          r.range.start >= previous.range.start &&
          r.range.start < previous.range.end,
      );
    } else units.push({ ...group });
  }
  let text = "";
  const identities: Array<readonly [number, string]> = [];
  for (const unit of units) {
    for (const r of unit.records)
      identities.push([
        text.length + r.range.start - unit.range.start,
        r.sourceKey,
      ]);
    text += model.sourceDocument.source.slice(unit.range.start, unit.range.end);
    if (
      !/[\r\n]$/.test(text) &&
      (unit !== units.at(-1) || offset < model.sourceDocument.source.length)
    )
      text += model.sourceDocument.newline;
  }
  const insert = sequenceNewRecordPatch(
      model,
      offset,
      text,
      units[0]!.records[0]!.sourceKey,
    ),
    prefix = insert.identities![0]![0];
  insert.value = insert.value.slice(0, prefix) + text;
  insert.identities = identities.map(
    ([at, key]) => [at + prefix, key] as const,
  );
  return [...units.map((unit) => ({ range: unit.range, value: "" })), insert];
}
