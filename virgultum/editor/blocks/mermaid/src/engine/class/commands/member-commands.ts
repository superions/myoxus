// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidClassModel, MermaidClassMember } from "../model.js";
import {
  nextClassSourceKey,
  sourceMermaidClassName,
} from "../source-document.js";
import {
  classNoChange,
  classRecord,
  classRecordEnd,
  classRecordGroup,
  classMoveRecords,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
} from "../writer.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export type ClassMemberChanges = Partial<
  Pick<
    MermaidClassMember,
    | "raw"
    | "kind"
    | "visibility"
    | "name"
    | "type"
    | "parameters"
    | "returnType"
    | "classifier"
  >
>;
export function classMemberSignature(value: ClassMemberChanges) {
  if (value.raw !== undefined) return value.raw;
  return `${value.visibility ?? ""}${value.name ?? ""}${value.kind === "operation" ? `(${value.parameters ?? ""})${value.returnType ? " " + value.returnType : ""}` : value.type ? ": " + value.type : ""}${value.classifier === "static" ? "$" : value.classifier === "abstract" ? "*" : ""}`;
}
/** Preserve the signature and its comments when a short-form edit needs a block,
 * or a reorder crosses the lexical block boundary. */
function memberBlockUnit(
  model: MermaidClassModel,
  member: MermaidClassMember,
  signature: string,
  wrap: boolean,
): { value: string; identities: (readonly [number, string])[] } {
  const group = classRecordGroup(model, member.id)!;
  const newline = model.sourceDocument.newline;
  let value = wrap
    ? `class ${sourceMermaidClassName(member.classId)} {${newline}`
    : "";
  const identities: (readonly [number, string])[] = [];
  if (wrap) identities.push([0, nextClassSourceKey()]);
  let cursor = group.range.start;
  for (const record of group.records) {
    value += model.sourceDocument.source.slice(cursor, record.range.start);
    identities.push([value.length, record.sourceKey]);
    value +=
      record.sourceKey === member.id
        ? `${record.indent}${signature}${record.eol}`
        : `${record.raw}${record.eol}`;
    cursor = classRecordEnd(record);
  }
  if (wrap) value += `${/[\r\n]$/.test(value) ? "" : newline}}${newline}`;
  return { value, identities };
}
export function editClassMember(
  model: MermaidClassModel,
  key: string,
  changes: ClassMemberChanges,
  options: ClassWriteOptions = {},
) {
  const member = model.nodes
      .flatMap((n) => n.members)
      .find((m) => m.id === key),
    record = classRecord(model, key);
  if (!member || !record || !member.range)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const patches: ClassPatch[] = [];
  if (
    changes.raw !== undefined ||
    (changes.kind !== undefined && changes.kind !== member.kind)
  ) {
    const kind = changes.kind ?? member.kind;
    const raw =
      changes.raw ??
      `${changes.visibility ?? member.visibility}${changes.name ?? member.name}${kind === "operation" ? `(${changes.parameters ?? member.parameters})${(changes.returnType ?? member.returnType) ? " " + (changes.returnType ?? member.returnType) : ""}` : (changes.type ?? member.type) ? ": " + (changes.type ?? member.type) : ""}${(changes.classifier ?? member.classifier) === "static" ? "$" : (changes.classifier ?? member.classifier) === "abstract" ? "*" : ""}`;
    if (!raw.trim() || /[\r\n{}]/.test(raw))
      return classNoChange(model, "invalid", messages.classPatchRejected());
    patches.push({ range: member.range, value: raw });
  } else {
    if (!member.precise)
      return classNoChange(model, "invalid", messages.classPatchRejected());
    for (const field of [
      "visibility",
      "name",
      "type",
      "parameters",
      "returnType",
      "classifier",
    ] as const) {
      if (!Object.hasOwn(changes, field) || changes[field] === member[field])
        continue;
      const value = changes[field]!;
      if (/[\r\n{}]/.test(value))
        return classNoChange(model, "invalid", messages.classPatchRejected());
      const range = member.ranges[field];
      const encoded =
        field === "classifier"
          ? value === "static"
            ? "$"
            : value === "abstract"
              ? "*"
              : ""
          : value;
      if (range) patches.push({ range, value: encoded });
      else if (field === "visibility")
        patches.push({
          range: { start: member.range.start, end: member.range.start },
          value: encoded,
        });
      else if (field === "type" && member.kind === "attribute") {
        const end = member.ranges.classifier?.start ?? member.range.end;
        patches.push({
          range: { start: end, end },
          value: value ? `: ${value}` : "",
        });
      } else if (field === "returnType" && member.kind === "operation") {
        const end = member.ranges.classifier?.start ?? member.range.end;
        patches.push({
          range: { start: end, end },
          value: value ? ` ${value}` : "",
        });
      } else if (field === "classifier")
        patches.push({
          range: { start: member.range.end, end: member.range.end },
          value: encoded,
        });
      else
        return classNoChange(model, "invalid", messages.classPatchRejected());
    }
  }
  if (member.sourceForm === "short") {
    let signature = member.raw;
    for (const patch of [...patches].sort(
      (a, b) => b.range.start - a.range.start,
    ))
      signature =
        signature.slice(0, patch.range.start - member.range.start) +
        patch.value +
        signature.slice(patch.range.end - member.range.start);
    if (/[:;]/.test(signature)) {
      const group = classRecordGroup(model, key)!;
      const unit = memberBlockUnit(model, member, signature, true);
      return writeClassPatches(model, [{ range: group.range, ...unit }], {
        ...options,
        selection: key,
        focus: key,
      });
    }
  }
  return writeClassPatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export function addClassMember(
  model: MermaidClassModel,
  classKey: string,
  value: string | ClassMemberChanges,
  options: ClassWriteOptions = {},
  before?: string,
) {
  const raw = typeof value === "string" ? value : classMemberSignature(value);
  const node = model.nodes.find(
    (n) => n.sourceKey === classKey || n.id === classKey,
  );
  if (!node || node.kind !== "class" || !raw.trim() || /[\r\n{}]/.test(raw))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const key = nextClassSourceKey(),
    target = before ? classRecord(model, before) : undefined;
  if (
    target &&
    (!node.members.some((m) => m.id === before) ||
      target.ownerId !== node.sourceId)
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const opening = model.sourceDocument.records.find(
    (r) => r.kind === "class" && r.ownerId === node.sourceId && r.closeKey,
  );
  const closing = opening?.closeKey
    ? classRecord(model, opening.closeKey)
    : undefined;
  if (!closing && !target) {
    // Short-form labels stop at a colon in Mermaid's lexer. A block supports
    // the complete native signature, including typed operation parameters.
    const declaration = model.sourceDocument.records.find(
      (r) => r.kind === "class" && r.ownerId === node.sourceId && !r.closeKey,
    );
    const newline = model.sourceDocument.newline;
    if (declaration) {
      const prefix = `${declaration.raw} {${newline}${declaration.indent}  `;
      return writeClassPatches(
        model,
        [
          {
            range: declaration.range,
            value: `${prefix}${raw}${newline}${declaration.indent}}`,
            identities: [
              [0, declaration.sourceKey],
              [prefix.length - declaration.indent.length - 2, key],
            ],
          },
        ],
        { ...options, selection: key, focus: key },
      );
    }
    const prefix = `class ${sourceMermaidClassName(node.sourceId)} {${newline}  `;
    const patch = classNewRecordPatch(
      model,
      model.sourceDocument.source.length,
      `${prefix}${raw}${newline}}`,
    );
    const prefixOffset = patch.value.indexOf(prefix);
    return writeClassPatches(
      model,
      [{ ...patch, identities: [[prefixOffset + prefix.length - 2, key]] }],
      { ...options, selection: key, focus: key },
    );
  }
  const offset =
    (before ? classRecordGroup(model, before)?.range.start : undefined) ??
    closing?.range.start ??
    model.sourceDocument.source.length;
  const targetMember = node.members.find((m) => m.id === before);
  const inBlock = targetMember
    ? targetMember.sourceForm === "block"
    : Boolean(closing);
  if (!inBlock && /[:;]/.test(raw)) {
    const prefix = `class ${sourceMermaidClassName(node.sourceId)} {${model.sourceDocument.newline}`;
    const patch = classNewRecordPatch(
      model,
      offset,
      `${prefix}${raw}${model.sourceDocument.newline}}`,
      nextClassSourceKey(),
    );
    const recordOffset = patch.identities![0]![0] + prefix.length;
    return writeClassPatches(
      model,
      [{ ...patch, identities: [...patch.identities!, [recordOffset, key]] }],
      { ...options, selection: key, focus: key },
    );
  }
  const text = inBlock
    ? `${target?.indent ?? opening!.indent + "  "}${raw}`
    : `${sourceMermaidClassName(node.sourceId)} : ${raw}`;
  return writeClassPatches(
    model,
    [classNewRecordPatch(model, offset, text, key)],
    { ...options, selection: key, focus: key },
  );
}
export function deleteClassMember(
  model: MermaidClassModel,
  key: string,
  options: ClassWriteOptions = {},
) {
  const group = classRecordGroup(model, key);
  if (!group)
    return classNoChange(model, "invalid", messages.classMissingObject());
  return writeClassPatches(model, [{ range: group.range, value: "" }], {
    ...options,
    removed: new Set(group.records.map((r) => r.sourceKey)),
    impact: {
      records: group.records.map((r) => ({
        id: r.sourceKey,
        kind: r.kind,
        label: r.raw.trim(),
      })),
      attachedNotes: [],
    },
  });
}
export function duplicateClassMember(
  model: MermaidClassModel,
  key: string,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key),
    member = model.nodes.flatMap((n) => n.members).find((m) => m.id === key);
  if (!record || !member)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const id = nextClassSourceKey();
  return writeClassPatches(
    model,
    [
      classNewRecordPatch(
        model,
        classRecordGroup(model, key)?.range.end ?? classRecordEnd(record),
        record.raw,
        id,
      ),
    ],
    { ...options, selection: id, focus: id },
  );
}
export function reorderClassMember(
  model: MermaidClassModel,
  key: string,
  before: string | undefined,
  options: ClassWriteOptions = {},
) {
  const node = model.nodes.find((n) => n.members.some((m) => m.id === key));
  const member = node?.members.find((m) => m.id === key),
    target = before ? node?.members.find((m) => m.id === before) : undefined;
  const group = classRecordGroup(model, key);
  if (
    !node ||
    !member ||
    !group ||
    (before && (!target || target.kind !== member.kind))
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const targetGroup = before ? classRecordGroup(model, before) : undefined;
  const opening = model.sourceDocument.records.find(
    (r) =>
      r.kind === "class" &&
      r.ownerId === node.sourceId &&
      r.closeKey &&
      r.range.start < member.range!.start &&
      classRecord(model, r.closeKey)!.range.start > member.range!.end,
  );
  const closing = opening?.closeKey
    ? classRecord(model, opening.closeKey)
    : undefined;
  const offset =
    targetGroup?.range.start ??
    (member.sourceForm === "block"
      ? closing?.range.start
      : model.sourceDocument.source.length);
  if (offset === undefined)
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const destinationBlock = target
    ? target.sourceForm === "block"
    : member.sourceForm === "block";
  if (
    (member.sourceForm === "short" && destinationBlock) ||
    (member.sourceForm === "block" && !destinationBlock)
  ) {
    const unit = memberBlockUnit(model, member, member.raw, !destinationBlock);
    const insertion = classNewRecordPatch(model, offset, unit.value, member.id);
    const prefix = insertion.identities![0]![0];
    return writeClassPatches(
      model,
      [
        { range: group.range, value: "" },
        {
          ...insertion,
          identities: unit.identities.map(([start, id]) => [
            start + prefix,
            id,
          ]),
        },
      ],
      { ...options, selection: key, focus: key },
    );
  }
  return writeClassPatches(
    model,
    classMoveRecords(model, group.records, offset),
    { ...options, selection: key, focus: key },
  );
}
