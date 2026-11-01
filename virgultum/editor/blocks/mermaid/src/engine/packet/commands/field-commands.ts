// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../../i18n.js";
import type { MermaidPacketModel } from "../model.js";
import {
  nextPacketSourceKey,
  packetFieldRecordGroup,
} from "../source-document.js";
import { planPacketFieldRange } from "./boundary-commands.js";
import {
  packetNewFieldPatch,
  packetFieldNumberPatches,
  type PacketPatch,
  packetFieldGroupReplacement,
  packetNoChange,
  packetQuotedLabel,
  writePacketPatches,
  type PacketWriteOptions,
} from "../writer.js";
export function renamePacketField(
  model: MermaidPacketModel,
  fieldKey: string,
  label: string,
  options: PacketWriteOptions = {},
) {
  const field = model.fields.find((f) => f.id === fieldKey);
  if (!field?.labelRange)
    return packetNoChange(model, "invalid", messages.packetMissingField());
  if (label === field.label) return packetNoChange(model);
  return writePacketPatches(
    model,
    [{ range: field.labelRange, value: packetQuotedLabel(label, field.quote) }],
    { ...options, selection: fieldKey, focus: fieldKey },
  );
}

export type PacketFieldEdit = {
  label?: string;
  startBit?: number;
  endBit?: number;
  sourceForm?: MermaidPacketModel["fields"][number]["sourceForm"];
};
export function editPacketField(
  model: MermaidPacketModel,
  fieldKey: string,
  edit: PacketFieldEdit,
  options: PacketWriteOptions = {},
) {
  const field = model.fields.find((f) => f.id === fieldKey);
  if (!field?.labelRange)
    return packetNoChange(model, "invalid", messages.packetMissingField());
  const plan = planPacketFieldRange(
    model,
    fieldKey,
    edit.startBit ?? field.startBit,
    edit.endBit ?? field.endBit,
    edit.sourceForm,
  );
  if (!plan.patches) return packetNoChange(model, "invalid", plan.diagnostic);
  const patches = [...plan.patches];
  if (edit.label !== undefined && edit.label !== field.label)
    patches.push({
      range: field.labelRange,
      value: packetQuotedLabel(edit.label, field.quote),
    });
  return writePacketPatches(model, patches, {
    ...options,
    selection: fieldKey,
    focus: fieldKey,
  });
}

export function reorderField(
  model: MermaidPacketModel,
  fieldKey: string,
  targetIndex: number,
  options: PacketWriteOptions = {},
) {
  const index = model.fields.findIndex((f) => f.id === fieldKey);
  if (
    index < 0 ||
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= model.fields.length
  )
    return packetNoChange(model, "invalid", messages.packetReorderTarget());
  if (index === targetIndex) return packetNoChange(model);
  const fields = [...model.fields],
    [moved] = fields.splice(index, 1);
  fields.splice(targetIndex, 0, moved!);
  const patches = [];
  let startBit = 0;
  for (let slot = 0; slot < fields.length; slot++) {
    const incoming = fields[slot]!,
      outgoing = model.fields[slot]!;
    if (incoming.id !== outgoing.id || incoming.startBit !== startBit) {
      const group = packetFieldRecordGroup(model, outgoing.id);
      const patch =
        group &&
        packetFieldGroupReplacement(
          model,
          incoming.id,
          startBit,
          startBit + incoming.width - 1,
          group.range,
        );
      if (!patch)
        return packetNoChange(model, "invalid", messages.packetMoveTrivia());
      patches.push(patch);
    }
    startBit += incoming.width;
  }
  return writePacketPatches(model, patches, {
    ...options,
    selection: fieldKey,
    focus: fieldKey,
  });
}

