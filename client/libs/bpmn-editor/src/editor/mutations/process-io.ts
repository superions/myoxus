// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import {
  indexBpmnIds,
  getNewBpmnIdRandomizer,
} from "../idRandomizer/bpmn-id-randomizer";
import { createIoSet } from "./io-sets";
import { generateUuid } from "../../xyflow/uuid/uuid";
import {
  dataAssociationLocations,
  removeLocatedDataAssociation,
} from "./data-association";
import { deleteEdge } from "./deleteEdge";
import {
  findProcessIoItem,
  type ProcessIoItem,
  type ProcessIoKind,
} from "./process-io-context";

/** Palette entry for a real process-owned interface item. IDs belong to the
 * caller's command; shared ItemDefinitions are never duplicated.
 * Required set membership is created explicitly, not inferred while rendering. */
export function appendProcessIoItem(
  definitions: Normalized<BPMN20__tDefinitions>,
  kind: ProcessIoKind,
  item: Normalized<ProcessIoItem>,
) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions }),
    index = indexBpmnIds(definitions),
    incoming = getNewBpmnIdRandomizer(definitions).ack({
      json: [item],
      type: "BPMN20__tInputOutputSpecification",
      attr: kind,
    });
  if (
    !item["@_id"] ||
    [...incoming.getOriginalIds()].some((id) => index.getOriginalIds().has(id))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (!process.ioSpecification)
    createIoSet(
      definitions,
      process["@_id"],
      kind === "dataInput" ? "input" : "output",
    );
  const spec = process.ioSpecification!;
  if (kind === "dataInput") {
    (spec.dataInput ??= []).push(item);
    (spec.inputSet[0].dataInputRefs ??= []).push({ __$$text: item["@_id"] });
  } else {
    (spec.dataOutput ??= []).push(item);
    (spec.outputSet[0].dataOutputRefs ??= []).push({ __$$text: item["@_id"] });
  }
}

export function setProcessIoDetails(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  change: {
    name?: string;
    documentation?: string;
    state?: string;
    collection?: boolean;
    itemId?: string | null;
  },
) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions }),
    location = findProcessIoItem(process, id);
  if (!location) throw new Error("BPMN_INVALID_CONNECTION");
  const item = location.element,
    index = indexBpmnIds(definitions);
  const selected = change.itemId
    ? definitions.rootElement?.find(
        (root) =>
          root.__$$element === "itemDefinition" &&
          root["@_id"] === change.itemId,
      )
    : undefined;
  if (change.itemId && selected?.__$$element !== "itemDefinition")
    throw new Error("BPMN_INVALID_CONNECTION");
  if (
    change.state === "" &&
    item.dataState?.["@_id"] &&
    index.isReferenced(item.dataState["@_id"])
  )
    throw new Error("BPMN_DEFINITION_IN_USE");
  const typed =
      change.itemId === null
        ? false
        : !!change.itemId || !!item["@_itemSubjectRef"],
    collection =
      selected?.__$$element === "itemDefinition"
        ? (selected["@_isCollection"] ?? false)
        : (item["@_isCollection"] ?? false);
  if (
    change.collection !== undefined &&
    typed &&
    change.collection !== collection
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (change.itemId !== undefined) {
    if (change.itemId === null) delete item["@_itemSubjectRef"];
    else {
      const type = definitions.rootElement?.find(
        (root) =>
          root.__$$element === "itemDefinition" &&
          root["@_id"] === change.itemId,
      );
      if (type?.__$$element !== "itemDefinition")
        throw new Error("BPMN_INVALID_CONNECTION");
      item["@_itemSubjectRef"] = index.referenceFor(
        item,
        change.itemId,
        item["@_itemSubjectRef"],
      );
      if (item["@_isCollection"] !== undefined || type["@_isCollection"])
        item["@_isCollection"] = type["@_isCollection"] ?? false;
    }
  }
  if (change.collection !== undefined)
    item["@_isCollection"] = change.collection;
  if (change.name !== undefined) {
    if (change.name) item["@_name"] = change.name;
    else delete item["@_name"];
  }
  if (change.documentation !== undefined) {
    if (change.documentation || item.documentation?.length) {
      item.documentation ??= [];
      item.documentation[0] ??= { "@_id": generateUuid() };
      item.documentation[0].__$$text = change.documentation;
    }
  }
  if (change.state !== undefined) {
    if (change.state) {
      item.dataState ??= { "@_id": generateUuid() };
      item.dataState["@_name"] = change.state;
    } else delete item.dataState;
  }
}

