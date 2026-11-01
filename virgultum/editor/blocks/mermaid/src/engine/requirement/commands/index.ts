// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRequirementModel } from "../model.js";
export * from "./fields.js";
export * from "./delete.js";

function cloneRequirementModel(model: MermaidRequirementModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidRequirementModel;
}

export function setMermaidRequirementRisk(
  model: MermaidRequirementModel,
  requirementId: string,
  risk: string,
) {
  const next = cloneRequirementModel(model);
  const requirement = next.requirements.find(
    (candidate) => candidate.id === requirementId,
  );
  if (requirement) requirement.risk = risk.trim();
  return next;
}

export function renameMermaidRequirementRelation(
  model: MermaidRequirementModel,
  relationId: string,
  kind: string,
) {
  const next = cloneRequirementModel(model);
  const relation = next.relations.find(
    (candidate) => candidate.id === relationId,
  );
  if (relation) relation.kind = kind.trim() || relation.kind;
  return next;
}

export function addMermaidRequirementRelation(
  model: MermaidRequirementModel,
  from: string,
  to: string,
  kind = "satisfies",
) {
  const next = cloneRequirementModel(model);
  const validIds = new Set([
    ...next.requirements.map((requirement) => requirement.id),
    ...next.elements.map((element) => element.id),
  ]);
  if (from === to || !validIds.has(from) || !validIds.has(to)) return next;
  const order = next.relations.length;
  next.relations.push({
    from,
    id: `relation-${from}-${to}-${order + 1}`,
    kind: kind.trim() || "satisfies",
    order,
    to,
  });
  return next;
}
export * from "./rename.js";
export * from "./copy.js";
export * from "./comments.js";
export * from "./title.js";
export * from "./accessibility.js";
