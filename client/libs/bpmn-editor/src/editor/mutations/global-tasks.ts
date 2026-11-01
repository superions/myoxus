// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified by Myoxus; see provenance.json for the retained definitions/reference owners.

import type {
  BPMN20__tDefinitions,
  BPMN20__tCallableElement,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { resolveBpmnProcessOwner } from "../../process-source";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { parseXmlQName } from "../../xml-parser/q-names";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { visitBpmnSourceObjects } from "./element-visitor";
import { qnameListChoices, resolveQNameList } from "./qname-list";

export type GlobalTaskKind =
  | "globalTask"
  | "globalUserTask"
  | "globalManualTask"
  | "globalScriptTask"
  | "globalBusinessRuleTask";
type Root = NonNullable<
  Normalized<BPMN20__tDefinitions>["rootElement"]
>[number];
export type GlobalTask = Extract<Root, { __$$element: GlobalTaskKind }>;
type CallActivity = Extract<
  NonNullable<Extract<Root, { __$$element: "process" }>["flowElement"]>[number],
  { __$$element: "callActivity" }
>;

export function isGlobalTask(root: Root): root is GlobalTask {
  return (
    root.__$$element === "globalTask" ||
    root.__$$element === "globalUserTask" ||
    root.__$$element === "globalManualTask" ||
    root.__$$element === "globalScriptTask" ||
    root.__$$element === "globalBusinessRuleTask"
  );
}

/** Process and GlobalTask inherit the same CallableElement interface contract.
 * Unresolved imported QNames remain explicit choices, never local-part aliases;
 * ID-less declarations cannot be QName reference targets. */
export function supportedInterfaceChoices(
  definitions: Normalized<BPMN20__tDefinitions>,
  owner: Pick<BPMN20__tCallableElement, "supportedInterfaceRef"> | undefined,
) {
  const targets = (definitions.rootElement ?? [])
    .filter((root) => root.__$$element === "interface")
    .filter((root) => !!root["@_id"])
    .map((root) => ({
      value: root["@_id"],
      label: root["@_name"] || root["@_id"],
    }));
  return qnameListChoices(
    definitions,
    owner?.supportedInterfaceRef ?? [],
    targets,
  );
}

/** Validate the whole list before replacing it. Retained references keep their
 * lexical spelling, namespace scope and metadata; new local choices encode at
 * the live callable owner. A stale/missing target never partially edits XML. */
export function setSupportedInterfaces(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  values: readonly string[],
) {
  const owner = definitions.rootElement?.find(
    (root) =>
      root["@_id"] === ownerId &&
      (root.__$$element === "process" || isGlobalTask(root)),
  );
  if (!owner || (owner.__$$element !== "process" && !isGlobalTask(owner)))
    throw new Error("BPMN_INVALID_CALLED_INTERFACE");
  const targets = new Set(
    definitions.rootElement
      ?.filter((root) => root.__$$element === "interface")
      .map((root) => root["@_id"])
      .filter(Boolean),
  );
  const next = resolveQNameList({
    definitions,
    owner,
    previous: owner.supportedInterfaceRef ?? [],
    selected: values,
    targets,
    invalid: "BPMN_INVALID_CALLED_INTERFACE",
  });
  if (next.length) owner.supportedInterfaceRef = next;
  else delete owner.supportedInterfaceRef;
}

/** Read-only call projection. External/unresolved targets do not acquire a
 * local marker merely because their QName's local part matches a declaration. */
export function calledGlobalTaskKind(
  definitions: Normalized<BPMN20__tDefinitions>,
  callId: string,
): GlobalTaskKind | undefined {
  // Zustand subscriptions can see new definitions before React Flow supplies
  // new node props. Resolve the stable ID within this snapshot, never index a
  // call object captured from a prior render against a different scope tree.
  const process = definitions.rootElement?.find(
    (root) => root.__$$element === "process",
  );
  if (process?.__$$element !== "process") return undefined;
  let call: CallActivity | undefined;
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element.__$$element !== "callActivity" || element["@_id"] !== callId)
      return true;
    call = element;
    return false;
  });
  if (!call) return undefined;
  const id = indexBpmnIds(definitions).resolveReference(
    call,
    call["@_calledElement"],
  );
  const root =
    id && definitions.rootElement?.find((root) => root["@_id"] === id);
  return root && isGlobalTask(root) ? root.__$$element : undefined;
}

