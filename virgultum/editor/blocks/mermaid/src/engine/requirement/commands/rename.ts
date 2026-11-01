// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import {
  readRequirementString,
  sourceRequirementString,
} from "../runtime-contract.js";
import { editRequirementRelation } from "../relation-commands.js";
import {
  requirementNoChange,
  writeRequirementModel,
  type RequirementWriteOptions,
} from "../writer.js";

export type RequirementRenameReferences = Readonly<
  Record<string, "keep" | "reassign">
>;

/** Rename impact is based on actual native alias references, not optional IDs.
 * Cross-namespace repair leaves shared style/class targets at their old alias. */
export function requirementRenameImpact(
  model: MermaidRequirementModel,
  key: string,
  name: string,
) {
  const objects = [...model.requirements, ...model.elements],
    object = objects.find((object) => object.sourceKey === key);
  const namespace =
    object && "requirementType" in object ? "requirement" : "element";
  const remaining =
    object &&
    objects.find((other) => other !== object && other.name === object.name);
  const collision = model.sourceDocument?.records.some(
    (record) =>
      record.kind === "object-open" &&
      record.ownerId === name &&
      name !== object?.name,
  );
  const records =
    model.sourceDocument?.records.filter(
      (record) =>
        object &&
        ((record.kind === "object-open" &&
          record.namespace === namespace &&
          record.ownerId === object.name) ||
          record.references.some((reference) => reference.id === object.name)),
    ) ?? [];
  const relations = model.relations.filter(
    (relation) =>
      object && (relation.from === object.name || relation.to === object.name),
  );
  return {
    object,
    remaining,
    valid: Boolean(
      object &&
      !collision &&
      readRequirementString(sourceRequirementString(name)) === name,
    ),
    records,
    relations,
  };
}

/** One checked alias-group rename, with explicit per-record relationship choices
 * when the two native namespaces shared the old alias. Never guess that intent. */
export function renameRequirementAlias(
  model: MermaidRequirementModel,
  key: string,
  name: string,
  references: RequirementRenameReferences = {},
  options: RequirementWriteOptions = {},
) {
  const impact = requirementRenameImpact(model, key, name),
    object = impact.object;
  if (!impact.valid || !object) return requirementNoChange(model, "invalid");
  if (object.name === name) return requirementNoChange(model);
  if (
    impact.remaining &&
    impact.relations.some(
      (relation) =>
        !relation.sourceKey ||
        !["keep", "reassign"].includes(references[relation.sourceKey]),
    )
  )
    return requirementNoChange(model, "invalid");
  const desired = structuredClone(model),
    selected = [...desired.requirements, ...desired.elements].find(
      (candidate) => candidate.sourceKey === key,
    )!;
  selected.name = name;
  let result = writeRequirementModel(model, desired, {
    ...options,
    selection: object.id,
  });
  if (result.status === "rejected" || !impact.remaining) return result;
  for (const relation of impact.relations) {
    if (references[relation.sourceKey!] !== "reassign") continue;
    const objects = [...result.model.requirements, ...result.model.elements];
    const resolve = (alias: string) =>
      alias === object.name
        ? key
        : objects.find((candidate) => candidate.name === alias)?.sourceKey;
    const next = editRequirementRelation(
      result.model,
      relation.sourceKey!,
      {
        sourceKey: resolve(relation.from) ?? "",
        targetKey: resolve(relation.to) ?? "",
      },
      { ...options, baseSource: result.source },
    );
    if (next.status === "rejected")
      return requirementNoChange(model, "invalid");
    result = next;
  }
  return { ...result, selection: object.id };
}
