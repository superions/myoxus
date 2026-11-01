// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tDataAssociation,
  BPMN20__tInputSet,
  BPMN20__tOutputSet,
  BPMNDI__BPMNEdge,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { connectionElement } from "./connection";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { findProcessIoItem } from "./process-io-context";
import {
  indexBpmnIds,
  getNewBpmnIdRandomizer,
} from "../idRandomizer/bpmn-id-randomizer";
import { getDiscretelyAutoPositionedEdgeParams } from "../../xyflow/maths/Maths";
import {
  acceptsDataAssociation,
  dataAssociationEndpoints,
  dataAssociationRouteEndpoints,
  dataAssociationSourceItems,
  dataAssociationTargetItems,
  isGraphicalDataItem,
  scopeDataAssociations,
  type DataAssociationHost,
  type DataAssociationLocation,
} from "./data-association-context";

export function dataAssociationLocations(
  definitions: Normalized<BPMN20__tDefinitions>,
): DataAssociationLocation[] {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  const result = scopeDataAssociations(process);
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "subProcess" ||
      element.__$$element === "adHocSubProcess" ||
      element.__$$element === "transaction"
    )
      result.push(...scopeDataAssociations(element));
  });
  return result;
}
/** Resolve a semantic mapping ID or one of its secondary DI view identities. */
export function dataAssociationById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const locations = dataAssociationLocations(definitions),
    direct = locations.find((location) => location.association["@_id"] === id);
  if (direct) return direct;
  const { diagramElements } = addOrGetProcessAndDiagramElements({
      definitions,
    }),
    index = indexBpmnIds(definitions),
    route = diagramElements.find(
      (route) =>
        route.__$$element === "bpmndi:BPMNEdge" && route["@_id"] === id,
    );
  const semantic =
    route && index.resolveReference(route, route["@_bpmnElement"]);
  return semantic
    ? locations.find((location) => location.association["@_id"] === semantic)
    : undefined;
}

/** Primary view identity follows the first semantic source group, not DI-array
 * order. Secondary views use their stable DI ID. Imported planes may order
 * those routes arbitrarily; commands capture this route before semantic edits. */
export function dataAssociationRouteById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const { diagramElements } = addOrGetProcessAndDiagramElements({
      definitions,
    }),
    index = indexBpmnIds(definitions);
  const direct = diagramElements.find(
    (route) => route.__$$element === "bpmndi:BPMNEdge" && route["@_id"] === id,
  );
  if (direct?.__$$element === "bpmndi:BPMNEdge") return direct;
  const location = dataAssociationById(definitions, id);
  if (!location) return undefined;
  const first = dataAssociationEndpoints(location).sourceIds[0];
  const route = diagramElements.find(
    (route) =>
      route.__$$element === "bpmndi:BPMNEdge" &&
      index.resolveReference(route, route["@_bpmnElement"]) === id &&
      dataAssociationRouteEndpoints(definitions, location, route).sourceId ===
        first,
  );
  return route?.__$$element === "bpmndi:BPMNEdge" ? route : undefined;
}

export type DataAssociationBinding = { source?: string; target?: string };

/** Only an ambiguous Event payload needs explicit pointer-gesture binding.
 * Reconnecting the same visual endpoint already has a real semantic binding;
 * do not reprompt or replace it because its owner has other payloads. */
