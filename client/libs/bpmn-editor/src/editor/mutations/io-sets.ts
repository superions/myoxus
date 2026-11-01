// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tInputOutputSpecification,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { resolveBpmnProcessOwner } from "../../process-source";
import { findConnectionElement } from "./connection";
import { isGlobalTask } from "./global-tasks";
import {
  acceptsDataAssociation,
  type DataAssociationHost,
} from "./data-association-context";
import {
  assertIoSets,
  ioSetKeys,
  isEventIoOwner,
  eventIoSpecification,
  type IoDirection,
  type IoSet,
  type IoSetField,
} from "./io-context";
import { generateUuid } from "../../xyflow/uuid/uuid";
import {
  indexBpmnIds,
  getNewBpmnIdRandomizer,
} from "../idRandomizer/bpmn-id-randomizer";

export function inputOutputOwner(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): DataAssociationHost {
  resolveBpmnProcessOwner(definitions);
  const owner =
    definitions.rootElement?.find((root) => root["@_id"] === id) ??
    findConnectionElement(definitions, id)?.element;
  if (
    !owner ||
    !(
      owner.__$$element === "process" ||
      isGlobalTask(owner as Parameters<typeof isGlobalTask>[0]) ||
      acceptsDataAssociation(owner as DataAssociationHost, "input") ||
      acceptsDataAssociation(owner as DataAssociationHost, "output")
    )
  )
    throw new Error("BPMN_INVALID_IO_SET");
  return owner as DataAssociationHost;
}

/** Read projection only: singleton Event sets and specification arrays share
 * controls, never a new XML owner or read-time creation of default sets. */
export function inputOutputSpecification(
  host: DataAssociationHost,
): BPMN20__tInputOutputSpecification | undefined {
  if (!isEventIoOwner(host)) return host.ioSpecification;
  return eventIoSpecification(host);
}
const setsOf = (
  spec: BPMN20__tInputOutputSpecification | undefined,
  direction: IoDirection,
): IoSet[] =>
  direction === "input" ? (spec?.inputSet ?? []) : (spec?.outputSet ?? []);
function setLocation(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
  id: string | number,
) {
  const host = inputOutputOwner(definitions, ownerId),
    spec = inputOutputSpecification(host),
    sets = setsOf(spec, direction),
    position =
      typeof id === "number" ? id : sets.findIndex((set) => set["@_id"] === id),
    set = sets[position];
  if (!spec || !set) throw new Error("BPMN_INVALID_IO_SET");
  return { host, spec, sets, position, set };
}

export function createIoSet(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
) {
  const host = inputOutputOwner(definitions, ownerId);
  if (isEventIoOwner(host)) {
    if (!acceptsDataAssociation(host, direction))
      throw new Error("BPMN_INVALID_IO_SET");
    if (
      (direction === "input" ? host.dataInput : host.dataOutput)?.some(
        (item) => !item["@_id"],
      )
    )
      throw new Error("BPMN_INVALID_IO_SET");
    if (direction === "input") {
      if (host.inputSet) throw new Error("BPMN_INVALID_IO_SET");
      host.inputSet = {
        "@_id": generateUuid(),
        dataInputRefs: host.dataInput?.map((item) => ({
          __$$text: item["@_id"]!,
        })),
      };
    } else {
      if (host.outputSet) throw new Error("BPMN_INVALID_IO_SET");
      host.outputSet = {
        "@_id": generateUuid(),
        dataOutputRefs: host.dataOutput?.map((item) => ({
          __$$text: item["@_id"]!,
        })),
      };
    }
    return;
  }
  if (!host.ioSpecification) {
    host.ioSpecification = {
      "@_id": generateUuid(),
      inputSet: [{ "@_id": generateUuid() }],
      outputSet: [{ "@_id": generateUuid() }],
    };
    return;
  }
  const key = direction === "input" ? "inputSet" : "outputSet";
  (host.ioSpecification[key] ??= []).push({ "@_id": generateUuid() });
}

export function setIoSetName(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
  id: string | number,
  name: string,
) {
  const { set } = setLocation(definitions, ownerId, direction, id);
  if (name) set["@_name"] = name;
  else delete set["@_name"];
}

