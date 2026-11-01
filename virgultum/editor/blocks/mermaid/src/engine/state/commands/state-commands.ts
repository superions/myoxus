// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  stateEffectiveDescriptions,
  type MermaidStateModel,
} from "../model.js";
import {
  stateNoChange,
  stateRecord,
  stateRecordEnd,
  stateNewRecordPatch,
  stateInsertAnchor,
  stateSourceIdValue,
  stateTextValue,
  stateImpact,
  writeStatePatches,
  deleteStateRecords,
  stateMoveRecords,
  stateRecordGroup,
  composeStateCommandResults,
  type StateInsertAnchor,
  type StateWriteOptions,
  type StatePatch,
  type StateCommandResult,
} from "../writer.js";
import { nextStateSourceKey } from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
export function stateObject(model: MermaidStateModel, key: string) {
  return [...model.states, ...model.composites].find(
    (n) => n.sourceKey === key || n.id === key,
  );
}
export function addState(
  model: MermaidStateModel,
  value: { id: string; label?: string; anchor?: StateInsertAnchor },
  options: StateWriteOptions = {},
) {
  const at = stateInsertAnchor(model, value.anchor);
  if (
    !at ||
    !stateSourceIdValue(
      value.id,
      value.label === undefined ? "state" : "alias",
    ) ||
    stateObject(model, value.id)
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const key = nextStateSourceKey();
  const text =
    value.label === undefined
      ? value.id
      : `state "${stateTextValue(value.label).replaceAll('"', "#34;")}" as ${value.id}`;
  return writeStatePatches(
    model,
    [stateNewRecordPatch(model, at.offset, at.indent + text, key)],
    { ...options, selection: value.id, focus: value.id },
  );
}
export function renameStateId(
  model: MermaidStateModel,
  key: string,
  id: string,
  options: StateWriteOptions = {},
) {
  const node = stateObject(model, key);
  if (
    !node ||
    ("kind" in node && (node.kind === "start" || node.kind === "end"))
  )
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (id === node.id) return writeStatePatches(model, [], options);
  if (
    stateObject(model, id) ||
    model.sourceDocument.records.some(
      (r) =>
        r.references.some((ref) => ref.id === node.id) &&
        !stateSourceIdValue(
          id,
          r.kind === "pseudostate"
            ? "pseudostate"
            : r.kind === "state"
              ? r.values.text
                ? "alias"
                : r.values.classes
                  ? "reference"
                  : "state"
              : r.kind === "composite"
                ? r.values.text
                  ? "composite-alias"
                  : "state"
                : "reference",
        ),
    )
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const patches: StatePatch[] = model.sourceDocument.records.flatMap((r) =>
    r.references
      .filter((ref) => ref.id === node.id)
      .map((ref) => ({ range: ref.range, value: id })),
  );
  if (!patches.length)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  const stateKeys = new Map(
    [...model.states, ...model.composites].map((n) => [
      n.id === node.id ? id : n.id,
      n.sourceKey!,
    ]),
  );
  return writeStatePatches(model, patches, {
    ...options,
    stateKeys,
    selection: node.sourceKey,
    focus: node.sourceKey,
  });
}
/** ID and heading changes share one checked Source commit and history entry. */
export function editState(
  model: MermaidStateModel,
  key: string,
  value: { id?: string; label?: string },
  options: StateWriteOptions = {},
): StateCommandResult {
  let result = writeStatePatches(model, [], options);
  if (value.id !== undefined)
    result = renameStateId(model, key, value.id, options);
  if (result.status === "rejected" || value.label === undefined) return result;
  const edited = setStateHeading(result.model, key, value.label, {
    ...options,
    baseSource: result.source,
  });
  return edited.status === "rejected"
    ? stateNoChange(model, edited.reason, edited.diagnostic)
    : composeStateCommandResults(model, edited, options);
}
export function setStateHeading(
  model: MermaidStateModel,
  key: string,
  text: string,
  options: StateWriteOptions = {},
) {
  const node = stateObject(model, key);
  if (!node || ("kind" in node && node.kind !== "state"))
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (text === stateDisplayText(node.label))
    return writeStatePatches(model, [], options);
  const heading = stateEffectiveDescriptions(node)[0] ?? node.descriptions?.[0],
    record = heading ? stateRecord(model, heading.recordKey) : undefined;
  if (record) {
    const field = heading!.id.endsWith(":body") ? "body" : "text",
      range = record.values[field];
    if (!range) return stateNoChange(model, "invalid", m.classPatchRejected());
    return writeStatePatches(
      model,
      [
        {
          range,
          value: stateTextValue(text).replaceAll(
            '"',
            heading!.form === "alias" ? "#34;" : '"',
          ),
        },
      ],
      { ...options, selection: node.sourceKey, focus: node.sourceKey },
    );
  }
  const declaration = node.recordKeys
    ?.map((k) => stateRecord(model, k))
    .find((r) => r?.kind === "state" || r?.kind === "composite");
  if (declaration) {
    const at = declaration.values.id!;
    const offset = declaration.range.start + declaration.indent.length;
    const keyword = /^(?:[ \t]*state\s+)/i.exec(declaration.raw);
    const start = keyword
      ? declaration.range.start + keyword[0].length
      : offset;
    return writeStatePatches(
      model,
      [
        {
          range: { start, end: at.end },
          value: `${keyword ? "" : "state "}"${stateTextValue(text).replaceAll('"', "#34;")}" as ${node.id}`,
        },
      ],
      { ...options, selection: node.sourceKey, focus: node.sourceKey },
    );
  }
  const at = stateInsertAnchor(model, {
    parentId: node.parentId,
    regionKey: node.regionKey,
  });
  if (!at) return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(
    model,
    [
      stateNewRecordPatch(
        model,
        at.offset,
        `${at.indent}state "${stateTextValue(text).replaceAll('"', "#34;")}" as ${node.id}`,
      ),
    ],
    { ...options, selection: node.sourceKey, focus: node.sourceKey },
  );
}
export function addStateDescription(
  model: MermaidStateModel,
  key: string,
  text: string,
  options: StateWriteOptions = {},
) {
  const node = model.states.find((n) => n.sourceKey === key || n.id === key);
  if (!node || node.kind !== "state")
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const last = node.descriptions?.at(-1),
    record = last
      ? stateRecord(model, last.recordKey)
      : node.recordKeys?.map((k) => stateRecord(model, k)).findLast(Boolean);
  const at = stateInsertAnchor(model, {
    parentId: node.parentId,
    regionKey: node.regionKey,
    afterKey: record?.sourceKey,
  });
  if (!at) return stateNoChange(model, "invalid", m.classPatchRejected());
  const sourceKey = nextStateSourceKey();
  return writeStatePatches(
    model,
    [
      stateNewRecordPatch(
        model,
        at.offset,
        `${at.indent}${node.id}: ${stateTextValue(text)}`,
        sourceKey,
      ),
    ],
    { ...options, selection: sourceKey, focus: sourceKey },
  );
}
export function insertStateDescription(
  model: MermaidStateModel,
  key: string,
  text: string,
  beforeKey?: string,
  options: StateWriteOptions = {},
): StateCommandResult {
  const added = addStateDescription(model, key, text, options);
  if (!beforeKey || added.status === "rejected" || !added.selection)
    return added;
  const moved = reorderStateDescription(
    added.model,
    added.selection,
    beforeKey,
    { ...options, baseSource: added.source },
  );
  return moved.status === "rejected"
    ? stateNoChange(model, moved.reason, moved.diagnostic)
    : composeStateCommandResults(model, moved, options);
}
export function editStateDescription(
  model: MermaidStateModel,
  key: string,
  text: string,
  options: StateWriteOptions = {},
) {
  const description = model.states
    .flatMap((n) => n.descriptions ?? [])
    .find((d) => d.id === key);
  const record = description
    ? stateRecord(model, description.recordKey)
    : undefined;
  const range =
    record?.values[description?.id.endsWith(":body") ? "body" : "text"];
  if (!description || !range)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (text === stateDisplayText(description.text))
    return writeStatePatches(model, [], options);
  return writeStatePatches(
    model,
    [
      {
        range,
        value: stateTextValue(text).replaceAll(
          '"',
          description.form === "alias" ? "#34;" : '"',
        ),
      },
    ],
    { ...options, selection: key, focus: key },
  );
}
export function reorderStateDescription(
  model: MermaidStateModel,
  key: string,
  beforeKey: string,
  options: StateWriteOptions = {},
): StateCommandResult {
  const node = model.states.find((n) =>
    n.descriptions?.some((d) => d.id === key),
  );
  const description = node?.descriptions?.find((d) => d.id === key),
    target = node?.descriptions?.find((d) => d.id === beforeKey);
  if (!node || !description || !target)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  if (key === beforeKey) return writeStatePatches(model, [], options);
  // Split only an inline body's owned field when its new order requires an
  // independent record. Its former detail key becomes that record's key.
  const inline = [description, target].filter((d) => d.id.endsWith(":body"));
  if (inline.length) {
    const patches: StatePatch[] = [];
    for (const d of inline) {
      const r = stateRecord(model, d.recordKey)!;
      const colon = r.raw.indexOf(":", r.values.id!.end - r.range.start);
      patches.push(
        {
          range: { start: r.range.start + colon, end: r.range.end },
          value: "",
        },
        stateNewRecordPatch(
          model,
          stateRecordEnd(r),
          `${r.indent}${node.id}: ${stateTextValue(stateDisplayText(d.text))}`,
          d.id,
        ),
      );
    }
    const split = writeStatePatches(model, patches, options);
    if (split.status === "rejected") return split;
    return composeStateCommandResults(
      model,
      reorderStateDescription(split.model, key, beforeKey, {
        ...options,
        baseSource: split.source,
      }),
      options,
    );
  }
  const record = stateRecord(model, description.recordKey)!,
    other = stateRecord(model, target.recordKey)!;
  return writeStatePatches(
    model,
    stateMoveRecords(
      model,
      stateRecordGroup(model, record.sourceKey)!.records,
      other.range.start,
    ),
    { ...options, selection: key, focus: key },
  );
}
export function deleteStateDescription(
  model: MermaidStateModel,
  key: string,
  options: StateWriteOptions = {},
) {
  const node = model.states.find((n) =>
    n.descriptions?.some((d) => d.id === key),
  );
  const description = node?.descriptions?.find((d) => d.id === key),
    record = description
      ? stateRecord(model, description.recordKey)
      : undefined;
  if (!node || !description || !record)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  const comments = model.commentRecords.filter((c) => c.anchorId === key);
  const retainOptions: StateWriteOptions = {
    ...options,
    selection: node.sourceKey,
    focus: node.sourceKey,
    commentTransfers: new Set(comments.map((c) => c.id)),
    commentAnchors: new Map(
      comments.map((c) => [
        c.id,
        {
          ...c,
          anchorKind: "state" as const,
          anchorId: node.sourceKey,
        },
      ]),
    ),
  };
  if (description.form === "alias") {
    const range = record.values.text;
    if (!range) return stateNoChange(model, "invalid", m.classPatchRejected());
    const end = record.values.id!.start - record.range.start;
    return writeStatePatches(
      model,
      [
        {
          range: {
            start: record.range.start + record.indent.length,
            end: record.range.start + end,
          },
          value: "",
        },
      ],
      retainOptions,
    );
  }
  if (description.id.endsWith(":body")) {
    const start = record.raw.indexOf(
      ":",
      record.values.id!.end - record.range.start,
    );
    return writeStatePatches(
      model,
      [
        {
          range: { start: record.range.start + start, end: record.range.end },
          value: "",
        },
      ],
      retainOptions,
    );
  }
  const result = deleteStateRecords(model, [record], {
    ...options,
    commentTransfers: new Set(
      model.commentRecords.filter((c) => c.anchorId === key).map((c) => c.id),
    ),
    selection: node.sourceKey,
    focus: node.sourceKey,
  });
  if (result.status !== "changed") return result;
  const retained = stateObject(result.model, node.sourceKey!);
  if (
    retained &&
    retained.parentId === node.parentId &&
    retained.regionKey === node.regionKey
  )
    return result;
  // The sole declaration/effective nested appearance also owns State existence
  // and membership. Removing only its text keeps a bare ID at the same slot.
  return writeStatePatches(
    model,
    [
      {
        range: {
          start: record.range.start + record.indent.length,
          end: record.range.end,
        },
        value: node.id,
      },
    ],
    retainOptions,
  );
}
export function stateDeleteRecords(
  model: MermaidStateModel,
  keys: readonly string[],
) {
  const nodes = keys
    .map((k) => model.states.find((n) => n.sourceKey === k || n.id === k))
    .filter((n) => n !== undefined);
  const ids = new Set(nodes.map((n) => n.id)),
    recordKeys = new Set(nodes.flatMap((n) => n.recordKeys ?? []));
  for (const transition of model.transitions)
    if (ids.has(transition.from) || ids.has(transition.to))
      recordKeys.add(transition.id);
  for (const note of model.notes)
    if (note.stateId && ids.has(note.stateId)) recordKeys.add(note.id);
  for (const link of model.links)
    if (ids.has(link.stateId)) recordKeys.add(link.sourceKey!);
  for (const style of model.styles)
    if (style.kind !== "definition" && style.owners.every((id) => ids.has(id)))
      recordKeys.add(style.sourceKey);
  const records = model.sourceDocument.records.filter((r) =>
    recordKeys.has(r.sourceKey),
  );
  return { nodes, ids, records, impact: stateImpact(model, records) };
}
export function deleteStateSelection(
  model: MermaidStateModel,
  keys: readonly string[],
  options: StateWriteOptions = {},
) {
  const { nodes, ids } = stateDeleteRecords(model, keys);
  const notes = keys.flatMap((key) => model.notes.filter((n) => n.id === key));
  if (
    nodes.length + notes.length !== keys.length ||
    new Set(keys).size !== keys.length ||
    nodes.some((n) => n.kind === "start" || n.kind === "end")
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return deleteStateObjects(
    model,
    [...ids],
    notes.map((n) => stateRecord(model, n.id)!),
    options,
  );
}
/** Common deletion plan keeps reusable definitions/comments and prunes only
 * removed targets from a multi-target assignment. Scope owners supply their
 * explicit boundary/region records rather than guessing from geometry. */
export function deleteStateObjects(
  model: MermaidStateModel,
  objectIds: readonly string[],
  extraRecords: readonly import("../source-document.js").StateSourceRecord[] = [],
  options: StateWriteOptions = {},
) {
  const ids = new Set(objectIds),
    nodes = [...model.states, ...model.composites].filter((n) => ids.has(n.id));
  const recordKeys = new Set([
    ...nodes.flatMap((n) => n.recordKeys ?? []),
    ...extraRecords.map((r) => r.sourceKey),
  ]);
  for (const t of model.transitions)
    if (ids.has(t.from) || ids.has(t.to)) recordKeys.add(t.id);
  for (const note of model.notes)
    if (note.stateId && ids.has(note.stateId)) recordKeys.add(note.id);
  for (const link of model.links)
    if (ids.has(link.stateId)) recordKeys.add(link.sourceKey!);
  for (const style of model.styles)
    if (style.kind !== "definition" && style.owners.every((id) => ids.has(id)))
      recordKeys.add(style.id);
  const records = model.sourceDocument.records.filter(
    (r) =>
      recordKeys.has(r.sourceKey) &&
      r.kind !== "comment" &&
      r.kind !== "class-definition",
  );
  const impact = stateImpact(model, records);
  const patches: StatePatch[] = records.map((r) => ({
    range: { start: r.range.start, end: stateRecordEnd(r) },
    value: "",
  }));
  for (const style of model.styles) {
    if (
      recordKeys.has(style.sourceKey) ||
      style.kind === "definition" ||
      style.owners.every((id) => ids.has(id)) ||
      !style.owners.some((id) => ids.has(id))
    )
      continue;
    const record = stateRecord(model, style.sourceKey)!;
    patches.push({
      range: record.values.targets!,
      value: style.owners.filter((id) => !ids.has(id)).join(","),
    });
  }
  return writeStatePatches(model, patches, {
    ...options,
    removed: new Set(records.map((r) => r.sourceKey)),
    commentTransfers: new Set(
      model.commentRecords
        .filter(
          (c) =>
            nodes.some(
              (n) =>
                c.anchorId === n.sourceKey ||
                ("primaryRegionKey" in n &&
                  c.anchorId === n.primaryRegionKey) ||
                n.descriptions?.some((d) => d.id === c.anchorId),
            ) || records.some((r) => r.sourceKey === c.anchorId),
        )
        .map((c) => c.id),
    ),
    impact,
  });
}
export function deleteState(
  model: MermaidStateModel,
  key: string,
  options: StateWriteOptions = {},
) {
  return deleteStateSelection(model, [key], options);
}

import { stateDisplayText } from "../source-document.js";
