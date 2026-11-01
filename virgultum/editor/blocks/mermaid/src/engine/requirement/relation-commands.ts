// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "./model.js";
import { REQUIREMENT_RELATIONS } from "./runtime-contract.js";
import {
  requirementNoChange,
  writeRequirementModel,
  type RequirementWriteOptions,
} from "./writer.js";

export type RequirementRelationDraft = {
  sourceKey: string;
  targetKey: string;
  kind: (typeof REQUIREMENT_RELATIONS)[number];
  sourceForm: "left" | "right";
};

/** Endpoints are effective object records, not display names or domain IDs.
 * A native alias with two namespaces is deliberately not guessed. Repetition,
 * cycles and self-connections are valid, independently bound relation records. */
export function addRequirementRelation(
  model: MermaidRequirementModel,
  draft: RequirementRelationDraft,
  options: RequirementWriteOptions = {},
) {
  const objects = [...model.requirements, ...model.elements];
  const source = objects.find((object) => object.sourceKey === draft.sourceKey),
    target = objects.find((object) => object.sourceKey === draft.targetKey);
  if (
    !source ||
    !target ||
    objects.filter((object) => object.name === source.name).length !== 1 ||
    objects.filter((object) => object.name === target.name).length !== 1 ||
    !(REQUIREMENT_RELATIONS as readonly string[]).includes(draft.kind) ||
    !["left", "right"].includes(draft.sourceForm)
  )
    return requirementNoChange(model, "invalid");
  let index = model.relations.length + 1;
  while (
    model.relations.some((relation) => relation.id === `relation-${index}`)
  )
    index++;
  const id = `relation-${index}`,
    desired = structuredClone(model);
  desired.relations.push({
    id,
    from: source.name,
    fromId: source.id,
    to: target.name,
    toId: target.id,
    kind: draft.kind,
    sourceForm: draft.sourceForm,
    order: model.relations.length,
  });
  const result = writeRequirementModel(model, desired, options);
  // The parser assigns the new record's first editor identity. Selection must
  // use that checked readback, not the temporary candidate identity above.
  return result.changed
    ? { ...result, selection: result.model.relations.at(-1)?.id }
    : result;
}

/** Reconnect one record, preserving its notation, kind and all neighbours.
 * Endpoint aliases are resolved from concrete effective object records. */
export function reconnectRequirementRelation(
  model: MermaidRequirementModel,
  key: string,
  draft: Pick<RequirementRelationDraft, "sourceKey" | "targetKey">,
  options: RequirementWriteOptions = {},
) {
  return editRequirementRelation(
    model,
    key,
    { sourceKey: draft.sourceKey, targetKey: draft.targetKey },
    options,
  );
}

/** Edit one bound relation atomically. Swapping the endpoint records reverses
 * semantic direction; the existing left/right Source notation stays intact. */
export function editRequirementRelation(
  model: MermaidRequirementModel,
  key: string,
  draft: Pick<RequirementRelationDraft, "sourceKey" | "targetKey"> &
    Partial<Pick<RequirementRelationDraft, "kind">>,
  options: RequirementWriteOptions = {},
) {
  const objects = [...model.requirements, ...model.elements],
    source = objects.find((object) => object.sourceKey === draft.sourceKey),
    target = objects.find((object) => object.sourceKey === draft.targetKey);
  const relation = model.relations.find(
    (relation) => relation.sourceKey === key,
  );
  if (
    !relation ||
    !source ||
    !target ||
    objects.filter((object) => object.name === source.name).length !== 1 ||
    objects.filter((object) => object.name === target.name).length !== 1 ||
    (draft.kind !== undefined &&
      !(REQUIREMENT_RELATIONS as readonly string[]).includes(draft.kind))
  )
    return requirementNoChange(model, "invalid");
  const desired = structuredClone(model),
    changed = desired.relations.find(
      (candidate) => candidate.sourceKey === key,
    )!;
  Object.assign(changed, {
    from: source.name,
    fromId: source.id,
    to: target.name,
    toId: target.id,
    kind: draft.kind ?? relation.kind,
  });
  return writeRequirementModel(model, desired, {
    ...options,
    selection: relation.id,
  });
}
