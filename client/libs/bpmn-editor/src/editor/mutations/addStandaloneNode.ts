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
import { type Normalized } from "../normalization/normalize";
import {
  type BPMN20__tDefinitions,
  type BPMN20__tTask,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  type BpmnDiagramNodeData,
  type BpmnNodeType,
  elementToNodeType,
  NODE_TYPES,
  type TaskVariant,
} from "../diagram/BpmnDiagramDomain";
import { type DC__Bounds } from "../../xyflow/maths/model";
import { NodeNature, nodeNatures } from "./node-nature";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { addOrGetLanes } from "./addOrGetLanes";
import { assertUnreachable } from "../ts-ext/assertUnreachable";
import { bpmnConstructState } from "../../source-profile";
import { setSubProcessKind } from "./activity";
import { appendProcessIoItem } from "./process-io";
export function getNewNodeDefaultName({
  type,
  element,
}: {
  type: BpmnNodeType;
  element: keyof typeof elementToNodeType;
}) {
  switch (type) {
    case NODE_TYPES.subProcess:
      if (element === "transaction") {
        return I18n["com.myoxus.editor.bpmn.transaction"]();
      } else if (element === "adHocSubProcess") {
        return I18n["com.myoxus.editor.bpmn.adhoc-subprocess"]();
      } else {
        return I18n["com.myoxus.editor.shape.bpmn.sub-process"]();
      }
    case NODE_TYPES.startEvent:
    case NODE_TYPES.intermediateCatchEvent:
    case NODE_TYPES.intermediateThrowEvent:
    case NODE_TYPES.endEvent:
    case NODE_TYPES.gateway:
    case NODE_TYPES.group:
    case NODE_TYPES.textAnnotation:
    case NODE_TYPES.unknown:
      return undefined;
    case NODE_TYPES.dataObject:
      if (element === "dataInput")
        return I18n["com.myoxus.editor.bpmn.data-input"]();
      if (element === "dataOutput")
        return I18n["com.myoxus.editor.bpmn.data-output"]();
      if (element === "dataStoreReference")
        return I18n["com.myoxus.editor.shape.bpmn.data-store"]();
      return element === "dataObjectReference"
        ? I18n["com.myoxus.editor.bpmn.data-object-reference"]()
        : I18n["com.myoxus.editor.shape.bpmn.data-object"]();
    case NODE_TYPES.lane:
      return I18n["com.myoxus.editor.shape.bpmn.lane"]();
    case NODE_TYPES.task:
      switch (element) {
        case "callActivity":
          return I18n["com.myoxus.editor.shape.bpmn.call-activity"]();
        case "task":
          return I18n["com.myoxus.editor.shape.bpmn.task"]();
        case "userTask":
          return I18n["com.myoxus.editor.shape.bpmn.user-task"]();
        case "businessRuleTask":
          return I18n["com.myoxus.editor.shape.bpmn.business-rule-task"]();
        case "scriptTask":
          return I18n["com.myoxus.editor.shape.bpmn.script-task"]();
        case "serviceTask":
          return I18n["com.myoxus.editor.shape.bpmn.service-task"]();
        case "manualTask":
          return I18n["com.myoxus.editor.shape.bpmn.manual-task"]();
        case "sendTask":
          return I18n["com.myoxus.editor.shape.bpmn.send-task"]();
        case "receiveTask":
          return I18n["com.myoxus.editor.shape.bpmn.receive-task"]();
        default:
          return undefined;
      }
    default:
      assertUnreachable(type);
  }
}
export function addStandaloneNode({
  definitions,
  __readonly_element,
  __readonly_newNode,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_element: keyof typeof elementToNodeType;
  __readonly_newNode: {
    type: BpmnNodeType;
    bounds: DC__Bounds;
    data: undefined | BpmnDiagramNodeData;
  };
}) {
  const newBpmnElementId = generateUuid();
  if (bpmnConstructState(__readonly_element) !== "editable")
    throw new Error("BPMN_UNSUPPORTED_ELEMENT");
  const nature = nodeNatures[__readonly_newNode.type];
  const { process, plane } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const diagramElements = (plane["di:DiagramElement"] ??= []);
  if (
    __readonly_element === "dataInput" ||
    __readonly_element === "dataOutput"
  ) {
    appendProcessIoItem(definitions, __readonly_element, {
      "@_id": newBpmnElementId,
      "@_name": getNewNodeDefaultName({
        type: __readonly_newNode.type,
        element: __readonly_element,
      }),
    });
  } else if (nature === NodeNature.PROCESS_FLOW_ELEMENT) {
    process.flowElement ??= [];
    process.flowElement?.push(
      switchExpression(
        __readonly_newNode.type as Exclude<
          BpmnNodeType,
          | "node_group"
          | "node_textAnnotation"
          | "node_unknown"
          | "node_lane"
          | "node_subProcess"
        >,
        {
          [NODE_TYPES.task]:
            __readonly_element === "callActivity"
              ? {
                  "@_id": newBpmnElementId,
                  __$$element: "callActivity",
                  "@_name": getNewNodeDefaultName({
                    type: __readonly_newNode.type,
                    element: __readonly_element,
                  }),
                }
              : {
                  ...__readonly_newNode.data?.bpmnElement,
                  "@_id": newBpmnElementId,
                  // All standard variants share this task geometry/DI owner.
                  // The semantic type comes from the palette, not a later morph.
                  __$$element: __readonly_element as "task" | TaskVariant,
                  "@_name":
                    (
                      __readonly_newNode.data?.bpmnElement as
                        Normalized<BPMN20__tTask> | undefined
                    )?.["@_name"] ??
                    getNewNodeDefaultName({
                      type: __readonly_newNode.type,
                      element: __readonly_element,
                    }),
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
          [NODE_TYPES.gateway]: {
            "@_id": newBpmnElementId,
            __$$element: __readonly_element as
              | "exclusiveGateway"
              | "inclusiveGateway"
              | "parallelGateway"
              | "eventBasedGateway"
              | "complexGateway",
          },
          [NODE_TYPES.dataObject]: {
            "@_id": newBpmnElementId,
            "@_name": getNewNodeDefaultName({
              type: __readonly_newNode.type,
              element: __readonly_element,
            }),
            __$$element:
              __readonly_element === "dataStoreReference"
                ? "dataStoreReference"
                : __readonly_element === "dataObjectReference"
                  ? "dataObjectReference"
                  : "dataObject",
          },
        },
      ),
    );
  } else if (nature === NodeNature.ARTIFACT) {
    process.artifact ??= [];
    process.artifact?.push(
      ...switchExpression(
        __readonly_newNode.type as Extract<
          BpmnNodeType,
          "node_group" | "node_textAnnotation"
        >,
        {
          [NODE_TYPES.textAnnotation]: [
            {
              "@_id": newBpmnElementId,
              __$$element: "textAnnotation" as const,
              text: {
                __$$text: "",
              },
            },
          ],
          [NODE_TYPES.group]: [
            {
              "@_id": newBpmnElementId,
              __$$element: "group" as const,
            },
          ],
        },
      ),
    );
  } else if (nature === NodeNature.CONTAINER) {
    process.flowElement ??= [];
    process.flowElement.push(
      __readonly_element === "transaction"
        ? {
            "@_id": newBpmnElementId,
            "@_name": getNewNodeDefaultName({
              type: __readonly_newNode.type,
              element: __readonly_element,
            }),
            __$$element: "transaction",
          }
        : {
            "@_id": newBpmnElementId,
            "@_name": getNewNodeDefaultName({
              type: __readonly_newNode.type,
              element: __readonly_element,
            }),
            __$$element:
              __readonly_element === "adHocSubProcess"
                ? "adHocSubProcess"
                : "subProcess",
          },
    );
  } else if (nature === NodeNature.LANE) {
    const { lanes } = addOrGetLanes({ definitions });
    lanes.push({
      "@_id": newBpmnElementId,
      "@_name": getNewNodeDefaultName({
        type: __readonly_newNode.type,
        element: __readonly_element,
      }),
    });
  }
  //
  else {
    throw new Error(`Unknown node nature '${nature}'.`);
  }

  // Add the new node shape
  const shapeId = generateUuid();
  diagramElements?.push({
    __$$element: "bpmndi:BPMNShape",
    "@_id": shapeId,
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
  if (
    __readonly_newNode.data?.bpmnElement.__$$element === "subProcess" &&
    __readonly_newNode.data.bpmnElement["@_triggeredByEvent"]
  )
    setSubProcessKind(definitions, newBpmnElementId, "event");
  return {
    id: newBpmnElementId,
    shapeId,
  };
}