export function dataAssociationBindingOptions(
  definitions: Normalized<BPMN20__tDefinitions>,
  sourceId: string,
  targetId: string,
  id?: string,
) {
  const location = id ? dataAssociationById(definitions, id) : undefined;
  const route = id ? dataAssociationRouteById(definitions, id) : undefined;
  const previous = location
    ? route
      ? dataAssociationRouteEndpoints(definitions, location, route)
      : dataAssociationEndpoints(location)
    : undefined;
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  const options = (nodeId: string, input: boolean, unchanged: boolean) => {
    if (unchanged || findProcessIoItem(process, nodeId)) return [];
    const host = connectionElement(definitions, nodeId)
      .element as DataAssociationHost;
    if (!acceptsDataAssociation(host, input ? "input" : "output")) return [];
    if (
      !input &&
      location?.kind === "dataOutputAssociation" &&
      (location.association.sourceRef?.length ?? 0) > 1 &&
      isEventDataHost(host)
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    const slots = input ? host.dataInput : host.dataOutput;
    return (slots?.length ?? 0) > 1
      ? slots!.map((item) => {
          if (!item["@_id"]) throw new Error("BPMN_INVALID_CONNECTION");
          return {
            value: item["@_id"],
            label: `${item["@_name"] || item["@_id"]} (${item["@_id"]})`,
          };
        })
      : [];
  };
  const name = (id: string) => {
    const item =
      findProcessIoItem(process, id)?.element ??
      connectionElement(definitions, id).element;
    return ("@_name" in item && item["@_name"]) || id;
  };
  return {
    source: options(sourceId, false, previous?.sourceId === sourceId),
    target: options(targetId, true, previous?.targetId === targetId),
    sourceName: name(sourceId),
    targetName: name(targetId),
  };
}

/** Pointer endpoints are visual FlowNodes/data items. Create a real owned
 * DataInput/Output and required sets, then bind the association's IDREFs to that
 * slot. DI continues to point at the activity/event shape, never that hidden slot.
 * Same-host reconnect retains its slot. A different activity gets new implicit
 * I/O; an Event reuses its sole unambiguous payload. Neither steals the old
 * host's named/typed/shared contract. Association/expression identities survive
 * that explicit rebind; external-slot retirement waits until reattachment. */
export function upsertDataAssociation(
  definitions: Normalized<BPMN20__tDefinitions>,
  sourceId: string,
  targetId: string,
  id = generateUuid(),
  binding: DataAssociationBinding = {},
): string {
  const { process } = addOrGetProcessAndDiagramElements({ definitions }),
    sourceIo = findProcessIoItem(process, sourceId),
    targetIo = findProcessIoItem(process, targetId);
  const source = sourceIo
      ? {
          owner: process,
          element: { ...sourceIo.element, __$$element: sourceIo.kind },
        }
      : connectionElement(definitions, sourceId),
    target = targetIo
      ? {
          owner: process,
          element: { ...targetIo.element, __$$element: targetIo.kind },
        }
      : connectionElement(definitions, targetId);
  if (source.owner !== target.owner) throw new Error("BPMN_ACTIVITY_SCOPE");
  if (sourceId === targetId) throw new Error("BPMN_INVALID_CONNECTION");
  const sourceData = sourceIo
      ? sourceIo.kind === "dataInput"
      : isGraphicalDataItem(source.element.__$$element),
    targetData = targetIo
      ? targetIo.kind === "dataOutput"
      : isGraphicalDataItem(target.element.__$$element);
  const existing = dataAssociationById(definitions, id);
  const sourceHost = source.element as DataAssociationHost,
    targetHost = target.element as DataAssociationHost;
  const bridge =
    !sourceData &&
    !targetData &&
    acceptsDataAssociation(sourceHost, "output") &&
    acceptsDataAssociation(targetHost, "input");
  if ((sourceData && targetData) || (!sourceData && !targetData && !bridge))
    throw new Error("BPMN_INVALID_CONNECTION");
  // New host-to-host mappings belong to the receiving input. Existing mappings
  // retain their standard owner/direction; each visual host still binds a real
  // output/input slot rather than persisting either FlowNode ID as an endpoint.
  const input =
    sourceData || (bridge && existing?.kind !== "dataOutputAssociation");
  const host = (input ? target.element : source.element) as DataAssociationHost,
    kind = input ? "dataInputAssociation" : "dataOutputAssociation",
    direction = input ? "input" : "output";
  if (!acceptsDataAssociation(host, direction))
    throw new Error("BPMN_INVALID_CONNECTION");
  const route = dataAssociationRouteById(definitions, id);
  const previous = existing
    ? route
      ? dataAssociationRouteEndpoints(definitions, existing, route)
      : dataAssociationEndpoints(existing)
    : undefined;
  if (existing) id = existing.association["@_id"]!;
  const retired = existing
    ? [
        ...(existing.association.sourceRef?.map((ref) => ref.__$$text.trim()) ??
          []),
        existing.association.targetRef.__$$text.trim(),
      ]
    : [];
  const externalSource = () =>
    sourceData ? sourceId : appendDataPort(sourceHost, false, binding.source);
  const externalTarget = () =>
    targetData
      ? targetId
      : existing && previous?.targetId === targetId
        ? existing.association.targetRef.__$$text
        : appendDataPort(targetHost, true, binding.target);
  const replaceSource = (association: BPMN20__tDataAssociation) => {
    if (!previous || previous.sourceId === sourceId) return;
    if (previous.sourceIds.includes(sourceId))
      throw new Error("BPMN_INVALID_CONNECTION");
    const replacement = externalSource();
    let replaced = false;
    association.sourceRef = association.sourceRef?.flatMap((ref) => {
      if (previous.sourceByItem.get(ref.__$$text.trim()) !== previous.sourceId)
        return [ref];
      if (replaced) return [];
      replaced = true;
      return [{ ...ref, __$$text: replacement }];
    });
  };
  // Several independent associations may depict the same visual host pair:
  // their real payload bindings/expressions and semantic lifetimes stay distinct.
  // Visual coincidence is not semantic duplication or a shared fan-in mapping.
  if (existing) {
    if (existing.host !== host || existing.kind !== kind) {
      const bindings = indexBpmnIds(definitions).namespaceDeclarationsFor(
        existing.association,
      );
      const association = removeDataAssociation(definitions, id, true)!;
      // The new host may shadow namespaces inherited by expressions at the old
      // owner. Carry those bindings before attaching the same semantic object.
      if (existing.host !== host) Object.assign(association, bindings);
      if (input) {
        if (existing.kind !== kind)
          association.sourceRef = [{ __$$text: externalSource() }];
        else replaceSource(association);
        association.targetRef.__$$text = appendDataPort(
          host,
          true,
          binding.target,
        );
      } else {
        const count =
          existing.kind === kind
            ? Math.max(1, association.sourceRef?.length ?? 0)
            : 1;
        // A single Event choice cannot represent several distinct semantic
        // outputs. Reject instead of collapsing them to repeated IDREFs.
        if (count > 1 && isEventDataHost(host))
          throw new Error("BPMN_INVALID_CONNECTION");
        association.sourceRef = Array.from({ length: count }, () => ({
          __$$text: appendDataPort(host, false, binding.source),
        }));
        association.targetRef.__$$text = externalTarget();
      }
      (host[kind] ??= []).push(association);
      retireExternalDataAssociationSlots(definitions, retired);
      return id;
    }
    if (input) {
      replaceSource(existing.association);
    } else if (previous!.targetId !== targetId)
      existing.association.targetRef = { __$$text: externalTarget() };
    retireExternalDataAssociationSlots(definitions, retired);
    return id;
  }
  const portId = appendDataPort(
    host,
    input,
    input ? binding.target : binding.source,
  );
  const association: BPMN20__tDataAssociation = {
    "@_id": id,
    sourceRef: [{ __$$text: input ? externalSource() : portId }],
    targetRef: { __$$text: input ? portId : externalTarget() },
  };
  (host[kind] ??= []).push(association);
  return id;
}

function isEventDataHost(host: DataAssociationHost) {
  return [
    "startEvent",
    "intermediateCatchEvent",
    "boundaryEvent",
    "endEvent",
    "intermediateThrowEvent",
  ].includes(host.__$$element);
}

function appendDataPort(
  host: DataAssociationHost,
  input: boolean,
  selected?: string,
): string {
  if (selected) {
    const data = host.ioSpecification ?? host;
    if (
      !(input ? data.dataInput : data.dataOutput)?.some(
        (item) => item["@_id"] === selected,
      )
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    return selected;
  }
  const event = isEventDataHost(host);
  if (event) {
    const existing = input ? host.dataInput : host.dataOutput;
    // An Event slot is its payload contract, not one fresh port per route.
    // Reuse an unambiguous payload; never append past several definition-bound
    // slots or guess which payload an arbitrary first array entry represents.
    if ((existing?.length ?? 0) > 1) throw new Error("BPMN_INVALID_CONNECTION");
    if (existing?.[0]) return (existing[0]["@_id"] ??= generateUuid());
  }
  if (!event)
    host.ioSpecification ??= {
      "@_id": generateUuid(),
      inputSet: [{ "@_id": generateUuid() }],
      outputSet: [{ "@_id": generateUuid() }],
    };
  const data = event ? host : host.ioSpecification!,
    portId = generateUuid();
  if (input) {
    (data.dataInput ??= []).push({ "@_id": portId });
    let set: BPMN20__tInputSet;
    if (event) set = host.inputSet ??= { "@_id": generateUuid() };
    else
      set = (host.ioSpecification!.inputSet ??= [
        { "@_id": generateUuid() },
      ])[0];
    (set.dataInputRefs ??= []).push({ __$$text: portId });
  } else {
    (data.dataOutput ??= []).push({ "@_id": portId });
    let set: BPMN20__tOutputSet;
    if (event) set = host.outputSet ??= { "@_id": generateUuid() };
    else
      set = (host.ioSpecification!.outputSet ??= [
        { "@_id": generateUuid() },
      ])[0];
    (set.dataOutputRefs ??= []).push({ __$$text: portId });
  }
  return portId;
}

/** Reverse semantic direction and route orientation inside the caller's single
 * history transaction. Interior manual geometry, labels and DI identity stay
 * authored; invalid catch/throw contexts reject before changing either owner. */
export function reverseDataAssociation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const location = dataAssociationById(definitions, id);
  if (!location) throw new Error("BPMN_INVALID_CONNECTION");
  const { sourceId, targetId } = dataAssociationEndpoints(location),
    index = indexBpmnIds(definitions),
    { diagramElements } = addOrGetProcessAndDiagramElements({ definitions });
  if (dataAssociationEndpoints(location).sourceIds.length > 1)
    throw new Error("BPMN_INVALID_CONNECTION");
  const edge = diagramElements.find(
    (edge) =>
      edge.__$$element === "bpmndi:BPMNEdge" &&
      index.resolveReference(edge, edge["@_bpmnElement"]) === id,
  );
  if (edge?.__$$element !== "bpmndi:BPMNEdge")
    throw new Error("BPMN_INVALID_CONNECTION");
  upsertDataAssociation(definitions, targetId, sourceId, id);
  edge["di:waypoint"]?.reverse();
  const source = edge["@_sourceElement"],
    target = edge["@_targetElement"];
  if (target) edge["@_sourceElement"] = target;
  else delete edge["@_sourceElement"];
  if (source) edge["@_targetElement"] = source;
  else delete edge["@_targetElement"];
}

/** Only anonymous slots whose entire remaining use is set membership can retire
 * with an association. Named/typed/annotated/shared I/O is an independent contract
 * and survives, as do every ItemDefinition and external data object/store. This
 * structural rule needs no private XML marker or session-only provenance. */
export function removeDataAssociation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  deferExternalCleanup = false,
): BPMN20__tDataAssociation | undefined {
  const location = dataAssociationById(definitions, id);
  if (!location) return undefined;
  return removeLocatedDataAssociation(
    definitions,
    location,
    deferExternalCleanup,
  );
}

