// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidC4Argument,
  MermaidC4Model,
  MermaidC4Relationship,
} from "../model.js";
import { C4_CALLS, isC4RelationshipKind } from "../runtime-contract.js";
import { generateMermaidC4SourceWithBindings } from "../writer.js";
import { C4WriteError } from "../patches.js";
import { cloneC4Model, c4CommandResult, c4NoChange } from "./model.js";
import { editC4RelationshipRecord } from "./relationship-commands.js";
import { c4CallPatch } from "../record-writer.js";
import { writeC4Patches } from "../patches.js";
import { mermaidMessages as m } from "../../../i18n.js";

export const C4_RELATIONSHIP_FIELD_KEYS = {
  label: "label",
  technology: "techn",
  description: "descr",
  sprite: "sprite",
  tags: "tags",
  link: "link",
} as const;
export type C4RelationshipFields = Record<
  keyof typeof C4_RELATIONSHIP_FIELD_KEYS,
  string
>;
export function readC4RelationshipFields(
  relationship: MermaidC4Relationship,
): C4RelationshipFields {
  return {
    label: relationship.label,
    technology: relationship.technology,
    description: relationship.description,
    sprite: relationship.sprite,
    tags: relationship.tags,
    link: relationship.link,
  };
}
/** Effective fields reuse the retained writer's actual provider and explicit absent-slot updates. */
export function editC4RelationshipFields(
  model: MermaidC4Model,
  selectionId: string,
  values: Readonly<Partial<C4RelationshipFields>>,
) {
  if (
    Object.entries(values).some(
      ([key, value]) =>
        !Object.hasOwn(C4_RELATIONSHIP_FIELD_KEYS, key) ||
        typeof value !== "string",
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  const draft = cloneC4Model(model),
    owner = draft.relationships.find(
      (r) => r.resolution!.selectionId === selectionId,
    );
  if (!owner) return c4NoChange(model, m.classPatchRejected());
  Object.assign(owner, values);
  try {
    return c4CommandResult(
      model,
      generateMermaidC4SourceWithBindings(draft),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
/** Selected-record edits preserve ignored RelIndex text and cannot bypass endpoint validation. */
export function editC4RelationshipArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey,
  );
  if (
    !record?.arguments ||
    !record.callKind ||
    !model.occurrences.some(
      (o) => o.sourceKey === sourceKey && o.selectionId === selectionId,
    ) ||
    !["relationship", "relationship-update"].includes(record.kind) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= record.arguments.length
  )
    return c4NoChange(model, m.classPatchRejected());
  if (record.kind === "relationship" && !isC4RelationshipKind(record.callKind))
    return c4NoChange(model, m.classPatchRejected());
  const field = C4_CALLS[record.callKind].slots[index];
  if (field === "from" || field === "to")
    return c4NoChange(model, m.classPatchRejected());
  const args = record.arguments.map((a) => ({ ...a }));
  if (JSON.stringify(args[index]) === JSON.stringify(argument))
    return c4NoChange(model);
  args[index] = { ...argument };
  try {
    const next = isC4RelationshipKind(record.callKind)
      ? editC4RelationshipRecord(model, sourceKey, record.callKind, args)
      : writeC4Patches(model, [
          c4CallPatch(model, sourceKey, record.callKind, args),
        ]);
    if (
      !next ||
      next.model.relationships.some((r) =>
        [r.from, r.to].some(
          (alias) => !next.model.elements.some((e) => e.alias === alias),
        ),
      )
    )
      return c4NoChange(model, m.visualConnectionInvalidTarget());
    return c4CommandResult(
      model,
      next,
      next.model.occurrences.find((o) => o.sourceKey === sourceKey)
        ?.selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
