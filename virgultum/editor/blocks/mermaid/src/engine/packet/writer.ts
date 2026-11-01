// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import type {
  MermaidPacketModel,
  MermaidPacketComment,
  MermaidPacketField,
} from "./model.js";
import {
  packetFieldRecordGroup,
  encodePacketString,
} from "./source-document.js";
import type { SourceValuePatch } from "../source-yaml.js";
import { parseMermaidPacketSource } from "./parser.js";
import { packetSourceDiagnostic } from "./diagnostics.js";
export type PacketPatch = SourceValuePatch & {
  /** Record starts relative to the replacement; moved/new records reserve these keys. */
  identities?: readonly (readonly [number, string])[];
};
export type PacketImpact = {
  fields: readonly {
    id: string;
    label: string;
    before?: Pick<MermaidPacketField, "startBit" | "endBit" | "sourceForm">;
    after?: Pick<MermaidPacketField, "startBit" | "endBit" | "sourceForm">;
    sourceFormChanged?: boolean;
  }[];
  totalWidthBefore: number;
  totalWidthAfter: number;
};
export type PacketCommandResult = {
  status: "changed" | "rejected" | "no-op";
  changed: boolean;
  source: string;
  model: MermaidPacketModel;
  patches: readonly PacketPatch[];
  reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly" | "cancelled";
  selection?: string;
  focus?: string | "add";
  remap: ReadonlyMap<string, string>;
  impact: PacketImpact;
  diagnostic?: string;
};
export type PacketWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  selection?: string;
  focus?: string | "add";
  allowConfigDiagnostics?: boolean;
  commentTransfers?: ReadonlyMap<string, string>;
  commentAnchors?: ReadonlyMap<
    string,
    {
      anchorKind: MermaidPacketComment["anchorKind"];
      anchorId?: string;
      position: MermaidPacketComment["position"];
    }
  >;
};
export function packetNoChange(
  model: MermaidPacketModel,
  reason: PacketCommandResult["reason"] = "no-change",
  diagnostic?: string,
): PacketCommandResult {
  return {
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    changed: false,
    source: model.sourceDocument.source,
    model,
    patches: [],
    reason,
    remap: new Map(),
    impact: {
      fields: [],
      totalWidthBefore: model.totalWidth,
      totalWidthAfter: model.totalWidth,
    },
    diagnostic,
  };
}
/** Draft validation is an exact Source comparison. Preview reparses a candidate, but
 * remains outside host history; only its subsequent confirmation may commit it. */
export function writePacketPatches(
  model: MermaidPacketModel,
  patches: readonly PacketPatch[],
  options: PacketWriteOptions = {},
): PacketCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return packetNoChange(model, "cancelled");
  if (options.readonly) return packetNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return packetNoChange(model, "conflict", messages.packetSourceConflict());
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>();
  const reserved = new Set<string>();
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
      return packetNoChange(model, "invalid", messages.packetPatchBounds());
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(id))
        return packetNoChange(model, "invalid", messages.packetRecordMapping());
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return packetNoChange(model);
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
  const parsed = parseMermaidPacketSource(next, model, mapping);
  if (
    !parsed ||
    parsed.issues.length ||
    parsed.diagnostics.some(
      (issue) => issue.code !== "config" || !options.allowConfigDiagnostics,
    )
  )
    return packetNoChange(
      model,
      "invalid",
      parsed
        ? (packetSourceDiagnostic(parsed) ?? undefined)
        : messages.packetParseRejected(),
    );
  const parsedKeys = new Set(
    parsed.sourceDocument.records.map((record) => record.sourceKey),
  );
  const parsedComments = new Map(
    (parsed.comments ?? []).map((comment) => [comment.id, comment]),
  );
  for (const record of model.sourceDocument.records) {
    if (options.removed?.has(record.sourceKey)) continue;
    if (!parsedKeys.has(record.sourceKey))
      return packetNoChange(model, "invalid", messages.packetRecordLoss());
  }
  for (const comment of model.comments ?? []) {
    if (options.removed?.has(comment.id)) continue;
    const retained = parsedComments.get(comment.id);
    const transfer = options.commentTransfers?.get(comment.id);
    if (transfer) {
      if (
        !retained ||
        retained.text !== comment.text ||
        !(
          (retained.anchorKind === "field" && retained.anchorId === transfer) ||
          (retained.anchorKind === "diagram" &&
            retained.affinity === "position")
        )
      )
        return packetNoChange(
          model,
          "invalid",
          messages.packetCommentTransfer(),
        );
      continue;
    }
    const expected = options.commentAnchors?.get(comment.id) ?? comment;
    if (
      !retained ||
      retained.anchorKind !== expected.anchorKind ||
      retained.anchorId !== expected.anchorId ||
      retained.position !== expected.position
    )
      return packetNoChange(model, "invalid", messages.packetCommentDetach());
  }
  const remap = new Map<string, string>();
  for (const record of model.sourceDocument.records) {
    if (options.removed?.has(record.sourceKey)) continue;
    if (parsedKeys.has(record.sourceKey))
      remap.set(record.sourceKey, record.sourceKey);
  }
  const before = new Map(model.fields.map((f) => [f.id, f]));
  const after = new Map(parsed.fields.map((f) => [f.id, f]));
  const fields: PacketImpact["fields"][number][] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id),
      b = after.get(id);
    if (
      a &&
      b &&
      a.startBit === b.startBit &&
      a.endBit === b.endBit &&
      a.label === b.label &&
      a.order === b.order &&
      a.sourceForm === b.sourceForm
    )
      continue;
    fields.push({
      id,
      label: b?.label ?? a!.label,
      before: a
        ? { startBit: a.startBit, endBit: a.endBit, sourceForm: a.sourceForm }
        : undefined,
      after: b
        ? { startBit: b.startBit, endBit: b.endBit, sourceForm: b.sourceForm }
        : undefined,
      sourceFormChanged: Boolean(a && b && a.sourceForm !== b.sourceForm),
    });
  }
  return {
    status: "changed",
    changed: true,
    source: next,
    model: parsed,
    patches: sorted,
    reason: "applied",
    selection: options.selection,
    focus: options.focus,
    remap,
    impact: {
      fields,
      totalWidthBefore: model.totalWidth,
      totalWidthAfter: parsed.totalWidth,
    },
  };
}
export function packetQuotedLabel(label: string, quote: "'" | '"' = '"') {
  const value = encodePacketString(label).slice(1, -1).replaceAll('\\"', '"');
  return quote + value.replaceAll(quote, "\\" + quote) + quote;
}
export function packetFieldNumberPatches(
  field: MermaidPacketField,
  startBit: number,
  endBit: number,
  sourceForm = field.sourceForm,
): PacketPatch[] | null {
  if (!field.numberRange || !field.startRange) return null;
  const width = endBit - startBit + 1;
  if (sourceForm === "single" && width !== 1) sourceForm = "range";
  if (sourceForm === field.sourceForm) {
    if (sourceForm === "count")
      return field.width === width
        ? []
        : [{ range: field.startRange, value: String(width) }];
    const patches: PacketPatch[] = [];
    if (field.startBit !== startBit)
      patches.push({ range: field.startRange, value: String(startBit) });
    if (sourceForm === "range" && field.endRange && field.endBit !== endBit)
      patches.push({ range: field.endRange, value: String(endBit) });
    return patches;
  }
  return [
    {
      range: field.numberRange,
      value:
        sourceForm === "count"
          ? `+${width}`
          : sourceForm === "single"
            ? String(startBit)
            : `${startBit}-${endBit}`,
    },
  ];
}

