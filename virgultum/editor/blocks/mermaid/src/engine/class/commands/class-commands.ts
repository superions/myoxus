// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidClassModel } from "../model.js";

import {
  CLASS_NAME_SOURCE,
  nextClassSourceKey,
  sourceMermaidClassName,
} from "../source-document.js";
import {
  classNoChange,
  classRecord,
  classRecordEnd,
  classRecordGroup,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
  type ClassImpact,
} from "../writer.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export function validClassId(value: string) {
  return (
    Boolean(value.trim()) &&
    !/[`\r\n]/.test(value) &&
    new RegExp(`^${CLASS_NAME_SOURCE}$`, "u").test(
      sourceMermaidClassName(value),
    )
  );
}
export function classQuotedText(value: string) {
  return value.replaceAll('"', "&quot;");
}
export function addClass(
  model: MermaidClassModel,
  value: {
    id: string;
    label?: string;
    genericType?: string;
    annotation?: string;
    namespaceId?: string | null;
  },
  options: ClassWriteOptions = {},
) {
  if (!validClassId(value.id))
    return classNoChange(model, "invalid", messages.classIdInvalid());
  if (model.nodes.some((n) => n.kind === "class" && n.sourceId === value.id))
    return classNoChange(model, "invalid", messages.classIdCollision());
  if (
    /[~\r\n]/.test(value.genericType ?? "") ||
    /[>\r\n]/.test(value.annotation ?? "")
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const namespace = value.namespaceId
    ? model.sourceDocument.records.find(
        (r) =>
          r.kind === "namespace" &&
          r.ownerId === value.namespaceId &&
          r.closeKey,
      )
    : undefined;
  if (value.namespaceId && !namespace)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const closing = namespace?.closeKey
      ? classRecord(model, namespace.closeKey)
      : undefined,
    key = nextClassSourceKey();
  const text = `${namespace ? namespace.indent + "  " : ""}class ${sourceMermaidClassName(value.id)}${value.genericType ? `~${value.genericType}~` : ""}${value.label !== undefined ? `["${classQuotedText(value.label)}"]` : ""}${value.annotation ? ` <<${value.annotation}>>` : ""}`;
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
    { ...options, selection: `${key}:class:0` },
  );
}
export function renameClassId(
  model: MermaidClassModel,
  key: string,
  id: string,
  options: ClassWriteOptions = {},
) {
  const node = model.nodes.find((n) => n.sourceKey === key || n.id === key);
  if (!node || node.kind !== "class")
    return classNoChange(model, "invalid", messages.classMissingObject());
  if (!validClassId(id))
    return classNoChange(model, "invalid", messages.classIdInvalid());
  if (
    model.nodes.some(
      (n) => n !== node && n.kind === "class" && n.sourceId === id,
    )
  )
    return classNoChange(model, "invalid", messages.classIdCollision());
  const patches: ClassPatch[] = [];
  for (const record of model.sourceDocument.records)
    for (const ref of record.references) {
      if (ref.kind !== "class" || ref.id !== node.sourceId) continue;
      const relation = model.relations.find((r) => r.id === record.sourceKey);
      if (
        relation &&
        ((ref.range.start === record.values.from?.start &&
          relation.fromMarker === "lollipop" &&
          relation.toMarker === "none") ||
          (ref.range.start === record.values.to?.start &&
            relation.toMarker === "lollipop" &&
            relation.fromMarker === "none"))
      )
        continue;
      patches.push({ range: ref.range, value: sourceMermaidClassName(id) });
    }
  return writeClassPatches(model, patches, {
    ...options,
    classKeys: new Map([[id, node.sourceKey]]),
    selection: node.sourceKey,
  });
}
export function editClass(
  model: MermaidClassModel,
  key: string,
  changes: {
    id?: string;
    label?: string;
    genericType?: string;
    annotation?: string;
  },
  options: ClassWriteOptions = {},
) {
  const node = model.nodes.find((n) => n.sourceKey === key || n.id === key);
  if (!node || node.kind !== "class")
    return classNoChange(model, "invalid", messages.classMissingObject());
  const declarations = model.sourceDocument.records.filter(
    (r) => r.kind === "class" && r.ownerId === node.sourceId,
  );
  const patches: ClassPatch[] = [];
  const removed = new Set<string>();
  let classKeys = options.classKeys;
  if (changes.id !== undefined && changes.id !== node.sourceId) {
    const renamed = renameClassId(model, key, changes.id, options);
    if (renamed.status === "rejected") return renamed;
    patches.push(...renamed.patches);
    classKeys = new Map([[changes.id, node.sourceKey]]);
  }
  if (changes.label !== undefined && changes.label !== node.label) {
    const declaration =
      declarations.findLast((r) => r.values.label) ?? declarations.at(-1);
    if (declaration?.values.label)
      patches.push({
        range: declaration.values.label,
        value: classQuotedText(changes.label),
      });
    else if (declaration) {
      const end = declaration.values.generic
        ? declaration.values.generic.end + 1
        : declaration.references[0]!.range.end;
      patches.push({
        range: { start: end, end },
        value: `["${classQuotedText(changes.label)}"]`,
      });
    } else
      patches.push(
        classNewRecordPatch(
          model,
          model.sourceDocument.source.length,
          `class ${sourceMermaidClassName(changes.id ?? node.sourceId)}["${classQuotedText(changes.label)}"]`,
        ),
      );
  }
  if (
    changes.genericType !== undefined &&
    changes.genericType !== node.genericType
  ) {
    if (/[~\r\n]/.test(changes.genericType))
      return classNoChange(model, "invalid", messages.classPatchRejected());
    const first = model.sourceDocument.records.find((r) =>
      r.references.some(
        (ref) => ref.kind === "class" && ref.id === node.sourceId,
      ),
    );
    if (!first)
      return classNoChange(model, "invalid", messages.classMissingObject());
    const relation = model.relations.find(
      (r) => r.sourceKey === first.sourceKey,
    );
    const genericRange =
      first.values.generic ??
      (relation?.fromSourceId === node.sourceId
        ? first.values.fromGeneric
        : first.values.toGeneric);
    if (genericRange)
      patches.push({ range: genericRange, value: changes.genericType });
    else {
      const id = first.references.find(
        (r) => r.kind === "class" && r.id === node.sourceId,
      )!;
      patches.unshift({
        range: { start: id.range.end, end: id.range.end },
        value: `~${changes.genericType}~`,
      });
    }
  }
  if (
    changes.annotation !== undefined &&
    changes.annotation !== (node.annotations[0] ?? "")
  ) {
    if (/[>\r\n]/.test(changes.annotation))
      return classNoChange(model, "invalid", messages.classPatchRejected());
    const owner = model.sourceDocument.records.find(
      (r) => r.ownerId === node.sourceId && r.values.annotation,
    );
    if (owner && !changes.annotation && owner.kind === "annotation") {
      const group = classRecordGroup(model, owner.sourceKey)!;
      patches.push({ range: group.range, value: "" });
      group.records.forEach((record) => removed.add(record.sourceKey));
    } else if (owner) {
      const range = owner.values.annotation!;
      patches.push({
        range: changes.annotation
          ? range
          : { start: range.start - 2, end: range.end + 2 },
        value: changes.annotation,
      });
    } else if (changes.annotation)
      patches.push(
        classNewRecordPatch(
          model,
          model.sourceDocument.source.length,
          `<<${changes.annotation}>> ${sourceMermaidClassName(changes.id ?? node.sourceId)}`,
        ),
      );
  }
  return writeClassPatches(model, patches, {
    ...options,
    classKeys,
    removed,
    selection: node.sourceKey,
  });
}
export function classDeleteImpact(
  model: MermaidClassModel,
  keys: readonly string[],
): ClassImpact {
  const nodes = model.nodes.filter(
    (n) => keys.includes(n.sourceKey) || keys.includes(n.id),
  );
  const ids = new Set(nodes.map((n) => n.sourceId));
  const recordKeys = new Set(
    model.sourceDocument.records
      .filter(
        (r) =>
          r.references.some((ref) => ref.kind === "class" && ids.has(ref.id)) ||
          (r.ownerId && ids.has(r.ownerId)),
      )
      .map((r) => r.sourceKey),
  );
  for (const node of nodes)
    for (const comment of model.commentRecords)
      if (
        comment.anchorId === node.sourceKey ||
        node.members.some((m) => m.id === comment.anchorId)
      )
        recordKeys.add(comment.id);
  return {
    records: model.sourceDocument.records
      .filter((r) => recordKeys.has(r.sourceKey))
      .map((r) => ({ id: r.sourceKey, kind: r.kind, label: r.raw.trim() })),
    attachedNotes: model.notes
      .filter((n) => n.classId && ids.has(n.classId))
      .map((n) => n.id),
  };
}
export function deleteClasses(
  model: MermaidClassModel,
  keys: readonly string[],
  notes: "keep-free" | "delete" | undefined,
  options: ClassWriteOptions = {},
) {
  const nodes = model.nodes.filter(
      (n) =>
        n.kind === "class" &&
        (keys.includes(n.sourceKey) || keys.includes(n.id)),
    ),
    ids = new Set(nodes.map((n) => n.sourceId));
  if (!nodes.length)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const impact = classDeleteImpact(model, keys);
  if (impact.attachedNotes.length && !notes)
    return {
      ...classNoChange(model, "invalid", messages.classNotesStrategy()),
      impact,
    };
  const removed = new Set<string>(),
    patches: ClassPatch[] = [];
  const remove = (record: NonNullable<ReturnType<typeof classRecord>>) => {
    if (removed.has(record.sourceKey)) return;
    const close = record.closeKey
      ? classRecord(model, record.closeKey)
      : undefined;
    const end = classRecordEnd(close ?? record);
    for (const r of model.sourceDocument.records)
      if (r.range.start >= record.range.start && r.range.start < end)
        removed.add(r.sourceKey);
    patches.push({ range: { start: record.range.start, end }, value: "" });
  };
  for (const record of model.sourceDocument.records) {
    if (removed.has(record.sourceKey) || record.kind === "style-definition")
      continue;
    const refs = record.references.filter(
      (r) => r.kind === "class" && ids.has(r.id),
    );
    if (record.kind === "note" && refs.length && notes === "keep-free") {
      const text = record.values.text!;
      patches.push({
        range: {
          start: record.range.start + record.indent.length,
          end: text.start - 1,
        },
        value: "note ",
      });
      continue;
    }
    if (
      (record.kind === "style" || record.kind === "style-assignment") &&
      refs.length
    ) {
      const remaining = record.references.filter(
        (r) => r.kind === "class" && !ids.has(r.id),
      );
      if (remaining.length)
        patches.push({
          range: record.values.targets!,
          value: remaining
            .map((r) =>
              model.sourceDocument.source.slice(r.range.start, r.range.end),
            )
            .join(","),
        });
      else remove(record);
      continue;
    }
    const relation = model.relations.find((r) => r.id === record.sourceKey);
    const refersClass = relation
      ? (ids.has(relation.fromSourceId) &&
          !(
            relation.fromMarker === "lollipop" && relation.toMarker === "none"
          )) ||
        (ids.has(relation.toSourceId) &&
          !(relation.toMarker === "lollipop" && relation.fromMarker === "none"))
      : refs.length > 0;
    if (refersClass || (record.ownerId && ids.has(record.ownerId)))
      remove(record);
  }
  for (const c of model.commentRecords)
    if (
      nodes.some(
        (n) =>
          c.anchorId === n.sourceKey ||
          n.members.some((m) => m.id === c.anchorId),
      ) ||
      (c.anchorId && removed.has(c.anchorId))
    ) {
      const r = classRecord(model, c.id);
      if (r) remove(r);
    }
  return writeClassPatches(model, patches, { ...options, removed, impact });
}

export function addClassAnnotation(
  model: MermaidClassModel,
  key: string,
  annotation: string,
  options: ClassWriteOptions = {},
) {
  const node = model.nodes.find(
    (n) => n.sourceKey === key && n.kind === "class",
  );
  if (!node || !annotation.trim() || /[<>\r\n]/.test(annotation))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  return writeClassPatches(
    model,
    [
      classNewRecordPatch(
        model,
        model.sourceDocument.source.length,
        `<<${annotation}>> ${sourceMermaidClassName(node.sourceId)}`,
      ),
    ],
    { ...options, selection: key },
  );
}
export function editClassAnnotation(
  model: MermaidClassModel,
  key: string,
  annotation: string | undefined,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key),
    range = record?.values.annotation;
  if (
    !record ||
    !range ||
    (annotation !== undefined &&
      (!annotation.trim() || /[<>\r\n]/.test(annotation)))
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const whole = record.kind === "annotation";
  return writeClassPatches(
    model,
    [
      {
        range:
          annotation !== undefined
            ? range
            : whole
              ? { start: record.range.start, end: classRecordEnd(record) }
              : { start: range.start - 2, end: range.end + 2 },
        value: annotation ?? "",
      },
    ],
    {
      ...options,
      removed: whole && annotation === undefined ? new Set([key]) : undefined,
    },
  );
}