/** Global tasks are definitions-level callables, never flow nodes. Their five
 * schema kinds must not enter the task-node map, palette or BPMNDI projection. */
export function createGlobalTask(
  definitions: Normalized<BPMN20__tDefinitions>,
  kind: GlobalTaskKind,
  name: string,
): GlobalTask {
  resolveBpmnProcessOwner(definitions);
  const root: GlobalTask = {
    __$$element: kind,
    "@_id": generateUuid(),
    "@_name": name,
  };
  if (indexBpmnIds(definitions).getOriginalIds().has(root["@_id"]))
    throw new Error("BPMN_DUPLICATE_ID");
  definitions.rootElement!.push(root);
  return root;
}

function globalTask(definitions: Normalized<BPMN20__tDefinitions>, id: string) {
  const matches =
    definitions.rootElement?.filter(
      (root): root is GlobalTask => isGlobalTask(root) && root["@_id"] === id,
    ) ?? [];
  if (matches.length !== 1) throw new Error("BPMN_GLOBAL_TASK_NOT_FOUND");
  return matches[0];
}

/** An imported lexical QName is resolved in its actual call-activity scope.
 * A genuinely external bound name is legal without any resolution/execution
 * claim. Missing owned names, including prefixed MODEL names, are not external. */
export function validCalledElement(
  definitions: BPMN20__tDefinitions,
  owner: object,
  value: string,
): boolean {
  if (!value.trim()) return true;
  try {
    const references = indexBpmnIds(definitions);
    const id = references.resolveReference(owner, value);
    if (id)
      return (
        definitions.rootElement?.some(
          (root) =>
            root["@_id"] === id &&
            (root.__$$element === "process" || isGlobalTask(root as Root)),
        ) ?? false
      );
    const { namespace } = references.expandQName(owner, value);
    return (
      namespace !== definitions["@_targetNamespace"] &&
      namespace !== "http://www.omg.org/spec/BPMN/20100524/MODEL" &&
      (parseXmlQName(value).prefix !== undefined || !!namespace)
    );
  } catch {
    return false;
  }
}

/** Selection IDs and raw lexical references have explicit private intent. The
 * DTO is never persisted; only the QName encoded at the real XML owner is. */
export type CalledElementTarget =
  | { kind: "internal"; id: string }
  | { kind: "reference"; qname: string }
  | undefined;
export function setCalledElement(
  definitions: Normalized<BPMN20__tDefinitions>,
  callId: string,
  target: CalledElementTarget,
) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let call: CallActivity | undefined;
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element.__$$element !== "callActivity" || element["@_id"] !== callId)
      return true;
    call = element;
    return false;
  });
  if (!call) throw new Error("BPMN_CALL_ACTIVITY_NOT_FOUND");
  if (!target) {
    delete call["@_calledElement"];
    return;
  }
  if (target.kind === "reference") {
    if (!validCalledElement(definitions, call, target.qname))
      throw new Error("BPMN_INVALID_CALLED_ELEMENT");
    if (target.qname.trim()) call["@_calledElement"] = target.qname;
    else delete call["@_calledElement"];
    return;
  }
  const root = definitions.rootElement?.find(
    (root) => root["@_id"] === target.id,
  );
  if (!root || (root.__$$element !== "process" && !isGlobalTask(root)))
    throw new Error("BPMN_INVALID_CALLED_ELEMENT");
  call["@_calledElement"] = indexBpmnIds(definitions).referenceFor(
    call,
    target.id,
    call["@_calledElement"],
  );
}

/** Identity rename cascades through the retained schema index in one enclosing
 * history transaction. Display-name edits do not rename IDs or references. */
export function renameGlobalTask(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  newId: string,
) {
  resolveBpmnProcessOwner(definitions);
  globalTask(definitions, id);
  indexBpmnIds(definitions).rename(id, newId);
}

/** New callable I/O always has the schema-required input/output sets. Existing
 * sets and ioBinding metadata are never reconstructed through mapping rows. */