/** Semantic deletion also handles imported ID-less, non-graphical mappings. */
export function removeLocatedDataAssociation(
  definitions: Normalized<BPMN20__tDefinitions>,
  location: DataAssociationLocation,
  deferExternalCleanup = false,
): BPMN20__tDataAssociation {
  const { host, association, kind, array } = location;
  const index = array.indexOf(association);
  if (index < 0) throw new Error("BPMN_INVALID_CONNECTION");
  const ids =
    kind === "dataInputAssociation"
      ? [association.targetRef?.__$$text.trim()]
      : (association.sourceRef?.map((ref) => ref.__$$text.trim()) ?? []);
  array.splice(index, 1);
  if (!array.length) delete host[kind];
  retireDataAssociationSlots(definitions, host, kind, ids);
  if (!deferExternalCleanup)
    retireExternalDataAssociationSlots(definitions, [
      ...(association.sourceRef?.map((ref) => ref.__$$text.trim()) ?? []),
      association.targetRef.__$$text.trim(),
    ]);
  return association;
}

/** A direct host bridge can own implicit I/O at both ends. Run this after the
 * mapping is retired or fully rebound so surviving references protect reused
 * slots. Only anonymous activity/Event slots participate; the process interface
 * and definitions roots remain independent contracts even when unnamed. */
