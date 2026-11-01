/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus; see provenance.json for retained source and patches.

import { type State } from "../store/Store";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import {
  visitFlowElementsAndArtifacts,
  visitLanes,
  visitProcessLanes,
  type ElementVisitorArgs,
  type LaneVisitorArgs,
} from "./element-visitor";
import { addOrGetLanes } from "./addOrGetLanes";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { activityById } from "./activity";
import { assertSubProcessContext } from "./activity-context";
import { assertEventContext } from "./event";
import { dataAssociationLocations } from "./data-association";
import { dataAssociationEndpoints } from "./data-association-context";
import { findProcessIoItem } from "./process-io-context";
export function moveNodesInsideSubProcess({
  definitions,
  __readonly_subProcessId,
  __readonly_nodeIds,
}: {
  definitions: State["bpmn"]["model"]["definitions"];
  __readonly_subProcessId: string | undefined;
  __readonly_nodeIds: string[];
}) {
  if (!__readonly_subProcessId) throw new Error("BPMN_SUBPROCESS_NOT_FOUND");
  reassignFlowSelection({
    definitions,
    targetOwnerId: __readonly_subProcessId,
    nodeIds: __readonly_nodeIds,
  });
}

/** Reparent actual flow/artifact owners at any depth. Connected selected roots
 * travel with their shared internal edges; a crossing edge rejects before any
 * writes. Carry boundary siblings with their host and never turn containment
 * into a cycle or rebuild a selected descendant twice. DI stays absolute and is
 * owned by the enclosing pointer/history gesture, not this semantic command. */
