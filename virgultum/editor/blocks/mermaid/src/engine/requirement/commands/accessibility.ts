// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import { nextRequirementSourceKey } from "../source-document.js";
import {
  requirementNoChange,
  requirementRecordEnd,
  writeRequirementPatches,
  type RequirementPatch,
  type RequirementWriteOptions,
} from "../writer.js";

export type RequirementAccessibilityValues = {
  title?: string;
  description?: string;
};
/** Patch native accessibility records only. Empty edits remove all providers
 * of that metadata field so an earlier value cannot silently become effective. */
export function editRequirementAccessibility(
  model: MermaidRequirementModel,
  values: RequirementAccessibilityValues,
  options: RequirementWriteOptions = {},
) {
  const document = model.sourceDocument;
  if (!document) return requirementNoChange(model, "invalid");
  const patches: RequirementPatch[] = [],
    removed = new Set<string>();
  const normalize = (text: string) => text.replace(/\r\n|\r/g, "\n").trim();
  for (const [field, kind, prefix, current] of [
    ["title", "accessibility-title", "accTitle", model.accTitle],
    ["description", "accessibility-description", "accDescr", model.accDescr],
  ] as const) {
    if (values[field] === undefined) continue;
    const text = normalize(values[field]!);
    if (text === normalize(current ?? "")) continue;
    if (
      (field === "title" && text.includes("\n")) ||
      (field === "description" && text.includes("\n") && /[{}]/.test(text))
    )
      return requirementNoChange(model, "invalid");
    const records = document.records.filter((record) => record.kind === kind),
      record = records.at(-1);
    if (!text) {
      for (const record of records) {
        removed.add(record.sourceKey);
        patches.push({
          range: {
            start: record.range.start,
            end: requirementRecordEnd(record),
          },
          value: "",
        });
      }
      continue;
    }
    const raw =
      field === "description" && text.includes("\n")
        ? `${prefix} {${text.replaceAll("\n", document.newline)}}`
        : `${prefix}: ${text}`;
    if (record)
      patches.push({
        range: { start: record.range.start, end: record.range.end },
        value: record.indent + raw,
        identities: [[0, record.sourceKey]],
      });
    else {
      const header = document.records.find(
        (record) => record.kind === "header",
      );
      if (!header) return requirementNoChange(model, "invalid");
      const offset = requirementRecordEnd(header),
        prefix =
          offset > 0 && !/[\r\n]$/.test(document.source.slice(0, offset))
            ? document.newline
            : "";
      patches.push({
        range: { start: offset, end: offset },
        value: prefix + raw + document.newline,
        identities: [[prefix.length, nextRequirementSourceKey()]],
      });
    }
  }
  return writeRequirementPatches(model, patches, { ...options, removed });
}