/** Deleting an interface item is semantic, not merely removing its shape.
 * Check incoming set/association consumers before writes; unknown references
 * to any retired child abort the enclosing history transaction. Shared roots
 * outlive the item. */
export function deleteProcessIoItem(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
      definitions,
    }),
    location = findProcessIoItem(process, id);
  if (!location) throw new Error("BPMN_INVALID_CONNECTION");
  const index = indexBpmnIds(definitions),
    sets =
      location.kind === "dataInput"
        ? process.ioSpecification!.inputSet
        : process.ioSpecification!.outputSet,
    keys =
      location.kind === "dataInput"
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
  const associations = dataAssociationLocations(definitions).filter(
      ({ association }) =>
        association.sourceRef?.some((ref) => ref.__$$text.trim() === id) ||
        association.targetRef.__$$text.trim() === id,
    ),
    artifacts = (process.artifact ?? []).filter(
      (element) =>
        element.__$$element === "association" &&
        (index.resolveReference(element, element["@_sourceRef"]) === id ||
          index.resolveReference(element, element["@_targetRef"]) === id),
    );
  let handled = diagramElements.filter(
    (shape) => index.resolveReference(shape, shape["@_bpmnElement"]) === id,
  ).length;
  for (const set of sets)
    for (const key of keys)
      handled +=
        (
          (set as Record<string, unknown>)[key] as
            { __$$text: string }[] | undefined
        )?.filter((ref) => ref.__$$text.trim() === id).length ?? 0;
  for (const { association } of associations)
    handled +=
      (association.sourceRef?.filter((ref) => ref.__$$text.trim() === id)
        .length ?? 0) + (association.targetRef.__$$text.trim() === id ? 1 : 0);
  for (const artifact of artifacts)
    if (artifact.__$$element === "association")
      handled +=
        (index.resolveReference(artifact, artifact["@_sourceRef"]) === id
          ? 1
          : 0) +
        (index.resolveReference(artifact, artifact["@_targetRef"]) === id
          ? 1
          : 0);
  if (index.referenceCount(id) > handled)
    throw new Error("BPMN_DEFINITION_IN_USE");
  if (
    location.element.dataState?.["@_id"] &&
    index.isReferenced(location.element.dataState["@_id"])
  )
    throw new Error("BPMN_DEFINITION_IN_USE");
  for (const location of associations) {
    const { association } = location;
    if (association["@_id"])
      deleteEdge({ definitions, __readonly_edgeId: association["@_id"] });
    else removeLocatedDataAssociation(definitions, location);
  }
  for (const artifact of artifacts) {
    if (artifact["@_id"])
      deleteEdge({ definitions, __readonly_edgeId: artifact["@_id"] });
    else process.artifact!.splice(process.artifact!.indexOf(artifact), 1);
  }
  for (const set of sets)
    for (const key of keys) {
      const owner = set as Record<string, unknown>,
        refs = owner[key] as { __$$text: string }[] | undefined;
      if (refs) {
        const retained = refs.filter((ref) => ref.__$$text.trim() !== id);
        if (retained.length) owner[key] = retained;
        else delete owner[key];
      }
    }
  location.array.splice(location.array.indexOf(location.element), 1);
  if (!location.array.length) delete process.ioSpecification![location.kind];
  const shapeIndex = diagramElements.findIndex(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        index.resolveReference(shape, shape["@_bpmnElement"]) === id,
    ),
    shape =
      shapeIndex < 0 ? undefined : diagramElements.splice(shapeIndex, 1)[0];
  const remaining = indexBpmnIds(definitions),
    ids = remaining.getOriginalIds();
  for (const owned of index.getOriginalIds())
    if (!ids.has(owned) && remaining.isReferenced(owned))
      throw new Error("BPMN_DEFINITION_IN_USE");
  return {
    element: { ...location.element, __$$element: location.kind },
    shape,
  };
}
