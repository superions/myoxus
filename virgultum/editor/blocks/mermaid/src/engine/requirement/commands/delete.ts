// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import {
  requirementNoChange,
  writeRequirementModel,
  type RequirementWriteOptions,
  writeRequirementPatches,
  requirementRecordEnd,
} from "../writer.js";
import { requirementComments } from "./comments.js";

export type RequirementDeleteOptions = RequirementWriteOptions & {
  confirmed?: boolean;
  references?: "keep" | "remove";
};
export type RequirementDeleteImpact = {
  requiresConfirmation: boolean;
  changesResolution: boolean;
  resolutions: { alias: string; before: string; after: string }[];
  records: { key: string; kind: string; source: string; line: number }[];
};

function deletionPlan(
  model: MermaidRequirementModel,
  keys: readonly string[],
  references: "keep" | "remove" = "keep",
) {
  const selected = new Set(keys);
  const removedObjects = [...model.requirements, ...model.elements].filter(
    (n) => selected.has(n.sourceKey ?? ""),
  );
  const requirements = model.requirements.filter(
    (n) => !selected.has(n.sourceKey ?? ""),
  );
  const elements = model.elements.filter(
    (n) => !selected.has(n.sourceKey ?? ""),
  );
  const remainingAliases = new Set(
    [...requirements, ...elements].map((n) => n.name),
  );
  const aliases = new Set(removedObjects.map((n) => n.name));
  const changedAliases = new Set(
    removedObjects
      .filter((n) => {
        const before =
          model.requirements.find((r) => r.name === n.name) ??
          model.elements.find((e) => e.name === n.name);
        const after =
          requirements.find((r) => r.name === n.name) ??
          elements.find((e) => e.name === n.name);
        return before?.sourceKey !== after?.sourceKey;
      })
      .map((n) => n.name),
  );
  const affectedRelations = model.relations.filter(
    (r) => changedAliases.has(r.from) || changedAliases.has(r.to),
  );
  const relations = model.relations.filter(
    (r) =>
      !selected.has(r.sourceKey ?? "") &&
      ![r.from, r.to].some(
        (alias) =>
          changedAliases.has(alias) &&
          (!remainingAliases.has(alias) || references === "remove"),
      ),
  );
  const requirementKeys = new Set(model.requirements.map((n) => n.sourceKey));
  const definitionKeys = new Set(
    model.sourceDocument?.records
      .filter(
        (r) =>
          r.kind === "object-open" &&
          removedObjects.some(
            (n) =>
              r.namespace ===
                (requirementKeys.has(n.sourceKey)
                  ? "requirement"
                  : "element") && r.ownerId === n.name,
          ),
      )
      .map((r) => r.sourceKey),
  );
  const affected =
    model.sourceDocument?.records.filter(
      (r) =>
        definitionKeys.has(r.sourceKey) ||
        definitionKeys.has(r.blockKey ?? "") ||
        selected.has(r.sourceKey) ||
        affectedRelations.some((edge) => edge.sourceKey === r.sourceKey) ||
        (r.references.some((ref) => aliases.has(ref.id)) &&
          ["style", "style-assignment", "inline-class"].includes(r.kind)),
    ) ?? [];
  const removedKeys = new Set([
    ...definitionKeys,
    ...(model.sourceDocument?.records
      .filter(
        (record) =>
          ["style", "style-assignment", "inline-class"].includes(record.kind) &&
          record.references.length > 0 &&
          record.references.every(
            (reference) =>
              aliases.has(reference.id) && !remainingAliases.has(reference.id),
          ),
      )
      .map((record) => record.sourceKey) ?? []),
    ...(model.sourceDocument?.records
      .filter((record) => definitionKeys.has(record.blockKey ?? ""))
      .map((record) => record.sourceKey) ?? []),
    ...model.relations
      .filter((relation) => !relations.includes(relation))
      .flatMap((relation) => relation.sourceKey ?? []),
  ]);
  const comments = requirementComments(model).filter(
    (comment) => comment.anchor.key && removedKeys.has(comment.anchor.key),
  );
  for (const comment of comments) {
    const record = model.sourceDocument?.records.find(
      (record) => record.sourceKey === comment.key,
    );
    if (record && !affected.includes(record)) affected.push(record);
  }
  const changesResolution = affectedRelations.some((r) =>
    [r.from, r.to].some(
      (alias) => changedAliases.has(alias) && remainingAliases.has(alias),
    ),
  );
  const impact: RequirementDeleteImpact = {
    changesResolution,
    resolutions: [...changedAliases].flatMap((alias) => {
      const before =
        model.requirements.find((object) => object.name === alias) ??
        model.elements.find((object) => object.name === alias);
      const after =
        requirements.find((object) => object.name === alias) ??
        elements.find((object) => object.name === alias);
      const label = (object: typeof before) =>
        `${alias} (${object && "requirementType" in object ? object.requirementType : "element"})`;
      return before && after
        ? [{ alias, before: label(before), after: label(after) }]
        : [];
    }),
    requiresConfirmation:
      affectedRelations.length > 0 ||
      comments.length > 0 ||
      definitionKeys.size > removedObjects.length ||
      affected.some((r) =>
        ["style", "style-assignment", "inline-class"].includes(r.kind),
      ),
    records: affected
      .filter((r) => r.kind !== "blank")
      .map((r) => ({
        key: r.sourceKey,
        kind: r.kind,
        source: r.raw,
        line: r.range.line,
      })),
  };
  return {
    impact,
    comments,
    desired: { ...model, requirements, elements, relations },
  };
}

/** A namespace alias group is one visual object. Remove every definition in that
 * group so an ignored definition cannot silently resurrect it. Cross-namespace
 * references may deliberately re-resolve to the surviving object. */
export function requirementDeleteImpact(
  model: MermaidRequirementModel,
  keys: readonly string[],
): RequirementDeleteImpact {
  return deletionPlan(model, keys).impact;
}
export function deleteRequirementSelection(
  model: MermaidRequirementModel,
  keys: readonly string[],
  options: RequirementDeleteOptions = {},
) {
  if (!keys.length) return requirementNoChange(model);
  const known = new Set(
    [...model.requirements, ...model.elements, ...model.relations].map(
      (n) => n.sourceKey,
    ),
  );
  if (keys.some((key) => !known.has(key)))
    return requirementNoChange(model, "invalid");
  const { desired, impact, comments } = deletionPlan(
    model,
    keys,
    options.references,
  );
  if (
    impact.requiresConfirmation &&
    !options.confirmed &&
    options.intent !== "cancel"
  )
    return requirementNoChange(model, "invalid");
  const next =
    [...desired.requirements, ...desired.elements][0] ?? desired.relations[0];
  const edited = writeRequirementModel(model, desired, {
    ...options,
    selection: next?.id,
  });
  if (!edited.changed) return edited;
  const records = edited.model.sourceDocument!.records.filter((record) =>
    comments.some((comment) => comment.key === record.sourceKey),
  );
  if (!records.length) return edited;
  return writeRequirementPatches(
    edited.model,
    records.map((record) => ({
      range: { start: record.range.start, end: requirementRecordEnd(record) },
      value: "",
    })),
    {
      ...options,
      baseSource: edited.source,
      removed: new Set(records.map((record) => record.sourceKey)),
      selection: next?.id,
    },
  );
}
