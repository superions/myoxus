// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "./model.js";
import {
  REQUIREMENT_TYPES,
  readRequirementString,
  sourceRequirementString,
} from "./runtime-contract.js";
import {
  requirementNoChange,
  writeRequirementModel,
  type RequirementWriteOptions,
} from "./writer.js";

export type RequirementObjectKind =
  (typeof REQUIREMENT_TYPES)[number] | "element";
function reservedAliases(model: MermaidRequirementModel) {
  return new Set(
    model.sourceDocument?.records
      .filter((record) => record.kind === "object-open")
      .map((record) => record.ownerId),
  );
}
export function nextRequirementAlias(
  model: MermaidRequirementModel,
  kind: RequirementObjectKind,
) {
  const used = reservedAliases(model),
    prefix = kind === "element" ? "element" : "requirement";
  let index = 1;
  while (used.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

/** New cards have no fabricated domain ID or optional property providers. The
 * typed alias is checked against both native namespaces before any write. */
export function addRequirementObject(
  model: MermaidRequirementModel,
  kind: RequirementObjectKind,
  name: string,
  options: RequirementWriteOptions = {},
) {
  if (
    (!(REQUIREMENT_TYPES as readonly string[]).includes(kind) &&
      kind !== "element") ||
    readRequirementString(sourceRequirementString(name)) !== name ||
    reservedAliases(model).has(name)
  )
    return requirementNoChange(model, "invalid");
  const desired = structuredClone(model);
  const geometry = { id: name, name, x: 0, y: 0, width: 200 };
  if (kind === "element")
    desired.elements.push({
      ...geometry,
      order: desired.elements.length,
      docRef: "",
      elementType: "",
    });
  else
    desired.requirements.push({
      ...geometry,
      order: desired.requirements.length,
      requirementId: "",
      requirementType: kind,
      risk: "",
      text: "",
      verifyMethod: "",
    });
  return writeRequirementModel(model, desired, { ...options, selection: name });
}