/** Validate a prospective set before writes, preserving retained reference
 * wrappers/order. Removing membership explicitly clears its subset links, but
 * cannot orphan a slot which still belongs to the specification. */
export function setIoSetReferences(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
  id: string | number,
  field: IoSetField,
  values: string[],
) {
  const { host, spec, sets, position, set } = setLocation(
      definitions,
      ownerId,
      direction,
      id,
    ),
    key = ioSetKeys[direction][field],
    selected = new Set(values),
    candidate = { ...set };
  if (selected.size !== values.length) throw new Error("BPMN_INVALID_IO_SET");
  const retained =
      set[key]?.filter((ref) => selected.has(ref.__$$text.trim())) ?? [],
    old = new Set(retained.map((ref) => ref.__$$text.trim()));
  candidate[key] = [
    ...retained,
    ...values
      .filter((value) => !old.has(value))
      .map((__$$text) => ({ __$$text })),
  ];
  if (!candidate[key]?.length) delete candidate[key];
  if (field === "members")
    for (const subset of [
      ioSetKeys[direction].optional,
      ioSetKeys[direction].executing,
    ]) {
      candidate[subset] = candidate[subset]?.filter((ref) =>
        selected.has(ref.__$$text.trim()),
      );
      if (!candidate[subset]?.length) delete candidate[subset];
    }
  const next = sets.slice();
  next[position] = candidate;
  assertIoSets(
    { ...spec, [direction === "input" ? "inputSet" : "outputSet"]: next },
    !isEventIoOwner(host),
  );
  for (const key of Object.values(ioSetKeys[direction])) {
    if (candidate[key] !== set[key]) {
      if (candidate[key]) set[key] = candidate[key];
      else delete set[key];
    }
  }
}

export function deleteIoSet(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
  id: string | number,
) {
  const { host, spec, sets, position, set } = setLocation(
    definitions,
    ownerId,
    direction,
    id,
  );
  if (set["@_id"] && indexBpmnIds(definitions).isReferenced(set["@_id"]!))
    throw new Error("BPMN_DEFINITION_IN_USE");
  const remaining = sets.filter((_, index) => index !== position);
  if (
    isEventIoOwner(host) &&
    !remaining.length &&
    (direction === "input" ? host.dataInput?.length : host.dataOutput?.length)
  )
    throw new Error("BPMN_INVALID_IO_SET");
  assertIoSets(
    { ...spec, [direction === "input" ? "inputSet" : "outputSet"]: remaining },
    !isEventIoOwner(host),
  );
  if (isEventIoOwner(host)) {
    if (direction === "input") delete host.inputSet;
    else delete host.outputSet;
  } else sets.splice(position, 1);
}

/** InputSet array order is its evaluation order. Reordering moves the actual
 * element, leaving IDs and counterpart references unchanged. Events are singletons. */
export function moveIoSet(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  direction: IoDirection,
  id: string | number,
  offset: -1 | 1,
) {
  const { host, sets, position, set } = setLocation(
      definitions,
      ownerId,
      direction,
      id,
    ),
    target = position + offset;
  if (isEventIoOwner(host) || target < 0 || target >= sets.length) return;
  sets.splice(position, 1);
  sets.splice(target, 0, set);
}

/** A specification is optional, but its two required set arrays cannot be
 * deleted independently. Explicitly remove the empty owner and internal set
 * links together only after proving no outside consumer needs any owned ID. */
export function deleteEmptyIoSpecification(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
) {
  const host = inputOutputOwner(definitions, ownerId),
    spec = host.ioSpecification;
  if (isEventIoOwner(host) || !spec) throw new Error("BPMN_INVALID_IO_SET");
  if (
    spec.dataInput?.length ||
    spec.dataOutput?.length ||
    host.dataInputAssociation?.length ||
    host.dataOutputAssociation?.length
  )
    throw new Error("BPMN_DEFINITION_IN_USE");
  const all = indexBpmnIds(definitions),
    owned = getNewBpmnIdRandomizer(definitions).ack({
      json: spec,
      parentJson: host,
      type: "BPMN20__tProcess",
      attr: "ioSpecification",
    });
  for (const id of owned.getOriginalIds())
    if (all.referenceCount(id) > owned.referenceCount(id))
      throw new Error("BPMN_DEFINITION_IN_USE");
  delete host.ioSpecification;
}
