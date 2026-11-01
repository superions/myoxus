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

import { I18n } from "@myoxus/i18n";

import { switchExpression } from "../ts-ext/switch-expression";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { type BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import { AutoPositionedEdgeMarker } from "../../xyflow/edges/AutoPositionedEdgeMarker";
import { type DC__Bounds } from "../../xyflow/maths/model";
import {
  type BpmnNodeType,
  EDGE_TYPES,
  NODE_TYPES,
  type TaskVariant,
} from "../diagram/BpmnDiagramDomain";
import { type Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { NodeNature, nodeNatures } from "./node-nature";
import { addEdge } from "./addEdge";
import { PositionalNodeHandleId } from "../../xyflow/nodes/PositionalNodeHandles";
import { getNewNodeDefaultName } from "./addStandaloneNode";
import { bpmnConstructState } from "../../source-profile";
import { findProcessIoItem } from "./process-io-context";
import {
  visitFlowElementsAndArtifacts,
  type ElementVisitorArgs,
  visitProcessLanes,
} from "./element-visitor";
export function addConnectedNode({
  definitions,
  __readonly_sourceNode,
  __readonly_newNode,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_sourceNode: {
    type: BpmnNodeType;
    id: string;
    bounds: DC__Bounds;
    shapeId: string | undefined;
  };
  __readonly_newNode: {
    type: BpmnNodeType;
    bounds: DC__Bounds;
    element?: "task" | TaskVariant;
  };
}) {
  if (
    __readonly_newNode.element &&
    bpmnConstructState(__readonly_newNode.element) !== "editable"
  )
    throw new Error("BPMN_UNSUPPORTED_ELEMENT");
  const newBpmnElementId = generateUuid();
  const newNodeNature = nodeNatures[__readonly_newNode.type];
  const { process: rootProcess, plane } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  let owner: ElementVisitorArgs["owner"] | undefined;
  if (findProcessIoItem(rootProcess, __readonly_sourceNode.id))
    owner = rootProcess;
  visitFlowElementsAndArtifacts(
    rootProcess,
    ({ element, owner: currentOwner }) => {
      if (element["@_id"] !== __readonly_sourceNode.id) return true;
      owner = currentOwner;
      return false;
    },
  );
  if (!owner && __readonly_sourceNode.type === NODE_TYPES.lane)
    visitProcessLanes(rootProcess, ({ lane, scope }) => {
      if (lane["@_id"] !== __readonly_sourceNode.id) return true;
      owner = scope;
      return false;
    });
  if (!owner) throw new Error("BPMN_ACTIVITY_SCOPE");
  const process = owner;
  if (
    process.__$$element === "adHocSubProcess" &&
    (__readonly_newNode.type === NODE_TYPES.startEvent ||
      __readonly_newNode.type === NODE_TYPES.endEvent)
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  const diagramElements = (plane["di:DiagramElement"] ??= []);
  if (
    newNodeNature === NodeNature.PROCESS_FLOW_ELEMENT ||
    newNodeNature === NodeNature.CONTAINER
  ) {
    process.flowElement ??= [];
    process.flowElement?.push(
      switchExpression(
        __readonly_newNode.type as Exclude<
          BpmnNodeType,
          | "node_group"
          | "node_textAnnotation"
          | "node_unknown"
          | "node_lane"
          | "node_dataObject"
          | "node_transaction"
        >,
        {
          [NODE_TYPES.task]: {
            "@_id": newBpmnElementId,
            "@_name": getNewNodeDefaultName({
              type: NODE_TYPES.task,
              element: __readonly_newNode.element ?? "task",
            }),
            __$$element: __readonly_newNode.element ?? "task",
          },
          [NODE_TYPES.startEvent]: {
            "@_id": newBpmnElementId,
            __$$element: "startEvent",
          },
          [NODE_TYPES.intermediateCatchEvent]: {
            "@_id": newBpmnElementId,
            __$$element: "intermediateCatchEvent",
            eventDefinition: [
              {
                "@_id": generateUuid(),
                __$$element: "timerEventDefinition",
                timeDuration: { "@_id": generateUuid(), __$$text: "PT1M" },
              },
            ],
          },
          [NODE_TYPES.intermediateThrowEvent]: {
            "@_id": newBpmnElementId,
            __$$element: "intermediateThrowEvent",
            eventDefinition: [
              {
                "@_id": generateUuid(),
                __$$element: "signalEventDefinition",
              },
            ],
          },
          [NODE_TYPES.endEvent]: {
            "@_id": newBpmnElementId,
            __$$element: "endEvent",
          },
          [NODE_TYPES.subProcess]: {
            "@_id": newBpmnElementId,
            "@_name": I18n["com.myoxus.editor.shape.bpmn.sub-process"](),
            __$$element: "subProcess",
          },
          [NODE_TYPES.gateway]: {
            "@_id": newBpmnElementId,
            __$$element: "exclusiveGateway",
          },
        },
      ),
    );
  } else if (newNodeNature === NodeNature.ARTIFACT) {
    process.artifact ??= [];
    process.artifact.push(
      ...switchExpression(
        __readonly_newNode.type as Extract<
          BpmnNodeType,
          "node_group" | "node_textAnnotation"
        >,
        {
          [NODE_TYPES.group]: [
            {
              "@_id": newBpmnElementId,
              __$$element: "group" as const,
            },
          ],
          [NODE_TYPES.textAnnotation]: [
            {
              "@_id": newBpmnElementId,
              __$$element: "textAnnotation" as const,
              text: {
                __$$text: "",
              },
            },
          ],
        },
      ),
    );
  } else {
    throw new Error(`BPMN MUTATION: Unknown node usage '${newNodeNature}'.`);
  }
  const newShapeId = generateUuid();
  // Add the new node shape
  diagramElements?.push({
    __$$element: "bpmndi:BPMNShape",
    "@_id": newShapeId,
    "@_bpmnElement": newBpmnElementId,
    ...(__readonly_newNode.type === NODE_TYPES.subProcess
      ? { "@_isExpanded": true }
      : {}),
    "dc:Bounds": __readonly_newNode.bounds,
  });
  const shape = diagramElements[diagramElements.length - 1];
  shape["@_bpmnElement"] = indexBpmnIds(definitions).referenceFor(
    shape,
    newBpmnElementId,
  )!;

  // addEdge is the sole owner of the semantic edge and its matching DI entry.
  addEdge({
    definitions,
    __readonly_edge: {
      autoPositionedEdgeMarker: AutoPositionedEdgeMarker.BOTH,
      sourceHandle: PositionalNodeHandleId.Center,
      targetHandle: PositionalNodeHandleId.Center,
      type:
        newNodeNature === NodeNature.ARTIFACT
          ? EDGE_TYPES.association
          : EDGE_TYPES.sequenceFlow,
      name: undefined,
      documentation: undefined,
    },
    __readonly_keepWaypoints: false,
    __readonly_sourceNode: {
      bounds: __readonly_sourceNode.bounds,
      type: __readonly_sourceNode.type,
      href: __readonly_sourceNode.id,
      shapeId: __readonly_sourceNode.shapeId,
    },
    __readonly_targetNode: {
      bounds: __readonly_newNode.bounds,
      type: __readonly_newNode.type,
      href: newBpmnElementId,
      shapeId: newShapeId,
    },
  });
  return {
    id: newBpmnElementId,
    href: newBpmnElementId,
  };
}