export function reassignFlowSelection({
  definitions,
  targetOwnerId,
  nodeIds,
}: {
  definitions: State["bpmn"]["model"]["definitions"];
  targetOwnerId?: string;
  nodeIds: string[];
}) {
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const target =
    !targetOwnerId || targetOwnerId === process["@_id"]
      ? process
      : activityById(definitions, targetOwnerId);
  if (
    target !== process &&
    target.__$$element !== "subProcess" &&
    target.__$$element !== "adHocSubProcess" &&
    target.__$$element !== "transaction"
  )
    throw new Error("BPMN_SUBPROCESS_NOT_FOUND");
  const destination = target as ElementVisitorArgs["owner"];
  // A process interface may overlap a lane geometrically but cannot change its
  // semantic owner into a subprocess flow array. Reject the complete gesture.
  if (
    nodeIds.some((id) => !!findProcessIoItem(process, id)) &&
    destination !== process
  )
    throw new Error("BPMN_ACTIVITY_SCOPE");
  nodeIds = nodeIds.filter((id) => !findProcessIoItem(process, id));
  if (!nodeIds.length) return;
  const locations = new Map<string, ElementVisitorArgs>();
  visitFlowElementsAndArtifacts(process, (location) => {
    locations.set(location.element["@_id"], location);
  });
  const lanes = new Map<
    string,
    LaneVisitorArgs & { scope: ElementVisitorArgs["owner"] }
  >();
  visitProcessLanes(process, (location) => {
    lanes.set(location.lane["@_id"], location);
  });
  if (nodeIds.some((id) => !locations.has(id) && !lanes.has(id)))
    throw new Error("BPMN_ACTIVITY_SCOPE");
  const selectedContainers = new Set(nodeIds);
  nodeIds = nodeIds.filter((id) => {
    for (
      let owner = lanes.get(id)?.scope ?? locations.get(id)?.owner;
      owner && owner !== process;
      owner = locations.get(owner["@_id"])?.owner
    )
      if (selectedContainers.has(owner["@_id"])) return false;
    return true;
  });
  const selectedLanes = new Set(nodeIds.filter((id) => lanes.has(id)));
  const laneRoots = new Set(
    [...selectedLanes].filter((id) => {
      for (
        let parent = lanes.get(id)?.parentLane;
        parent;
        parent = lanes.get(parent["@_id"])?.parentLane
      )
        if (selectedLanes.has(parent["@_id"])) return false;
      return true;
    }),
  );
  const carriedLanes = new Set<string>();
  const memberIds = new Set(nodeIds.filter((id) => locations.has(id)));
  for (const [id, { lane, parentLane }] of lanes)
    if (
      laneRoots.has(id) ||
      (parentLane && carriedLanes.has(parentLane["@_id"]))
    ) {
      carriedLanes.add(id);
      for (const ref of lane.flowNodeRef ?? [])
        memberIds.add(ref.__$$text.trim());
    }
  nodeIds = [...memberIds];
  const selected = new Set(nodeIds);
  const ancestorsOf = (id: string) => {
    const ancestors = new Set<string>();
    for (
      let owner = locations.get(id)?.owner;
      owner && owner !== process;
      owner = locations.get(owner["@_id"])?.owner
    ) {
      if (ancestors.has(owner["@_id"])) throw new Error("BPMN_ACTIVITY_CYCLE");
      ancestors.add(owner["@_id"]);
    }
    return ancestors;
  };
  if (
    selected.has(destination["@_id"]) ||
    [...ancestorsOf(destination["@_id"])].some((id) => selected.has(id))
  )
    throw new Error("BPMN_ACTIVITY_CYCLE");
  const roots = new Set(
    nodeIds.filter(
      (id) => ![...ancestorsOf(id)].some((parent) => selected.has(parent)),
    ),
  );
  const references = indexBpmnIds(definitions);
  for (const [id, location] of locations) {
    if (
      location.element.__$$element === "boundaryEvent" &&
      roots.has(
        references.resolveReference(
          location.element,
          location.element["@_attachedToRef"],
        )!,
      )
    )
      roots.add(id);
  }
  const moved = new Set(
    [...roots].filter((id) => locations.get(id)!.owner !== destination),
  );
  // A same-scope dataObjectRef cannot follow one side of a reparenting command.
  // Moving an enclosing subprocess carries its complete subtree unchanged.
  for (const { element, owner } of locations.values()) {
    if (
      element.__$$element !== "dataObjectReference" ||
      !element["@_dataObjectRef"]
    )
      continue;
    const target = locations.get(element["@_dataObjectRef"].trim());
    if (!target || target.element.__$$element !== "dataObject")
      throw new Error("BPMN_ACTIVITY_SCOPE");
    const referenceOwner = moved.has(element["@_id"]) ? destination : owner;
    const targetOwner = moved.has(target.element["@_id"])
      ? destination
      : target.owner;
    if (referenceOwner !== targetOwner) throw new Error("BPMN_ACTIVITY_SCOPE");
  }
  const movedLanes = [...laneRoots].filter(
    (id) => lanes.get(id)!.scope !== destination || lanes.get(id)!.parentLane,
  );
  if (!moved.size && !movedLanes.length) return;
  if (destination !== process) {
    const shape = diagramElements.find(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        references.resolveReference(shape, shape["@_bpmnElement"]) ===
          destination["@_id"],
    );
    if (
      shape?.__$$element !== "bpmndi:BPMNShape" ||
      shape["@_isExpanded"] !== true
    )
      throw new Error("BPMN_SUBPROCESS_COLLAPSED");
  }
  const carriedEdges = new Set<string>();
  for (const location of dataAssociationLocations(definitions)) {
    let endpoints: ReturnType<typeof dataAssociationEndpoints>;
    try {
      endpoints = dataAssociationEndpoints(location);
    } catch {
      continue;
    }
    if (
      endpoints.sourceIds.some(
        (source) => moved.has(source) !== moved.has(endpoints.targetId),
      )
    )
      throw new Error("BPMN_ACTIVITY_SCOPE");
  }
  for (const [id, { element }] of locations) {
    if (moved.has(id) && element.__$$element === "boundaryEvent") {
      const host = references.resolveReference(
        element,
        element["@_attachedToRef"],
      );
      if (
        !host ||
        (!moved.has(host) && locations.get(host)?.owner !== destination)
      )
        throw new Error("BPMN_ACTIVITY_SCOPE");
    }
    if (
      element.__$$element !== "sequenceFlow" &&
      element.__$$element !== "association"
    )
      continue;
    const source = moved.has(
        references.resolveReference(element, element["@_sourceRef"]) ??
          element["@_sourceRef"],
      ),
      target = moved.has(
        references.resolveReference(element, element["@_targetRef"]) ??
          element["@_targetRef"],
      );
    if (source !== target) throw new Error("BPMN_ACTIVITY_SCOPE");
    if (source && target) carriedEdges.add(id);
  }
  const all = new Set([...moved, ...carriedEdges]);
  const prospective = {
    ...destination,
    flowElement: [
      ...(destination.flowElement ?? []),
      ...[...all]
        .map((id) => locations.get(id)!.element)
        .filter(
          (element) =>
            element.__$$element !== "association" &&
            element.__$$element !== "textAnnotation" &&
            element.__$$element !== "group",
        ),
    ],
  };
  for (const element of prospective.flowElement)
    if (
      element.__$$element === "startEvent" ||
      element.__$$element === "endEvent" ||
      element.__$$element === "intermediateCatchEvent" ||
      element.__$$element === "intermediateThrowEvent" ||
      element.__$$element === "boundaryEvent"
    )
      assertEventContext(definitions, element, prospective);
  for (const scope of new Set([...all].map((id) => locations.get(id)!.owner)))
    if (
      scope !== process &&
      scope.__$$element === "subProcess" &&
      scope["@_triggeredByEvent"]
    )
      assertSubProcessContext({
        ...scope,
        flowElement: scope.flowElement?.filter(
          (element) => !all.has(element["@_id"]),
        ),
      });
  if (
    destination !== process &&
    (destination.__$$element === "subProcess" ||
      destination.__$$element === "adHocSubProcess" ||
      destination.__$$element === "transaction")
  )
    assertSubProcessContext({
      ...destination,
      flowElement: [
        ...(destination.flowElement ?? []),
        ...[...moved]
          .map((id) => locations.get(id)!.element)
          .filter(
            (element) =>
              element.__$$element !== "association" &&
              element.__$$element !== "textAnnotation" &&
              element.__$$element !== "group",
          ),
      ],
    });
  const bindings = new Map(
    [...all].map((id) => [
      id,
      references.namespaceDeclarationsFor(locations.get(id)!.element),
    ]),
  );
  const laneBindings = new Map(
    movedLanes.map((id) => [
      id,
      references.namespaceDeclarationsFor(lanes.get(id)!.lane),
    ]),
  );
  const departed = new Set([...all].map((id) => locations.get(id)!.owner));
  for (const scope of departed)
    visitLanes(scope, ({ lane }) => {
      if (carriedLanes.has(lane["@_id"])) return;
      if (!lane.flowNodeRef) return;
      const retained = lane.flowNodeRef.filter(
        (ref) => !moved.has(ref.__$$text.trim()),
      );
      if (retained.length) lane.flowNodeRef = retained;
      else delete lane.flowNodeRef;
    });
  for (const id of all) {
    const location = locations.get(id)!;
    const isArtifact = location.owner.artifact === location.array;
    const destinationArray = isArtifact
      ? (destination.artifact ??= [])
      : (destination.flowElement ??= []);
    const index = location.array.findIndex((element) => element["@_id"] === id);
    if (index < 0) throw new Error("BPMN_ACTIVITY_SCOPE");
    const [element] = location.array.splice(index, 1);
    Object.assign(element, bindings.get(id));
    destinationArray.push(element as never);
  }
  for (const id of movedLanes) {
    const location = lanes.get(id)!;
    location.array.splice(
      location.array.findIndex((lane) => lane["@_id"] === id),
      1,
    );
    if (!location.array.length) delete location.owner.lane;
    Object.assign(location.lane, laneBindings.get(id));
    addOrGetLanes({ definitions, scope: destination }).lanes.push(
      location.lane,
    );
  }
}
