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
  visitProcessLanes,
  visitFlowElementsAndArtifacts,
  type LaneVisitorArgs,
  type ElementVisitorArgs,
} from "./element-visitor";
import { addOrGetLanes } from "./addOrGetLanes";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { reassignFlowSelection } from "./moveNodesInsideSubProcess";
import { processIoItems } from "./process-io-context";

/** Explicit flow-node reassignment, not a load-time normalization. Preserve
 * already-authored memberships in the target's ancestors but retire unrelated
 * branches so projection and semantic membership select the same deepest lane.
 * Geometry is changed by the enclosing pointer/history command, never here. */
export function moveNodesInsideLane({
  definitions,
  __readonly_laneId,
  __readonly_nodeIds,
}: {
  definitions: State["bpmn"]["model"]["definitions"];
  __readonly_laneId: string | undefined;
  __readonly_nodeIds: string[];
}) {
  if (__readonly_laneId === undefined) throw new Error("BPMN_LANE_NOT_FOUND");
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let targetScope: ElementVisitorArgs["owner"] | undefined;
  const owners = new Map<string, ElementVisitorArgs["owner"]>();
  for (const { element } of processIoItems(process))
    if (element["@_id"]) owners.set(element["@_id"], process);
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    owners.set(element["@_id"], owner);
  });
  visitProcessLanes(process, ({ lane, scope }) => {
    owners.set(lane["@_id"], scope);
    if (lane["@_id"] === __readonly_laneId) targetScope = scope;
  });
  if (!targetScope) throw new Error("BPMN_LANE_NOT_FOUND");
  // Palette nodes start in the process. Dropping into a nested lane first
  // changes the real flow scope, with the same crossing-edge/cycle validation
  // as a subprocess drop; membership alone must never fake containment.
  if (__readonly_nodeIds.some((id) => owners.get(id) !== targetScope))
    reassignFlowSelection({
      definitions,
      targetOwnerId: targetScope["@_id"],
      nodeIds: __readonly_nodeIds,
    });
  reassignLaneSelection({
    definitions,
    targetLaneId: __readonly_laneId,
    nodeIds: __readonly_nodeIds,
  });
}

/** Shared move-in/out owner. A lane selection relocates its actual subtree;
 * process-owned flow nodes stay in the process. Preserve inner memberships and
 * inherited namespace scopes while retiring memberships in the departed branch.
 * All validation precedes writes; the enclosing gesture owns DI/history. */