export function retireExternalDataAssociationSlots(
  definitions: Normalized<BPMN20__tDefinitions>,
  ids: string[],
) {
  if (!ids.length) return;
  const { process } = addOrGetProcessAndDiagramElements({ definitions }),
    candidates = new Set(ids);
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    const host = element as DataAssociationHost;
    for (const kind of [
      "dataInputAssociation",
      "dataOutputAssociation",
    ] as const) {
      const data = host.ioSpecification ?? host,
        items =
          kind === "dataInputAssociation" ? data.dataInput : data.dataOutput;
      if (items?.some((item) => !!item["@_id"] && candidates.has(item["@_id"])))
        retireDataAssociationSlots(definitions, host, kind, ids);
    }
  });
}

function retireDataAssociationSlots(
  definitions: Normalized<BPMN20__tDefinitions>,
  host: DataAssociationHost,
  kind: DataAssociationLocation["kind"],
  ids: (string | undefined)[],
) {
  // EventDefinition-to-payload correspondence is positional, not an IDREF that
  // the reference counter can see. Defined payload slots outlive their routes.
  if (host.eventDefinition?.length || host.eventDefinitionRef?.length) return;
  const data = host.ioSpecification ?? host,
    input = kind === "dataInputAssociation",
    items = (input ? data.dataInput : data.dataOutput) ?? [],
    sets = input
      ? (host.ioSpecification?.inputSet ??
        (host.inputSet ? [host.inputSet] : []))
      : (host.ioSpecification?.outputSet ??
        (host.outputSet ? [host.outputSet] : []));
  for (const portId of ids) {
    const item = items.find((item) => item["@_id"] === portId);
    if (!item || !portId || Object.keys(item).some((key) => key !== "@_id"))
      continue;
    let membership = 0;
    for (const set of sets) {
      const refs = input
        ? (set as BPMN20__tInputSet).dataInputRefs
        : (set as BPMN20__tOutputSet).dataOutputRefs;
      membership += (refs ?? []).filter(
        (ref) => ref.__$$text.trim() === portId,
      ).length;
    }
    if (indexBpmnIds(definitions).referenceCount(portId) !== membership)
      continue;
    items.splice(items.indexOf(item), 1);
    for (const set of sets) {
      if (input) {
        const owner = set as BPMN20__tInputSet;
        owner.dataInputRefs = owner.dataInputRefs?.filter(
          (ref) => ref.__$$text.trim() !== portId,
        );
        if (!owner.dataInputRefs?.length) delete owner.dataInputRefs;
      } else {
        const owner = set as BPMN20__tOutputSet;
        owner.dataOutputRefs = owner.dataOutputRefs?.filter(
          (ref) => ref.__$$text.trim() !== portId,
        );
        if (!owner.dataOutputRefs?.length) delete owner.dataOutputRefs;
      }
    }
  }
  if (!items.length) {
    if (input) delete data.dataInput;
    else delete data.dataOutput;
  }
  const references = indexBpmnIds(definitions),
    emptySet = (set: BPMN20__tInputSet | BPMN20__tOutputSet) =>
      Object.keys(set).every((key) => key === "@_id") &&
      (!set["@_id"] || !references.isReferenced(set["@_id"]));
  if (
    host.ioSpecification &&
    Object.keys(host.ioSpecification).every((key) =>
      ["@_id", "inputSet", "outputSet"].includes(key),
    ) &&
    [
      ...(host.ioSpecification.inputSet ?? []),
      ...(host.ioSpecification.outputSet ?? []),
    ].every(emptySet) &&
    (!host.ioSpecification["@_id"] ||
      !references.isReferenced(host.ioSpecification["@_id"]))
  )
    delete host.ioSpecification;
  if (host.inputSet && emptySet(host.inputSet)) delete host.inputSet;
  if (host.outputSet && emptySet(host.outputSet)) delete host.outputSet;
}

