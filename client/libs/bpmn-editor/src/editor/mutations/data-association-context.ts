// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDataAssociation,
  BPMN20__tDataInput,
  BPMN20__tDataOutput,
  BPMN20__tInputOutputSpecification,
  BPMN20__tInputSet,
  BPMN20__tOutputSet,
  BPMN20__tProcess,
  BPMN20__tSubProcess,
  BPMN20__tDefinitions,
  BPMNDI__BPMNEdge,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";

export type DataAssociationKind =
  "dataInputAssociation" | "dataOutputAssociation";
export type DataAssociationHost = {
  "@_id"?: string;
  __$$element: string;
  ioSpecification?: BPMN20__tInputOutputSpecification;
  dataInput?: BPMN20__tDataInput[];
  dataOutput?: BPMN20__tDataOutput[];
  inputSet?: BPMN20__tInputSet;
  outputSet?: BPMN20__tOutputSet;
  dataInputAssociation?: BPMN20__tDataAssociation[];
  dataOutputAssociation?: BPMN20__tDataAssociation[];
  eventDefinition?: unknown[];
  eventDefinitionRef?: { __$$text: string }[];
};
export type DataAssociationLocation = {
  host: DataAssociationHost;
  scope: BPMN20__tProcess | BPMN20__tSubProcess;
  association: BPMN20__tDataAssociation;
  kind: DataAssociationKind;
  array: BPMN20__tDataAssociation[];
  index: number;
};

export const isGraphicalDataItem = (kind: string) =>
  ["dataObject", "dataObjectReference", "dataStoreReference"].includes(kind);
export function acceptsDataAssociation(
  host: DataAssociationHost,
  direction: "input" | "output",
) {
  if (
    [
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
    ].includes(host.__$$element)
  )
    return true;
  return (
    direction === "input"
      ? ["endEvent", "intermediateThrowEvent"]
      : ["startEvent", "intermediateCatchEvent", "boundaryEvent"]
  ).includes(host.__$$element);
}

export function scopeDataAssociations(
  scope: BPMN20__tProcess | BPMN20__tSubProcess,
): DataAssociationLocation[] {
  const result: DataAssociationLocation[] = [];
  for (const element of scope.flowElement ?? []) {
    const host = element as DataAssociationHost;
    for (const kind of [
      "dataInputAssociation",
      "dataOutputAssociation",
    ] as const) {
      const array = host[kind] ?? [];
      array.forEach((association, index) =>
        result.push({ host, scope, association, kind, array, index }),
      );
    }
  }
  return result;
}

/** Semantic association endpoints are ItemAwareElement IDREFs. The route's
 * visible activity/event endpoint is only a projection of its owned input or
 * output; persisting the FlowNode ID there would corrupt the BPMN contract.
 * Sources sharing a shape share its route; different visible sources require
 * independent DI routes for the same association, never a lossy first-source
 * projection. sourceId is the first group for single-route callers; route
 * consumers must resolve their explicit sourceElement below. */
