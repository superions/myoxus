// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { resolveBpmnProcessOwner } from "../../process-source";
import { findConnectionElement } from "./connection";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../xyflow/uuid/uuid";

type SchemaRole = NonNullable<
  Normalized<BPMN20__tProcess>["resourceRole"]
>[number];
// The XML parser omits the base element discriminator, emitting it only for
// substitution types. Commands use the same representation for reopen identity.
export type ResourceRole = Omit<SchemaRole, "__$$element"> & {
  __$$element?: SchemaRole["__$$element"];
};
const roleOwners = new Set([
  "process",
  "task",
  "userTask",
  "manualTask",
  "serviceTask",
  "scriptTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "callActivity",
  "subProcess",
  "adHocSubProcess",
  "transaction",
  "globalTask",
  "globalUserTask",
  "globalManualTask",
  "globalScriptTask",
  "globalBusinessRuleTask",
]);

/** Resolve the current semantic owner, including non-graphical callable roots.
 * Process/activity roles share the same schema contract and definitions roots;
 * a selected canvas snapshot never owns a separate role collection. */
export function resourceRoleOwner(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): { resourceRole?: ResourceRole[] } | undefined {
  resolveBpmnProcessOwner(definitions);
  const owner =
    definitions.rootElement?.find((root) => root["@_id"] === id) ??
    findConnectionElement(definitions, id)?.element;
  return owner && roleOwners.has(owner.__$$element)
    ? (owner as { resourceRole?: ResourceRole[] })
    : undefined;
}

/** Destructive commands must account for references to every owned descendant,
 * not just the root. Shared resources and parameters are never swept implicitly. */
export function assertResourceSubtreeUnused(
  definitions: Normalized<BPMN20__tDefinitions>,
  value: unknown,
) {
  const ids = indexBpmnIds(definitions);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const element = value as Record<string, unknown>;
    if (
      typeof element["@_id"] === "string" &&
      ids.isReferenced(element["@_id"])
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
    Object.values(element).forEach(visit);
  };
  visit(value);
}

export function changeResourceRoles(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  change: (
    roles: ResourceRole[],
    references: ReturnType<typeof indexBpmnIds>,
  ) => void,
) {
  const owner = resourceRoleOwner(definitions, id);
  if (!owner) throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  change((owner.resourceRole ??= []), indexBpmnIds(definitions));
  if (!owner.resourceRole.length) delete owner.resourceRole;
}

export function setRoleResource(
  definitions: Normalized<BPMN20__tDefinitions>,
  role: ResourceRole,
  target?: string,
) {
  const index = indexBpmnIds(definitions);
  if (
    target &&
    !definitions.rootElement?.some(
      (root) => root.__$$element === "resource" && root["@_id"] === target,
    )
  )
    throw new Error("BPMN_DEFINITION_NOT_FOUND");
  const previous = index.resolveReference(
    role.resourceRef ?? role,
    role.resourceRef?.__$$text,
  );
  // Existing parameter bindings belong to their selected resource. Retargeting
  // must not strand them or reinterpret them as a different resource's inputs.
  if (previous !== target && role.resourceParameterBinding?.length)
    throw new Error("BPMN_DEFINITION_IN_USE");
  if (!target) {
    delete role.resourceRef;
    return;
  }
  const encoded = index.referenceFor(
    role.resourceRef ?? role,
    target,
    role.resourceRef?.__$$text,
  )!;
  role.resourceRef ??= { __$$text: "" };
  role.resourceRef.__$$text = encoded;
}

export function createResource(
  definitions: Normalized<BPMN20__tDefinitions>,
): string {
  resolveBpmnProcessOwner(definitions);
  const id = generateUuid();
  (definitions.rootElement ??= []).push({
    __$$element: "resource",
    "@_id": id,
    "@_name": "",
  });
  return id;
}

/** Imported unreferenced declarations may omit their optional ID. The manager
 * borrows their current definitions-array position synchronously; it never treats
 * undefined as a shared identity or allocates an ID merely to display fields. */
export function resourceById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string | number,
) {
  resolveBpmnProcessOwner(definitions);
  const root =
    typeof id === "number"
      ? definitions.rootElement?.[id]
      : definitions.rootElement?.find(
          (root) => root.__$$element === "resource" && root["@_id"] === id,
        );
  if (root?.__$$element !== "resource")
    throw new Error("BPMN_DEFINITION_NOT_FOUND");
  return root;
}

export function deleteResource(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string | number,
) {
  const root = resourceById(definitions, id);
  assertResourceSubtreeUnused(definitions, root);
  definitions.rootElement!.splice(definitions.rootElement!.indexOf(root), 1);
}
