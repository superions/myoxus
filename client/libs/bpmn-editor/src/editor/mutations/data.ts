// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { connectionElement, findConnectionElement } from "./connection";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { dataObjectReferenceTarget } from "./data-context";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { findProcessIoItem, type ProcessIoItem } from "./process-io-context";

/** A non-graphical backing belongs to its flow scope, shared by its references.
 * Retire it only when the last reference is explicitly removed/reassigned and
 * no schema consumer (including a child state consumer) would be left dangling.
 * Visible data objects are independent diagram elements and always survive. */
export function retireUnusedDataBacking(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const index = indexBpmnIds(definitions),
    { plane } = addOrGetProcessAndDiagramElements({ definitions });
  if (
    plane["di:DiagramElement"]?.some(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        index.resolveReference(shape, shape["@_bpmnElement"]) === id,
    ) ||
    index.isReferenced(id)
  )
    return;
  const location = findConnectionElement(definitions, id);
  if (location?.element.__$$element !== "dataObject") return;
  const assertUnreferenced = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(assertUnreferenced);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      typeof object["@_id"] === "string" &&
      index.isReferenced(object["@_id"])
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
    Object.values(object).forEach(assertUnreferenced);
  };
  assertUnreferenced(location.element);
  location.array.splice(location.index, 1);
}

export function setDataObjectReference(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  targetId?: string,
) {
  const { element, owner } = connectionElement(definitions, id);
  if (element.__$$element !== "dataObjectReference")
    throw new Error("BPMN_INVALID_CONNECTION");
  const previous = element["@_dataObjectRef"]?.trim();
  dataObjectReferenceTarget(owner, { ...element, "@_dataObjectRef": targetId });
  if (targetId) element["@_dataObjectRef"] = targetId;
  else delete element["@_dataObjectRef"];
  if (previous && previous !== targetId)
    retireUnusedDataBacking(definitions, previous);
}

export function createDataObjectBacking(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const { element, owner } = connectionElement(definitions, id);
  if (element.__$$element !== "dataObjectReference")
    throw new Error("BPMN_INVALID_CONNECTION");
  const backingId = generateUuid();
  (owner.flowElement ??= []).push({
    "@_id": backingId,
    __$$element: "dataObject",
  });
  setDataObjectReference(definitions, id, backingId);
}

/** Bracketed data state is notation, not part of the authored name. Both
 * renderers read the current ID owner; inline rename edits only @_name. */
export function dataObjectLabel(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const io = findProcessIoItem(
    addOrGetProcessAndDiagramElements({ definitions }).process,
    id,
  );
  const object = findConnectionElement(definitions, id)?.element;
  if (
    !io &&
    object?.__$$element !== "dataObject" &&
    object?.__$$element !== "dataObjectReference" &&
    object?.__$$element !== "dataStoreReference"
  )
    return "";
  const data = (io?.element ?? object) as ProcessIoItem | undefined;
  if (!data) return "";
  return [
    data["@_name"],
    data.dataState?.["@_name"] ? `[${data.dataState["@_name"]}]` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function dataObjectIsCollection(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const io = findProcessIoItem(
    addOrGetProcessAndDiagramElements({ definitions }).process,
    id,
  );
  if (io) return io.element["@_isCollection"] ?? false;
  const location = findConnectionElement(definitions, id);
  const element = location?.element;
  const object =
    element?.__$$element === "dataObjectReference"
      ? dataObjectReferenceTarget(location!.owner, element)
      : element;
  return (
    object?.__$$element === "dataObject" && object["@_isCollection"] === true
  );
}

/** A focused edit retains state ID, documentation and extensions. Clearing an
 * externally referenced inline state rejects rather than dangling it. */
export function setDataObjectDetails(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  change: { collection?: boolean; state?: string },
) {
  const { element: object } = connectionElement(definitions, id);
  if (
    object.__$$element !== "dataObject" &&
    object.__$$element !== "dataObjectReference" &&
    object.__$$element !== "dataStoreReference"
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (change.collection !== undefined && object.__$$element !== "dataObject")
    throw new Error("BPMN_INVALID_CONNECTION");
  if (change.collection !== undefined && object["@_itemSubjectRef"]) {
    const typeId = indexBpmnIds(definitions).resolveReference(
      object,
      object["@_itemSubjectRef"],
    );
    const type = definitions.rootElement?.find(
      (root) =>
        root.__$$element === "itemDefinition" && root["@_id"] === typeId,
    );
    if (
      type?.__$$element !== "itemDefinition" ||
      (type["@_isCollection"] ?? false) !== change.collection
    )
      throw new Error("BPMN_INVALID_CONNECTION");
  }
  if (change.collection !== undefined)
    if (object.__$$element === "dataObject")
      object["@_isCollection"] = change.collection;
  if (change.state !== undefined) {
    if (change.state) {
      object.dataState ??= { "@_id": generateUuid() };
      object.dataState["@_name"] = change.state;
    } else {
      if (
        object.dataState?.["@_id"] &&
        indexBpmnIds(definitions).isReferenced(object.dataState["@_id"])
      )
        throw new Error("BPMN_DEFINITION_IN_USE");
      delete object.dataState;
    }
  }
}

/** BPMN 2.0.2 Table 10.52: a direct DataObject's ItemDefinition owns collection
 * cardinality. References own an item type but never a collection flag. Changing
 * type never rewrites a shared ItemDefinition; clearing it retains a direct
 * object's current collection flag, which then becomes authorable. */
export function setDataObjectItemType(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  typeId?: string,
) {
  const { element: object } = connectionElement(definitions, id);
  if (
    object.__$$element !== "dataObject" &&
    object.__$$element !== "dataObjectReference" &&
    object.__$$element !== "dataStoreReference"
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (!typeId) {
    delete object["@_itemSubjectRef"];
    return;
  }
  const type = definitions.rootElement?.find(
    (root) => root.__$$element === "itemDefinition" && root["@_id"] === typeId,
  );
  if (type?.__$$element !== "itemDefinition")
    throw new Error("BPMN_INVALID_CONNECTION");
  object["@_itemSubjectRef"] = indexBpmnIds(definitions).referenceFor(
    object,
    typeId,
    object["@_itemSubjectRef"],
  );
  if (
    object.__$$element === "dataObject" &&
    (object["@_isCollection"] !== undefined || type["@_isCollection"])
  )
    object["@_isCollection"] = type["@_isCollection"] ?? false;
}
