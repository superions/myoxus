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

import { type Normalized } from "../normalization/normalize";
import { type BpmnDiagramEdgeData } from "../diagram/BpmnDiagramDomain";
import {
  type BPMN20__tDefinitions,
  type BPMN20__tProcess,
  type BPMNDI__BPMNEdge,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { dataAssociationById, removeDataAssociation } from "./data-association";
import {
  type FoundElement,
  visitFlowElementsAndArtifacts,
} from "./element-visitor";
import { type ElementFilter } from "../../xml-parser/element-filter";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
export function deleteEdge({
  definitions,
  __readonly_edgeId,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_edgeId: string;
}): {
  deletedBpmnEdge: BPMNDI__BPMNEdge | undefined;
  deletedBpmnElement: BpmnDiagramEdgeData["bpmnElement"] | undefined;
} {
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  // Borrow identities before removing their declarations so prefixed endpoint
  // refs still resolve during the same deletion transaction.
  const references = indexBpmnIds(definitions);
  const dataLocation = dataAssociationById(definitions, __readonly_edgeId);
  if (dataLocation) {
    const association = removeDataAssociation(definitions, __readonly_edgeId)!;
    const semanticId = dataLocation.association["@_id"]!;
    const routeIndex = diagramElements.findIndex(
      (edge) =>
        edge.__$$element === "bpmndi:BPMNEdge" &&
        references.resolveReference(edge, edge["@_bpmnElement"]) === semanticId,
    );
    const route =
      routeIndex >= 0
        ? (diagramElements.splice(routeIndex, 1)[0] as BPMNDI__BPMNEdge)
        : undefined;
    for (let i = diagramElements.length - 1; i >= 0; i--) {
      const edge = diagramElements[i];
      if (
        edge.__$$element === "bpmndi:BPMNEdge" &&
        references.resolveReference(edge, edge["@_bpmnElement"]) === semanticId
      )
        diagramElements.splice(i, 1);
    }
    return {
      deletedBpmnEdge: route,
      deletedBpmnElement: {
        ...association,
        "@_id": semanticId,
        __$$element: dataLocation.kind,
      } as BpmnDiagramEdgeData["bpmnElement"],
    };
  }

  // BPMN Element (<sequenceFlow> or <association>)
  let foundBpmnElement:
    | undefined
    | FoundElement<
        | Normalized<
            ElementFilter<
              Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
              "sequenceFlow"
            >
          >
        | Normalized<
            ElementFilter<
              Unpacked<NonNullable<BPMN20__tProcess["artifact"]>>,
              "association"
            >
          >
      >;
  visitFlowElementsAndArtifacts(process, ({ element, ...args }) => {
    if (
      (element.__$$element === "sequenceFlow" ||
        element.__$$element === "association") &&
      element["@_id"] === __readonly_edgeId
    ) {
      foundBpmnElement = {
        element,
        ...args,
      };
      return false; // Will stop visiting.
    }
    return true;
  });
  if (!foundBpmnElement) {
    throw new Error(
      `BPMN MUTATION: Can't find BPMN Element with ID '${__readonly_edgeId}'`,
    );
  }

  // BPMNEdge
  const bpmnEdgeIndex = (diagramElements ?? []).findIndex(
    (e) =>
      references.resolveReference(e, e["@_bpmnElement"]) === __readonly_edgeId,
  );
  if (bpmnEdgeIndex < 0) {
    throw new Error(
      `BPMN MUTATION: Can't find BPMNEdge with referencing a BPMN element with ID ${__readonly_edgeId}`,
    );
  }
  foundBpmnElement.array.splice(foundBpmnElement.index, 1);
  const deletedBpmnEdge = diagramElements?.splice(bpmnEdgeIndex, 1)[0] as
    BPMNDI__BPMNEdge | undefined;

  // <incoming> and <outgoing> elements of Flow Elements
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element !== "association" &&
      element.__$$element !== "group" &&
      element.__$$element !== "textAnnotation" &&
      element.__$$element !== "sequenceFlow" &&
      element.__$$element !== "dataStoreReference" &&
      element.__$$element !== "dataObject" &&
      element.__$$element !== "dataObjectReference"
    ) {
      // outgoing
      if (element["@_id"] === foundBpmnElement?.element?.["@_sourceRef"]) {
        element.outgoing = element.outgoing?.filter(
          (s) =>
            references.resolveReference(s, s.__$$text) !== __readonly_edgeId,
        );
        if (!element.outgoing?.length) delete element.outgoing;
        if (
          "@_default" in element &&
          references.resolveReference(element, element["@_default"]) ===
            __readonly_edgeId
        )
          delete element["@_default"];
      }

      // incoming
      if (element["@_id"] === foundBpmnElement?.element?.["@_targetRef"]) {
        element.incoming = element.incoming?.filter(
          (s) =>
            references.resolveReference(s, s.__$$text) !== __readonly_edgeId,
        );
        if (!element.incoming?.length) delete element.incoming;
      }
    }
    // Source and target may occur anywhere in the owner, or be the same node
    // for a self-loop. Finish both sides without materializing unrelated arrays.
    return true;
  });
  return {
    deletedBpmnEdge,
    deletedBpmnElement: foundBpmnElement.element,
  };
}