export type PacketFieldAdd = {
  label: string;
  width: number;
  position: "before" | "after" | "append";
  anchorKey?: string;
  sourceForm: "range" | "count";
  /** Optional ephemeral draft identity, shared by preview and confirmation. */
  fieldKey?: string;
};
export function addPacketField(
  model: MermaidPacketModel,
  draft: PacketFieldAdd,
  options: PacketWriteOptions = {},
) {
  if (
    !draft.label.trim() ||
    !Number.isSafeInteger(draft.width) ||
    draft.width <= 0 ||
    !Number.isSafeInteger(model.totalWidth + draft.width)
  )
    return packetNoChange(model, "invalid", messages.packetFieldRequired());
  const anchor = model.fields.findIndex(
    (field) => field.id === draft.anchorKey,
  );
  if (draft.position !== "append" && anchor < 0)
    return packetNoChange(
      model,
      "invalid",
      messages.packetMissingInsertionAnchor(),
    );
  const index =
    draft.position === "append"
      ? model.fields.length
      : anchor + (draft.position === "after" ? 1 : 0);
  const startBit = model.fields[index]?.startBit ?? model.totalWidth;
  const fieldKey = draft.fieldKey ?? nextPacketSourceKey();
  if (model.sourceDocument.records.some((r) => r.sourceKey === fieldKey))
    return packetNoChange(model, "invalid", messages.packetDraftIdentity());
  const target = model.fields[index],
    previous = model.fields[index - 1];
  const group = target
    ? packetFieldRecordGroup(model, target.id)
    : previous
      ? packetFieldRecordGroup(model, previous.id)
      : undefined;
  if ((target || previous) && !group)
    return packetNoChange(model, "invalid", messages.packetInsertTrivia());
  const offset = target
    ? group!.range.start
    : previous
      ? group!.range.end
      : model.sourceDocument.source.length;
  const patches: PacketPatch[] = [
    packetNewFieldPatch(model, offset, {
      startBit,
      endBit: startBit + draft.width - 1,
      label: draft.label,
      sourceForm: draft.sourceForm,
      fieldKey,
      indent: target?.indent ?? previous?.indent ?? "  ",
    }),
  ];
  for (const field of model.fields.slice(index)) {
    const change = packetFieldNumberPatches(
      field,
      field.startBit + draft.width,
      field.endBit + draft.width,
    );
    if (!change)
      return packetNoChange(
        model,
        "invalid",
        messages.packetMissingFieldRanges(),
      );
    patches.push(...change);
  }
  return writePacketPatches(model, patches, {
    ...options,
    selection: fieldKey,
    focus: fieldKey,
  });
}