export function dataAssociationEndpoints(location: DataAssociationLocation) {
  const { scope, host, association, kind } = location,
    direction = kind === "dataInputAssociation" ? "input" : "output";
  if (!acceptsDataAssociation(host, direction))
    throw new Error("BPMN_INVALID_CONNECTION");
  const inputs = host.ioSpecification?.dataInput ?? host.dataInput ?? [],
    outputs = host.ioSpecification?.dataOutput ?? host.dataOutput ?? [];
  const sources =
      association.sourceRef?.map((ref) => ref.__$$text.trim()) ?? [],
    target = association.targetRef?.__$$text.trim();
  if (!sources.length || !target) throw new Error("BPMN_INVALID_CONNECTION");
  if (
    sources.length > 1 &&
    !association.transformation &&
    !association.assignment?.length
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const visual = new Map<string, string>();
  if ("__$$element" in scope && scope.__$$element === "process")
    for (const item of [
      ...(scope.ioSpecification?.dataInput ?? []),
      ...(scope.ioSpecification?.dataOutput ?? []),
    ])
      if (item["@_id"]) visual.set(item["@_id"], item["@_id"]);
  if (
    (direction === "input" &&
      sources.some((id) =>
        scope.ioSpecification?.dataOutput?.some((item) => item["@_id"] === id),
      )) ||
    (direction === "output" &&
      scope.ioSpecification?.dataInput?.some((item) => item["@_id"] === target))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  for (const element of scope.flowElement ?? []) {
    if (!element["@_id"]) continue;
    if (isGraphicalDataItem(element.__$$element))
      visual.set(element["@_id"], element["@_id"]);
    const owner = element as DataAssociationHost;
    for (const item of [
      ...(owner.ioSpecification?.dataInput ?? owner.dataInput ?? []),
      ...(owner.ioSpecification?.dataOutput ?? owner.dataOutput ?? []),
    ])
      if (item["@_id"]) visual.set(item["@_id"], element["@_id"]);
  }
  if (
    (direction === "input" &&
      !inputs.some((item) => item["@_id"] === target)) ||
    (direction === "output" &&
      sources.some((id) => !outputs.some((item) => item["@_id"] === id)))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const sourceShapes = new Set(sources.map((id) => visual.get(id))),
    targetId = visual.get(target);
  if (!sourceShapes.size || sourceShapes.has(undefined) || !targetId)
    throw new Error("BPMN_INVALID_CONNECTION");
  const sourceIds = [...sourceShapes] as string[],
    sourceId = sourceIds[0];
  if (sourceIds.includes(targetId)) throw new Error("BPMN_INVALID_CONNECTION");
  return {
    sourceId,
    sourceIds,
    sourceByItem: new Map(sources.map((id) => [id, visual.get(id)!])),
    targetId,
    semanticSources: sources,
    semanticTarget: target,
  };
}

/** DI disambiguates a multi-source depiction by its actual source shape. Old
 * single-source routes may omit the redundant shape references; a multi-source
 * route may not guess from waypoint proximity or reference-array order. */
export function dataAssociationRouteEndpoints(
  definitions: BPMN20__tDefinitions,
  location: DataAssociationLocation,
  route: BPMNDI__BPMNEdge,
) {
  const endpoints = dataAssociationEndpoints(location),
    index = indexBpmnIds(definitions);
  const shapeElement = (reference: string | undefined) => {
    if (!reference) return undefined;
    const id = index.resolveReference(route, reference);
    for (const diagram of definitions["bpmndi:BPMNDiagram"] ?? [])
      for (const shape of diagram["bpmndi:BPMNPlane"]?.["di:DiagramElement"] ??
        [])
        if (shape.__$$element === "bpmndi:BPMNShape" && shape["@_id"] === id)
          return index.resolveReference(shape, shape["@_bpmnElement"]);
    throw new Error("BPMN_INVALID_CONNECTION");
  };
  const source = shapeElement(route["@_sourceElement"]),
    target = shapeElement(route["@_targetElement"]);
  if (
    (source && !endpoints.sourceIds.includes(source)) ||
    (target && target !== endpoints.targetId) ||
    (!source && endpoints.sourceIds.length > 1)
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  return { ...endpoints, sourceId: source ?? endpoints.sourceId };
}

/** Real ItemAware IDs available to the graphical mapping, with user-authored
 * names only. Definitions and hidden process properties are not pretend shapes. */
export function dataAssociationSourceItems(location: DataAssociationLocation) {
  const { scope, host, kind } = location,
    result: { id: string; name: string }[] = [];
  const add = (
    item: { "@_id"?: string; "@_name"?: string },
    ownerName?: string,
  ) => {
    if (item["@_id"])
      result.push({
        id: item["@_id"],
        name: ownerName
          ? `${ownerName} / ${item["@_name"] || item["@_id"]}`
          : item["@_name"] || item["@_id"],
      });
  };
  if (kind === "dataOutputAssociation") {
    for (const item of host.ioSpecification?.dataOutput ??
      host.dataOutput ??
      [])
      add(item);
    return result;
  }
  if ("__$$element" in scope && scope.__$$element === "process")
    for (const item of scope.ioSpecification?.dataInput ?? []) add(item);
  for (const element of scope.flowElement ?? []) {
    if (isGraphicalDataItem(element.__$$element)) add(element);
    if (element === host) continue;
    const owner = element as DataAssociationHost;
    for (const item of [
      ...(owner.ioSpecification?.dataInput ?? owner.dataInput ?? []),
      ...(owner.ioSpecification?.dataOutput ?? owner.dataOutput ?? []),
    ])
      add(item, ("@_name" in element && element["@_name"]) || element["@_id"]);
  }
  return result;
}

/** Rebind the semantic slot on the already depicted target. Changing the
 * visible host remains a pointer reconnect, not a hidden geometry edit. */
export function dataAssociationTargetItems(location: DataAssociationLocation) {
  const { host, scope, kind } = location;
  const endpoints = dataAssociationEndpoints(location);
  const target =
    kind === "dataInputAssociation"
      ? host
      : (scope.flowElement?.find(
          (element) => element["@_id"] === endpoints.targetId,
        ) as DataAssociationHost | undefined);
  const inputs = target?.ioSpecification?.dataInput ?? target?.dataInput;
  if (inputs?.some((item) => item["@_id"] === endpoints.semanticTarget))
    return inputs.flatMap((item) =>
      item["@_id"]
        ? [{ id: item["@_id"], name: item["@_name"] || item["@_id"] }]
        : [],
    );
  return [{ id: endpoints.semanticTarget, name: endpoints.semanticTarget }];
}
