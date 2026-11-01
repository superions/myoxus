// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidClassModel } from "../model.js";
import {
  nextClassSourceKey,
  sourceMermaidClassName,
} from "../source-document.js";
import {
  classNoChange,
  classRecord,
  classRecordGroup,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
} from "../writer.js";
import { classQuotedText } from "./class-commands.js";
import { namespaceRecord } from "./namespace-commands.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export function addClassNote(
  model: MermaidClassModel,
  value: { text: string; classId?: string | null; namespaceId?: string | null },
  options: ClassWriteOptions = {},
) {
  if (
    value.classId &&
    !model.nodes.some((n) => n.kind === "class" && n.sourceId === value.classId)
  )
    return classNoChange(model, "invalid", messages.classMissingObject());
  const namespace = value.namespaceId
      ? namespaceRecord(model, value.namespaceId)
      : undefined,
    close = namespace?.closeKey
      ? classRecord(model, namespace.closeKey)
      : undefined,
    key = nextClassSourceKey();
  const text = `${namespace ? namespace.indent + "  " : ""}note${value.classId ? ` for ${sourceMermaidClassName(value.classId)}` : ""} "${classQuotedText(value.text)}"`;
  return writeClassPatches(
    model,
    [
      classNewRecordPatch(
        model,
        close?.range.start ?? model.sourceDocument.source.length,
        text,
        key,
      ),
    ],
    { ...options, selection: key },
  );
}
export function editClassNote(
  model: MermaidClassModel,
  key: string,
  value: { text?: string; classId?: string | null },
  options: ClassWriteOptions = {},
) {
  const note = model.notes.find((n) => n.id === key),
    record = classRecord(model, key);
  if (!note || !record)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const patches: ClassPatch[] = [];
  if (value.text !== undefined && value.text !== note.text)
    patches.push({
      range: record.values.text!,
      value: classQuotedText(
        value.text.includes("\n") && note.text.includes("<br/>")
          ? value.text.replaceAll(/\r?\n/g, "<br/>")
          : value.text.includes("\n") && note.text.includes("\\n")
            ? value.text.replaceAll(/\r?\n/g, "\\n")
            : value.text,
      ),
    });
  if (Object.hasOwn(value, "classId") && value.classId !== note.classId) {
    if (
      value.classId &&
      !model.nodes.some(
        (n) => n.kind === "class" && n.sourceId === value.classId,
      )
    )
      return classNoChange(model, "invalid", messages.classMissingObject());
    const start = record.range.start + record.indent.length,
      end = record.values.text!.start - 1;
    patches.push({
      range: { start, end },
      value: `note${value.classId ? ` for ${sourceMermaidClassName(value.classId)}` : ""} `,
    });
  }
  return writeClassPatches(model, patches, { ...options, selection: key });
}
export function deleteClassNote(
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
