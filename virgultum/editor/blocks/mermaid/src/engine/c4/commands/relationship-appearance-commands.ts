// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Argument, MermaidC4Model } from "../model.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import {
  c4CallPatch,
  c4RecordDeletionPatches,
  insertC4StyleUpdate,
} from "../record-writer.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export const C4_RELATIONSHIP_APPEARANCE_FIELDS = [
  "textColor",
  "lineColor",
  "offsetX",
  "offsetY",
] as const;
export type C4RelationshipAppearance = {
  textColor: string;
  lineColor: string;
  offsetX: number;
  offsetY: number;
};
import { C4_CALLS, c4RelationshipLabelOffset } from "../runtime-contract.js";
export function readC4RelationshipAppearance(
  model: MermaidC4Model,
  selectionId: string,
): C4RelationshipAppearance {
  const fields =
    model.relationships.find((r) => r.resolution!.selectionId === selectionId)
      ?.resolution!.fields ?? {};
  return {
    textColor: typeof fields.textColor === "string" ? fields.textColor : "",
    lineColor: typeof fields.lineColor === "string" ? fields.lineColor : "",
    offsetX: c4RelationshipLabelOffset(fields.offsetX),
    offsetY: c4RelationshipLabelOffset(fields.offsetY),
  };
}
export function c4RelationshipStyleRecords(
  model: MermaidC4Model,
  selectionId: string,
) {
  const owner = model.relationships.find(
    (r) => r.resolution!.selectionId === selectionId,
  );
  if (!owner) return [];
  const pairs = [
    [owner.from, owner.to],
    ...model.sourceDocument.records
      .filter((r) => owner.resolution!.sourceKeys.includes(r.sourceKey))
      .map((r) => [
        r.arguments![C4_CALLS[r.callKind!].slots.indexOf("from")].value,
        r.arguments![C4_CALLS[r.callKind!].slots.indexOf("to")].value,
      ]),
  ];
  return model.sourceDocument.records.filter(
    (r) =>
      r.kind === "relationship-update" &&
      (model.occurrences.some(
        (o) => o.sourceKey === r.sourceKey && o.selectionId === selectionId,
      ) ||
        pairs.some(
          ([from, to]) =>
            r.arguments![0].value === from && r.arguments![1].value === to,
        )),
  );
}
/** Only changed effective offsets are written; opening/applying a raw parseInt form preserves its bytes. */
export function editC4RelationshipAppearance(
  model: MermaidC4Model,
  selectionId: string,
  values: Readonly<Partial<C4RelationshipAppearance>>,
) {
  const owner = model.relationships.find(
      (r) => r.resolution!.selectionId === selectionId,
    ),
    current = readC4RelationshipAppearance(model, selectionId);
  if (
    !owner ||
    Object.entries(values).some(
      ([key, value]) =>
        !Object.hasOwn(current, key) ||
        (["offsetX", "offsetY"].includes(key)
          ? typeof value !== "number" || !Number.isSafeInteger(value)
          : typeof value !== "string"),
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  const calls = new Map<string, MermaidC4Argument[]>(),
    colors: MermaidC4Argument[] = [],
    offsets: MermaidC4Argument[] = [];
  for (const field of [
    "textColor",
    "lineColor",
    "offsetX",
    "offsetY",
  ] as const) {
    const value = values[field];
    if (value === undefined || current[field] === value) continue;
    const unusable = ["textColor", "lineColor"].includes(field)
      ? typeof owner.resolution!.fields[field] !== "string"
      : typeof owner.resolution!.fields[field] === "object";
    const provider = unusable ? undefined : owner.resolution!.providers[field],
      record = model.sourceDocument.records.find(
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
        value: String(value),
      };
      calls.set(record.sourceKey, args);
    } else
      (typeof value === "number" ? offsets : colors).push({
        key: field,
        value: String(value),
      });
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
    const pair = [
      { key: "", value: owner.from },
      { key: "", value: owner.to },
    ];
    if (colors.length)
      next = insertC4StyleUpdate(next.model, "UpdateRelStyle", [
        ...pair,
        ...colors,
      ]);
    // Named string slots preserve unrelated colours/offsets; svgDraw performs the native integer coercion.
    if (offsets.length)
      next = insertC4StyleUpdate(next.model, "UpdateRelStyle", [
        ...pair,
        ...offsets,
      ]);
    return c4CommandResult(model, next, selectionId);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export function editC4RelationshipStyleArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
) {
  const record = c4RelationshipStyleRecords(model, selectionId).find(
    (r) => r.sourceKey === sourceKey,
  );
  if (
    !record?.arguments ||
    !Number.isInteger(index) ||
    index < 2 ||
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
        c4CallPatch(model, sourceKey, "UpdateRelStyle", args),
      ]),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export function removeC4RelationshipStyleRecord(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (
    !c4RelationshipStyleRecords(model, selectionId).some(
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

export function c4RelationshipStyleArgumentEffect(
  model: MermaidC4Model,
  sourceKey: string,
  index: number,
) {
  const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey && r.kind === "relationship-update",
    ),
    occurrence = model.occurrences.find((o) => o.sourceKey === sourceKey),
    argument = record?.arguments?.[index],
    slot = C4_CALLS.UpdateRelStyle.slots[index];
  if (!argument || !slot || index < 2 || !occurrence?.applied) return false;
  const field = argument.key || argument.named ? argument.key : slot;
  return (
    occurrence.effectiveFields.includes(field) &&
    [
      "textColor",
      "lineColor",
      "offsetX",
      "offsetY",
      "from",
      "to",
      "type",
      "label",
      "techn",
      "descr",
    ].includes(field)
  );
}
