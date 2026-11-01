// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Argument, MermaidC4Model } from "../model.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import {
  c4CallPatch,
  c4RecordDeletionPatches,
  insertC4StyleUpdate,
} from "../record-writer.js";
import { C4_CALLS, C4_SHAPE_KEYWORDS } from "../runtime-contract.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export const C4_ELEMENT_APPEARANCE_FIELDS = [
  "bgColor",
  "fontColor",
  "borderColor",
  "shadowing",
  "shape",
  "sprite",
  "techn",
  "legendText",
  "legendSprite",
] as const;
export type C4ElementAppearanceField =
  (typeof C4_ELEMENT_APPEARANCE_FIELDS)[number];
function owner(model: MermaidC4Model, selectionId: string) {
  return [...model.elements, ...model.boundaries].find(
    (e) => e.resolution!.selectionId === selectionId,
  );
}
/** Include targetable early updates without pretending they were applied retroactively. */
export function c4ElementStyleRecords(
  model: MermaidC4Model,
  selectionId: string,
) {
  const value = owner(model, selectionId);
  if (!value) return [];
  const aliases = new Set([
    value.alias,
    ...model.sourceDocument.records
      .filter((r) => value.resolution!.sourceKeys.includes(r.sourceKey))
      .map((r) => r.arguments![0].value),
  ]);
  return model.sourceDocument.records.filter(
    (r) =>
      r.kind === "element-update" &&
      (model.occurrences.some(
        (o) => o.sourceKey === r.sourceKey && o.selectionId === selectionId,
      ) ||
        aliases.has(r.arguments![0].value)),
  );
}
/** Provider mode edits the actual argument. Append mode intentionally creates a later native update. */
export function editC4ElementAppearance(
  model: MermaidC4Model,
  selectionId: string,
  values: Readonly<Partial<Record<C4ElementAppearanceField, string>>>,
  mode: "provider" | "append" = "provider",
) {
  const value = owner(model, selectionId);
  if (
    !value ||
    !["provider", "append"].includes(mode) ||
    Object.entries(values).some(
      ([field, v]) =>
        !C4_ELEMENT_APPEARANCE_FIELDS.some((f) => f === field) ||
        typeof v !== "string",
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  const calls = new Map<string, MermaidC4Argument[]>(),
    added: MermaidC4Argument[] = [];
  for (const [field, text] of Object.entries(values)) {
    if (mode === "provider" && value.resolution!.fields[field] === text)
      continue;
    const usable =
      !["bgColor", "fontColor", "borderColor", "shape", "sprite"].includes(
        field,
      ) || typeof value.resolution!.fields[field] === "string";
    const provider =
      mode === "provider" && usable
        ? value.resolution!.providers[field]
        : undefined;
    const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === provider?.sourceKey,
    );
    if (
      record?.arguments &&
      provider?.argumentIndex !== undefined &&
      provider.form !== "omitted" &&
      record.arguments[provider.argumentIndex]
    ) {
      const args =
        calls.get(record.sourceKey) ?? record.arguments.map((a) => ({ ...a }));
      args[provider.argumentIndex] = {
        ...args[provider.argumentIndex],
        value: text,
      };
      calls.set(record.sourceKey, args);
    } else added.push({ key: field, value: text });
  }
  try {
    let next = writeC4Patches(
      model,
      [...calls].map(([key, args]) =>
        c4CallPatch(
          model,
          key,
          model.sourceDocument.records.find((r) => r.sourceKey === key)!
            .callKind!,
          args,
        ),
      ),
    );
    if (added.length)
      next = insertC4StyleUpdate(next.model, "UpdateElementStyle", [
        { key: "", value: owner(next.model, selectionId)!.alias },
        ...added,
      ]);
    return c4CommandResult(model, next, selectionId);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export function editC4ElementStyleArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
) {
  const record = c4ElementStyleRecords(model, selectionId).find(
    (r) => r.sourceKey === sourceKey,
  );
  if (
    !record?.arguments ||
    !Number.isInteger(index) ||
    index < 1 ||
    index >= record.arguments.length
  )
    return c4NoChange(model, m.classPatchRejected());
  if (JSON.stringify(record.arguments[index]) === JSON.stringify(argument))
    return c4NoChange(model);
  const args = record.arguments.map((a) => ({ ...a }));
  args[index] = { ...argument };
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, [
        c4CallPatch(model, sourceKey, "UpdateElementStyle", args),
      ]),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
/** Delete exactly one update record. Its comments and all earlier updates remain Source-owned. */
export function removeC4ElementStyleRecord(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (
    !c4ElementStyleRecords(model, selectionId).some(
      (r) => r.sourceKey === sourceKey,
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, c4RecordDeletionPatches(model, [sourceKey])),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}

/** Native boundaries reserve an image area for a sprite but draw no sprite image.
 * Shape overrides, legends and shadowing do not have a native boundary/body renderer. */
export function c4ElementStyleArgumentEffect(
  model: MermaidC4Model,
  sourceKey: string,
  index: number,
): "content" | "spacing" | "technology" | "stored" {
  const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey && r.kind === "element-update",
    ),
    occurrence = model.occurrences.find((o) => o.sourceKey === sourceKey);
  const argument = record?.arguments?.[index],
    slot = C4_CALLS.UpdateElementStyle.slots[index];
  if (!argument || !slot || index < 1 || !occurrence?.applied) return "stored";
  const field = argument.key || argument.named ? argument.key : slot;
  if (!occurrence.effectiveFields.includes(field)) return "stored";
  const boundary = model.boundaries.find(
    (b) => b.resolution!.selectionId === occurrence.selectionId,
  );
  if (field === "sprite" && boundary)
    return argument.value ? "spacing" : "stored";
  if (field === "techn" && !boundary) return "technology";
  if (field === "shape" || field === "sprite")
    return !boundary &&
      C4_SHAPE_KEYWORDS.some((k) => k === argument.value.toLowerCase())
      ? "content"
      : "stored";
  const fields = boundary
    ? [
        "bgColor",
        "fontColor",
        "borderColor",
        "label",
        "type",
        "descr",
        "alias",
        "parentBoundary",
        "nodeType",
        "wrap",
      ]
    : [
        "bgColor",
        "fontColor",
        "borderColor",
        "label",
        "descr",
        "tags",
        "typeC4Shape",
        "alias",
        "parentBoundary",
      ];
  return fields.includes(field) ? "content" : "stored";
}
