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
  type BPMN20__tLane,
  type BPMN20__tProcess,
  type BPMNDI__BPMNShape,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  type BpmnDiagramEdgeData,
  type BpmnNodeElement,
} from "../diagram/BpmnDiagramDomain";
import { type Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { deleteEdge } from "./deleteEdge";
import { retireUnusedDataBacking } from "./data";
import { findProcessIoItem } from "./process-io-context";
import { deleteProcessIoItem } from "./process-io";
import { dataAssociationLocations } from "./data-association";
import { assertSubProcessContext } from "./activity-context";
import {
  type FoundElement,
  visitFlowElementsAndArtifacts,
  visitProcessLanes,
} from "./element-visitor";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import { type ElementExclusion } from "../../xml-parser/element-filter";
export function deleteNode({
  definitions,
  __readonly_bpmnEdgeData,
  __readonly_bpmnElementId,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_bpmnEdgeData: BpmnDiagramEdgeData[];
  __readonly_bpmnElementId: string | undefined;
}): {
  deletedBpmnElement: BpmnNodeElement | undefined;
  deletedBpmnShape: Normalized<BPMNDI__BPMNShape> | undefined;
} {
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const references = indexBpmnIds(definitions);

  const nodeId = __readonly_bpmnElementId;
  if (nodeId && findProcessIoItem(process, nodeId)) {
    const deleted = deleteProcessIoItem(definitions, nodeId);
    return {
      deletedBpmnElement: deleted.element as BpmnNodeElement,
      deletedBpmnShape:
        deleted.shape?.__$$element === "bpmndi:BPMNShape"
          ? deleted.shape
          : undefined,
    };
  }
  void __readonly_bpmnEdgeData; // Collapsed/virtualized children are not in a rendered edge selection.
  const deletedIds = new Set<string>();
  if (nodeId) deletedIds.add(nodeId);
  const boundaryIds = new Set<string>();
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element["@_id"] !== nodeId) return;
    if (
      element.__$$element === "subProcess" ||
      element.__$$element === "adHocSubProcess" ||
      element.__$$element === "transaction"
    ) {
      visitFlowElementsAndArtifacts(element, ({ element }) => {
        deletedIds.add(element["@_id"]);
      });
      visitProcessLanes(element, ({ lane }) => {
        deletedIds.add(lane["@_id"]);
      });
    }
  });
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "boundaryEvent" &&
      deletedIds.has(
        references.resolveReference(element, element["@_attachedToRef"])!,
      )
    ) {
      deletedIds.add(element["@_id"]);
      boundaryIds.add(element["@_id"]);
    }
  });
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "subProcess" &&
      element["@_triggeredByEvent"] &&
      !deletedIds.has(element["@_id"])
    )
      assertSubProcessContext({
        ...element,
        flowElement: element.flowElement?.filter(
          (child) => !deletedIds.has(child["@_id"]),
        ),
      });
  });
  const edges = new Set<string>();
  const dataConnections = dataAssociationLocations(definitions);
  for (const { host } of dataConnections)
    if (host["@_id"] && deletedIds.has(host["@_id"]))
      for (const item of [
        ...(host.ioSpecification?.dataInput ?? host.dataInput ?? []),
        ...(host.ioSpecification?.dataOutput ?? host.dataOutput ?? []),
      ])
        if (item["@_id"]) deletedIds.add(item["@_id"]);
  for (const { host, association } of dataConnections) {
    if (
      (host["@_id"] && deletedIds.has(host["@_id"])) ||
      association.sourceRef?.some((ref) =>
        deletedIds.has(ref.__$$text.trim()),
      ) ||
      (association.targetRef &&
        deletedIds.has(association.targetRef.__$$text.trim()))
    )
      if (association["@_id"]) edges.add(association["@_id"]);
  }
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      (element.__$$element === "sequenceFlow" ||
        element.__$$element === "association") &&
      (deletedIds.has(element["@_id"]) ||
        deletedIds.has(
          element.__$$element === "sequenceFlow"
            ? element["@_sourceRef"]
            : references.resolveReference(element, element["@_sourceRef"])!,
        ) ||
        deletedIds.has(
          element.__$$element === "sequenceFlow"
            ? element["@_targetRef"]
            : references.resolveReference(element, element["@_targetRef"])!,
        ))
    )
      edges.add(element["@_id"]);
  });
  // Semantic ownership, not current canvas visibility, determines deletion.
  const backingCandidates = new Set<string>();
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element !== "dataObjectReference" ||
      !element["@_dataObjectRef"]
    )
      return;
    const target = element["@_dataObjectRef"].trim();
    if (deletedIds.has(target) && !deletedIds.has(element["@_id"]))
      throw new Error("BPMN_DEFINITION_IN_USE");
    if (deletedIds.has(element["@_id"]) && !deletedIds.has(target))
      backingCandidates.add(target);
  });
  // Remove all descendant routes and host-attached boundary siblings in this
  // history command; shared definitions remain outside the owned subtree.
  for (const id of edges) {
    deleteEdge({ definitions, __readonly_edgeId: id });
    deletedIds.add(id);
  }
  for (const id of boundaryIds) {
    if (id === nodeId) continue;
    visitFlowElementsAndArtifacts(process, ({ element, array, index }) => {
      if (element["@_id"] !== id) return true;
      array.splice(index, 1);
      return false;
    });
  }

  // Delete the bpmnElement

  let foundElement:
    | undefined
    | FoundElement<
        | ElementExclusion<
            Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
            "sequenceFlow"
          >
        | ElementExclusion<
            Unpacked<NonNullable<BPMN20__tProcess["artifact"]>>,
            "association"
          >
      >;
  let deletedBpmnElement: BpmnNodeElement | undefined = undefined;
  const deletedLaneIds = new Set<string>();
  visitFlowElementsAndArtifacts(process, ({ element, ...args }) => {
    if (
      element["@_id"] === __readonly_bpmnElementId &&
      element.__$$element !== "sequenceFlow" &&
      element.__$$element !== "association"
    ) {
      foundElement = {
        element,
        ...args,
      };
      return false; // Will stop visiting.
    }
    return true;
  });

  // if flowElement or artifact
  if (foundElement) {
    deletedBpmnElement = foundElement.array.splice(
      foundElement.index,
      1,
    )?.[0] as BpmnNodeElement | undefined;
  } else {
    visitProcessLanes(process, ({ lane, array, index, owner }) => {
      if (lane["@_id"] !== nodeId) return true;
      // Lanes own child lanes, not their referenced process flow nodes. Remove
      // subtree DI in this same command, keeping those nodes at absolute bounds.
      const collect = (value: BPMN20__tLane) => {
        if (value["@_id"]) deletedLaneIds.add(value["@_id"]);
        for (const child of value.childLaneSet?.lane ?? []) collect(child);
      };
      collect(lane);
      array.splice(index, 1);
      if (!array.length) delete owner.lane;
      deletedBpmnElement = {
        ...lane,
        __$$element: "lane",
      };
      return false;
    });
  }
  // Shared interface/operation definitions are not owned by the deleted task.
  for (const id of backingCandidates) retireUnusedDataBacking(definitions, id);
  if (!deletedBpmnElement) {
    return {
      deletedBpmnElement: undefined,
      deletedBpmnShape: undefined,
    };
  }
  for (const id of deletedLaneIds) deletedIds.add(id);
  visitProcessLanes(process, ({ lane }) => {
    if (!lane.flowNodeRef) return;
    const retained = lane.flowNodeRef.filter(
      (reference) => !deletedIds.has(reference.__$$text.trim()),
    );
    if (retained.length !== lane.flowNodeRef.length) {
      if (retained.length) lane.flowNodeRef = retained;
      else delete lane.flowNodeRef;
    }
  });

  // Delete the BPMNShape

  let deletedBpmnShape: Normalized<BPMNDI__BPMNShape> | undefined;
  const bpmnShapeIndex = (diagramElements ?? []).findIndex(
    (d) =>
      references.resolveReference(d, d["@_bpmnElement"]) ===
      __readonly_bpmnElementId,
  );
  if (bpmnShapeIndex >= 0) {
    deletedBpmnShape = diagramElements[
      bpmnShapeIndex
    ] as typeof deletedBpmnShape;
    diagramElements.splice(bpmnShapeIndex, 1);
  }
  for (let index = diagramElements.length - 1; index >= 0; index--) {
    const shape = diagramElements[index];
    if (
      deletedIds.has(
        references.resolveReference(shape, shape["@_bpmnElement"])!,
      )
    )
      diagramElements.splice(index, 1);
  }
  // Graph deletion is called in the enclosing Immer history transaction. A
  // consumer outside the repaired graph/lanes/DI (including a child identity)
  // aborts that transaction instead of leaving a dangling reference behind.
  const remaining = indexBpmnIds(definitions);
  const remainingIds = remaining.getOriginalIds();
  for (const id of references.getOriginalIds())
    if (!remainingIds.has(id) && remaining.isReferenced(id))
      throw new Error("BPMN_DEFINITION_IN_USE");
  return {
    deletedBpmnElement,
    deletedBpmnShape,
  };
}
