// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import {
  requirementNoChange,
  writeRequirementModel,
  type RequirementWriteOptions,
  writeRequirementPatches,
  requirementRecordEnd,
} from "../writer.js";
import type { RequirementPropertyName } from "../runtime-contract.js";

export const REQUIREMENT_PROPERTY_FIELDS = {
  id: "requirementId",
  text: "text",
  risk: "risk",
  verifymethod: "verifyMethod",
  type: "elementType",
  docref: "docRef",
} as const;
export type RequirementFieldWriteOptions = RequirementWriteOptions & {
  /** Remove every provider in the effective definition, never an ignored definition. */
  removeProperties?: readonly RequirementPropertyName[];
};

export type RequirementFieldValues = Partial<
  Record<
    | "name"
    | "requirementId"
    | "requirementType"
    | "risk"
    | "text"
    | "verifyMethod"
    | "elementType"
    | "docRef"
    | "kind",
    string
  >
>;

/** One form confirmation patches the effective providers in one checked write.
 * Keys are Source record identities, not names or optional domain IDs. */
export function editRequirementFields(
  model: MermaidRequirementModel,
  key: string,
  values: RequirementFieldValues,
  options: RequirementFieldWriteOptions = {},
) {
  const desired = structuredClone(model);
  const requirement = desired.requirements.find((n) => n.sourceKey === key);
  const element = desired.elements.find((n) => n.sourceKey === key);
  const relation = desired.relations.find((n) => n.sourceKey === key);
  const target = requirement ?? element ?? relation;
  if (!target) return requirementNoChange(model, "invalid");
  for (const [field, value] of Object.entries(values)) {
    if (
      !(field in target) ||
      typeof value !== "string" ||
      (field === "kind" && !relation)
    )
      return requirementNoChange(model, "invalid");
    Object.assign(target, { [field]: value });
  }
  const edited = writeRequirementModel(model, desired, {
    ...options,
    selection: target.id,
  });
  if (edited.status === "rejected" || !options.removeProperties?.length)
    return edited;
  const selected = [
    ...edited.model.requirements,
    ...edited.model.elements,
  ].find((object) => object.sourceKey === key);
  if (!selected) return requirementNoChange(model, "invalid");
  const allowed =
    "requirementType" in selected
      ? ["id", "text", "risk", "verifymethod"]
      : ["type", "docref"];
  if (options.removeProperties.some((property) => !allowed.includes(property)))
    return requirementNoChange(model, "invalid");
  const keys = new Set(
    options.removeProperties.flatMap(
      (property) => selected.propertyKeys?.[property] ?? [],
    ),
  );
  const records = edited.model.sourceDocument!.records.filter((record) =>
    keys.has(record.sourceKey),
  );
  const removed = writeRequirementPatches(
    edited.model,
    records.map((record) => ({
      range: { start: record.range.start, end: requirementRecordEnd(record) },
      value: "",
    })),
    {
      ...options,
      baseSource: edited.source,
      selection: selected.id,
      removed: keys,
    },
  );
  return removed.changed || removed.status === "rejected" ? removed : edited;
}