/** Source edits retain the same semantic mapping and every surviving authored
 * branch. Add DI only for newly visible source groups; removing a branch never
 * replaces another branch's geometry or the mapping's expressions. */
export function setDataAssociationSources(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  values: string[],
) {
  const location = dataAssociationById(definitions, id);
  if (!location) throw new Error("BPMN_INVALID_CONNECTION");
  const { association } = location,
    index = indexBpmnIds(definitions),
    selected = new Set(values),
    choices = new Set(
      dataAssociationSourceItems(location).map((item) => item.id),
    );
  if (
    !values.length ||
    selected.size !== values.length ||
    values.some((value) => !choices.has(value))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const oldEndpoints = dataAssociationEndpoints(location),
    retained =
      association.sourceRef?.filter((ref) =>
        selected.has(ref.__$$text.trim()),
      ) ?? [],
    old = new Set(retained.map((ref) => ref.__$$text.trim())),
    sourceRef = [
      ...retained,
      ...values
        .filter((value) => !old.has(value))
        .map((__$$text) => ({ __$$text })),
    ];
  const next = dataAssociationEndpoints({
      ...location,
      association: { ...association, sourceRef },
    }),
    { diagramElements } = addOrGetProcessAndDiagramElements({ definitions }),
    routes = diagramElements.filter(
      (
        route,
      ): route is Normalized<BPMNDI__BPMNEdge> & {
        __$$element: "bpmndi:BPMNEdge";
      } =>
        route.__$$element === "bpmndi:BPMNEdge" &&
        index.resolveReference(route, route["@_bpmnElement"]) ===
          association["@_id"],
    ),
    bySource = new Map(
      routes.map((route) => [
        dataAssociationRouteEndpoints(definitions, location, route).sourceId,
        route,
      ]),
    );
  if (!routes.length) throw new Error("BPMN_INVALID_CONNECTION");
  const obsolete = routes.filter(
    (route) =>
      !next.sourceIds.includes(
        dataAssociationRouteEndpoints(definitions, location, route).sourceId,
      ),
  );
  for (const route of obsolete) {
    const owned = getNewBpmnIdRandomizer(definitions).ack({
      json: [route],
      type: "BPMNDI__BPMNPlane",
      attr: "di:DiagramElement",
      __$$element: "bpmndi:BPMNEdge",
    });
    for (const id of owned.getOriginalIds())
      if (index.referenceCount(id) > owned.referenceCount(id))
        throw new Error("BPMN_DEFINITION_IN_USE");
  }
  const shapeFor = (id: string) => {
    const shape = diagramElements.find(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        index.resolveReference(shape, shape["@_bpmnElement"]) === id,
    );
    if (shape?.__$$element !== "bpmndi:BPMNShape")
      throw new Error("BPMN_INVALID_CONNECTION");
    return shape;
  };
  const target = shapeFor(next.targetId),
    sources = next.sourceIds.map((id) => ({ id, shape: shapeFor(id) }));
  association.sourceRef = sourceRef;
  for (const route of obsolete)
    diagramElements.splice(diagramElements.indexOf(route), 1);
  for (const { id, shape } of sources) {
    const current = bySource.get(id);
    if (current) {
      if (next.sourceIds.length > 1) {
        current["@_sourceElement"] = index.referenceFor(
          current,
          shape["@_id"],
          current["@_sourceElement"],
        );
        current["@_targetElement"] = index.referenceFor(
          current,
          target["@_id"],
          current["@_targetElement"],
        );
      }
      continue;
    }
    const bounds = (shape: typeof target) => ({
        x: shape["dc:Bounds"]["@_x"],
        y: shape["dc:Bounds"]["@_y"],
        width: shape["dc:Bounds"]["@_width"],
        height: shape["dc:Bounds"]["@_height"],
      }),
      points = getDiscretelyAutoPositionedEdgeParams(
        bounds(shape),
        bounds(target),
        undefined,
      ),
      route: Normalized<BPMNDI__BPMNEdge> = {
        "@_id": generateUuid(),
        "di:waypoint": [
          { "@_x": points.sx, "@_y": points.sy },
          { "@_x": points.tx, "@_y": points.ty },
        ],
      };
    diagramElements.push({ ...route, __$$element: "bpmndi:BPMNEdge" });
    const entry = diagramElements[diagramElements.length - 1];
    if (entry.__$$element !== "bpmndi:BPMNEdge")
      throw new Error("BPMN_INVALID_CONNECTION");
    const currentIndex = indexBpmnIds(definitions);
    entry["@_bpmnElement"] = currentIndex.referenceFor(
      entry,
      association["@_id"]!,
    )!;
    entry["@_sourceElement"] = currentIndex.referenceFor(entry, shape["@_id"])!;
    entry["@_targetElement"] = currentIndex.referenceFor(
      entry,
      target["@_id"],
    )!;
  }
  retireExternalDataAssociationSlots(
    definitions,
    oldEndpoints.semanticSources.filter((id) => !selected.has(id)),
  );
}

/** Slot-only target binding preserves every authored branch and expression.
 * Retire the former implicit target only after the new reference is attached;
 * named/typed/shared/definition-bound payloads remain independent contracts. */
export function setDataAssociationTarget(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  target: string,
) {
  const location = dataAssociationById(definitions, id);
  if (
    !location ||
    !dataAssociationTargetItems(location).some((item) => item.id === target)
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const previous = dataAssociationEndpoints(location);
  const next = dataAssociationEndpoints({
    ...location,
    association: {
      ...location.association,
      targetRef: { ...location.association.targetRef, __$$text: target },
    },
  });
  if (next.targetId !== previous.targetId)
    throw new Error("BPMN_INVALID_CONNECTION");
  if (previous.semanticTarget === target) return;
  location.association.targetRef.__$$text = target;
  retireExternalDataAssociationSlots(definitions, [previous.semanticTarget]);
}

export function setDataAssociationTransformation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  text: string,
) {
  const association = dataAssociationById(definitions, id)?.association;
  if (!association) throw new Error("BPMN_INVALID_CONNECTION");
  if (text) {
    association.transformation ??= { "@_id": generateUuid() };
    association.transformation.__$$text = text;
  } else {
    if (
      (association.sourceRef?.length ?? 0) > 1 &&
      !association.assignment?.length
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    if (
      association.transformation?.["@_id"] &&
      indexBpmnIds(definitions).isReferenced(association.transformation["@_id"])
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
    delete association.transformation;
  }
}

export function setDataAssociationDocumentation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  text: string,
) {
  const association = dataAssociationById(definitions, id)?.association;
  if (!association) throw new Error("BPMN_INVALID_CONNECTION");
  if (!text && !association.documentation?.length) return;
  association.documentation ??= [];
  association.documentation[0] ??= { "@_id": generateUuid() };
  association.documentation[0].__$$text = text;
}
export function addDataAssignment(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const association = dataAssociationById(definitions, id)?.association;
  if (!association) throw new Error("BPMN_INVALID_CONNECTION");
  (association.assignment ??= []).push({
    "@_id": generateUuid(),
    from: { "@_id": generateUuid(), __$$text: "" },
    to: { "@_id": generateUuid(), __$$text: "" },
  });
}
/** ID-bearing assignments resolve by identity. For an imported assignment which
 * omits its optional ID, the synchronous inspector command borrows its current
 * array position without inventing XML identities or rebuilding sibling rows. */
export function editDataAssignment(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  assignmentId: string | number,
  field: "from" | "to",
  text: string,
) {
  const assignments = dataAssociationById(definitions, id)?.association
    .assignment;
  const assignment =
    typeof assignmentId === "number"
      ? assignments?.[assignmentId]
      : assignments?.find((assignment) => assignment["@_id"] === assignmentId);
  if (!assignment) throw new Error("BPMN_INVALID_CONNECTION");
  assignment[field].__$$text = text;
}
export function removeDataAssignment(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  assignmentId: string | number,
) {
  const association = dataAssociationById(definitions, id)?.association,
    assignment =
      typeof assignmentId === "number"
        ? association?.assignment?.[assignmentId]
        : association?.assignment?.find(
            (assignment) => assignment["@_id"] === assignmentId,
          );
  if (!association || !assignment) throw new Error("BPMN_INVALID_CONNECTION");
  if (
    !association.transformation &&
    (association.sourceRef?.length ?? 0) > 1 &&
    association.assignment?.length === 1
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const index = indexBpmnIds(definitions);
  for (const element of [assignment, assignment.from, assignment.to])
    if (element["@_id"] && index.isReferenced(element["@_id"]))
      throw new Error("BPMN_DEFINITION_IN_USE");
  association.assignment!.splice(
    association.assignment!.indexOf(assignment),
    1,
  );
  if (!association.assignment!.length) delete association.assignment;
}
