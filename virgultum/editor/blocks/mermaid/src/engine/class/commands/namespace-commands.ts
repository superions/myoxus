// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidClassModel } from "../model.js";
import {
  nextClassSourceKey,
  sourceMermaidClassName,
  type ClassSourceRecord,
} from "../source-document.js";
import {
  composeClassCommandResults,
  classNoChange,
  classRecord,
  classRecordEnd,
  classRecordGroup,
  classMoveRecords,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
  type ClassCommandResult,
} from "../writer.js";
import {
  deleteClasses,
  validClassId,
  classQuotedText,
} from "./class-commands.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export function namespaceRecord(model: MermaidClassModel, key: string) {
  const namespace = model.namespaces.find(
    (n) => n.sourceKey === key || n.id === key,
  );
  return namespace
    ? model.sourceDocument.records.find(
        (r) => r.kind === "namespace" && r.ownerId === namespace.id,
      )
    : undefined;
}
function namespaceUnit(model: MermaidClassModel, record: ClassSourceRecord) {
  const close = record.closeKey
    ? classRecord(model, record.closeKey)
    : undefined;
  const end = classRecordEnd(close ?? record);
  return model.sourceDocument.records.filter(
    (r) => r.range.start >= record.range.start && r.range.start < end,
  );
}
/** Dotted parents are real objects. Materialize only their descendant lexical
 * units when a command needs an explicit boundary; never rewrite the diagram. */
