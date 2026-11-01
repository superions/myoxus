// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel } from "../model.js";
import {
  stateRecord,
  stateNoChange,
  stateInsertAnchor,
  stateNewRecordPatch,
  stateTextValue,
  writeStatePatches,
  deleteStateRecords,
  stateMoveRecords,
  stateRecordGroup,
  type StateInsertAnchor,
  type StateWriteOptions,
  type StatePatch,
} from "../writer.js";
import { stateObject } from "./state-commands.js";
import { nextStateSourceKey } from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
export type StateTransitionValue = {
  /** A native connector already owns this checked, newly allocated identity. */
  sourceKey?: string;
  from: string;
  to: string;
  label?: string;
  fromClass?: string;
  toClass?: string;
  anchor?: StateInsertAnchor;
};
export function stateEndpoint(
  model: MermaidStateModel,
  id: string,
  side: "from" | "to",
) {
  if (id === "[*]") return id;
  const node = stateObject(model, id);
  if (!node) return null;
  if ("kind" in node && (node.kind === "start" || node.kind === "end"))
    return node.kind === (side === "from" ? "start" : "end") ? "[*]" : null;
  return node.id;
}
export function addStateTransition(
  model: MermaidStateModel,
  value: StateTransitionValue,
  options: StateWriteOptions = {},
) {
  const from = stateEndpoint(model, value.from, "from"),
    to = stateEndpoint(model, value.to, "to"),
    at = stateInsertAnchor(model, value.anchor);
  if (
    !from ||
    !to ||
    !at ||
    [value.fromClass, value.toClass].some(
      (v) => Boolean(v) && !/^\w+$/.test(v!),
    )
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const key = value.sourceKey ?? nextStateSourceKey();
  if (model.sourceDocument.records.some((r) => r.sourceKey === key))
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const text = `${from}${value.fromClass ? `:::${value.fromClass}` : ""} --> ${to}${value.toClass ? `:::${value.toClass}` : ""}${value.label ? `: ${stateTextValue(value.label)}` : ""}`;
  return writeStatePatches(
    model,
    [stateNewRecordPatch(model, at.offset, at.indent + text, key)],
    { ...options, selection: key, focus: key },
  );
}
export function editStateTransition(
  model: MermaidStateModel,
  key: string,
  changes: Partial<StateTransitionValue>,
  options: StateWriteOptions = {},
) {
  const relation = model.transitions.find((t) => t.id === key),
    record = stateRecord(model, key);
  if (!relation || !record)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  const patches: StatePatch[] = [];
  for (const side of ["from", "to"] as const) {
    if (changes[side] === undefined || changes[side] === relation[side])
      continue;
    const id = stateEndpoint(model, changes[side]!, side),
      range = record.values[side];
    if (!id || !range)
      return stateNoChange(model, "invalid", m.classPatchRejected());
    patches.push({ range, value: id });
  }
  for (const field of ["fromClass", "toClass"] as const) {
    if (
      changes[field] === undefined ||
      changes[field] === (relation[field] ?? "")
    )
      continue;
    const value = changes[field]!;
    if (value && !/^\w+$/.test(value))
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const range = record.values[field];
    if (range)
      patches.push({
        range: value ? range : { start: range.start - 3, end: range.end },
        value,
      });
    else if (value) {
      const offset = record.values[field === "fromClass" ? "from" : "to"]!.end;
      patches.push({
        range: { start: offset, end: offset },
        value: `:::${value}`,
      });
    }
  }
  if (
    changes.label !== undefined &&
    changes.label !== stateDisplayText(relation.label)
  ) {
    const range = record.values.text;
    if (range) {
      const colon = record.raw.indexOf(
        ":",
        (record.values.toClass?.end ?? record.values.to!.end) -
          record.range.start,
      );
      patches.push({
        range: changes.label
          ? range
          : { start: record.range.start + colon, end: range.end },
        value: stateTextValue(changes.label),
      });
    } else if (changes.label)
      patches.push({
        range: { start: record.range.end, end: record.range.end },
        value: `: ${stateTextValue(changes.label)}`,
      });
  }
  const local = writeStatePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
  if (!changes.anchor || local.status === "rejected") return local;
  const moved = moveStateTransition(local.model, key, changes.anchor, {
    ...options,
    baseSource: local.source,
  });
  return composeStateCommandResults(model, moved, options);
}
export function moveStateTransition(
  model: MermaidStateModel,
  key: string,
  anchor: StateInsertAnchor,
  options: StateWriteOptions = {},
) {
  const record = stateRecord(model, key),
    at = stateInsertAnchor(model, anchor),
    group = stateRecordGroup(model, key);
  if (record?.kind !== "transition" || !at || !group)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const patches = stateMoveRecords(model, group.records, at.offset);
  const insert = patches.find((p) => p.value);
  if (insert && record.indent !== at.indent) {
    const shift = at.indent.length - record.indent.length;
    const prefix = insert.identities!.find(
      ([, id]) => id === record.sourceKey,
    )![0];
    insert.value =
      insert.value.slice(0, prefix) +
      at.indent +
      record.raw.slice(record.indent.length) +
      insert.value.slice(prefix + record.raw.length);
    insert.identities = insert.identities!.map(
      ([pos, id]) => [pos > prefix ? pos + shift : pos, id] as const,
    );
  }
  return writeStatePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export function reorderStateTransition(
  model: MermaidStateModel,
  key: string,
  beforeKey: string,
  options: StateWriteOptions = {},
) {
  const source = stateRecord(model, key),
    target = stateRecord(model, beforeKey);
  if (
    source?.kind !== "transition" ||
    target?.kind !== "transition" ||
    source.parentId !== target.parentId ||
    source.regionKey !== target.regionKey
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return moveStateTransition(
    model,
    key,
    { parentId: source.parentId, regionKey: source.regionKey, beforeKey },
    options,
  );
}
export function deleteStateTransition(
  model: MermaidStateModel,
  key: string,
  options: StateWriteOptions = {},
) {
  const record = stateRecord(model, key);
  if (record?.kind !== "transition")
    return stateNoChange(model, "invalid", m.stateMissingObject());
  return deleteStateRecords(model, [record], {
    ...options,
    commentTransfers: new Set(
      model.commentRecords.filter((c) => c.anchorId === key).map((c) => c.id),
    ),
  });
}
import { composeStateCommandResults } from "../writer.js";

import { stateDisplayText } from "../source-document.js";