/** Assemble a moved record unit without normalizing its trivia. Number edits are
 * the only semantic rewrites; destination EOF may require one line separator. */
export function packetFieldGroupReplacement(
  model: MermaidPacketModel,
  fieldKey: string,
  startBit: number,
  endBit: number,
  destination: { start: number; end: number },
  edit?: { label: string; sourceForm: "range" | "count"; fieldKey: string },
): PacketPatch | null {
  const group = packetFieldRecordGroup(model, fieldKey);
  if (!group) return null;
  const numbers = packetFieldNumberPatches(
    group.field,
    startBit,
    endBit,
    edit?.sourceForm,
  );
  if (!numbers) return null;
  const labelPatch =
    edit && edit.label !== group.field.label && group.field.labelRange
      ? [
          {
            range: group.field.labelRange,
            value: packetQuotedLabel(edit.label, group.field.quote),
          },
        ]
      : [];
  const sorted = [...numbers, ...labelPatch].sort(
    (a, b) => a.range.start - b.range.start,
  );
  let text = "",
    cursor = group.range.start;
  for (const p of sorted) {
    text += model.sourceDocument.source.slice(cursor, p.range.start) + p.value;
    cursor = p.range.end;
  }
  text += model.sourceDocument.source.slice(cursor, group.range.end);
  const identities: [number, string][] = [];
  for (const r of group.records) {
    let offset = r.range.start - group.range.start;
    for (const p of sorted) {
      if (p.range.start >= r.range.start) break;
      offset += p.value.length - (p.range.end - p.range.start);
    }
    identities.push([
      offset,
      edit && r.sourceKey === fieldKey ? edit.fieldKey : r.sourceKey,
    ]);
  }
  const source = model.sourceDocument.source;
  const needsSeparator =
    destination.end < source.length || /[\r\n]$/.test(source);
  if (needsSeparator && !/[\r\n]$/.test(text))
    text += model.sourceDocument.newline;
  // A trailing object comment needs a blank separator before the next statement;
  // otherwise a cold parse would reinterpret it as that next object's leading comment.
  const afterComment = (model.comments ?? []).some(
    (comment) => comment.anchorId === fieldKey && comment.position === "after",
  );
  if (
    afterComment &&
    destination.end < source.length &&
    !/^[\r\n]/.test(source.slice(destination.end))
  )
    text += model.sourceDocument.newline;
  if (!needsSeparator) text = text.replace(/(?:\r\n|\r|\n)$/, "");
  return { range: destination, value: text, identities };
}

export function packetNewFieldPatch(
  model: MermaidPacketModel,
  offset: number,
  field: {
    startBit: number;
    endBit: number;
    label: string;
    sourceForm: "range" | "count";
    fieldKey: string;
    indent: string;
  },
): PacketPatch {
  const source = model.sourceDocument.source,
    newline = model.sourceDocument.newline;
  let prefix = offset > 0 && !/[\r\n]/.test(source[offset - 1]!) ? newline : "";
  const prior = model.sourceDocument.records.findLast(
    (r) => r.range.end + r.eol.length <= offset && r.kind !== "blank",
  );
  if (
    prior?.kind === "comment" &&
    offset === prior.range.end + prior.eol.length
  )
    prefix += newline;
  const suffix =
    offset < source.length || /[\r\n]$/.test(source) ? newline : "";
  const number =
    field.sourceForm === "count"
      ? `+${field.endBit - field.startBit + 1}`
      : `${field.startBit}-${field.endBit}`;
  return {
    range: { start: offset, end: offset },
    value: `${prefix}${field.indent}${number}: ${packetQuotedLabel(field.label)}${suffix}`,
    identities: [[prefix.length, field.fieldKey]],
  };
}
