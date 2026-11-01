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

import {
  type BPMN20__tDefinitions,
  type BPMN20__tProperty,
  type BPMN20__tProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../normalization/normalize";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import type { Activity } from "./activity";
import type { BpmnEvent } from "./event";

export type PropertyOwner = Normalized<BPMN20__tProcess | BpmnEvent> | Activity;

/** Standard Property ownership follows Activity/Event inheritance, not only
 * flow-container nesting. Gate both the inspector and mutation lookup here. */
export function isPropertyOwner(element: object): element is PropertyOwner {
  if (!("__$$element" in element)) return false;
  switch (element.__$$element) {
    case "process":
    case "task":
    case "manualTask":
    case "userTask":
    case "serviceTask":
    case "sendTask":
    case "receiveTask":
    case "businessRuleTask":
    case "scriptTask":
    case "callActivity":
    case "subProcess":
    case "adHocSubProcess":
    case "transaction":
    case "startEvent":
    case "endEvent":
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return true;
    default:
      return false;
  }
}

/** Resolve the live nested XML owner; never fall back to process when an
 * activity/event disappeared or the caller supplied an inapplicable element. */
export function propertyOwnerById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string | undefined,
): PropertyOwner {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  if (id === process["@_id"]) return process;
  let owner: PropertyOwner | undefined;
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element["@_id"] !== id) return true;
    if (isPropertyOwner(element)) owner = element;
    return false;
  });
  if (!owner) throw new Error("BPMN_PROPERTY_OWNER_NOT_FOUND");
  return owner;
}

/** Optional imported identities are not allocated by ordinary edits. An ID-less
 * row is addressed only by its ordinal in the current synchronous table. */
export function findOwnedProperty(
  owner: { property?: Normalized<BPMN20__tProperty>[] },
  id: string | undefined,
  originalIndex?: number,
) {
  if (id) return owner.property?.find((property) => property["@_id"] === id);
  if (
    originalIndex === undefined ||
    !Number.isInteger(originalIndex) ||
    originalIndex < 0
  )
    return;
  const property = owner.property?.[originalIndex];
  return property && !property["@_id"] ? property : undefined;
}
/** Standard item-aware Property, not an engine variable. Untyped creation leaves
 * itemSubjectRef absent: an empty QName makes the editor's own source uneditable. */
export function addVariable({
  definitions,
  pId,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  pId: string | undefined;
}): void {
  const owner = propertyOwnerById(definitions, pId);
  (owner.property ??= []).push({ "@_id": generateUuid(), "@_name": "" });
}

/** Called inside the owning history transaction; remaining consumers of any
 * removed child identity abort deletion across the complete definitions tree. */
export function deleteVariable(
  definitions: Normalized<BPMN20__tDefinitions>,
  ownerId: string,
  id: string | undefined,
  originalIndex?: number,
) {
  const references = indexBpmnIds(definitions);
  const remove = (owner: { property?: Normalized<BPMN20__tProperty>[] }) => {
    const property = findOwnedProperty(owner, id, originalIndex);
    if (!property) return;
    const index = owner.property!.indexOf(property);
    owner.property!.splice(index, 1);
    if (!owner.property!.length) delete owner.property;
  };
  remove(propertyOwnerById(definitions, ownerId));
  const remaining = indexBpmnIds(definitions),
    ids = remaining.getOriginalIds();
  for (const removed of references.getOriginalIds())
    if (!ids.has(removed) && remaining.isReferenced(removed))
      throw new Error("BPMN_DEFINITION_IN_USE");
}