export function reassignLaneSelection({
  definitions,
  targetLaneId,
  nodeIds,
}: {
  definitions: State["bpmn"]["model"]["definitions"];
  targetLaneId?: string;
  nodeIds: string[];
}) {
  if (!nodeIds.length) return;
  const { process } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  if ((process.laneSet?.length ?? 0) > 1)
    throw new Error("BPMN_UNSUPPORTED_ELEMENT");
  const locations = new Map<
    string,
    LaneVisitorArgs & { scope: ElementVisitorArgs["owner"] }
  >();
  const parents = new Map<string, string>();
  visitProcessLanes(process, (location) => {
    locations.set(location.lane["@_id"], location);
    if (location.parentLane)
      parents.set(location.lane["@_id"], location.parentLane["@_id"]);
  });
  const target =
    targetLaneId === undefined ? undefined : locations.get(targetLaneId)?.lane;
  if (targetLaneId !== undefined && !target)
    throw new Error("BPMN_LANE_NOT_FOUND");
  const flowOwners = new Map<string, ElementVisitorArgs["owner"]>();
  const nonFlowNodes = new Set<string>();
  for (const { element } of processIoItems(process))
    if (element["@_id"]) nonFlowNodes.add(element["@_id"]);
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (
      [
        "textAnnotation",
        "group",
        "dataObject",
        "dataObjectReference",
        "dataStoreReference",
      ].includes(element.__$$element)
    )
      nonFlowNodes.add(element["@_id"]);
    if (
      element.__$$element !== "sequenceFlow" &&
      element.__$$element !== "association" &&
      element.__$$element !== "dataObject" &&
      element.__$$element !== "dataObjectReference" &&
      element.__$$element !== "dataStoreReference"
    )
      flowOwners.set(element["@_id"], owner);
  });
  const flowNodes = new Set(flowOwners.keys());
  const selectedOwners = new Set(nodeIds);
  nodeIds = nodeIds.filter((id) => {
    // Artifacts/data items may be placed geometrically inside a lane but are not BPMN
    // FlowNodes. Scope reassignment already happened above when necessary;
    // never manufacture an invalid Lane.flowNodeRef for an annotation/group.
    if (nonFlowNodes.has(id)) return false;
    for (
      let owner = locations.get(id)?.scope ?? flowOwners.get(id);
      owner && owner !== process;
      owner = flowOwners.get(owner["@_id"])
    )
      if (selectedOwners.has(owner["@_id"])) return false;
    return true;
  });
  if (!nodeIds.length) return;
  if (nodeIds.some((id) => !flowNodes.has(id) && !locations.has(id)))
    throw new Error("BPMN_UNSUPPORTED_ELEMENT");
  const scope = targetLaneId
    ? locations.get(targetLaneId)!.scope
    : (locations.get(nodeIds[0])?.scope ?? flowOwners.get(nodeIds[0]));
  if (
    !scope ||
    nodeIds.some(
      (id) => (locations.get(id)?.scope ?? flowOwners.get(id)) !== scope,
    )
  )
    throw new Error("BPMN_ACTIVITY_SCOPE");
  const ancestorsOf = (id: string) => {
    const ancestors = new Set<string>();
    let parent = parents.get(id);
    while (parent) {
      ancestors.add(parent);
      parent = parents.get(parent);
    }
    return ancestors;
  };
  const selected = new Set(nodeIds);
  const selectedLanes = new Set(nodeIds.filter((id) => locations.has(id)));
  const newBranch = target
    ? new Set([...ancestorsOf(target["@_id"]), target["@_id"]])
    : new Set<string>();
  if ([...selectedLanes].some((id) => newBranch.has(id)))
    throw new Error("BPMN_LANE_CYCLE");
  const roots = new Set(
    [...selectedLanes].filter(
      (id) => ![...ancestorsOf(id)].some((parent) => selectedLanes.has(parent)),
    ),
  );
  const carriedLanes = new Set<string>();
  const carriedNodes = new Set<string>();
  for (const [id, { lane, parentLane }] of locations) {
    if (roots.has(id) || (parentLane && carriedLanes.has(parentLane["@_id"]))) {
      carriedLanes.add(id);
      for (const reference of lane.flowNodeRef ?? [])
        carriedNodes.add(reference.__$$text.trim());
    }
  }
  const reassignedNodes = new Set(
    [...selected].filter((id) => flowNodes.has(id) && !carriedNodes.has(id)),
  );
  const removedMemberships = new Set([...reassignedNodes, ...carriedNodes]);
  const references = indexBpmnIds(definitions);
  const bindings = new Map(
    [...roots].map((id) => [
      id,
      references.namespaceDeclarationsFor(locations.get(id)!.lane),
    ]),
  );
  for (const [id, { lane }] of locations) {
    if (newBranch.has(id) || carriedLanes.has(id) || !lane.flowNodeRef)
      continue;
    const retained = lane.flowNodeRef.filter(
      (reference) => !removedMemberships.has(reference.__$$text.trim()),
    );
    if (retained.length !== lane.flowNodeRef.length) {
      if (retained.length) lane.flowNodeRef = retained;
      else delete lane.flowNodeRef;
    }
  }
  if (target && reassignedNodes.size) {
    const existing = new Set(
      target.flowNodeRef?.map((reference) => reference.__$$text.trim()),
    );
    const added = [...reassignedNodes].filter((id) => !existing.has(id));
    if (added.length)
      (target.flowNodeRef ??= []).push(
        ...added.map((id) => ({ __$$text: id })),
      );
  }
  for (const id of roots) {
    const location = locations.get(id)!;
    if (target ? location.owner === target.childLaneSet : !location.parentLane)
      continue;
    const destination = target
      ? ((target.childLaneSet ??= { "@_id": generateUuid() }).lane ??= [])
      : addOrGetLanes({ definitions, scope }).lanes;
    Object.assign(location.lane, bindings.get(id));
    location.array.splice(
      location.array.findIndex((lane) => lane["@_id"] === id),
      1,
    );
    if (!location.array.length) delete location.owner.lane;
    destination.push(location.lane);
  }
}