function materializeNamespace(model: MermaidClassModel, id: string) {
  const namespace = model.namespaces.find((n) => n.id === id);
  if (!namespace || namespace.explicit) return classNoChange(model);
  const openings = model.sourceDocument.records.filter(
    (r) =>
      r.kind === "namespace" &&
      r.ownerId?.startsWith(id + ".") &&
      !(r.namespaceId === id || r.namespaceId?.startsWith(id + ".")),
  );
  if (!openings.length)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const patches: ClassPatch[] = [],
    identities: [number, string][] = [];
  const first = openings[0]!,
    nl = model.sourceDocument.newline;
  const local = first.namespaceId ? id.slice(first.namespaceId.length + 1) : id;
  let value = `${first.indent}namespace ${sourceMermaidClassName(local)} {${nl}`;
  identities.push([0, nextClassSourceKey()]);
  for (const opening of openings) {
    const records = namespaceUnit(model, opening),
      start = opening.range.start,
      end = classRecordEnd(records.at(-1)!);
    const ref = opening.references.find((r) => r.kind === "namespace")!;
    const replacement = sourceMermaidClassName(
      opening.ownerId!.slice(id.length + 1),
    );
    const old = model.sourceDocument.source.slice(start, end);
    const unit =
      old.slice(0, ref.range.start - start) +
      replacement +
      old.slice(ref.range.end - start);
    const delta = replacement.length - (ref.range.end - ref.range.start);
    for (const record of records)
      identities.push([
        value.length +
          record.range.start -
          start +
          (record.range.start >= ref.range.end ? delta : 0),
        record.sourceKey,
      ]);
    value += unit;
    if (!/[\r\n]$/.test(value)) value += nl;
    patches.push({ range: { start, end }, value: "" });
  }
  value += `${first.indent}}${nl}`;
  patches.push({
    range: { start: first.range.start, end: first.range.start },
    value,
    identities,
  });
  return writeClassPatches(model, patches);
}
function throughNamespace(
  model: MermaidClassModel,
  id: string,
  operation: (
    prepared: MermaidClassModel,
  ) => import("../writer.js").ClassCommandResult,
  options: ClassWriteOptions,
) {
  const prepared = materializeNamespace(model, id);
  if (prepared.status === "rejected") return prepared;
  return composeClassCommandResults(model, operation(prepared.model), options);
}
export function addClassNamespace(
  model: MermaidClassModel,
  value: { id: string; label?: string; parentId?: string | null },
  options: ClassWriteOptions = {},
): ClassCommandResult {
  if (value.parentId && !namespaceRecord(model, value.parentId))
    return throughNamespace(
      model,
      value.parentId,
      (prepared) => addClassNamespace(prepared, value),
      options,
    );
  const id = value.parentId ? `${value.parentId}.${value.id}` : value.id;
  if (!validClassId(value.id) || model.namespaces.some((n) => n.id === id))
    return classNoChange(model, "invalid", messages.classIdCollision());
  const parent = value.parentId
      ? namespaceRecord(model, value.parentId)
      : undefined,
    closing = parent?.closeKey
      ? classRecord(model, parent.closeKey)
      : undefined;
  if (value.parentId && !closing)
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const key = nextClassSourceKey(),
    indent = parent ? parent.indent + "  " : "",
    nl = model.sourceDocument.newline;
  const text = `${indent}namespace ${sourceMermaidClassName(value.id)}${value.label !== undefined ? `["${classQuotedText(value.label)}"]` : ""} {${nl}${indent}}`;
  return writeClassPatches(
    model,
    [
      classNewRecordPatch(
        model,
        closing?.range.start ?? model.sourceDocument.source.length,
        text,
        key,
      ),
    ],
    { ...options, selection: `${key}:namespace` },
  );
}
export function editClassNamespace(
  model: MermaidClassModel,
  key: string,
  value: { id?: string; label?: string },
  options: ClassWriteOptions = {},
): ClassCommandResult {
  const namespace = model.namespaces.find(
      (n) => n.sourceKey === key || n.id === key,
    ),
    record = namespaceRecord(model, key);
  if (!namespace)
    return classNoChange(model, "invalid", messages.classMissingObject());
  if (!record && value.label !== undefined)
    return throughNamespace(
      model,
      namespace.id,
      (prepared) => editClassNamespace(prepared, namespace.sourceKey, value),
      options,
    );
  const patches: ClassPatch[] = [];
  if (value.id !== undefined && value.id !== namespace.id.split(".").at(-1)) {
    if (!validClassId(value.id))
      return classNoChange(model, "invalid", messages.classIdInvalid());
    const path = namespace.parentId
      ? `${namespace.parentId}.${value.id}`
      : value.id;
    if (model.namespaces.some((n) => n !== namespace && n.id === path))
      return classNoChange(model, "invalid", messages.classIdCollision());
    for (const r of model.sourceDocument.records.filter(
      (r) => r.kind === "namespace",
    ))
      for (const ref of r.references) {
        if (
          ref.kind !== "namespace" ||
          !(ref.id === namespace.id || ref.id.startsWith(namespace.id + "."))
        )
          continue;
        if (
          r.namespaceId &&
          (r.namespaceId === namespace.id ||
            r.namespaceId.startsWith(namespace.id + "."))
        )
          continue;
        const next = path + ref.id.slice(namespace.id.length),
          local = r.namespaceId ? next.slice(r.namespaceId.length + 1) : next;
        patches.push({
          range: ref.range,
          value: sourceMermaidClassName(local),
        });
      }
  }
  if (value.label !== undefined && value.label !== namespace.label) {
    if (!record)
      return classNoChange(model, "invalid", messages.classPatchRejected());
    if (record.values.label)
      patches.push({
        range: record.values.label,
        value: classQuotedText(value.label),
      });
    else {
      const end = record.references[0]!.range.end;
      patches.push({
        range: { start: end, end },
        value: `["${classQuotedText(value.label)}"]`,
      });
    }
  }
  return writeClassPatches(model, patches, {
    ...options,
    selection: namespace.sourceKey,
  });
}
export function moveClassNamespace(
  model: MermaidClassModel,
  key: string,
  parentId: string | null,
  options: ClassWriteOptions = {},
  before?: string,
): ClassCommandResult {
  const namespace = model.namespaces.find(
      (n) => n.sourceKey === key || n.id === key,
    ),
    record = namespaceRecord(model, key);
  if (namespace && !record)
    return throughNamespace(
      model,
      namespace.id,
      (prepared) =>
        moveClassNamespace(prepared, namespace.sourceKey, parentId, {}, before),
      options,
    );
  if (parentId && !namespaceRecord(model, parentId))
    return throughNamespace(
      model,
      parentId,
      (prepared) => moveClassNamespace(prepared, key, parentId, {}, before),
      options,
    );
  if (
    !namespace ||
    !record ||
    parentId === namespace.id ||
    parentId?.startsWith(namespace.id + ".")
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const parent = parentId ? namespaceRecord(model, parentId) : undefined,
    close = parent?.closeKey ? classRecord(model, parent.closeKey) : undefined,
    target = before ? namespaceRecord(model, before) : undefined;
  if ((parentId && !close) || (target && target.namespaceId !== parentId))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const destination = parentId
    ? `${parentId}.${namespace.id.split(".").at(-1)}`
    : namespace.id.split(".").at(-1)!;
  if (model.namespaces.some((n) => n !== namespace && n.id === destination))
    return classNoChange(model, "invalid", messages.classIdCollision());
  const ref = record.references.find((r) => r.kind === "namespace")!;
  const local = namespace.id.split(".").at(-1)!;
  const written = model.sourceDocument.source.slice(
    ref.range.start,
    ref.range.end,
  );
  if (written !== sourceMermaidClassName(local)) {
    const prepared = writeClassPatches(model, [
      { range: ref.range, value: sourceMermaidClassName(local) },
    ]);
    if (prepared.status === "rejected") return prepared;
    return composeClassCommandResults(
      model,
      moveClassNamespace(
        prepared.model,
        namespace.sourceKey,
        parentId,
        {},
        before,
      ),
      options,
    );
  }
  const records = namespaceUnit(model, record),
    offset =
      target?.range.start ??
      close?.range.start ??
      model.sourceDocument.source.length;
  const patches = classMoveRecords(model, records, offset);
  return writeClassPatches(model, patches, {
    ...options,
    selection: namespace.sourceKey,
  });
}
/** Group only an already completed, homogeneous selection. Never filter notes
 * out of a mixed box selection or infer containment from canvas proximity. */
export function classGroupAllowed(
  model: MermaidClassModel,
  keys: readonly string[],
) {
  const nodes = keys.map((key) =>
    model.nodes.find((n) => n.sourceKey === key || n.id === key),
  );
  return (
    keys.length >= 2 &&
    nodes.every((n) => n?.kind === "class") &&
    nodes.every((n) => n!.namespaceId === nodes[0]!.namespaceId)
  );
}
export function groupClasses(
  model: MermaidClassModel,
  keys: readonly string[],
  value: { id: string; label?: string },
  options: ClassWriteOptions = {},
) {
  if (!classGroupAllowed(model, keys))
    return classNoChange(model, "invalid", messages.classGroupSelection());
  const nodes = keys.map((key) =>
    model.nodes.find((n) => n.sourceKey === key || n.id === key)!,
  );
  return transferClasses(
    model,
    nodes.map((n) => n.sourceKey),
    undefined,
    options,
    value,
  );
}
export function setClassNamespace(
  model: MermaidClassModel,
  key: string,
  namespaceId: string | null,
  options: ClassWriteOptions = {},
) {
  return transferClasses(model, [key], namespaceId, options);
}
function transferClasses(
  model: MermaidClassModel,
  keys: readonly string[],
  namespaceId: string | null | undefined,
  options: ClassWriteOptions,
  newNamespace?: { id: string; label?: string },
): ClassCommandResult {
  const nodes = keys
    .map((key) => model.nodes.find((n) => n.sourceKey === key || n.id === key))
    .filter((n) => n?.kind === "class");
  if (nodes.length !== keys.length)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const parentId = newNamespace ? nodes[0]!.namespaceId : (namespaceId ?? null);
  if (parentId && !namespaceRecord(model, parentId))
    return throughNamespace(
      model,
      parentId,
      (prepared) =>
        transferClasses(prepared, keys, namespaceId, {}, newNamespace),
      options,
    );
  const parent = parentId ? namespaceRecord(model, parentId) : undefined,
    close = parent?.closeKey ? classRecord(model, parent.closeKey) : undefined;
  if (
    (parentId && !close) ||
    (newNamespace &&
      (!validClassId(newNamespace.id) ||
        model.namespaces.some(
          (n) => n.id === (parentId ? parentId + "." : "") + newNamespace.id,
        )))
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const units: ClassSourceRecord[][] = [];
  for (const node of nodes)
    for (const opening of model.sourceDocument.records.filter(
      (r) => r.kind === "class" && r.ownerId === node!.sourceId,
    )) {
      let start = opening.range.start;
      const anchored = model.commentRecords.filter(
        (c) =>
          c.anchorKind === "class" &&
          c.anchorId === node!.sourceKey &&
          c.position === "before",
      );
      for (const c of anchored) {
        const r = classRecord(model, c.id);
        if (
          r &&
          r.range.end <= opening.range.start &&
          model.sourceDocument.records
            .filter(
              (other) =>
                other.range.start >= r.range.end &&
                other.range.start < opening.range.start,
            )
            .every(
              (other) => other.kind === "comment" || other.kind === "blank",
            )
        )
          start = Math.min(start, r.range.start);
      }
      const end = opening.closeKey
        ? classRecordEnd(classRecord(model, opening.closeKey)!)
        : classRecordEnd(opening);
      units.push(
        model.sourceDocument.records.filter(
          (r) => r.range.start >= start && r.range.start < end,
        ),
      );
    }
  // Classes first introduced by a relation/short member still need a declaration
  // at the confirmed destination; their global ID and original records stay put.
  const implicitNodes = nodes.filter(
    (node) =>
      !model.sourceDocument.records.some(
        (r) => r.kind === "class" && r.ownerId === node!.sourceId,
      ),
  );
  const offset = close?.range.start ?? model.sourceDocument.source.length,
    nl = model.sourceDocument.newline,
    key = nextClassSourceKey();
  let value = newNamespace
    ? `${parent ? parent.indent + "  " : ""}namespace ${sourceMermaidClassName(newNamespace.id)}${newNamespace.label !== undefined ? `["${classQuotedText(newNamespace.label)}"]` : ""} {${nl}`
    : "";
  const identities: [number, string][] = newNamespace ? [[0, key]] : [];
  const patches: ClassPatch[] = [];
  for (const records of units) {
    const start = records[0]!.range.start,
      end = classRecordEnd(records.at(-1)!);
    for (const r of records)
      identities.push([value.length + r.range.start - start, r.sourceKey]);
    value += model.sourceDocument.source.slice(start, end);
    if (!/[\r\n]$/.test(value)) value += nl;
    patches.push({ range: { start, end }, value: "" });
  }
  for (const node of implicitNodes) {
    identities.push([value.length, nextClassSourceKey()]);
    value += `${parent ? parent.indent + "  " : ""}class ${sourceMermaidClassName(node!.sourceId)}${nl}`;
  }
  if (newNamespace) value += `${parent?.indent ?? ""}}${nl}`;
  const prefix =
    offset > 0 && !/[\r\n]/.test(model.sourceDocument.source[offset - 1]!)
      ? nl
      : "";
  patches.push({
    range: { start: offset, end: offset },
    value: prefix + value,
    identities: identities.map(([start, id]) => [start + prefix.length, id]),
  });
  return writeClassPatches(model, patches, {
    ...options,
    selection: newNamespace ? `${key}:namespace` : nodes[0]!.sourceKey,
  });
}
export function deleteClassNamespace(
  model: MermaidClassModel,
  key: string,
  strategy: "ungroup" | "delete",
  notes: "keep-free" | "delete" | undefined,
  options: ClassWriteOptions = {},
): ClassCommandResult {
  const namespace = model.namespaces.find(
      (n) => n.sourceKey === key || n.id === key,
    ),
    record = namespaceRecord(model, key);
  if (namespace && !record)
    return throughNamespace(
      model,
      namespace.id,
      (prepared) =>
        deleteClassNamespace(prepared, namespace.sourceKey, strategy, notes),
      options,
    );
  if (!namespace || !record)
    return classNoChange(model, "invalid", messages.classPatchRejected());
  if (strategy === "delete") {
    const nodes = model.nodes.filter(
      (n) =>
        n.namespaceId === namespace.id ||
        n.namespaceId?.startsWith(namespace.id + "."),
    );
    const deleted = nodes.length
      ? deleteClasses(
          model,
          nodes.map((n) => n.sourceKey),
          notes,
          options,
        )
      : classNoChange(model);
    if (deleted.status === "rejected") return deleted;
    const unit = namespaceUnit(model, record),
      start = unit[0]!.range.start,
      end = classRecordEnd(unit.at(-1)!);
    const candidateRecord = namespaceRecord(deleted.model, namespace.sourceKey);
    if (!candidateRecord)
      return classNoChange(model, "invalid", messages.classPatchRejected());
    const kept =
      notes === "keep-free"
        ? deleted.model.notes.filter(
            (n) =>
              deleted.impact.attachedNotes.includes(n.id) &&
              n.namespaceId &&
              (n.namespaceId === namespace.id ||
                n.namespaceId.startsWith(namespace.id + ".")),
          )
        : [];
    const identities: [number, string][] = [],
      retained = new Set<string>();
    let value = "";
    for (const note of kept) {
      const group = classRecordGroup(deleted.model, note.id)!;
      for (const r of group.records) {
        identities.push([
          value.length + r.range.start - group.range.start,
          r.sourceKey,
        ]);
        retained.add(r.sourceKey);
      }
      value += deleted.source.slice(group.range.start, group.range.end);
      if (!/[\r\n]$/.test(value)) value += model.sourceDocument.newline;
    }
    const patches = deleted.patches.filter(
      (p) => p.range.end <= start || p.range.start >= end,
    );
    patches.push({ range: { start, end }, value, identities });
    const removed = new Set(
      model.sourceDocument.records
        .filter(
          (r) =>
            ((r.range.start >= start && r.range.start < end) ||
              !deleted.model.sourceDocument.records.some(
                (next) => next.sourceKey === r.sourceKey,
              )) &&
            !retained.has(r.sourceKey),
        )
        .map((r) => r.sourceKey),
    );
    return writeClassPatches(model, patches, {
      ...options,
      removed,
      impact: {
        records: [
          ...new Map(
            [
              ...deleted.impact.records,
              ...unit.map((r) => ({
                id: r.sourceKey,
                kind: r.kind,
                label: r.raw.trim(),
              })),
            ].map((r) => [r.id, r]),
          ).values(),
        ],
        attachedNotes: deleted.impact.attachedNotes,
      },
    });
  }
  const closing = record.closeKey
    ? classRecord(model, record.closeKey)
    : undefined;
  const remove = [record, ...(closing ? [closing] : [])];
  return writeClassPatches(
    model,
    remove.map((r) => ({
      range: { start: r.range.start, end: classRecordEnd(r) },
      value: "",
    })),
    {
      ...options,
      removed: new Set(remove.map((r) => r.sourceKey)),
      commentTransfers: new Set(
        model.commentRecords
          .filter(
            (c) =>
              c.anchorKind === "namespace" &&
              c.anchorId === namespace.sourceKey,
          )
          .map((c) => c.id),
      ),
      impact: {
        records: [
          ...remove,
          ...model.commentRecords
            .filter((c) => c.anchorId === namespace.sourceKey)
            .flatMap((c) => {
              const r = classRecord(model, c.id);
              return r ? [r] : [];
            }),
        ].map((r) => ({ id: r.sourceKey, kind: r.kind, label: r.raw.trim() })),
        attachedNotes: [],
      },
    },
  );
}

/** A mixed selection shares the Class cascade and one original-basis patch set. */
export function deleteClassSelection(
  model: MermaidClassModel,
  keys: readonly string[],
  notes: "keep-free" | "delete" | undefined,
  options: ClassWriteOptions = {},
): ClassCommandResult {
  const namespaces = model.namespaces.filter((n) => keys.includes(n.sourceKey));
  // Namespace deletion owns its Class cascade, including retained attached notes.
  // Running that cascade first prevents a later namespace pass deleting freed notes.
  let result = classNoChange(model);
  const impacts: ClassCommandResult["impact"][] = [];
  const roots = namespaces.filter(
    (n) =>
      !namespaces.some(
        (parent) => parent !== n && n.id.startsWith(parent.id + "."),
      ),
  );
  for (const group of roots) {
    const next = deleteClassNamespace(
      result.model,
      group.sourceKey,
      "delete",
      notes,
    );
    if (next.status === "rejected") return next;
    impacts.push(next.impact);
    result = next;
  }
  const classKeys = result.model.nodes
    .filter((n) => n.kind === "class" && keys.includes(n.sourceKey))
    .map((n) => n.sourceKey);
  if (classKeys.length) {
    const next = deleteClasses(result.model, classKeys, notes);
    if (next.status === "rejected") return next;
    impacts.push(next.impact);
    result = next;
  }
  const remaining = keys.filter((key) => classRecord(result.model, key));
  const groups = remaining.flatMap((key) => {
    const group = classRecordGroup(result.model, key);
    return group ? [group] : [];
  });
  const records = [
    ...new Map(
      groups.flatMap((g) => g.records).map((r) => [r.sourceKey, r]),
    ).values(),
  ];
  if (records.length) {
    // Disjoint records are deduplicated rather than silently expanding a selection.
    const next = writeClassPatches(
      result.model,
      records.map((r) => ({
        range: { start: r.range.start, end: classRecordEnd(r) },
        value: "",
      })),
      { removed: new Set(records.map((r) => r.sourceKey)) },
    );
    if (next.status === "rejected") return next;
    result = next;
  }
  const finalRecords = new Set(
    result.model.sourceDocument.records.map((r) => r.sourceKey),
  );
  return composeClassCommandResults(
    model,
    {
      ...result,
      impact: {
        attachedNotes: [
          ...new Set(impacts.flatMap((impact) => impact.attachedNotes)),
        ],
        records: model.sourceDocument.records
          .filter(
            (r) =>
              !finalRecords.has(r.sourceKey) ||
              result.model.sourceDocument.records.find(
                (other) => other.sourceKey === r.sourceKey,
              )?.raw !== r.raw,
          )
          .map((r) => ({ id: r.sourceKey, kind: r.kind, label: r.raw.trim() })),
      },
    },
    options,
  );
}