export function splitPacketField(
  model: MermaidPacketModel,
  fieldKey: string,
  boundary: number,
  label: string,
  sourceForm: "range" | "count",
  options: PacketWriteOptions = {},
  secondKey = nextPacketSourceKey(),
) {
  const group = packetFieldRecordGroup(model, fieldKey),
    field = group?.field;
  if (
    !field ||
    !Number.isSafeInteger(boundary) ||
    boundary <= field.startBit ||
    boundary > field.endBit ||
    !label.trim() ||
    model.sourceDocument.records.some((r) => r.sourceKey === secondKey)
  )
    return packetNoChange(model, "invalid", messages.packetSplitRequired());
  const numbers = packetFieldNumberPatches(field, field.startBit, boundary - 1);
  if (!numbers)
    return packetNoChange(
      model,
      "invalid",
      messages.packetMissingFieldRanges(),
    );
  const insert = packetNewFieldPatch(model, group!.range.end, {
    startBit: boundary,
    endBit: field.endBit,
    label,
    sourceForm,
    fieldKey: secondKey,
    indent: field.indent ?? "  ",
  });
  return writePacketPatches(model, [...numbers, insert], {
    ...options,
    selection: secondKey,
    focus: secondKey,
  });
}
export function mergePacketFields(
  model: MermaidPacketModel,
  fieldKey: string,
  neighborKey: string,
  label: string,
  sourceForm: "range" | "count",
  options: PacketWriteOptions = {},
) {
  const index = model.fields.findIndex((f) => f.id === fieldKey),
    neighbor = model.fields.findIndex((f) => f.id === neighborKey);
  if (
    index < 0 ||
    neighbor < 0 ||
    Math.abs(index - neighbor) !== 1 ||
    !label.trim()
  )
    return packetNoChange(model, "invalid", messages.packetMergeRequired());
  const left = model.fields[Math.min(index, neighbor)]!,
    right = model.fields[Math.max(index, neighbor)]!;
  const leftGroup = packetFieldRecordGroup(model, left.id),
    rightGroup = packetFieldRecordGroup(model, right.id);
  if (!leftGroup || !rightGroup)
    return packetNoChange(model, "invalid", messages.packetMergeTrivia());
  const replacement = packetFieldGroupReplacement(
    model,
    left.id,
    left.startBit,
    right.endBit,
    leftGroup.range,
    { label, sourceForm, fieldKey },
  );
  if (!replacement)
    return packetNoChange(model, "invalid", messages.packetMergeRecord());
  const identities: [number, string][] = [];
  let comments = "";
  for (const record of rightGroup.records) {
    if (record.sourceKey === right.id) continue;
    identities.push([comments.length, record.sourceKey]);
    comments +=
      (left.indent ?? "  ") +
      record.raw.trimStart() +
      (record.eol || model.sourceDocument.newline);
  }
  if (comments && rightGroup.range.end < model.sourceDocument.source.length)
    comments += model.sourceDocument.newline;
  if (
    rightGroup.range.end === model.sourceDocument.source.length &&
    !/[\r\n]$/.test(model.sourceDocument.source)
  )
    comments = comments.replace(/(?:\r\n|\r|\n)$/, "");
  const transfers = new Map(
    (model.comments ?? [])
      .filter((c) => c.anchorId === left.id || c.anchorId === right.id)
      .map((c) => [c.id, fieldKey]),
  );
  return writePacketPatches(
    model,
    [replacement, { range: rightGroup.range, value: comments, identities }],
    {
      ...options,
      removed: new Set([neighborKey]),
      commentTransfers: transfers,
      selection: fieldKey,
      focus: fieldKey,
    },
  );
}

/** Delete only the chosen field and its object comments. Positional trivia stays
 * at its Source location; following explicit ranges collapse by the lost width. */
export function deletePacketField(
  model: MermaidPacketModel,
  fieldKey: string,
  options: PacketWriteOptions = {},
) {
  const index = model.fields.findIndex((f) => f.id === fieldKey);
  const field = model.fields[index];
  if (!field)
    return packetNoChange(model, "invalid", messages.packetMissingField());
  const removed = new Set([
    fieldKey,
    ...(model.comments ?? [])
      .filter(
        (c) =>
          c.anchorKind === "field" &&
          c.anchorId === fieldKey &&
          c.affinity === "object",
      )
      .map((c) => c.id),
  ]);
  const records = model.sourceDocument.records;
  const patches: PacketPatch[] = records
    .filter((r) => removed.has(r.sourceKey))
    .map((r) => {
      const previous = records[records.indexOf(r) - 1];
      return {
        range: { start: r.range.start, end: r.range.end + r.eol.length },
        value:
          r.sourceKey === fieldKey &&
          previous?.kind === "header" &&
          !previous.eol
            ? model.sourceDocument.newline
            : "",
      };
    });
  for (const next of model.fields.slice(index + 1)) {
    const change = packetFieldNumberPatches(
      next,
      next.startBit - field.width,
      next.endBit - field.width,
    );
    if (!change)
      return packetNoChange(
        model,
        "invalid",
        messages.packetMissingFieldRanges(),
      );
    patches.push(...change);
  }
  const focus =
    model.fields[index + 1]?.id ?? model.fields[index - 1]?.id ?? "add";
  return writePacketPatches(model, patches, {
    ...options,
    removed,
    selection: focus === "add" ? undefined : focus,
    focus,
  });
}
