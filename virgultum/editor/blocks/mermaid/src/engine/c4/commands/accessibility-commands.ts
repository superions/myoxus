// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";
import type { C4SourceRecord } from "../source-document.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import { insertC4Record } from "../record-writer.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  C4_RENDERED_CONFIG_FIELDS,
  c4ConfigHasRendererEffect,
  readC4Config,
} from "../config.js";

export const C4_ACCESSIBILITY_FORMS = [
  "accTitle:",
  "accDescr:",
  "accDescription",
  "accDescr {}",
] as const;
export type C4AccessibilityForm = (typeof C4_ACCESSIBILITY_FORMS)[number];
export function c4AccessibilityForm(
  record: C4SourceRecord,
): C4AccessibilityForm {
  return record.kind === "accessibility-title"
    ? "accTitle:"
    : /^accDescr\s*\{/.test(record.raw.trimStart())
      ? "accDescr {}"
      : record.raw.trimStart().startsWith("accDescription")
        ? "accDescription"
        : "accDescr:";
}
/** An empty native multiline block emits no setter token, retaining an earlier description. */
export function c4AccessibilityRecordHasEffect(record: C4SourceRecord) {
  return c4AccessibilityForm(record) !== "accDescr {}" || !!record.value;
}
function invalid(model: MermaidC4Model) {
  return model.sourceDocument.diagnostics.some((d) => d.severity === "error");
}
function reject(model: MermaidC4Model) {
  return c4NoChange(model, m.classPatchRejected());
}
/** Metadata cannot absorb or introduce neighbouring records through native whitespace/delimiters. */
function retainsOtherRecords(
  before: MermaidC4Model,
  after: MermaidC4Model,
  key: string,
) {
  const records = before.sourceDocument.records.filter(
      (r) => r.sourceKey !== key,
    ),
    next = after.sourceDocument.records.filter((r) => r.sourceKey !== key);
  return (
    records.length === next.length &&
    records.every(
      (r, index) =>
        r.sourceKey === next[index].sourceKey &&
        r.kind === next[index].kind &&
        r.raw === next[index].raw &&
        r.eol === next[index].eol,
    )
  );
}
export function editC4AccessibilityRecord(
  model: MermaidC4Model,
  sourceKey: string,
  value: string,
) {
  const record = model.sourceDocument.records.find(
    (r) =>
      r.sourceKey === sourceKey &&
      ["accessibility-title", "accessibility-description"].includes(r.kind),
  );
  if (!record?.valueRange || invalid(model)) return reject(model);
  if (record.value === value) return c4NoChange(model);
  const form = c4AccessibilityForm(record);
  if (
    form === "accDescr {}"
      ? value.includes("}")
      : /[\r\n]/.test(value) ||
        (form === "accDescription" && /[#;]/.test(value))
  )
    return reject(model);
  let end = record.valueRange.end,
    text = value;
  if (form === "accDescr {}") {
    const raw = model.sourceDocument.source.slice(record.valueRange.start, end);
    end -= /\s*$/.exec(raw)![0].length;
    if (!raw && value) {
      const closingPrefix = model.sourceDocument.source.slice(
        model.sourceDocument.source.lastIndexOf("\n", end - 1) + 1,
        end,
      );
      if (!closingPrefix.trim())
        text += model.sourceDocument.newline + closingPrefix;
    }
  }
  try {
    const next = writeC4Patches(model, [
      { start: record.valueRange.start, end, text },
    ]);
    const actual = next.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    );
    if (
      invalid(next.model) ||
      actual?.kind !== record.kind ||
      c4AccessibilityForm(actual) !== form ||
      actual.value !== value.trim() ||
      !retainsOtherRecords(model, next.model, sourceKey)
    )
      return reject(model);
    return c4CommandResult(model, next, sourceKey);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject(model);
  }
}
export function createC4AccessibilityRecord(
  model: MermaidC4Model,
  form: C4AccessibilityForm,
  value: string,
) {
  if (
    invalid(model) ||
    !C4_ACCESSIBILITY_FORMS.includes(form) ||
    !value.trim() ||
    (form === "accDescr {}"
      ? value.includes("}")
      : /[\r\n]/.test(value) ||
        (form === "accDescription" && /[#;]/.test(value)))
  )
    return reject(model);
  try {
    const raw =
      form === "accDescr {}"
        ? `accDescr {${model.sourceDocument.newline}${value}${model.sourceDocument.newline}}`
        : `${form} ${value}`;
    const next = insertC4Record(model, { parentKey: null }, raw);
    const added = next.model.sourceDocument.records.find(
      (r) =>
        ["accessibility-title", "accessibility-description"].includes(r.kind) &&
        !model.sourceDocument.records.some(
          (old) => old.sourceKey === r.sourceKey,
        ),
    );
    if (
      invalid(next.model) ||
      !added ||
      c4AccessibilityForm(added) !== form ||
      added.value !== value.trim()
    )
      return reject(model);
    return c4CommandResult(model, next, added.sourceKey);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject(model);
  }
}
export function editC4PreambleRecord(
  model: MermaidC4Model,
  sourceKey: string,
  raw: string,
) {
  const record = model.sourceDocument.records.find(
    (r) =>
      r.sourceKey === sourceKey &&
      ["frontmatter", "directive"].includes(r.kind),
  );
  if (!record || invalid(model)) return reject(model);
  if (raw === record.raw) return c4NoChange(model);
  try {
    const next = writeC4Patches(model, [
      { start: record.range.start, end: record.range.end, text: raw },
    ]);
    const actual = next.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    );
    if (
      invalid(next.model) ||
      actual?.kind !== record.kind ||
      actual.raw !== raw ||
      !retainsOtherRecords(model, next.model, sourceKey)
    )
      return reject(model);
    const result = c4CommandResult(model, next, sourceKey);
    const before = readC4Config(model.sourceDocument),
      after = readC4Config(next.model.sourceDocument);
    // Raw metadata and colours do not repack hand-positioned objects. Only a
    // changed native geometry consumer requests measurement and source packing.
    if (
      C4_RENDERED_CONFIG_FIELDS.some(
        (field) =>
          !field.endsWith("_color") &&
          field !== "useMaxWidth" &&
          c4ConfigHasRendererEffect(field, after.config) &&
          !Object.is(before.effective[field], after.effective[field]),
      )
    ) {
      result.reflowScopes = [
        null,
        ...next.model.boundaries.map((b) => b.resolution!.selectionId),
      ];
      result.measureContent = true;
    }
    return result;
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject(model);
  }
}