export function addGlobalTaskData(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  direction: "input" | "output",
) {
  const root = globalTask(definitions, id);
  const io = (root.ioSpecification ??= {
    "@_id": generateUuid(),
    inputSet: [{ "@_id": generateUuid() }],
    outputSet: [{ "@_id": generateUuid() }],
  });
  const data = { "@_id": generateUuid(), "@_name": "" };
  if (direction === "input") {
    (io.dataInput ??= []).push(data);
    (io.inputSet[0].dataInputRefs ??= []).push({ __$$text: data["@_id"] });
  } else {
    (io.dataOutput ??= []).push(data);
    (io.outputSet[0].dataOutputRefs ??= []).push({ __$$text: data["@_id"] });
  }
}

/** Remove only the selected data item and its own set memberships. A binding,
 * expression or any other consumer this control cannot repair blocks deletion. */
export function deleteGlobalTaskData(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  direction: "input" | "output",
  dataIndex: number,
) {
  const io = globalTask(definitions, id).ioSpecification;
  const entries = direction === "input" ? io?.dataInput : io?.dataOutput;
  const data = entries?.[dataIndex];
  if (!io || !data) throw new Error("BPMN_GLOBAL_DATA_NOT_FOUND");
  const index = indexBpmnIds(definitions);
  const fields =
    direction === "input"
      ? ([
          "dataInputRefs",
          "optionalInputRefs",
          "whileExecutingInputRefs",
        ] as const)
      : ([
          "dataOutputRefs",
          "optionalOutputRefs",
          "whileExecutingOutputRefs",
        ] as const);
  const sets = direction === "input" ? io.inputSet : io.outputSet;
  const owners = sets as Array<Record<string, unknown>>;
  let memberships = 0;
  for (const set of owners)
    for (const field of fields) {
      const refs = set[field] as Array<{ __$$text: string }> | undefined;
      memberships +=
        refs?.filter((ref) => ref.__$$text.trim() === data["@_id"]).length ?? 0;
    }
  if (index.referenceCount(data["@_id"]) > memberships)
    throw new Error("BPMN_DEFINITION_IN_USE");
  for (const set of owners)
    for (const field of fields) {
      const refs = set[field] as Array<{ __$$text: string }> | undefined;
      if (refs) {
        const remaining = refs.filter(
          (ref) => ref.__$$text.trim() !== data["@_id"],
        );
        if (remaining.length) set[field] = remaining;
        else delete set[field];
      }
    }
  entries!.splice(dataIndex, 1);
  if (!entries!.length) {
    if (direction === "input") delete io.dataInput;
    else delete io.dataOutput;
  }
}

/** Deletion is fail-closed unless every call consumer is explicitly cleared or
 * retargeted by this command. Other schema consumers still block deletion;
 * external same-spelled names and unrelated definitions/namespace bindings stay.
 * The caller supplies the existing model/history transaction, never a registry. */
export function deleteGlobalTask(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  retarget?: { kind: "clear" } | { kind: "replace"; id: string },
) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  const root = globalTask(definitions, id);
  const references = indexBpmnIds(definitions);
  const subtree = {
    ...definitions,
    rootElement: [root],
    "bpmndi:BPMNDiagram": undefined,
    relationship: undefined,
  };
  const ownedReferences = indexBpmnIds(subtree);
  // Deleting a callable also deletes its I/O/rendering/resource identities.
  // External consumers of those children are just as blocking as root users.
  visitBpmnSourceObjects(subtree, ({ value }) => {
    const child = value["@_id"];
    if (
      typeof child === "string" &&
      child !== id &&
      references.referenceCount(child) > ownedReferences.referenceCount(child)
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
  });
  const consumers: CallActivity[] = [];
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "callActivity" &&
      references.resolveReference(element, element["@_calledElement"]) === id
    )
      consumers.push(element);
  });
  if (
    references.referenceCount(id) > consumers.length ||
    (consumers.length && !retarget)
  )
    throw new Error("BPMN_DEFINITION_IN_USE");
  if (retarget?.kind === "replace") {
    const replacement = definitions.rootElement?.find(
      (root) => root["@_id"] === retarget.id,
    );
    if (
      retarget.id === id ||
      !replacement ||
      (replacement.__$$element !== "process" && !isGlobalTask(replacement))
    )
      throw new Error("BPMN_INVALID_CALLED_ELEMENT");
  }
  for (const consumer of consumers) {
    if (retarget?.kind === "replace")
      consumer["@_calledElement"] = references.referenceFor(
        consumer,
        retarget.id,
        consumer["@_calledElement"],
      );
    else delete consumer["@_calledElement"];
  }
  definitions.rootElement!.splice(definitions.rootElement!.indexOf(root), 1);
}
